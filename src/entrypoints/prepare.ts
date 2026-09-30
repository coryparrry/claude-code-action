#!/usr/bin/env bun

/**
 * Prepare the Codex action by checking trigger conditions, verifying actor permissions,
 * and creating the initial tracking comment
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import {
  assertNoForkPullRequests,
  ForkPullRequestError,
} from "../github/validation/forks";
import { createOctokit } from "../github/api/client";
import {
  parseGitHubContext,
  isEntityContext,
  isWorkflowRunEvent,
} from "../github/context";
import { detectMode } from "../modes/detector";
import { prepareTagMode } from "../modes/tag";
import { prepareAgentMode } from "../modes/agent";
import { checkContainsTrigger } from "../github/validation/trigger";
import { collectActionInputsPresence } from "./collect-inputs";

async function run() {
  try {
    collectActionInputsPresence();

    // Parse GitHub context first to enable mode detection
    const context = parseGitHubContext();

    // Auto-detect mode based on context
    const modeName = detectMode(context);
    console.log(
      `Auto-detected mode: ${modeName} for event: ${context.eventName}`,
    );

    // Setup GitHub token
    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);

    try {
      await assertNoForkPullRequests(context, octokit.rest);
    } catch (error) {
      if (!(error instanceof ForkPullRequestError)) throw error;
      core.setOutput("contains_trigger", "false");
      core.setOutput("skipped_due_to_fork", "true");
      return;
    }

    // Step 3: Check write permissions (entity contexts and workflow_run)
    if (isEntityContext(context) || isWorkflowRunEvent(context)) {
      // Non-write exceptions require an explicitly supplied scoped token.
      const githubTokenProvided = process.env.GITHUB_TOKEN_PROVIDED === "true";
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        githubTokenProvided,
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

    // Debug logging
    console.log(`Mode: ${modeName}`);
    console.log(`Context prompt: ${context.inputs?.prompt || "NO PROMPT"}`);
    console.log(`Trigger result: ${containsTrigger}`);

    // Set output for action.yml to check
    core.setOutput("contains_trigger", containsTrigger.toString());

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      // Still set github_token output even when skipping
      core.setOutput("github_token", githubToken);
      return;
    }

    // Run prepare
    console.log(
      `Preparing with mode: ${modeName} for event: ${context.eventName}`,
    );
    if (modeName === "tag") {
      await prepareTagMode({ context, octokit, githubToken });
    } else {
      await prepareAgentMode({ context, octokit, githubToken });
    }

    // MCP config is handled by individual modes (tag/agent) and included in their claude_args output

    // Expose the supplied GitHub token as an output
    core.setOutput("github_token", githubToken);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Prepare step failed with error: ${errorMessage}`);
    // Also output the clean error message for the action to capture
    core.setOutput("prepare_error", errorMessage);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
