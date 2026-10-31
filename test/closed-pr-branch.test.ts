import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupBranch } from "../src/github/operations/branch";
import type { Octokits } from "../src/github/api/client";
import type { FetchDataResult } from "../src/github/data/fetcher";
import { createMockContext } from "./mockContext";

/** Run isolated fixture Git commands without invoking personal commit hooks/signing. */
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

describe("closed PR replacement ancestry", () => {
  for (const useCommitSigning of [false, true]) {
    test(`retains a deleted original head with API signing ${useCommitSigning}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "closed-pr-"));
      const originalCwd = process.cwd();
      try {
        const remote = join(root, "remote.git");
        const seed = join(root, "seed");
        const workspace = join(root, "workspace");
        mkdirSync(seed);
        git(root, "init", "--bare", remote);
        git(seed, "init");
        git(seed, "config", "user.name", "Fixture");
        git(seed, "config", "user.email", "fixture@example.invalid");
        writeFileSync(join(seed, "base.txt"), "base\n");
        git(seed, "add", "base.txt");
        git(seed, "commit", "-m", "base");
        git(seed, "remote", "add", "origin", remote);
        git(seed, "push", "origin", "main");
        writeFileSync(
          join(seed, "original-feature.txt"),
          "preserved feature\n",
        );
        git(seed, "add", "original-feature.txt");
        git(seed, "commit", "-m", "original feature");
        const head = git(seed, "rev-parse", "HEAD");
        git(seed, "push", "origin", `${head}:refs/pull/42/head`);
        git(root, "clone", remote, workspace);
        process.chdir(workspace);
        const data = {
          contextData: {
            state: "CLOSED",
            title: "Original feature",
            labels: { nodes: [] },
            baseRefName: "main",
            headRefName: "deleted-original",
            headRefOid: head,
            commits: { totalCount: 1 },
          },
        } as unknown as FetchDataResult;
        const context = createMockContext({
          isPR: true,
          entityNumber: 42,
          inputs: { useCommitSigning, branchPrefix: "codex/" },
        });
        const result = await setupBranch(
          { rest: {} } as Octokits,
          data,
          context,
        );
        expect(result.baseBranch).toBe("main");
        expect(result.sourceSha).toBe(head);
        expect(git(workspace, "rev-parse", "HEAD")).toBe(head);
        expect(
          readFileSync(join(workspace, "original-feature.txt"), "utf8"),
        ).toBe("preserved feature\n");
        if (!useCommitSigning)
          expect(git(workspace, "branch", "--show-current")).toBe(
            result.claudeBranch!,
          );
      } finally {
        process.chdir(originalCwd);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
