import type { Octokit } from "@octokit/rest";
import type { GitHubContext } from "../context";

/** A confirmed fork PR is intentionally skipped; unresolved origins must fail. */
export class ForkPullRequestError extends Error {
  constructor(source: string) {
    super(`Fork pull requests are not supported (${source}).`);
    this.name = "ForkPullRequestError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Cannot establish pull request origin: missing metadata.");
  }
  return value as Record<string, unknown>;
}

function repositoryIdentity(value: unknown): string {
  const repository = object(value);
  const fullName = repository.full_name;
  const owner = repository.owner;
  const name = repository.name;
  let identity: string | undefined;
  if (fullName !== undefined) {
    if (typeof fullName !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
      throw new Error(
        "Cannot establish pull request origin: invalid repository.",
      );
    }
    identity = fullName.toLowerCase();
  }
  const login = owner !== undefined ? object(owner).login : undefined;
  if (login !== undefined || name !== undefined) {
    if (
      (login !== undefined &&
        (typeof login !== "string" || !/^[^/\s]+$/.test(login))) ||
      (name !== undefined &&
        (typeof name !== "string" || !/^[^/\s]+$/.test(name)))
    ) {
      throw new Error(
        "Cannot establish pull request origin: invalid repository.",
      );
    }
    const [identityOwner, identityName] = identity?.split("/") ?? [];
    if (
      identity &&
      ((login !== undefined && String(login).toLowerCase() !== identityOwner) ||
        (name !== undefined && String(name).toLowerCase() !== identityName))
    ) {
      throw new Error(
        "Cannot establish pull request origin: ambiguous repository.",
      );
    }
    if (login !== undefined && name !== undefined) {
      identity = `${login}/${name}`.toLowerCase();
    }
  }
  if (!identity) {
    throw new Error(
      "Cannot establish pull request origin: missing repository.",
    );
  }
  return identity;
}

function pullNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Cannot establish pull request origin: missing PR number.");
  }
  return value;
}

/**
 * Call before preparation, checkout, or model invocation with the REST Octokit
 * client. Resolves PR origins from event data or GitHub; API and incomplete-data
 * failures propagate. Only confirmed external repositories use the skip error.
 */
export async function assertNoForkPullRequests(
  context: GitHubContext,
  restClient: Octokit,
): Promise<void> {
  const payload = object(context.payload);
  const currentRepository = `${context.repository.owner}/${context.repository.repo}`;
  const assertRepository = (repository: unknown, source: string) => {
    if (repositoryIdentity(repository) !== currentRepository.toLowerCase()) {
      throw new ForkPullRequestError(source);
    }
  };
  const assertPullRequest = (value: unknown) => {
    assertRepository(object(object(value).head).repo, "pull request head");
  };
  const fetchPullRequest = async (number: unknown) => {
    const response = await restClient.pulls.get({
      owner: context.repository.owner,
      repo: context.repository.repo,
      pull_number: pullNumber(number),
    });
    assertPullRequest(response.data);
  };

  if (
    context.eventName === "pull_request" ||
    context.eventName === "pull_request_review" ||
    context.eventName === "pull_request_review_comment"
  ) {
    assertPullRequest(payload.pull_request);
    return;
  }

  if (context.eventName === "issue_comment" || context.eventName === "issues") {
    const issue = object(payload.issue);
    if (issue.pull_request || ("isPR" in context && context.isPR)) {
      await fetchPullRequest(issue.number);
    }
    return;
  }

  if (context.eventName !== "workflow_run") return;

  const run = object(payload.workflow_run);
  assertRepository(run.head_repository, "workflow run head");
  if (typeof run.event !== "string" || !run.event) {
    throw new Error("Cannot establish pull request origin: missing run event.");
  }
  if (!Array.isArray(run.pull_requests)) {
    throw new Error(
      "Cannot establish pull request origin: missing run associations.",
    );
  }

  // GitHub may omit PR associations in fork-origin workflow runs. PR/comment
  // workflows need a lookup when empty; an unresolved comment origin is unsafe.
  let associatedPullRequests: unknown[] = run.pull_requests;
  // Comment workflows run on the default branch: PRs associated with that SHA
  // cannot identify the commented PR, so do not use commit lookup as evidence.
  if (associatedPullRequests.length === 0 && run.event === "issue_comment") {
    throw new Error(
      "Cannot establish pull request origin: comment workflow has no associations.",
    );
  }
  if (
    associatedPullRequests.length === 0 &&
    run.event.startsWith("pull_request")
  ) {
    if (typeof run.head_sha !== "string" || !run.head_sha) {
      throw new Error(
        "Cannot establish pull request origin: missing run commit.",
      );
    }
    associatedPullRequests = await restClient.paginate(
      restClient.repos.listPullRequestsAssociatedWithCommit,
      {
        owner: context.repository.owner,
        repo: context.repository.repo,
        commit_sha: run.head_sha,
        per_page: 100,
      },
    );
    if (associatedPullRequests.length === 0) {
      throw new Error(
        "Cannot establish pull request origin: PR workflow has no associations.",
      );
    }
  }
  for (const pullRequest of associatedPullRequests) {
    await fetchPullRequest(object(pullRequest).number);
  }
}
