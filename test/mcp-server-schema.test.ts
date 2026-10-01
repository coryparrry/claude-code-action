import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Load the production servers over the real protocol without invoking GitHub.
// This catches MCP/Zod version mismatches that source-level schema tests miss.
test.each([
  "github-comment-server.ts",
  "github-inline-comment-server.ts",
  "github-file-ops-server.ts",
  "github-actions-server.ts",
])("%s exposes valid tool schemas over stdio", async (file) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-github-mcp-"));
  const client = new Client({
    name: "offline-schema-fixture",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "..", "src", "mcp", file)],
    cwd: directory,
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: directory,
      REPO_OWNER: "fixture-owner",
      REPO_NAME: "fixture-repo",
      PR_NUMBER: "1",
      BRANCH_NAME: "fixture-branch",
      REPO_DIR: directory,
      RUNNER_TEMP: directory,
      GITHUB_TOKEN: "offline-fixture-value-only",
    },
  });
  try {
    await client.connect(transport);
    const result = await client.listTools();
    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(typeof tool.inputSchema.properties).toBe("object");
    }
  } finally {
    await client.close();
    await transport.close();
    await rm(directory, { recursive: true, force: true });
  }
});
