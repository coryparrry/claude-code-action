import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  applyInstallation,
  planInstallation,
} from "../scripts/github-action-installer/install.mjs";
import {
  MEMORY_WORKFLOW_PATH,
  WORKFLOW_PATH,
  renderMemoryWorkflow,
  renderWorkflow,
} from "../scripts/github-action-installer/workflow.mjs";
import {
  loadRepositoryMemory,
  storeRepositoryMemory,
} from "../src/github/data/repository-memory-store";
import { memoryFixture, memoryRecord } from "./fixtures/repository-memory";
import { GitHubClient } from "../scripts/github-action-installer/github.mjs";

const options = {
  actors: ["trusted-user"],
  runner: "ubuntu-latest",
  model: "gpt-6-luna",
};

test("installer refuses an action pin lacking the memory publisher before making setup changes", async () => {
  const adapter = new GitHubClient({
    run: () => ({
      status: 1,
      stdout: "",
      stderr: "HTTP 404 Not Found",
      pid: 0,
      output: [],
      signal: null,
    }),
  });
  await expect(adapter.verifyActionRevision()).rejects.toThrow(
    "Publish the updated action",
  );
  const fixture = installerFixture();
  fixture.client.verifyActionRevision = async () => {
    throw new Error("Missing publisher release");
  };
  await expect(
    planInstallation(fixture.client, { repository: "owner/repo", ...options }),
  ).rejects.toThrow("Missing publisher release");
  expect(fixture.writes).toHaveLength(0);
});

/** Model installation into multiple repositories without live GitHub mutation. */
function installerFixture() {
  const files = new Map<string, { sha: string; content: string }>();
  const writes: any[] = [];
  const key = (repository: string, ref: string, path: string) =>
    `${repository}:${ref}:${path}`;
  const client = {
    repository: async (repository: string) => ({
      nameWithOwner: repository,
      defaultBranchRef: { name: "main" },
      viewerPermission: "ADMIN",
      isArchived: false,
    }),
    workflow: async (repository: string, ref: string, path = WORKFLOW_PATH) =>
      files.get(key(repository, ref, path)) ?? null,
    verifyActionRevision: async () => {},
    secrets: async () => [{ name: "OPENAI_API_KEY" }],
    pullRequests: async () => [],
    head: async () => "a".repeat(40),
    createBranch: async () => {},
    writeWorkflow: async (
      repository: string,
      ref: string,
      content: string,
      _sha?: string,
      path = WORKFLOW_PATH,
    ) => {
      writes.push({ repository, ref, path, content });
      files.set(key(repository, ref, path), { sha: "workflow-sha", content });
    },
    createPullRequest: async (repository: string) =>
      `https://github.com/${repository}/pull/1`,
  };
  return { client, files, writes, key };
}

test("fresh setup automatically installs the review and trusted memory workflows in each selected repository", async () => {
  const fixture = installerFixture();
  for (const repository of ["owner/project-one", "other/project-two"]) {
    const plan = await planInstallation(fixture.client, {
      repository,
      ...options,
    });
    expect(plan.status).toBe("new");
    await applyInstallation(fixture.client, plan, {
      branchName: "codex/install-github-action-test",
    });
    const installed = fixture.writes.filter(
      (write) => write.repository === repository,
    );
    expect(installed.map((write) => write.path)).toEqual([
      WORKFLOW_PATH,
      MEMORY_WORKFLOW_PATH,
    ]);
    for (const file of installed)
      fixture.files.set(fixture.key(repository, "main", file.path), {
        sha: "merged-workflow",
        content: file.content,
      });
    expect(
      (await planInstallation(fixture.client, { ...options, repository }))
        .status,
    ).toBe("configured");
    expect(
      installed.some((write) =>
        write.content.includes("CODEX_REVIEW_MEMORY_ISSUE"),
      ),
    ).toBe(false);
  }
  expect(fixture.writes).toHaveLength(4);
});

test("an older installation gets the missing memory workflow, while user-owned files are preserved", async () => {
  const fixture = installerFixture();
  fixture.files.set(fixture.key("owner/repo", "main", WORKFLOW_PATH), {
    sha: "old",
    content: renderWorkflow({ repository: "owner/repo", ...options }),
  });
  expect(
    (
      await planInstallation(fixture.client, {
        repository: "owner/repo",
        ...options,
      })
    ).status,
  ).toBe("update");
  fixture.files.set(fixture.key("owner/repo", "main", MEMORY_WORKFLOW_PATH), {
    sha: "custom",
    content: "name: custom maintenance",
  });
  await expect(
    planInstallation(fixture.client, { repository: "owner/repo", ...options }),
  ).rejects.toThrow(MEMORY_WORKFLOW_PATH);
  expect(fixture.writes).toHaveLength(0);
});

test("publisher executes pinned action code without PR checkout, source writes in review, or model credentials", async () => {
  const review = parse(
    renderWorkflow({ repository: "owner/repo", ...options }),
  );
  const memory = parse(
    renderMemoryWorkflow({ repository: "owner/repo", ...options }),
  );
  expect(review.jobs.codex_review.permissions.contents).toBe("read");
  expect(memory.on.workflow_run.workflows).toEqual(["Codex"]);
  expect(memory.on.pull_request_target.types).toEqual(["closed"]);
  expect(memory.jobs.memory.permissions).toEqual({
    contents: "write",
    actions: "read",
    "pull-requests": "read",
  });
  expect(memory.jobs.memory.steps).toHaveLength(1);
  expect(memory.jobs.memory.steps[0].uses).toContain("/review-memory@");
  expect(memory.jobs.memory.steps[0].with.trusted_actors).toBe("trusted-user");
  expect(JSON.stringify(memory)).not.toContain("OPENAI_API_KEY");
  expect(JSON.stringify(memory)).not.toContain("checkout");
  const child = parse(
    await readFile(
      new URL("../review-memory/action.yml", import.meta.url),
      "utf8",
    ),
  );
  expect(child.inputs.openai_api_key).toBeUndefined();
  expect(
    child.runs.steps.some((step: any) =>
      step.run?.includes("publish-review-memory.ts"),
    ),
  ).toBe(true);
});

test("memory branch identity and knowledge are isolated automatically per repository", async () => {
  const fixtures = [memoryFixture(), memoryFixture()];
  for (const [index, repository] of [
    "owner/project-one",
    "other/project-two",
  ].entries()) {
    const [owner, repo] = repository.split("/") as [string, string];
    const fixture = fixtures[index]!;
    await storeRepositoryMemory(
      fixture.client,
      { owner, repo },
      { ...memoryRecord, note: `Invariant for ${repository}` },
      { merged: true, baseRef: "main", updatedAt: "2026-11-01T12:00:00Z" },
    );
    const context = await loadRepositoryMemory(
      fixture.client,
      { owner, repo },
      { pr: 2, changedPaths: ["src/access.ts"], baseRef: "main" },
    );
    expect(context.records[0]?.note).toBe(`Invariant for ${repository}`);
    expect(
      fixture.calls
        .filter((call) =>
          ["createTree", "getContent", "getRef"].includes(call.name),
        )
        .every(
          (call) => call.input.owner === owner && call.input.repo === repo,
        ),
    ).toBe(true);
  }
});
