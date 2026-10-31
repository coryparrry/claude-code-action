import type { Octokit } from "@octokit/rest";
import { retryWithBackoff } from "../utils/retry";
import {
  findingId,
  renderReview,
  renderFindings,
  reviewSchema,
  reviewHead,
  MAX_REVIEW_COMMENT_BYTES,
} from "./schema";
import { findReviewAnchor, type ChangedReviewFile } from "./anchor";

export type ReviewTarget = {
  owner: string;
  repo: string;
  pull_number: number;
  head: string;
  base: string;
  author: string;
};
export type ReviewHistory = {
  findings: Set<string>;
  reviewedHeads: Set<string>;
  context: string;
  review?: { id: number; html_url: string; body: string };
};

const retryRead = <T>(operation: () => Promise<T>) =>
  retryWithBackoff(operation, {
    initialDelayMs: 250,
    shouldRetry: (error) => {
      const status = (error as Error & { status?: number }).status;
      return status === undefined || status === 429 || status >= 500;
    },
  });

/** Reuse completed native reviews on reruns and retain the latest review's full evidence. */
export async function loadReviewHistory(
  client: Octokit,
  target: ReviewTarget,
): Promise<ReviewHistory> {
  const route = {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pull_number,
    per_page: 100,
  };
  const [reviews, comments] = await Promise.all([
    retryRead(() => client.paginate(client.rest.pulls.listReviews, route)),
    retryRead(() =>
      client.paginate(client.rest.pulls.listReviewComments, route),
    ),
  ]);
  const own = (item: { user: { login: string } | null }) =>
    item.user?.login.toLowerCase() === target.author.toLowerCase();
  const owned = reviews.filter(
    (review) =>
      own(review) &&
      review.state === "COMMENTED" &&
      reviewHead(review.body) === review.commit_id,
  );
  const reviewedHeads = new Set<string>();
  for (const review of owned)
    if (review.commit_id) reviewedHeads.add(review.commit_id);
  const existing = owned
    .filter((review) => review.commit_id === target.head)
    .at(-1);
  const latest = owned.at(-1);
  const currentComments = comments.filter(
    (comment) => own(comment) && comment.pull_request_review_id === latest?.id,
  );
  const context = latest
    ? [
        latest.body,
        ...currentComments.map(
          (comment) =>
            `Finding discussion in ${comment.path}:\n${comment.body}`,
        ),
      ].join("\n\n")
    : "";
  const findings = new Set<string>();
  for (const marker of context.matchAll(
    /<!-- codex-action:finding:([a-f0-9]{12}) -->/g,
  ))
    findings.add(marker[1]!);
  return {
    findings,
    reviewedHeads,
    context,
    review: existing
      ? { id: existing.id, html_url: existing.html_url, body: existing.body }
      : undefined,
  };
}

/** One native summary and at most one grouped inline discussion, submitted together. */
export async function publishReview(
  client: Octokit,
  target: ReviewTarget,
  output: unknown,
): Promise<string | undefined> {
  const parsed = reviewSchema.parse(output);
  const history = await loadReviewHistory(client, target);
  if (history.reviewedHeads.has(target.head)) return history.review?.html_url;
  const route = {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pull_number,
  };
  const requireCurrentHead = async () => {
    const current = await retryRead(() => client.rest.pulls.get(route));
    if (current.data.head.sha !== target.head || current.data.state !== "open")
      throw new Error(
        "The pull request changed or closed during review; no review was published. Run again on its current head.",
      );
  };
  const seen = new Set<string>();
  const review = {
    ...parsed,
    findings: parsed.findings.filter((finding) => {
      const id = findingId(finding);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  };
  const bounded = (body: string) => {
    if (Buffer.byteLength(body, "utf8") > MAX_REVIEW_COMMENT_BYTES)
      throw new Error(
        "The grouped review exceeds the comment size limit. Shorten its evidence and retry; no extra finding threads were created.",
      );
    return body;
  };
  let summary = bounded(renderReview(review, target.head, target));
  let grouped = review.findings.length
    ? bounded(renderFindings(review, target.head, target))
    : undefined;
  let files: ChangedReviewFile[] = [];
  if (grouped) {
    await requireCurrentHead();
    files = await retryRead(() =>
      client.paginate(client.rest.pulls.listFiles, { ...route, per_page: 100 }),
    );
  }
  const anchor = grouped ? findReviewAnchor(files, review.findings) : undefined;
  if (grouped) {
    const renamedPaths = Object.fromEntries(
      files
        .filter((file) => file.previous_filename)
        .map((file) => [file.previous_filename!, file.filename]),
    );
    const location = { ...target, renamedPaths };
    grouped = bounded(renderFindings(review, target.head, location));
    if (!anchor)
      summary = bounded(renderReview(review, target.head, location, true));
  }
  await requireCurrentHead();
  // Never blindly retry this mutation. A rerun locates a saved completed review.
  const result = await client.rest.pulls.createReview({
    ...route,
    commit_id: target.head,
    event: "COMMENT",
    body: summary,
    comments: anchor && grouped ? [{ ...anchor, body: grouped }] : [],
  });
  return result.data.html_url;
}
