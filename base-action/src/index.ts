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
    const result = await runCodex(promptConfig.path, {
      executable: process.env.INPUT_PATH_TO_CODEX_EXECUTABLE || "codex",
      mcpConfig: process.env.INPUT_MCP_CONFIG || '{"mcpServers":{}}',
      model: process.env.INPUT_CODEX_MODEL,
      compatibilityArgs:
        process.env.INPUT_CODEX_ARGS || process.env.INPUT_CLAUDE_ARGS,
      settings: process.env.INPUT_SETTINGS,
      plugins: process.env.INPUT_PLUGINS,
      pluginMarketplaces: process.env.INPUT_PLUGIN_MARKETPLACES,
      effort: process.env.INPUT_CODEX_EFFORT,
      sandbox: process.env.INPUT_CODEX_SANDBOX,
      appendSystemPrompt: process.env.INPUT_APPEND_SYSTEM_PROMPT,
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
