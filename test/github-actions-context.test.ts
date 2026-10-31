import { describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import {
  getCIStatus,
  getWorkflowRunDetails,
  summarizeWorkflowRuns,
} from "../src/mcp/github-actions-context";

type Run = Parameters<typeof summarizeWorkflowRuns>[0][number];
function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 1,
    workflow_id: 10,
    event: "pull_request",
    head_branch: "feature",
    head_sha: "current",
    run_number: 1,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    ...overrides,
  } as Run;
}

describe("CI diagnosis context", () => {
  test("counts every outcome without treating cancelled/skipped/unknown runs as passed", () => {
    const conclusions = [
      "success",
      "failure",
      "timed_out",
      "action_required",
      "startup_failure",
      "cancelled",
      "skipped",
      "neutral",
      null,
    ];
    const runs = conclusions.map((conclusion, i) =>
      run({ workflow_id: i, conclusion }),
    );
    runs.push(
      run({ workflow_id: 100, status: "in_progress", conclusion: null }),
    );
    expect(summarizeWorkflowRuns(runs).summary).toEqual({
      total_runs: 10,
      failed: 4,
      passed: 1,
      pending: 1,
      cancelled: 1,
      skipped: 1,
      neutral: 1,
      unknown: 1,
      superseded_runs: 0,
    });
  });

  test("selects the latest run and attempt before applying a failure filter", () => {
    const runs = [
      run({ id: 3, run_number: 2, run_attempt: 2, conclusion: "success" }),
      run({ id: 2, run_number: 2, run_attempt: 1 }),
      run({ id: 1, run_number: 1 }),
    ];
    expect(summarizeWorkflowRuns(runs).runs.map((item) => item.id)).toEqual([
      3,
    ]);
    expect(summarizeWorkflowRuns(runs, "failure").summary).toMatchObject({
      total_runs: 0,
      superseded_runs: 2,
    });
  });

  test("keeps distinct workflows and events even when names match", () => {
    const runs = [run(), run({ workflow_id: 11 }), run({ event: "push" })];
    expect(summarizeWorkflowRuns(runs).summary.failed).toBe(3);
  });

  test("fetches the current PR revision and does not prefilter away superseding success", async () => {
    const requests: unknown[] = [];
    const client = {
      pulls: { get: async () => ({ data: { head: { sha: "current" } } }) },
      actions: { listWorkflowRunsForRepo: () => {} },
      paginate: async (_method: unknown, params: unknown) => {
        requests.push(params);
        return [run(), run({ id: 2, run_number: 2, conclusion: "success" })];
      },
    } as unknown as Octokit;
    const result = await getCIStatus(
      client,
      { owner: "o", repo: "r", pull_number: 1 },
      "failure",
    );
    expect(requests).toEqual([{ owner: "o", repo: "r", head_sha: "current" }]);
    expect(result.head_sha).toBe("current");
    expect(result.summary.total_runs).toBe(0);
  });

  test("marks stale evidence and includes setup failures and latest-attempt steps", async () => {
    const requests: unknown[] = [];
    const client = {
      pulls: { get: async () => ({ data: { head: { sha: "new" } } }) },
      actions: {
        getWorkflowRun: async () => ({ data: run({ head_sha: "old" }) }),
        listJobsForWorkflowRun: () => {},
      },
      paginate: async (_method: unknown, params: unknown) => {
        requests.push(params);
        return [
          {
            id: 2,
            status: "completed",
            conclusion: "timed_out",
            steps: [
              {
                name: "Setup",
                number: 1,
                status: "completed",
                conclusion: "timed_out",
              },
              {
                name: "Tests",
                number: 2,
                status: "completed",
                conclusion: "skipped",
              },
            ],
          },
        ];
      },
    } as unknown as Octokit;
    const result = await getWorkflowRunDetails(client, {
      owner: "o",
      repo: "r",
      pull_number: 1,
      run_id: 3,
    });
    expect(requests).toEqual([
      { owner: "o", repo: "r", run_id: 3, filter: "latest" },
    ]);
    expect(result.is_current_head).toBe(false);
    expect(result.head_sha).toBe("old");
    expect(result.current_head_sha).toBe("new");
    expect(result.jobs[0]?.failed_steps).toEqual([
      { name: "Setup", number: 1 },
    ]);
    expect(result.jobs[0]?.steps[1]?.conclusion).toBe("skipped");
  });
});
