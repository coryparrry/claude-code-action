import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import {
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodex, type CodexOptions } from "../src/run-codex";

type Reply =
  | ModelResponse
  | ((request: ModelRequest) => Promise<ModelResponse>);

/** Real Agents SDK orchestration with a deterministic, offline model boundary. */
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
    throw new Error("This fixture exercises the non-streaming SDK run");
  }
}

function response(output: ModelResponse["output"]): ModelResponse {
  return {
    output,
    usage: new Usage({ requests: 1, inputTokens: 8, outputTokens: 2 }),
  };
}

function message(text = "Finished"): ModelResponse {
  return response([
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ]);
}

let callIndex = 0;
function call(name: string, args: Record<string, unknown>): ModelResponse {
  return response([
    {
      type: "function_call",
      name,
      callId: `runtime-call-${++callIndex}`,
      arguments: JSON.stringify(args),
      status: "completed",
    },
  ]);
}

function permissionAllowHook() {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
  return {
    PreToolUse: [
      {
        hooks: [
          {
            type: "command",
            command: process.execPath,
            args: [
              "-e",
              `process.stdout.write(${JSON.stringify(JSON.stringify(output))})`,
            ],
          },
        ],
      },
    ],
  };
}

const directories: string[] = [];
let directory: string;
let prompt: string;
let savedEnv: NodeJS.ProcessEnv;
let info: ReturnType<typeof spyOn>;
let secret: ReturnType<typeof spyOn>;
let logs: ReturnType<typeof spyOn>;

beforeEach(async () => {
  savedEnv = { ...process.env };
  directory = await realpath(await mkdtemp(join(tmpdir(), "runtime-parity-")));
  directories.push(directory);
  prompt = join(directory, "prompt.txt");
  await writeFile(prompt, "Offline runtime parity prompt");
  process.env.OPENAI_API_KEY = "runtime-parity-test-key";
  process.env.RUNNER_TEMP = directory;
  process.env.HOME = directory;
  info = spyOn(core, "info").mockImplementation(() => {});
  secret = spyOn(core, "setSecret").mockImplementation(() => {});
  logs = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  process.env = savedEnv;
  info.mockRestore();
  secret.mockRestore();
  logs.mockRestore();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function options(
  model: Model,
  extra: Partial<CodexOptions> = {},
): CodexOptions {
  return {
    model,
    workspace: directory,
    configurationHome: directory,
    mcpConfig: JSON.stringify({ mcpServers: {} }),
    settingSources: [],
    timeoutMs: 3000,
    permissionMode: "bypassPermissions",
    ...extra,
  };
}

describe("runtime parity controls", () => {
  test("JSON schema output preserves optional properties and still validates required fields", async () => {
    const schema = {
      type: "object",
      properties: {
        is_flaky: { type: "boolean" },
        summary: { type: "string" },
      },
      required: ["is_flaky"],
    };
    const model = new ScriptedModel([message('{"is_flaky":false}')]);
    const result = await runCodex(
      prompt,
      options(model, {
        compatibilityArgs: `--json-schema '${JSON.stringify(schema)}'`,
      }),
    );
    expect(model.requests[0]?.outputType).toMatchObject({
      type: "json_schema",
      strict: false,
      schema,
    });
    expect(result.structuredOutput).toEqual({ is_flaky: false });
    await expect(
      runCodex(
        prompt,
        options(
          new ScriptedModel([message('{"summary":"missing required field"}')]),
          {
            compatibilityArgs: `--json-schema '${JSON.stringify(schema)}'`,
          },
        ),
      ),
    ).rejects.toThrow("Structured output did not match JSON schema");
  });

  test("hooks observe permission mode changes when entering and exiting planning", async () => {
    const model = new ScriptedModel([
      call("EnterPlanMode", {}),
      call("Read", { file_path: "prompt.txt" }),
      call("ExitPlanMode", { plan: "Continue with the approved work" }),
      message("Finished"),
    ]);
    const hook = {
      type: "command",
      command: process.execPath,
      args: [
        "-e",
        'let input="";process.stdin.on("data",data=>input+=data);process.stdin.on("end",()=>{const event=JSON.parse(input);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:event.hook_event_name,additionalContext:`Mode after ${event.tool_name}: ${event.permission_mode}`}}));});',
      ],
    };
    await runCodex(
      prompt,
      options(model, {
        allowedTools: ["ExitPlanMode"],
        settings: JSON.stringify({
          hooks: { PostToolUse: [{ hooks: [hook] }] },
        }),
      }),
    );
    expect(JSON.stringify(model.requests[1]?.input)).toContain(
      "Mode after EnterPlanMode: plan",
    );
    expect(JSON.stringify(model.requests[2]?.input)).toContain(
      "Mode after Read: plan",
    );
    expect(JSON.stringify(model.requests[3]?.input)).toContain(
      "Mode after ExitPlanMode: bypassPermissions",
    );
  });

  for (const nested of [false, true]) {
    for (const permissionMode of ["dontAsk", "bypassPermissions"]) {
      for (const name of ["Bash", "Read"]) {
        test(`${nested ? "Task" : "selected"} agents enforce ${name} scopes despite broad parent grants, ${permissionMode} and hook approval`, async () => {
          const agentDirectory = join(directory, ".codex", "agents");
          await mkdir(agentDirectory, { recursive: true });
          await writeFile(
            join(agentDirectory, "scoped-shell.md"),
            `---\ntools: ["${name}(${name === "Bash" ? "cat:*" : "src/**"})"]\n---\nRead the permitted fixture.`,
          );
          await mkdir(join(directory, "src"));
          await writeFile(join(directory, "fixture.txt"), "scoped shell works");
          await writeFile(
            join(directory, "src", "fixture.txt"),
            "scoped read works",
          );
          if (name === "Read")
            await writeFile(
              join(directory, "forbidden.txt"),
              "outside-scope-secret",
            );
          const model = new ScriptedModel([
            ...(nested
              ? [
                  call("Task", {
                    subagent_type: "scoped-shell",
                    prompt: "Read fixture",
                  }),
                ]
              : []),
            call(
              name,
              name === "Bash"
                ? { command: "cat fixture.txt" }
                : { file_path: "src/fixture.txt" },
            ),
            call(
              name,
              name === "Bash"
                ? { command: "touch forbidden.txt" }
                : { file_path: "forbidden.txt" },
            ),
            message("Agent finished"),
            ...(nested ? [message("Parent finished")] : []),
          ]);
          await runCodex(
            prompt,
            options(model, {
              permissionMode,
              allowedTools: ["Bash", "Read", "Task"],
              settings: JSON.stringify({ hooks: permissionAllowHook() }),
              settingSources: ["project"],
              ...(nested ? {} : { agentName: "scoped-shell" }),
            }),
          );
          const firstChildRequest = nested ? 1 : 0;
          expect(
            model.requests[firstChildRequest]?.tools.map((tool) => tool.name),
          ).toEqual([name]);
          expect(
            JSON.stringify(model.requests[firstChildRequest + 1]?.input),
          ).toContain(
            name === "Bash" ? "scoped shell works" : "scoped read works",
          );
          expect(
            JSON.stringify(model.requests[firstChildRequest + 2]?.input),
          ).toContain("outside configured agent scope");
          if (name === "Bash")
            expect(
              await Bun.file(join(directory, "forbidden.txt")).exists(),
            ).toBe(false);
          else
            expect(
              JSON.stringify(model.requests[firstChildRequest + 2]?.input),
            ).not.toContain("outside-scope-secret");
        });
      }
    }
  }

  test("native disabled controls remove matching tools while preserving MCP tools", async () => {
    const mcpPath = join(import.meta.dir, "mcp-test", "simple-mcp-server.ts");
    const model = new ScriptedModel([
      call("mcp__fixture__test_tool", {}),
      message("MCP result preserved"),
    ]);
    await runCodex(
      prompt,
      options(model, {
        settings: JSON.stringify({
          web_search: "disabled",
          features: {
            shell_tool: false,
            unified_exec: false,
            apply_patch_freeform: false,
          },
        }),
        mcpConfig: JSON.stringify({
          mcpServers: {
            fixture: { command: process.execPath, args: [mcpPath] },
          },
        }),
      }),
    );

    const names = model.requests[0]?.tools.map((tool) => tool.name) ?? [];
    for (const disabled of [
      "WebSearch",
      "Bash",
      "BashOutput",
      "KillShell",
      "Edit",
    ])
      expect(names).not.toContain(disabled);
    expect(names).toContain("Read");
    expect(names).toContain("mcp__fixture__test_tool");
    expect(JSON.stringify(model.requests[1]?.input)).toContain(
      "Test tool response",
    );
  });

  test("model verbosity and reasoning summary reach the actual SDK model request", async () => {
    const model = new ScriptedModel([message()]);
    await runCodex(
      prompt,
      options(model, {
        settings: JSON.stringify({
          model_verbosity: "high",
          model_reasoning_summary: "detailed",
        }),
      }),
    );
    expect((model.requests[0]?.modelSettings as any).verbosity).toBe("high");
    expect(model.requests[0]?.modelSettings.reasoning).toMatchObject({
      summary: "detailed",
    });
  });

  test("cached web search disables external access on the hosted search request", async () => {
    const model = new ScriptedModel([
      call("WebSearch", { query: "fixture query" }),
      message("Search summary"),
      message("Finished"),
    ]);
    await runCodex(
      prompt,
      options(model, {
        settings: JSON.stringify({ web_search: "cached" }),
      }),
    );
    expect(model.requests).toHaveLength(3);
    const hostedTools = model.requests[1]?.tools ?? [];
    expect(hostedTools.length).toBeGreaterThan(0);
    expect(hostedTools[0]).toMatchObject({
      type: "hosted_tool",
      providerData: { external_web_access: false },
    });
  });

  test("invalid native settings fail before an SDK model request", async () => {
    const model = new ScriptedModel([message()]);
    await expect(
      runCodex(
        prompt,
        options(model, {
          settings: JSON.stringify({ model_verbosity: "maximum" }),
        }),
      ),
    ).rejects.toThrow("Invalid native setting: model_verbosity");
    expect(model.requests).toHaveLength(0);
  });

  for (const scope of ["project", "local"] as const) {
    for (const fixture of [
      { rule: "Write(.claude/**)", action: "append" as const, denied: "Write" },
      {
        rule: "Write(**/MEMORY.md)",
        action: "append" as const,
        denied: "Write",
      },
      {
        rule: "AgentMemory(.claude/**)",
        action: "append" as const,
        denied: "AgentMemory",
      },
      {
        rule: "Read(.claude/**)",
        action: "read" as const,
        denied: "Read",
      },
    ]) {
      test(`${scope} memory honors scoped ${fixture.rule} deny with bypass mode and an allow hook`, async () => {
        const name = `memory-${scope}-${fixture.denied.toLowerCase()}-${fixture.action}`;
        const agentDirectory = join(directory, ".codex", "agents");
        await mkdir(agentDirectory, { recursive: true });
        await writeFile(
          join(agentDirectory, `${name}.md`),
          `---\nmemory: ${scope}\ntools: [AgentMemory]\n---\nKeep scoped memory access controlled`,
        );

        const memoryDirectory =
          scope === "project"
            ? join(directory, ".claude", "agent-memory", name)
            : join(directory, ".claude", "agent-memory.local", name);
        const memoryFile = join(memoryDirectory, "MEMORY.md");
        if (fixture.action === "read") {
          await mkdir(memoryDirectory, { recursive: true });
          await writeFile(memoryFile, "preexisting private note\n");
        }

        const model = new ScriptedModel([
          call("Task", {
            subagent_type: name,
            prompt: `Try to ${fixture.action} scoped memory`,
          }),
          call("AgentMemory", {
            action: fixture.action,
            ...(fixture.action === "append"
              ? { content: "must be denied" }
              : {}),
          }),
          message("Child finished"),
          message("Parent finished"),
        ]);

        await runCodex(
          prompt,
          options(model, {
            permissionMode: "bypassPermissions",
            disallowedTools: [fixture.rule],
            settings: JSON.stringify({ hooks: permissionAllowHook() }),
            modelProvider: { getModel: () => model },
            settingSources: ["project"],
          }),
        );

        expect(model.requests).toHaveLength(4);
        const childToolResult = JSON.stringify(model.requests[2]?.input);
        expect(childToolResult).toContain(
          `Tool permission denied: ${fixture.denied}`,
        );
        if (fixture.action === "read") {
          expect(model.requests[1]?.systemInstructions).not.toContain(
            "preexisting private note",
          );
          expect(childToolResult).not.toContain("preexisting private note");
        } else {
          expect(await Bun.file(memoryFile).exists()).toBe(false);
        }
      });
    }
  }
});
