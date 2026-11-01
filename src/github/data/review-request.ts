import type { Octokits } from "../api/client";
import { retryGitHubRead } from "../api/retry";
import { GITHUB_API_URL } from "../api/config";
import {
  isPullRequestReviewCommentEvent,
  type ParsedGitHubContext,
} from "../context";
import { filterCommentsByActor, filterCommentsToTriggerTime } from "./fetcher";

export type ReviewLocation = {
  path: string;
  line: number | null;
  originalLine: number | null;
  commitId: string;
  diffHunk: string;
  side?: string;
  startLine?: number | null;
  originalStartLine?: number | null;
  startSide?: string | null;
  originalCommitId?: string | null;
};

export type ReviewRequest = ReviewLocation & {
  commentId: number;
  parentLocation?: ReviewLocation;
  parentId?: number;
  parentBody?: string;
  parentUnavailable?: boolean;
  attachmentIds?: string[];
};

/** Preserve the trigger's location and resolve its parent beyond paged PR context. */
export async function fetchReviewRequest(
  context: ParsedGitHubContext,
  octokits: Octokits,
): Promise<ReviewRequest | undefined> {
  if (!isPullRequestReviewCommentEvent(context)) return undefined;
  const comment = context.payload.comment;
  const request: ReviewRequest = {
    commentId: comment.id,
    path: comment.path,
    line: comment.line ?? null,
    originalLine: comment.original_line ?? null,
    commitId: comment.commit_id,
    diffHunk: comment.diff_hunk,
    side: comment.side,
    startLine: comment.start_line,
    originalStartLine: comment.original_start_line,
    startSide: comment.start_side,
    originalCommitId: comment.original_commit_id,
    ...(comment.in_reply_to_id && { parentId: comment.in_reply_to_id }),
  };
  if (!request.parentId) return request;

  // A reply's parent is not necessarily in the first page of GraphQL reviews.
  // Apply the same actor and event-time boundaries used for general context.
  request.parentUnavailable = true;
  try {
    const { owner, repo } = context.repository;
    const { data: parent } = await retryGitHubRead(() =>
      octokits.rest.pulls.getReviewComment({
        owner,
        repo,
        comment_id: request.parentId!,
      }),
    );
    const expectedPR = `${GITHUB_API_URL.replace(/\/+$/, "")}/repos/${owner}/${repo}/pulls/${context.entityNumber}`;
    if (parent.pull_request_url !== expectedPR) return request;
    const timestamps = [
      comment.created_at,
      parent.created_at,
      parent.updated_at,
    ];
    if (timestamps.some((time) => !Number.isFinite(Date.parse(time))))
      return request;
    const safeParents = filterCommentsByActor(
      filterCommentsToTriggerTime(
        [
          {
            body: parent.body,
            createdAt: parent.created_at,
            updatedAt: parent.updated_at,
            author: parent.user
              ? { login: parent.user.login, __typename: parent.user.type }
              : null,
          },
        ],
        comment.created_at,
      ),
      context.inputs.includeCommentsByActor,
      context.inputs.excludeCommentsByActor,
    );
    if (safeParents.length) {
      const moderation = await retryGitHubRead(() =>
        octokits.graphql<{ node: { isMinimized: boolean } | null }>(
          "query($id: ID!) { node(id: $id) { ... on PullRequestReviewComment { isMinimized } } }",
          { id: parent.node_id },
        ),
      );
      if (moderation.node?.isMinimized !== false) return request;
      request.parentBody = parent.body;
      request.parentLocation = {
        path: parent.path,
        line: parent.line ?? null,
        originalLine: parent.original_line ?? null,
        commitId: parent.commit_id,
        diffHunk: parent.diff_hunk,
        side: parent.side,
        startLine: parent.start_line,
        originalStartLine: parent.original_start_line,
        startSide: parent.start_side,
        originalCommitId: parent.original_commit_id,
      };
      request.parentUnavailable = false;
    }
  } catch {
    // Missing/deleted/inaccessible context must not turn a vague reply into an
    // instruction to guess. The prompt explicitly reports this limitation.
    console.warn("Could not retrieve the triggering review comment's parent");
  }
  return request;
}
