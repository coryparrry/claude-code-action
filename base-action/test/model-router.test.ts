import { describe, expect, test } from "bun:test";
import {
  Usage,
  tool,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import { z } from "zod";
import { ModelRouter, parseModelRouting } from "../src/model-router";
import { runOpenAIAgent } from "../src/openai-agent-runner";

const config = {
  cheap_model: "custom-small",
  strong_model: "custom-large",
  max_cheap_turns: 1,
};
const prices = {
  "custom-small": { input: 0.1, cachedInput: 0.01, output: 0.5 },
  "custom-large": { input: 1, cachedInput: 0.05, output: 5 },
};
/** Build real SDK model responses without making paid API requests. */
function reply(text: string): ModelResponse {
  return {
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 2 }),
  };
}
/** Request a tool through the SDK's actual conversation loop. */
function call(name: string, args = {}): ModelResponse {
  return {
    output: [
      {
        type: "function_call",
        name,
        arguments: JSON.stringify(args),
        callId: `call-${name}`,
        status: "completed",
      },
    ],
    usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 2 }),
  };
}
/** Supply deterministic models while retaining the real Agent/Runner/tool integration. */
function model(
  responses: (
    | ModelResponse
    | Error
    | ((request: ModelRequest) => ModelResponse)
  )[],
): Model & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    /** Capture tier-specific reasoning and the continuation history. */
    async getResponse(request) {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected model request");
      if (response instanceof Error) throw response;
      return typeof response === "function" ? response(request) : response;
    },
    /** Keep streaming out of these nonstreaming fixtures. */
    async *getStreamedResponse() {
      throw new Error("Unexpected stream");
    },
  };
}
/** Build shared router state with a provider mapping arbitrary user-chosen model names. */
function fixture(
  small: ReturnType<typeof model>,
  large: ReturnType<typeof model>,
  maxCheapTurns = 1,
) {
  const router = new ModelRouter(
    { ...config, max_cheap_turns: maxCheapTurns },
    prices,
  );
  return {
    router,
    options: {
      apiKey: "fixture-only",
      model: "custom-small",
      modelRouter: router,
      modelProvider: {
        getModel: async (name: string) =>
          name === "custom-small" ? small : large,
      },
      instructions: "Complete the task.",
      tools: [],
      maxTurns: 5,
      deadline: Date.now() + 5000,
      /** Charge every completed response, matching the action's accounting boundary. */
      onEvent: (
        event: import("../src/openai-agent-runner").OpenAIAgentEvent,
      ) => {
        if (event.type === "model.response")
          router.record(
            event.activeModelName,
            event.response.usage,
            event.response.output,
          );
      },
    },
  };
}

describe("model router configuration", () => {
  test("routing is opt-in and validates names, efforts and limits", () => {
    expect(parseModelRouting()).toBeUndefined();
    expect(parseModelRouting("")).toBeUndefined();
    expect(parseModelRouting(JSON.stringify(config))).toMatchObject(config);
    for (const value of [
      "null",
      "{}",
      "{",
      JSON.stringify({ ...config, max_cheap_turns: 0 }),
      JSON.stringify({ ...config, cheap_effort: "unknown" }),
      JSON.stringify({ ...config, typo: true }),
    ])
      expect(() => parseModelRouting(value)).toThrow();
    expect(() => new ModelRouter(config, {})).toThrow("token prices");
    expect(
      () =>
        new ModelRouter(
          {
            ...config,
            cheap_model: "custom-large",
            strong_model: "custom-small",
          },
          prices,
        ),
    ).toThrow("higher token rates");
  });
  test("explicit stronger selection overrides the cheap phase and third roles are rejected", async () => {
    const small = model([]),
      large = model([reply("Verified")]);
    const f = fixture(small, large);
    f.router.requestModel("custom-large");
    await runOpenAIAgent("Update title", f.options);
    expect(small.requests).toHaveLength(0);
    expect(large.requests).toHaveLength(1);
    expect(() => f.router.requestModel("third-model")).toThrow(
      "Explicit model overrides",
    );
  });
  test("unpriced or unnamed fallback is rejected before paid inference", async () => {
    const small = model([]),
      large = model([]);
    const f = fixture(small, large);
    for (const fallbackModel of ["unknown-fallback", large])
      await expect(
        runOpenAIAgent("Update title", { ...f.options, fallbackModel }),
      ).rejects.toThrow("token prices");
    expect(small.requests).toHaveLength(0);
    expect(large.requests).toHaveLength(0);
  });
  test("risky and large inputs start strong without a paid triage call", async () => {
    for (const input of [
      "Fix authentication in src/auth/session.ts",
      "x".repeat(80_001),
      "Investigate a race condition",
      "Review array index validation and bounds",
    ]) {
      const small = model([]),
        large = model([reply("Done")]);
      const f = fixture(small, large);
      await runOpenAIAgent(input, f.options);
      expect(small.requests).toHaveLength(0);
      expect(large.requests).toHaveLength(1);
      expect(large.requests[0]!.modelSettings.reasoning?.effort).toBe("high");
    }
  });
  test("simple work finishes cheap and records its real cost", async () => {
    const small = model([reply("Done")]),
      large = model([]);
    const f = fixture(small, large);
    await runOpenAIAgent("Correct a spelling error", f.options);
    expect(large.requests).toHaveLength(0);
    expect(small.requests[0]!.modelSettings.reasoning?.effort).toBe("low");
    expect(f.router.report().cost_by_model_usd["custom-small"]).toBeGreaterThan(
      0,
    );
    expect(f.router.report().escalated).toBe(false);
  });
  test("turn escalation keeps tool output and executes side effects only once", async () => {
    let writes = 0;
    const small = model([call("write_once")]),
      large = model([reply("Done")]);
    const f = fixture(small, large);
    const result = await runOpenAIAgent("Update the title", {
      ...f.options,
      tools: [
        tool({
          name: "write_once",
          description: "Write the title",
          parameters: z.object({}),
          execute: async () => {
            writes++;
            return "title saved";
          },
        }),
      ],
    });
    expect(result.turns).toBe(2);
    expect(writes).toBe(1);
    expect(JSON.stringify(large.requests[0]!.input)).toContain("title saved");
    expect(f.router.report().cost_by_model_usd["custom-large"]).toBeGreaterThan(
      0,
    );
    expect(f.router.report().decisions.at(-1)?.reason).toContain("allowance");
  });
  test("explicit escalation uses the configured stronger model without resetting history", async () => {
    const small = model([
      call("request_stronger_model", { reason: "Need deeper reasoning" }),
    ]);
    const large = model([reply("Verified")]);
    const f = fixture(small, large, 5);
    await runOpenAIAgent("Fix the calculation", f.options);
    expect(f.router.report().decisions.at(-1)?.reason).toBe(
      "Need deeper reasoning",
    );
    expect(JSON.stringify(large.requests[0]!.input)).toContain(
      "Need deeper reasoning",
    );
  });
  test("shared state bounds cheap calls across auxiliary runs", async () => {
    const small = model([reply("One")]),
      large = model([reply("Two")]);
    const f = fixture(small, large);
    await runOpenAIAgent("First task", f.options);
    await runOpenAIAgent("Second task", f.options);
    expect(small.requests).toHaveLength(1);
    expect(large.requests).toHaveLength(1);
  });
  test("API fallback ends the cheap phase and preserves usage and effort", async () => {
    const error = Object.assign(new Error("busy"), { status: 429 });
    const small = model([error]),
      large = model([reply("Done")]);
    const f = fixture(small, large);
    await runOpenAIAgent("Update title", {
      ...f.options,
      fallbackModel: "custom-large",
    });
    expect(f.router.report().escalated).toBe(true);
    expect(large.requests[0]!.modelSettings.reasoning?.effort).toBe("high");
    expect(f.router.report().cost_by_model_usd["custom-large"]).toBeGreaterThan(
      0,
    );
  });
  test("routing retains the original total turn limit", async () => {
    const small = model([
      call("request_stronger_model", { reason: "Complex" }),
    ]);
    const large = model([]);
    const f = fixture(small, large);
    await expect(
      runOpenAIAgent("Do work", { ...f.options, maxTurns: 1 }),
    ).rejects.toThrow();
    expect(large.requests).toHaveLength(0);
  });
});
