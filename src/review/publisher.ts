import type { Octokit } from "@octokit/rest";
import { retryWithBackoff } from "../utils/retry";
import {
  findingId,
  renderReview,
  renderFinding,
  reviewSchema,
  reviewHead,
  MAX_REVIEW_COMMENT_BYTES,
} from "./schema";
import { rememberedFromBody, renderReviewMemory } from "./memory";
import { VERIFIED_REVIEW_MARKER } from "./verification";
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
  knownFindings?: Set<string>;
  context: string;
  summaries?: { id: number; head: string; body: string }[];
  review?: { id: number; html_url: string; body: string };
};

/** Retry idempotent review reads on transient GitHub failures. */
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
  verifiedOnly = false,
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
      !!review.commit_id &&
      reviewHead(review.body) === review.commit_id,
  );
  const active = owned.filter(
    (review) =>
      !review.body?.startsWith("Superseded by the [current review](") &&
      (!verifiedOnly || review.body.includes(VERIFIED_REVIEW_MARKER)),
  );
  const reviewedHeads = new Set<string>();
  for (const review of active)
    if (review.commit_id) reviewedHeads.add(review.commit_id);
  const existing = active
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
  const knownFindings = new Set<string>();
  for (const body of [
    ...comments.filter(own).map((comment) => comment.body),
    ...owned.map((review) => review.body || ""),
  ]) {
    for (const finding of rememberedFromBody(body, {
      path: "",
      url: "",
      resolved: null,
    }))
      knownFindings.add(finding.id);
  }
  return {
    findings,
    knownFindings,
    reviewedHeads,
    summaries: owned.map((review) => ({
      id: review.id,
      head: review.commit_id!,
      body: review.body,
    })),
    context,
    review: existing
      ? { id: existing.id, html_url: existing.html_url, body: existing.body }
      : undefined,
  };
}

/** Keep one full current overview while preserving historical reviews and their inline threads. */
export async function retireReviewSummaries(
  client: Octokit,
  target: ReviewTarget,
  current: { id: number; html_url: string },
  history: ReviewHistory,
): Promise<void> {
  const currentPR = await retryRead(() =>
    client.rest.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.pull_number,
    }),
  );
  if (
    currentPR.data.state !== "open" ||
    currentPR.data.head.sha !== target.head
  )
    throw new Error(
      "The pull request changed or closed before overview cleanup; rerun on its current head.",
    );
  for (const previous of history.summaries ?? []) {
    if (previous.id === current.id) continue;
    const memory = renderReviewMemory(
      rememberedFromBody(previous.body, { path: "", url: "", resolved: null }),
    );
    const body = `Superseded by the [current review](${current.html_url}). Historical inline findings remain attached to this review.${memory}\n\n<!-- codex-action:review:${previous.head} -->\n<!-- codex-action:inline-review -->`;
    if (previous.body === body) continue;
    const currentPR = await retryRead(() =>
      client.rest.pulls.get({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.pull_number,
      }),
    );
    if (
      currentPR.data.state !== "open" ||
      currentPR.data.head.sha !== target.head
    )
      throw new Error(
        "The pull request changed or closed before overview cleanup; rerun on its current head.",
      );
    // Updating a known review body is idempotent, unlike creating a new review.
    await retryWithBackoff(
      () =>
        client.rest.pulls.updateReview({
          owner: target.owner,
          repo: target.repo,
          pull_number: target.pull_number,
          review_id: previous.id,
          body,
        }),
      {
        initialDelayMs: 250,
        maxDelayMs: 1000,
        shouldRetry: (error) => {
          const status = (error as Error & { status?: number }).status;
          return status === undefined || status === 429 || status >= 500;
        },
      },
    );
  }
}

/** Submit one native summary and one individually anchored comment per finding. */
export async function publishReview(
  client: Octokit,
  target: ReviewTarget,
  output: unknown,
  verified = false,
): Promise<string | undefined> {
  const parsed = reviewSchema.parse(output);
  const history = await loadReviewHistory(client, target, verified);
  if (history.reviewedHeads.has(target.head)) {
    if (history.review)
      await retireReviewSummaries(client, target, history.review, history);
    return history.review?.html_url;
  }
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
      if (seen.has(id) || (verified && history.knownFindings?.has(id)))
        return false;
      seen.add(id);
      return true;
    }),
  };
  const bounded = (body: string) => {
    if (Buffer.byteLength(body, "utf8") > MAX_REVIEW_COMMENT_BYTES)
      throw new Error(
        "A review comment exceeds the comment size limit. Shorten its evidence and retry; no review was published.",
      );
    return body;
  };
  if (verified && review.findings.length !== parsed.findings.length) {
    review.summary = review.findings.length
      ? `${review.findings.length} new defects confirmed by independent inspection.`
      : "No new confirmed defects; prior findings remain in their existing threads.";
  }
  const summary = bounded(renderReview(review, target.head, target, verified));
  let files: ChangedReviewFile[] = [];
  if (review.findings.length) {
    await requireCurrentHead();
    files = await retryRead(() =>
      client.paginate(client.rest.pulls.listFiles, { ...route, per_page: 100 }),
    );
  }
  const renamedPaths = Object.fromEntries(
    files
      .filter((file) => file.previous_filename)
      .map((file) => [file.previous_filename!, file.filename]),
  );
  const comments = review.findings.map((finding) => {
    const anchor = findReviewAnchor(files, finding);
    if (!anchor)
      throw new Error(
        `Finding at ${finding.path}:${finding.line} (${finding.side}) has no commentable diff location. Regenerate the review with locations in the prepared patch; no review was published.`,
      );
    return {
      ...anchor,
      body: bounded(
        renderFinding(
          finding,
          { ...target, renamedPaths },
          verified ? "high" : undefined,
        ),
      ),
    };
  });
  await requireCurrentHead();
  // Never blindly retry this mutation. A rerun locates a saved completed review.
  const result = await client.rest.pulls.createReview({
    ...route,
    commit_id: target.head,
    event: "COMMENT",
    body: summary,
    comments,
  });
  await retireReviewSummaries(client, target, result.data, history);
  return result.data.html_url;
}
