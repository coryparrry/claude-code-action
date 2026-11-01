import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { parse } from "yaml";
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
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/codex.yml", import.meta.url),
      "utf8",
    ),
  );
  expect(workflow.permissions).toEqual({});
  const write = workflow.jobs.codex;
  expect(
    write.steps.find((step: { id?: string }) => step.id === "agent").with
      .allowed_tools,
  ).toBeUndefined();
  const validation = workflow.jobs.validate_change;
  expect(validation.permissions).toEqual({ contents: "read" });
  expect(validation.steps[0].with).toMatchObject({
    ref: "${{ needs.codex.outputs.head_sha }}",
    "persist-credentials": false,
  });
  expect(JSON.stringify(validation)).not.toContain("secrets.");
  expect(JSON.stringify(validation)).not.toContain("github.token");
  expect(
    validation.steps
      .filter((step: { run?: string }) => step.run)
      .map((step: { run: string }) => step.run),
  ).toEqual([
    "bun --no-env-file install --frozen-lockfile",
    "bun --no-env-file test",
    "bun --no-env-file run typecheck",
  ]);
  const report = workflow.jobs.report_validation;
  expect(report.permissions).toEqual({
    issues: "write",
    "pull-requests": "write",
  });
  expect(JSON.stringify(report)).not.toContain("actions/checkout");
  expect(JSON.stringify(report)).not.toContain("OPENAI_API_KEY");
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
});
