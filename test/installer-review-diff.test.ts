import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderWorkflow,
  REVIEW_DIFF_PATH,
  DEFAULT_ACTION_REF,
} from "../scripts/github-action-installer/workflow.mjs";
import { createAgentTools } from "../base-action/src/agent-tools";
import { AgentPermissions } from "../base-action/src/agent-permissions";
import { RunContext, type FunctionTool } from "@openai/agents";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function workflowYaml(source: string): any {
  return (
    Bun as unknown as { YAML: { parse: (yaml: string) => any } }
  ).YAML.parse(source);
}

async function createPullRequestHistory(): Promise<{
  directory: string;
  baseSha: string;
  headSha: string;
}> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "codex-review-diff-"),
  );
  const directory = await realpath(temporaryDirectory);
  temporaryDirectories.push(temporaryDirectory);
  git(directory, "init", "-q", "-b", "main");
  git(directory, "config", "user.name", "Review Diff Test");
  git(directory, "config", "user.email", "review-diff@example.invalid");

  await writeFile(join(directory, "changed.txt"), "old value\nkept line\n");
  await writeFile(join(directory, "removed.txt"), "remove this file\n");
  git(directory, "add", "changed.txt", "removed.txt");
  git(directory, "commit", "-q", "-m", "common base");

  git(directory, "switch", "-q", "-c", "feature");
  await writeFile(join(directory, "changed.txt"), "new value\nkept line\n");
  await rm(join(directory, "removed.txt"));
  await writeFile(join(directory, "added.txt"), "new file content\n");
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "PR changes");
  const headSha = git(directory, "rev-parse", "HEAD");

  git(directory, "switch", "-q", "main");
  await writeFile(join(directory, "base-only.txt"), "base branch update\n");
  git(directory, "add", "base-only.txt");
  git(directory, "commit", "-q", "-m", "unrelated base update");
  const baseSha = git(directory, "rev-parse", "HEAD");
  git(directory, "switch", "-q", "feature");
  return { directory, baseSha, headSha };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("generated automatic review patch", () => {
  test("captures base-to-head additions, removals, and deletions without base-only changes", async () => {
    const { directory, baseSha, headSha } = await createPullRequestHistory();
    const workflow = workflowYaml(renderWorkflow({ actors: ["trusted-user"] }));
    const review = workflow.jobs.codex_review;
    const checkout = review.steps.find(
      (step: any) => step.uses === "actions/checkout@v6",
    );
    const preparation = review.steps.find(
      (step: any) => step.name === "Prepare PR diff",
    );

    expect(checkout.with.ref).toBe("${{ github.event.pull_request.head.sha }}");
    expect(checkout.with["fetch-depth"]).toBe(0);
    expect(preparation.env.CODEX_PR_BASE_SHA).toBe(
      "${{ github.event.pull_request.base.sha }}",
    );
    expect(preparation.env.CODEX_PR_HEAD_SHA).toBe(
      "${{ github.event.pull_request.head.sha }}",
    );

    const result = execFileSync(
      "bash",
      ["-euo", "pipefail", "-c", preparation.run],
      {
        cwd: directory,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          CODEX_PR_BASE_SHA: baseSha,
          CODEX_PR_HEAD_SHA: headSha,
        },
      },
    );
    expect(result).toBe("");

    const patch = await readFile(join(directory, REVIEW_DIFF_PATH), "utf8");
    expect(patch).toContain("diff --git a/changed.txt b/changed.txt");
    expect(patch).toContain("-old value");
    expect(patch).toContain("+new value");
    expect(patch).toContain("diff --git a/removed.txt b/removed.txt");
    expect(patch).toContain("-remove this file");
    expect(patch).toContain("diff --git a/added.txt b/added.txt");
    expect(patch).toContain("+new file content");
    expect(patch).not.toContain("base-only.txt");
    expect(patch).not.toContain("base branch update");
    expect(
      review.steps.some((step: any) => step.uses === DEFAULT_ACTION_REF),
    ).toBe(true);
  });

  test("read-only Agents SDK can read the prepared patch but cannot execute or edit", async () => {
    const { directory } = await createPullRequestHistory();
    await mkdir(join(directory, ".git"), { recursive: true });
    await writeFile(
      join(directory, REVIEW_DIFF_PATH),
      "diff --git a/source.ts b/source.ts\n-old\n+new\n",
    );
    const permissions = new AgentPermissions({
      cwd: directory,
      sandboxMode: "read-only",
    });
    const tools = createAgentTools({
      cwd: directory,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      allowedTools: ["Read", "Bash", "Write", "Edit"],
      sandboxMode: "read-only",
      permissions,
    });
    const invoke = async (name: string, input: Record<string, unknown>) => {
      const selected = tools.find((tool) => tool.name === name) as FunctionTool;
      return selected.invoke(new RunContext(), JSON.stringify(input));
    };

    const contents = await invoke("Read", { file_path: REVIEW_DIFF_PATH });
    expect(String(contents)).toContain("-old");
    expect(String(contents)).toContain("+new");
    expect(String(await invoke("Bash", { command: "true" }))).toContain(
      "read-only/plan mode",
    );
    expect(
      String(
        await invoke("Write", { file_path: "changed.txt", content: "bad" }),
      ),
    ).toContain("read-only/plan mode");
    expect(
      String(
        await invoke("Edit", {
          file_path: "changed.txt",
          old_string: "old",
          new_string: "bad",
        }),
      ),
    ).toContain("read-only/plan mode");
  });
});
