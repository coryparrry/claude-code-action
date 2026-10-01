import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  MemorySession,
  Usage,
  tool,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import { z } from "zod";
import { createAgentCompaction } from "../src/agent-compaction";
import {
  runOpenAIAgent,
  OpenAIAgentRunError,
} from "../src/openai-agent-runner";

let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => {
  fetchMock?.mockRestore();
  fetchMock = undefined;
});

function fakeCompact(
  options: {
    fail?: boolean;
    onRequest?: (request: Request, body: Record<string, unknown>) => void;
  } = {},
) {
  const requests: Record<string, unknown>[] = [];
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (...args: Parameters<typeof globalThis.fetch>) => {
        const [input, init] = args;
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(String(input), init);
        const body = JSON.parse(await request.text()) as Record<
          string,
          unknown
        >;
        requests.push(body);
        options.onRequest?.(request, body);
        return new Response(
          JSON.stringify(
            options.fail
              ? {
                  error: {
                    message: "Compaction unavailable",
                    type: "server_error",
                    code: "server_error",
                  },
                }
              : {
                  id: "compact-response",
                  object: "response.compaction",
                  created_at: 1,
                  output: [
                    {
                      type: "message",
                      role: "user",
                      content: [
                        { type: "input_text", text: "Preserved user request" },
                      ],
                    },
                    {
                      type: "compaction",
                      id: "compact-marker",
                      encrypted_content: "opaque-context-snapshot",
                    },
                  ],
                  usage: {
                    input_tokens: 20,
                    output_tokens: 2,
                    total_tokens: 22,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 0 },
                  },
                },
          ),
          {
            status: options.fail ? 500 : 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  return requests;
}
function response(inputTokens: number): ModelResponse {
  return {
    usage: new Usage({ requests: 1, inputTokens, outputTokens: 5 }),
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Done" }],
      },
    ],
  };
}

describe("SDK context compaction", () => {
  test("triggers using observed tokens and emits actual compaction lifecycle and charges", async () => {
    const requests = fakeCompact({
      onRequest: (request) => {
        expect(request.url).toBe(
          "http://offline-compact.test/v1/responses/compact",
        );
        expect(request.headers.get("authorization")).toBe("Bearer offline-key");
      },
    });
    const events: string[] = [];
    const compact = createAgentCompaction({
      apiKey: "offline-key",
      baseURL: "http://offline-compact.test/v1",
      model: "gpt-5.3-codex",
      signal: new AbortController().signal,
      onBeforeCompact: ({ trigger }) => {
        events.push(`before:${trigger}`);
      },
      onUsage: (usage, model) => {
        events.push(`usage:${model}:${usage.inputTokens}`);
      },
      onAfterCompact: ({ history }) => {
        expect(history.some((item) => item.type === "compaction")).toBe(true);
        events.push("after");
      },
    });
    await compact.session.addItems([
      { role: "user", content: "Preserved user request" },
    ]);
    compact.observeResponse(response(319_000));
    expect(await compact.session.runCompaction()).toBeNull();
    compact.observeResponse(response(320_000));
    const result = await compact.session.runCompaction();
    expect(result?.usage.inputTokens).toBe(20);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe("gpt-5.3-codex");
    expect(requests[0]).not.toHaveProperty("previous_response_id");
    expect(events).toEqual(["before:auto", "usage:gpt-5.3-codex:20", "after"]);
    expect(await compact.session.runCompaction()).toBeNull();
  });

  test("does not guess custom model context windows and uses the actual fallback model", async () => {
    const requests = fakeCompact();
    const compact = createAgentCompaction({
      apiKey: "offline-key",
      model: "gpt-custom",
      signal: new AbortController().signal,
    });
    await compact.session.addItems([{ role: "user", content: "request" }]);
    compact.observeResponse(response(900_000));
    expect(await compact.session.runCompaction()).toBeNull();
    compact.observeResponse(response(320_000), "gpt-5.3-codex");
    await compact.session.runCompaction();
    expect(requests[0]?.model).toBe("gpt-5.3-codex");
  });

  test("only compacts a completed prefix while preserving pending tool calls", async () => {
    const requests = fakeCompact();
    const compact = createAgentCompaction({
      apiKey: "offline-key",
      model: "gpt-custom",
      signal: new AbortController().signal,
    });
    await compact.session.addItems([
      { role: "user", content: "earlier request" },
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "earlier answer" }],
      },
      {
        type: "function_call",
        callId: "pending-call",
        name: "Write",
        arguments: '{"path":"pending.txt"}',
      },
    ]);
    const history = await compact.forceCompact();
    expect(JSON.stringify(requests[0]?.input)).not.toContain("pending-call");
    expect(history?.at(-1)).toMatchObject({
      type: "function_call",
      callId: "pending-call",
    });
    expect(history?.some((item) => item.type === "compaction")).toBe(true);
  });

  test("failed compaction restores the completed prefix and pending suffix", async () => {
    const requests = fakeCompact({ fail: true });
    const store = new MemorySession();
    const original = [
      { role: "user" as const, content: "request" },
      {
        type: "function_call" as const,
        callId: "pending",
        name: "Write",
        arguments: "{}",
      },
    ];
    await store.addItems(original);
    const compact = createAgentCompaction({
      apiKey: "offline-key",
      model: "gpt-custom",
      underlyingSession: store,
      signal: new AbortController().signal,
    });
    await expect(compact.forceCompact()).rejects.toThrow(
      "Compaction unavailable",
    );
    expect(await store.getItems()).toEqual(original);
    expect(requests).toHaveLength(1);
  });

  test("does not compact an unresolved call without a completed prefix", async () => {
    const requests = fakeCompact();
    const compact = createAgentCompaction({
      apiKey: "offline-key",
      model: "gpt-custom",
      signal: new AbortController().signal,
    });
    await compact.session.addItems([
      {
        type: "function_call",
        callId: "pending",
        name: "Write",
        arguments: "{}",
      },
    ]);
    expect(await compact.forceCompact()).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  test("Runner reloads real SDK compacted memory between tool turns and records compaction usage", async () => {
    const requests = fakeCompact();
    const compact = createAgentCompaction({
      apiKey: "offline-key",
      model: "gpt-5.3-codex",
      contextWindowTokens: 100,
      signal: new AbortController().signal,
    });
    const modelRequests: ModelRequest[] = [];
    let executions = 0;
    const model: Model = {
      async getResponse(request) {
        modelRequests.push(request);
        if (modelRequests.length === 1)
          return {
            usage: new Usage({ requests: 1, inputTokens: 90, outputTokens: 5 }),
            output: [
              {
                type: "function_call",
                callId: "once",
                name: "echo",
                arguments: '{"value":"test"}',
              },
            ],
          };
        return response(10);
      },
      async *getStreamedResponse() {
        throw new Error("Unused streaming path");
      },
    };
    const result = await runOpenAIAgent("Preserved user request", {
      apiKey: "offline-key",
      model,
      instructions: "Trusted instructions",
      tools: [
        tool({
          name: "echo",
          description: "Echo",
          parameters: z.object({ value: z.string() }),
          execute: () => {
            executions++;
            return "completed tool";
          },
        }),
      ],
      session: compact.session,
      prepareModelInput: compact.prepareModelInput,
      transformHistory: compact.projectHistory,
      additionalUsage: compact.getAdditionalUsage,
      maxTurns: 2,
      deadline: Date.now() + 5000,
      onEvent: (event) => {
        if (event.type === "model.response")
          compact.observeResponse(event.response, event.activeModelName);
      },
    });
    expect(requests).toHaveLength(1);
    expect(executions).toBe(1);
    expect(JSON.stringify(modelRequests[1]?.input)).toContain(
      "opaque-context-snapshot",
    );
    expect(result.turns).toBe(2);
    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.outputTokens).toBe(12);
    expect(result.usage.requests).toBe(3);
    expect(
      (await compact.session.getItems()).some(
        (item) => item.type === "compaction",
      ),
    ).toBe(true);
  });

  test("context-limit recovery compacts the first oversized input once and preserves retry and fallback history", async () => {
    const requests = fakeCompact();
    const compact = createAgentCompaction({
      apiKey: "offline-key",
      model: "gpt-5.3-codex",
      signal: new AbortController().signal,
    });
    const primaryRequests: ModelRequest[] = [];
    const fallbackRequests: ModelRequest[] = [];
    const primary: Model = {
      async getResponse(request) {
        primaryRequests.push(request);
        throw Object.assign(
          new Error("Limit"),
          primaryRequests.length === 1
            ? { code: "context_length_exceeded" }
            : { status: 503 },
        );
      },
      async *getStreamedResponse() {
        throw new Error("Unused");
      },
    };
    const fallback: Model = {
      async getResponse(request) {
        fallbackRequests.push(request);
        return response(10);
      },
      async *getStreamedResponse() {
        throw new Error("Unused");
      },
    };
    const result = await runOpenAIAgent(
      [{ role: "user", content: "Resumed oversized request" }],
      {
        apiKey: "offline-key",
        model: primary,
        fallbackModel: fallback,
        instructions: "Trusted",
        tools: [],
        maxTurns: 1,
        deadline: Date.now() + 5000,
        prepareModelInput: compact.prepareModelInput,
        transformHistory: compact.projectHistory,
        additionalUsage: compact.getAdditionalUsage,
        onContextLimit: (input, context) =>
          compact.forceCompact(context, input),
      },
    );
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.input)).toContain(
      "Resumed oversized request",
    );
    expect(primaryRequests).toHaveLength(2);
    expect(JSON.stringify(primaryRequests[1]?.input)).toContain(
      "opaque-context-snapshot",
    );
    expect(JSON.stringify(fallbackRequests[0]?.input)).toContain(
      "opaque-context-snapshot",
    );
    expect(result.turns).toBe(1);
    expect(result.usage.requests).toBe(2);
    expect(JSON.stringify(result.history)).toContain("opaque-context-snapshot");
  });

  test("a failed resumed request supplies its pending suffix without sending it to compact", async () => {
    const requests = fakeCompact();
    const compact = createAgentCompaction({
      apiKey: "offline-key",
      model: "gpt-5.3-codex",
      signal: new AbortController().signal,
    });
    const input = [
      { role: "user" as const, content: "Oversized completed input" },
      {
        type: "function_call" as const,
        callId: "pending-new",
        name: "Write",
        arguments: "{}",
      },
    ];
    const result = await compact.forceCompact(undefined, input);
    expect(JSON.stringify(requests[0]?.input)).not.toContain("pending-new");
    expect(result?.at(-1)).toMatchObject({ callId: "pending-new" });
    expect(compact.projectHistory(input)?.at(-1)).toMatchObject({
      callId: "pending-new",
    });
  });

  test("a post-compaction budget failure retains the compacted checkpoint and pending suffix", async () => {
    fakeCompact();
    const compact = createAgentCompaction({
      apiKey: "offline-key",
      model: "gpt-5.3-codex",
      signal: new AbortController().signal,
      onUsage: () => {
        throw new Error("Budget exhausted");
      },
    });
    const input = [
      { role: "user" as const, content: "Oversized completed input" },
      {
        type: "function_call" as const,
        callId: "pending",
        name: "Write",
        arguments: "{}",
      },
    ];
    await expect(compact.forceCompact(undefined, input)).rejects.toThrow(
      "Budget exhausted",
    );
    const history = await compact.session.getItems();
    expect(history.some((item) => item.type === "compaction")).toBe(true);
    expect(history.at(-1)).toMatchObject({ callId: "pending" });
    expect(compact.projectHistory(input)).toEqual(history);
    expect(compact.getAdditionalUsage().inputTokens).toBe(20);
  });

  test("compaction charges survive a model-budget rejection before SDK acceptance", async () => {
    fakeCompact();
    const compact = createAgentCompaction({
      apiKey: "offline-key",
      model: "gpt-5.3-codex",
      signal: new AbortController().signal,
    });
    let calls = 0;
    const model: Model = {
      async getResponse() {
        if (++calls === 1)
          throw Object.assign(new Error("Context limit"), {
            code: "context_length_exceeded",
          });
        return response(30);
      },
      async *getStreamedResponse() {
        throw new Error("Unused");
      },
    };
    try {
      await runOpenAIAgent("Oversized request", {
        apiKey: "offline-key",
        model,
        instructions: "Trusted",
        tools: [],
        deadline: Date.now() + 5000,
        maxTurns: 1,
        prepareModelInput: compact.prepareModelInput,
        transformHistory: compact.projectHistory,
        additionalUsage: compact.getAdditionalUsage,
        onContextLimit: (input, context) =>
          compact.forceCompact(context, input),
        onEvent: (event) => {
          if (event.type === "model.response")
            throw new Error("Budget exhausted");
        },
      });
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenAIAgentRunError);
      const partial = (error as OpenAIAgentRunError).partialResult;
      expect(partial.usage.inputTokens).toBe(50);
      expect(partial.usage.requests).toBe(2);
      expect(JSON.stringify(partial.history)).toContain(
        "opaque-context-snapshot",
      );
    }
  });

  test("cancellation prevents compaction API calls and preserves memory", async () => {
    const requests = fakeCompact();
    const controller = new AbortController();
    controller.abort();
    const compact = createAgentCompaction({
      apiKey: "offline-key",
      model: "gpt-custom",
      signal: controller.signal,
    });
    await compact.session.addItems([{ role: "user", content: "request" }]);
    await expect(compact.forceCompact()).rejects.toThrow();
    expect(requests).toHaveLength(0);
    expect(await compact.session.getItems()).toHaveLength(1);
  });
});
