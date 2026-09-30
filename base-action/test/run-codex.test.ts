import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodex } from "../src/run-codex";
import {
  codexEnvironment,
  SECURITY_OVERRIDES,
  serializeMcpConfig,
} from "../src/codex-config";

const API_KEY = "unit-test-api-value-only";
const GITHUB_TOKEN = "unit-test-github-value-only";
const events: Record<string, unknown>[] = [
  { type: "thread.started", thread_id: "session-test-123" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: "Done" } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
];
const parseToml = (value: string): Record<string, any> =>
  (
    Bun as unknown as {
      TOML: { parse: (value: string) => Record<string, any> };
    }
  ).TOML.parse(value);

describe("Codex runner (offline fake CLI)", () => {
  let directory: string;
  let prompt: string;
  let capture: string;
  let savedEnv: NodeJS.ProcessEnv;
  let info: ReturnType<typeof spyOn>;
  let warning: ReturnType<typeof spyOn>;
  let secret: ReturnType<typeof spyOn>;
  let consoleLog: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    directory = await mkdtemp(join(tmpdir(), "codex-runner-test-"));
    prompt = join(directory, "context.txt");
    capture = join(directory, "capture.json");
    await writeFile(prompt, "Generated GitHub context");
    process.env.OPENAI_API_KEY = API_KEY;
    process.env.RUNNER_TEMP = directory;
    process.env.GITHUB_TOKEN = GITHUB_TOKEN;
    process.env.ACTIONS_RUNTIME_TOKEN = "actions-secret-test-only";
    info = spyOn(core, "info").mockImplementation(() => {});
    warning = spyOn(core, "warning").mockImplementation(() => {});
    secret = spyOn(core, "setSecret").mockImplementation(() => {});
    consoleLog = spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(async () => {
    process.env = savedEnv;
    info.mockRestore();
    warning.mockRestore();
    secret.mockRestore();
    consoleLog.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  async function fake(
    script: string,
    pluginScript = "process.exit(0);",
  ): Promise<string> {
    const executable = join(directory, "fake-codex");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst args = process.argv.slice(2);\nconst home = process.env.CODEX_HOME;\nif (args[0] === "plugin") { fs.appendFileSync(${JSON.stringify(join(directory, "plugins.jsonl"))}, JSON.stringify({args, home}) + "\\n"); ${pluginScript} }\nconst output = args[args.indexOf("--output-last-message") + 1];\nlet prompt = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", chunk => prompt += chunk);\nprocess.stdin.on("end", () => {\nfs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, home, prompt, config: fs.readFileSync(path.join(home, "config.toml"), "utf8"), env: process.env }));\n${script}\n});\n`,
    );
    await chmod(executable, 0o700);
    return executable;
  }

  function output(stream = events, final = "Done", exit = 0): string {
    return `fs.writeFileSync(output, ${JSON.stringify(final)});\nprocess.stdout.write(${JSON.stringify(stream.map((event) => JSON.stringify(event)).join("\n") + "\n")});\nprocess.exitCode = ${exit};`;
  }

  async function artifact(): Promise<Record<string, any>[]> {
    return JSON.parse(
      await readFile(join(directory, "codex-execution-output.json"), "utf8"),
    );
  }

  async function assertCleaned(): Promise<void> {
    const { home } = JSON.parse(await readFile(capture, "utf8"));
    await expect(readFile(join(home, "config.toml"))).rejects.toThrow();
  }

  async function waitForFakeReady(): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        JSON.parse(await readFile(capture, "utf8"));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Fake Codex CLI did not become ready within 3 seconds");
  }

  test("passes both prompt files, append instructions, explicit options and API-only auth", async () => {
    await writeFile(
      join(directory, "codex-user-request.txt"),
      "Review this PR",
    );
    const executable = await fake(output());
    const result = await runCodex(prompt, {
      executable,
      mcpConfig: '{"mcpServers":{}}',
      appendSystemPrompt: "Use repository rules",
      model: "test-model",
      effort: "high",
      sandbox: "read-only",
    });
    expect(result.conclusion).toBe("success");
    const report = (await artifact()).at(-1)!;
    expect(report.num_turns).toBe(1);
    expect(report.duration_ms).toBeGreaterThanOrEqual(0);
    expect(report.usage).toEqual({
      input_tokens: 1,
      output_tokens: 1,
      cache_read_input_tokens: 0,
    });
    expect(result.sessionId).toBe("session-test-123");
    expect(result.executionFile).toBe(
      join(directory, "codex-execution-output.json"),
    );
    const captured = JSON.parse(await readFile(capture, "utf8"));
    expect(captured.prompt).toContain("Generated GitHub context");
    expect(captured.prompt).toContain("Review this PR");
    expect(captured.prompt).toContain("Use repository rules");
    expect(captured.args).toContain("--json");
    expect(captured.args).toContain("--ephemeral");
    expect(captured.args.at(-1)).toBe("-");
    expect(captured.args).toContain("test-model");
    expect(captured.args).toContain('model_reasoning_effort="high"');
    expect(captured.env.CODEX_API_KEY).toBe(API_KEY);
    expect(captured.env.OPENAI_API_KEY).toBeUndefined();
    expect(captured.env.GITHUB_TOKEN).toBeUndefined();
    expect(captured.env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
    expect(secret).toHaveBeenCalledWith(API_KEY);
    const config = parseToml(captured.config);
    expect(config.forced_login_method).toBe("api");
    expect(config.shell_environment_policy.exclude).toContain("CODEX_API_KEY");
    expect(config.shell_environment_policy.exclude).toContain("ACTIONS_*");
    const turns = await artifact();
    expect(
      turns.find((turn) => turn.type === "assistant")?.message.content[0].text,
    ).toBe("Done");
    expect(turns.at(-1)?.is_error).toBe(false);
    await assertCleaned();
  });

  test("rejects a missing API key before launching", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      runCodex(prompt, { executable: "nonexistent", mcpConfig: "{}" }),
    ).rejects.toThrow("OPENAI_API_KEY");
    await expect(readFile(capture)).rejects.toThrow();
  });

  test("rejects danger-full-access before launching", async () => {
    await expect(
      runCodex(prompt, {
        executable: "nonexistent",
        sandbox: "danger-full-access",
        mcpConfig: '{"mcpServers":{}}',
      }),
    ).rejects.toThrow("read-only or workspace-write");
    await expect(readFile(capture)).rejects.toThrow();
  });

  test("serializes MCP token privately and redacts exact values in logs and persisted output", async () => {
    const text = `Keys: ${API_KEY} ${GITHUB_TOKEN} actions-secret-test-only`;
    const stream = events.map((event) =>
      event.type === "item.completed"
        ? { ...event, item: { type: "agent_message", text } }
        : event,
    );
    const executable = await fake(output(stream, text));
    await runCodex(prompt, {
      executable,
      showFullOutput: "true",
      mcpConfig: JSON.stringify({
        mcpServers: {
          github: {
            command: "bun",
            args: ["server.ts"],
            env: { GITHUB_TOKEN, REPO_NAME: "repo" },
          },
        },
      }),
    });
    const captured = JSON.parse(await readFile(capture, "utf8"));
    expect(parseToml(captured.config).mcp_servers.github.env.GITHUB_TOKEN).toBe(
      GITHUB_TOKEN,
    );
    expect(captured.env.GITHUB_TOKEN).toBeUndefined();
    expect(secret).toHaveBeenCalledWith(GITHUB_TOKEN);
    const persisted = JSON.stringify(await artifact());
    const logged = JSON.stringify(info.mock.calls);
    for (const value of [API_KEY, GITHUB_TOKEN, "actions-secret-test-only"]) {
      expect(persisted).not.toContain(value);
      expect(logged).not.toContain(value);
    }
    expect(persisted).toContain("[REDACTED]");
    await assertCleaned();
  });

  test("preserves a redacted transcript when the process exits nonzero after completion", async () => {
    const executable = await fake(
      `process.stderr.write(${JSON.stringify(API_KEY)});\n` +
        output(events, "Done", 2),
    );
    await expect(
      runCodex(prompt, { executable, mcpConfig: '{"mcpServers":{}}' }),
    ).rejects.toThrow("code 2");
    expect((await artifact()).at(-1)?.is_error).toBe(true);
    expect(warning).toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).not.toContain(API_KEY);
    await assertCleaned();
  });

  test.each(["error", "turn.failed"])(
    "rejects a %s event even with exit zero and completion",
    async (type) => {
      const executable = await fake(
        output([...events, { type, error: { message: "failed" } }]),
      );
      await expect(
        runCodex(prompt, { executable, mcpConfig: '{"mcpServers":{}}' }),
      ).rejects.toThrow("failed turn");
      expect((await artifact()).at(-1)?.is_error).toBe(true);
      await assertCleaned();
    },
  );

  test("rejects missing terminal completion while preserving assistant output", async () => {
    const executable = await fake(output(events.slice(0, -1)));
    await expect(
      runCodex(prompt, { executable, mcpConfig: '{"mcpServers":{}}' }),
    ).rejects.toThrow("completed turn");
    expect((await artifact()).some((turn) => turn.type === "assistant")).toBe(
      true,
    );
    await assertCleaned();
  });

  test("rejects a completed turn with no final assistant message", async () => {
    const executable = await fake(
      output(
        events.filter((event) => event.type !== "item.completed"),
        "",
      ),
    );
    await expect(
      runCodex(prompt, { executable, mcpConfig: '{"mcpServers":{}}' }),
    ).rejects.toThrow("final assistant");
    await assertCleaned();
  });

  test("can use the last-message file when the completed event lacks an agent-message item", async () => {
    const executable = await fake(
      output(
        events.filter((event) => event.type !== "item.completed"),
        "Final via file",
      ),
    );
    await runCodex(prompt, { executable, mcpConfig: '{"mcpServers":{}}' });
    expect(
      (await artifact()).find((turn) => turn.type === "assistant")?.message
        .content[0].text,
    ).toBe("Final via file");
    await assertCleaned();
  });

  test("keeps tag-mode defaults alongside an explicit allowlist and applies explicit denies last", async () => {
    const executable = await fake(output());
    await runCodex(prompt, {
      executable,
      mcpConfig: JSON.stringify({
        mcpServers: {
          github: { command: "bun" },
          github_comment: { command: "bun" },
          github_file_ops: { command: "bun" },
        },
      }),
      compatibilityArgs:
        "# --allowedTools ignored\n--allowedTools mcp__github__get_issue --disallowedTools mcp__github_file_ops__delete_file",
      defaultAllowedTools: [
        "Bash",
        "mcp__github_comment__update_codex_comment",
        "mcp__github_file_ops__*",
        "mcp__github_ci__*",
      ],
    });
    const captured = JSON.parse(await readFile(capture, "utf8"));
    expect(captured.args).toContain(
      'mcp_servers."github".enabled_tools=["get_issue"]',
    );
    expect(captured.args).toContain(
      'mcp_servers."github_comment".enabled_tools=["update_codex_comment"]',
    );
    expect(captured.args).not.toContain(
      'mcp_servers."github_comment".enabled=false',
    );
    expect(captured.args).not.toContain(
      'mcp_servers."github_file_ops".enabled=false',
    );
    expect(captured.args).not.toContain("features.shell_tool=false");
    expect(captured.args).toContain(
      'mcp_servers."github_file_ops".disabled_tools=["delete_file"]',
    );
    expect(captured.args.join(" ")).not.toContain("github_ci");
    await assertCleaned();
  });

  test("an explicit Bash deny overrides tag-mode Bash defaults", async () => {
    const executable = await fake(output());
    await runCodex(prompt, {
      executable,
      mcpConfig: '{"mcpServers":{}}',
      compatibilityArgs: "--allowedTools Bash --disallowedTools Bash",
      defaultAllowedTools: ["Bash"],
    });
    const captured = JSON.parse(await readFile(capture, "utf8"));
    expect(captured.args).toContain("features.shell_tool=false");
    expect(captured.args).toContain("features.unified_exec=false");
    await assertCleaned();
  });

  test("maps compatibility schema/options and returns structured report output", async () => {
    const final = JSON.stringify({ done: true });
    const executable = await fake(output(events, final));
    const result = await runCodex(prompt, {
      executable,
      mcpConfig: '{"mcpServers":{}}',
      compatibilityArgs: `--skip-git-repo-check --model compat-model --effort high --json-schema '{"type":"object","properties":{"done":{"type":"boolean"}},"required":["done"],"additionalProperties":false}' --append-system-prompt 'Extra compatibility rules'`,
      settings: 'model_verbosity = "low"',
    });
    expect(result.structuredOutput).toEqual({ done: true });
    expect((await artifact()).at(-1)?.structured_output).toEqual({
      done: true,
    });
    const captured = JSON.parse(await readFile(capture, "utf8"));
    expect(captured.args).toContain("--output-schema");
    expect(captured.args).toContain("--skip-git-repo-check");
    expect(captured.args).toContain("compat-model");
    expect(captured.args).toContain('model_verbosity="low"');
    expect(captured.prompt).toContain("Extra compatibility rules");
    await assertCleaned();
  });

  test("fails when a schema response is not valid JSON", async () => {
    const executable = await fake(output(events, "not-json"));
    await expect(
      runCodex(prompt, {
        executable,
        mcpConfig: '{"mcpServers":{}}',
        compatibilityArgs: `--json-schema '{"type":"object"}'`,
      }),
    ).rejects.toThrow("not valid JSON");
    expect((await artifact()).at(-1)?.is_error).toBe(true);
    await assertCleaned();
  });

  test("preserves actual build environment and legacy env settings in shell config", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const executable = await fake(output());
      await runCodex(prompt, {
        executable,
        mcpConfig: '{"mcpServers":{}}',
        settings: JSON.stringify({ env: { APP_MODE: "fixture" } }),
      });
      const captured = JSON.parse(await readFile(capture, "utf8"));
      const env = parseToml(captured.config).shell_environment_policy.set;
      expect(env.NODE_ENV).toBe("test");
      expect(env.APP_MODE).toBe("fixture");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ALL_INPUTS).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
  test("rejects model credentials smuggled through legacy settings.env values", async () => {
    const executable = await fake(output());
    await expect(
      runCodex(prompt, {
        executable,
        mcpConfig: '{"mcpServers":{}}',
        settings: JSON.stringify({
          env: {
            APP_CONFIG: JSON.stringify({ key: process.env.OPENAI_API_KEY }),
          },
        }),
      }),
    ).rejects.toThrow("reserved or credential variable");
  });
  test("grants only explicit trusted GitHub context to shell tools while model credentials stay isolated", async () => {
    const executable = await fake(output());
    await runCodex(prompt, {
      executable,
      mcpConfig: '{"mcpServers":{}}',
      githubEnvironment: {
        GH_TOKEN: "trusted-scoped-token",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_EVENT_PATH: "/tmp/event.json",
        GITHUB_WORKSPACE: "/workspace",
        GH_HOST: "github.com",
      },
    });
    const captured = JSON.parse(await readFile(capture, "utf8"));
    const config = parseToml(captured.config);
    expect(config.shell_environment_policy.set).toMatchObject({
      GH_TOKEN: "trusted-scoped-token",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_EVENT_PATH: "/tmp/event.json",
      GITHUB_WORKSPACE: "/workspace",
      GH_HOST: "github.com",
    });
    expect(config.shell_environment_policy.set.OPENAI_API_KEY).toBeUndefined();
    expect(config.shell_environment_policy.set.CODEX_API_KEY).toBeUndefined();
    expect(captured.env.GH_TOKEN).toBeUndefined();
    expect(captured.args).toContain('approval_policy="never"');
    await assertCleaned();
  });

  test("gives HTTP authentication to Codex without leaking it into shell configuration or reports", async () => {
    process.env.REMOTE_MCP_AUTH = "remote-auth-test-only";
    process.env.APP_DATA = JSON.stringify({ auth: "remote-auth-test-only" });
    process.env.APP_HEADERS = JSON.stringify({ auth: "header-auth-test-only" });
    const executable = await fake(
      output(
        events,
        "remote-auth-test-only header-auth-test-only cookie-auth-test-only",
      ),
    );
    await runCodex(prompt, {
      executable,
      mcpConfig: JSON.stringify({
        mcpServers: {
          remote: {
            type: "streamable-http",
            url: "https://example.com/mcp",
            bearer_token_env_var: "REMOTE_MCP_AUTH",
            http_headers: {
              Authorization: "Bearer header-auth-test-only",
              Cookie: "session=cookie-auth-test-only",
            },
          },
        },
      }),
    });
    const captured = JSON.parse(await readFile(capture, "utf8"));
    const config = parseToml(captured.config);
    expect(captured.env.REMOTE_MCP_AUTH).toBe("remote-auth-test-only");
    expect(config.shell_environment_policy.set.REMOTE_MCP_AUTH).toBeUndefined();
    expect(config.shell_environment_policy.set.APP_DATA).toBeUndefined();
    expect(config.shell_environment_policy.set.APP_HEADERS).toBeUndefined();
    expect(config.mcp_servers.remote.url).toBe("https://example.com/mcp");
    const report = JSON.stringify(await artifact());
    expect(report).not.toContain("remote-auth-test-only");
    expect(report).not.toContain("header-auth-test-only");
    expect(report).not.toContain("cookie-auth-test-only");
    expect(secret).toHaveBeenCalledWith("cookie-auth-test-only");
    expect(secret).toHaveBeenCalledWith("remote-auth-test-only");
    await assertCleaned();
  });

  test("installs native plugins into the same disposable home before execution", async () => {
    const executable = await fake(output());
    await runCodex(prompt, {
      executable,
      mcpConfig: '{"mcpServers":{}}',
      plugins: "tool@market",
      pluginMarketplaces: "./marketplace",
    });
    const captured = JSON.parse(await readFile(capture, "utf8"));
    const installations = (
      await readFile(join(directory, "plugins.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(installations.map((item) => item.args)).toEqual([
      ["plugin", "marketplace", "add", "./marketplace", "--json"],
      ["plugin", "add", "tool@market", "--json"],
    ]);
    expect(installations.every((item) => item.home === captured.home)).toBe(
      true,
    );
    await assertCleaned();
  });

  test("fails and cleans up when native plugin setup fails", async () => {
    const executable = await fake(output(), "process.exit(2);");
    await expect(
      runCodex(prompt, {
        executable,
        mcpConfig: '{"mcpServers":{}}',
        plugins: "tool@market",
      }),
    ).rejects.toThrow("plugin setup failed");
    const setup = JSON.parse(
      (await readFile(join(directory, "plugins.jsonl"), "utf8")).trim(),
    );
    await expect(readFile(join(setup.home, "config.toml"))).rejects.toThrow();
    expect((await artifact()).at(-1)?.is_error).toBe(true);
  });

  test("rejects malformed NDJSON even if a success event follows", async () => {
    const executable = await fake(
      `process.stdout.write("not-json\\n");\n${output()}`,
    );
    await expect(
      runCodex(prompt, { executable, mcpConfig: '{"mcpServers":{}}' }),
    ).rejects.toThrow("invalid JSON");
    expect((await artifact()).at(-1)?.is_error).toBe(true);
    await assertCleaned();
  });

  test("handles a missing executable and writes failure output", async () => {
    await expect(
      runCodex(prompt, {
        executable: join(directory, "missing"),
        mcpConfig: '{"mcpServers":{}}',
      }),
    ).rejects.toThrow("launch");
    expect((await artifact()).at(-1)?.is_error).toBe(true);
  });

  test("times out and removes its temporary home", async () => {
    const executable = await fake(
      'process.stdout.write(JSON.stringify({type:"thread.started", thread_id:"timeout-test"}) + "\\n"); setInterval(() => {}, 1000);',
    );
    await expect(
      runCodex(prompt, {
        executable,
        timeoutMs: 2000,
        mcpConfig: '{"mcpServers":{}}',
      }),
    ).rejects.toThrow("timed out");
    expect((await artifact()).at(-1)?.is_error).toBe(true);
    await assertCleaned();
  });

  test("cancels a running process and removes its temporary home", async () => {
    const executable = await fake("setInterval(() => {}, 1000);");
    const controller = new AbortController();
    const failure = runCodex(prompt, {
      executable,
      signal: controller.signal,
      timeoutMs: 4000,
      mcpConfig: '{"mcpServers":{}}',
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await waitForFakeReady();
    } finally {
      controller.abort();
    }
    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("cancelled");
    expect((await artifact()).at(-1)?.is_error).toBe(true);
    await assertCleaned();
  });
});

describe("Codex configuration", () => {
  test("round trips TOML metacharacters in server names, commands, arguments and environment", () => {
    const server = {
      command: 'command"\\name\n\u007f',
      args: ['quote"', "back\\slash", "tab\tline\n", "unicode 😀"],
      env: { 'TOKEN.quoted"': 'value"\\\n', NORMAL: "plain" },
    };
    const config = serializeMcpConfig(
      JSON.stringify({ mcpServers: { 'name.quoted"': server } }),
    );
    const parsed = parseToml(
      `${SECURITY_OVERRIDES.join("\n")}\n${config.toml}`,
    );
    expect(parsed.mcp_servers['name.quoted"'].command).toBe(server.command);
    expect(parsed.mcp_servers['name.quoted"'].args).toEqual(server.args);
    expect(parsed.mcp_servers['name.quoted"'].env).toEqual(server.env);
    expect(parsed.mcp_servers['name.quoted"'].required).toBe(true);
  });

  test.each([
    { command: "bun", env: { TOKEN: 123 } },
    { command: "bun", args: [123] },
  ])("rejects unsupported or malformed MCP configuration", (server) => {
    expect(() =>
      serializeMcpConfig(JSON.stringify({ mcpServers: { bad: server } })),
    ).toThrow("supports MCP stdio");
  });

  test.each([
    { type: "sse", url: "https://example.com" },
    { command: "bun", url: "https://example.com" },
    { url: "file:///tmp/server" },
    { url: "https://user:password@example.com" },
    { url: "https://example.com", headers: { Authorization: "a\nb" } },
    { url: "https://example.com", headers: {}, http_headers: {} },
    { url: "https://example.com", bearer_token_env_var: "OPENAI_API_KEY" },
    {
      url: "https://example.com",
      bearer_token_env_var: "UNSET_HTTP_AUTH_TEST",
    },
  ])(
    "rejects malformed HTTP or unsupported transport without echoing credentials",
    (server) => {
      expect(() =>
        serializeMcpConfig(JSON.stringify({ mcpServers: { bad: server } })),
      ).toThrow();
    },
  );

  test("translates streamable HTTP headers and isolated bearer authentication", () => {
    process.env.REMOTE_MCP_AUTH = "remote-auth-test-only";
    try {
      const result = serializeMcpConfig(
        JSON.stringify({
          mcpServers: {
            remote: {
              type: "http",
              url: "https://example.com/mcp",
              headers: {
                Authorization: "Bearer header-auth-test-only",
                "X-Region": "test",
              },
              bearer_token_env_var: "REMOTE_MCP_AUTH",
            },
          },
        }),
      );
      const parsed = parseToml(result.toml);
      expect(parsed.mcp_servers.remote).toEqual({
        url: "https://example.com/mcp",
        required: true,
        bearer_token_env_var: "REMOTE_MCP_AUTH",
        http_headers: {
          Authorization: "Bearer header-auth-test-only",
          "X-Region": "test",
        },
      });
      expect(result.clientEnvironment).toEqual({
        REMOTE_MCP_AUTH: "remote-auth-test-only",
      });
      expect(result.secrets).toContain("remote-auth-test-only");
      expect(result.secrets).toContain("header-auth-test-only");
    } finally {
      delete process.env.REMOTE_MCP_AUTH;
    }
  });

  test("rejects invalid JSON without echoing a credential-bearing config", () => {
    expect(() => serializeMcpConfig(API_KEY)).toThrow("valid JSON");
  });

  test("runner env excludes all nonessential variables", () => {
    const env = codexEnvironment("/isolated", "fake-key");
    expect(env.CODEX_HOME).toBe("/isolated");
    expect(env.CODEX_API_KEY).toBe("fake-key");
    expect(env.RUNNER_TEMP).toBeUndefined();
    expect(env.INPUT_OPENAI_API_KEY).toBeUndefined();
  });
});
