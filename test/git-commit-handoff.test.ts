import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskGit } from "../src/github/operations/task-git";
import {
  generatePrompt,
  prepareContext,
  buildAllowedToolsString,
  buildDisallowedToolsString,
} from "../src/create-prompt";
import { AgentPermissions } from "../base-action/src/agent-permissions";
import { mockIssueOpenedContext } from "./mockContext";
import type { FetchDataResult } from "../src/github/data/fetcher";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** Execute fixture Git commands without personal hooks or signing. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "init.defaultBranch=main",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** Create an isolated repository with one existing commit and no shell-dependent paths. */
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "task-git-"));
  roots.push(cwd);
  git(cwd, "init");
  git(cwd, "config", "user.name", "Fixture");
  git(cwd, "config", "user.email", "fixture@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "existing.txt"), "base\n");
  git(cwd, "add", "existing.txt");
  git(cwd, "commit", "-m", "base");
  return {
    cwd,
    tool: new TaskGit({
      repoDir: cwd,
      branch: "codex/fix#1(test)",
      receiptFile: join(cwd, "receipt.json"),
      baseBranch: "main",
    }),
  };
}

test("literal messages and punctuation branch push preserve unrelated staging in linked worktrees", async () => {
  const { cwd } = fixture();
  const linked = join(cwd, "linked");
  git(cwd, "worktree", "add", "-b", "codex/fix#1(test)", linked);
  const remote = join(cwd, "remote.git");
  git(cwd, "init", "--bare", remote);
  git(linked, "remote", "add", "origin", remote);
  writeFileSync(join(linked, "unrelated.txt"), "keep staged\n");
  git(linked, "add", "unrelated.txt");
  writeFileSync(join(linked, "fixture.txt"), "fixture\n");
  const tool = new TaskGit({
    repoDir: linked,
    branch: "codex/fix#1(test)",
    baseBranch: "main",
  });
  const message =
    "test(fixtures): add fixture\n\nCo-authored-by: Reviewer <reviewer@example.invalid>\nLiteral $(false) `false` # (data)";
  const result = await tool.commit(["fixture.txt"], message);
  expect(git(linked, "log", "-1", "--format=%B")).toBe(message);
  expect(git(linked, "diff", "--cached", "--name-only")).toBe("unrelated.txt");
  expect(git(linked, "show", "--format=", "--name-only", "HEAD")).toBe(
    "fixture.txt",
  );
  expect(tool.push().head_sha).toBe(result.head_sha);
  expect(git(cwd, "ls-remote", "origin", "none")).toBe("");
  expect(
    git(cwd, "--git-dir", remote, "rev-parse", "refs/heads/codex/fix#1(test)"),
  ).toBe(result.head_sha);
});

test("repository diff rejects outside paths, metadata, directories for commits and staged selections", async () => {
  const { cwd, tool } = fixture();
  symlinkSync(tmpdir(), join(cwd, "outside"));
  for (const path of [
    "../outside-marker",
    "/tmp/outside-marker",
    ".git/config",
    "outside/outside-marker",
  ]) {
    await expect(tool.diff({ paths: [path] })).rejects.toThrow();
    await expect(tool.commit([path], "fix: invalid")).rejects.toThrow();
  }
  await expect(tool.commit(["."], "fix: all")).rejects.toThrow();
  writeFileSync(join(cwd, "existing.txt"), "edited\n");
  git(cwd, "add", "existing.txt");
  await expect(
    tool.commit(["existing.txt"], "fix: selected staging"),
  ).rejects.toThrow("already has staged");
  expect((await tool.diff({ staged: true })).text).toContain("+edited");
});

test("read-only Git tools reject every mutation and disable external diff programs", async () => {
  const { cwd } = fixture();
  git(cwd, "config", "diff.external", "false");
  writeFileSync(join(cwd, "existing.txt"), "edited\n");
  const tool = new TaskGit({
    repoDir: cwd,
    branch: "main",
    baseBranch: "main",
    readOnly: true,
  });
  expect((await tool.diff()).text).toContain("+edited");
  await expect(tool.commit(["existing.txt"], "fix: no")).rejects.toThrow(
    "disabled",
  );
  await expect(tool.remove(["existing.txt"], "fix: no")).rejects.toThrow(
    "disabled",
  );
  expect(() => tool.push()).toThrow("disabled");
});

test("Git pathspec syntax remains literal and cannot include unrelated files", async () => {
  const { cwd, tool } = fixture();
  writeFileSync(join(cwd, "unrelated.txt"), "preserve\n");
  git(cwd, "add", "unrelated.txt");
  const before = git(cwd, "rev-parse", "HEAD");
  for (const path of ["*", ":(exclude)existing.txt", ":(top)**"]) {
    await expect(
      tool.commit([path], "fix: invalid selection"),
    ).rejects.toThrow();
    expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
    expect(git(cwd, "diff", "--cached", "--name-only")).toBe("unrelated.txt");
  }
  writeFileSync(join(cwd, "*"), "literal wildcard\n");
  await tool.commit(["*"], "test: literal wildcard");
  expect(git(cwd, "show", "--format=", "--name-only", "HEAD")).toBe("*");
  expect(git(cwd, "diff", "--cached", "--name-only")).toBe("unrelated.txt");
});

test("generated handoff uses structured Git without granting no-index or metadata writes", () => {
  const context = prepareContext(
    mockIssueOpenedContext,
    "20",
    "main",
    "codex/issue-fix",
  );
  const data = {
    contextData: {
      title: "Fix",
      body: "/codex fix",
      author: { login: "author" },
      createdAt: "2026-01-01",
      state: "OPEN",
      labels: { nodes: [] },
    },
    comments: [],
    changedFiles: [],
    changedFilesWithSHA: [],
    reviewData: null,
    imageUrlMap: new Map(),
  } as unknown as FetchDataResult;
  const prompt = generatePrompt(context, data, false, "tag");
  expect(prompt).toContain("mcp__github_git__commit_files");
  expect(prompt).not.toContain(".git/codex-commit-message.txt");
  const allowedTools = buildAllowedToolsString().split(",");
  const policy = new AgentPermissions({
    cwd: process.cwd(),
    permissionMode: "acceptEdits",
    allowedTools,
    disallowedTools: buildDisallowedToolsString().split(","),
  });
  expect(
    policy.needsApproval(
      "Bash",
      "git diff --no-index /tmp/outside-marker /dev/null",
    ),
  ).toBe(true);
  expect(() => policy.authorize("Write", ".git/config")).toThrow();
  for (const tool of ["Grep", "Glob"]) {
    expect(() => policy.authorize(tool, ".git/config")).toThrow();
    expect(() => policy.authorize(tool, ".git")).toThrow();
  }
});

test("batch deletion preflights missing files and rolls back commit failures", async () => {
  const { cwd, tool } = fixture();
  await expect(
    tool.remove(["existing.txt", "missing.txt"], "fix: delete"),
  ).rejects.toThrow();
  expect(await Bun.file(join(cwd, "existing.txt")).text()).toBe("base\n");
  writeFileSync(join(cwd, "other.txt"), "unrelated\n");
  git(cwd, "add", "other.txt");
  git(cwd, "config", "commit.gpgsign", "true");
  git(cwd, "config", "gpg.program", "/nonexistent-fixture-gpg");
  await expect(tool.remove(["existing.txt"], "fix: delete")).rejects.toThrow();
  expect(await Bun.file(join(cwd, "existing.txt")).text()).toBe("base\n");
  expect(git(cwd, "diff", "--cached", "--name-only")).toBe("other.txt");
  expect(git(cwd, "diff", "--name-only")).toBe("");
});

test("up-to-date pushes do not create delivery receipts and new LFS pointers fail before push", async () => {
  const { cwd, tool } = fixture();
  const remote = join(cwd, "remote.git");
  git(cwd, "init", "--bare", remote);
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "checkout", "-b", "codex/fix#1(test)");
  git(cwd, "push", "origin", "HEAD");
  expect(tool.push()).toMatchObject({ changed: false });
  expect(existsSync(join(cwd, "receipt.json"))).toBe(false);
  writeFileSync(
    join(cwd, "large.bin"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 42\n`,
  );
  await tool.commit(["large.bin"], "test: add pointer");
  expect(() => tool.push()).toThrow("LFS");
  expect(
    git(cwd, "ls-remote", "origin", "refs/heads/codex/fix#1(test)").split(
      /\s/,
    )[0],
  ).not.toBe(git(cwd, "rev-parse", "HEAD"));
});

test("LFS preflight uses current remote ancestry without trusting missing or stale tracking refs", async () => {
  const { cwd, tool } = fixture();
  writeFileSync(
    join(cwd, "old.bin"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 42\n`,
  );
  git(cwd, "add", "old.bin");
  git(cwd, "commit", "-m", "existing remote pointer");
  git(cwd, "checkout", "-b", "codex/fix#1(test)");
  const remote = join(cwd, "remote.git");
  git(cwd, "init", "--bare", remote);
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "push", "origin", "HEAD");
  git(cwd, "update-ref", "-d", "refs/remotes/origin/codex/fix#1(test)");
  writeFileSync(join(cwd, "existing.txt"), "ordinary fix\n");
  await tool.commit(["existing.txt"], "fix: ordinary edit");
  expect(tool.push()).toMatchObject({ changed: true });
  writeFileSync(
    join(cwd, "new.bin"),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${"b".repeat(64)}\nsize 43\n`,
  );
  await tool.commit(["new.bin"], "test: new pointer");
  git(
    cwd,
    "update-ref",
    "refs/remotes/origin/stale",
    git(cwd, "rev-parse", "HEAD"),
  );
  expect(() => tool.push()).toThrow("LFS");
  expect(
    git(cwd, "for-each-ref", "--format=%(refname)", "refs/codex-delivery/"),
  ).toBe("");
});
