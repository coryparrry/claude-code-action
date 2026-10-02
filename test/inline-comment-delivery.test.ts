import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import {
  getInlineCommentBufferPath,
  initializeInlineCommentBuffer,
} from "../src/mcp/inline-comment-buffer";
import {
  main,
  type BufferedComment,
} from "../src/entrypoints/post-buffered-inline-comments";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "inline-delivery-test-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const comment = (line: number): BufferedComment => ({
  ts: "now",
  path: "src/main.ts",
  line,
  body: `Fix bug on line ${line}`,
});
const writeBuffer = (path: string, comments: BufferedComment[]) =>
  writeFileSync(
    path,
    comments.map((value) => JSON.stringify(value) + "\n").join(""),
  );

function environment(path: string) {
  return {
    CODEX_INLINE_COMMENTS_BUFFER: path,
    GITHUB_TOKEN: "offline-token",
    REPO_OWNER: "owner",
    REPO_NAME: "repo",
    PR_NUMBER: "12",
  };
}

test("allocates separate buffers for repeated invocations within one runner", () => {
  const env = { RUNNER_TEMP: directory };
  const first = initializeInlineCommentBuffer(env);
  writeBuffer(first, [comment(1)]);
  const second = initializeInlineCommentBuffer(env);
  expect(second).not.toBe(first);
  expect(second.startsWith(directory)).toBe(true);
  expect(readFileSync(second, "utf8")).toBe("");
  expect(getInlineCommentBufferPath({})).toBeUndefined();
  expect(getInlineCommentBufferPath(environment(second))).toBe(second);
});

test("drains successes and filtered probes while preserving failures for retry", async () => {
  const path = initializeInlineCommentBuffer({ RUNNER_TEMP: directory });
  writeBuffer(path, [
    comment(1),
    comment(2),
    comment(3),
    { ...comment(4), confirmed: false },
  ]);
  let failSecond = true;
  const post = mock(async (params: { line?: number }) => {
    if (params.line === 2 && failSecond)
      throw new Error("Offline simulated failure");
    return { data: { id: params.line } };
  });
  const pulls = {
    get: mock(async () => ({ data: { head: { sha: "head-sha" } } })),
    createReviewComment: post,
  };
  const octokit = { pulls, rest: { pulls } } as unknown as Octokit;
  await main({
    env: environment(path),
    octokit,
    classify: async () => [true, true, false],
  });
  expect(post.mock.calls.map(([params]) => params.line)).toEqual([1, 2]);
  expect(readFileSync(path, "utf8")).toBe(JSON.stringify(comment(2)) + "\n");

  failSecond = false;
  await main({ env: environment(path), octokit, classify: async () => [true] });
  expect(post.mock.calls.map(([params]) => params.line)).toEqual([1, 2, 2]);
  expect(readFileSync(path, "utf8")).toBe("");

  await main({
    env: environment(path),
    octokit,
    classify: async () => {
      throw new Error("No further classification expected");
    },
  });
  expect(post).toHaveBeenCalledTimes(3);
});

test("a later invocation does not replay an earlier failed review", async () => {
  const first = initializeInlineCommentBuffer({ RUNNER_TEMP: directory });
  writeBuffer(first, [comment(1)]);
  const second = initializeInlineCommentBuffer({ RUNNER_TEMP: directory });
  const get = mock(async () => {
    throw new Error("No GitHub request expected");
  });
  await main({
    env: environment(second),
    octokit: { pulls: { get } } as unknown as Octokit,
  });
  expect(get).not.toHaveBeenCalled();
  expect(readFileSync(first, "utf8")).toContain("Fix bug on line 1");
});
