/** Real SDK inference/tool/tracing loop with HTTP intercepted before any network request. */
import { tool } from "@openai/agents";
import { z } from "zod";
import { runOpenAIAgent } from "../../src/openai-agent-runner";
import { agentTraceConfig } from "../../src/agent-tracing";

const scenario = process.argv[2] ?? "success";
const privatePrompt = "PROMPT_PRIVATE_SENTINEL";
const privateTool = "TOOL_PRIVATE_SENTINEL";
const privateOutput = "MODEL_PRIVATE_SENTINEL";
const fakeKey = "TRACE_API_KEY_PRIVATE_SENTINEL";
const exports: unknown[] = [];
let modelCalls = 0,
  traceCalls = 0,
  correctAuth = true;
const originalFetch = globalThis.fetch;
/** Serve fake model and ingestion responses while recording only trace payloads. */
globalThis.fetch = (async (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url === "https://api.openai.com/v1/traces/ingest") {
    traceCalls++;
    if (scenario === "export-hangs") {
      await new Promise((_, reject) => {
        if (init?.signal?.aborted) return reject(new Error("Export cancelled"));
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("Export cancelled")),
          { once: true },
        );
      });
    }
    exports.push(JSON.parse(String(init?.body)));
    correctAuth &&=
      new Headers(init?.headers).get("Authorization") === `Bearer ${fakeKey}`;
    return Response.json(
      {},
      { status: scenario === "export-failure" ? 503 : 200 },
    );
  }
  if (url === "https://api.openai.com/v1/responses") {
    modelCalls++;
    if (scenario === "model-failure")
      return Response.json(
        {
          error: {
            message: privatePrompt,
            type: "invalid_request_error",
            code: "fixture_failure",
          },
        },
        { status: 400 },
      );
    const output =
      modelCalls === 1
        ? [
            {
              type: "function_call",
              id: "fc_fixture",
              call_id: "call_fixture",
              name: "echo",
              arguments: JSON.stringify({ value: privateTool }),
              status: "completed",
            },
          ]
        : [
            {
              type: "message",
              id: "msg_fixture",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: privateOutput, annotations: [] },
              ],
            },
          ];
    return Response.json({
      id: `resp_fixture_${modelCalls}`,
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-fixture",
      output,
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        total_tokens: 13,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
  }
  throw new Error("Unexpected network request in tracing fixture");
}) as typeof fetch;
let succeeded = false;
try {
  const config = agentTraceConfig({
    apiKey: fakeKey,
    sessionId: "fixture-session",
    enabled: scenario !== "disabled",
    phase: "verification",
    environment: {
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/38/merge",
    },
  });
  const result = await runOpenAIAgent(privatePrompt, {
    apiKey: fakeKey,
    model: "gpt-fixture",
    tracing: config,
    instructions: privatePrompt,
    tools: [
      tool({
        name: "echo",
        description: "Echo a value",
        parameters: z.object({ value: z.string() }),
        execute: async () => privateTool,
      }),
    ],
    maxTurns: 4,
    deadline: Date.now() + 5000,
  });
  succeeded = result.finalOutput === privateOutput;
} catch {
  succeeded = false;
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  JSON.stringify({
    scenario,
    succeeded,
    modelCalls,
    traceCalls,
    correctAuth,
    exports,
    payloadContainsSecrets: [
      privatePrompt,
      privateTool,
      privateOutput,
      fakeKey,
    ].some((value) => JSON.stringify(exports).includes(value)),
  }),
);
