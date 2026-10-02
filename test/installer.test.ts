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
  DEFAULT_ACTION_REF,
  DEFAULT_MODEL,
  REVIEW_DIFF_PATH,
  MANAGED_MARKER,
  WORKFLOW_PATH,
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
  actors: ["trusted-user"],
  runner: "ubuntu-latest",
  model: DEFAULT_MODEL,
};

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

function repository(overrides: Record<string, any> = {}) {
  return {
    nameWithOwner: "octo/demo",
    defaultBranchRef: { name: "main" },
    viewerPermission: "ADMIN",
    isArchived: false,
    url: "https://github.com/octo/demo",
    ...overrides,
  };
}

function fakeClient(overrides: Record<string, any> = {}): {
  client: Record<string, any>;
  calls: any[][];
} {
  const calls: any[][] = [];
  const values = {
    repository: repository(),
    secrets: [],
    workflow: null,
    pullRequests: [],
    compare: { files: [{ filename: WORKFLOW_PATH }] },
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
  for (const name of [
    "setSecret",
    "createBranch",
    "writeWorkflow",
    "createPullRequest",
  ]) {
    client[name] = async (...args: any[]) => {
      calls.push([name, ...args]);
      return name === "createPullRequest" ? values.pullRequestUrl : undefined;
    };
  }
  return { client, calls };
}

describe("guided GitHub Action workflow", () => {
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
          path: "${{ steps.agent.outputs.execution_file }}",
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
    expect(workflow.permissions).toEqual({
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
    expect(actionStep.with.codex_effort).toBe("low");
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

  test("allows multiple trusted actors and macOS runner, while pinning the action", () => {
    const workflow = parse(
      renderWorkflow({
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
    expect(workflow.permissions.contents).toBe("write");

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
    expect(actionStep(review).with.track_progress).toBe("true");
    expect(actionStep(review).with.codex_args).toContain(
      '--allowedTools "mcp__github_inline_comment__create_inline_comment"',
    );
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
    expect(() => renderWorkflow({ actors: [] })).toThrow(
      "Select at least one trusted actor",
    );
    expect(() =>
      renderWorkflow({ actors: ["trusted-user"], runner: "self-hosted" }),
    ).toThrow();
    expect(() =>
      renderWorkflow({
        actors: ["trusted-user"],
        model: "model\n  permissions: write",
      }),
    ).toThrow();
    expect(validateRepository("octo/demo")).toBe("octo/demo");
  });
});

describe("installation planning and application", () => {
  test("requires an active repository, write access, and an initialized default branch", async () => {
    for (const repo of [
      repository({ isArchived: true }),
      repository({ viewerPermission: "READ" }),
      repository({ defaultBranchRef: null }),
    ]) {
      const { client } = fakeClient({ repository: repo });
      await expect(
        planInstallation(client, {
          repository: "octo/demo",
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
      planInstallation(client, { repository: "octo/demo", ...defaultOptions }),
    ).rejects.toThrow(WORKFLOW_PATH);
    expect(calls.some(([name]) => name === "head")).toBe(false);
  });

  test("marks a matching installed workflow configured and reuses the existing secret", async () => {
    const workflow = renderWorkflow(defaultOptions);
    const { client, calls } = fakeClient({
      workflow: { sha: "workflow-sha", content: workflow },
      secrets: [{ name: "OPENAI_API_KEY" }],
    });
    const plan = await planInstallation(client, {
      repository: "octo/demo",
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
      repository: "octo/demo",
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
      "secrets",
      "pullRequests",
      "head",
      "secrets",
      "setSecret",
      "createBranch",
      "writeWorkflow",
      "createPullRequest",
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
    ]);
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
    client.workflow = async (_repository: string, ref: string) => {
      calls.push(["workflow", _repository, ref]);
      return ref === "main" ? null : { sha: "pending-sha", content: workflow };
    };
    const plan = await planInstallation(client, {
      repository: "octo/demo",
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
    const makePendingClient = (
      content: string,
      files: { filename: string }[],
    ) => {
      const result = fakeClient({
        pullRequests: pending,
        compare: { files },
        workflow: null,
      });
      result.client.workflow = async (_repository: string, ref: string) =>
        ref === "main" ? null : { sha: "pending", content };
      return result.client;
    };
    await expect(
      planInstallation(
        makePendingClient(workflow, [
          { filename: WORKFLOW_PATH },
          { filename: "README.md" },
        ]),
        { repository: "octo/demo", ...defaultOptions },
      ),
    ).rejects.toThrow("other changes");
    await expect(
      planInstallation(
        makePendingClient(
          renderWorkflow({ ...defaultOptions, actors: ["someone-else"] }),
          [{ filename: WORKFLOW_PATH }],
        ),
        { repository: "octo/demo", ...defaultOptions },
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
      planInstallation(client, { repository: "octo/demo", ...defaultOptions }),
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
        repository: "octo/demo",
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
      repository: "octo/demo",
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

  test("reports failed writes without exposing command output or the API key", async () => {
    const { client } = fakeClient();
    client.writeWorkflow = async () => {
      throw new Error("gh leaked sk-test-secret");
    };
    const plan = await planInstallation(client, {
      repository: "octo/demo",
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
      repository: "octo/demo",
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
      repository: "octo/demo",
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
  function fakeSecretTerminal(initialRaw = false) {
    const input = new EventEmitter();
    const writes: string[] = [];
    const rawModes: boolean[] = [];
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
      write: (value: string) => writes.push(String(value)),
    };
    const terminal = new Terminal({
      input: input as any,
      output: output as any,
    });
    return { input, writes, rawModes, terminal };
  }

  test("masks typed API-key characters and returns the value only after Enter", async () => {
    const { input, writes, rawModes, terminal } = fakeSecretTerminal();
    const pending = terminal.secret("OpenAI API key: ");
    input.emit("keypress", "s", { name: "s" });
    input.emit("keypress", "k", { name: "k" });
    input.emit("keypress", "-", { name: "-" });
    input.emit("keypress", undefined, { name: "return" });
    await expect(pending).resolves.toBe("sk-");
    expect(writes.join("")).toContain("***");
    expect(writes.join("")).not.toContain("sk-");
    expect(rawModes).toEqual([true, false]);
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
if (args[0] === 'api' && args[1] === 'user') return json({ login: 'alice' });
if (args[0] === 'repo' && args[1] === 'view') return json({ nameWithOwner: 'octo/demo', defaultBranchRef: { name: 'main' }, viewerPermission: 'ADMIN', isArchived: false, url: 'https://github.com/octo/demo' });
if (args[0] === 'secret' && args[1] === 'list') return json([]);
if (args[0] === 'pr' && args[1] === 'list') return json([]);
if (args[0] === 'api' && args[1].includes('/contents/') && !args.includes('PUT')) { process.stderr.write('HTTP 404 Not Found'); process.exit(1); }
if (args[0] === 'api' && args[1].includes('/git/ref/heads/')) return json({ object: { sha: '0123456789abcdef0123456789abcdef01234567' } });
if (args[0] === 'api' && args.includes('--method') && args.includes('POST')) {
  if (args[1].includes('/pulls')) return json({ html_url: 'https://github.com/octo/demo/pull/9' });
  return json({ ok: true });
}
if (args[0] === 'api' && args.includes('--method') && args.includes('PUT')) return json({ ok: true });
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
      expect(help.stdout).toContain("Guided repository");
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
