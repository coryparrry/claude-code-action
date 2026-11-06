import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  DEFAULT_ACTION_REF,
  renderWorkflow,
} from "../scripts/github-action-installer/workflow.mjs";

const repository = "octo/demo";
const head = "a".repeat(40);
const runUrl = "https://github.com/octo/demo/actions/runs/123/attempts/1";
const { codex, validate_change, report_validation } = parse(
  renderWorkflow({
    repository,
    actors: ["trusted-user"],
    runner: "macos-latest",
  }),
).jobs;

test("generated validation checks out the delivered SHA without write access or persisted credentials", () => {
  expect(codex.outputs).toEqual({
    head_sha: "${{ steps.agent.outputs.head_sha }}",
    comment_id: "${{ steps.agent.outputs.comment_id }}",
    comment_type: "${{ steps.agent.outputs.comment_type }}",
  });
  const agent = codex.steps.find(
    (step: any) => step.uses === DEFAULT_ACTION_REF,
  );
  expect(agent.with.disallowed_tools).toBe("Bash,PowerShell");
  expect(validate_change.if).toBe(
    "always() && needs.codex.outputs.head_sha != ''",
  );
  expect(validate_change.permissions).toEqual({ contents: "read" });
  expect(validate_change["runs-on"]).toBe("macos-latest");
  expect(validate_change.steps[0].with).toEqual({
    ref: "${{ needs.codex.outputs.head_sha }}",
    "persist-credentials": false,
  });
  expect(validate_change.steps[1].env).toEqual({
    HEAD_SHA: "${{ needs.codex.outputs.head_sha }}",
  });
  expect(validate_change.steps[1].run).toContain(
    'test "$(git rev-parse HEAD)" = "$HEAD_SHA"',
  );
  expect(validate_change.steps[2]).toMatchObject({
    if: "steps.verify.outputs.configured == 'true'",
    uses: "./.github/actions/codex-validate",
  });
  expect(JSON.stringify(validate_change)).not.toContain("secrets.");
});

test("reporting always follows validation, with comment permissions and no repository checkout", () => {
  expect(report_validation.if).toBe(
    "always() && needs.codex.outputs.head_sha != '' && needs.codex.outputs.comment_id != ''",
  );
  expect(report_validation.needs).toEqual(["codex", "validate_change"]);
  expect(report_validation.permissions).toEqual({
    issues: "write",
    "pull-requests": "write",
  });
  expect(report_validation.steps).toHaveLength(1);
  expect(report_validation.steps[0].env.VALIDATION_RESULT).toBe(
    "${{ needs.validate_change.result }}",
  );
  expect(report_validation.steps[0].env.VALIDATION_CONFIGURED).toBe(
    "${{ needs.validate_change.outputs.configured }}",
  );
  expect(report_validation.steps[0].uses).toBeUndefined();
});

test("the action repository uses the same workflow consumers install", async () => {
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
});

/** Execute the generated reporter with an in-memory GitHub comment API. */
function reporter(body: string) {
  const calls: Array<{ url: string; method: string }> = [];
  const script = report_validation.steps[0].run;
  const code = script.slice(
    script.indexOf("\n") + 1,
    script.lastIndexOf("\nNODE"),
  );
  const execute = new Function(
    "process",
    "fetch",
    `return (async () => { ${code} })()`,
  );
  /** Supply synthetic GitHub output values to the generated script. */
  async function run(overrides: Record<string, string> = {}) {
    await execute(
      {
        env: {
          API_URL: "https://api.github.com",
          REPOSITORY: repository,
          COMMENT_ID: "42",
          COMMENT_TYPE: "issue",
          HEAD_SHA: head,
          VALIDATION_RESULT: "success",
          VALIDATION_CONFIGURED: "true",
          RUN_URL: runUrl,
          GH_TOKEN: "test-token",
          ...overrides,
        },
      },
      (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method ?? "GET" });
        if (init.method === "PATCH") body = JSON.parse(String(init.body)).body;
        return { ok: true, json: async () => ({ body }) };
      },
    );
    return body;
  }
  return { calls, run };
}

test("reports a delivered SHA once and replaces its result on an inline-comment rerun", async () => {
  const tracking = reporter("Existing comment");
  const first = await tracking.run({ COMMENT_TYPE: "review" });
  expect(first).toContain(
    `Validation for \`${head}\`: **success**. [View checks](${runUrl})`,
  );
  expect(first.startsWith("Existing comment\n")).toBe(true);
  expect(tracking.calls).toEqual(
    ["GET", "PATCH"].map((method) => ({
      url: "https://api.github.com/repos/octo/demo/pulls/comments/42",
      method,
    })),
  );
  const rerun = await tracking.run({
    COMMENT_TYPE: "review",
    VALIDATION_RESULT: "failure",
    VALIDATION_CONFIGURED: "",
  });
  expect(rerun).toContain(`Validation for \`${head}\`: **failure**`);
  expect(rerun.match(/<!-- codex-validation:/g)).toHaveLength(1);
  await tracking.run({ COMMENT_TYPE: "review", VALIDATION_RESULT: "failure" });
  expect(
    tracking.calls.filter(({ method }) => method === "PATCH"),
  ).toHaveLength(2);
});

test("reports skipped project checks and rejects invalid delivery metadata", async () => {
  const tracking = reporter("Existing comment");
  const body = await tracking.run({ VALIDATION_CONFIGURED: "false" });
  expect(body).toContain("**skipped (project checks are not configured)**");
  expect(tracking.calls[1]?.url).toBe(
    "https://api.github.com/repos/octo/demo/issues/comments/42",
  );
  await expect(tracking.run({ HEAD_SHA: "main" })).rejects.toThrow(
    "Invalid delivery metadata",
  );
  expect(tracking.calls).toHaveLength(2);
});
