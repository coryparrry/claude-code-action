import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "inline-integration-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function githubFixture() {
  const lines: number[] = [];
  const models: string[] = [];
  const events: string[] = [];
  let trackingBody = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/v1/responses") {
        const input = (await request.json()) as { model: string };
        models.push(input.model);
        events.push("classify");
        return Response.json({
          id: "fixture-response",
          object: "response",
          status: "completed",
          model: input.model,
          output: [
            {
              id: "fixture-message",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: '{"verdicts":[true]}',
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }
      if (request.method === "POST" && path.endsWith("/pulls/12/comments")) {
        const comment = (await request.json()) as {
          line: number;
          path: string;
        };
        lines.push(comment.line);
        events.push("inline");
        if (comment.line === 124) {
          return Response.json(
            {
              message: "Validation Failed",
              errors: [{ field: "line", message: "could not be resolved" }],
            },
            { status: 422 },
          );
        }
        return Response.json(
          {
            id: 123,
            html_url: "https://github.com/owner/repo/pull/12#discussion_r123",
            path: comment.path,
            line: comment.line,
          },
          { status: 201 },
        );
      }
      if (path.endsWith("/issues/comments/45")) {
        if (request.method === "PATCH") {
          trackingBody = ((await request.json()) as { body: string }).body;
          events.push("tracking");
        }
        return Response.json({ id: 45, body: "Codex is working…\nFinding." });
      }
      if (path.endsWith("/pulls/12")) {
        return Response.json({
          head: { sha: "a".repeat(40), repo: { full_name: "owner/repo" } },
          base: { repo: { full_name: "owner/repo" } },
        });
      }
      return Response.json(
        { message: `Unexpected ${request.method} ${path}` },
        { status: 404 },
      );
    },
  });
  return { server, lines, models, events, body: () => trackingBody };
}

function environment(apiUrl: string) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: directory,
    RUNNER_TEMP: directory,
    GITHUB_API_URL: apiUrl,
    GITHUB_TOKEN: "offline-fixture-token",
    REPO_OWNER: "owner",
    REPO_NAME: "repo",
    PR_NUMBER: "12",
  };
}

test("upstream immediate-post tool exposes invalid lines and confirms a corrected comment", async () => {
  const fixture = githubFixture();
  const buffer = join(directory, "comments.jsonl");
  await writeFile(buffer, "");
  const client = new Client({ name: "delivery-fixture", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--no-env-file",
      join(root, "src/mcp/github-inline-comment-server.ts"),
    ],
    stderr: "ignore",
    env: {
      ...environment(fixture.server.url.toString()),
      CODEX_INLINE_COMMENTS_BUFFER: buffer,
      CLASSIFY_INLINE_COMMENTS: "true",
    },
  });
  try {
    await client.connect(transport);
    const call = (line: number) =>
      client.callTool({
        name: "create_inline_comment",
        arguments: {
          path: "src/main.ts",
          line,
          body: "Fix this bug",
          confirmed: true,
        },
      });
    const rejected = await call(124);
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain("Validation Failed");
    const posted = await call(3);
    expect(posted.isError).not.toBe(true);
    expect(JSON.stringify(posted.content)).toContain("discussion_r123");
    expect(fixture.lines).toEqual([124, 3]);
    expect(await readFile(buffer, "utf8")).toBe("");
  } finally {
    await client.close();
    await transport.close();
    fixture.server.stop(true);
  }
}, 15000);

test.each([3, 124])(
  "root action finalizes tracking after buffered line %i delivery",
  async (line) => {
    const fixture = githubFixture();
    const event = join(directory, "event.json");
    const output = join(directory, "output.txt");
    const preload = join(directory, "fixture.ts");
    await writeFile(
      event,
      JSON.stringify({
        action: "synchronize",
        number: 12,
        repository: {
          full_name: "owner/repo",
          name: "repo",
          owner: { login: "owner" },
          default_branch: "main",
        },
        pull_request: {
          number: 12,
          body: "",
          head: { sha: "a".repeat(40), repo: { full_name: "owner/repo" } },
          base: { ref: "main", repo: { full_name: "owner/repo" } },
        },
      }),
    );
    await writeFile(output, "");
    // Isolate preparation and model inference; orchestration, HTTP delivery,
    // Action outputs and the inherited tracking renderer all execute for real.
    await writeFile(
      preload,
      `
    import { mock } from "bun:test";
    import { mkdir, writeFile } from "node:fs/promises";
    const root = ${JSON.stringify(root)};
    mock.module(root + "/src/github/token.ts", () => ({ setupGitHubToken: async () => "offline-fixture-token", hasMintedGitHubAppToken: () => false }));
    mock.module(root + "/src/github/validation/permissions.ts", () => ({ checkWritePermissions: async () => true }));
    mock.module(root + "/src/codex-install.ts", () => ({ validateCodexInputs: () => {} }));
    mock.module(root + "/src/github/operations/restore-config.ts", () => ({ restoreConfigFromBase: () => [] }));
    mock.module(root + "/src/modes/tag/index.ts", () => ({ prepareTagMode: async () => {
      await mkdir(process.env.RUNNER_TEMP + "/codex-prompts", { recursive: true });
      await writeFile(process.env.RUNNER_TEMP + "/codex-prompts/codex-prompt.txt", "Review this change");
      return { commentId: 45, branchInfo: { baseBranch: "main" }, claudeArgs: "" };
    } }));
    mock.module(root + "/base-action/src/run-codex.ts", () => ({ runCodex: async () => {
      await writeFile(process.env.CODEX_INLINE_COMMENTS_BUFFER, JSON.stringify({ ts: "now", path: "src/main.ts", line: ${line}, body: "Fix this bug" }) + "\\n");
      const executionFile = process.env.RUNNER_TEMP + "/codex-execution-output.json";
      await writeFile(executionFile, JSON.stringify([{ type: "result", duration_ms: 1, is_error: false }]));
      return { conclusion: "success", executionFile };
    } }));
  `,
    );
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "--no-env-file",
        "--preload",
        preload,
        join(root, "src/entrypoints/run.ts"),
      ],
      cwd: directory,
      env: {
        ...environment(fixture.server.url.toString()),
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: event,
        GITHUB_ACTOR: "owner",
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_RUN_ID: "1",
        GITHUB_OUTPUT: output,
        TRACK_PROGRESS: "true",
        PROMPT: "Review this change",
        OPENAI_API_KEY: "offline-classifier-fixture-key",
        OPENAI_BASE_URL: fixture.server.url.toString() + "v1",
        CODEX_MODEL: "fixture-review-model",
        CODEX_EFFORT: "low",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 8000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stdout + stderr).toContain("Posted");
      expect(code).toBe(line === 124 ? 1 : 0);
      const conclusions = [
        ...(await readFile(output, "utf8")).matchAll(
          /conclusion<<[^\n]+\n([^\n]+)/g,
        ),
      ];
      expect(conclusions.at(-1)?.[1]).toBe(
        line === 124 ? "failure" : "success",
      );
      expect(fixture.events).toEqual(["classify", "inline", "tracking"]);
      expect(fixture.models).toEqual(["fixture-review-model"]);
      expect(fixture.body()).toContain(
        line === 124 ? "Codex encountered an error" : "Codex finished",
      );
      if (line === 124)
        expect(fixture.body()).toContain("Inline feedback delivery failed");
    } finally {
      clearTimeout(timeout);
      child.kill();
      fixture.server.stop(true);
    }
  },
  15000,
);
