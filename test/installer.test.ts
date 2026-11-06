import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { parse } from "yaml";
import {
  COMMAND_DELIVERY_POLICY,
  DEFAULT_ACTION_REF,
  DEFAULT_MODEL,
  REVIEW_DIFF_PATH,
  MANAGED_MARKER,
  SETUP_TITLE,
  setupCommitMessage,
  WORKFLOW_PATH,
  MEMORY_WORKFLOW_PATH,
  renderMemoryWorkflow,
  renderWorkflow,
  validateActor,
  validateRepository,
} from "../scripts/github-action-installer/workflow.mjs";
import {
  applyInstallation,
  planInstallation,
} from "../scripts/github-action-installer/install.mjs";
import { GitHubClient } from "../scripts/github-action-installer/github.mjs";
import { Terminal } from "../scripts/github-action-installer/terminal.mjs";
import { runCli } from "../scripts/install-github-app.mjs";

const defaultOptions = {
  repository: "octo/demo",
  actors: ["trusted-user"],
  runner: "ubuntu-latest",
  model: DEFAULT_MODEL,
};

/** Evaluate the supported GitHub condition subset against a synthetic event. */
function evaluateWorkflowCondition(
  condition: string,
  event: Record<string, any>,
) {
  return new Function(
    "github",
    "contains",
    "fromJSON",
    `return (${condition});`,
  )(
    event,
    (value: unknown, search: unknown) =>
      Array.isArray(value)
        ? value.includes(search)
        : String(value ?? "").includes(String(search)),
    JSON.parse,
  );
}

/** Build canonical repository metadata for installer API fixtures. */
function repository(overrides: Record<string, any> = {}) {
  return {
    id: "R_fixture",
    nameWithOwner: "octo/demo",
    defaultBranchRef: { name: "main" },
    viewerPermission: "ADMIN",
    isArchived: false,
    url: "https://github.com/octo/demo",
    ...overrides,
  };
}

/** Return GitHub's draft identity and the head observed when it was opened. */
function setupDraft(
  repository: string,
  branch: string,
  base: string,
  sha: string,
  html_url = "https://github.com/octo/demo/pull/9",
) {
  return {
    title: SETUP_TITLE,
    draft: true,
    html_url,
    head: { ref: branch, sha, repo: { full_name: repository } },
    base: { ref: base },
  };
}

/** Record installer API calls and return configurable repository fixtures. */
function fakeClient(overrides: Record<string, any> = {}): {
  client: Record<string, any>;
  calls: any[][];
} {
  const calls: any[][] = [];
  const values = {
    repository: repository(),
    workflowScopeMissing: false,
    hasValidationRecipe: false,
    secrets: [],
    workflow: null,
    memoryWorkflow: null,
    pullRequests: [],
    compare: {
      files: [{ filename: WORKFLOW_PATH }, { filename: MEMORY_WORKFLOW_PATH }],
    },
    head: "0123456789abcdef0123456789abcdef01234567",
    pullRequestUrl: "https://github.com/octo/demo/pull/9",
    ...overrides,
  };
  const client: Record<string, any> = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      async (...args: any[]) => {
        calls.push([name, ...args]);
        return value;
      },
    ]),
  );
  client.head = async (repository: string, branch: string) => {
    calls.push(["head", repository, branch]);
    return branch === "main" ? values.head : undefined;
  };
  client.workflow = async (
    repository: string,
    ref: string,
    path = WORKFLOW_PATH,
  ) => {
    calls.push([
      "workflow",
      repository,
      ref,
      ...(path === WORKFLOW_PATH ? [] : [path]),
    ]);
    return path === MEMORY_WORKFLOW_PATH
      ? values.memoryWorkflow
      : values.workflow;
  };
  let setupHead = values.head;
  for (const name of [
    "verifyActionRevision",
    "setSecret",
    "createBranch",
    "writeWorkflow",
    "createPullRequest",
    "closePullRequest",
    "deleteBranch",
  ]) {
    client[name] = async (...args: any[]) => {
      calls.push([name, ...args]);
      if (name === "createPullRequest")
        return setupDraft(
          args[0],
          args[1],
          args[2],
          setupHead,
          values.pullRequestUrl,
        );
      if (name === "createBranch") setupHead = args[2];
      if (name === "writeWorkflow") {
        const parent = setupHead;
        setupHead = (args[4] === MEMORY_WORKFLOW_PATH ? "c" : "b").repeat(40);
        return { commit: { sha: setupHead, parents: [{ sha: parent }] } };
      }
    };
  }
  return { client, calls };
}

describe("guided GitHub Action workflow", () => {
  test.each(["generated", "installed"])(
    "%s workflow skips copied repositories and external review heads",
    async (source) => {
      const target =
        source === "generated" ? "octo/demo" : "coryparrry/claude-code-action";
      const workflow = parse(
        source === "generated"
          ? renderWorkflow(defaultOptions)
          : await readFile(
              new URL("../.github/workflows/codex.yml", import.meta.url),
              "utf8",
            ),
      );
      const actor = source === "generated" ? "trusted-user" : "coryparrry";
      /** Build command or review events with independently selectable repository origins. */
      const event = (
        event_name: string,
        repository = target,
        head = repository,
      ) => ({
        actor,
        event_name,
        repository,
        event: {
          comment: { body: "/codex inspect" },
          review: { body: "/codex inspect" },
          issue: { title: "/codex inspect", body: "" },
          pull_request: event_name.startsWith("pull_request")
            ? { draft: false, head: { repo: { full_name: head } } }
            : undefined,
        },
      });
      for (const eventName of [
        "issues",
        "issue_comment",
        "pull_request_review",
        "pull_request_review_comment",
      ]) {
        expect(
          evaluateWorkflowCondition(workflow.jobs.codex.if, event(eventName)),
        ).toBe(true);
        expect(
          evaluateWorkflowCondition(
            workflow.jobs.codex.if,
            event(eventName, "outsider/copied"),
          ),
        ).toBe(false);
        if (eventName.startsWith("pull_request")) {
          expect(
            evaluateWorkflowCondition(
              workflow.jobs.codex.if,
              event(eventName, target, "outsider/fork"),
            ),
          ).toBe(false);
          const deletedHead = event(eventName);
          // GitHub expression missing properties evaluate as null; represent that
          // as an empty object for the JavaScript condition evaluator.
          deletedHead.event.pull_request!.head.repo = {} as any;
          expect(
            evaluateWorkflowCondition(workflow.jobs.codex.if, deletedHead),
          ).toBe(false);
        }
      }
      expect(
        evaluateWorkflowCondition(
          workflow.jobs.codex_review.if,
          event("pull_request"),
        ),
      ).toBe(true);
      expect(
        evaluateWorkflowCondition(
          workflow.jobs.codex_review.if,
          event("pull_request", "outsider/copied"),
        ),
      ).toBe(false);
      expect(
        evaluateWorkflowCondition(
          workflow.jobs.codex_review.if,
          event("pull_request", target, "outsider/fork"),
        ),
      ).toBe(false);
    },
  );

  test("requires a valid repository binding", () => {
    for (const repository of [undefined, "", "owner/repo' || true || '"]) {
      expect(() => renderWorkflow({ ...defaultOptions, repository })).toThrow(
        "owner/repository",
      );
    }
  });

  test.each(["generated", "installed"])(
    "%s workflow retains available reports after success or failure",
    async (source) => {
      const workflow = parse(
        source === "generated"
          ? renderWorkflow(defaultOptions)
          : await readFile(
              new URL("../.github/workflows/codex.yml", import.meta.url),
              "utf8",
            ),
      );
      for (const [jobName, label] of [
        ["codex", "command"],
        ["codex_review", "review"],
      ] as const) {
        const steps = workflow.jobs[jobName].steps;
        const agentIndex = steps.findIndex((step: any) => step.id === "agent");
        const reportIndex = steps.findIndex(
          (step: any) => step.uses === "actions/upload-artifact@v4",
        );
        expect(agentIndex).toBeGreaterThanOrEqual(0);
        expect(steps[agentIndex].uses).toBe(DEFAULT_ACTION_REF);
        expect(reportIndex).toBe(agentIndex + 1);
        const report = steps[reportIndex];
        expect(report.with).toEqual({
          name: `codex-${label}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
          path: "${{ steps.agent.outputs.execution_file }}\n${{ steps.agent.outputs.verification_file }}\n",
          "if-no-files-found": "error",
          "retention-days": 7,
        });
        expect(report.if).toBe(
          "${{ always() && steps.agent.outputs.execution_file != '' }}",
        );
        const shouldUpload = new Function(
          "always",
          "steps",
          `return (${report.if.slice(3, -2)});`,
        );
        for (const outcome of ["success", "failure"]) {
          expect(
            shouldUpload(() => true, {
              agent: {
                outcome,
                outputs: { execution_file: "/tmp/current-report.json" },
              },
            }),
          ).toBe(true);
          expect(
            shouldUpload(() => true, {
              agent: { outcome, outputs: { execution_file: "" } },
            }),
          ).toBe(false);
        }
      }
    },
  );

  test("renders valid, restricted workflow YAML using action.yml inputs", async () => {
    const source = renderWorkflow(defaultOptions);
    const workflow = parse(source);
    const actionMetadata = parse(
      await readFile(new URL("../action.yml", import.meta.url), "utf8"),
    );
    const job = workflow.jobs.codex;
    const actionStep = job.steps.find(
      (step: any) => step.uses === DEFAULT_ACTION_REF,
    );

    expect(source.startsWith(MANAGED_MARKER)).toBe(true);
    expect(actionMetadata.inputs.trigger_phrase.default).toBe("/codex");
    expect(actionMetadata.inputs.codex_args).toBeDefined();
    expect(workflow.permissions).toEqual({});
    expect(job.permissions).toEqual({
      actions: "read",
      contents: "write",
      issues: "write",
      "pull-requests": "write",
    });
    expect(workflow.on).toEqual({
      issue_comment: { types: ["created"] },
      issues: { types: ["opened"] },
      pull_request: {
        types: ["opened", "synchronize", "reopened", "ready_for_review"],
      },
      pull_request_review_comment: { types: ["created"] },
      pull_request_review: { types: ["submitted"] },
    });
    expect(job.if).toContain("github.actor == 'trusted-user'");
    expect(job.if).toContain("/codex");
    expect(job.if).not.toContain("@codex");
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(actionStep.with.openai_api_key).toBe(
      "${{ secrets.OPENAI_API_KEY }}",
    );
    expect(actionStep.with.codex_model).toBe(DEFAULT_MODEL);
    expect(actionStep.with.codex_effort).toBe("max");
    expect(actionStep.with.trigger_phrase).toBe("/codex");
    expect(Object.keys(actionStep.with)).toEqual(
      expect.arrayContaining([
        "openai_api_key",
        "codex_model",
        "codex_effort",
        "max_turns",
      ]),
    );
    for (const input of Object.keys(actionStep.with)) {
      expect(actionMetadata.inputs[input]).toBeDefined();
    }
  });

  test("uses Terra 6.1 Max in both generated jobs", () => {
    expect(DEFAULT_MODEL).toBe("gpt-6.1-terra");
    const workflow = parse(renderWorkflow(defaultOptions));
    expect(workflow.jobs.codex.permissions.actions).toBe("read");
    for (const name of ["codex", "codex_review"]) {
      const step = workflow.jobs[name].steps.find(
        (step: any) => step.uses === DEFAULT_ACTION_REF,
      );
      expect(step.with.codex_model).toBe("gpt-6.1-terra");
      expect(step.with.codex_effort).toBe("max");
      expect(step.with.max_turns).toBe(name === "codex_review" ? "60" : "30");
    }
  });

  test("lets a custom model choose its provider-supported default effort", () => {
    const workflow = parse(
      renderWorkflow({ ...defaultOptions, model: "gpt-5.4" }),
    );
    for (const name of ["codex", "codex_review"]) {
      const step = workflow.jobs[name].steps.find(
        (step: any) => step.uses === DEFAULT_ACTION_REF,
      );
      expect(step.with.codex_model).toBe("gpt-5.4");
      expect(step.with.codex_effort).toBeUndefined();
    }
  });

  test("allows multiple trusted actors and macOS runner, while pinning the action", () => {
    const workflow = parse(
      renderWorkflow({
        repository: "octo/demo",
        actors: ["alice", "bob-2"],
        runner: "macos-latest",
        model: "gpt-6.1",
      }),
    );
    expect(workflow.jobs.codex.if).toContain(
      'contains(fromJSON(\'["alice","bob-2"]\'), github.actor)',
    );
    expect(workflow.jobs.codex_review.if).toContain(
      'contains(fromJSON(\'["alice","bob-2"]\'), github.actor)',
    );
    expect(workflow.jobs.codex["runs-on"]).toBe("macos-latest");
    expect(workflow.jobs.validate_change["runs-on"]).toBe("macos-latest");
    expect(
      workflow.jobs.codex.steps.some(
        (step: any) => step.uses === DEFAULT_ACTION_REF,
      ),
    ).toBe(true);
    expect(DEFAULT_ACTION_REF).toMatch(/@(?:[a-f0-9]{40})$/i);
  });

  test("routes command and automatic review triggers into separate safe jobs", () => {
    const workflow = parse(renderWorkflow(defaultOptions));
    const command = workflow.jobs.codex;
    const review = workflow.jobs.codex_review;
    /** Locate the pinned action invocation within a generated job. */
    const actionStep = (job: any) =>
      job.steps.find((step: any) => step.uses === DEFAULT_ACTION_REF);

    expect(workflow.on).toEqual({
      issue_comment: { types: ["created"] },
      issues: { types: ["opened"] },
      pull_request: {
        types: ["opened", "synchronize", "reopened", "ready_for_review"],
      },
      pull_request_review_comment: { types: ["created"] },
      pull_request_review: { types: ["submitted"] },
    });
    expect(command).toBeDefined();
    expect(review).toBeDefined();

    const commandCondition = String(command.if);
    expect(commandCondition).toContain("github.actor == 'trusted-user'");
    expect(commandCondition).toContain("/codex");
    expect(commandCondition).toContain("github.event.comment.body");
    expect(commandCondition).toContain("github.event.review.body");
    expect(commandCondition).toContain("github.event.issue.body");
    expect(commandCondition).toContain("github.event.issue.title");
    expect(commandCondition).not.toContain(
      "github.event_name == 'pull_request'",
    );
    /** Build a same-repository event for command trigger routing checks. */
    const commandEvent = (event_name: string) => ({
      actor: "trusted-user",
      event_name,
      event: {
        action: "opened",
        comment: { body: "" },
        issue: { body: "", title: "" },
        review: { body: "" },
        pull_request: {
          draft: false,
          head: { repo: { full_name: "octo/demo" } },
        },
      },
      repository: "octo/demo",
    });
    const issueTitleEvent = commandEvent("issues");
    issueTitleEvent.event.issue.title = "/codex review";
    expect(evaluateWorkflowCondition(commandCondition, issueTitleEvent)).toBe(
      true,
    );

    const generatedIssue = commandEvent("issues");
    generatedIssue.event.issue.title = "/codex do not run";
    generatedIssue.event.issue.body =
      "<!-- codex-action:created-issue:v1 -->\n\n/codex example";
    expect(evaluateWorkflowCondition(commandCondition, generatedIssue)).toBe(
      false,
    );

    const commentOverIssueBodyEvent = commandEvent("issue_comment");
    commentOverIssueBodyEvent.event.issue.body = "/codex review";
    expect(
      evaluateWorkflowCondition(commandCondition, commentOverIssueBodyEvent),
    ).toBe(false);

    const commentOverReviewBodyEvent = commandEvent("issue_comment");
    commentOverReviewBodyEvent.event.review.body = "/codex review";
    expect(
      evaluateWorkflowCondition(commandCondition, commentOverReviewBodyEvent),
    ).toBe(false);

    const triggeredCommentEvent = commandEvent("issue_comment");
    triggeredCommentEvent.event.comment.body = "/codex review";
    expect(
      evaluateWorkflowCondition(commandCondition, triggeredCommentEvent),
    ).toBe(true);

    const triggeredReviewEvent = commandEvent("pull_request_review");
    triggeredReviewEvent.event.review.body = "/codex review";
    expect(
      evaluateWorkflowCondition(commandCondition, triggeredReviewEvent),
    ).toBe(true);

    const untrustedIssueEvent = commandEvent("issues");
    untrustedIssueEvent.actor = "untrusted-user";
    untrustedIssueEvent.event.issue.title = "/codex review";
    expect(
      evaluateWorkflowCondition(commandCondition, untrustedIssueEvent),
    ).toBe(false);
    expect(actionStep(command).with.prompt).toBeUndefined();
    expect(actionStep(command).with.track_progress).toBe("true");
    expect(command.permissions.contents).toBe("write");

    const reviewCondition = String(review.if);
    expect(reviewCondition).toContain("github.actor == 'trusted-user'");
    expect(reviewCondition).toContain(
      "github.event.pull_request.head.repo.full_name",
    );
    expect(reviewCondition).toContain("github.repository");
    expect(reviewCondition).toContain("github.event.pull_request.draft");
    const reviewEvent = {
      actor: "trusted-user",
      event_name: "pull_request",
      repository: "octo/demo",
      event: {
        pull_request: {
          draft: false,
          head: { repo: { full_name: "octo/demo" } },
        },
      },
    };
    expect(evaluateWorkflowCondition(reviewCondition, reviewEvent)).toBe(true);
    expect(
      evaluateWorkflowCondition(reviewCondition, {
        ...reviewEvent,
        event: {
          pull_request: {
            ...reviewEvent.event.pull_request,
            draft: true,
          },
        },
      }),
    ).toBe(false);
    expect(
      evaluateWorkflowCondition(reviewCondition, {
        ...reviewEvent,
        event: {
          pull_request: {
            ...reviewEvent.event.pull_request,
            head: { repo: { full_name: "fork/demo" } },
          },
        },
      }),
    ).toBe(false);
    expect(review.permissions.contents).toBe("read");
    const reviewCheckout = review.steps.find(
      (step: any) => step.uses === "actions/checkout@v6",
    );
    expect(reviewCheckout.with.ref).toBe(
      "${{ github.event.pull_request.head.sha }}",
    );
    const prepareDiff = review.steps.find(
      (step: any) => step.name === "Prepare PR diff",
    );
    expect(prepareDiff.env).toEqual({
      CODEX_PR_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      CODEX_PR_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    });
    expect(prepareDiff.run).toContain(
      `git diff --no-ext-diff --no-textconv "$CODEX_PR_BASE_SHA...$CODEX_PR_HEAD_SHA" -- > ${REVIEW_DIFF_PATH}`,
    );
    expect(actionStep(review).with.codex_sandbox).toBe("read-only");
    expect(actionStep(review).with.prompt).toContain("native review schema");
    expect(actionStep(review).with.review_mode).toBe("true");
    expect(actionStep(review).with.track_progress).toBeUndefined();
    expect(actionStep(review).with.codex_args).toBeUndefined();
    expect(actionStep(review).with.prompt.toLowerCase()).toContain("review");
    expect(actionStep(review).with.prompt).toContain(
      `Read the prepared patch in ${REVIEW_DIFF_PATH} first`,
    );
    expect(actionStep(review).with.prompt.toLowerCase()).toContain(
      "do not edit files",
    );
    expect(review.concurrency.group).toContain(
      "github.event.pull_request.number",
    );
    expect(review.concurrency["cancel-in-progress"]).toBe(true);
  });

  test("rejects malformed repositories, actor names, runners, models, and empty actor lists", () => {
    for (const value of [
      "",
      "octo",
      "octo/demo/path",
      "-bad/name",
      "octo/name;echo x",
    ]) {
      expect(() => validateRepository(value)).toThrow();
    }
    for (const value of [
      "",
      "two words",
      "@evil",
      "a".repeat(40),
      "trusted' || true || '",
    ]) {
      expect(() => validateActor(value)).toThrow();
    }
    expect(() => renderWorkflow({ ...defaultOptions, actors: [] })).toThrow(
      "Select at least one trusted actor",
    );
    expect(() =>
      renderWorkflow({ ...defaultOptions, runner: "self-hosted" }),
    ).toThrow();
    expect(() =>
      renderWorkflow({
        ...defaultOptions,
        model: "model\n  permissions: write",
      }),
    ).toThrow();
    expect(validateRepository("octo/demo")).toBe("octo/demo");
  });
});

describe("installation planning and application", () => {
  test("binds the workflow to GitHub's canonical installation repository", async () => {
    const { client } = fakeClient({
      repository: repository({ nameWithOwner: "renamed/project" }),
    });
    const plan = await planInstallation(client, defaultOptions);
    expect(plan.repository).toBe("renamed/project");
    const { jobs } = parse(plan.workflow);
    for (const job of [jobs.codex, jobs.codex_review]) {
      expect(job.if).toContain("github.repository == 'renamed/project'");
      expect(job.if).not.toContain("github.repository == 'octo/demo'");
    }
  });

  test("requires an active repository, write access, and an initialized default branch", async () => {
    for (const repo of [
      repository({ isArchived: true }),
      repository({ viewerPermission: "READ" }),
      repository({ defaultBranchRef: null }),
    ]) {
      const { client } = fakeClient({ repository: repo });
      await expect(
        planInstallation(client, {
          ...defaultOptions,
        }),
      ).rejects.toThrow();
    }
  });

  test("refuses to overwrite an unmanaged workflow", async () => {
    const { client, calls } = fakeClient({
      workflow: { sha: "abc", content: "name: user's workflow\n" },
    });
    await expect(
      planInstallation(client, { ...defaultOptions }),
    ).rejects.toThrow(WORKFLOW_PATH);
    expect(calls.some(([name]) => name === "head")).toBe(false);
  });

  test("marks a matching installed workflow configured and reuses the existing secret", async () => {
    const workflow = renderWorkflow(defaultOptions);
    const { client, calls } = fakeClient({
      workflow: { sha: "workflow-sha", content: workflow },
      memoryWorkflow: {
        sha: "memory-sha",
        content: renderMemoryWorkflow(defaultOptions),
      },
      secrets: [{ name: "OPENAI_API_KEY" }],
    });
    const plan = await planInstallation(client, {
      ...defaultOptions,
    });
    expect(plan).toMatchObject({
      status: "configured",
      workflowSha: "workflow-sha",
      needsSecret: false,
    });
    expect(calls.some(([name]) => name === "head")).toBe(false);
    const result = await applyInstallation(client, plan);
    expect(result.status).toBe("configured");
    expect(
      calls.some(([name]) => name === "setSecret" || name === "createBranch"),
    ).toBe(false);
  });

  test("plans and opens a draft setup PR, passing the API key only through stdin", async () => {
    const { client, calls } = fakeClient();
    const plan = await planInstallation(client, {
      ...defaultOptions,
    });
    expect(plan).toMatchObject({
      status: "new",
      defaultBranch: "main",
      baseSha: "0123456789abcdef0123456789abcdef01234567",
      needsSecret: true,
    });
    const apiKey = "sk-test-never-log-this";
    const result = await applyInstallation(client, plan, {
      apiKey,
      branchName: "codex/install-github-action-test",
    });
    expect(result).toEqual({
      repository: "octo/demo",
      status: "created",
      pullRequestUrl: "https://github.com/octo/demo/pull/9",
    });
    expect(calls.map(([name]) => name)).toEqual([
      "repository",
      "workflow",
      "workflow",
      "verifyActionRevision",
      "secrets",
      "pullRequests",
      "head",
      "secrets",
      "head",
      "createBranch",
      "writeWorkflow",
      "writeWorkflow",
      "createPullRequest",
      "secrets",
      "setSecret",
    ]);
    expect(calls.find(([name]) => name === "setSecret")).toEqual([
      "setSecret",
      "octo/demo",
      apiKey,
    ]);
    expect(calls.find(([name]) => name === "createBranch")).toEqual([
      "createBranch",
      "octo/demo",
      "codex/install-github-action-test",
      (plan as any).baseSha,
    ]);
    expect(calls.find(([name]) => name === "writeWorkflow")).toEqual([
      "writeWorkflow",
      "octo/demo",
      "codex/install-github-action-test",
      plan.workflow,
      undefined,
      WORKFLOW_PATH,
    ]);
  });

  test("upgrades a managed two-job workflow to include validation and reporting", async () => {
    const previous = renderWorkflow(defaultOptions)
      .replace(/^  validate_change:\n[\s\S]*?(?=^  codex_review:)/m, "")
      .replace(`${COMMAND_DELIVERY_POLICY}\n`, "");
    const { client, calls } = fakeClient({
      workflow: {
        sha: "legacy-workflow",
        content: previous,
      },
      memoryWorkflow: {
        sha: "existing-memory",
        content: renderMemoryWorkflow(defaultOptions),
      },
      secrets: [{ name: "OPENAI_API_KEY" }],
    });
    const plan = await planInstallation(client, defaultOptions);
    expect(plan).toMatchObject({
      status: "update",
      needsSecret: false,
      workflowSha: "legacy-workflow",
    });
    const { jobs } = parse(plan.workflow);
    expect(jobs.validate_change.needs).toBe("codex");
    expect(jobs.report_validation.needs).toEqual(["codex", "validate_change"]);
    const result = await applyInstallation(client, plan, {
      branchName: "codex/install-github-action-test",
    });
    expect(result.status).toBe("created");
    expect(calls).toContainEqual([
      "writeWorkflow",
      "octo/demo",
      "codex/install-github-action-test",
      plan.workflow,
      "legacy-workflow",
      WORKFLOW_PATH,
    ]);
    expect(calls.some(([name]) => name === "setSecret")).toBe(false);
  });

  test("reuses a matching pending setup PR without creating another branch or PR", async () => {
    const workflow = renderWorkflow(defaultOptions);
    const { client, calls } = fakeClient({
      pullRequests: [
        {
          url: "https://github.com/octo/demo/pull/3",
          headRefName: "codex/install-github-action-old",
          isCrossRepository: false,
        },
      ],
      workflow: null,
    });
    client.workflow = async (
      _repository: string,
      ref: string,
      path = WORKFLOW_PATH,
    ) => {
      calls.push(["workflow", _repository, ref]);
      return ref === "main"
        ? null
        : {
            sha: "pending-sha",
            content:
              path === MEMORY_WORKFLOW_PATH
                ? renderMemoryWorkflow(defaultOptions)
                : workflow,
          };
    };
    const plan = await planInstallation(client, {
      ...defaultOptions,
    });
    expect(plan).toMatchObject({
      status: "pending",
      pullRequestUrl: "https://github.com/octo/demo/pull/3",
    });
    const result = await applyInstallation(client, plan, {
      apiKey: "sk-existing",
    });
    expect(result.status).toBe("pending");
    expect(
      calls.some(
        ([name]) =>
          name === "createBranch" ||
          name === "writeWorkflow" ||
          name === "createPullRequest",
      ),
    ).toBe(false);
  });

  test("rejects pending setup PRs with unrelated changes or conflicting settings", async () => {
    const pending = [
      {
        url: "https://github.com/octo/demo/pull/3",
        headRefName: "codex/install-github-action-old",
        isCrossRepository: false,
      },
    ];
    const workflow = renderWorkflow(defaultOptions);
    /** Create an installer client with an existing setup PR and configurable diff. */
    const makePendingClient = (
      content: string,
      files: { filename: string }[],
    ) => {
      const result = fakeClient({
        pullRequests: pending,
        compare: { files },
        workflow: null,
      });
      result.client.workflow = async (
        _repository: string,
        ref: string,
        path = WORKFLOW_PATH,
      ) =>
        ref === "main"
          ? null
          : {
              sha: "pending",
              content:
                path === MEMORY_WORKFLOW_PATH
                  ? renderMemoryWorkflow(defaultOptions)
                  : content,
            };
      return result.client;
    };
    await expect(
      planInstallation(
        makePendingClient(workflow, [
          { filename: WORKFLOW_PATH },
          { filename: "README.md" },
        ]),
        { ...defaultOptions },
      ),
    ).rejects.toThrow("other changes");
    await expect(
      planInstallation(
        makePendingClient(
          renderWorkflow({ ...defaultOptions, actors: ["someone-else"] }),
          [{ filename: WORKFLOW_PATH }],
        ),
        { ...defaultOptions },
      ),
    ).rejects.toThrow("different settings");
  });

  test("does not accept a pending setup PR that changes another workflow path", async () => {
    const { client } = fakeClient({
      pullRequests: [
        {
          url: "https://github.com/octo/demo/pull/3",
          headRefName: "codex/install-github-action-old",
          isCrossRepository: false,
        },
      ],
    });
    client.workflow = async (_repository: string, ref: string) =>
      ref === "main"
        ? null
        : { sha: "pending", content: renderWorkflow(defaultOptions) };
    client.compare = async () => ({
      files: [{ filename: ".github/workflows/other.yml" }],
    });
    await expect(
      planInstallation(client, { ...defaultOptions }),
    ).rejects.toThrow("other changes");
  });

  test("does not reuse fork or unidentified-source PRs even when their head workflow matches", async () => {
    for (const isCrossRepository of [true, undefined]) {
      const { client, calls } = fakeClient({
        pullRequests: [
          {
            url: "https://github.com/contributor/demo/pull/3",
            headRefName: "codex/install-github-action-old",
            isCrossRepository,
          },
        ],
      });
      client.workflow = async (_repository: string, ref: string) =>
        ref === "main"
          ? null
          : { sha: "fork-workflow", content: renderWorkflow(defaultOptions) };
      const plan = await planInstallation(client, {
        ...defaultOptions,
      });
      expect(plan.status).toBe("new");
      expect((plan as any).baseSha).toBe(
        "0123456789abcdef0123456789abcdef01234567",
      );
      expect(calls.some(([name]) => name === "compare")).toBe(false);
    }
  });

  test("requires a key when needed and rejects unsafe branch names", async () => {
    const { client, calls } = fakeClient();
    const plan = await planInstallation(client, {
      ...defaultOptions,
    });
    await expect(applyInstallation(client, plan)).rejects.toThrow(
      "API key is required",
    );
    await expect(
      applyInstallation(client, plan, {
        apiKey: "sk-test",
        branchName: "users/alice/test",
      }),
    ).rejects.toThrow("installer branch");
    expect(calls.some(([name]) => name === "setSecret")).toBe(false);
  });

  test("requires the trusted base recipe before replacing inline checks", async () => {
    const workflow = renderWorkflow(defaultOptions).replace(
      /  validate_change:\n[\s\S]*?(?=  report_validation:\n)/,
      "  'validate_change': # Existing checks\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n\n",
    );
    const { client, calls } = fakeClient({
      workflow: { sha: "legacy", content: workflow },
    });
    await expect(planInstallation(client, defaultOptions)).rejects.toThrow(
      "This upgrade would replace existing inline validation",
    );
    expect(calls).toContainEqual([
      "hasValidationRecipe",
      "octo/demo",
      "0123456789abcdef0123456789abcdef01234567",
    ]);
    client.hasValidationRecipe = async () => true;
    await expect(
      planInstallation(client, defaultOptions),
    ).resolves.toMatchObject({ status: "update", validationMigration: true });
    client.authenticated = async () => true;
    client.user = async () => ({ login: "alice" });
    const terminal = { interactive: false, write() {} };
    await expect(
      runCli(["--repo", "octo/demo", "--yes", "--json"], {
        client,
        terminal,
      } as any),
    ).rejects.toThrow("--accept-validation-migration");
    expect(
      calls.some(([name]) => name === "setSecret" || name === "createBranch"),
    ).toBe(false);
  });

  test("guards additional inline checks alongside a trusted action but allows runner changes", async () => {
    const source = renderWorkflow(defaultOptions);
    const workflow = { sha: "installed", content: source };
    const { client } = fakeClient({ workflow });
    await expect(
      planInstallation(client, { ...defaultOptions, runner: "macos-latest" }),
    ).resolves.toMatchObject({ validationMigration: false });
    workflow.content = source.replace(
      "\n  report_validation:",
      "      - run: npm run lint\n\n  report_validation:",
    );
    await expect(planInstallation(client, defaultOptions)).rejects.toThrow(
      "would replace existing inline validation",
    );
  });

  test.each([WORKFLOW_PATH, MEMORY_WORKFLOW_PATH])(
    "blocks an upgrade that would drop a separate check from %s",
    async (path) => {
      const command = renderWorkflow(defaultOptions);
      const memory = renderMemoryWorkflow(defaultOptions);
      const check =
        '\n  "compatibility_check": # existing required check\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./check.sh\n';
      const { client, calls } = fakeClient({
        workflow: {
          sha: "command",
          content: command + (path === WORKFLOW_PATH ? check : ""),
        },
        memoryWorkflow: {
          sha: "memory",
          content: memory + (path === MEMORY_WORKFLOW_PATH ? check : ""),
        },
        hasValidationRecipe: true,
      });
      await expect(planInstallation(client, defaultOptions)).rejects.toThrow(
        `would remove jobs from ${path}: compatibility_check`,
      );
      expect(calls.map(([name]) => name)).toEqual([
        "repository",
        "workflow",
        "workflow",
      ]);
    },
  );

  test.each([
    [WORKFLOW_PATH, "codex", "      - name: Save execution report"],
    [WORKFLOW_PATH, "codex_review", "      - name: Prepare PR diff"],
    [WORKFLOW_PATH, "report_validation", "      - name: Append validation"],
    [MEMORY_WORKFLOW_PATH, "memory", "      - uses:"],
  ])(
    "blocks an upgrade that would replace checks in %s job %s",
    async (path, job, marker) => {
      const insert = `      - name: Required check
        run: ./project-check.sh
`;
      const command = renderWorkflow(defaultOptions);
      const memory = renderMemoryWorkflow(defaultOptions);
      const { client, calls } = fakeClient({
        workflow: {
          sha: "command",
          content:
            path === WORKFLOW_PATH
              ? command.replace(marker, insert + marker)
              : command,
        },
        memoryWorkflow: {
          sha: "memory",
          content:
            path === MEMORY_WORKFLOW_PATH
              ? memory.replace(marker, insert + marker)
              : memory,
        },
        hasValidationRecipe: true,
      });
      await expect(planInstallation(client, defaultOptions)).rejects.toThrow(
        `would replace custom steps in job ${job} in ${path}`,
      );
      expect(calls.map(([name]) => name)).toEqual([
        "repository",
        "workflow",
        "workflow",
      ]);
    },
  );

  test.each(["continue", "reject secret", "secret read unavailable"])(
    "reconciles applied writes with lost responses and handles %s",
    async (outcome) => {
      const { client } = fakeClient();
      const plan = await planInstallation(client, defaultOptions);
      const branch = "codex/install-github-action-lost-response";
      const url = "https://github.com/octo/demo/pull/9";
      const lost = Object.assign(new Error("connection reset"), {
        uncertain: true,
      });
      let head: string | undefined;
      let draft = false;
      let secret = false;
      let writes = 0;
      let secretWrites = 0;
      const files = new Map<string, string>();
      const commits = new Map<string, object>();
      client.head = async () => head;
      client.createBranch = async () => {
        head = plan.baseSha;
        throw lost;
      };
      client.writeWorkflow = async (
        _repo: string,
        _branch: string,
        content: string,
        _sha: string,
        path: string,
      ) => {
        const parent = head;
        const newHead = String(++writes).repeat(40);
        head = newHead;
        files.set(`${newHead}:${path}`, content);
        commits.set(newHead, {
          parents: [{ sha: parent }],
          commit: { message: setupCommitMessage(branch, path) },
          files: [{ filename: path }],
        });
        throw lost;
      };
      client.workflow = async (_repo: string, sha: string, path: string) => ({
        content: files.get(`${sha}:${path}`),
      });
      client.commit = async (_repo: string, sha: string) => commits.get(sha);
      client.createPullRequest = async () => {
        draft = true;
        throw lost;
      };
      client.setupPullRequest = async () =>
        draft ? setupDraft("octo/demo", branch, "main", head!, url) : undefined;
      client.setSecret = async () => {
        secretWrites++;
        if (outcome === "reject secret") throw new Error("HTTP 403");
        secret = true;
        throw lost;
      };
      client.secrets = async () => {
        if (secret && outcome === "secret read unavailable") throw lost;
        return secret ? [{ name: "OPENAI_API_KEY" }] : [];
      };
      client.pullRequest = async () => ({
        state: draft ? "OPEN" : "CLOSED",
        isDraft: draft,
        isCrossRepository: false,
        headRefName: branch,
        headRefOid: head,
        baseRefName: "main",
      });
      client.closePullRequest = async (closed: string) => {
        expect(closed).toBe(url);
        draft = false;
        throw lost;
      };
      client.deleteBranch = async (
        _id: string,
        ref: string,
        expected: string,
      ) => {
        expect(ref).toBe(branch);
        expect(expected).toBe(head ?? "missing branch head");
        head = undefined;
        throw lost;
      };
      const result = applyInstallation(client, plan, {
        apiKey: "sk-test",
        branchName: branch,
      });
      if (outcome === "continue") {
        await expect(result).resolves.toMatchObject({
          status: "created",
          pullRequestUrl: url,
        });
      } else {
        await expect(result).rejects.toThrow(
          outcome === "reject secret"
            ? "The setup branch was removed"
            : `GitHub could not confirm the write. Check branch ${branch}`,
        );
      }
      expect(writes).toBe(2);
      expect(secretWrites).toBe(1);
      expect({ head }).toEqual({
        head: outcome === "reject secret" ? undefined : "2".repeat(40),
      });
      expect(draft).toBe(outcome !== "reject secret");
      expect(secret).toBe(outcome !== "reject secret");
    },
  );

  test.each(["command workflow", "memory workflow", "draft PR", "secret"])(
    "rolls back a failed setup at the %s stage",
    async (stage) => {
      const { client } = fakeClient();
      const plan = await planInstallation(client, defaultOptions);
      let branchHead: string | undefined;
      let draft = false;
      let secretAttempts = 0;
      let writes = 0;
      client.createBranch = async () => {
        branchHead = plan.baseSha;
      };
      client.head = async () => branchHead;
      client.writeWorkflow = async () => {
        writes++;
        if (stage === (writes === 1 ? "command workflow" : "memory workflow"))
          throw new Error("write rejected");
        const parent = branchHead;
        branchHead = String(writes).repeat(40);
        return { commit: { sha: branchHead, parents: [{ sha: parent }] } };
      };
      client.createPullRequest = async (
        repository: string,
        branch: string,
        base: string,
      ) => {
        if (stage === "draft PR") throw new Error("PR rejected");
        draft = true;
        return setupDraft(repository, branch, base, branchHead!);
      };
      const branchName = "codex/install-github-action-rejected-write";
      client.pullRequest = async () => ({
        state: "OPEN",
        isDraft: draft,
        isCrossRepository: false,
        headRefName: branchName,
        headRefOid: branchHead,
        baseRefName: "main",
      });
      client.closePullRequest = async () => {
        draft = false;
      };
      client.deleteBranch = async (
        repositoryId: string,
        _branch: string,
        expectedHead: string,
      ) => {
        expect(repositoryId).toBe("R_fixture");
        expect(branchHead).toBe(expectedHead);
        branchHead = undefined;
      };
      client.setSecret = async () => {
        secretAttempts++;
        throw new Error("secret rejected");
      };
      await expect(
        applyInstallation(client, plan, { apiKey: "sk-test", branchName }),
      ).rejects.toThrow("The setup branch was removed");
      expect(branchHead).toBeUndefined();
      expect(draft).toBe(false);
      expect(secretAttempts).toBe(stage === "secret" ? 1 : 0);
    },
  );

  test("keeps a setup PR marked ready while the secret write was rejected", async () => {
    const { client, calls } = fakeClient();
    const plan = await planInstallation(client, defaultOptions);
    let created = false;
    client.createBranch = async () => {
      created = true;
    };
    client.head = async () => (created ? "c".repeat(40) : undefined);
    client.setSecret = async () => {
      throw new Error("HTTP 403");
    };
    client.pullRequest = async () => ({ state: "OPEN", isDraft: false });
    await expect(
      applyInstallation(client, plan, { apiKey: "sk-test" }),
    ).rejects.toThrow("Cleanup could not be confirmed");
    expect(
      calls.some(([name]) =>
        ["closePullRequest", "deleteBranch"].includes(name),
      ),
    ).toBe(false);
  });

  test("keeps the setup draft when a requested secret replacement cannot be confirmed", async () => {
    const { client, calls } = fakeClient({
      secrets: [{ name: "OPENAI_API_KEY" }],
    });
    const plan = await planInstallation(client, {
      ...defaultOptions,
      replaceSecret: true,
    });
    client.setSecret = async () => {
      throw Object.assign(new Error("connection reset"), { uncertain: true });
    };
    await expect(
      applyInstallation(client, plan, { apiKey: "sk-test" }),
    ).rejects.toThrow("GitHub could not confirm the write");
    expect(
      calls.some(([name]) =>
        ["closePullRequest", "deleteBranch"].includes(name),
      ),
    ).toBe(false);
  });

  test.each([WORKFLOW_PATH, MEMORY_WORKFLOW_PATH])(
    "preserves a concurrent commit when GitHub writes %s on top of it",
    async (concurrentPath) => {
      const { client, calls } = fakeClient();
      const plan = await planInstallation(client, defaultOptions);
      const concurrent = "f".repeat(40);
      const commits = new Map<string, string>();
      const written: string[] = [];
      let head: string | undefined;
      client.head = async () => head;
      client.createBranch = async () => {
        head = plan.baseSha;
      };
      client.writeWorkflow = async (
        _repo: string,
        _branch: string,
        _content: string,
        _sha: string,
        path: string,
      ) => {
        written.push(path);
        if (path === concurrentPath) {
          commits.set(concurrent, head!);
          head = concurrent;
        }
        const parent = head!;
        const sha = (path === WORKFLOW_PATH ? "b" : "c").repeat(40);
        commits.set(sha, parent);
        head = sha;
        return { commit: { sha, parents: [{ sha: parent }] } };
      };
      await expect(
        applyInstallation(client, plan, { apiKey: "sk-test" }),
      ).rejects.toThrow("Cleanup could not be confirmed");
      expect(written.at(-1)).toBe(concurrentPath);
      expect(commits.get(head!)).toBe(concurrent);
      expect(
        calls.some(([name]) =>
          ["createPullRequest", "setSecret", "deleteBranch"].includes(name),
        ),
      ).toBe(false);
    },
  );

  test("preserves a draft with a concurrent commit without uploading a secret", async () => {
    const { client, calls } = fakeClient();
    const plan = await planInstallation(client, defaultOptions);
    client.createPullRequest = async (
      repository: string,
      branch: string,
      base: string,
    ) => setupDraft(repository, branch, base, "f".repeat(40));
    await expect(
      applyInstallation(client, plan, { apiKey: "sk-test" }),
    ).rejects.toThrow("GitHub could not confirm the write");
    expect(
      calls.some(([name]) =>
        ["setSecret", "closePullRequest", "deleteBranch"].includes(name),
      ),
    ).toBe(false);
  });

  test("keeps a setup branch that changed before rollback", async () => {
    const { client, calls } = fakeClient();
    const plan = await planInstallation(client, defaultOptions);
    let created = false;
    client.createBranch = async () => {
      created = true;
    };
    client.head = async () => (created ? "c".repeat(40) : undefined);
    client.writeWorkflow = async () => {
      throw new Error("write rejected");
    };
    await expect(
      applyInstallation(client, plan, { apiKey: "sk-test" }),
    ).rejects.toThrow("Cleanup could not be confirmed");
    expect(
      calls.some(([name]) => name === "setSecret" || name === "deleteBranch"),
    ).toBe(false);
  });

  test("reports failed writes without exposing command output or the API key", async () => {
    const { client } = fakeClient();
    client.writeWorkflow = async () => {
      throw new Error("gh leaked sk-test-secret");
    };
    const plan = await planInstallation(client, {
      ...defaultOptions,
    });
    await expect(
      applyInstallation(client, plan, {
        apiKey: "sk-test-secret",
        branchName: "codex/install-github-action-test",
      }),
    ).rejects.toThrow("writing the workflow");
    await expect(
      applyInstallation(client, plan, {
        apiKey: "sk-test-secret",
        branchName: "codex/install-github-action-test",
      }),
    ).rejects.not.toThrow("sk-test-secret");
  });

  test("reuses a secret added during review unless replacement was requested", async () => {
    const normal = fakeClient();
    const normalPlan = await planInstallation(normal.client, {
      ...defaultOptions,
    });
    normal.client.secrets = async (repo: string) => {
      normal.calls.push(["secrets-recheck", repo]);
      return [{ name: "OPENAI_API_KEY" }];
    };
    await applyInstallation(normal.client, normalPlan, {
      apiKey: "sk-key-entered-after-review-123456",
      branchName: "codex/install-github-action-race",
    });
    expect(normal.calls.some(([name]) => name === "setSecret")).toBe(false);

    const replacement = fakeClient();
    const replacementPlan = await planInstallation(replacement.client, {
      ...defaultOptions,
      replaceSecret: true,
    });
    replacement.client.secrets = async () => [{ name: "OPENAI_API_KEY" }];
    await applyInstallation(replacement.client, replacementPlan, {
      apiKey: "sk-explicit-replacement-123456789",
      branchName: "codex/install-github-action-replace",
    });
    expect(
      replacement.calls.filter(([name]) => name === "setSecret"),
    ).toHaveLength(1);
  });
});

describe("GitHub CLI adapter", () => {
  test("requires the expected commit when deleting a setup ref", async () => {
    const requests: any[] = [];
    const client = new GitHubClient({
      run: (args: string[], { input }: { input?: string }) => {
        requests.push({ args, input: JSON.parse(input!) });
        return {
          status: 0,
          stdout: JSON.stringify({ data: { updateRefs: {} } }),
        };
      },
    } as any);
    await client.deleteBranch(
      "R_fixture",
      "codex/install-github-action-test",
      "a".repeat(40),
    );
    expect(requests).toEqual([
      expect.objectContaining({
        args: ["api", "graphql", "--method", "POST", "--input", "-"],
        input: expect.objectContaining({
          variables: {
            input: {
              repositoryId: "R_fixture",
              refUpdates: [
                {
                  name: "refs/heads/codex/install-github-action-test",
                  beforeOid: "a".repeat(40),
                  afterOid: "0".repeat(40),
                },
              ],
            },
          },
        }),
      }),
    ]);
  });
  test("sends secret material as stdin, never as an argument", async () => {
    const invocations: any[] = [];
    const client = new GitHubClient({
      run: (args: any[], options: any) => {
        invocations.push({ args, options });
        return { status: 0, stdout: "", stderr: "" };
      },
    } as any);
    await client.setSecret("octo/demo", "sk-test-secret");
    expect(invocations).toEqual([
      {
        args: ["secret", "set", "OPENAI_API_KEY", "--repo", "octo/demo"],
        options: { input: "sk-test-secret\n" },
      },
    ]);
    expect(invocations[0].args.join(" ")).not.toContain("sk-test-secret");
  });

  test("redacts GitHub CLI stdout and stderr from errors", async () => {
    const secret = "sk-test-secret";
    const client = new GitHubClient({
      run: () => ({
        status: 1,
        stdout: secret,
        stderr: `failed with ${secret}`,
      }),
    } as any);
    await expect(client.setSecret("octo/demo", secret)).rejects.toThrow(
      "GitHub request failed",
    );
    await expect(client.setSecret("octo/demo", secret)).rejects.not.toThrow(
      secret,
    );
  });

  test("recognizes a missing workflow but does not mask other API failures", async () => {
    const missing = new GitHubClient({
      run: () => ({
        status: 1,
        stdout: "",
        stderr: "HTTP 404 Not Found",
      }),
    } as any);
    await expect(missing.workflow("octo/demo", "main")).resolves.toBeNull();
    const failed = new GitHubClient({
      run: () => ({ status: 1, stdout: "", stderr: "HTTP 500" }),
    } as any);
    await expect(failed.workflow("octo/demo", "main")).rejects.toThrow(
      "GitHub request failed",
    );
  });
});

describe("terminal input", () => {
  /** Record terminal mode and output as each synthetic key prompt is written. */
  function fakeSecretTerminal(initialRaw = false) {
    const input = new EventEmitter();
    const writes: string[] = [];
    const rawModes: boolean[] = [];
    const promptModes: boolean[] = [];
    Object.assign(input, {
      isTTY: true,
      isRaw: initialRaw,
      setRawMode: (enabled: boolean) => {
        rawModes.push(enabled);
        Object.assign(input, { isRaw: enabled });
      },
      resume: () => {},
      pause: () => {},
    });
    const output = {
      isTTY: true,
      write: (value: string) => {
        if (value.startsWith("OpenAI API key"))
          promptModes.push((input as any).isRaw);
        return writes.push(String(value));
      },
    };
    const terminal = new Terminal({
      input: input as any,
      output: output as any,
    });
    return { input, writes, rawModes, promptModes, terminal };
  }

  test("masks typed API-key characters and returns the value only after Enter", async () => {
    const { input, writes, rawModes, promptModes, terminal } =
      fakeSecretTerminal();
    const pending = terminal.secret("OpenAI API key: ");
    input.emit("keypress", "s", { name: "s" });
    input.emit("keypress", "k", { name: "k" });
    input.emit("keypress", "-", { name: "-" });
    input.emit("keypress", undefined, { name: "return" });
    await expect(pending).resolves.toBe("sk-");
    expect(writes.join("")).toContain("***");
    expect(writes.join("")).not.toContain("sk-");
    expect(rawModes).toEqual([true, false]);
    expect(promptModes).toEqual([true]);
  });

  test("Ctrl-C cancels masked key entry and restores terminal mode", async () => {
    const { input, writes, rawModes, terminal } = fakeSecretTerminal();
    const pending = terminal.secret("OpenAI API key: ");
    input.emit("keypress", "s", { name: "s" });
    input.emit("keypress", undefined, { name: "c", ctrl: true });
    await expect(pending).rejects.toThrow("cancelled");
    expect(writes.join("")).not.toContain("s\n");
    expect(rawModes).toEqual([true, false]);
  });

  test("Ctrl-D cancels masked key entry and restores the prior raw state", async () => {
    const { input, rawModes, terminal } = fakeSecretTerminal(true);
    const pending = terminal.secret("OpenAI API key: ");
    input.emit("keypress", undefined, { name: "d", ctrl: true });
    await expect(pending).rejects.toThrow("cancelled");
    expect(rawModes).toEqual([true, true]);
    expect((input as any).isRaw).toBe(true);
  });

  test("end of input cancels masked entry and restores terminal mode", async () => {
    const { input, rawModes, terminal } = fakeSecretTerminal();
    const pending = terminal.secret("OpenAI API key: ");
    input.emit("end");
    await expect(pending).rejects.toThrow("Input closed");
    expect(rawModes).toEqual([true, false]);
    expect((input as any).isRaw).toBe(false);
  });

  test("confirmation accepts terminal input", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    (input as any).isTTY = true;
    (output as any).isTTY = true;
    (input as any).setRawMode = () => {};
    const terminal = new Terminal({
      input: input as any,
      output: output as any,
    });
    const accepted = terminal.confirm("Apply setup?");
    input.write("y\n");
    await expect(accepted).resolves.toBe(true);
  });
});

describe("installer interaction guards", () => {
  /** Capture the interactive setup plan without touching credentials. */
  function interactiveTerminalSpy() {
    const prompts: string[] = [];
    return {
      prompts,
      terminal: {
        interactive: true,
        write: (message: string) => prompts.push(message),
        ask: async (question: string) => {
          prompts.push(question);
          return "";
        },
        confirm: async (question: string) => {
          prompts.push(question);
          return true;
        },
        secret: async (question: string) => {
          prompts.push(question);
          return "sk-never-used-123456789";
        },
      },
    };
  }

  test("previews the current checkout without opening the repository picker", async () => {
    const { client, calls } = fakeClient({
      authenticated: true,
      user: { login: "alice" },
    });
    client.currentRepository = async () => "octo/demo";
    const { terminal, prompts } = interactiveTerminalSpy();
    const result = await runCli(["--dry-run"], { client, terminal } as any);
    expect(result).toMatchObject({
      dryRun: true,
      plans: [{ repository: "octo/demo", status: "new" }],
    });
    expect(prompts.some((message) => message.includes("octo/demo"))).toBe(true);
    expect(calls.some(([name]) => name === "repositories")).toBe(false);
    expect(calls.some(([name]) => name === "setSecret")).toBe(false);
  });

  test("retains the managed settings and changes only explicit overrides", async () => {
    const previous = {
      repository: "octo/demo",
      actors: ["owner", "teammate"],
      runner: "macos-latest",
      model: "gpt-5.4",
    };
    const workflow = { sha: "installed", content: renderWorkflow(previous) };
    const memoryWorkflow = {
      sha: "memory",
      content: renderMemoryWorkflow(previous),
    };
    const { client } = fakeClient({
      authenticated: true,
      user: { login: "installer-admin" },
      currentRepository: previous.repository,
      secrets: [{ name: "OPENAI_API_KEY" }],
      workflow,
      memoryWorkflow,
    });
    const { terminal, prompts } = interactiveTerminalSpy();
    const unchanged = await runCli(["--dry-run"], { client, terminal } as any);
    expect(unchanged).toMatchObject({
      plans: [{ ...previous, status: "configured" }],
    });
    const override = await runCli(["--dry-run", "--model", "gpt-5.4-mini"], {
      client,
      terminal,
    } as any);
    expect(override).toMatchObject({
      plans: [{ ...previous, model: "gpt-5.4-mini", status: "update" }],
    });
    expect(prompts.join("\n")).toContain("trusted users: owner, teammate");
    workflow.content = workflow.content.replaceAll(
      `contains(fromJSON('["owner","teammate"]'), github.actor)`,
      "github.actor == 'owner' || github.actor == 'teammate'",
    );
    await expect(
      runCli(["--dry-run"], { client, terminal } as any),
    ).rejects.toThrow("--actor");
    const explicit = await runCli(
      ["--dry-run", "--actor", "owner", "--actor", "teammate"],
      { client, terminal } as any,
    );
    expect(explicit).toMatchObject({
      plans: [{ ...previous, status: "update" }],
    });
    workflow.content = renderWorkflow(previous);
    memoryWorkflow.content = renderMemoryWorkflow({
      ...previous,
      actors: ["owner"],
    });
    await expect(
      runCli(["--dry-run"], { client, terminal } as any),
    ).rejects.toThrow("--actor");
  });

  test("preserves publisher actors when only the memory workflow exists", async () => {
    const actors = ["owner", "teammate"];
    const { client } = fakeClient({
      memoryWorkflow: {
        sha: "memory",
        content: renderMemoryWorkflow({ repository: "octo/demo", actors }),
      },
    });
    await expect(
      planInstallation(client, {
        repository: "octo/demo",
        defaultActor: "installer-admin",
      }),
    ).resolves.toMatchObject({ actors, status: "update" });
  });

  test("refreshes a missing workflow scope before prompting for a key or writing", async () => {
    const { client, calls } = fakeClient({
      authenticated: true,
      user: { login: "alice" },
      currentRepository: "octo/demo",
      secrets: [{ name: "OPENAI_API_KEY" }],
    });
    let missing = true;
    client.workflowScopeMissing = async () => {
      calls.push(["workflowScopeMissing"]);
      return missing;
    };
    client.refreshWorkflowScope = async () => {
      calls.push(["refreshWorkflowScope"]);
      missing = false;
    };
    const { terminal, prompts } = interactiveTerminalSpy();
    await expect(
      runCli([], { client, terminal } as any),
    ).resolves.toMatchObject({
      results: [{ status: "created" }],
    });
    expect(prompts).toContain(
      "Grant GitHub CLI permission to write workflows?",
    );
    expect(
      calls
        .map(([name]) => name)
        .filter((name) =>
          [
            "workflowScopeMissing",
            "refreshWorkflowScope",
            "createBranch",
          ].includes(name),
        ),
    ).toEqual([
      "workflowScopeMissing",
      "refreshWorkflowScope",
      "workflowScopeMissing",
      "createBranch",
    ]);
  });

  test("JSON install never prompts for a key even when a terminal is interactive", async () => {
    const { client, calls } = fakeClient({
      authenticated: true,
      user: { login: "alice" },
    });
    const { terminal, prompts } = interactiveTerminalSpy();
    await expect(
      runCli(["--repo", "octo/demo", "--yes", "--json"], {
        client,
        terminal,
      } as any),
    ).rejects.toThrow("--key-file or --use-env-key");
    expect(prompts).toEqual([]);
    expect(calls.some(([name]) => name === "setSecret")).toBe(false);
    expect(calls.some(([name]) => name === "createBranch")).toBe(false);
  });

  test("unauthenticated interactive dry run does not offer or start GitHub login", async () => {
    const { client, calls } = fakeClient({ authenticated: false });
    let loginCalls = 0;
    client.login = async () => {
      loginCalls += 1;
    };
    const { terminal, prompts } = interactiveTerminalSpy();
    await expect(
      runCli(["--repo", "octo/demo", "--dry-run"], {
        client,
        terminal,
      } as any),
    ).rejects.toThrow("Sign in first");
    expect(loginCalls).toBe(0);
    expect(prompts).toEqual([]);
    expect(calls.map(([name]) => name)).toEqual(["authenticated"]);
  });
});

describe("installer command line", () => {
  async function withFakeGh(
    run: (context: {
      directory: string;
      eventLog: string;
      invoke: (args: string[], extraEnv?: NodeJS.ProcessEnv) => any;
    }) => Promise<void>,
  ): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "codex-installer-cli-"));
    const bin = join(directory, "bin");
    await mkdir(bin);
    const eventLog = join(directory, "gh-events.jsonl");
    const fakeGh = join(bin, "gh");
    await writeFile(
      fakeGh,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.INSTALLER_GH_EVENT_LOG, JSON.stringify({ args, input }) + '\\n');
const json = value => process.stdout.write(JSON.stringify(value));
if (args[0] === 'auth' && args[1] === 'status') process.exit(0);
if (args[0] === 'api' && args[1] === 'user') {
  if (args.includes('--include') && process.env.INSTALLER_GH_OAUTH_SCOPES !== undefined)
    process.stdout.write('HTTP/2.0 200 OK\\nX-Oauth-Scopes: ' + process.env.INSTALLER_GH_OAUTH_SCOPES + '\\n\\n');
  return json({ login: 'alice' });
}
if (args[0] === 'repo' && args[1] === 'view') return json({ nameWithOwner: 'octo/demo', defaultBranchRef: { name: 'main' }, viewerPermission: 'ADMIN', isArchived: false, url: 'https://github.com/octo/demo' });
if (args[0] === 'secret' && args[1] === 'list') return json([]);
if (args[0] === 'pr' && args[1] === 'list') return json([]);
if (args[0] === 'api' && args[1].includes('/contents/review-memory/action.yml')) { process.stdout.write(JSON.stringify({type:'file'})); process.exit(0); }
if (args[0] === 'api' && args[1].includes('/contents/') && !args.includes('PUT')) { process.stderr.write('HTTP 404 Not Found'); process.exit(1); }
if (args[0] === 'api' && args[1].includes('/git/ref/heads/')) {
  if (!args[1].endsWith('/main')) { process.stderr.write('HTTP 404 Not Found'); process.exit(1); }
  return json({ object: { sha: '0123456789abcdef0123456789abcdef01234567' } });
}
if (args[0] === 'api' && args.includes('--method') && args.includes('POST')) {
  if (args[1].includes('/pulls')) {
    const draft = JSON.parse(input);
    return json({
      title: draft.title,
      draft: true,
      html_url: 'https://github.com/octo/demo/pull/9',
      head: { ref: draft.head, sha: 'c'.repeat(40), repo: { full_name: 'octo/demo' } },
      base: { ref: draft.base },
    });
  }
  return json({ ok: true });
}
if (args[0] === 'api' && args.includes('--method') && args.includes('PUT')) {
  const memory = args[1].endsWith('/codex-memory.yml');
  return json({ commit: {
    sha: (memory ? 'c' : 'b').repeat(40),
    parents: [{ sha: memory ? 'b'.repeat(40) : '0123456789abcdef0123456789abcdef01234567' }],
  } });
}
if (args[0] === 'secret' && args[1] === 'set') process.exit(0);
process.stderr.write('Unexpected fake gh request');
process.exit(2);
`,
    );
    await chmod(fakeGh, 0o700);
    const cwd = join(directory, "unrelated-cwd");
    await mkdir(cwd);
    const installer = resolve(
      import.meta.dir,
      "../scripts/install-github-app.mjs",
    );
    /** Run the installer CLI against the isolated fake GitHub executable. */
    const invoke = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
      spawnSync(process.execPath, [installer, ...args], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          INSTALLER_GH_EVENT_LOG: eventLog,
          ...extraEnv,
        },
      });
    try {
      await run({ directory, eventLog, invoke });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  test("help is offline and doctor reports GitHub authentication as JSON", async () => {
    await withFakeGh(async ({ eventLog, invoke }) => {
      const help = invoke(["--help"]);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("Set up the current repository");
      expect(help.stderr).toBe("");
      expect(await readFile(eventLog, "utf8").catch(() => "")).toBe("");

      const doctor = invoke(["doctor", "--json"]);
      expect(doctor.status).toBe(0);
      expect(JSON.parse(doctor.stdout)).toMatchObject({
        ok: true,
        ready: true,
        login: "alice",
      });
    });
  });

  test("runs the standalone tarball with npx outside the action checkout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-installer-package-"));
    try {
      const env = {
        ...process.env,
        npm_config_cache: join(directory, "npm-cache"),
      };
      const pack = spawnSync(
        "node",
        [
          resolve(import.meta.dir, "../scripts/pack-installer.mjs"),
          "0.0.0-test",
          directory,
        ],
        { cwd: directory, encoding: "utf8", env },
      );
      expect(pack.stderr).toBe("");
      expect(pack.status).toBe(0);
      const result = spawnSync(
        "npx",
        [
          "--offline",
          "--loglevel=error",
          "--yes",
          `--package=${join(directory, "codex-action.tgz")}`,
          "codex-action",
          "--help",
        ],
        { cwd: directory, encoding: "utf8", env },
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Set up the current repository");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("dry run from an unrelated directory does not read a key file or write to GitHub", async () => {
    await withFakeGh(async ({ eventLog, invoke }) => {
      const result = invoke([
        "--repo",
        "octo/demo",
        "--dry-run",
        "--json",
        "--key-file",
        "missing-key-file",
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({
        ok: true,
        dryRun: true,
        plans: [{ status: "new", repository: "octo/demo", needsSecret: true }],
      });
      const events = (await readFile(eventLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.some(({ args }) => args[0] === "secret" && args[1] === "set"),
      ).toBe(false);
      expect(
        events.some(
          ({ args }) =>
            args.includes("--method") &&
            ["POST", "PUT"].some((verb) => args.includes(verb)),
        ),
      ).toBe(false);
    });
  });

  test("a classic login without workflow scope stops before any setup writes", async () => {
    await withFakeGh(async ({ eventLog, invoke }) => {
      const result = invoke(
        [
          "--repo",
          "octo/demo",
          "--yes",
          "--json",
          "--key-file",
          "missing-key-file",
        ],
        { INSTALLER_GH_OAUTH_SCOPES: "repo, read:org" },
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stderr).error.message).toContain(
        "--scopes workflow",
      );
      const events = (await readFile(eventLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.some(({ args }) => args.includes("--include"))).toBe(true);
      expect(
        events.some(({ args }) =>
          ["set", "PUT", "POST"].some((verb) => args.includes(verb)),
        ),
      ).toBe(false);
    });
  });

  test("returns a safe machine-readable error when noninteractive install has no explicit key source", async () => {
    await withFakeGh(async ({ eventLog, invoke }) => {
      const result = invoke(["--repo", "octo/demo", "--yes", "--json"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining("--key-file or --use-env-key"),
        },
      });
      const events = (await readFile(eventLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        events.some(({ args }) => args[0] === "secret" && args[1] === "set"),
      ).toBe(false);
      expect(
        events.some(
          ({ args }) =>
            args.includes("--method") &&
            ["POST", "PUT"].some((verb) => args.includes(verb)),
        ),
      ).toBe(false);
    });
  });

  test("noninteractive install writes secret through stdin and creates branch, workflow, and draft PR", async () => {
    await withFakeGh(async ({ directory, eventLog, invoke }) => {
      const secret = "sk-test-integration-key-123456789";
      const keyFile = join(directory, "selected-key.env");
      await writeFile(keyFile, `OPENAI_API_KEY=${secret}\n`);
      const result = invoke([
        "--repo",
        "octo/demo",
        "--yes",
        "--json",
        "--key-file",
        keyFile,
      ]);
      if (result.status !== 0)
        throw new Error(
          `fake gh install failed: ${result.stderr} ${result.stdout}`,
        );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(secret);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        results: [
          {
            repository: "octo/demo",
            status: "created",
            pullRequestUrl: "https://github.com/octo/demo/pull/9",
          },
        ],
      });
      const events = (await readFile(eventLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const secretWrite = events.find(
        ({ args }) => args[0] === "secret" && args[1] === "set",
      );
      expect(secretWrite.args).toEqual([
        "secret",
        "set",
        "OPENAI_API_KEY",
        "--repo",
        "octo/demo",
      ]);
      expect(secretWrite.input).toBe(`${secret}\n`);
      expect(
        events.some(
          ({ args }) =>
            args[0] === "api" &&
            args[1].includes("/git/refs") &&
            args.includes("POST"),
        ),
      ).toBe(true);
      const workflowWrite = events.find(
        ({ args }) =>
          args[0] === "api" &&
          args[1].includes("/contents/") &&
          args.includes("PUT"),
      );
      expect(workflowWrite).toBeDefined();
      const workflowBody = JSON.parse(workflowWrite.input);
      expect(
        Buffer.from(workflowBody.content, "base64").toString("utf8"),
      ).toContain(MANAGED_MARKER);
      const prWrite = events.find(
        ({ args }) =>
          args[0] === "api" &&
          args[1].includes("/pulls") &&
          args.includes("POST"),
      );
      expect(JSON.parse(prWrite.input).draft).toBe(true);
      expect(events.every(({ args }) => !args.join(" ").includes(secret))).toBe(
        true,
      );
    });
  });
});
