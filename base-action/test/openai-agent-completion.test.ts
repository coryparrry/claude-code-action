import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import {
  MemorySession,
  Usage,
  tool,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  OpenAIAgentRunError,
  runOpenAIAgent,
  type OpenAIAgentOptions,
} from "../src/openai-agent-runner";
import { runCodex } from "../src/run-codex";

type Reply =
  | ModelResponse
  | ((request: ModelRequest) => Promise<ModelResponse>);
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
    throw new Error("This fixture uses the nonstreaming SDK loop");
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
function options(
  model: Model,
  extra: Partial<OpenAIAgentOptions> = {},
): OpenAIAgentOptions {
  return {
    apiKey: "offline-api-key",
    instructions: "Review the pull request",
    model,
    tools: [],
    maxTurns: 5,
    deadline: Date.now() + 5000,
    ...extra,
  };
}

describe("empty final response recovery with the real Agents SDK", () => {
  test.each(["", " \n\t"])(
    "requests a final summary after %j without repeating completed tools",
    async (blank) => {
      const model = new ScriptedModel([
        response([
          {
            type: "function_call",
            name: "post_review",
            callId: "posted-review",
            arguments: "{}",
          },
        ]),
        message(blank),
        message("Review complete. No actionable findings."),
      ]);
      let posts = 0;
      const stop = spyOn({ finish: () => undefined }, "finish");
      const validate = spyOn({ output: () => undefined }, "output");
      const result = await runOpenAIAgent(
        "Review this PR",
        options(model, {
          maxTurns: 3,
          tools: [
            tool({
              name: "post_review",
              description: "Post review feedback",
              parameters: z.object({}),
              execute: () => {
                posts++;
                return "Review posted successfully";
              },
            }),
          ],
          onSessionFinal: stop,
          validateOutput: validate,
        }),
      );
      expect(result.finalOutput).toBe(
        "Review complete. No actionable findings.",
      );
      expect(posts).toBe(1);
      expect(result.turns).toBe(3);
      expect(result.usage.requests).toBe(3);
      expect(result.usage.inputTokens).toBe(30);
      expect(model.requests).toHaveLength(3);
      expect(JSON.stringify(model.requests[2]?.input)).toContain(
        "Review posted successfully",
      );
      expect(stop).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(1);
    },
  );

  test("a second empty completion fails with the full history and usage", async () => {
    const model = new ScriptedModel([message(""), message(" \n")]);
    let failure: unknown;
    try {
      await runOpenAIAgent("Review this PR", options(model));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenAIAgentRunError);
    const error = failure as OpenAIAgentRunError;
    expect(error.message).toContain("final assistant message");
    expect(model.requests).toHaveLength(2);
    expect(error.partialResult.turns).toBe(2);
    expect(error.partialResult.usage.inputTokens).toBe(20);
    expect(JSON.stringify(error.partialResult.history)).toContain(
      JSON.stringify(" \n"),
    );
  });

  test("completion recovery cannot reset the turn cap", async () => {
    const model = new ScriptedModel([message(""), message("Should not run")]);
    await expect(
      runOpenAIAgent("Review this PR", options(model, { maxTurns: 1 })),
    ).rejects.toThrow("1 turn limit");
    expect(model.requests).toHaveLength(1);
  });

  test("session continuation retains history without duplicating its request", async () => {
    const session = new MemorySession({ sessionId: "completion-recovery" });
    const model = new ScriptedModel([message(""), message("Review complete")]);
    const result = await runOpenAIAgent(
      "Review this PR",
      options(model, { session }),
    );
    expect(result.finalOutput).toBe("Review complete");
    expect(result.turns).toBe(2);
    const stored = await session.getItems();
    expect(
      stored.filter((item) => "role" in item && item.role === "user"),
    ).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]?.input)).toContain(
      "Review this PR",
    );
  });

  test.each(["deadline", "cancellation"])(
    "completion recovery retains the original %s",
    async (interruption) => {
      const controller = new AbortController();
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const model = new ScriptedModel([
        message(""),
        async () => {
          ready();
          return new Promise<ModelResponse>(() => {});
        },
      ]);
      const outcome = runOpenAIAgent(
        "Review this PR",
        options(model, {
          signal: controller.signal,
          deadline: Date.now() + 1000,
        }),
      ).catch((error: unknown) => error);
      await started;
      if (interruption === "cancellation") controller.abort();
      const error = await outcome;
      expect(error).toBeInstanceOf(OpenAIAgentRunError);
      expect((error as Error).message).toContain(
        interruption === "deadline" ? "timed out" : "cancelled",
      );
      expect(model.requests).toHaveLength(2);
      expect(
        (error as OpenAIAgentRunError).partialResult.usage.inputTokens,
      ).toBe(10);
    },
  );

  test("a Stop hook can authorize new tool work after tool-free completion recovery", async () => {
    const model = new ScriptedModel([
      message(""),
      message("Review complete"),
      response([
        {
          type: "function_call",
          name: "post_review",
          callId: "new-work",
          arguments: "{}",
        },
      ]),
      message("Additional review complete"),
    ]);
    let posts = 0;
    let stops = 0;
    const result = await runOpenAIAgent(
      "Review this PR",
      options(model, {
        maxTurns: 4,
        tools: [
          tool({
            name: "post_review",
            description: "Post feedback",
            parameters: z.object({}),
            execute: () => {
              posts++;
              return "Posted additional feedback";
            },
          }),
        ],
        onSessionFinal: () =>
          ++stops === 1 ? "Post the additional requested feedback" : undefined,
      }),
    );
    expect(result.finalOutput).toBe("Additional review complete");
    expect(posts).toBe(1);
    expect(stops).toBe(2);
    expect(model.requests[1]?.tools).toHaveLength(0);
    expect(model.requests[2]?.tools.map((tool) => tool.name)).toContain(
      "post_review",
    );
  });
});

describe("action completion integration", () => {
  let directory: string;
  let savedEnv: NodeJS.ProcessEnv;
  let info: ReturnType<typeof spyOn>;
  let secrets: ReturnType<typeof spyOn>;
  let logs: ReturnType<typeof spyOn>;
  beforeEach(async () => {
    savedEnv = { ...process.env };
    directory = await mkdtemp(join(tmpdir(), "codex-completion-test-"));
    process.env.OPENAI_API_KEY = "offline-action-key";
    process.env.RUNNER_TEMP = directory;
    info = spyOn(core, "info").mockImplementation(() => {});
    secrets = spyOn(core, "setSecret").mockImplementation(() => {});
    logs = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    process.env = savedEnv;
    info.mockRestore();
    secrets.mockRestore();
    logs.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  test("the action writes a successful execution result after completion recovery", async () => {
    const prompt = join(directory, "prompt.txt");
    await writeFile(prompt, "Review this PR");
    const model = new ScriptedModel([message(""), message("Review complete")]);
    const result = await runCodex(prompt, {
      mcpConfig: '{"mcpServers":{}}',
      model,
      workspace: directory,
      configurationHome: directory,
      settingSources: [],
      timeoutMs: 5000,
    });
    expect(result.conclusion).toBe("success");
    const artifact = JSON.parse(await readFile(result.executionFile!, "utf8"));
    expect(artifact.at(-1).is_error).toBe(false);
    expect(artifact.at(-1).result).toBe("Review complete");
    expect(artifact.at(-1).num_turns).toBe(2);
    expect(artifact.at(-1).usage.input_tokens).toBe(20);
  });
});
