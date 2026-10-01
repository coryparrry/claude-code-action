#!/usr/bin/env bun

import * as core from "@actions/core";
import { preparePrompt } from "./prepare-prompt";
import { runCodex } from "./run-codex";
import { validateEnvironmentVariables } from "./validate-env";
import { setExecutionFileOutputIfPresent } from "./execution-file";

export async function run() {
  try {
    validateEnvironmentVariables();
    const promptConfig = await preparePrompt({
      prompt: process.env.INPUT_PROMPT || "",
      promptFile: process.env.INPUT_PROMPT_FILE || "",
    });
    const timeout = process.env.INPUT_CODEX_TIMEOUT_MINUTES || "30";
    if (
      !/^\d+$/.test(timeout) ||
      !Number.isSafeInteger(Number(timeout)) ||
      Number(timeout) <= 0
    ) {
      throw new Error("Codex timeout minutes must be a positive integer");
    }
    if (
      process.env.INPUT_CONTINUE_SESSION &&
      !["true", "false"].includes(process.env.INPUT_CONTINUE_SESSION)
    ) {
      throw new Error("continue_session must be true or false");
    }
    const result = await runCodex(promptConfig.path, {
      mcpConfig: process.env.INPUT_MCP_CONFIG || '{"mcpServers":{}}',
      model: process.env.INPUT_CODEX_MODEL || undefined,
      baseURL: process.env.OPENAI_BASE_URL,
      maxTurns: process.env.INPUT_MAX_TURNS || undefined,
      maxBudgetUsd: process.env.INPUT_MAX_BUDGET_USD || undefined,
      allowedTools: process.env.INPUT_ALLOWED_TOOLS || undefined,
      disallowedTools: process.env.INPUT_DISALLOWED_TOOLS || undefined,
      systemPrompt: process.env.INPUT_SYSTEM_PROMPT || undefined,
      fallbackModel: process.env.INPUT_FALLBACK_MODEL || undefined,
      additionalDirectories: process.env.INPUT_ADDITIONAL_DIRECTORIES?.trim()
        ? process.env.INPUT_ADDITIONAL_DIRECTORIES.split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined,
      settingSources: process.env.INPUT_SETTING_SOURCES?.trim()
        ? process.env.INPUT_SETTING_SOURCES.split(/[,\r\n]+/)
            .map((value) => value.trim())
            .filter(Boolean)
        : undefined,
      permissionMode: process.env.INPUT_PERMISSION_MODE || undefined,
      continueSession: process.env.INPUT_CONTINUE_SESSION
        ? process.env.INPUT_CONTINUE_SESSION === "true"
        : undefined,
      resumeThreadId: process.env.INPUT_RESUME_SESSION || undefined,
      compatibilityArgs:
        process.env.INPUT_CODEX_ARGS || process.env.INPUT_CLAUDE_ARGS,
      settings: process.env.INPUT_SETTINGS,
      plugins: process.env.INPUT_PLUGINS,
      pluginMarketplaces: process.env.INPUT_PLUGIN_MARKETPLACES,
      effort: process.env.INPUT_CODEX_EFFORT || undefined,
      sandbox: process.env.INPUT_CODEX_SANDBOX,
      appendSystemPrompt: process.env.INPUT_APPEND_SYSTEM_PROMPT || undefined,
      showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
      timeoutMs: Number(timeout) * 60 * 1000,
    });
    core.setOutput("conclusion", result.conclusion);
    if (result.executionFile)
      core.setOutput("execution_file", result.executionFile);
    if (result.sessionId) core.setOutput("session_id", result.sessionId);
    if (result.structuredOutput !== undefined)
      core.setOutput(
        "structured_output",
        JSON.stringify(result.structuredOutput),
      );
  } catch (error) {
    setExecutionFileOutputIfPresent();
    core.setFailed(`Action failed with error: ${error}`);
    core.setOutput("conclusion", "failure");
  }
}

if (import.meta.main) {
  run();
}
