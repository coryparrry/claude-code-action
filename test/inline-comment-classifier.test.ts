import { describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyComments,
  selectCommentsToPost,
  type BufferedComment,
} from "../src/entrypoints/post-buffered-inline-comments";

type ModelRequest = {
  model: string;
  store: boolean;
  tools?: unknown[];
  text: {
    format: {
      type: string;
      schema: { properties: { verdicts: { items: { type: string } } } };
    };
  };
};

function modelResponse(text: string): Response {
  return Response.json({
    id: "response-offline",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5.3-codex",
    output: [
      {
        id: "message-offline",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 4,
      output_tokens: 3,
      total_tokens: 7,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
}

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

  it("runs the actual Agents SDK against an offline endpoint without ambient settings, tools, or report writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inline-classifier-test-"));
    const requests: Array<{
      body: ModelRequest;
      authorization: string | null;
      path: string;
    }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.push({
          body: (await request.json()) as ModelRequest,
          authorization: request.headers.get("authorization"),
          path: new URL(request.url).pathname,
        });
        return modelResponse(JSON.stringify({ verdicts: [true, false] }));
      },
    });
    try {
      const mainReport = join(dir, "codex-execution-output.json");
      const actionOutput = join(dir, "action-output.txt");
      const marker = join(dir, "hook-ran");
      await writeFile(mainReport, "original report");
      await writeFile(actionOutput, "original output");
      await mkdir(join(dir, ".codex"));
      await writeFile(
        join(dir, "AGENTS.md"),
        "AMBIENT_USER_INSTRUCTIONS must not enter classifier",
      );
      await writeFile(
        join(dir, ".codex", "settings.json"),
        JSON.stringify({
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: `touch '${marker}'` }] },
            ],
          },
          enabledPlugins: { "missing-plugin@missing-marketplace": true },
          mcpServers: { malicious: { command: "missing-mcp-command" } },
        }),
      );
      const env = {
        ...process.env,
        OPENAI_API_KEY: "offline-api-key",
        OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        HOME: dir,
        CODEX_HOME: join(dir, ".codex"),
        OPENAI_AGENTS_DISABLE_TRACING: "1",
        GITHUB_TOKEN: "github-secret-should-not-reach-sdk",
        GITHUB_OUTPUT: actionOutput,
        RUNNER_TEMP: dir,
        INPUT_CODEX_MODEL: "",
        INPUT_CODEX_EFFORT: "low",
        INPUT_MCP_CONFIG: '{"mcpServers":{"dangerous":{"command":"bad"}}}',
        INPUT_PLUGINS: "missing-plugin@missing-marketplace",
        INPUT_PLUGIN_MARKETPLACES: "missing-marketplace",
        INPUT_SETTINGS: '{"hooks":{"SessionStart":"bad"}}',
        INPUT_CODEX_ARGS: "--tools Bash --setting-sources user",
        INPUT_PROMPT: "must not inherit the main prompt",
      };
      const reviewComments = [
        { ...comments[0]!, body: "This dereferences null offline-api-key" },
        ...comments.slice(1),
      ];
      expect(
        await selectCommentsToPost(reviewComments, (bodies) =>
          classifyComments(bodies, { env }),
        ),
      ).toEqual([reviewComments[0]!]);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.path).toBe("/v1/responses");
      expect(request.authorization).toBe("Bearer offline-api-key");
      expect(request.body.model).toBe("gpt-5.3-codex");
      expect(request.body.store).toBe(false);
      expect(request.body.tools ?? []).toEqual([]);
      expect(request.body.text.format.type).toBe("json_schema");
      expect(
        request.body.text.format.schema.properties.verdicts.items.type,
      ).toBe("boolean");
      const input = JSON.stringify(request.body);
      expect(input).toContain("This dereferences null");
      for (const forbidden of [
        "offline-api-key",
        "Never post",
        "AMBIENT_USER_INSTRUCTIONS",
        "must not inherit the main prompt",
        "github-secret-should-not-reach-sdk",
        "missing-plugin",
        "missing-mcp-command",
      ])
        expect(input).not.toContain(forbidden);
      expect(await readFile(mainReport, "utf8")).toBe("original report");
      expect(await readFile(actionOutput, "utf8")).toBe("original output");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      server.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back for invalid model output and SDK API errors without logging authentication", async () => {
    let text = "not JSON";
    let status = 200;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return status === 200
          ? modelResponse(text)
          : Response.json(
              {
                error: {
                  message: "offline-api-key",
                  type: "invalid_request_error",
                },
              },
              { status },
            );
      },
    });
    const logs: string[] = [];
    const logging = spyOn(console, "log").mockImplementation((message) =>
      logs.push(String(message)),
    );
    try {
      for (const [output, code] of [
        ["not JSON", 200],
        ['{"verdicts":[true]}', 200],
        ['{"verdicts":[1,0]}', 200],
        ['{"verdicts":[true,false]}', 400],
      ] as const) {
        text = output;
        status = code;
        expect(
          await selectCommentsToPost(comments, (bodies) =>
            classifyComments(bodies, {
              env: {
                ...process.env,
                OPENAI_API_KEY: "offline-api-key",
                OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
              },
            }),
          ),
        ).toEqual(comments.slice(0, 2));
      }
      expect(logs.join("\n")).not.toContain("offline-api-key");
      expect(logs).toHaveLength(4);
    } finally {
      logging.mockRestore();
      server.stop(true);
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
