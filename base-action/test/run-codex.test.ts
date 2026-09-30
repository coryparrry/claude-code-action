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

  async function fake(script: string): Promise<string> {
    const executable = join(directory, "fake-codex");
    await writeFile(
      executable,
      `#!${process.execPath}\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst args = process.argv.slice(2);\nconst home = process.env.CODEX_HOME;\nconst output = args[args.indexOf("--output-last-message") + 1];\nlet prompt = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", chunk => prompt += chunk);\nprocess.stdin.on("end", () => {\nfs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, home, prompt, config: fs.readFileSync(path.join(home, "config.toml"), "utf8"), env: process.env }));\n${script}\n});\n`,
    );
    await chmod(executable, 0o700);
    return executable;
  }

  function output(stream = events, final = "Done", exit = 0): string {
    return `fs.writeFileSync(output, ${JSON.stringify(final)});\nprocess.stdout.write(${JSON.stringify(stream.map((event) => JSON.stringify(event)).join("\n") + "\n")});\nprocess.exitCode = ${exit};`;
  }

  async function artifact(): Promise<Record<string, any>[]> {
    return JSON.parse(
      await readFile(join(directory, "claude-execution-output.json"), "utf8"),
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
      join(directory, "claude-user-request.txt"),
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
    expect(result.sessionId).toBe("session-test-123");
    expect(result.executionFile).toBe(
      join(directory, "claude-execution-output.json"),
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
    { type: "http", url: "https://example.com" },
    { command: "bun", env: { TOKEN: 123 } },
    { command: "bun", args: [123] },
    { command: "bun", url: "https://example.com" },
  ])("rejects unsupported or malformed MCP configuration", (server) => {
    expect(() =>
      serializeMcpConfig(JSON.stringify({ mcpServers: { bad: server } })),
    ).toThrow("supports MCP stdio");
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
