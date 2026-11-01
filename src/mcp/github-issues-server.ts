#!/usr/bin/env bun
/** Repository-scoped issue creation for explicitly requested GitHub work. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { GITHUB_API_URL } from "../github/api/config";
import { redactSecrets, sanitizeContent } from "../github/utils/sanitizer";

export const issueInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(256),
  body: z
    .string()
    .max(65536)
    .refine(
      (value) => Buffer.byteLength(value) <= 65536,
      "Issue body exceeds its byte budget",
    ),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
});
type IssueInput = z.infer<typeof issueInputSchema>;
type RepositoryScope = { owner: string; repo: string };

/** Validate the immutable repository scope supplied by the action, never the model. */
function validateScope(scope: RepositoryScope): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(scope.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(scope.repo) ||
    [".", ".."].includes(scope.repo)
  )
    throw new Error("Invalid issue repository scope");
}

/** Create one issue; never automatically retry a potentially completed POST. */
export async function createRepositoryIssue(
  client: Octokit,
  scope: RepositoryScope,
  input: IssueInput,
) {
  validateScope(scope);
  const parsed = issueInputSchema.parse(input);
  const payload = issueInputSchema.parse({
    ...parsed,
    title: redactSecrets(sanitizeContent(parsed.title)).trim(),
    body: redactSecrets(sanitizeContent(parsed.body)),
  });
  const result = await client.rest.issues.create({
    ...payload,
    ...scope,
    request: { timeout: 15000 },
  });
  return {
    number: result.data.number,
    title: result.data.title,
    url: result.data.html_url,
  };
}

/** Explain recoverable configuration errors without reflecting credentials or payloads. */
export function issueCreationError(error: unknown): string {
  if (error instanceof z.ZodError)
    return "Invalid issue title, body or labels; no issue was created.";
  const status =
    error && typeof error === "object" && "status" in error
      ? error.status
      : undefined;
  if (status === 410)
    return "Issues are disabled for this repository. Enable Issues in repository settings before requesting creation.";
  if (status === 401 || status === 403)
    return "Issue creation needs a valid token with issues: write permission. Check workflow or GitHub App permissions.";
  if (status === 404)
    return "The repository or its Issues feature is unavailable to this token. Check repository access and Issues settings.";
  if (status === 422)
    return "GitHub rejected the issue input. Check the title, body and existing repository label names.";
  return "Issue creation could not be confirmed. Inspect the repository's issues before trying again; the POST was not retried automatically.";
}

/** Expose one scoped write tool and reuse identical calls within this server process. */
export function createIssueServer(
  client: Octokit,
  scope: RepositoryScope,
): McpServer {
  validateScope(scope);
  const server = new McpServer({
    name: "GitHub Issues Server",
    version: "1.0.0",
  });
  const attempts = new Map<
    string,
    Promise<Awaited<ReturnType<typeof createRepositoryIssue>>>
  >();
  server.tool(
    "create_issue",
    "Open an issue in this workflow's repository only when the user requests it. Returns the confirmed issue URL. Identical calls in this action process reuse their first result; uncertain failures must be checked on GitHub before a new attempt.",
    issueInputSchema.shape,
    async (input) => {
      try {
        const key = JSON.stringify(input);
        if (!attempts.has(key)) {
          if (attempts.size >= 100)
            throw new Error("Issue attempt limit reached");
          attempts.set(key, createRepositoryIssue(client, scope, input));
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(await attempts.get(key)),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: issueCreationError(error) }],
        };
      }
    },
  );
  return server;
}

/** Start the MCP transport with action-owned repository identity and credentials. */
async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  if (!token || !owner || !repo)
    throw new Error(
      "Issue creation requires GITHUB_TOKEN, REPO_OWNER and REPO_NAME",
    );
  const server = createIssueServer(
    new Octokit({ auth: token, baseUrl: GITHUB_API_URL }),
    { owner, repo },
  );
  await server.connect(new StdioServerTransport());
}

if (import.meta.main)
  main().catch(() => {
    console.error(
      "Issue server could not start; check its action-owned configuration.",
    );
    process.exitCode = 1;
  });
