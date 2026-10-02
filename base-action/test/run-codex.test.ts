import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import {
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ModelProvider,
} from "@openai/agents";
import {
  mkdir,
  readdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  runCodex,
  resolveCodexModel,
  type CodexOptions,
} from "../src/run-codex";
import { agentSessionDirectory } from "../src/agent-sessions";

const API_KEY = "unit-test-api-value-only",
  GITHUB_TOKEN = "unit-test-github-value-only";
const subagentWorktrees: string[] = [];
type Reply =
  | ModelResponse
  | ((request: ModelRequest) => Promise<ModelResponse>);
class ScriptedModel implements Model {
  readonly requests: ModelRequest[] = [];
  constructor(private replies: Reply[]) {}
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const reply = this.replies[this.requests.length - 1];
    if (!reply) throw new Error("Unexpected model request");
    return typeof reply === "function" ? reply(request) : reply;
  }
  async *getStreamedResponse(): AsyncGenerator<never> {
    throw new Error("Nonstreaming fixture");
  }
}
function message(text = "Done", inputTokens = 10): ModelResponse {
  return {
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: new Usage({ requests: 1, inputTokens, outputTokens: 3 }),
  };
}
function call(
  name: string,
  input: Record<string, unknown>,
  id = "call-test-1",
): ModelResponse {
  return {
    output: [
      {
        type: "function_call",
        name,
        callId: id,
        arguments: JSON.stringify(input),
        status: "completed",
      },
    ],
    usage: new Usage({ requests: 1, inputTokens: 10, outputTokens: 3 }),
  };
}
const bashInput = (command: string) => ({
  command,
  timeout: null,
  run_in_background: null,
  description: null,
});

// The SDK Agent/Runner/tool loop is real; only its model response boundary is offline.
describe("Codex Agents SDK integration", () => {
  let directory: string, prompt: string, savedEnv: NodeJS.ProcessEnv;
  let info: ReturnType<typeof spyOn>,
    secret: ReturnType<typeof spyOn>,
    logs: ReturnType<typeof spyOn>;
  beforeEach(async () => {
    savedEnv = { ...process.env };
    directory = await realpath(
      await mkdtemp(join(tmpdir(), "codex-sdk-test-")),
    );
    prompt = join(directory, "prompt.txt");
    await writeFile(prompt, "Generated GitHub context");
    process.env.OPENAI_API_KEY = API_KEY;
    process.env.RUNNER_TEMP = directory;
    process.env.HOME = directory;
    process.env.GITHUB_TOKEN = GITHUB_TOKEN;
    process.env.ACTIONS_RUNTIME_TOKEN = "actions-secret-test-only";
    info = spyOn(core, "info").mockImplementation(() => {});
    secret = spyOn(core, "setSecret").mockImplementation(() => {});
    logs = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    process.env = savedEnv;
    info.mockRestore();
    secret.mockRestore();
    logs.mockRestore();
    for (const path of subagentWorktrees.splice(0)) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", "--", path], {
          cwd: directory,
        });
        const branch = execFileSync(
          "git",
          ["branch", "--list", "codex-agent/*"],
          {
            cwd: directory,
            encoding: "utf8",
          },
        )
          .trim()
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean);
        for (const name of branch)
          execFileSync("git", ["branch", "-D", "--", name], {
            cwd: directory,
            stdio: "ignore",
          });
      } catch {
        // The fixture may have failed before creating or retaining a worktree.
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  function options(
    model: Model,
    extra: Partial<CodexOptions> = {},
  ): CodexOptions {
    return {
      mcpConfig: '{"mcpServers":{}}',
      model,
      workspace: directory,
      configurationHome: directory,
      timeoutMs: 3000,
      settingSources: [],
      ...extra,
    };
  }
  async function artifact(): Promise<Record<string, any>[]> {
    return JSON.parse(
      await readFile(join(directory, "codex-execution-output.json"), "utf8"),
    );
  }
  async function history(id: string): Promise<Record<string, any>> {
    return JSON.parse(
      await readFile(
        join(
          agentSessionDirectory(
            join(directory, "codex-action-sessions"),
            directory,
          ),
          `${id}.json`,
        ),
        "utf8",
      ),
    );
  }
  const hook = (event: string, output: unknown) => ({
    [event]: [
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
  });

  test("consumes context and sidecar with real SDK instructions at system priority", async () => {
    await writeFile(
      join(directory, "codex-user-request.txt"),
      "Review this PR",
    );
    const model = new ScriptedModel([message()]);
    const result = await runCodex(
      prompt,
      options(model, {
        systemPrompt: "Replacement system",
        appendSystemPrompt: "Additional system",
      }),
    );
    expect(result.conclusion).toBe("success");
    expect(result.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(model.requests[0]?.systemInstructions).toContain(
      "Replacement system",
    );
    expect(model.requests[0]?.systemInstructions).toContain(
      "Additional system",
    );
    expect(JSON.stringify(model.requests[0]?.input)).toContain(
      "Generated GitHub context",
    );
    expect(JSON.stringify(model.requests[0]?.input)).toContain(
      "Review this PR",
    );
    expect(model.requests[0]?.tracing).toBe(false);
    expect(secret).toHaveBeenCalledWith(API_KEY);
    expect((await artifact()).at(-1)?.is_error).toBe(false);
    expect((await history(result.sessionId!)).history.length).toBeGreaterThan(
      0,
    );
  });

  test("loads project settings and AGENTS instructions through default source scopes", async () => {
    await mkdir(join(directory, ".codex"));
    await writeFile(
      join(directory, ".codex", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
    );
    await writeFile(
      join(directory, "AGENTS.md"),
      "Repository instruction fixture",
    );
    const model = new ScriptedModel([message()]);
    await runCodex(prompt, options(model, { settingSources: undefined }));
    expect(model.requests[0]?.systemInstructions).toContain(
      "Repository instruction fixture",
    );
  });

  test("rejects missing auth and unsupported sandbox before invoking model", async () => {
    const model = new ScriptedModel([message()]);
    await expect(
      runCodex(prompt, options(model, { sandbox: "danger-full-access" })),
    ).rejects.toThrow("read-only or workspace-write");
    delete process.env.OPENAI_API_KEY;
    await expect(runCodex(prompt, options(model))).rejects.toThrow(
      "OPENAI_API_KEY",
    );
    expect(model.requests).toHaveLength(0);
  });

  test("real Bash tool receives ordinary environment and trusted GH token without model auth or aliases", async () => {
    process.env.BUILD_LABEL = "build-fixture";
    process.env.AUTH_ALIAS = API_KEY;
    const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write(JSON.stringify({build:process.env.BUILD_LABEL,openai:process.env.OPENAI_API_KEY,alias:process.env.AUTH_ALIAS,actions:process.env.ACTIONS_RUNTIME_TOKEN,gh:!!process.env.GH_TOKEN}))'`;
    const model = new ScriptedModel([
      call("Bash", bashInput(command)),
      async (request) => {
        const input = JSON.stringify(request.input);
        expect(input).toContain("build-fixture");
        expect(input).toContain('\\"gh\\":true');
        expect(input).not.toContain(API_KEY);
        expect(input).not.toContain(GITHUB_TOKEN);
        expect(input).not.toContain("actions-secret-test-only");
        return message();
      },
    ]);
    await runCodex(
      prompt,
      options(model, {
        permissionMode: "bypassPermissions",
        githubEnvironment: { GH_TOKEN: GITHUB_TOKEN },
      }),
    );
    const report = JSON.stringify(await artifact());
    expect(report).not.toContain(API_KEY);
    expect(report).not.toContain(GITHUB_TOKEN);
    expect((await artifact()).some((turn) => turn.type === "user")).toBe(true);
  });

  test("PermissionRequest hook permits an otherwise unapproved shell and updates shared permissions", async () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: [
            {
              type: "addRules",
              behavior: "allow",
              destination: "session",
              rules: [{ toolName: "Bash", ruleContent: "printf:*" }],
            },
          ],
        },
      },
    };
    const model = new ScriptedModel([
      call("Bash", bashInput("printf first")),
      call("Bash", bashInput("printf second"), "call-2"),
      message(),
    ]);
    await runCodex(
      prompt,
      options(model, {
        settings: JSON.stringify({ hooks: hook("PermissionRequest", output) }),
      }),
    );
    expect(model.requests).toHaveLength(3);
    expect(JSON.stringify(model.requests[2]?.input)).toContain("second");
  });

  test("PostToolUse additional context appears before next actual SDK model turn", async () => {
    const hooks = hook("PostToolUse", {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "POST TOOL CONTEXT",
      },
    });
    const model = new ScriptedModel([
      call("Read", { file_path: prompt, offset: null, limit: null }),
      message(),
    ]);
    const result = await runCodex(
      prompt,
      options(model, { settings: JSON.stringify({ hooks }) }),
    );
    expect(JSON.stringify(model.requests[1]?.input)).toContain(
      "POST TOOL CONTEXT",
    );
    expect(
      JSON.stringify((await history(result.sessionId!)).history),
    ).toContain("POST TOOL CONTEXT");
  });

  test("Stop blocked hook continues without resetting main SDK turn limit", async () => {
    const hooks = hook("Stop", {
      decision: "block",
      reason: "Continue fixture",
    });
    const model = new ScriptedModel([
      message("First answer"),
      message("Second answer"),
    ]);
    await expect(
      runCodex(
        prompt,
        options(model, { maxTurns: 2, settings: JSON.stringify({ hooks }) }),
      ),
    ).rejects.toThrow("2 turn limit");
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]?.input)).toContain(
      "Continue fixture",
    );
    expect((await artifact()).at(-1)?.usage.input_tokens).toBe(20);
    expect((await artifact()).at(-1)?.session_id).toMatch(/^[a-f0-9-]{36}$/);
  });

  test("Stop continue false finishes instead of starting a continuation", async () => {
    const model = new ScriptedModel([message()]);
    await runCodex(
      prompt,
      options(model, {
        settings: JSON.stringify({
          hooks: hook("Stop", {
            continue: false,
            stopReason: "Finish fixture",
          }),
        }),
      }),
    );
    expect(model.requests).toHaveLength(1);
  });

  test("fallback uses named provider models without repeating completed tools", async () => {
    const primary = new ScriptedModel([
      async () => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      },
    ]);
    const fallback = new ScriptedModel([message("Fallback result")]);
    const names: string[] = [];
    const provider: ModelProvider = {
      getModel: (name) => {
        names.push(name ?? "gpt-6.1-sol");
        return name === "gpt-6.1-sol" ? primary : fallback;
      },
    };
    await runCodex(
      prompt,
      options(primary, {
        model: "sonnet",
        fallbackModel: "fallback-fixture",
        modelProvider: provider,
      }),
    );
    expect(names).toEqual(["gpt-6.1-sol", "fallback-fixture"]);
    expect((await artifact()).at(-1)?.result).toBe("Fallback result");
  });

  test("budget records the paid response usage and rejects before another SDK turn", async () => {
    const model = new ScriptedModel([
      call("Read", { file_path: prompt, offset: null, limit: null }),
      message(),
    ]);
    const provider: ModelProvider = { getModel: () => model };
    await expect(
      runCodex(
        prompt,
        options(model, {
          model: "gpt-5.3-codex",
          modelProvider: provider,
          maxBudgetUsd: 0.000001,
        }),
      ),
    ).rejects.toThrow("USD budget");
    expect(model.requests).toHaveLength(1);
    const final = (await artifact()).at(-1)!;
    expect(final.usage.input_tokens).toBe(10);
    expect(final.total_cost_usd).toBeGreaterThan(0);
  });

  test("workflow settings supply custom model prices and unpriced requests fail before running", async () => {
    const model = new ScriptedModel([message()]);
    await expect(
      runCodex(
        prompt,
        options(model, {
          model: "custom-fixture",
          modelProvider: { getModel: () => model },
          maxBudgetUsd: 1,
        }),
      ),
    ).rejects.toThrow("configured token prices");
    expect(model.requests).toHaveLength(0);
    await runCodex(
      prompt,
      options(model, {
        model: "custom-fixture",
        modelProvider: { getModel: () => model },
        maxBudgetUsd: 1,
        settings: JSON.stringify({
          modelPrices: {
            "custom-fixture": { input: 1, cachedInput: 0.1, output: 1 },
          },
        }),
      }),
    );
    expect(model.requests).toHaveLength(1);
    expect((await artifact()).at(-1)?.total_cost_usd).toBeCloseTo(0.000013, 10);
  });

  test("stable sessions resume sanitized history after success", async () => {
    const first = new ScriptedModel([message(`First answer ${API_KEY}`)]);
    const initial = await runCodex(prompt, options(first));
    const next = new ScriptedModel([message("Next answer")]);
    const resumed = await runCodex(
      prompt,
      options(next, { resumeSession: initial.sessionId }),
    );
    expect(resumed.sessionId).toBe(initial.sessionId!);
    const input = JSON.stringify(next.requests[0]?.input);
    expect(input).toContain("First answer");
    expect(input).toContain("[REDACTED]");
    expect(input).not.toContain(API_KEY);
    expect(JSON.stringify(await history(initial.sessionId!))).not.toContain(
      API_KEY,
    );
  });

  test("failed SDK calls persist partial usage/session/history and exact-secret redaction", async () => {
    const model = new ScriptedModel([
      call("Read", { file_path: prompt, offset: null, limit: null }),
      async () => {
        throw new Error(`Failure ${API_KEY} ${GITHUB_TOKEN}`);
      },
    ]);
    await expect(
      runCodex(prompt, options(model, { showFullOutput: "true" })),
    ).rejects.toThrow("Failure [REDACTED]");
    const report = await artifact(),
      final = report.at(-1)!;
    expect(final.is_error).toBe(true);
    expect(final.usage.input_tokens).toBe(10);
    expect(final.num_turns).toBe(2);
    expect((await history(final.session_id)).history.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain(API_KEY);
    expect(JSON.stringify(info.mock.calls)).not.toContain(API_KEY);
  });

  test("deadline stops a stalled model and still saves a failure report", async () => {
    const model = new ScriptedModel([
      async () => new Promise<ModelResponse>(() => {}),
    ]);
    await expect(
      runCodex(prompt, options(model, { timeoutMs: 100 })),
    ).rejects.toThrow("timed out");
    expect((await artifact()).at(-1)?.is_error).toBe(true);
  });

  test("caller cancellation interrupts a running actual SDK run", async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const model = new ScriptedModel([
      async () => {
        ready();
        return new Promise<ModelResponse>(() => {});
      },
    ]);
    const outcome = runCodex(
      prompt,
      options(model, { signal: controller.signal }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    await started;
    controller.abort();
    expect(((await outcome) as Error).message).toContain("cancelled");
    expect((await artifact()).at(-1)?.is_error).toBe(true);
  });

  test("JSON schema is validated by Ajv and structured output is exposed", async () => {
    const schema = {
      type: "object",
      properties: { result: { type: "boolean" } },
      required: ["result"],
      additionalProperties: false,
    };
    const model = new ScriptedModel([message('{"result":false}')]);
    const result = await runCodex(
      prompt,
      options(model, {
        compatibilityArgs: `--json-schema '${JSON.stringify(schema)}'`,
      }),
    );
    expect(result.structuredOutput).toEqual({ result: false });
    const invalid = new ScriptedModel([message('{"result":"invalid"}')]);
    await expect(
      runCodex(
        prompt,
        options(invalid, {
          compatibilityArgs: `--json-schema '${JSON.stringify(schema)}'`,
        }),
      ),
    ).rejects.toThrow();
  });

  test("model aliases select the documented default", () => {
    expect(resolveCodexModel("opus")).toBe("gpt-6-astra");
    expect(resolveCodexModel(undefined)).toBe("gpt-6-luna");
    expect(resolveCodexModel("gpt-fixture")).toBe("gpt-fixture");
  });

  test("nested Task budget exhaustion aborts the parent before a third model request", async () => {
    const model = new ScriptedModel([
      call("Task", {
        subagent_type: "general-purpose",
        prompt: "Nested fixture",
        description: null,
        model: null,
        max_turns: null,
        run_in_background: null,
      }),
      message("Nested result", 10000),
      message("Parent must not request this"),
    ]);
    await expect(
      runCodex(
        prompt,
        options(model, {
          model: "gpt-5.3-codex",
          modelProvider: { getModel: () => model },
          permissionMode: "bypassPermissions",
          maxBudgetUsd: 0.01,
        }),
      ),
    ).rejects.toThrow("USD budget");
    expect(model.requests).toHaveLength(2);
    expect((await artifact()).at(-1)?.usage.input_tokens).toBe(10010);
  });

  test("Task inherits repository and appended system instructions", async () => {
    await writeFile(join(directory, "AGENTS.md"), "AGENTS CHILD SENTINEL");
    const model = new ScriptedModel([
      call("Task", {
        subagent_type: "general-purpose",
        prompt: "Nested fixture",
        description: null,
        model: null,
        max_turns: null,
        run_in_background: null,
      }),
      message("Nested result"),
      message("Parent result"),
    ]);
    await runCodex(
      prompt,
      options(model, {
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
        appendSystemPrompt: "APPENDED CHILD SENTINEL",
      }),
    );
    expect(model.requests).toHaveLength(3);
    expect(model.requests[1]?.systemInstructions).toContain(
      "AGENTS CHILD SENTINEL",
    );
    expect(model.requests[1]?.systemInstructions).toContain(
      "APPENDED CHILD SENTINEL",
    );
  });

  test("resumes a Task with its prior transcript and the same agent identity", async () => {
    await mkdir(join(directory, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(directory, ".codex", "agents", "reviewer.md"),
      "---\ntools: [Read]\n---\nStable reviewer identity",
    );
    const first = new ScriptedModel([
      call("Task", {
        subagent_type: "reviewer",
        prompt: "Inspect the first file",
      }),
      message(`Remember that the first file has a race. ${API_KEY}`),
      message("First parent turn"),
    ]);
    const sessionStoragePath = join(directory, "agent-sessions");
    const settings = {
      ...options(first, {
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        modelProvider: { getModel: () => first },
        sessionStoragePath,
      }),
    };
    await runCodex(prompt, settings);
    expect(first.requests).toHaveLength(3);
    const checkpointDirectory = agentSessionDirectory(
      sessionStoragePath,
      directory,
    );
    const checkpointFile = (await readdir(checkpointDirectory)).find((file) =>
      file.startsWith("subagent-"),
    );
    const id = checkpointFile?.slice("subagent-".length, -".json".length);
    expect(id).toBeDefined();
    const savedCheckpoint = JSON.parse(
      await readFile(join(checkpointDirectory, checkpointFile!), "utf8"),
    );
    expect(JSON.stringify(savedCheckpoint)).not.toContain(API_KEY);

    const second = new ScriptedModel([
      call("Task", {
        subagent_type: "reviewer",
        prompt: "Now inspect the related file",
        resume_task_id: id,
      }),
      message("The related file confirms the race."),
      message("Second parent turn"),
    ]);
    await runCodex(
      prompt,
      options(second, {
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        modelProvider: { getModel: () => second },
        sessionStoragePath,
      }),
    );
    expect(second.requests).toHaveLength(3);
    expect(second.requests[1]?.systemInstructions).toContain(
      "Stable reviewer identity",
    );
    expect(JSON.stringify(second.requests[1]?.input)).toContain(
      "Remember that the first file has a race.",
    );
    expect(JSON.stringify(second.requests[1]?.input)).not.toContain(API_KEY);
    expect(JSON.stringify(second.requests[1]?.input)).toContain(
      "Now inspect the related file",
    );
  });

  test("runs isolated agent writes in a real worktree and reports its path", async () => {
    await mkdir(join(directory, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(directory, ".codex", "agents", "isolated.md"),
      "---\ntools: [Write]\nisolation: worktree\n---\nCreate the requested file",
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "agent@example.invalid"], {
      cwd: directory,
    });
    execFileSync("git", ["config", "user.name", "Agent Test"], {
      cwd: directory,
    });
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: directory });
    const model = new ScriptedModel([
      call("Task", { subagent_type: "isolated", prompt: "Create result.txt" }),
      call("Write", { file_path: "result.txt", content: "isolated output" }),
      message("Child finished"),
      message("Parent finished"),
    ]);
    await runCodex(
      prompt,
      options(model, {
        permissionMode: "bypassPermissions",
        modelProvider: { getModel: () => model },
        settingSources: ["project"],
      }),
    );
    expect(model.requests).toHaveLength(4);
    const parentInput = JSON.stringify(model.requests[3]?.input);
    const worktreePath = /\[Worktree: ([^\]]+)\]/.exec(parentInput)?.[1];
    expect(worktreePath).toBeDefined();
    subagentWorktrees.push(worktreePath!);
    expect(await Bun.file(join(directory, "result.txt")).exists()).toBe(false);
    expect(await readFile(join(worktreePath!, "result.txt"), "utf8")).toBe(
      "isolated output",
    );
  });

  test("lets a memory-enabled subagent save notes in its local memory scope", async () => {
    await mkdir(join(directory, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(directory, ".codex", "agents", "rememberer.md"),
      "---\nmemory: local\n---\nKeep useful notes for later runs",
    );
    const verifyMemoryHook = [
      "let input='';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "const event = JSON.parse(input);",
      "if (event.tool_name !== 'AgentMemory' || event.tool_input?.action !== 'append' || !event.tool_response?.includes('Agent memory saved.')) process.exit(1);",
      "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'AgentMemory PostToolUse observed'}}));",
      "});",
    ].join("");
    const model = new ScriptedModel([
      call("Task", {
        subagent_type: "rememberer",
        prompt: "Save this finding",
      }),
      call("AgentMemory", {
        action: "append",
        content: `The parser rejects empty frontmatter. ${API_KEY}`,
      }),
      message("Saved the finding"),
      message("Parent finished"),
    ]);
    await runCodex(
      prompt,
      options(model, {
        permissionMode: "bypassPermissions",
        modelProvider: { getModel: () => model },
        settingSources: ["project"],
        sessionStoragePath: join(directory, "agent-sessions"),
        settings: JSON.stringify({
          hooks: {
            PostToolUse: [
              {
                hooks: [
                  {
                    type: "command",
                    command: process.execPath,
                    args: ["-e", verifyMemoryHook],
                  },
                ],
              },
            ],
          },
        }),
      }),
    );
    expect(model.requests).toHaveLength(4);
    expect(JSON.stringify(model.requests[2]?.input)).toContain(
      "Agent memory saved.",
    );
    expect(JSON.stringify(model.requests[2]?.input)).toContain(
      "AgentMemory PostToolUse observed",
    );
    expect(
      await readFile(
        join(
          directory,
          ".claude",
          "agent-memory.local",
          "rememberer",
          "MEMORY.md",
        ),
        "utf8",
      ),
    ).toContain("The parser rejects empty frontmatter. [REDACTED]");
    expect(
      await readFile(
        join(
          directory,
          ".claude",
          "agent-memory.local",
          "rememberer",
          "MEMORY.md",
        ),
        "utf8",
      ),
    ).not.toContain(API_KEY);
  });

  test("parent plan mode blocks persistent memory writes by bypass-configured children", async () => {
    await mkdir(join(directory, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(directory, ".codex", "agents", "rememberer.md"),
      "---\nmemory: local\npermissionMode: bypassPermissions\ntools: [AgentMemory]\n---\nTry to save a note",
    );
    const model = new ScriptedModel([
      call("Task", {
        subagent_type: "rememberer",
        prompt: "Save a note",
      }),
      call("AgentMemory", {
        action: "append",
        content: "must stay read only",
      }),
      async (request) => {
        expect(JSON.stringify(request.input)).toContain("read-only/plan mode");
        return message("Memory write correctly blocked");
      },
      message("Parent finished"),
    ]);
    await runCodex(
      prompt,
      options(model, {
        permissionMode: "plan",
        allowedTools: ["Task"],
        modelProvider: { getModel: () => model },
        settingSources: ["project"],
      }),
    );
    expect(model.requests).toHaveLength(4);
    expect(
      await Bun.file(
        join(
          directory,
          ".claude",
          "agent-memory.local",
          "rememberer",
          "MEMORY.md",
        ),
      ).exists(),
    ).toBe(false);
  });

  test("AgentMemory honors explicit AgentMemory and Write denials", async () => {
    await mkdir(join(directory, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(directory, ".codex", "agents", "rememberer.md"),
      "---\nmemory: local\npermissionMode: bypassPermissions\ndisallowedTools: [Write]\n---\nTry to save a note",
    );
    const model = new ScriptedModel([
      call("Task", {
        subagent_type: "rememberer",
        prompt: "Save a note",
      }),
      call("AgentMemory", {
        action: "append",
        content: "must be denied",
      }),
      async (request) => {
        expect(JSON.stringify(request.input)).toContain(
          "Tool permission denied: Write",
        );
        return message("Memory write correctly denied");
      },
      message("Parent finished"),
    ]);
    await runCodex(
      prompt,
      options(model, {
        permissionMode: "bypassPermissions",
        allowedTools: ["Task"],
        modelProvider: { getModel: () => model },
        settingSources: ["project"],
      }),
    );
    expect(model.requests).toHaveLength(4);
    expect(
      await Bun.file(
        join(
          directory,
          ".claude",
          "agent-memory.local",
          "rememberer",
          "MEMORY.md",
        ),
      ).exists(),
    ).toBe(false);
  });

  test("AgentMemory cannot bypass an explicit AgentMemory denial", async () => {
    await mkdir(join(directory, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(directory, ".codex", "agents", "rememberer.md"),
      "---\nmemory: local\npermissionMode: bypassPermissions\ndisallowedTools: [AgentMemory]\n---\nTry to save a note",
    );
    const model = new ScriptedModel([
      call("Task", {
        subagent_type: "rememberer",
        prompt: "Save a note",
      }),
      call("AgentMemory", {
        action: "append",
        content: "must be denied",
      }),
      async (request) => {
        expect(JSON.stringify(request.input)).toContain(
          "Tool permission denied: AgentMemory",
        );
        return message("Memory write correctly denied");
      },
      message("Parent finished"),
    ]);
    await runCodex(
      prompt,
      options(model, {
        permissionMode: "bypassPermissions",
        allowedTools: ["Task"],
        modelProvider: { getModel: () => model },
        settingSources: ["project"],
      }),
    );
    expect(model.requests).toHaveLength(4);
    expect(
      await Bun.file(
        join(
          directory,
          ".claude",
          "agent-memory.local",
          "rememberer",
          "MEMORY.md",
        ),
      ).exists(),
    ).toBe(false);
  });

  test("resumes a clean isolated Task by recreating its worktree", async () => {
    await mkdir(join(directory, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(directory, ".codex", "agents", "isolated.md"),
      "---\ntools: [Read]\nisolation: worktree\n---\nReview in an isolated worktree",
    );
    execFileSync("git", ["init", "-b", "main"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "agent@example.invalid"], {
      cwd: directory,
    });
    execFileSync("git", ["config", "user.name", "Agent Test"], {
      cwd: directory,
    });
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: directory });
    const sessionStoragePath = join(directory, "agent-sessions");
    const first = new ScriptedModel([
      call("Task", {
        subagent_type: "isolated",
        prompt: "Review the first file",
      }),
      message("First isolated run completed without changes"),
      message("First parent turn"),
    ]);
    await runCodex(
      prompt,
      options(first, {
        permissionMode: "bypassPermissions",
        modelProvider: { getModel: () => first },
        settingSources: ["project"],
        sessionStoragePath,
      }),
    );
    const checkpointDirectory = agentSessionDirectory(
      sessionStoragePath,
      directory,
    );
    const checkpointFile = (await readdir(checkpointDirectory)).find((file) =>
      file.startsWith("subagent-"),
    )!;
    const id = checkpointFile.slice("subagent-".length, -".json".length);
    const checkpoint = JSON.parse(
      await readFile(join(checkpointDirectory, checkpointFile), "utf8"),
    );
    expect(checkpoint.isolation).toBe("worktree");
    expect(checkpoint.worktreePath).toBeUndefined();

    const second = new ScriptedModel([
      call("Task", {
        subagent_type: "isolated",
        prompt: "Continue the same review",
        resume_task_id: id,
      }),
      message("Resumed in a recreated worktree"),
      message("Second parent turn"),
    ]);
    await runCodex(
      prompt,
      options(second, {
        permissionMode: "bypassPermissions",
        modelProvider: { getModel: () => second },
        settingSources: ["project"],
        sessionStoragePath,
      }),
    );
    expect(second.requests).toHaveLength(3);
    expect(JSON.stringify(second.requests[1]?.input)).toContain(
      "First isolated run completed without changes",
    );
    expect(JSON.stringify(second.requests[1]?.input)).toContain(
      "Continue the same review",
    );
  });

  test("parent plan mode keeps a bypass-configured child read-only", async () => {
    await mkdir(join(directory, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(directory, ".codex", "agents", "writer.md"),
      "---\npermissionMode: bypassPermissions\ntools: [Write]\n---\nTry the requested write",
    );
    const model = new ScriptedModel([
      call("Task", { subagent_type: "writer", prompt: "write denied.txt" }),
      call("Write", { file_path: "denied.txt", content: "must not exist" }),
      async (request) => {
        expect(JSON.stringify(request.input)).toContain("read-only/plan");
        return message("Write correctly blocked");
      },
      message("Parent finished"),
    ]);
    await runCodex(
      prompt,
      options(model, {
        permissionMode: "plan",
        allowedTools: ["Task"],
        modelProvider: { getModel: () => model },
        settingSources: ["project"],
      }),
    );
    expect(model.requests).toHaveLength(4);
    expect(await Bun.file(join(directory, "denied.txt")).exists()).toBe(false);
  });

  test("Stop asyncRewake waits for newly launched work and continues inside the original turn cap", async () => {
    const settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: process.execPath,
                args: [
                  "-e",
                  "setTimeout(()=>{process.stderr.write('Finish required extra work');process.exitCode=2},50)",
                ],
                async: true,
                asyncRewake: true,
                once: true,
              },
            ],
          },
        ],
      },
    };
    const model = new ScriptedModel([
      message("Initial result"),
      message("Finished extra work"),
    ]);
    await runCodex(
      prompt,
      options(model, { maxTurns: 2, settings: JSON.stringify(settings) }),
    );
    expect(model.requests).toHaveLength(2);
    expect(JSON.stringify(model.requests[1]?.input)).toContain(
      "Finish required extra work",
    );
    expect((await artifact()).at(-1)?.result).toBe("Finished extra work");
  });

  test("disableSlashCommands preserves a raw slash request and no-session-persistence saves no history", async () => {
    await writeFile(
      join(directory, "codex-user-request.txt"),
      "/unconfigured fixture",
    );
    const model = new ScriptedModel([message()]);
    const result = await runCodex(
      prompt,
      options(model, { disableSlashCommands: true, persistSession: false }),
    );
    expect(JSON.stringify(model.requests[0]?.input)).toContain(
      "/unconfigured fixture",
    );
    await expect(history(result.sessionId!)).rejects.toThrow();
  });

  test("actual streamed SDK deltas are retained safely even when the API key crosses fragment boundaries", async () => {
    const answer = `Streaming ${API_KEY} finished`;
    const model: Model = {
      async getResponse() {
        throw new Error("Unexpected nonstreaming call");
      },
      async *getStreamedResponse() {
        yield { type: "response_started" as const };
        yield {
          type: "output_text_delta" as const,
          itemId: "stream-1",
          delta: answer.slice(0, 19),
        };
        yield {
          type: "output_text_delta" as const,
          itemId: "stream-1",
          delta: answer.slice(19),
        };
        yield {
          type: "response_done" as const,
          response: {
            id: "stream-response",
            output: [
              {
                type: "message" as const,
                role: "assistant" as const,
                status: "completed" as const,
                content: [{ type: "output_text" as const, text: answer }],
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
    await runCodex(
      prompt,
      options(model, {
        includePartialMessages: true,
        outputFormat: "stream-json",
      }),
    );
    const turns = await artifact();
    const delta = turns.find((turn) => turn.type === "stream_event");
    expect(delta?.event.delta.text).toBe("Streaming [REDACTED] finished");
    expect(JSON.stringify(turns)).not.toContain(API_KEY);
    expect(JSON.stringify(info.mock.calls)).not.toContain(API_KEY);
    expect(turns.at(-1)?.result).toBe("Streaming [REDACTED] finished");
  });

  test("loaded Skill changes the model on the next real SDK inference", async () => {
    await mkdir(join(directory, ".codex", "skills", "switcher"), {
      recursive: true,
    });
    await writeFile(
      join(directory, ".codex", "skills", "switcher", "SKILL.md"),
      '---\nmodel: secondary-fixture\nallowed-tools: ["Bash(printf:*)"]\n---\nSwitch model fixture',
    );
    const primary = new ScriptedModel([
      call("Skill", { skill: "switcher", args: null }),
    ]);
    const secondary = new ScriptedModel([message("Switched model")]);
    const names: string[] = [];
    const provider: ModelProvider = {
      getModel(name) {
        names.push(name ?? "");
        return name === "primary-fixture" ? primary : secondary;
      },
    };
    await runCodex(
      prompt,
      options(primary, {
        model: "primary-fixture",
        modelProvider: provider,
        permissionMode: "bypassPermissions",
        settingSources: ["project"],
      }),
    );
    expect(names).toEqual(["primary-fixture", "secondary-fixture"]);
    expect(primary.requests).toHaveLength(1);
    expect(secondary.requests).toHaveLength(1);
  });

  test("explicit agent definitions select instructions and limit exposed tools", async () => {
    const model = new ScriptedModel([message()]);
    await runCodex(
      prompt,
      options(model, {
        agentName: "reviewer",
        agentDefinitions: {
          reviewer: {
            prompt: "SELECTED AGENT SENTINEL",
            tools: ["Read"],
            description: "fixture",
          },
        },
      }),
    );
    expect(model.requests[0]?.systemInstructions).toContain(
      "SELECTED AGENT SENTINEL",
    );
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual(["Read"]);
  });

  test("strict MCP configuration suppresses ambient project servers", async () => {
    await mkdir(join(directory, ".codex"));
    await writeFile(
      join(directory, ".codex", "settings.json"),
      JSON.stringify({
        mcpServers: { ambient: { command: "fixture-does-not-exist" } },
      }),
    );
    const model = new ScriptedModel([message()]);
    await runCodex(
      prompt,
      options(model, { strictMcpConfig: true, settingSources: ["project"] }),
    );
    expect(model.requests).toHaveLength(1);
  });

  test("child MCP tools use child denies while preserving parent MCP approval", async () => {
    await mkdir(join(directory, ".codex", "agents"), { recursive: true });
    await writeFile(
      join(directory, ".codex", "agents", "restricted.md"),
      "---\ndisallowedTools: [mcp__fixture__test_tool]\n---\nRestricted child fixture",
    );
    const model = new ScriptedModel([
      call("Task", {
        subagent_type: "restricted",
        prompt: "Invoke fixture tool",
        description: null,
        model: null,
        max_turns: null,
        run_in_background: null,
      }),
      call("mcp__fixture__test_tool", {}, "child-mcp"),
      async (request) => {
        expect(JSON.stringify(request.input)).toContain("denied");
        expect(JSON.stringify(request.input)).not.toContain(
          "Test tool response",
        );
        return message("Child denied safely");
      },
      message("Parent finished"),
    ]);
    await runCodex(
      prompt,
      options(model, {
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        allowedTools: ["mcp__fixture__test_tool"],
        mcpConfig: JSON.stringify({
          mcpServers: {
            fixture: {
              command: process.execPath,
              args: [join(import.meta.dir, "mcp-test", "simple-mcp-server.ts")],
            },
          },
        }),
      }),
    );
    expect(model.requests).toHaveLength(3);
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toContain(
      "mcp__fixture__test_tool",
    );
    expect(JSON.stringify(model.requests[2]?.input)).toContain(
      "Tool permission denied: mcp__fixture__test_tool",
    );
    expect((await artifact()).at(-1)?.is_error).toBe(false);
  });

  test("Task compacts its isolated first context, charges usage once and preserves the main turn cap", async () => {
    const hookLog = join(directory, "child-compact-hooks.jsonl");
    const handler = {
      type: "command",
      command: process.execPath,
      args: [
        "-e",
        `const fs=require('node:fs');const data=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(hookLog)},JSON.stringify({event:data.hook_event_name,session:data.session_id})+'\\n')`,
      ],
    };
    const main = new ScriptedModel([
      call("Task", {
        subagent_type: "compact-child",
        prompt: "NESTED ONLY fixture",
        description: null,
        model: null,
        max_turns: 1,
        run_in_background: null,
      }),
      message("Parent finished"),
    ]);
    const child = new ScriptedModel([
      async () => {
        throw Object.assign(new Error("context too long"), {
          code: "context_length_exceeded",
        });
      },
      async (request) => {
        expect(JSON.stringify(request.input)).toContain("child-compact-marker");
        return message("Child recovered");
      },
    ]);
    const compactRequests: Record<string, unknown>[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (...args: Parameters<typeof globalThis.fetch>) => {
          const [input, init] = args;
          const request =
            input instanceof Request
              ? new Request(input, init)
              : new Request(String(input), init);
          expect(request.url).toBe(
            "https://fixture.invalid/v1/responses/compact",
          );
          const body = JSON.parse(await request.text()) as Record<
            string,
            unknown
          >;
          compactRequests.push(body);
          return new Response(
            JSON.stringify({
              id: "compact-child-response",
              object: "response.compaction",
              created_at: 1,
              output: [
                {
                  type: "message",
                  role: "user",
                  content: [
                    { type: "input_text", text: "NESTED ONLY fixture" },
                  ],
                },
                {
                  type: "compaction",
                  id: "child-compact-marker",
                  encrypted_content: "opaque-child-context",
                },
              ],
              usage: {
                input_tokens: 20,
                output_tokens: 2,
                total_tokens: 22,
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
    try {
      const result = await runCodex(
        prompt,
        options(main, {
          model: "gpt-5.3-codex",
          modelProvider: {
            getModel: (name) => (name === "gpt-5.3-codex" ? main : child),
          },
          baseURL: "https://fixture.invalid/v1",
          maxTurns: 2,
          maxBudgetUsd: 1,
          permissionMode: "bypassPermissions",
          modelPrices: {
            "gpt-5.3-codex-child-fixture": {
              input: 1.75,
              cachedInput: 0.175,
              output: 14,
            },
          },
          agentDefinitions: {
            "compact-child": {
              prompt: "Child compaction fixture",
              model: "gpt-5.3-codex-child-fixture",
              hooks: {
                PreCompact: [{ hooks: [handler] }],
                PostCompact: [{ hooks: [handler] }],
              },
            },
          },
        }),
      );
      expect(result.conclusion).toBe("success");
      expect(main.requests).toHaveLength(2);
      expect(child.requests).toHaveLength(2);
      expect(compactRequests).toHaveLength(1);
      expect(compactRequests[0]?.model).toBe("gpt-5.3-codex-child-fixture");
      expect(JSON.stringify(compactRequests[0]?.input)).toContain(
        "NESTED ONLY",
      );
      expect(JSON.stringify(main.requests[1]?.input)).not.toContain(
        "child-compact-marker",
      );
      const recorded = await artifact(),
        final = recorded.at(-1)!;
      expect(final.num_turns).toBe(2);
      expect(final.usage.input_tokens).toBe(50);
      expect(final.usage.output_tokens).toBe(11);
      expect(final.total_cost_usd).toBeCloseTo(0.0002415, 10);
      const hookCalls = (await readFile(hookLog, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(hookCalls.map((event) => event.event)).toEqual([
        "PreCompact",
        "PostCompact",
      ]);
      expect(hookCalls[0].session).not.toBe(result.sessionId);
      expect(hookCalls[1].session).toBe(hookCalls[0].session);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
