/** Paid, explicitly invoked paired comparison using the actual action runtime and isolated workspaces. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { runCodex } from "../../base-action/src/run-codex";
import { DEFAULT_MODEL_PRICES } from "../../base-action/src/agent-budget";
import { routingCases, type RoutingCase } from "./fixtures";
import {
  evaluateRouting,
  gradeReview,
  type RoutingObservation,
} from "./evaluation";

assert.ok(
  process.env.OPENAI_API_KEY,
  "Supply an existing API key through the environment; never pass it as an argument",
);
const output = resolve(
  process.env.ROUTER_BENCH_OUTPUT ?? "/tmp/model-router-benchmark",
);
const repeats = Number(process.env.ROUTER_BENCH_REPEATS ?? 2);
assert.ok(
  Number.isInteger(repeats) && repeats >= 1 && repeats <= 10,
  "Repeats must be 1..10",
);
const cheap = process.env.ROUTER_CHEAP_MODEL ?? "gpt-6-luna";
const strong = process.env.ROUTER_STRONG_MODEL ?? "gpt-6.1-terra";
const strongEffort = process.env.ROUTER_STRONG_EFFORT ?? "high";
const maxCost = Number(process.env.ROUTER_BENCH_MAX_USD ?? 5);
assert.ok(Number.isFinite(maxCost) && maxCost > 0);
const only = process.env.ROUTER_BENCH_CASE;
const cases = only
  ? routingCases.filter((item) => item.id === only)
  : routingCases;
assert.ok(cases.length > 0, "No matching benchmark cases");
const rawWrite = process.stdout.write.bind(process.stdout);
// Suppress action logs and GitHub add-mask commands, which contain the local credential.
process.stdout.write = (() => true) as typeof process.stdout.write;
/** Emit only sanitized benchmark metadata through the original output stream. */
function log(value: unknown) {
  rawWrite(`${JSON.stringify(value)}\n`);
}
const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "category", "explanation"],
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          category: {
            type: "string",
            enum: [
              "bounds",
              "input_mutation",
              "authorization",
              "defaulting",
              "other",
            ],
          },
          explanation: { type: "string" },
        },
      },
    },
  },
};
type Row = RoutingObservation & {
  turns: number;
  duration_ms: number;
  routing?: unknown;
  error?: string;
};
const sourceFiles = [
  "base-action/src/model-router.ts",
  "base-action/src/openai-agent-runner.ts",
  "base-action/src/run-codex.ts",
  "base-action/src/codex-agent-runtime.ts",
  "base-action/src/agent-budget.ts",
  "bun.lock",
  "scripts/model-routing/benchmark.ts",
  "scripts/model-routing/fixtures.ts",
  "scripts/model-routing/evaluation.ts",
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (path) => [
      path,
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ]),
  ),
);
const sourceBase = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const rows: Row[] = [];
let totalCost = 0;
await mkdir(output, { recursive: true });

/** Check observable behavior using private edge cases or exact expected finding locations and categories. */
async function grade(
  item: RoutingCase,
  workspace: string,
  structured: unknown,
): Promise<boolean> {
  if (item.kind === "fix") {
    try {
      execFileSync(
        process.execPath,
        [
          "--no-env-file",
          "-e",
          `import assert from 'node:assert/strict'; const m=await import(${JSON.stringify(join(workspace, item.path))}); ${item.check}`,
        ],
        {
          cwd: workspace,
          stdio: "pipe",
          env: { PATH: process.env.PATH, TMPDIR: tmpdir() },
          timeout: 10000,
        },
      );
      return true;
    } catch {
      return false;
    }
  }
  return gradeReview(item.path, item.expected!, structured);
}

/** Execute each arm from an identical source tree; retain redacted native execution reports. */
async function run(
  item: RoutingCase,
  repeat: number,
  arm: Row["arm"],
): Promise<Row> {
  assert.ok(
    totalCost < maxCost,
    "Benchmark reached its cumulative spending limit",
  );
  const root = await mkdtemp(join(tmpdir(), "router-bench-"));
  const workspace = join(root, "workspace");
  await mkdir(dirname(join(workspace, item.path)), { recursive: true });
  await writeFile(join(workspace, item.path), item.source);
  await writeFile(
    join(root, "prompt.txt"),
    `${item.request}\nThe file is ${item.path}. Inspect it before answering. ${item.kind === "fix" ? "Implement the fix in the workspace. Do not merely describe a solution." : "Return the requested findings JSON. Keep file paths relative to the workspace."}`,
  );
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  process.env.RUNNER_TEMP = join(root, "report");
  await mkdir(process.env.RUNNER_TEMP, { recursive: true });
  const started = Date.now();
  let structured: unknown,
    error: string | undefined,
    turns = 0;
  try {
    const result = await runCodex(join(root, "prompt.txt"), {
      mcpConfig: '{"mcpServers":{}}',
      model: strong,
      effort: strongEffort,
      modelRouting:
        arm === "routed"
          ? {
              cheap_model: cheap,
              strong_model: strong,
              strong_effort: strongEffort as "high",
              max_cheap_turns: 3,
            }
          : undefined,
      sandbox: item.kind === "fix" ? "workspace-write" : "read-only",
      permissionMode: "acceptEdits",
      maxTurns: 12,
      maxBudgetUsd: Math.min(0.3, maxCost - totalCost),
      timeoutMs: 180000,
      workspace,
      configurationHome: root,
      sessionStoragePath: join(root, "sessions"),
      settingSources: [],
      settings: JSON.stringify({
        web_search: "disabled",
      }),
      compatibilityArgs: `--no-session-persistence --disable-slash-commands --tools ${item.kind === "fix" ? "Read,Write,Edit,Glob,Grep,LS" : "Read,Glob,Grep,LS"}${item.kind === "review" ? ` --json-schema '${JSON.stringify(reviewSchema)}'` : ""}`,
    });
    structured = result.structuredOutput;
    turns = result.numTurns ?? 0;
  } catch (caught) {
    error = (
      caught instanceof Error ? caught.message : String(caught)
    ).replaceAll(process.env.OPENAI_API_KEY!, "[REDACTED]");
  }
  const report = JSON.parse(
    await readFile(
      join(process.env.RUNNER_TEMP, "codex-execution-output.json"),
      "utf8",
    ),
  );
  const final = report.at(-1);
  assert.equal(
    typeof final.total_cost_usd,
    "number",
    "Unknown cost must fail the benchmark",
  );
  totalCost += final.total_cost_usd;
  await writeFile(
    join(output, `${item.id}-${repeat}-${arm}-execution.json`),
    JSON.stringify(report, null, 2),
  );
  if (item.kind === "fix")
    await writeFile(
      join(output, `${item.id}-${repeat}-${arm}-source.ts`),
      await readFile(join(workspace, item.path), "utf8"),
    );
  return {
    case: item.id,
    repeat,
    arm,
    passed: !error && (await grade(item, workspace, structured)),
    cost_usd: final.total_cost_usd,
    turns,
    duration_ms: Date.now() - started,
    ...(final.model_routing ? { routing: final.model_routing } : {}),
    ...(error ? { error } : {}),
  };
}

for (let repeat = 0; repeat < repeats; repeat++) {
  for (const [index, item] of cases.entries()) {
    // Counterbalance execution order across cases and repeats.
    const arms: Row["arm"][] =
      (index + repeat) % 2 ? ["routed", "baseline"] : ["baseline", "routed"];
    for (const arm of arms) {
      const row = await run(item, repeat, arm);
      rows.push(row);
      log(row);
      await writeFile(
        join(output, "checkpoint.json"),
        JSON.stringify({ rows, total_cost_usd: totalCost }, null, 2),
      );
      if (
        row.error &&
        /401|403|429|insufficient_quota|model.*not.*found/i.test(row.error)
      )
        throw new Error(
          "Provider prerequisite failed; see checkpoint for redacted details",
        );
    }
  }
}
const summary = {
  recorded_at: new Date().toISOString(),
  source_base_sha: sourceBase,
  source_sha256: sourceHashes,
  baseline: { model: strong, effort: strongEffort },
  router: { cheap_model: cheap, strong_model: strong, max_cheap_turns: 3 },
  fixture_sha256: createHash("sha256")
    .update(JSON.stringify(cases))
    .digest("hex"),
  repeats,
  tasks: cases.length,
  pricing_source: "https://developers.openai.com/api/docs/pricing",
  pricing: {
    [cheap]: DEFAULT_MODEL_PRICES[cheap],
    [strong]: DEFAULT_MODEL_PRICES[strong],
  },
  ...evaluateRouting(rows, cases.length * repeats),
  limitation:
    "Small synthetic action-runtime suite; does not establish noninferiority across arbitrary repositories, long-context tasks, or hosted GitHub publishing.",
  rows,
};
await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2));
log({ ...summary, rows: undefined });
process.exitCode = summary.accepted ? 0 : 1;
