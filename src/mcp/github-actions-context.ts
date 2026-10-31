import type { Octokit } from "@octokit/rest";
import {
  listWorkflowJobs,
  listWorkflowRuns,
} from "./github-actions-pagination";

type WorkflowRun = Awaited<ReturnType<typeof listWorkflowRuns>>[number];
type PRParams = { owner: string; repo: string; pull_number: number };
const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
]);

/** Keep independent workflow invocations and collapse only attempts of the same run. */
export function summarizeWorkflowRuns(runs: WorkflowRun[], status?: string) {
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const key = String(run.id);
    const previous = latest.get(key);
    if (
      !previous ||
      run.run_number > previous.run_number ||
      (run.run_number === previous.run_number &&
        (run.run_attempt ?? 1) > (previous.run_attempt ?? 1))
    ) {
      latest.set(key, run);
    }
  }
  const currentRuns = [...latest.values()].filter(
    (run) => !status || run.status === status || run.conclusion === status,
  );
  const summary = {
    total_runs: currentRuns.length,
    failed: 0,
    passed: 0,
    pending: 0,
    cancelled: 0,
    skipped: 0,
    neutral: 0,
    unknown: 0,
    superseded_runs: runs.length - latest.size,
  };
  for (const run of currentRuns) {
    if (run.status === "action_required") summary.failed++;
    else if (run.status !== "completed") summary.pending++;
    else if (FAILURE_CONCLUSIONS.has(run.conclusion ?? "")) summary.failed++;
    else if (run.conclusion === "success") summary.passed++;
    else if (run.conclusion === "cancelled") summary.cancelled++;
    else if (run.conclusion === "skipped") summary.skipped++;
    else if (run.conclusion === "neutral") summary.neutral++;
    else summary.unknown++;
  }
  return {
    summary,
    runs: currentRuns.map((run) => ({
      id: run.id,
      name: run.name,
      head_sha: run.head_sha,
      event: run.event,
      run_attempt: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion,
      html_url: run.html_url,
      created_at: run.created_at,
    })),
  };
}

/** Bind CI evidence to the PR revision and choose latest attempts before status filtering. */
export async function getCIStatus(
  client: Octokit,
  params: PRParams,
  status?: string,
) {
  const { data: pr } = await client.pulls.get(params);
  const runs = await listWorkflowRuns(client, {
    owner: params.owner,
    repo: params.repo,
    head_sha: pr.head.sha,
  });
  return { head_sha: pr.head.sha, ...summarizeWorkflowRuns(runs, status) };
}

/** Surface stale-run evidence and setup/step outcomes rather than only failed names. */
export async function getWorkflowRunDetails(
  client: Octokit,
  params: PRParams & { run_id: number },
) {
  const { owner, repo, run_id, pull_number } = params;
  const [runResult, prResult, jobs] = await Promise.all([
    client.actions.getWorkflowRun({ owner, repo, run_id }),
    client.pulls.get({ owner, repo, pull_number }),
    listWorkflowJobs(client, { owner, repo, run_id, filter: "latest" }),
  ]);
  const run = runResult.data;
  return {
    head_sha: run.head_sha,
    current_head_sha: prResult.data.head.sha,
    is_current_head: run.head_sha === prResult.data.head.sha,
    run_attempt: run.run_attempt,
    status: run.status,
    conclusion: run.conclusion,
    html_url: run.html_url,
    jobs: jobs.map((job) => ({
      id: job.id,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
      html_url: job.html_url,
      failed_steps: (job.steps ?? [])
        .filter((step) => FAILURE_CONCLUSIONS.has(step.conclusion ?? ""))
        .map((step) => ({ name: step.name, number: step.number })),
      steps: (job.steps ?? []).map((step) => ({
        name: step.name,
        number: step.number,
        status: step.status,
        conclusion: step.conclusion,
      })),
    })),
  };
}
