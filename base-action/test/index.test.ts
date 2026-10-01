import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index";

describe("base action entrypoint (offline)", () => {
  let directory: string;
  let savedEnv: NodeJS.ProcessEnv;
  let output: ReturnType<typeof spyOn>;
  let failed: ReturnType<typeof spyOn>;
  let info: ReturnType<typeof spyOn>;
  let secret: ReturnType<typeof spyOn>;
  let consoleLog: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    directory = await mkdtemp(join(tmpdir(), "codex-entrypoint-test-"));
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("INPUT_")) delete process.env[key];
    }
    process.env.RUNNER_TEMP = directory;
    process.env.OPENAI_API_KEY = "offline-fake-key";
    process.env.INPUT_PROMPT_FILE = join(directory, "prompt.txt");
    await writeFile(process.env.INPUT_PROMPT_FILE, "Review these files");
    output = spyOn(core, "setOutput").mockImplementation(() => {});
    failed = spyOn(core, "setFailed").mockImplementation(() => {});
    info = spyOn(core, "info").mockImplementation(() => {});
    secret = spyOn(core, "setSecret").mockImplementation(() => {});
    consoleLog = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.env = savedEnv;
    output.mockRestore();
    failed.mockRestore();
    info.mockRestore();
    secret.mockRestore();
    consoleLog.mockRestore();
    await rm(directory, { recursive: true, force: true });
  });

  test.each(["default", "compatibility"])(
    "runs the real Agents SDK through an offline HTTP fixture (%s)",
    async (mode) => {
      let captured: Record<string, unknown> | undefined;
      let path: string | undefined;
      const fetch = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
          async (...args: Parameters<typeof globalThis.fetch>) => {
            const [input, init] = args;
            const request =
              input instanceof Request
                ? new Request(input, init)
                : new Request(String(input), init);
            path = request.url;
            captured = JSON.parse(await request.text());
            expect(request.headers.get("authorization")).toBe(
              "Bearer offline-fake-key",
            );
            return new Response(
              JSON.stringify({
                id: "offline-entrypoint-response",
                object: "response",
                created_at: 1,
                status: "completed",
                model: "gpt-5.3-codex",
                output: [
                  {
                    id: "offline-entrypoint-message",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                      {
                        type: "output_text",
                        text: "Reviewed",
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
      process.env.OPENAI_BASE_URL = "http://offline-entrypoint.test/v1";
      process.env.INPUT_SYSTEM_PROMPT = "Trusted replacement instructions";
      process.env.INPUT_APPEND_SYSTEM_PROMPT = "Follow the repository rules";
      const expectedModel =
        mode === "compatibility" ? "compatibility-model" : "gpt-5.3-codex";
      if (mode === "compatibility") {
        process.env.INPUT_CODEX_MODEL = "";
        process.env.INPUT_CODEX_EFFORT = "";
        process.env.INPUT_SYSTEM_PROMPT = "";
        process.env.INPUT_APPEND_SYSTEM_PROMPT = "";
        process.env.INPUT_CODEX_ARGS =
          '--model compatibility-model --effort high --system-prompt "Trusted replacement instructions" --append-system-prompt "Follow the repository rules"';
      }
      process.env.INPUT_SETTING_SOURCES = "project";
      process.env.INPUT_MAX_TURNS = "3";
      process.env.INPUT_MAX_BUDGET_USD = mode === "default" ? "1" : "";
      process.env.INPUT_PERMISSION_MODE = "acceptEdits";
      process.env.INPUT_CONTINUE_SESSION = "false";
      try {
        await run();
        expect(failed.mock.calls).toEqual([]);
        expect(path).toBe("http://offline-entrypoint.test/v1/responses");
        expect(captured?.model).toBe(expectedModel);
        if (mode === "compatibility")
          expect((captured?.reasoning as Record<string, unknown>)?.effort).toBe(
            "high",
          );
        expect(captured?.store).toBe(false);
        expect(captured?.instructions).toContain(
          "Trusted replacement instructions",
        );
        expect(captured?.instructions).toContain("Follow the repository rules");
        expect(JSON.stringify(captured?.input)).toContain("Review these files");
        expect(output).toHaveBeenCalledWith("conclusion", "success");
        expect(
          output.mock.calls.some(
            (call: unknown[]) =>
              call[0] === "session_id" && typeof call[1] === "string",
          ),
        ).toBe(true);
        expect(output).toHaveBeenCalledWith(
          "execution_file",
          join(directory, "codex-execution-output.json"),
        );
        const report = JSON.parse(
          await readFile(
            join(directory, "codex-execution-output.json"),
            "utf8",
          ),
        );
        expect(report.at(-1).is_error).toBe(false);
        expect(JSON.stringify(report)).toContain("Reviewed");
      } finally {
        fetch.mockRestore();
      }
    },
  );

  test("rejects malformed continue_session before any model request", async () => {
    process.env.INPUT_CONTINUE_SESSION = "sometimes";
    await run();
    expect(failed.mock.calls[0]?.[0]).toContain(
      "continue_session must be true or false",
    );
    expect(output).toHaveBeenCalledWith("conclusion", "failure");
  });

  test("fails before launch when the OpenAI key is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    await run();
    expect(failed.mock.calls[0]?.[0]).toContain("OPENAI_API_KEY is required");
    expect(output).toHaveBeenCalledWith("conclusion", "failure");
  });

  test.each(["0", "-1", "1.5", "abc", "9007199254740992"])(
    "rejects an invalid timeout %s before launch",
    async (timeout) => {
      process.env.INPUT_CODEX_TIMEOUT_MINUTES = timeout;
      await run();
      expect(failed.mock.calls[0]?.[0]).toContain(
        "timeout minutes must be a positive integer",
      );
      expect(output).toHaveBeenCalledWith("conclusion", "failure");
    },
  );
});
