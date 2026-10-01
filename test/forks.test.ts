import { describe, expect, mock, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import {
  assertNoForkPullRequests,
  ForkPullRequestError,
} from "../src/github/validation/forks";
import { createMockAutomationContext, createMockContext } from "./mockContext";

const sameRepository = { full_name: "test-owner/test-repo" };
const forkRepository = { full_name: "contributor/test-repo" };
const pull = (repository: unknown = sameRepository) => ({
  number: 1,
  head: { repo: repository },
});
const client = (repository: unknown = sameRepository) => {
  const get = mock(async () => ({ data: pull(repository) }));
  const paginate = mock(async () => [{ number: 1 }]);
  return {
    get,
    paginate,
    rest: {
      pulls: { get },
      repos: { listPullRequestsAssociatedWithCommit: mock() },
      paginate,
    } as unknown as Octokit,
  };
};
const prContext = (
  repository: unknown = sameRepository,
  eventName:
    | "pull_request"
    | "pull_request_review"
    | "pull_request_review_comment" = "pull_request",
) =>
  createMockContext({
    eventName,
    isPR: true,
    payload: { pull_request: pull(repository) } as any,
  });
const commentContext = (isPR = true) =>
  createMockContext({
    eventName: "issue_comment",
    isPR,
    payload: {
      issue: { number: 1, ...(isPR ? { pull_request: {} } : {}) },
    } as any,
  });
const workflowContext = (overrides: Record<string, unknown> = {}) =>
  createMockAutomationContext({
    eventName: "workflow_run",
    payload: {
      workflow_run: {
        event: "push",
        head_repository: sameRepository,
        pull_requests: [],
        head_sha: "0123456789abcdef",
        ...overrides,
      },
    } as any,
  });

describe("assertNoForkPullRequests", () => {
  for (const eventName of [
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
  ] as const) {
    test(`allows same-repository ${eventName} without an API lookup`, async () => {
      const api = client();
      await assertNoForkPullRequests(
        prContext(sameRepository, eventName),
        api.rest,
      );
      expect(api.get).not.toHaveBeenCalled();
    });

    test(`blocks fork ${eventName} even for an allowed actor`, async () => {
      const context = prContext(forkRepository, eventName);
      context.actor = "repository-admin";
      await expect(
        assertNoForkPullRequests(context, client().rest),
      ).rejects.toBeInstanceOf(ForkPullRequestError);
    });
  }

  test("compares case-insensitive repository identity, not the fork flag", async () => {
    await assertNoForkPullRequests(
      prContext({ full_name: "TEST-OWNER/TEST-REPO", fork: true }),
      client().rest,
    );
    await assertNoForkPullRequests(
      prContext({ owner: { login: "test-owner" }, name: "test-repo" }),
      client().rest,
    );
  });

  for (const repository of [
    null,
    {},
    { full_name: "" },
    {
      full_name: "test-owner/test-repo",
      name: "other-repo",
    },
    {
      full_name: "test-owner/test-repo",
      owner: { login: "contributor" },
      name: "test-repo",
    },
  ]) {
    test(`fails closed for missing or ambiguous direct PR identity: ${JSON.stringify(repository)}`, async () => {
      await expect(
        assertNoForkPullRequests(prContext(repository), client().rest),
      ).rejects.toThrow("Cannot establish pull request origin");
    });
  }

  test("looks up and allows a same-repository PR issue comment", async () => {
    const api = client();
    await assertNoForkPullRequests(commentContext(), api.rest);
    expect(api.get).toHaveBeenCalledWith({
      owner: "test-owner",
      repo: "test-repo",
      pull_number: 1,
    });
  });

  test("blocks a fork referenced by an issue comment", async () => {
    await expect(
      assertNoForkPullRequests(commentContext(), client(forkRepository).rest),
    ).rejects.toBeInstanceOf(ForkPullRequestError);
  });

  test("uses PR metadata even if an issue comment's parsed isPR is false", async () => {
    const context = commentContext();
    context.isPR = false;
    await expect(
      assertNoForkPullRequests(context, client(forkRepository).rest),
    ).rejects.toBeInstanceOf(ForkPullRequestError);
  });

  test("fails closed when a comment lookup has a deleted head repository", async () => {
    await expect(
      assertNoForkPullRequests(commentContext(), client(null).rest),
    ).rejects.toThrow("Cannot establish pull request origin");
  });

  test("propagates API lookup errors instead of classifying them as a safe skip", async () => {
    const api = client();
    api.get.mockImplementation(async () => {
      throw new Error("API unavailable");
    });
    await expect(
      assertNoForkPullRequests(commentContext(), api.rest),
    ).rejects.toThrow("API unavailable");
  });

  test("allows ordinary issues, issue comments, and workflow dispatch", async () => {
    const api = client();
    await assertNoForkPullRequests(commentContext(false), api.rest);
    await assertNoForkPullRequests(
      createMockContext({
        eventName: "issues",
        payload: { issue: { number: 1 } } as any,
      }),
      api.rest,
    );
    await assertNoForkPullRequests(createMockAutomationContext(), api.rest);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.paginate).not.toHaveBeenCalled();
  });

  test("blocks a workflow run whose head repository is a fork", async () => {
    await expect(
      assertNoForkPullRequests(
        workflowContext({
          head_repository: forkRepository,
        }),
        client().rest,
      ),
    ).rejects.toBeInstanceOf(ForkPullRequestError);
  });

  test("allows a same-repository push workflow without PR associations", async () => {
    const api = client();
    await assertNoForkPullRequests(workflowContext(), api.rest);
    expect(api.get).not.toHaveBeenCalled();
  });

  test("looks up abbreviated workflow associations and blocks fork PRs", async () => {
    const api = client(forkRepository);
    await expect(
      assertNoForkPullRequests(
        workflowContext({
          pull_requests: [{ number: 1, head: { repo: { name: "test-repo" } } }],
        }),
        api.rest,
      ),
    ).rejects.toBeInstanceOf(ForkPullRequestError);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  test("checks every associated PR rather than accepting the first safe one", async () => {
    const api = client();
    api.get.mockImplementation(async () => ({ data: pull(sameRepository) }));
    api.get.mockImplementationOnce(async () => ({
      data: pull(sameRepository),
    }));
    api.get.mockImplementationOnce(async () => ({
      data: pull(forkRepository),
    }));
    await expect(
      assertNoForkPullRequests(
        workflowContext({
          pull_requests: [{ number: 1 }, { number: 2 }],
        }),
        api.rest,
      ),
    ).rejects.toBeInstanceOf(ForkPullRequestError);
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  test("resolves missing associations for PR workflow runs through all API pages", async () => {
    const api = client();
    await assertNoForkPullRequests(
      workflowContext({ event: "pull_request" }),
      api.rest,
    );
    expect(api.paginate).toHaveBeenCalledWith(
      api.rest.repos.listPullRequestsAssociatedWithCommit,
      {
        owner: "test-owner",
        repo: "test-repo",
        commit_sha: "0123456789abcdef",
        per_page: 100,
      },
    );
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  test("fails closed if a PR workflow has no resolvable associations", async () => {
    const api = client();
    api.paginate.mockImplementation(async () => []);
    await expect(
      assertNoForkPullRequests(
        workflowContext({ event: "pull_request_target" }),
        api.rest,
      ),
    ).rejects.toThrow("PR workflow has no associations");
  });

  test("fails closed if an upstream comment workflow has no resolvable origin", async () => {
    const api = client();
    api.paginate.mockImplementation(async () => []);
    await expect(
      assertNoForkPullRequests(
        workflowContext({ event: "issue_comment" }),
        api.rest,
      ),
    ).rejects.toThrow("comment workflow has no associations");
    expect(api.paginate).not.toHaveBeenCalled();
  });

  for (const overrides of [
    { head_repository: null },
    { pull_requests: undefined },
    { pull_requests: [{ number: 0 }] },
    { event: undefined },
    { event: "pull_request", head_sha: undefined },
  ]) {
    test(`fails closed for incomplete workflow origin: ${JSON.stringify(overrides)}`, async () => {
      await expect(
        assertNoForkPullRequests(workflowContext(overrides), client().rest),
      ).rejects.toThrow("Cannot establish pull request origin");
    });
  }

  test("propagates association lookup errors", async () => {
    const api = client();
    api.paginate.mockImplementation(async () => {
      throw new Error("API unavailable");
    });
    await expect(
      assertNoForkPullRequests(
        workflowContext({ event: "pull_request" }),
        api.rest,
      ),
    ).rejects.toThrow("API unavailable");
  });
});
