import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TaskGit } from "../github/operations/task-git";

/** Serve restricted Git operations; no model-controlled shell command is executed. */
export async function runGitServer() {
  const git = new TaskGit({
    repoDir: process.env.REPO_DIR || process.cwd(),
    branch: process.env.BRANCH_NAME || "",
    baseBranch: process.env.BASE_BRANCH || "main",
    receiptFile: process.env.CODEX_GIT_DELIVERY_RECEIPT,
    readOnly: process.env.GIT_READ_ONLY === "true",
  });
  const server = new McpServer({ name: "GitHub Git Server", version: "1.0.0" });
  /** Adapt bounded Git results and failures to the MCP response contract. */
  const execute = async (operation: () => unknown | Promise<unknown>) => {
    try {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(await operation()) },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: String(error instanceof Error ? error.message : error),
          },
        ],
      };
    }
  };
  server.tool(
    "get_status",
    "Get the prepared branch and repository working-tree state",
    {},
    () => execute(() => git.status()),
  );
  server.tool(
    "get_diff",
    "Read a bounded repository diff; arbitrary refs, outside paths and external diff programs are unavailable",
    {
      staged: z.boolean().optional(),
      base: z.boolean().optional(),
      paths: z.array(z.string()).max(100).optional(),
    },
    (options) => execute(() => git.diff(options)),
  );
  if (process.env.GIT_READ_ONLY !== "true") {
    server.tool(
      "commit_files",
      "Commit only selected repository files; message is literal data and unrelated staging is preserved",
      {
        files: z.array(z.string()).min(1).max(100),
        message: z.string().min(1).max(32_000),
      },
      ({ files, message }) => execute(() => git.commit(files, message)),
    );
    server.tool(
      "delete_files",
      "Delete and commit explicit repository files, preserving unrelated staging",
      {
        files: z.array(z.string()).min(1).max(100),
        message: z.string().min(1).max(32_000),
      },
      ({ files, message }) => execute(() => git.remove(files, message)),
    );
    server.tool(
      "push",
      "Push the current commit to the prepared branch on origin",
      {},
      () => execute(() => git.push()),
    );
  }
  await server.connect(new StdioServerTransport());
}

if (import.meta.main)
  runGitServer().catch(() => {
    process.exitCode = 1;
  });
