import { prepareAgentMode } from "../../src/modes/agent";
import * as actorValidation from "../../src/github/validation/actor";
import * as gitConfiguration from "../../src/github/operations/git-config";
import * as mcpPreparation from "../../src/mcp/install-mcp-server";
import { resolveActionPermissions } from "../../src/mcp/install-mcp-server";
import {
  createMockAutomationContext,
  createMockContext,
} from "../../test/mockContext";
import { actionCreatedIssueMarker } from "../../src/github/issue-origin";
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

test.each(["true", "false"])(
  "issue publication masks provider and App credentials while preserving %s",
  async (flag) => {
    const credential = "opaque-azure-fixture-987654321";
    const pem =
      "-----BEGIN PRIVATE KEY-----\nsynthetic-app-credential\n-----END PRIVATE KEY-----";
    const escapedPem = pem.replaceAll("\n", "\\n");
    process.env.GITHUB_APP_PRIVATE_KEY = escapedPem;
    process.env.GITHUB_TOKEN_PROVIDED = flag;
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_PROVIDER = "azure";
    process.env.OPENAI_API_VERSION = "2025-03-01-preview";
    process.env.AZURE_OPENAI_API_KEY = credential;
    process.env.AZURE_OPENAI_ENDPOINT = "https://fixture.openai.azure.com";
    await writeFile(join(directory, "reproduction.txt"), credential);
    await mkdir(join(directory, ".claude"), { recursive: true });
    await writeFile(
      join(directory, ".claude/settings.json"),
      '{"permissions":{"defaultMode":"plan"}}',
    );
    const posts: any[] = [];
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      /** Capture the real scoped issue server's outgoing REST payload. */
      async fetch(request) {
        posts.push(await request.json());
        return Response.json(
          {
            number: 1,
            title: posts[0].title,
            html_url: "https://github.com/owner/repo/issues/1",
          },
          { status: 201 },
        );
      },
    });
    const model = new ScriptedModel([
      call("Read", { file_path: join(directory, "reproduction.txt") }),
      call("mcp__github_issues__create_issue", {
        title: `Report true and false ${credential}`,
        body: `Literal <img alt="Example"> return true; enabled: false ${pem} ${escapedPem}`,
        labels: ["true", "false", credential],
      }),
      message("Created"),
    ]);
    try {
      await runCodex(
        prompt,
        options(model, {
          timeoutMs: 10000,
          reserveIssueMcpServer: true,
          issuePermissionMode: "acceptEdits",
          settingSources: ["project"],
          mcpConfig: JSON.stringify({
            mcpServers: {
              github_issues: {
                command: process.execPath,
                args: [
                  join(
                    import.meta.dir,
                    "../../src/mcp/github-issues-server.ts",
                  ),
                ],
                env: {
                  GITHUB_TOKEN: "fixture-token",
                  REPO_OWNER: "owner",
                  REPO_NAME: "repo",
                  GITHUB_WORKFLOW_REF:
                    "owner/repo/.github/workflows/create.yml@refs/heads/main",
                  GITHUB_API_URL: String(http.url).replace(/\/$/, ""),
                },
              },
            },
          }),
        }),
      );
      expect(posts).toHaveLength(1);
      expect(JSON.stringify(posts)).not.toContain(credential);
      expect(posts[0]).toMatchObject({
        title: "Report true and false [REDACTED]",
        body: `${actionCreatedIssueMarker("owner/repo/.github/workflows/create.yml@refs/heads/main")}\n\nLiteral <img alt="Example"> return true; enabled: false [REDACTED] [REDACTED]`,
        labels: ["true", "false", "[REDACTED]"],
      });
    } finally {
      http.stop(true);
    }
  },
);

test.each([
  "args",
  "settings",
  "direct",
  "main-read-only",
  "main-project-plan",
  "main-writer-conflict",
  "main-writer-conflict-alias",
  "main-restored",
  "main-prepared",
] as const)(
  "runtime retains caller-owned github_issues servers from %s",
  async (source) => {
    const server = join(directory, "standalone-mcp.cjs");
    await writeFile(
      server,
      String.raw`const readline = require("node:readline");
readline.createInterface({input:process.stdin}).on("line",line=>{
  const message=JSON.parse(line);
  if(message.id===undefined)return;
  const result=message.method==="initialize"
    ? {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"standalone",version:"1"}}
    : message.method==="tools/list"
      ? {tools:[{name:"proof",description:"Return a standalone proof",inputSchema:{type:"object",properties:{},additionalProperties:false}}]}
      : {content:[{type:"text",text:"standalone proof"}]};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result})+"\n");
});
`,
    );
    const config = JSON.stringify({
      mcpServers: { github_issues: { command: "node", args: [server] } },
    });
    const model = new ScriptedModel([
      call("mcp__github_issues__proof", {}),
      message(),
    ]);
    const extra =
      source === "args"
        ? { compatibilityArgs: `--mcp-config '${config}'` }
        : source === "settings"
          ? { settings: config }
          : { mcpConfig: config };
    if (source.startsWith("main-") && source !== "main-prepared") {
      if (source === "main-read-only") process.env.CODEX_SANDBOX = "read-only";
      const callerConfig =
        source === "main-writer-conflict-alias"
          ? config.replace('"github_issues"', '"github:issues"')
          : config;
      process.env.CODEX_ARGS = `--allowedTools mcp__github_issues__proof --mcp-config '${callerConfig}'`;
      if (source === "main-restored") {
        const file = join(directory, "workflow-mcp.json");
        await writeFile(
          file,
          '{"mcpServers":{"github_issues":{"command":"must-not-start"}}}',
        );
        process.env.CODEX_ARGS = `--allowedTools mcp__github_issues__proof --mcp-config '${file}'`;
      }
      if (!["main-read-only", "main-restored"].includes(source)) {
        await mkdir(join(directory, ".claude"));
        await writeFile(
          join(directory, ".claude/settings.json"),
          '{"permissions":{"defaultMode":"plan"}}',
        );
      }
      const permission = await resolveActionPermissions(
        "",
        source === "main-read-only"
          ? createMockAutomationContext()
          : createMockContext({
              eventName: "issues",
              eventAction: "opened",
              isPR: false,
              actor: "request-author",
              payload: { issue: { user: { login: "request-author" } } } as any,
            }),
        "tag",
      );
      expect(permission.reserveIssueMcpServer).toBe(
        source !== "main-read-only",
      );
      if (source === "main-restored")
        await writeFile(
          join(directory, "workflow-mcp.json"),
          '{"mcpServers":{}}',
        );
      Object.assign(extra, {
        reserveIssueMcpServer: permission.reserveIssueMcpServer,
        sandbox: source === "main-read-only" ? "read-only" : "workspace-write",
        settingSources: ["project"],
        mcpConfig:
          source === "main-restored"
            ? config
            : JSON.stringify({
                mcpServers: { github_issues: { command: "must-not-start" } },
              }),
        compatibilityArgs: process.env.CODEX_ARGS,
        ...(source.startsWith("main-writer-conflict")
          ? { issuePermissionMode: "acceptEdits" }
          : {}),
      });
    }
    if (source === "main-prepared") {
      process.env.ALLOWED_TOOLS =
        "mcp__github_issues__create_issue,mcp__github_issues__proof";
      process.env.CODEX_ARGS = "--allowedTools mcp__github_issues__proof";
      const spies = [
        spyOn(actorValidation, "checkHumanActor").mockResolvedValue(undefined),
        spyOn(gitConfiguration, "configureGitAuth").mockResolvedValue(
          undefined,
        ),
        spyOn(mcpPreparation, "prepareMcpConfig").mockResolvedValue(config),
      ];
      try {
        const prepared = await prepareAgentMode({
          context: createMockAutomationContext({
            inputs: { prompt: "Inspect the issue" },
          }),
          octokit: {} as any,
          githubToken: "fixture-token",
        });
        expect(prepared.reserveIssueMcpServer).toBe(true);
        Object.assign(extra, {
          compatibilityArgs: prepared.claudeArgs,
          mcpConfig: prepared.mcpConfig,
          reserveIssueMcpServer: prepared.reserveIssueMcpServer,
          issuePermissionMode: prepared.issuePermissionMode,
        });
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }
    if (source.startsWith("main-writer-conflict")) {
      await expect(runCodex(prompt, options(model, extra))).rejects.toThrow(
        "github_issues is reserved",
      );
      expect(model.requests).toHaveLength(0);
      return;
    }
    const result = await runCodex(prompt, options(model, extra));
    expect(result.conclusion).toBe("success");
    expect(JSON.stringify(model.requests[1]?.input)).toContain(
      "standalone proof",
    );
  },
);

test("main-action issue writes honor project plan mode before tag's editing default", async () => {
  await mkdir(join(directory, ".claude"), { recursive: true });
  await writeFile(
    join(directory, ".claude/settings.json"),
    '{"permissions":{"defaultMode":"plan"}}',
  );
  const model = new ScriptedModel([
    async (request) => {
      expect(
        request.tools.some((tool) =>
          tool.name.startsWith("mcp__github_issues__"),
        ),
      ).toBe(false);
      return message("Planning only");
    },
  ]);
  const result = await runCodex(
    prompt,
    options(model, {
      reserveIssueMcpServer: true,
      settingSources: ["project"],
      compatibilityArgs: "--permission-mode acceptEdits",
      mcpConfig: JSON.stringify({
        mcpServers: { github_issues: { command: "must-not-start" } },
      }),
    }),
  );
  expect(result.conclusion).toBe("success");
});

test("declared sensitive plugin options are masked at actual issue publication", async () => {
  const credential = "opaque-plugin-option-fixture";
  const plugin = join(directory, "private-plugin");
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  const server = join(plugin, "diagnostic.cjs");
  await writeFile(
    server,
    String.raw`const readline=require("node:readline");
readline.createInterface({input:process.stdin}).on("line",line=>{
 const message=JSON.parse(line); if(message.id===undefined)return;
 const result=message.method==="initialize"
 ? {protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"private-diagnostic",version:"1"}}
 : message.method==="tools/list"
 ? {tools:[{name:"diagnostic",description:"Sensitive diagnostic fixture",inputSchema:{type:"object",properties:{},additionalProperties:false}}]}
 : {content:[{type:"text",text:"plugin diagnostic "+process.env.AUTH}]};
 process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:message.id,result})+"\n");
});`,
  );
  await writeFile(
    join(plugin, ".claude-plugin/plugin.json"),
    JSON.stringify({
      name: "private-diagnostic",
      userConfig: {
        opaque: { type: "string", sensitive: true, required: true },
      },
      mcpServers: {
        probe: {
          command: "node",
          args: [server],
          env: { AUTH: "${user_config.opaque}" },
        },
      },
    }),
  );
  const posts: any[] = [];
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    /** Capture publication after plugin-specific credential registration. */
    async fetch(request) {
      posts.push(await request.json());
      return Response.json(
        {
          number: 1,
          title: "Plugin diagnostic",
          html_url: "https://github.com/owner/repo/issues/1",
        },
        { status: 201 },
      );
    },
  });
  const model = new ScriptedModel([
    async (request) => {
      const tool = request.tools.find((tool) =>
        tool.name.endsWith("__diagnostic"),
      );
      expect(tool).toBeDefined();
      return call(tool!.name, {});
    },
    call("mcp__github_issues__create_issue", {
      title: "Plugin diagnostic",
      body: `plugin diagnostic ${credential}`,
    }),
    message(),
  ]);
  try {
    await runCodex(
      prompt,
      options(model, {
        timeoutMs: 10000,
        reserveIssueMcpServer: true,
        pluginRoots: [plugin],
        settings: JSON.stringify({
          pluginConfigs: { "private-diagnostic": { opaque: credential } },
        }),
        mcpConfig: JSON.stringify({
          mcpServers: {
            github_issues: {
              command: process.execPath,
              args: [
                join(import.meta.dir, "../../src/mcp/github-issues-server.ts"),
              ],
              env: {
                GITHUB_TOKEN: "fixture-token",
                REPO_OWNER: "owner",
                REPO_NAME: "repo",
                GITHUB_API_URL: String(http.url).replace(/\/$/, ""),
              },
            },
          },
        }),
      }),
    );
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(model.requests[1]?.input)).toContain(
      "plugin diagnostic",
    );
    expect(JSON.stringify(posts)).not.toContain(credential);
    expect(posts[0].body).toContain("[REDACTED]");
  } finally {
    http.stop(true);
  }
});
