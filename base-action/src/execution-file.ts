import * as core from "@actions/core";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";

export type ExecutionFilename =
  | "codex-execution-output.json"
  | "codex-review-verifier-output.json";
const EXECUTION_FILENAME: ExecutionFilename = "codex-execution-output.json";

/** Resolve one of the action-owned report filenames without accepting arbitrary paths. */
export function getExecutionFilePath(
  filename: ExecutionFilename = EXECUTION_FILENAME,
): string | undefined {
  if (
    ![EXECUTION_FILENAME, "codex-review-verifier-output.json"].includes(
      filename,
    )
  )
    throw new Error("Invalid execution report filename");
  if (!process.env.RUNNER_TEMP) {
    return undefined;
  }
  return join(process.env.RUNNER_TEMP, filename);
}

/** Persist a reviewer or verifier report independently so neither phase overwrites the other. */
export async function writeExecutionFile(
  messages: unknown[],
  filename: ExecutionFilename = EXECUTION_FILENAME,
): Promise<string | undefined> {
  const executionFile = getExecutionFilePath(filename);
  if (!executionFile) {
    core.warning("Failed to write execution file: RUNNER_TEMP is not set");
    return undefined;
  }

  try {
    await writeFile(executionFile, JSON.stringify(messages, null, 2));
    console.log(`Log saved to ${executionFile}`);
    return executionFile;
  } catch (error) {
    core.warning(`Failed to write execution file: ${error}`);
    return undefined;
  }
}

export function setExecutionFileOutputIfPresent(): string | undefined {
  const executionFile = getExecutionFilePath();
  if (!executionFile || !existsSync(executionFile)) {
    return undefined;
  }

  core.setOutput("execution_file", executionFile);
  return executionFile;
}
