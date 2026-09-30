import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { prepareMcpConfig } from "../src/mcp/install-mcp-server";
import { createMockContext } from "./mockContext";

const originalEnv = { ...process.env };
let fetchSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  process.env.GITHUB_ACTION_PATH = "/test/action/path";
  delete process.env.DEFAULT_WORKFLOW_TOKEN;
  fetchSpy = spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }),
  );
});
afterEach(() => {
  fetchSpy.mockRestore();
  process.env = { ...originalEnv };
});

async function config(
  options: {
    pr?: boolean;
    tracking?: boolean;
    signing?: boolean;
    buffer?: boolean;
    agent?: boolean;
  } = {},
) {
  const context = createMockContext({
    isPR: options.pr ?? false,
    entityNumber: 123,
    inputs: {
      useCommitSigning: options.signing ?? false,
      bufferInlineComments: options.buffer ?? true,
    },
  });
  return JSON.parse(
    await prepareMcpConfig({
      githubToken: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      branch: "codex/task",
      baseBranch: "main",
      claudeCommentId: options.tracking ? "123" : undefined,
      mode: options.agent ? "agent" : "tag",
      context,
    }),
  ).mcpServers;
}

describe("Codex GitHub MCP configuration", () => {
  test("provides a scoped tracking comment tool and hermetic Bun arguments", async () => {
    const servers = await config({ tracking: true });
    expect(Object.keys(servers)).toEqual(["github_comment"]);
    expect(servers.github_comment.env.CODEX_COMMENT_ID).toBe("123");
    expect(servers.github_comment.env.GITHUB_TOKEN).toBe("test-token");
    expect(servers.github_comment.args).toEqual([
      "--no-env-file",
      "--config=/test/action/path/bunfig.toml",
      "run",
      "/test/action/path/src/mcp/github-comment-server.ts",
    ]);
  });
  test("does not provide an unusable tracking tool for automated prompts", async () => {
    expect(await config({ agent: true })).toEqual({});
  });
  for (const agent of [false, true]) {
    test(`provides PR inline review tools in ${agent ? "automated" : "mention"} mode`, async () => {
      const servers = await config({ pr: true, agent });
      expect(servers.github_inline_comment.env.PR_NUMBER).toBe("123");
      expect(servers.github_inline_comment.env.BUFFER_INLINE_COMMENTS).toBe(
        "true",
      );
      expect(
        servers.github_inline_comment.env.ANTHROPIC_API_KEY,
      ).toBeUndefined();
    });
  }
  test("honors explicit immediate-comment configuration", async () => {
    const servers = await config({ pr: true, buffer: false });
    expect(servers.github_inline_comment.env.BUFFER_INLINE_COMMENTS).toBe(
      "false",
    );
  });
  test("registers the file operation server when API signing is enabled", async () => {
    const servers = await config({ signing: true });
    expect(servers.github_file_ops.env.BRANCH_NAME).toBe("codex/task");
    expect(servers.github_file_ops.env.GITHUB_TOKEN).toBe("test-token");
  });
  test("adds CI reads only when workflow token has actions access", async () => {
    process.env.DEFAULT_WORKFLOW_TOKEN = "workflow-token";
    const servers = await config({ pr: true, agent: true });
    expect(servers.github_ci.env.GITHUB_TOKEN).toBe("workflow-token");
    expect(fetchSpy).toHaveBeenCalled();
  });
  test("omits CI tools when token lacks actions access", async () => {
    process.env.DEFAULT_WORKFLOW_TOKEN = "workflow-token";
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ message: "Resource not accessible by integration" }),
        { status: 403 },
      ),
    );
    expect((await config({ pr: true })).github_ci).toBeUndefined();
  });
});
