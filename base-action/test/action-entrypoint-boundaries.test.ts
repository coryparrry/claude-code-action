import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Reply = { output?: unknown[]; error?: string };
const directories: string[] = [];
const apiKey = "offline-boundary-fixture-key";
const entrypoint = resolve(import.meta.dir, "../src/index.ts");
const config = resolve(import.meta.dir, "../../bunfig.toml");

function message(text: string): Reply {
  return {
    output: [
      {
        id: "message-fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  };
}
function write(content: string, id = "write-once"): Reply {
  return {
    output: [
      {
        id: `function-${id}`,
        type: "function_call",
        name: "Write",
        call_id: id,
        status: "completed",
        arguments: JSON.stringify({ file_path: "review.txt", content }),
      },
    ],
  };
}

// Exercises the shipped entrypoint, Actions file commands, HTTP provider, SDK,
// permission checks, tools and execution report; only inference is a fixture.
async function runAction(
  replies: Reply[],
  inputs: Record<string, string> = {},
  staleReport = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "action-boundaries-"));
  directories.push(directory);
  const outputFile = join(directory, "outputs.txt");
  const reportPath = join(directory, "codex-execution-output.json");
  await writeFile(outputFile, "");
  if (staleReport)
    await writeFile(reportPath, '[{"type":"result","result":"previous run"}]');
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/responses")
        return new Response("Unexpected endpoint", { status: 404 });
      requests.push((await request.json()) as Record<string, unknown>);
      const reply = replies[requests.length - 1];
      if (!reply || reply.error)
        return Response.json(
          {
            error: {
              message: reply?.error ?? "Unexpected model request",
              type: "invalid_request_error",
            },
          },
          { status: 400 },
        );
      return Response.json({
        id: `response-${requests.length}`,
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-6-luna",
        output: reply.output ?? [],
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          total_tokens: 13,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      });
    },
  });
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", `--config=${config}`, entrypoint],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        RUNNER_TEMP: directory,
        GITHUB_WORKSPACE: directory,
        GITHUB_OUTPUT: outputFile,
        GITHUB_ENV: join(directory, "environment.txt"),
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        INPUT_PROMPT: "Review this change and report the result.",
        INPUT_CODEX_MODEL: "gpt-6-luna",
        INPUT_MCP_CONFIG: '{"mcpServers":{}}',
        INPUT_SETTING_SOURCES: "project,local",
        INPUT_CODEX_ARGS: "--no-session-persistence",
        INPUT_PERMISSION_MODE: "bypassPermissions",
        INPUT_CODEX_SANDBOX: "workspace-write",
        INPUT_MAX_TURNS: "5",
        ...inputs,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill(), 8000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const outputText = (await readFile(outputFile, "utf8")).replaceAll(
      "\r\n",
      "\n",
    );
    const outputs = Object.fromEntries(
      [
        ...outputText.matchAll(/^(\w+)<<([^\n]+)\n([\s\S]*?)\n\2(?:\n|$)/gm),
      ].map((match) => [match[1], match[3]]),
    );
    const report = await readFile(reportPath, "utf8").then(
      (text) => JSON.parse(text),
      () => undefined,
    );
    return { directory, exitCode, stdout, stderr, outputs, report, requests };
  } finally {
    clearTimeout(timer);
    child.kill();
    server.stop(true);
  }
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("shipped action boundaries", () => {
  test("completed tools and an empty response recover through the HTTP provider and Actions outputs", async () => {
    const result = await runAction([
      write("posted once"),
      message(""),
      message("Review complete"),
    ]);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.outputs.conclusion).toBe("success");
    expect(result.outputs.execution_file).toBe(
      join(result.directory, "codex-execution-output.json"),
    );
    expect(await readFile(join(result.directory, "review.txt"), "utf8")).toBe(
      "posted once",
    );
    expect(result.report.at(-1)).toMatchObject({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Review complete",
      num_turns: 3,
      usage: { input_tokens: 30 },
    });
    expect(result.requests).toHaveLength(3);
    expect(result.requests[2]?.tools ?? []).toHaveLength(0);
    expect(result.requests[2]?.tool_choice).toBe("none");
  }, 10000);

  test("a response without an assistant item cannot bypass the SDK turn cap", async () => {
    const result = await runAction([{ output: [] }, message("Too late")], {
      INPUT_MAX_TURNS: "1",
    });
    expect(result.exitCode).toBe(1);
    expect(result.outputs.conclusion).toBe("failure");
    expect(result.outputs.execution_file).toBeDefined();
    expect(result.report.at(-1)).toMatchObject({
      is_error: true,
      num_turns: 1,
      usage: { input_tokens: 10 },
    });
    expect(result.requests).toHaveLength(1);
  }, 10000);

  test("a provider tool call during completion recovery cannot repeat side effects", async () => {
    const result = await runAction([
      write("posted once"),
      message(""),
      write("duplicate", "write-twice"),
      message("Done"),
    ]);
    expect(result.exitCode, result.stdout + result.stderr).toBe(1);
    expect(result.outputs.conclusion).toBe("failure");
    expect(result.outputs.execution_file).toBeDefined();
    expect(await readFile(join(result.directory, "review.txt"), "utf8")).toBe(
      "posted once",
    );
    expect(result.report.at(-1).is_error).toBe(true);
    expect(result.requests).toHaveLength(3);
  }, 10000);

  test("repeated empty completions fail and preserve their report and usage", async () => {
    const result = await runAction([message(""), message(" \n\t")]);
    expect(result.exitCode).toBe(1);
    expect(result.outputs.conclusion).toBe("failure");
    expect(result.outputs.execution_file).toBeDefined();
    expect(result.report.at(-1)).toMatchObject({
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 2,
      usage: { input_tokens: 20 },
    });
    expect(result.report.at(-1).result).toContain("completion recovery");
    expect(result.requests).toHaveLength(2);
  }, 10000);

  test("completion recovery preserves the action turn cap and completed work", async () => {
    const result = await runAction(
      [write("posted once"), message(""), message("Too late")],
      { INPUT_MAX_TURNS: "2" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.report.at(-1)).toMatchObject({
      is_error: true,
      num_turns: 2,
      usage: { input_tokens: 20 },
    });
    expect(result.requests).toHaveLength(2);
    expect(await readFile(join(result.directory, "review.txt"), "utf8")).toBe(
      "posted once",
    );
  }, 10000);

  test("provider failure after completed work preserves redacted diagnostics", async () => {
    const result = await runAction([
      write("posted once"),
      { error: `Provider rejected ${apiKey}` },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.outputs.conclusion).toBe("failure");
    expect(result.outputs.execution_file).toBeDefined();
    expect(result.report.at(-1).is_error).toBe(true);
    expect(JSON.stringify(result.report)).not.toContain(apiKey);
    expect(result.requests).toHaveLength(2);
    expect(await readFile(join(result.directory, "review.txt"), "utf8")).toBe(
      "posted once",
    );
  }, 10000);

  test.each([true, false])(
    "structured output validity %j controls both exit status and action outputs",
    async (valid) => {
      const schema = {
        type: "object",
        properties: { reviewed: { type: "boolean" } },
        required: ["reviewed"],
        additionalProperties: false,
      };
      const result = await runAction(
        [message(valid ? '{"reviewed":true}' : '{"reviewed":"yes"}')],
        {
          INPUT_CODEX_ARGS: `--no-session-persistence --json-schema '${JSON.stringify(schema)}'`,
        },
      );
      expect(result.exitCode, result.stdout + result.stderr).toBe(
        valid ? 0 : 1,
      );
      expect(result.outputs.conclusion).toBe(valid ? "success" : "failure");
      expect(result.report.at(-1).is_error).toBe(!valid);
      if (valid)
        expect(JSON.parse(result.outputs.structured_output!)).toEqual({
          reviewed: true,
        });
      else expect(result.outputs.structured_output).toBeUndefined();
    },
    10000,
  );

  test("read-only action settings prevent a provider-requested write", async () => {
    const result = await runAction(
      [write("must not exist"), message("The write was denied")],
      { INPUT_CODEX_SANDBOX: "read-only" },
    );
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(
      await readFile(join(result.directory, "review.txt"), "utf8").catch(
        () => undefined,
      ),
    ).toBeUndefined();
    expect(JSON.stringify(result.report)).toContain(
      "Write is unavailable in read-only/plan mode",
    );
  }, 10000);

  test("preflight failure cannot expose a previous action's execution report", async () => {
    const result = await runAction(
      [],
      { INPUT_CODEX_TIMEOUT_MINUTES: "invalid" },
      true,
    );
    expect(result.exitCode).toBe(1);
    expect(result.outputs.conclusion).toBe("failure");
    expect(result.outputs.execution_file).toBeUndefined();
    expect(result.report).toBeUndefined();
    expect(result.requests).toHaveLength(0);
  }, 10000);
});
