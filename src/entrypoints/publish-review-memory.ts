import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { readFile } from "node:fs/promises";
import { GITHUB_API_URL } from "../github/api/config";
import { reconcilePullMemory } from "../github/data/repository-memory-store";
import { publishReviewRun } from "../github/operations/publish-review-memory";

/** Dispatch only trusted maintenance events; repository identity comes from the runner. */
export async function maintainRepositoryMemory(
  client: Octokit,
  repository: string,
  eventName: string,
  event: any,
  trustedActors: string[],
): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Invalid memory repository");
  const [owner, repo] = repository.split("/") as [string, string];
  const options = { owner, repo };
  if (eventName === "workflow_run") {
    const source = event.workflow_run ?? {};
    return publishReviewRun(
      client,
      options,
      {
        id: Number(source.id),
        attempt: Number(source.run_attempt),
      },
      trustedActors,
    );
  }
  if (
    eventName === "pull_request_target" &&
    event.action === "closed" &&
    event.pull_request?.head?.repo?.full_name?.toLowerCase() ===
      repository.toLowerCase()
  ) {
    const pr = Number(event.pull_request.number);
    if (!Number.isSafeInteger(pr) || pr < 1)
      throw new Error("Invalid memory source PR");
    return (await reconcilePullMemory(client, options, pr))
      ? "Reconciled closed PR memory"
      : "No pending memory changed";
  }
  return "Skipped unsupported memory maintenance event";
}

/** Run the maintenance action without model credentials or consumer-repository checkout. */
async function main(): Promise<void> {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token || !process.env.GITHUB_EVENT_PATH)
      throw new Error("Memory maintenance environment is missing");
    const actors = (process.env.CODEX_TRUSTED_ACTORS ?? "")
      .split(",")
      .filter(Boolean);
    if (
      !actors.length ||
      actors.some((actor) => !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(actor))
    )
      throw new Error("Memory maintenance needs trusted actors");
    const event = JSON.parse(
      await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    core.info(
      await maintainRepositoryMemory(
        new Octokit({ auth: token, baseUrl: GITHUB_API_URL }),
        process.env.GITHUB_REPOSITORY ?? "",
        process.env.GITHUB_EVENT_NAME ?? "",
        event,
        actors,
      ),
    );
  } catch {
    core.setFailed(
      "Repository memory maintenance failed. Check the source artifact, repository permissions and branch rules; no unvalidated learning is published.",
    );
  }
}

if (import.meta.main) await main();
