import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("runs the configured Codex executable and exposes its report and session", async () => {
    const executable = join(directory, "fake-codex.cjs");
    const capture = join(directory, "prompt-capture.txt");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nconst fs = require('node:fs');\nlet prompt = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', chunk => prompt += chunk);\nprocess.stdin.on('end', () => {\nfs.writeFileSync(${JSON.stringify(capture)}, prompt);\nconst events = [{type:'thread.started',thread_id:'entrypoint-session'}, {type:'item.completed',item:{type:'agent_message',text:'Reviewed'}}, {type:'turn.completed'}];\nfor (const event of events) console.log(JSON.stringify(event));\n});\n`,
    );
    await chmod(executable, 0o700);
    process.env.INPUT_PATH_TO_CODEX_EXECUTABLE = executable;
    process.env.INPUT_APPEND_SYSTEM_PROMPT = "Follow the repository rules";
    await run();
    expect(failed).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith("conclusion", "success");
    expect(output).toHaveBeenCalledWith("session_id", "entrypoint-session");
    expect(output).toHaveBeenCalledWith(
      "execution_file",
      join(directory, "codex-execution-output.json"),
    );
    expect(await readFile(capture, "utf8")).toContain(
      "Follow the repository rules",
    );
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
