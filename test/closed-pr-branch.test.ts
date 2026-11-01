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
  for (const { useCommitSigning, state, override } of [
    { useCommitSigning: false, state: "CLOSED", override: "" },
    { useCommitSigning: true, state: "CLOSED", override: "alternate" },
    { useCommitSigning: false, state: "MERGED", override: "" },
  ]) {
    test(`preserves ${state} ancestry and target with signing ${useCommitSigning}, override ${override}`, async () => {
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
        git(seed, "checkout", "-B", "main", "origin/main");
        writeFileSync(join(seed, "base.txt"), "new base\n");
        git(seed, "add", "base.txt");
        git(seed, "commit", "-m", "advance target");
        const target = git(seed, "rev-parse", "HEAD");
        for (const branch of ["main", "release", "alternate"])
          git(seed, "push", "origin", `HEAD:refs/heads/${branch}`);
        git(root, "clone", "--depth=1", `file://${remote}`, workspace);
        process.chdir(workspace);
        const data = {
          contextData: {
            state,
            title: "Original feature",
            labels: { nodes: [] },
            baseRefName: "release",
            headRefName: "deleted-original",
            headRefOid: head,
            commits: { totalCount: 1 },
          },
        } as unknown as FetchDataResult;
        const context = createMockContext({
          isPR: true,
          entityNumber: 42,
          inputs: {
            useCommitSigning,
            branchPrefix: "codex/",
            baseBranch: override,
          },
        });
        const result = await setupBranch(
          {
            rest: {
              git: {
                getRef: async () => ({ data: { object: { sha: target } } }),
              },
            },
          } as unknown as Octokits,
          data,
          context,
        );
        expect(result.baseBranch).toBe(override || "release");
        expect(git(workspace, "rev-parse", "HEAD")).toBe(
          state === "CLOSED" ? head : target,
        );
        if (state === "CLOSED") {
          expect(result.sourceSha).toBe(head);
          expect(
            readFileSync(join(workspace, "original-feature.txt"), "utf8"),
          ).toBe("preserved feature\n");
          expect(
            git(
              workspace,
              "merge-base",
              `origin/${override || "release"}`,
              "HEAD",
            ),
          ).toMatch(/^[a-f0-9]{40}$/);
        } else
          expect(readFileSync(join(workspace, "base.txt"), "utf8")).toBe(
            "new base\n",
          );
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
