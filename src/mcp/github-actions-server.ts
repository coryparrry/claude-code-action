#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GITHUB_API_URL } from "../github/api/config";
import { mkdir, writeFile } from "fs/promises";
import { redactSecrets } from "../github/utils/sanitizer";
import { Octokit } from "@octokit/rest";
import { getCIStatus, getWorkflowRunDetails } from "./github-actions-context";

const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const PR_NUMBER = process.env.PR_NUMBER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const RUNNER_TEMP = process.env.RUNNER_TEMP || "/tmp";

// Job logs are fetched by ID from GitHub-hosted storage; bound the request so a
// stalled fetch can't hang this MCP call forever. Mirrors the timeout added to
// fetchImage() in src/github/utils/image-downloader.ts (#1625).
const DOWNLOAD_JOB_LOG_TIMEOUT_MS = 30_000;

if (import.meta.main) {
  if (!REPO_OWNER || !REPO_NAME || !PR_NUMBER || !GITHUB_TOKEN) {
    console.error(
      "[GitHub CI Server] Error: REPO_OWNER, REPO_NAME, PR_NUMBER, and GITHUB_TOKEN environment variables are required",
    );
    process.exit(1);
  }
}

const server = new McpServer({
  name: "GitHub CI Server",
  version: "0.0.1",
});

console.error("[GitHub CI Server] MCP Server instance created");

server.tool(
  "get_ci_status",
  "Get current PR head SHA and independent workflow runs; duplicate attempts of the same run are collapsed",
  {
    status: z
      .enum([
        "completed",
        "action_required",
        "cancelled",
        "failure",
        "neutral",
        "skipped",
        "stale",
        "success",
        "timed_out",
        "in_progress",
        "queued",
        "requested",
        "waiting",
        "pending",
      ])
      .optional()
      .describe("Filter workflow runs by status"),
  },
  async ({ status }) => {
    try {
      const client = new Octokit({
        auth: GITHUB_TOKEN,
        baseUrl: GITHUB_API_URL,
      });

      const result = await getCIStatus(
        client,
        {
          owner: REPO_OWNER!,
          repo: REPO_NAME!,
          pull_number: parseInt(PR_NUMBER!, 10),
        },
        status,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

server.tool(
  "get_workflow_run_details",
  "Get workflow jobs and steps, including head SHA and whether this run matches the current PR revision",
  {
    run_id: z.number().describe("The workflow run ID"),
  },
  async ({ run_id }) => {
    try {
      const client = new Octokit({
        auth: GITHUB_TOKEN,
        baseUrl: GITHUB_API_URL,
      });

      const result = await getWorkflowRunDetails(client, {
        owner: REPO_OWNER!,
        repo: REPO_NAME!,
        pull_number: parseInt(PR_NUMBER!, 10),
        run_id,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

/** Download a bounded-time log and return paginated, redacted UTF-8 evidence directly. */
export async function downloadJobLog(
  client: Octokit,
  params: { owner: string; repo: string; job_id: number },
  runnerTemp: string,
  timeoutMs: number = DOWNLOAD_JOB_LOG_TIMEOUT_MS,
  chunk: { offset?: number; maxBytes?: number } = {},
) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await client.actions.downloadJobLogsForWorkflowRun({
      owner: params.owner,
      repo: params.repo,
      job_id: params.job_id,
      request: { signal: controller.signal },
    });

    const logsText =
      typeof response.data === "string"
        ? response.data
        : Buffer.from(response.data as unknown as ArrayBuffer).toString("utf8");

    const logsDir = `${runnerTemp}/github-ci-logs`;
    await mkdir(logsDir, { recursive: true });

    const logPath = `${logsDir}/job-${params.job_id}.log`;
    const redactedLogs = redactSecrets(logsText);
    await writeFile(logPath, redactedLogs, "utf-8");

    const text = Buffer.from(redactedLogs);
    const maxBytes = Math.max(256, Math.min(chunk.maxBytes ?? 16_000, 24_000));
    let offset = Math.max(
      0,
      Math.min(
        chunk.offset ?? Math.max(0, text.length - maxBytes),
        text.length,
      ),
    );
    while (offset < text.length && (text[offset]! & 0xc0) === 0x80) offset++;
    const end = Math.min(text.length, offset + maxBytes);
    const excerpt = new TextDecoder().decode(text.subarray(offset, end), {
      stream: end < text.length,
    });
    const consumed = Buffer.byteLength(excerpt);
    return {
      path: logPath,
      excerpt,
      offset,
      total_text_bytes: text.length,
      next_offset: offset + consumed < text.length ? offset + consumed : null,
      size_bytes: text.length,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

server.tool(
  "download_job_log",
  "Download a job log and return a bounded readable excerpt. The artifact path need not be read with file tools; use offset to inspect another chunk.",
  {
    job_id: z.number().int().positive().describe("The job ID"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Byte offset in the redacted text; omitted starts near the end",
      ),
    max_bytes: z.number().int().min(256).max(24000).optional(),
  },
  async ({ job_id, offset, max_bytes }) => {
    try {
      const client = new Octokit({
        auth: GITHUB_TOKEN,
        baseUrl: GITHUB_API_URL,
      });

      const result = await downloadJobLog(
        client,
        { owner: REPO_OWNER!, repo: REPO_NAME!, job_id },
        RUNNER_TEMP,
        DOWNLOAD_JOB_LOG_TIMEOUT_MS,
        { offset, maxBytes: max_bytes },
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        content: [
          {
            type: "text",
            text: `Error: ${errorMessage}`,
          },
        ],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

async function runServer() {
  try {
    const transport = new StdioServerTransport();

    await server.connect(transport);

    process.on("exit", () => {
      server.close();
    });
  } catch (error) {
    throw error;
  }
}

if (import.meta.main) {
  runServer().catch(() => {
    process.exit(1);
  });
}
