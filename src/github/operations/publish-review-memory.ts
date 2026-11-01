import { verifyReviewProof } from "../data/review-memory-proof";
import { retryGitHubRead } from "../api/retry";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Octokit } from "@octokit/rest";
import { parseReviewCandidate } from "../data/review-memory-candidate";
import {
  changedFileInventory,
  repositoryIdentity,
  storeRepositoryMemory,
  reconcilePullMemory,
  type RepositoryMemoryOptions,
} from "../data/repository-memory-store";

const execute = promisify(execFile);

/** Read only the expected JSON member, with bounded decompression and no ZIP extraction. */
export async function readCandidateArchive(
  archive: Uint8Array,
): Promise<string> {
  if (archive.byteLength > 32768)
    throw new Error("Review memory artifact exceeds its size budget");
  const directory = await mkdtemp(join(tmpdir(), "codex-memory-artifact-"));
  try {
    const path = join(directory, "candidate.zip");
    await writeFile(path, archive, { mode: 0o600 });
    const { stdout } = await execute("unzip", ["-p", path, "candidate.json"], {
      encoding: "utf8",
      maxBuffer: 16384,
      timeout: 5000,
    });
    return stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type ReviewRun = Awaited<
  ReturnType<Octokit["rest"]["actions"]["getWorkflowRun"]>
>["data"];

/** Keep the source-run trust policy in one pure predicate. */
function eligibleReviewRun(
  run: ReviewRun,
  repository: string,
  trustedActors: string[],
): boolean {
  return (
    run.event === "pull_request" &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    run.path?.split("@")[0] === ".github/workflows/codex.yml" &&
    run.repository.full_name.toLowerCase() === repository &&
    run.head_repository?.full_name.toLowerCase() === repository &&
    trustedActors.some(
      (actor) => actor.toLowerCase() === run.actor?.login.toLowerCase(),
    )
  );
}

/** Decode only the source run's unique, bounded learning artifact. */
async function reviewRunCandidate(
  client: Octokit,
  options: RepositoryMemoryOptions,
  run: ReviewRun,
  repository: string,
  decodeArchive: typeof readCandidateArchive,
  verifyProof: typeof verifyReviewProof,
) {
  const runId = run.id;
  const artifacts = await retryGitHubRead(() =>
    client.rest.actions.listWorkflowRunArtifacts({
      ...options,
      run_id: runId,
      per_page: 100,
    }),
  );
  const matches = artifacts.data.artifacts.filter(
    (artifact) =>
      artifact.name === `codex-review-memory-${run.id}-${run.run_attempt}` &&
      !artifact.expired,
  );
  if (!matches.length) return undefined;
  if (matches.length !== 1 || matches[0]!.size_in_bytes > 32768)
    throw new Error("Invalid review memory artifact metadata");
  const archive = await retryGitHubRead(() =>
    client.rest.actions.downloadArtifact({
      ...options,
      artifact_id: matches[0]!.id,
      archive_format: "zip",
    }),
  );
  const body = await decodeArchive(new Uint8Array(archive.data as ArrayBuffer));
  const candidate = parseReviewCandidate(body);
  if (
    candidate.repository.toLowerCase() !== repository ||
    candidate.runId !== run.id
  )
    throw new Error("Memory candidate does not belong to the source run");
  const identity = await repositoryIdentity(client, options);
  const workflowSha = await verifyProof(JSON.parse(body), run, identity.id);
  await validateReviewProducer(
    client,
    options,
    identity.default_branch,
    workflowSha,
  );
  return candidate;
}

/** Bind PR-head reviews and GitHub's synthetic merge-ref reviews to the saved head. */
async function validateReviewedHead(
  client: Octokit,
  options: RepositoryMemoryOptions,
  run: ReviewRun,
  head: string,
): Promise<void> {
  if (run.head_sha === head) return;
  const commit = await retryGitHubRead(() =>
    client.rest.repos.getCommit({ ...options, ref: run.head_sha }),
  );
  if (commit.data.parents.length !== 2 || commit.data.parents[1]?.sha !== head)
    throw new Error("Memory candidate does not match the reviewed commit");
}

/** Authenticate the exact executed workflow from GitHub's signed job identity. */
async function validateReviewProducer(
  client: Octokit,
  options: RepositoryMemoryOptions,
  defaultBranch: string,
  workflowSha: string,
): Promise<void> {
  /** Read a workflow blob without executing consumer repository code. */
  const readWorkflow = (ref: string) =>
    retryGitHubRead(() =>
      client.rest.repos.getContent({
        ...options,
        path: ".github/workflows/codex.yml",
        ref,
      }),
    );
  const trusted = (await readWorkflow(defaultBranch)).data;
  const source = (await readWorkflow(workflowSha)).data;
  if (
    Array.isArray(trusted) ||
    Array.isArray(source) ||
    trusted.type !== "file" ||
    source.type !== "file" ||
    source.sha !== trusted.sha
  )
    throw new Error(
      "Review producer workflow differs from the trusted default branch",
    );
}

/** Accept only the configured review workflow, trusted actor and exact reviewed commit. */
export async function publishReviewRun(
  client: Octokit,
  options: RepositoryMemoryOptions,
  runId: number,
  trustedActors: string[],
  decodeArchive = readCandidateArchive,
  verifyProof = verifyReviewProof,
): Promise<string> {
  if (!Number.isSafeInteger(runId) || runId < 1)
    throw new Error("Invalid source workflow run");
  const run = (
    await retryGitHubRead(() =>
      client.rest.actions.getWorkflowRun({ ...options, run_id: runId }),
    )
  ).data;
  const repository = `${options.owner}/${options.repo}`.toLowerCase();
  if (!eligibleReviewRun(run, repository, trustedActors))
    return "Skipped non-eligible review run";
  const candidate = await reviewRunCandidate(
    client,
    options,
    run,
    repository,
    decodeArchive,
    verifyProof,
  );
  if (!candidate) return "Review supplied no learning candidate";
  const record = candidate.record;
  await validateReviewedHead(client, options, run, record.head);
  const pull = (
    await retryGitHubRead(() =>
      client.rest.pulls.get({ ...options, pull_number: record.sourcePr }),
    )
  ).data;
  if (
    pull.head.sha !== record.head ||
    pull.head.repo?.full_name.toLowerCase() !== repository
  )
    return "Discarded candidate for a superseded or foreign PR revision";
  const files = await changedFileInventory(client, options, record.sourcePr);
  if (
    !record.paths.every((path) =>
      files.paths.some(
        (file) =>
          path === file || (path.endsWith("/") && file.startsWith(path)),
      ),
    )
  )
    throw new Error("Memory candidate scope is outside verified changed paths");
  const changed = await storeRepositoryMemory(client, options, record, {
    merged: Boolean(pull.merged_at),
    baseRef: pull.base.ref,
    updatedAt: run.updated_at,
  });
  const reconciled = await reconcilePullMemory(
    client,
    options,
    record.sourcePr,
  );
  return changed || reconciled
    ? "Stored and reconciled validated review learning"
    : "Review learning already stored";
}
