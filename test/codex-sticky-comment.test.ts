import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { createInitialComment } from "../src/github/operations/comments/create-initial";
import { CODEX_COMMENT_MARKER } from "../src/github/operations/comments/common";
import { updateCommentBody } from "../src/github/operations/comment-logic";
import { createMockContext } from "./mockContext";

const originalEnv = { ...process.env };
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "codex-sticky-test-"));
  process.env.GITHUB_OUTPUT = join(directory, "output");
  process.env.ACTION_ENGINE = "codex";
  delete process.env.BOT_NAME;
});
afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(directory, { recursive: true, force: true });
});

const context = () =>
  createMockContext({
    eventName: "pull_request",
    isPR: true,
    inputs: { useStickyComment: true },
  });

test.each([
  ["github-actions[bot]", true, true],
  ["github-actions[bot]", false, false],
  ["untrusted-user", true, false],
])(
  "sticky tracking comment with author %s and marker %s",
  async (author, marker, reuse) => {
    const body = updateCommentBody({
      currentBody: "Review completed",
      actionFailed: false,
      executionDetails: null,
      jobUrl: "https://github.com/owner/repo/actions/runs/previous",
    });
    expect(body).toContain(CODEX_COMMENT_MARKER);
    const update = mock(async () => ({ data: { id: 123 } }));
    const create = mock(async () => ({ data: { id: 456 } }));
    const octokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              {
                id: 123,
                user: { login: author, type: "Bot" },
                body: marker ? body : "An unrelated Actions comment",
              },
            ],
          }),
          updateComment: update,
          createComment: create,
        },
      },
    } as unknown as Octokit;
    const result = await createInitialComment(octokit, context());
    expect(result.id).toBe(reuse ? 123 : 456);
    expect(update.mock.calls.length).toBe(reuse ? 1 : 0);
    expect(create.mock.calls.length).toBe(reuse ? 0 : 1);
  },
);

test("supports a configured custom token author", async () => {
  process.env.BOT_NAME = "my-codex-bot[bot]";
  const update = mock(async () => ({ data: { id: 123 } }));
  const create = mock(async () => ({ data: { id: 456 } }));
  const octokit = {
    rest: {
      issues: {
        listComments: async () => ({
          data: [
            {
              id: 123,
              user: { login: "my-codex-bot[bot]" },
              body: CODEX_COMMENT_MARKER,
            },
          ],
        }),
        updateComment: update,
        createComment: create,
      },
    },
  } as unknown as Octokit;
  expect((await createInitialComment(octokit, context())).id).toBe(123);
  expect(create).not.toHaveBeenCalled();
});
