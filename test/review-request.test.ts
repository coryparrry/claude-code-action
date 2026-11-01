import { describe, expect, spyOn, test } from "bun:test";
import type { Octokits } from "../src/github/api/client";
import { GITHUB_API_URL } from "../src/github/api/config";
import { fetchReviewRequest } from "../src/github/data/review-request";
import {
  mockPullRequestReviewCommentContext,
  mockIssueCommentContext,
} from "./mockContext";
import type { PullRequestReviewCommentEvent } from "@octokit/webhooks-types";

/** Build a real-shaped inline reply and its independently fetched parent. */
function fixture(overrides: Record<string, unknown> = {}) {
  const context = structuredClone(mockPullRequestReviewCommentContext);
  const payload = context.payload as PullRequestReviewCommentEvent;
  Object.assign(payload.comment, {
    body: "/codex fix this",
    in_reply_to_id: 17,
    diff_hunk: "@@ -1 +1 @@\n-old\n+new",
    line: null,
    original_line: 42,
    side: "RIGHT",
  });
  const parent = {
    id: 17,
    node_id: "PRRC_parent",
    body: "This drops the empty-input case.",
    path: "src/original.ts",
    line: 9,
    original_line: 9,
    side: "LEFT",
    start_line: 6,
    original_start_line: 6,
    start_side: "LEFT",
    commit_id: "parent-commit",
    original_commit_id: "original-parent",
    diff_hunk: "@@ -6,4 +6,1 @@",
    created_at: "2024-01-15T16:00:00Z",
    updated_at: "2024-01-15T16:00:00Z",
    pull_request_url: `${GITHUB_API_URL}/repos/test-owner/test-repo/pulls/999`,
    user: { login: "reviewer[bot]", type: "Bot" },
    ...overrides,
  };
  const calls: unknown[] = [];
  const octokits = {
    graphql: async () => ({ node: { isMinimized: false } }),
    rest: {
      pulls: {
        getReviewComment: async (params: unknown) => {
          calls.push(params);
          return { data: parent };
        },
      },
    },
  } as unknown as Octokits;
  return { context, octokits, calls };
}

describe("inline implementation request context", () => {
  test("resolves an out-of-page parent and preserves outdated line metadata", async () => {
    const { context, octokits, calls } = fixture();
    const result = await fetchReviewRequest(context, octokits);
    expect(calls).toEqual([
      { owner: "test-owner", repo: "test-repo", comment_id: 17 },
    ]);
    expect(result).toMatchObject({
      path: "src/utils/algorithm.js",
      line: null,
      originalLine: 42,
      commitId: "xyz789abc123",
      parentId: 17,
      parentBody: "This drops the empty-input case.",
      parentUnavailable: false,
      side: "RIGHT",
      parentLocation: {
        path: "src/original.ts",
        side: "LEFT",
        startLine: 6,
        line: 9,
        originalStartLine: 6,
        startSide: "LEFT",
        originalCommitId: "original-parent",
      },
    });
  });

  for (const overrides of [
    { updated_at: "2024-01-15T16:45:00Z" },
    { created_at: "2024-01-15T16:46:00Z" },
    { updated_at: "invalid" },
    {
      pull_request_url: `${GITHUB_API_URL}/repos/test-owner/test-repo/pulls/1000`,
    },
  ]) {
    test(`withholds unsafe parent context: ${JSON.stringify(overrides)}`, async () => {
      const { context, octokits } = fixture(overrides);
      const result = await fetchReviewRequest(context, octokits);
      expect(result?.parentUnavailable).toBe(true);
      expect(result?.parentBody).toBeUndefined();
    });
  }

  for (const node of [{ isMinimized: true }, null, {}]) {
    test(`withholds minimized or unverifiable parent: ${JSON.stringify(node)}`, async () => {
      const { context, octokits } = fixture();
      octokits.graphql = (async () => ({
        node,
      })) as unknown as typeof octokits.graphql;
      const result = await fetchReviewRequest(context, octokits);
      expect(result?.parentUnavailable).toBe(true);
      expect(result?.parentBody).toBeUndefined();
    });
  }

  test("respects bot actor exclusion", async () => {
    const { context, octokits } = fixture();
    context.inputs.excludeCommentsByActor = "*[bot]";
    expect(
      (await fetchReviewRequest(context, octokits))?.parentBody,
    ).toBeUndefined();
  });

  test("handles a deleted author without dropping otherwise safe context", async () => {
    const { context, octokits } = fixture({ user: null });
    expect((await fetchReviewRequest(context, octokits))?.parentBody).toContain(
      "empty-input",
    );
  });

  test("reports unavailable context on API failure", async () => {
    const { context, octokits } = fixture();
    const spy = spyOn(
      octokits.rest.pulls,
      "getReviewComment",
    ).mockRejectedValue(Object.assign(new Error("404"), { status: 404 }));
    try {
      expect(
        (await fetchReviewRequest(context, octokits))?.parentUnavailable,
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("makes no parent API call for a new thread or another event", async () => {
    const { context, octokits, calls } = fixture();
    delete (context.payload as PullRequestReviewCommentEvent).comment
      .in_reply_to_id;
    expect((await fetchReviewRequest(context, octokits))?.path).toBe(
      "src/utils/algorithm.js",
    );
    expect(
      await fetchReviewRequest(mockIssueCommentContext, octokits),
    ).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
