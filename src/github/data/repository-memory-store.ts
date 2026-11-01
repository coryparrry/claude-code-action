import { z } from "zod";
import { retryGitHubRead } from "../api/retry";
import type { Octokit } from "@octokit/rest";
import {
  REPOSITORY_MEMORY_BRANCH,
  boundRepositoryMemory,
  memoryRelevance,
  cleanMemoryNote,
  validMemoryPaths,
  repositoryRecordSchema,
  type RepositoryMemoryContext,
  type RepositoryMemoryRecord,
} from "./repository-memory";

export type RepositoryMemoryOptions = { owner: string; repo: string };
export type MemoryIndex = z.infer<typeof memoryIndexSchema>;
export type MemoryEntry = MemoryIndex["entries"][number];
const INDEX_PATH = "index.json";
const MAX_INDEX_BYTES = 256 * 1024;
const memoryIndexSchema = z.strictObject({
  version: z.literal(1),
  repository: z.string().min(1),
  repositoryId: z.number().int().positive(),
  entries: z
    .array(
      repositoryRecordSchema
        .extend({
          merged: z.boolean(),
          baseRef: z.string(),
          updatedAt: z.iso.datetime(),
        })
        .refine((entry) => validMemoryPaths(entry.paths)),
    )
    .max(500),
});

/** Recognize an identical learning without separate IDs or record-file bookkeeping. */
function sameLearning(a: MemoryEntry, b: MemoryEntry): boolean {
  return (
    a.baseRef === b.baseRef &&
    a.sourcePr === b.sourcePr &&
    a.head === b.head &&
    a.note === b.note &&
    JSON.stringify(a.paths) === JSON.stringify(b.paths)
  );
}

/** Strip publisher metadata before validating notes as prompt reference data. */
function learningRecord(entry: MemoryEntry): RepositoryMemoryRecord {
  const { version, sourcePr, head, paths, note } = entry;
  const cleaned = cleanMemoryNote(note);
  if (!cleaned) throw new Error("Invalid repository memory learning");
  return { version, sourcePr, head, paths, note: cleaned };
}

/** Decode a bounded GitHub file response without executing any repository content. */
async function readMemoryIndex(
  client: Octokit,
  options: RepositoryMemoryOptions,
  ref: string,
  repositoryId: number,
): Promise<MemoryIndex> {
  const { data } = await retryGitHubRead(() =>
    client.rest.repos.getContent({
      ...options,
      path: INDEX_PATH,
      ref,
    }),
  );
  if (
    Array.isArray(data) ||
    data.type !== "file" ||
    data.encoding !== "base64" ||
    data.size > MAX_INDEX_BYTES
  )
    throw new Error("Invalid repository memory file");
  const body = Buffer.from(data.content, "base64").toString("utf8");
  if (Buffer.byteLength(body) > MAX_INDEX_BYTES)
    throw new Error("Repository memory file exceeds its size budget");
  const parsed = memoryIndexSchema.safeParse(JSON.parse(body));
  if (!parsed.success || parsed.data.repositoryId !== repositoryId)
    throw new Error("Invalid repository memory index");
  return parsed.data;
}

/** Resolve a versioned index at an immutable commit; a missing branch is a cold start. */
export async function readMemorySnapshot(
  client: Octokit,
  options: RepositoryMemoryOptions,
): Promise<{ sha?: string; index: MemoryIndex }> {
  const repository = await repositoryIdentity(client, options);
  let sha: string;
  try {
    sha = (
      await retryGitHubRead(() =>
        client.rest.git.getRef({
          ...options,
          ref: `heads/${REPOSITORY_MEMORY_BRANCH}`,
        }),
      )
    ).data.object.sha;
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    return {
      index: {
        version: 1,
        repository: `${options.owner}/${options.repo}`,
        repositoryId: repository.id,
        entries: [],
      },
    };
  }
  const index = await readMemoryIndex(client, options, sha, repository.id);
  return { sha, index };
}

/** Resolve immutable repository identity independently of names and transfers. */
export async function repositoryIdentity(
  client: Octokit,
  options: RepositoryMemoryOptions,
) {
  return (await retryGitHubRead(() => client.rest.repos.get(options))).data;
}

type MemoryPull = Awaited<ReturnType<Octokit["rest"]["pulls"]["get"]>>["data"];

/** Confirm missed close events read-only, with at most eight distinct pending PR lookups. */
async function mergedMemoryEntry(
  client: Octokit,
  options: RepositoryMemoryOptions,
  entry: MemoryEntry,
  baseRef: string,
  pulls: Map<number, MemoryPull>,
): Promise<boolean> {
  if (entry.merged) return entry.baseRef === baseRef;
  if (!pulls.has(entry.sourcePr)) {
    if (pulls.size >= 8) return false;
    pulls.set(
      entry.sourcePr,
      (
        await retryGitHubRead(() =>
          client.rest.pulls.get({ ...options, pull_number: entry.sourcePr }),
        )
      ).data,
    );
  }
  const pull = pulls.get(entry.sourcePr)!;
  return Boolean(
    pull.merged_at && pull.head.sha === entry.head && pull.base.ref === baseRef,
  );
}

/** Retrieve only published path matches, with no sliding comment-history window. */
export async function loadRepositoryMemory(
  client: Octokit,
  options: RepositoryMemoryOptions,
  current: {
    pr: number;
    changedPaths: string[];
    baseRef: string;
    pathsComplete?: boolean;
  },
): Promise<RepositoryMemoryContext> {
  const snapshot = await readMemorySnapshot(client, options);
  if (!snapshot.sha)
    return {
      records: [],
      status:
        "No repository memory yet. It will be provisioned automatically from review learnings.",
    };
  const inventory =
    current.pathsComplete === false
      ? await changedFileInventory(client, options, current.pr)
      : { paths: current.changedPaths, complete: true };
  const entries = snapshot.index.entries
    .filter(
      (entry) =>
        entry.sourcePr !== current.pr &&
        entry.baseRef === current.baseRef &&
        memoryRelevance(entry, inventory.paths) > 0,
    )
    .sort(
      (a, b) =>
        memoryRelevance(b, inventory.paths) -
          memoryRelevance(a, inventory.paths) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  let records: RepositoryMemoryRecord[] = [];
  const seen = new Set<string>();
  const pulls = new Map<number, MemoryPull>();
  for (const entry of entries) {
    if (
      !(await mergedMemoryEntry(client, options, entry, current.baseRef, pulls))
    )
      continue;
    const record = learningRecord(entry);
    const identity = JSON.stringify([record.note, record.paths]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    records = boundRepositoryMemory([...records, record]);
    if (records.length === 3) break;
  }
  return {
    records: boundRepositoryMemory(records),
    status: `Retrieved published repository memory by changed path. Revalidate all notes against current code.${inventory.complete ? "" : " Changed-path lookup reached its 3000-file API budget; memory coverage may be incomplete."}`,
  };
}

/** Paginate changed paths within a fixed API budget and report unfinished inventory. */
export async function changedFileInventory(
  client: Octokit,
  options: RepositoryMemoryOptions,
  pr: number,
): Promise<{ paths: string[]; complete: boolean }> {
  const paths: string[] = [];
  for (let page = 1; page <= 30; page++) {
    const files = await retryGitHubRead(() =>
      client.rest.pulls.listFiles({
        ...options,
        pull_number: pr,
        per_page: 100,
        page,
      }),
    );
    paths.push(
      ...files.data.flatMap((file) =>
        file.previous_filename
          ? [file.filename, file.previous_filename]
          : [file.filename],
      ),
    );
    if (files.data.length < 100) return { paths, complete: true };
  }
  return { paths, complete: false };
}

/** Bound the active index while retaining full history in prior Git commits. */
function boundedIndex(index: MemoryIndex): MemoryIndex {
  const entries = [...index.entries].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      Number(b.merged) - Number(a.merged),
  );
  while (
    entries.length > 500 ||
    Buffer.byteLength(JSON.stringify({ ...index, entries })) > MAX_INDEX_BYTES
  )
    entries.pop();
  return { ...index, entries };
}

/** Commit with fast-forward-only ref updates; concurrent changes trigger bounded retries. */
export async function mutateMemoryBranch(
  client: Octokit,
  options: RepositoryMemoryOptions,
  mutate: (index: MemoryIndex) => {
    index: MemoryIndex;
    requiredRecord?: MemoryEntry;
  },
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await readMemorySnapshot(client, options);
    const previousSha = snapshot.sha;
    const update = mutate(snapshot.index);
    const index = boundedIndex(update.index);
    if (
      update.requiredRecord &&
      !index.entries.some((entry) =>
        sameLearning(entry, update.requiredRecord!),
      )
    )
      throw new Error(
        "Learning falls outside the repository memory retention budget",
      );
    if (JSON.stringify(index) === JSON.stringify(snapshot.index)) return false;
    const baseTree = previousSha
      ? (
          await retryGitHubRead(() =>
            client.rest.git.getCommit({
              ...options,
              commit_sha: previousSha,
            }),
          )
        ).data.tree.sha
      : undefined;
    const tree = await client.rest.git.createTree({
      ...options,
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: [
        {
          path: INDEX_PATH,
          mode: "100644",
          type: "blob",
          content: JSON.stringify(index),
        },
      ],
    });
    const commit = await client.rest.git.createCommit({
      ...options,
      message: "chore(memory): update validated review learnings",
      tree: tree.data.sha,
      parents: previousSha ? [previousSha] : [],
    });
    try {
      if (previousSha)
        await client.rest.git.updateRef({
          ...options,
          ref: `heads/${REPOSITORY_MEMORY_BRANCH}`,
          sha: commit.data.sha,
          force: false,
        });
      else
        await client.rest.git.createRef({
          ...options,
          ref: `refs/heads/${REPOSITORY_MEMORY_BRANCH}`,
          sha: commit.data.sha,
        });
      return true;
    } catch (error) {
      if (![409, 422].includes((error as { status: number }).status))
        throw error;
      const latest = await retryGitHubRead(() =>
        client.rest.git.getRef({
          ...options,
          ref: `heads/${REPOSITORY_MEMORY_BRANCH}`,
        }),
      );
      if (latest.data.object.sha === previousSha)
        throw new Error(
          "Memory branch update rejected; check repository branch rules",
        );
    }
  }
  throw new Error(
    "Repository memory changed concurrently; bounded update retries exhausted",
  );
}

/** Stage or publish a provenance-checked learning without discarding concurrent records. */
export async function storeRepositoryMemory(
  client: Octokit,
  options: RepositoryMemoryOptions,
  record: RepositoryMemoryRecord,
  state: { merged: boolean; baseRef: string; updatedAt: string },
): Promise<boolean> {
  return mutateMemoryBranch(client, options, (index) => {
    const entry: MemoryEntry = { ...record, ...state };
    const existing = index.entries.find((prior) => sameLearning(prior, entry));
    if (existing && (existing.merged || !state.merged)) return { index };
    return {
      index: {
        ...index,
        entries: [
          ...index.entries.filter((prior) => !sameLearning(prior, entry)),
          entry,
        ],
      },
      requiredRecord: entry,
    };
  });
}

/** Only the immutable merged head can publish or retire this PR's pending knowledge. */
export async function reconcilePullMemory(
  client: Octokit,
  options: RepositoryMemoryOptions,
  pr: number,
): Promise<boolean> {
  const pull = (
    await retryGitHubRead(() =>
      client.rest.pulls.get({ ...options, pull_number: pr }),
    )
  ).data;
  // Open and closed-unmerged PRs can move or reopen; their pending data must survive stale observers.
  if (!pull.merged_at) return false;
  return mutateMemoryBranch(client, options, (index) => ({
    index: {
      ...index,
      entries: index.entries.flatMap((entry) => {
        if (entry.sourcePr !== pr || entry.merged) return [entry];
        if (entry.head !== pull.head.sha || entry.baseRef !== pull.base.ref)
          return [];
        return [
          { ...entry, merged: Boolean(pull.merged_at), baseRef: pull.base.ref },
        ];
      }),
    },
  }));
}
