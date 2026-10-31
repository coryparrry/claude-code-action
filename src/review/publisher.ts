import type { Octokit } from "@octokit/rest";
import { retryWithBackoff } from "../utils/retry";
import { findingId, renderFinding, renderReview, reviewSchema } from "./schema";

export type ReviewTarget = {
  owner: string;
  repo: string;
  pull_number: number;
  head: string;
  author: string;
};
export type ReviewHistory = {
  findings: Set<string>;
  reviewedHeads: Set<string>;
  context: string;
};

const read = <T>(operation: () => Promise<T>) =>
  retryWithBackoff(operation, {
    initialDelayMs: 250,
    shouldRetry: (error) => {
      const status = (error as Error & { status?: number }).status;
      return status === undefined || status === 429 || status >= 500;
    },
  });

/** Fetch only this bot's marked feedback; discussion text is untrusted context. */
export async function loadReviewHistory(
  client: Octokit,
  target: ReviewTarget,
): Promise<ReviewHistory> {
  const route = {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pull_number,
  };
  const [reviews, comments] = await Promise.all([
    read(() =>
      client.paginate(client.rest.pulls.listReviews, {
        ...route,
        per_page: 100,
      }),
    ),
    read(() =>
      client.paginate(client.rest.pulls.listReviewComments, {
        ...route,
        per_page: 100,
      }),
    ),
  ]);
  const own = (item: { user: { login: string } | null }) =>
    item.user?.login.toLowerCase() === target.author.toLowerCase();
  const findings = new Set<string>();
  const reviewedHeads = new Set<string>();
  const context: string[] = [];
  for (const review of reviews.filter(own)) {
    const marker = review.body.match(
      /<!-- codex-action:review:([a-f0-9]{40}) -->\s*$/,
    );
    if (
      !marker ||
      marker[1] !== review.commit_id ||
      review.state !== "COMMENTED"
    )
      continue;
    reviewedHeads.add(marker[1]!);
    context.push(`Prior review at ${review.commit_id}:\n${review.body}`);
  }
  for (const comment of comments.filter(own)) {
    const marker = comment.body.match(
      /<!-- codex-action:finding:([a-f0-9]{12}) -->\s*$/,
    );
    if (!marker) continue;
    findings.add(marker[1]!);
    context.push(`Existing finding in ${comment.path}:\n${comment.body}`);
  }
  return {
    findings,
    reviewedHeads,
    context: context.slice(-30).join("\n\n").slice(-48000),
  };
}

/** Submit the summary and inline findings atomically against the reviewed SHA. */
export async function publishReview(
  client: Octokit,
  target: ReviewTarget,
  output: unknown,
): Promise<string | undefined> {
  const review = reviewSchema.parse(output);
  const history = await loadReviewHistory(client, target);
  if (history.reviewedHeads.has(target.head)) return;
  const current = await read(() =>
    client.rest.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.pull_number,
    }),
  );
  if (current.data.head.sha !== target.head || current.data.state !== "open")
    throw new Error(
      "The pull request changed or closed during review; no review was published. Run again on its current head.",
    );
  const seen = new Set(history.findings);
  const findings = review.findings.filter((finding) => {
    const id = findingId(finding);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const body = renderReview(
    { ...review, findings },
    target.head,
    review.findings.length > 0 && findings.length === 0,
  );
  // Do not retry this mutation: an ambiguous timeout may follow successful delivery.
  // A workflow rerun reads the persisted review marker before attempting another post.
  const result = await client.rest.pulls.createReview({
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pull_number,
    commit_id: target.head,
    event: "COMMENT",
    body,
    comments: findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: renderFinding(finding),
    })),
  });
  return result.data.html_url;
}
