import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrompt, prepareContext } from "../src/create-prompt";
import {
  AgentPermissions,
  isSimpleShellCommand,
} from "../base-action/src/agent-permissions";
import { mockIssueOpenedContext } from "./mockContext";
import type { FetchDataResult } from "../src/github/data/fetcher";

/** Execute isolated Git commands with personal hooks and signing disabled. */
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

test("generated commit handoff preserves conventional titles and co-authors under scoped shell policy", () => {
  const cwd = mkdtempSync(join(tmpdir(), "commit-handoff-"));
  try {
    const context = prepareContext(
      mockIssueOpenedContext,
      "20",
      "main",
      "codex/issue-fix",
    );
    const data: FetchDataResult = {
      contextData: {
        title: "Fix fixture",
        body: "/codex fix fixture",
        author: { login: "author" },
        createdAt: "2026-01-01T00:00:00Z",
        state: "OPEN",
        labels: { nodes: [] },
        comments: { nodes: [] },
      },
      comments: [],
      changedFiles: [],
      changedFilesWithSHA: [],
      reviewData: null,
      imageUrlMap: new Map(),
    };
    const prompt = generatePrompt(context, data, false, "tag");
    const command = prompt.match(/`(git commit --file [^`]+)`/)?.[1];
    expect(command).toBe("git commit --file .git/codex-commit-message.txt");
    expect(prompt).toContain("Use the file-writing tool");
    const policy = new AgentPermissions({
      cwd,
      permissionMode: "acceptEdits",
      allowedTools: ["Bash(git commit:*)"],
    });
    expect(() => policy.authorize("Bash", command)).not.toThrow();
    expect(policy.needsApproval("Write", ".git/codex-commit-message.txt")).toBe(
      false,
    );
    expect(
      isSimpleShellCommand(
        'git commit -m "test(fixtures): add fixture" -m "Co-authored-by: Reviewer <reviewer@example.invalid>"',
      ),
    ).toBe(false);
    git(cwd, "init");
    git(cwd, "config", "user.name", "Fixture");
    git(cwd, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(cwd, "fixture.txt"), "fixture\n");
    git(cwd, "add", "fixture.txt");
    const message =
      "test(fixtures): add fixture\n\nCo-authored-by: Reviewer <reviewer@example.invalid>\n";
    writeFileSync(join(cwd, ".git/codex-commit-message.txt"), message);
    git(cwd, ...command!.split(" ").slice(1));
    expect(git(cwd, "log", "-1", "--format=%B")).toBe(message.trim());
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
