import { expect, mock, test } from "bun:test";
import { updateCommentLink } from "../src/entrypoints/update-comment-link";
import type { Octokits } from "../src/github/api/client";
import { createMockContext } from "./mockContext";

function fixture(status: number) {
  const getIssue = mock(async () => ({ data: { body: "Codex is working…" } }));
  const updateIssue = mock(async () => ({ data: { id: 45 } }));
  const updateReview = mock(async () => ({ data: { id: 45 } }));
  const api = {
    pulls: {
      getReviewComment: mock(async () => {
        throw Object.assign(new Error("Review comment unavailable"), {
          status,
        });
      }),
      get: mock(async () => ({ data: {} })),
      updateReviewComment: updateReview,
    },
    issues: { getComment: getIssue, updateComment: updateIssue },
  };
  return {
    getIssue,
    updateIssue,
    updateReview,
    params: {
      commentId: 45,
      githubToken: "offline-test-token",
      baseBranch: "main",
      context: createMockContext({
        eventName: "pull_request_review_comment",
        isPR: true,
      }),
      octokit: { rest: { ...api, rest: api } } as unknown as Octokits,
      claudeSuccess: true,
      prepareSuccess: true,
      useCommitSigning: false,
    },
  };
}

test("finalizes an issue fallback created for a review-comment trigger", async () => {
  const { params, getIssue, updateIssue, updateReview } = fixture(404);
  await updateCommentLink(params);
  expect(getIssue).toHaveBeenCalledTimes(1);
  expect(updateIssue).toHaveBeenCalledTimes(1);
  expect(updateReview).not.toHaveBeenCalled();
  expect((updateIssue.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
    comment_id: 45,
    body: expect.stringContaining("finished"),
  });
});

test("does not reinterpret authorization failures as an issue fallback", async () => {
  const { params, getIssue, updateIssue } = fixture(403);
  await expect(updateCommentLink(params)).rejects.toThrow(
    "Review comment unavailable",
  );
  expect(getIssue).not.toHaveBeenCalled();
  expect(updateIssue).not.toHaveBeenCalled();
});

test("shows failed delivery using the existing tracking comment error format", async () => {
  const { params, updateIssue } = fixture(404);
  await updateCommentLink({
    ...params,
    claudeSuccess: false,
    deliveryError: "Inline feedback delivery failed: GitHub rejected the line",
  });
  const body = (updateIssue.mock.calls as unknown[][])[0]?.[0] as {
    body: string;
  };
  expect(body.body).toContain("Codex encountered an error");
  expect(body.body).toContain("GitHub rejected the line");
  expect(body.body).not.toContain("finished");
});
