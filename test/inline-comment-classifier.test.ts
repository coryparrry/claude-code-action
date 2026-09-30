import { describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyComments,
  selectCommentsToPost,
  type BufferedComment,
} from "../src/entrypoints/post-buffered-inline-comments";

const comments: BufferedComment[] = [
  { ts: "now", path: "src/a.ts", line: 1, body: "This dereferences null" },
  {
    ts: "now",
    path: "src/a.ts",
    line: 2,
    body: "Test comment: does this work?",
  },
  {
    ts: "now",
    path: "src/a.ts",
    line: 3,
    body: "Never post",
    confirmed: false,
  },
];

describe("buffered inline comment classifier", () => {
  it("drops model-identified probes and never submits confirmed=false for classification", async () => {
    let submitted: string[] = [];
    const selected = await selectCommentsToPost(comments, async (bodies) => {
      submitted = bodies;
      return [true, false];
    });
    expect(submitted).toEqual(
      comments.slice(0, 2).map((comment) => comment.body),
    );
    expect(selected).toEqual([comments[0]!]);
  });

  it("falls back to all candidates when classification is unavailable or throws", async () => {
    for (const classifier of [
      async () => null,
      async () => {
        throw new Error("offline");
      },
      async () => [true],
      async () => [true, "bad"] as unknown as boolean[],
    ]) {
      expect(await selectCommentsToPost(comments, classifier)).toEqual(
        comments.slice(0, 2),
      );
    }
  });

  it("does not run a classifier when every call explicitly says not to post", async () => {
    expect(
      await selectCommentsToPost([comments[2]!], async () => {
        throw new Error("should not run");
      }),
    ).toEqual([]);
  });

  it("falls back without an OpenAI key", async () => {
    expect(await classifyComments(["review"], { env: {} })).toBeNull();
  });

  it("uses the real isolated Codex adapter and preserves the main run report and Actions output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-classifier-test-"));
    try {
      const capturePath = join(dir, "capture.json");
      const executable = join(dir, "fake-codex");
      const mainReport = join(dir, "codex-execution-output.json");
      const actionOutput = join(dir, "action-output.txt");
      await writeFile(mainReport, "original report");
      await writeFile(actionOutput, "original output");
      await writeFile(
        executable,
        `#!${process.execPath}
import { writeFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const prompt = await Bun.stdin.text();
const schemaPath = args[args.indexOf('--output-schema') + 1];
writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({args, prompt, schema: schemaPath ? JSON.parse(readFileSync(schemaPath, 'utf8')) : null, cwd: process.cwd(), env: process.env}));
const text = JSON.stringify({verdicts: [true, false]});
writeFileSync(args[args.indexOf('--output-last-message') + 1], text);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed'}));
`,
      );
      await chmod(executable, 0o700);
      const env = {
        ...process.env,
        OPENAI_API_KEY: "fake-openai-key-for-test",
        GITHUB_TOKEN: "github-secret-should-not-reach-cli",
        GITHUB_OUTPUT: actionOutput,
        RUNNER_TEMP: dir,
        INPUT_PATH_TO_CODEX_EXECUTABLE: executable,
        INPUT_CODEX_MODEL: "test-model",
        INPUT_CODEX_EFFORT: "low",
        INPUT_MCP_CONFIG: '{"mcpServers":{"dangerous":{"command":"bad"}}}',
        INPUT_PROMPT: "must not inherit the main prompt",
      };
      expect(
        await classifyComments(
          comments.slice(0, 2).map((comment) => comment.body),
          { env },
        ),
      ).toEqual([true, false]);
      const capture = JSON.parse(await readFile(capturePath, "utf8"));
      expect(capture.args).toContain("--output-schema");
      expect(capture.args).toContain("--skip-git-repo-check");
      expect(capture.args).toContain("read-only");
      expect(capture.args).toContain("test-model");
      expect(capture.schema.properties.verdicts.items.type).toBe("boolean");
      expect(capture.env.GITHUB_TOKEN).toBeUndefined();
      expect(capture.env.GITHUB_OUTPUT).toBeUndefined();
      expect(capture.env.INPUT_MCP_CONFIG).toBeUndefined();
      expect(capture.prompt).toContain("This dereferences null");
      expect(capture.prompt).not.toContain("must not inherit the main prompt");
      expect(capture.cwd).not.toBe(dir);
      expect(await readFile(mainReport, "utf8")).toBe("original report");
      expect(await readFile(actionOutput, "utf8")).toBe("original output");
      expect(await Bun.file(capture.cwd).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed model output and CLI failures without logging their secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-classifier-invalid-"));
    const logs: string[] = [];
    const logging = spyOn(console, "log").mockImplementation((message) =>
      logs.push(String(message)),
    );
    try {
      const executable = join(dir, "fake-codex");
      for (const [text, code] of [
        ["not JSON", 0],
        ['{"verdicts":[true]}', 0],
        ['{"verdicts":[1,0]}', 0],
        ['{"verdicts":[true,false]}', 1],
      ] as const) {
        await writeFile(
          executable,
          `#!${process.execPath}
import { writeFileSync } from 'node:fs';
await Bun.stdin.text();
const args = process.argv.slice(2);
writeFileSync(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(text)});
console.error(process.env.CODEX_API_KEY);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(text)}}}));
console.log(JSON.stringify({type:'turn.completed'}));
process.exit(${code});
`,
        );
        await chmod(executable, 0o700);
        expect(
          await classifyComments(["review", "probe"], {
            env: {
              ...process.env,
              OPENAI_API_KEY: "fake-not-a-key",
              INPUT_PATH_TO_CODEX_EXECUTABLE: executable,
            },
          }),
        ).toBeNull();
      }
      expect(logs.join("\n")).not.toContain("fake-not-a-key");
      expect(logs).toHaveLength(4);
    } finally {
      logging.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the original classification flag and contains no Anthropic runtime import or API", async () => {
    const entrypoint = await readFile(
      new URL(
        "../src/entrypoints/post-buffered-inline-comments.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const server = await readFile(
      new URL("../src/mcp/github-inline-comment-server.ts", import.meta.url),
      "utf8",
    );
    expect(entrypoint).not.toMatch(
      /ANTHROPIC_API_KEY|api\.anthropic\.com|@anthropic-ai/,
    );
    expect(server).toMatch(
      /process\.env\.CLASSIFY_INLINE_COMMENTS\s*\?\?\s*process\.env\.BUFFER_INLINE_COMMENTS/,
    );
    expect(server).toContain(
      "confirmed === false || (CLASSIFY_ENABLED && confirmed !== true)",
    );
  });
});
