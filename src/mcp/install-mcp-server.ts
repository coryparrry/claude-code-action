import * as core from "@actions/core";
import { GITHUB_API_URL } from "../github/api/config";
import type { GitHubContext } from "../github/context";
import { isEntityContext } from "../github/context";
import { Octokit } from "@octokit/rest";
import type { AutoDetectedMode } from "../modes/detector";

type PrepareConfigParams = {
  githubToken: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  claudeCommentId?: string;
  mode: AutoDetectedMode;
  context: GitHubContext;
};

// Build the bun invocation for one of the action's own MCP servers. The
// flags mirror the entrypoint invocation in action.yml so the server process
// reads its runtime config from the action directory rather than from the
// process working directory.
function bunServerArgs(scriptPath: string): string[] {
  const actionPath = process.env.GITHUB_ACTION_PATH;
  return [
    "--no-env-file",
    `--config=${actionPath}/bunfig.toml`,
    "run",
    `${actionPath}/${scriptPath}`,
  ];
}

async function checkActionsReadPermission(
  token: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const client = new Octokit({ auth: token, baseUrl: GITHUB_API_URL });

    // Try to list workflow runs - this requires actions:read
    // We use per_page=1 to minimize the response size
    await client.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: 1,
    });

    return true;
  } catch (error: any) {
    // Check if it's a permission error
    if (
      error.status === 403 &&
      error.message?.includes("Resource not accessible")
    ) {
      return false;
    }

    // For other errors (network issues, etc), log but don't fail
    core.debug(`Failed to check actions permission: ${error.message}`);
    return false;
  }
}

export async function prepareMcpConfig(
  params: PrepareConfigParams,
): Promise<string> {
  const {
    githubToken,
    owner,
    repo,
    branch,
    baseBranch,
    claudeCommentId,
    context,
  } = params;
  try {
    const baseMcpConfig: { mcpServers: Record<string, unknown> } = {
      mcpServers: {},
    };

    // Tracking comments exist only in mention mode.
    if (claudeCommentId) {
      baseMcpConfig.mcpServers.github_comment = {
        command: "bun",
        args: bunServerArgs("src/mcp/github-comment-server.ts"),
        env: {
          GITHUB_TOKEN: githubToken,
          REPO_OWNER: owner,
          REPO_NAME: repo,
          ...(claudeCommentId && { CODEX_COMMENT_ID: claudeCommentId }),
          GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME || "",
          GITHUB_API_URL: GITHUB_API_URL,
        },
      };
    }

    // Include file ops server when commit signing is enabled
    if (context.inputs.useCommitSigning) {
      baseMcpConfig.mcpServers.github_file_ops = {
        command: "bun",
        args: bunServerArgs("src/mcp/github-file-ops-server.ts"),
        env: {
          GITHUB_TOKEN: githubToken,
          REPO_OWNER: owner,
          REPO_NAME: repo,
          BRANCH_NAME: branch,
          BASE_BRANCH: baseBranch,
          REPO_DIR: process.env.GITHUB_WORKSPACE || process.cwd(),
          GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME || "",
          IS_PR: process.env.IS_PR || "false",
          GITHUB_API_URL: GITHUB_API_URL,
        },
      };
    }

    // Inline review tools are available for PR tasks in either mode.
    if (isEntityContext(context) && context.isPR) {
      baseMcpConfig.mcpServers.github_inline_comment = {
        command: "bun",
        args: bunServerArgs("src/mcp/github-inline-comment-server.ts"),
        env: {
          GITHUB_TOKEN: githubToken,
          REPO_OWNER: owner,
          REPO_NAME: repo,
          PR_NUMBER: context.entityNumber?.toString() || "",
          GITHUB_API_URL: GITHUB_API_URL,
          BUFFER_INLINE_COMMENTS: context.inputs.bufferInlineComments
            ? "true"
            : "false",
        },
      };
    }

    // CI reads require an explicit actions:read grant on the workflow token.
    const shouldIncludeCIServer =
      isEntityContext(context) &&
      context.isPR &&
      !!process.env.DEFAULT_WORKFLOW_TOKEN;

    if (shouldIncludeCIServer) {
      // Verify the token actually has actions:read permission
      const actuallyHasPermission = await checkActionsReadPermission(
        process.env.DEFAULT_WORKFLOW_TOKEN || "",
        owner,
        repo,
      );

      if (!actuallyHasPermission) {
        core.warning(
          "The github_ci MCP server requires 'actions: read' permission. " +
            "Skipping CI server installation. " +
            "To enable CI status checks, add 'actions: read' to your workflow permissions. " +
            "See: https://docs.github.com/en/actions/security-guides/automatic-token-authentication#permissions-for-the-github_token",
        );
      } else {
        baseMcpConfig.mcpServers.github_ci = {
          command: "bun",
          args: bunServerArgs("src/mcp/github-actions-server.ts"),
          env: {
            // Use workflow github token, not app token
            GITHUB_TOKEN: process.env.DEFAULT_WORKFLOW_TOKEN,
            REPO_OWNER: owner,
            REPO_NAME: repo,
            PR_NUMBER: context.entityNumber?.toString() || "",
            RUNNER_TEMP: process.env.RUNNER_TEMP || "/tmp",
          },
        };
      }
    }

    return JSON.stringify(baseMcpConfig, null, 2);
  } catch (error) {
    core.setFailed(`Install MCP server failed with error: ${error}`);
    process.exit(1);
  }
}
