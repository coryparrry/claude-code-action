import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { agentTraceConfig, parseTracingEnabled } from "../src/agent-tracing";

/** Isolate SDK-global processors and intercept all inference/export HTTP in a child process. */
function scenario(name: string) {
  const child = spawnSync(
    process.execPath,
    [
      "--no-env-file",
      new URL("./fixtures/tracing-runtime.ts", import.meta.url).pathname,
      name,
    ],
    {
      env: {
        PATH: process.env.PATH,
        OPENAI_API_KEY: "fake-test-key",
        OPENAI_AGENTS_DISABLE_TRACING: "",
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  expect(child.status).toBe(0);
  const lines = child.stdout.trim().split("\n");
  return JSON.parse(lines.at(-1)!);
}

test("tracing defaults on for direct OpenAI and protects other-provider credentials", () => {
  const base = { apiKey: "fixture-key", sessionId: "fixture", environment: {} };
  expect(agentTraceConfig(base).enabled).toBe(true);
  for (const extra of [
    { enabled: false },
    { customModel: true },
    { baseURL: "https://azure.example/openai" },
    { baseURL: "http://127.0.0.1:1234/v1" },
    { environment: { OPENAI_AGENTS_DISABLE_TRACING: "1" } },
  ])
    expect(agentTraceConfig({ ...base, ...extra }).enabled).toBe(false);
  expect(parseTracingEnabled()).toBeUndefined();
  expect(parseTracingEnabled("true")).toBe(true);
  expect(parseTracingEnabled("false")).toBe(false);
  expect(() => parseTracingEnabled("yes")).toThrow("enable_tracing");
});
test("real SDK traces finish and flush before return with useful labels but no payloads", () => {
  const result = scenario("success");
  expect(result.succeeded).toBe(true);
  expect(result.modelCalls).toBe(2);
  expect(result.traceCalls).toBeGreaterThan(0);
  expect(result.correctAuth).toBe(true);
  expect(result.payloadContainsSecrets).toBe(false);
  const items = result.exports.flatMap((entry: any) => entry.data);
  expect(
    items.some(
      (entry: any) =>
        entry.object === "trace" &&
        entry.workflow_name === "Codex verification",
    ),
  ).toBe(true);
  expect(JSON.stringify(items)).toContain("github:owner/repo:123:2");
  expect(JSON.stringify(items)).toContain('"pull_request":"38"');
  expect(items.some((entry: any) => entry.span_data?.type === "function")).toBe(
    true,
  );
  expect(
    items.some(
      (entry: any) =>
        entry.span_data?.type === "response" ||
        entry.span_data?.type === "generation",
    ),
  ).toBe(true);
});
test("disabled tracing never uploads SDK spans", () => {
  const result = scenario("disabled");
  expect(result.succeeded).toBe(true);
  expect(result.traceCalls).toBe(0);
});
test("export failure cannot change a successful action result", () => {
  const result = scenario("export-failure");
  expect(result.succeeded).toBe(true);
  expect(result.traceCalls).toBeGreaterThan(0);
  expect(result.payloadContainsSecrets).toBe(false);
});
test("model failures still flush traces without exposing failed input", () => {
  const result = scenario("model-failure");
  expect(result.succeeded).toBe(false);
  expect(result.traceCalls).toBeGreaterThan(0);
  expect(result.payloadContainsSecrets).toBe(false);
});

test("hung trace export is aborted without hanging or failing inference", () => {
  const started = Date.now();
  const result = scenario("export-hangs");
  expect(result.succeeded).toBe(true);
  expect(result.traceCalls).toBeGreaterThan(0);
  expect(Date.now() - started).toBeLessThan(10000);
}, 15000);
