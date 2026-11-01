import type { Octokit } from "@octokit/rest";
import { REPOSITORY_MEMORY_BRANCH, type RepositoryMemoryRecord } from "../../src/github/data/repository-memory";

export const memoryOptions = { owner: "owner", repo: "repo" };
export const memoryHead = "a".repeat(40);
export const memoryRecord: RepositoryMemoryRecord = { version: 1, sourcePr: 1, head: memoryHead, paths: ["src/"], note: "Affordability requires balance >= amount; boundary tests live beside access.ts." };

/** In-memory Git data API with real fast-forward conflict semantics and immutable trees. */
export function memoryFixture() {
  let sequence = 100;
  let branch: string | undefined;
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const trees = new Map<string, Map<string, string>>();
  const calls: { name: string; input: any }[] = [];
  const pulls = new Map<number, any>([[1, { number: 1, head: { sha: memoryHead, repo: { full_name: "owner/repo" } }, base: { ref: "main" }, merged_at: null, state: "open" }], [2, { number: 2, head: { sha: "b".repeat(40), repo: { full_name: "owner/repo" } }, base: { ref: "main" }, merged_at: null, state: "open" }]]);
  const runs = new Map<number, any>([[42, { id: 42, run_attempt: 1, event: "pull_request", status: "completed", conclusion: "success", path: ".github/workflows/codex.yml", repository: { full_name: "owner/repo" }, head_repository: { full_name: "owner/repo" }, actor: { login: "trusted-user" }, head_sha: memoryHead, updated_at: "2026-11-01T12:00:00Z", pull_requests: [{ number: 1 }] }]]);
  const artifacts: any[] = [{ id: 99, name: "codex-review-memory-42-1", size_in_bytes: 100, expired: false }];
  let beforeRef: (() => Promise<void>) | undefined;
  const sha = () => (++sequence).toString(16).padStart(40, "0");
  const fail = (status: number): never => { throw Object.assign(new Error("Fixture GitHub failure"), { status }); };
  const api: any = {
    git: {
      getRef: async (input: any) => { calls.push({ name: "getRef", input }); if (!branch) fail(404); return { data: { object: { sha: branch } } }; },
      getCommit: async ({ commit_sha }: any) => ({ data: { tree: { sha: commits.get(commit_sha)!.tree } } }),
      createTree: async (input: any) => { calls.push({ name: "createTree", input }); const files = new Map(trees.get(input.base_tree)); for (const file of input.tree) { if (file.sha === null) files.delete(file.path); else files.set(file.path, file.content); } const id = sha(); trees.set(id, files); return { data: { sha: id } }; },
      createCommit: async (input: any) => { const id = sha(); commits.set(id, { tree: input.tree, parents: input.parents }); return { data: { sha: id } }; },
      createRef: async (input: any) => { if (beforeRef) { const hook = beforeRef; beforeRef = undefined; await hook(); } if (branch) fail(422); branch = input.sha; return { data: {} }; },
      updateRef: async (input: any) => { calls.push({ name: "updateRef", input }); if (beforeRef) { const hook = beforeRef; beforeRef = undefined; await hook(); } if (input.force || !commits.get(input.sha)?.parents.includes(branch!)) fail(409); branch = input.sha; return { data: {} }; },
    },
    repos: {
      getContent: async (input: any) => { calls.push({ name: "getContent", input }); const commit = commits.get(input.ref === REPOSITORY_MEMORY_BRANCH ? branch! : input.ref); const content = commit && trees.get(commit.tree)?.get(input.path); if (content === undefined) fail(404); return { data: { type: "file", encoding: "base64", size: Buffer.byteLength(content!), content: Buffer.from(content!).toString("base64") } }; },
      getCommit: async () => ({ data: { parents: [{ sha: "f".repeat(40) }, { sha: memoryHead }] } }),
    },
    pulls: {
      get: async ({ pull_number }: any) => ({ data: structuredClone(pulls.get(pull_number)) }),
      listFiles: async () => ({ data: [{ filename: "src/access.ts" }] }),
    },
    actions: {
      getWorkflowRun: async ({ run_id }: any) => ({ data: runs.get(run_id) }),
      listWorkflowRunArtifacts: async () => ({ data: { artifacts } }),
      downloadArtifact: async () => ({ data: new Uint8Array([0]).buffer }),
    },
  };
  return { client: { rest: api } as Octokit, api, calls, pulls, runs, artifacts,
    beforeRef: (hook: () => Promise<void>) => { beforeRef = hook; },
    files: () => trees.get(commits.get(branch!)!.tree)!,
    branch: () => branch,
  };
}
