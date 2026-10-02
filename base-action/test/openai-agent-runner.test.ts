import { describe, expect, spyOn, test } from "bun:test";
import {
  MemorySession,
  Usage,
  tool,
  type AgentInputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import { z } from "zod";
import {
  runOpenAIAgent,
  OpenAIAgentRunError,
  type OpenAIAgentEvent,
  type OpenAIAgentOptions,
} from "../src/openai-agent-runner";

type Reply =
  | ModelResponse
  | ((request: ModelRequest) => Promise<ModelResponse>);

/** A model boundary fixture. Agent turns, tool invocation and history use the real SDK. */
class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly replies: Reply[]) {}
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const reply = this.replies[this.requests.length - 1];
    if (!reply) throw new Error("Unexpected model request");
    return typeof reply === "function" ? reply(request) : reply;
  }
  async *getStreamedResponse(): AsyncGenerator<never> {
    throw new Error("This fixture tests the non-streaming SDK loop");
  }
}

function response(output: ModelResponse["output"]): ModelResponse {
  return {
    output,
    usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 3 }),
  };
}
function message(text: string): ModelResponse {
  return response([
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ]);
}
function call(index: number, args = { value: "test" }): ModelResponse {
  return response([
    {
      type: "function_call",
      name: "echo",
      callId: `call-${index}`,
      arguments: JSON.stringify(args),
      status: "completed",
    },
  ]);
}
function options(
  model: Model,
  extra: Partial<OpenAIAgentOptions> = {},
): OpenAIAgentOptions {
  return {
    apiKey: "offline-api-key",
    model,
    instructions: "Trusted action instructions",
    tools: [],
    maxTurns: 5,
    deadline: Date.now() + 5000,
    ...extra,
  };
}

describe("OpenAI Agents SDK runner", () => {
  test("a Skill model change applies to the next inference without replaying tools or resetting limits", async () => {
    let selected = "gpt-primary";
    let executions = 0;
    const primary = new ScriptedModel([call(1)]);
    const changed = new ScriptedModel([message("Changed model")]);
    const events: OpenAIAgentEvent[] = [];
    const result = await runOpenAIAgent(
      "request",
      options(primary, {
        model: selected,
        resolveModel: () => selected,
        modelProvider: {
          getModel: (name) => (name === "gpt-primary" ? primary : changed),
        },
        maxTurns: 2,
        onEvent: (event) => events.push(event),
        tools: [
          tool({
            name: "echo",
            description: "Skill selection",
            parameters: z.object({ value: z.string() }),
            execute: () => {
              executions++;
              selected = "gpt-skill";
              return "Skill loaded";
            },
          }),
        ],
      }),
    );
    expect(result.turns).toBe(2);
    expect(executions).toBe(1);
    expect(primary.requests).toHaveLength(1);
    expect(JSON.stringify(changed.requests[0]?.input)).toContain(
      "Skill loaded",
    );
    expect(
      events
        .filter((e) => e.type === "model.response")
        .map((e) => e.activeModelName),
    ).toEqual(["gpt-primary", "gpt-skill"]);
  });

  test("same dynamic primary retains fallback until an explicit new model selection", async () => {
    let selected = "gpt-primary";
    const primary = new ScriptedModel([
      async () => {
        throw Object.assign(new Error("unavailable"), { status: 503 });
      },
    ]);
    const fallback = new ScriptedModel([call(1), call(2)]);
    const changed = new ScriptedModel([message("Done")]);
    let executions = 0;
    const result = await runOpenAIAgent(
      "request",
      options(primary, {
        model: selected,
        fallbackModel: "gpt-fallback",
        resolveModel: () => selected,
        modelProvider: {
          getModel: (name) =>
            name === "gpt-primary"
              ? primary
              : name === "gpt-fallback"
                ? fallback
                : changed,
        },
        maxTurns: 3,
        tools: [
          tool({
            name: "echo",
            description: "Select",
            parameters: z.object({ value: z.string() }),
            execute: () => {
              if (++executions === 2) selected = "gpt-skill";
              return "Selected";
            },
          }),
        ],
      }),
    );
    expect(result.turns).toBe(3);
    expect(primary.requests).toHaveLength(1);
    expect(fallback.requests).toHaveLength(2);
    expect(changed.requests).toHaveLength(1);
    expect(executions).toBe(2);
  });

  test("real SDK streamed output emits deltas and commits only the completed assistant output", async () => {
    const events: OpenAIAgentEvent[] = [];
    const streamed: Model = {
      async getResponse() {
        throw new Error("Nonstreaming call not expected");
      },
      async *getStreamedResponse() {
        yield { type: "response_started" as const };
        yield {
          type: "output_text_delta" as const,
          delta: "Hel",
          itemId: "assistant-1",
        };
        yield {
          type: "output_text_delta" as const,
          delta: "lo",
          itemId: "assistant-1",
        };
        yield {
          type: "response_done" as const,
          response: {
            id: "response-1",
            output: [
              {
                type: "message" as const,
                role: "assistant" as const,
                status: "completed" as const,
                content: [{ type: "output_text" as const, text: "Hello" }],
              },
            ],
            usage: {
              requests: 1,
              inputTokens: 10,
              outputTokens: 3,
              totalTokens: 13,
            },
          },
        };
      },
    };
    const result = await runOpenAIAgent(
      "request",
      options(streamed, {
        includePartialMessages: true,
        onEvent: (event) => events.push(event),
      }),
    );
    expect(
      events
        .filter((event) => event.type === "assistant.delta")
        .map((event) => event.text),
    ).toEqual(["Hel", "lo"]);
    expect(result.finalOutput).toBe("Hello");
    expect(result.history).toHaveLength(2);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.turns).toBe(1);
  });

  test("stream failure after a delta cannot replay the provider request on fallback", async () => {
    const fallback = new ScriptedModel([message("Replay")]);
    const streamed: Model = {
      async getResponse() {
        throw new Error("Unused");
      },
      async *getStreamedResponse() {
        yield { type: "output_text_delta" as const, delta: "Partial" };
        throw Object.assign(new Error("Stream failed"), { status: 503 });
      },
    };
    await expect(
      runOpenAIAgent(
        "request",
        options(streamed, {
          includePartialMessages: true,
          fallbackModel: fallback,
        }),
      ),
    ).rejects.toThrow("Stream failed");
    expect(fallback.requests).toHaveLength(0);
  });

  test("keeps instructions separate from user input and disables model tracing and storage", async () => {
    const model = new ScriptedModel([message("Done")]);
    const events: OpenAIAgentEvent[] = [];
    const result = await runOpenAIAgent(
      "User request",
      options(model, { onEvent: (event) => events.push(event) }),
    );
    expect(result.finalOutput).toBe("Done");
    expect(result.turns).toBe(1);
    expect(result.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(3);
    expect(model.requests[0]?.systemInstructions).toBe(
      "Trusted action instructions",
    );
    expect(JSON.stringify(model.requests[0]?.input)).toContain("User request");
    expect(JSON.stringify(model.requests[0]?.input)).not.toContain(
      "Trusted action instructions",
    );
    expect(model.requests[0]?.tracing).toBe(false);
    expect(model.requests[0]?.modelSettings.store).toBe(false);
    expect(events.map((event) => event.type)).toEqual([
      "model.response",
      "assistant",
    ]);
    expect(result.history).toHaveLength(2);
  });

  test("resolves a named model using the supplied provider", async () => {
    const model = new ScriptedModel([message("Done")]);
    const selected: (string | undefined)[] = [];
    await runOpenAIAgent(
      "request",
      options(model, {
        model: "codex-test-model",
        modelProvider: {
          getModel: (name) => {
            selected.push(name);
            return model;
          },
        },
      }),
    );
    expect(selected).toEqual(["codex-test-model"]);
  });

  test("sends the endpoint, API key and caller schema through the actual Responses provider", async () => {
    const schema = {
      type: "object" as const,
      properties: { status: { type: "string" }, optional: { type: "string" } },
      required: ["status"],
      additionalProperties: true as const,
    };
    let body: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    let path: string | undefined;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (...args: Parameters<typeof globalThis.fetch>) => {
          const [input, init] = args;
          const request =
            input instanceof Request
              ? new Request(input, init)
              : new Request(String(input), init);
          body = JSON.parse(await request.text());
          authorization = request.headers.get("authorization") ?? undefined;
          path = request.url;
          return new Response(
            JSON.stringify({
              id: "response-offline",
              object: "response",
              created_at: 1,
              status: "completed",
              model: "offline-codex",
              output: [
                {
                  id: "message-offline",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: '{"status":"HTTP response"}',
                      annotations: [],
                    },
                  ],
                },
              ],
              usage: {
                input_tokens: 4,
                output_tokens: 3,
                total_tokens: 7,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const savedBaseURL = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "https://invalid-process-environment.example";
    try {
      const result = await runOpenAIAgent(
        "User request",
        options(new ScriptedModel([]), {
          model: "offline-codex",
          baseURL: "http://offline-endpoint.test/v1",
          schema,
        }),
      );
      expect(result.finalOutput).toEqual({ status: "HTTP response" });
      expect(path).toBe("http://offline-endpoint.test/v1/responses");
      expect(authorization).toBe("Bearer offline-api-key");
      expect(body?.model).toBe("offline-codex");
      expect(body?.instructions).toBe("Trusted action instructions");
      expect(body?.store).toBe(false);
      expect(body?.text).toMatchObject({
        format: {
          type: "json_schema",
          name: "action_result",
          strict: false,
          schema,
        },
      });
    } finally {
      if (savedBaseURL === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = savedBaseURL;
      fetch.mockRestore();
    }
  });

  test("executes real SDK function tools and adds their results to the next request", async () => {
    const model = new ScriptedModel([call(1), message("Used tool")]);
    const invoked: string[] = [];
    const events: OpenAIAgentEvent[] = [];
    const echo = tool({
      name: "echo",
      description: "Echo a string",
      parameters: z.object({ value: z.string() }),
      execute: ({ value }) => {
        invoked.push(value);
        return `Echoed ${value}`;
      },
    });
    const result = await runOpenAIAgent(
      "request",
      options(model, { tools: [echo], onEvent: (event) => events.push(event) }),
    );
    expect(invoked).toEqual(["test"]);
    expect(result.turns).toBe(2);
    expect(result.usage.inputTokens).toBe(20);
    expect(events.map((event) => event.type)).toContain("tool.started");
    expect(events.map((event) => event.type)).toContain("tool.completed");
    const started = events.find((event) => event.type === "tool.started");
    const ended = events.find((event) => event.type === "tool.completed");
    expect(started?.type === "tool.started" && started.callId).toBe("call-1");
    expect(ended?.type === "tool.completed" && ended.callId).toBe("call-1");
    expect(JSON.stringify(model.requests[1]?.input)).toContain("Echoed test");
    expect(
      result.history.some((item) => item.type === "function_call_result"),
    ).toBe(true);
  });

  test("the SDK stops model calls at the exact requested turn cap", async () => {
    const model = new ScriptedModel([
      call(1),
      call(2),
      message("Should not run"),
    ]);
    let executions = 0;
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ value: z.string() }),
      execute: () => {
        executions++;
        return "ok";
      },
    });
    await expect(
      runOpenAIAgent("request", options(model, { tools: [echo], maxTurns: 2 })),
    ).rejects.toThrow("2 turn limit");
    expect(model.requests).toHaveLength(2);
    expect(executions).toBe(2);
  });

  test("async before-model context reaches the model and persists for resume", async () => {
    const model = new ScriptedModel([message("Final")]);
    const result = await runOpenAIAgent(
      "request",
      options(model, {
        onBeforeModel: async (_input, context) => {
          expect(context.turn).toBe(1);
          return [{ role: "user", content: "Async hook wake context" }];
        },
      }),
    );
    expect(JSON.stringify(model.requests[0]?.input)).toContain(
      "Async hook wake context",
    );
    expect(JSON.stringify(result.history)).toContain("Async hook wake context");
  });

  test("hook context survives later SDK turns once and retains its history position", async () => {
    const model = new ScriptedModel([call(1), message("Final")]);
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ value: z.string() }),
      execute: () => "tool result",
    });
    const result = await runOpenAIAgent(
      "request",
      options(model, {
        tools: [echo],
        onBeforeModel: async (_input, context) =>
          context.turn === 1
            ? [{ role: "user", content: "Persisted hook context" }]
            : undefined,
      }),
    );
    expect(
      JSON.stringify(model.requests[1]?.input).split("Persisted hook context"),
    ).toHaveLength(2);
    const stored = JSON.stringify(result.history);
    expect(stored.split("Persisted hook context")).toHaveLength(2);
    expect(stored.indexOf("Persisted hook context")).toBeLessThan(
      stored.indexOf("call-1"),
    );
  });

  test("failed SDK runs retain context injected before the failed request", async () => {
    const model = new ScriptedModel([
      async () => {
        throw new Error("Model failed");
      },
    ]);
    let failure: unknown;
    try {
      await runOpenAIAgent(
        "request",
        options(model, {
          onBeforeModel: async () => [
            { role: "user", content: "Failure context" },
          ],
        }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenAIAgentRunError);
    expect(
      JSON.stringify((failure as OpenAIAgentRunError).partialResult.history),
    ).toContain("Failure context");
  });

  test("SDK Session stores persist injected context without duplicating it", async () => {
    const session = new MemorySession({ sessionId: "hook-session" });
    const result = await runOpenAIAgent(
      "request",
      options(new ScriptedModel([message("Final")]), {
        session,
        onBeforeModel: async () => [
          { role: "user", content: "Session hook context" },
        ],
      }),
    );
    expect(
      JSON.stringify(result.history).split("Session hook context"),
    ).toHaveLength(2);
    expect(
      JSON.stringify(await session.getItems()).split("Session hook context"),
    ).toHaveLength(2);
  });

  test("an omitted turn cap preserves runs beyond the SDK's default ten turns", async () => {
    const model = new ScriptedModel([
      ...Array.from({ length: 11 }, (_value, index) => call(index)),
      message("Finished all work"),
    ]);
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ value: z.string() }),
      execute: () => "ok",
    });
    const result = await runOpenAIAgent(
      "request",
      options(model, { tools: [echo], maxTurns: undefined }),
    );
    expect(result.finalOutput).toBe("Finished all work");
    expect(result.turns).toBe(12);
    expect(model.requests).toHaveLength(12);
  });

  test("invalid SDK tool arguments reach the model as an error without executing the tool", async () => {
    const invalid = response([
      {
        type: "function_call",
        name: "echo",
        callId: "invalid",
        arguments: '{"value":123}',
      },
    ]);
    const model = new ScriptedModel([invalid, message("Recovered input")]);
    let executions = 0;
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ value: z.string() }),
      execute: () => {
        executions++;
        return "should not execute";
      },
    });
    const result = await runOpenAIAgent(
      "request",
      options(model, { tools: [echo] }),
    );
    expect(executions).toBe(0);
    expect(result.finalOutput).toBe("Recovered input");
    expect(JSON.stringify(model.requests[1]?.input)).toContain("Error");
  });

  test("fallback continues the same SDK turn without replaying earlier tools", async () => {
    const primary = new ScriptedModel([
      call(1),
      async () => {
        throw Object.assign(new Error("Model unavailable"), { status: 503 });
      },
    ]);
    const fallback = new ScriptedModel([message("Recovered")]);
    let executions = 0;
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ value: z.string() }),
      execute: () => {
        executions++;
        return "saved-effect";
      },
    });
    const events: OpenAIAgentEvent[] = [];
    const result = await runOpenAIAgent(
      "request",
      options(primary, {
        fallbackModel: fallback,
        tools: [echo],
        maxTurns: 2,
        onEvent: (event) => events.push(event),
      }),
    );
    expect(result.finalOutput).toBe("Recovered");
    expect(result.turns).toBe(2);
    expect(executions).toBe(1);
    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(1);
    expect(JSON.stringify(fallback.requests[0]?.input)).toContain(
      "saved-effect",
    );
    expect(
      events.filter((event) => event.type === "model.fallback"),
    ).toHaveLength(1);
  });

  test("does not fallback for authentication or invalid model behavior", async () => {
    for (const error of [
      Object.assign(new Error("Unauthorized"), { status: 401 }),
      new Error("Invalid model response"),
    ]) {
      const primary = new ScriptedModel([
        async () => {
          throw error;
        },
      ]);
      const fallback = new ScriptedModel([message("Should not run")]);
      await expect(
        runOpenAIAgent(
          "request",
          options(primary, { fallbackModel: fallback }),
        ),
      ).rejects.toThrow(error.message);
      expect(fallback.requests).toHaveLength(0);
    }
  });

  test("reports the actual named fallback model for per-model accounting", async () => {
    const primary = new ScriptedModel([
      async () => {
        throw Object.assign(new Error("Unavailable"), { status: 503 });
      },
    ]);
    const fallback = new ScriptedModel([message("Recovered")]);
    const events: OpenAIAgentEvent[] = [];
    await runOpenAIAgent(
      "request",
      options(primary, {
        model: "primary-codex",
        fallbackModel: "fallback-codex",
        modelProvider: {
          getModel: (name) => (name === "primary-codex" ? primary : fallback),
        },
        onEvent: (event) => events.push(event),
      }),
    );
    const completed = events.find((event) => event.type === "model.response");
    expect(
      completed?.type === "model.response" && completed.activeModelName,
    ).toBe("fallback-codex");
  });

  test("Stop-block instructions continue within the same turn and usage limits", async () => {
    const model = new ScriptedModel([message("Candidate"), message("Final")]);
    const stops: boolean[] = [];
    const result = await runOpenAIAgent(
      "request",
      options(model, {
        maxTurns: 2,
        onSessionFinal: (candidate, context) => {
          stops.push(context.stopHookActive);
          return candidate.finalOutput === "Candidate"
            ? "Finish the requested validation"
            : undefined;
        },
      }),
    );
    expect(stops).toEqual([false, true]);
    expect(result.finalOutput).toBe("Final");
    expect(result.turns).toBe(2);
    expect(result.usage.inputTokens).toBe(20);
    expect(JSON.stringify(model.requests[1]?.input)).toContain(
      "Finish the requested validation",
    );
    expect(JSON.stringify(result.history)).toContain("Candidate");
  });

  test("Stop blocks cannot reset the original turn cap", async () => {
    const model = new ScriptedModel([
      message("Candidate"),
      message("Should not run"),
    ]);
    let failure: unknown;
    try {
      await runOpenAIAgent(
        "request",
        options(model, { maxTurns: 1, onSessionFinal: () => "Continue" }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenAIAgentRunError);
    expect((failure as OpenAIAgentRunError).message).toContain("1 turn limit");
    expect((failure as OpenAIAgentRunError).partialResult.turns).toBe(1);
    expect(model.requests).toHaveLength(1);
  });

  test("a budget callback failure still reports the model tokens already spent", async () => {
    let failure: unknown;
    try {
      await runOpenAIAgent(
        "request",
        options(new ScriptedModel([message("Unaccepted output")]), {
          onEvent: (event) => {
            if (event.type === "model.response")
              throw new Error("Budget exceeded");
          },
        }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenAIAgentRunError);
    const partial = (failure as OpenAIAgentRunError).partialResult;
    expect(partial.usage.inputTokens).toBe(10);
    expect(partial.usage.outputTokens).toBe(3);
    expect(JSON.stringify(partial.history)).not.toContain("Unaccepted output");
  });

  test("failed turn caps retain public SDK history without replaying committed tools", async () => {
    let executions = 0;
    const echo = tool({
      name: "echo",
      description: "Echo",
      parameters: z.object({ value: z.string() }),
      execute: () => {
        executions++;
        return "committed-effect";
      },
    });
    let failure: unknown;
    try {
      await runOpenAIAgent(
        "request",
        options(new ScriptedModel([call(1)]), {
          tools: [echo],
          maxTurns: 1,
          sessionId: "failed-session",
        }),
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenAIAgentRunError);
    const partial = (failure as OpenAIAgentRunError).partialResult;
    expect(partial.sessionId).toBe("failed-session");
    expect(JSON.stringify(partial.history)).toContain("committed-effect");
    const resumed = new ScriptedModel([message("Resumed")]);
    await runOpenAIAgent(
      partial.history,
      options(resumed, { tools: [echo], sessionId: partial.sessionId }),
    );
    expect(executions).toBe(1);
    expect(JSON.stringify(resumed.requests[0]?.input)).toContain(
      "committed-effect",
    );
  });

  test("parses SDK structured output and applies the caller's schema validator", async () => {
    const schema = {
      type: "object" as const,
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false as const,
    };
    const model = new ScriptedModel([message('{"ok":true}')]);
    const output = await runOpenAIAgent(
      "request",
      options(model, {
        schema,
        validateOutput: (value) => {
          z.object({ ok: z.boolean() }).strict().parse(value);
        },
      }),
    );
    expect(output.finalOutput).toEqual({ ok: true });
    expect(model.requests[0]?.outputType).toMatchObject({
      type: "json_schema",
      strict: false,
    });
    const invalid = new ScriptedModel([message('{"ok":"wrong"}')]);
    await expect(
      runOpenAIAgent(
        "request",
        options(invalid, {
          schema,
          validateOutput: (value) => {
            z.object({ ok: z.boolean() }).parse(value);
          },
        }),
      ),
    ).rejects.toThrow();
    const malformed = new ScriptedModel([message("not JSON")]);
    await expect(
      runOpenAIAgent("request", options(malformed, { schema })),
    ).rejects.toThrow();
  });

  test("continues stored input history and retains an explicit session identifier", async () => {
    const first = await runOpenAIAgent(
      "First request",
      options(new ScriptedModel([message("First answer")]), {
        sessionId: "saved-session",
      }),
    );
    const model = new ScriptedModel([message("Second answer")]);
    const history: AgentInputItem[] = [
      ...first.history,
      { role: "user", content: "Second request" },
    ];
    const second = await runOpenAIAgent(
      history,
      options(model, { sessionId: first.sessionId }),
    );
    expect(second.sessionId).toBe("saved-session");
    expect(second.history).toHaveLength(4);
    expect(JSON.stringify(model.requests[0]?.input)).toContain("First answer");
    expect(JSON.stringify(model.requests[0]?.input)).toContain(
      "Second request",
    );
  });

  test("supports the SDK Session contract for history retrieval and persistence", async () => {
    const session = new MemorySession({
      sessionId: "session-contract",
      initialItems: [{ role: "user", content: "Stored request" }],
    });
    const model = new ScriptedModel([message("Current answer")]);
    const result = await runOpenAIAgent(
      "Current request",
      options(model, { session }),
    );
    expect(result.sessionId).toBe("session-contract");
    expect(JSON.stringify(model.requests[0]?.input)).toContain(
      "Stored request",
    );
    expect(JSON.stringify(await session.getItems())).toContain(
      "Current answer",
    );
  });

  test("cancels an active SDK request and never starts fallback", async () => {
    const controller = new AbortController();
    const model = new ScriptedModel([
      async (request) => {
        controller.abort();
        expect(request.signal?.aborted).toBe(true);
        throw Object.assign(new Error("Aborted"), { status: 503 });
      },
    ]);
    const fallback = new ScriptedModel([message("Should not run")]);
    await expect(
      runOpenAIAgent(
        "request",
        options(model, { signal: controller.signal, fallbackModel: fallback }),
      ),
    ).rejects.toThrow("cancelled");
    expect(fallback.requests).toHaveLength(0);
  });

  test("the deadline aborts the SDK signal even when a model ignores cancellation", async () => {
    let signal: AbortSignal | undefined;
    const model = new ScriptedModel([
      async (request) => {
        signal = request.signal;
        return new Promise<ModelResponse>(() => {});
      },
    ]);
    await expect(
      runOpenAIAgent("request", options(model, { deadline: Date.now() + 100 })),
    ).rejects.toThrow("timed out");
    expect(signal?.aborted).toBe(true);
  });

  test("validates turn limits and stops already cancelled or expired requests before the model", async () => {
    const model = new ScriptedModel([message("Should not run")]);
    await expect(
      runOpenAIAgent("request", options(model, { maxTurns: 0 })),
    ).rejects.toThrow("positive integer");
    const controller = new AbortController();
    controller.abort();
    await expect(
      runOpenAIAgent("request", options(model, { signal: controller.signal })),
    ).rejects.toThrow("cancelled");
    await expect(
      runOpenAIAgent("request", options(model, { deadline: Date.now() - 1 })),
    ).rejects.toThrow("timed out");
    expect(model.requests).toHaveLength(0);
  });
});
