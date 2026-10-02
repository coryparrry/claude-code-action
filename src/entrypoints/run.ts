#!/usr/bin/env bun

import { usesApiCommitSigning } from "../github/operations/commit-signing";

/**
 * Unified entrypoint for the Codex GitHub Action.
 * Merges all previously separate action.yml steps (prepare, install, run, cleanup)
 * into a single TypeScript orchestrator.
 */

import * as core from "@actions/core";
import { appendFile, rm } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { setupGitHubToken, hasMintedGitHubAppToken } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import {
  assertNoForkPullRequests,
  ForkPullRequestError,
} from "../github/validation/forks";
import { validateCodexInputs } from "../codex-install";
import { runCodex } from "../../base-action/src/run-codex";
import { createOctokit } from "../github/api/client";
import type { Octokits } from "../github/api/client";
import {
  parseGitHubContext,
  isEntityContext,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
  isWorkflowRunEvent,
} from "../github/context";
import type { GitHubContext } from "../github/context";
import { detectMode } from "../modes/detector";
import { prepareTagMode } from "../modes/tag";
import { prepareAgentMode } from "../modes/agent";
import { checkContainsTrigger } from "../github/validation/trigger";
import { restoreConfigFromBase } from "../github/operations/restore-config";
import { validateBranchName } from "../github/operations/branch";
import { actionRuntimeOptions } from "./runtime-options";
import { initializeInlineCommentBuffer } from "../mcp/inline-comment-buffer";
import { collectActionInputsPresence } from "./collect-inputs";
import { updateCommentLink } from "./update-comment-link";
import { main as postBufferedInlineComments } from "./post-buffered-inline-comments";
import { formatTurnsFromData } from "./format-turns";
import type { Turn } from "./format-turns";
import { redactSecrets } from "../github/utils/sanitizer";
import { preparePrompt } from "../../base-action/src/prepare-prompt";
import type { CodexRunResult } from "../../base-action/src/run-codex";
import {
  getExecutionFilePath,
  setExecutionFileOutputIfPresent,
} from "../../base-action/src/execution-file";

/**
 * Write the step summary from Codex's execution output file.
 */
async function writeStepSummary(executionFile: string): Promise<void> {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  try {
    const fileContent = readFileSync(executionFile, "utf-8");
    const data: Turn[] = JSON.parse(fileContent);
    const markdown = formatTurnsFromData(data);
    await appendFile(summaryFile, markdown);
    console.log("Successfully formatted Codex report");
  } catch (error) {
    console.error(`Failed to format output: ${error}`);
    // Fall back to raw JSON
    try {
      let fallback = "# Codex Report\n\n";
      fallback +=
        "Failed to format output (please report). Here's the raw JSON:\n\n";
      fallback += "```json\n";
      fallback += redactSecrets(readFileSync(executionFile, "utf-8"));
      fallback += "\n```\n";
      await appendFile(summaryFile, fallback);
    } catch {
      console.error("Failed to write raw output to step summary");
    }
  }
}

async function run() {
  let deliveryError: string | undefined;
  let githubToken: string | undefined;
  let commentId: number | undefined;
  let claudeBranch: string | undefined;
  let baseBranch: string | undefined;
  let executionFile: string | undefined;
  let claudeSuccess = false;
  let prepareSuccess = true;
  let prepareError: string | undefined;
  let context: GitHubContext | undefined;
  let octokit: Octokits | undefined;
  // Paths reverted to the PR base branch, which cleanup must not commit back
  // onto the PR author's branch. Empty unless restoreConfigFromBase ran.
  let restoredConfigPaths: string[] = [];
  // Track whether we've completed prepare phase, so we can attribute errors correctly
  let prepareCompleted = false;
  try {
    core.exportVariable(
      "CODEX_INLINE_COMMENTS_BUFFER",
      initializeInlineCommentBuffer(),
    );
    const previousExecutionFile = getExecutionFilePath();
    if (previousExecutionFile) await rm(previousExecutionFile, { force: true });
    if (process.env.OPENAI_API_KEY) core.setSecret(process.env.OPENAI_API_KEY);
    // Phase 1: Prepare
    const actionInputsPresent = collectActionInputsPresence();
    context = parseGitHubContext();
    const modeName = detectMode(context);
    console.log(
      `Auto-detected mode: ${modeName} for event: ${context.eventName}`,
    );

    githubToken = await setupGitHubToken();

    octokit = createOctokit(githubToken);

    try {
      await assertNoForkPullRequests(context, octokit.rest);
    } catch (error) {
      if (!(error instanceof ForkPullRequestError)) throw error;
      core.setOutput("skipped_due_to_fork", "true");
      console.log("Fork pull requests are disabled; skipping execution");
      return;
    }

    // Set GITHUB_TOKEN and GH_TOKEN in process env for downstream usage
    process.env.GITHUB_TOKEN = githubToken;
    process.env.GH_TOKEN = githubToken;

    // Check write permissions for entity contexts, and for workflow_run
    // events, whose upstream run may have been started by an actor without
    // write access (e.g. the author of a fork pull request)
    if (isEntityContext(context) || isWorkflowRunEvent(context)) {
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        process.env.GITHUB_TOKEN_PROVIDED === "true",
      );
      if (!hasWritePermissions) {
        throw new Error(
          "Actor does not have write permissions to the repository",
        );
      }
    }

    // Check trigger conditions
    const containsTrigger =
      modeName === "tag"
        ? isEntityContext(context) && checkContainsTrigger(context)
        : !!context.inputs?.prompt;
    console.log(`Mode: ${modeName}`);
    console.log(`Context prompt: ${context.inputs?.prompt || "NO PROMPT"}`);
    console.log(`Trigger result: ${containsTrigger}`);

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      core.setOutput("github_token", githubToken);
      return;
    }

    validateCodexInputs();

    // Run prepare
    console.log(
      `Preparing with mode: ${modeName} for event: ${context.eventName}`,
    );
    const prepareResult =
      modeName === "tag"
        ? await prepareTagMode({ context, octokit, githubToken })
        : await prepareAgentMode({ context, octokit, githubToken });

    commentId = prepareResult.commentId;
    claudeBranch = prepareResult.branchInfo.claudeBranch;
    baseBranch = prepareResult.branchInfo.baseBranch;
    prepareCompleted = true;

    // The locked OpenAI Agents SDK provides the Codex model runtime.
    process.env.INPUT_ACTION_INPUTS_PRESENT = actionInputsPresent;

    // PR-authored Codex configuration and instructions are attacker-controlled.
    // Restore them from the base branch before configuration is loaded.
    //
    // We read pull_request.base.ref from the payload directly because agent
    // mode's branchInfo.baseBranch defaults to the repo's default branch rather
    // than the PR's actual target (agent/index.ts). For issue_comment on a PR the payload
    // lacks base.ref, so we fall back to the mode-provided value — tag mode
    // fetches it from GraphQL; agent mode on issue_comment is an edge case
    // that at worst restores from the wrong trusted branch (still secure).
    if (isEntityContext(context) && context.isPR) {
      let restoreBase = baseBranch;
      if (
        isPullRequestEvent(context) ||
        isPullRequestReviewEvent(context) ||
        isPullRequestReviewCommentEvent(context)
      ) {
        restoreBase = context.payload.pull_request.base.ref;
        validateBranchName(restoreBase);
      }
      if (restoreBase) {
        restoredConfigPaths = restoreConfigFromBase(restoreBase);
      }
    }

    const promptFile =
      process.env.INPUT_PROMPT_FILE ||
      `${process.env.RUNNER_TEMP}/codex-prompts/codex-prompt.txt`;
    const promptConfig = await preparePrompt({
      prompt: "",
      promptFile,
    });

    const result: CodexRunResult = await runCodex(promptConfig.path, {
      mcpConfig: prepareResult.mcpConfig,
      ...actionRuntimeOptions(process.env),
      showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
      compatibilityArgs: prepareResult.claudeArgs,
      settings: process.env.INPUT_SETTINGS,
      plugins: process.env.INPUT_PLUGINS,
      pluginMarketplaces: process.env.INPUT_PLUGIN_MARKETPLACES,
      githubEnvironment: context.inputs.allowedNonWriteUsers
        ? undefined
        : {
            GH_TOKEN: githubToken,
            GITHUB_REPOSITORY: context.repository.full_name,
            GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH || "",
            GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE || process.cwd(),
          },
    });

    claudeSuccess = result.conclusion === "success";
    executionFile = result.executionFile;

    // Set action-level outputs
    if (result.executionFile) {
      core.setOutput("execution_file", result.executionFile);
    }
    if (result.sessionId) {
      core.setOutput("session_id", result.sessionId);
    }
    if (result.structuredOutput !== undefined) {
      core.setOutput(
        "structured_output",
        JSON.stringify(result.structuredOutput),
      );
    }
    core.setOutput("conclusion", result.conclusion);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    executionFile ??= setExecutionFileOutputIfPresent();
    // Only mark as prepare failure if we haven't completed the prepare phase
    if (!prepareCompleted) {
      prepareSuccess = false;
      prepareError = errorMessage;
    }
    core.setFailed(`Action failed with error: ${redactSecrets(errorMessage)}`);
    core.setOutput("conclusion", "failure");
  } finally {
    // Phase 4: Cleanup (always runs)

    // Complete the inherited comment delivery before announcing success.
    if (
      prepareCompleted &&
      context &&
      isEntityContext(context) &&
      context.isPR &&
      githubToken &&
      octokit &&
      process.env.BUFFER_INLINE_COMMENTS !== "false" &&
      process.env.CLASSIFY_INLINE_COMMENTS !== "false"
    ) {
      try {
        await postBufferedInlineComments({
          env: {
            ...process.env,
            GITHUB_TOKEN: githubToken,
            REPO_OWNER: context.repository.owner,
            REPO_NAME: context.repository.repo,
            PR_NUMBER: String(context.entityNumber),
            INPUT_CODEX_MODEL: process.env.CODEX_MODEL,
            INPUT_CODEX_EFFORT: process.env.CODEX_EFFORT,
          },
          octokit: octokit.rest,
        });
      } catch (error) {
        deliveryError = redactSecrets(
          `Inline feedback delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        claudeSuccess = false;
        core.setFailed(deliveryError);
        core.setOutput("conclusion", "failure");
      }
    }

    // Update tracking comment
    if (
      commentId &&
      context &&
      isEntityContext(context) &&
      githubToken &&
      octokit
    ) {
      try {
        await updateCommentLink({
          commentId,
          githubToken,
          claudeBranch,
          baseBranch: baseBranch || context.repository.default_branch || "main",
          triggerUsername: context.actor,
          context,
          octokit,
          claudeSuccess,
          outputFile: executionFile,
          prepareSuccess,
          prepareError,
          deliveryError,
          useCommitSigning: usesApiCommitSigning(context.inputs),
          restoredConfigPaths,
        });
      } catch (error) {
        console.error("Error updating comment with job link:", error);
      }
    }

    // Write step summary (unless display_report is set to false)
    if (
      executionFile &&
      existsSync(executionFile) &&
      process.env.DISPLAY_REPORT !== "false"
    ) {
      await writeStepSummary(executionFile);
    }

    // Set remaining action-level outputs
    core.setOutput("branch_name", claudeBranch);
    core.setOutput("github_token", githubToken);
    core.setOutput(
      "github_app_token_created",
      String(hasMintedGitHubAppToken()),
    );
  }
}

if (import.meta.main) {
  run();
}
