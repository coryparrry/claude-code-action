import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { renderWorkflow } from "../scripts/github-action-installer/workflow.mjs";
import {
  deliveredHead,
  initializeDeliveryReceipt,
  recordDelivery,
} from "../src/github/operations/delivery";
import type { Octokits } from "../src/github/api/client";

/** Build a minimal GitHub ref client and record immutable-delivery lookups. */
function client(sha: string, status?: number) {
  const calls: unknown[] = [];
  const octokit = {
    rest: {
      git: {
        getRef: async (params: unknown) => {
          calls.push(params);
          if (status)
            throw Object.assign(new Error("Ref unavailable"), { status });
          return { data: { object: { sha } } };
        },
      },
    },
  } as unknown as Octokits;
  return { octokit, calls };
}

test("delivery requires this invocation's successful push and the matching remote ref", async () => {
  const path = initializeDeliveryReceipt();
  const branch = "codex/fix#1(test)";
  const { octokit, calls } = client("a".repeat(40));
  try {
    expect(await deliveredHead(octokit, "owner", "repo", branch, path)).toBe(
      "",
    );
    expect(calls).toHaveLength(0);
    recordDelivery("a".repeat(40), branch, path);
    expect(await deliveredHead(octokit, "owner", "repo", branch, path)).toBe(
      "a".repeat(40),
    );
    expect(calls).toEqual([
      { owner: "owner", repo: "repo", ref: `heads/${branch}` },
    ]);
    expect(
      await deliveredHead(
        client("b".repeat(40)).octokit,
        "o",
        "r",
        branch,
        path,
      ),
    ).toBe("");
    expect(await deliveredHead(octokit, "o", "r", "other", path)).toBe("");
    expect(
      await deliveredHead(client("", 404).octokit, "o", "r", branch, path),
    ).toBe("");
    await expect(
      deliveredHead(client("", 403).octokit, "o", "r", branch, path),
    ).rejects.toThrow("Ref unavailable");
  } finally {
    await rm(new URL(".", `file://${path}`).pathname, {
      recursive: true,
      force: true,
    });
  }
});

test("repository validation executes without write credentials or model secrets", async () => {
  const installed = await readFile(
    new URL("../.github/workflows/codex.yml", import.meta.url),
    "utf8",
  );
  expect(installed).toBe(
    renderWorkflow({
      repository: "coryparrry/claude-code-action",
      actors: ["coryparrry"],
    }),
  );
  const workflow = parse(installed);
  expect(workflow.permissions).toEqual({});
  const write = workflow.jobs.codex;
  const agent = write.steps.find(
    (step: { id?: string }) => step.id === "agent",
  );
  expect(agent.with.allowed_tools).toBeUndefined();
  expect(agent.with.disallowed_tools).toBe("Bash,PowerShell");
  expect(write.outputs).toEqual({
    head_sha: "${{ steps.agent.outputs.head_sha }}",
    comment_id: "${{ steps.agent.outputs.comment_id }}",
    comment_type: "${{ steps.agent.outputs.comment_type }}",
  });
  const validation = workflow.jobs.validate_change;
  expect(validation.if).toBe("always() && needs.codex.outputs.head_sha != ''");
  expect(validation.permissions).toEqual({ contents: "read" });
  expect(validation.steps[0].with).toMatchObject({
    ref: "${{ needs.codex.outputs.head_sha }}",
    "persist-credentials": false,
  });
  expect(JSON.stringify(validation)).not.toContain("secrets.");
  expect(JSON.stringify(validation)).not.toContain("github.token");
  expect(validation.steps[1].with).toMatchObject({
    ref: "${{ github.event.pull_request.base.sha || github.workflow_sha }}",
    path: ".git/codex-validation",
    "sparse-checkout": ".github/actions/codex-validate",
    "persist-credentials": false,
  });
  expect(validation.steps[2].env).toEqual({
    HEAD_SHA: "${{ needs.codex.outputs.head_sha }}",
  });
  expect(validation.steps[2].run).toContain(
    'test "$(git rev-parse HEAD)" = "$HEAD_SHA"',
  );
  expect(validation.steps[2].run).toContain(
    "git -C .git/codex-validation ls-tree HEAD",
  );
  expect(validation.steps[3]).toMatchObject({
    if: "steps.verify.outputs.configured == 'true'",
    uses: "./.git/codex-validation/.github/actions/codex-validate",
  });
  const projectAction = parse(
    await readFile(
      new URL("../.github/actions/codex-validate/action.yml", import.meta.url),
      "utf8",
    ),
  );
  expect(projectAction.runs.steps[1].run.trim().split("\n")).toEqual([
    "bun --no-env-file install --frozen-lockfile --ignore-scripts",
    "bun --no-env-file test",
    "bun --no-env-file ./node_modules/typescript/bin/tsc --noEmit",
  ]);
  const report = workflow.jobs.report_validation;
  expect(report.needs).toEqual(["codex", "validate_change"]);
  expect(report.if).toBe(
    "always() && needs.codex.outputs.head_sha != '' && needs.codex.outputs.comment_id != ''",
  );
  expect(report.steps[0].env).toMatchObject({
    VALIDATION_RESULT: "${{ needs.validate_change.result }}",
    VALIDATION_CONFIGURED: "${{ needs.validate_change.outputs.configured }}",
  });
  expect(report.permissions).toEqual({
    issues: "write",
    "pull-requests": "write",
  });
  expect(JSON.stringify(report)).not.toContain("actions/checkout");
  expect(JSON.stringify(report)).not.toContain("OPENAI_API_KEY");
});

test("a delivered commit cannot substitute its own passing validation recipe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-validation-recipe-"));
  /** Run Git only within the disposable fixture checkout. */
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const recipe = ".github/actions/codex-validate/action.yml";
  const action =
    "name: Fixture\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: ";
  try {
    git("init", "-qb", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    await mkdir(join(directory, ".github/actions/codex-validate"), {
      recursive: true,
    });
    await writeFile(join(directory, recipe), `${action}exit 1\n`);
    git("add", ".");
    git("commit", "-qm", "Trusted recipe rejects the fixture");
    git("switch", "-qc", "codex/delivery");
    await writeFile(join(directory, recipe), `${action}exit 0\n`);
    git("commit", "-qam", "Delivered candidate replaces the recipe");
    git(
      "clone",
      "-q",
      "--single-branch",
      "--branch",
      "main",
      ".",
      ".git/codex-validation",
    );
    const workflow = parse(
      renderWorkflow({ repository: "owner/repo", actors: ["owner"] }),
    );
    const [, , verify, validate] = workflow.jobs.validate_change.steps;
    const outputs = join(directory, ".git/outputs");
    execFileSync("bash", ["-e", "-o", "pipefail", "-c", verify.run], {
      cwd: directory,
      env: {
        ...process.env,
        HEAD_SHA: git("rev-parse", "HEAD"),
        GITHUB_OUTPUT: outputs,
      },
    });
    expect(await readFile(outputs, "utf8")).toBe("configured=true\n");
    const selected = parse(
      await readFile(join(directory, validate.uses, "action.yml"), "utf8"),
    );
    expect(
      spawnSync("bash", ["-e", "-c", selected.runs.steps[0].run], {
        cwd: directory,
      }).status,
    ).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validation reporting updates the existing section after a same-commit retry", async () => {
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/codex.yml", import.meta.url),
      "utf8",
    ),
  );
  const script = workflow.jobs.report_validation.steps[0].run
    .split("<<'NODE'\n")[1]
    .split("\nNODE")[0];
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
    "process",
    "fetch",
    script,
  );
  let body = "Original implementation result";
  const requests: string[] = [];
  /** Serve the tracking comment and record actual PATCH bodies from the workflow script. */
  const fetch = async (
    _url: string,
    options: { method?: string; body?: string },
  ) => {
    expect(_url).toContain(
      env.COMMENT_TYPE === "review"
        ? "/pulls/comments/20"
        : "/issues/comments/20",
    );
    if (options.method === "PATCH") {
      body = JSON.parse(options.body!).body;
      requests.push(body);
    }
    return Response.json({ body });
  };
  const env = {
    API_URL: "https://api.github.com",
    REPOSITORY: "owner/repo",
    COMMENT_ID: "20",
    COMMENT_TYPE: "issue",
    HEAD_SHA: "a".repeat(40),
    VALIDATION_RESULT: "failure",
    VALIDATION_CONFIGURED: "true",
    RUN_URL: "https://github.com/owner/repo/actions/runs/1/attempts/1",
    GH_TOKEN: "fixture",
  };
  await execute({ env }, fetch);
  expect(body).toContain("**failure**");
  env.COMMENT_TYPE = "review";
  env.VALIDATION_RESULT = "success";
  env.RUN_URL = env.RUN_URL.replace("attempts/1", "attempts/2");
  await execute({ env }, fetch);
  expect(body).toContain("**success**");
  expect(body).not.toContain("**failure**");
  expect(body.match(/codex-validation:/g)).toHaveLength(1);
  await execute({ env }, fetch);
  expect(requests).toHaveLength(2);

  env.VALIDATION_CONFIGURED = "false";
  await execute({ env }, fetch);
  expect(body).toContain("**skipped (project checks are not configured)**");
  expect(body).toStartWith("Original implementation result");
  expect(requests).toHaveLength(3);
  await expect(
    execute({ env: { ...env, HEAD_SHA: "main" } }, fetch),
  ).rejects.toThrow("Invalid delivery metadata");
  expect(requests).toHaveLength(3);
});
