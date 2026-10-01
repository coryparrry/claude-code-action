import type { CodexOptions } from "../../base-action/src/run-codex";

/** Omitted Actions inputs must not override controls supplied by mode arguments. */
export function actionRuntimeOptions(
  env: NodeJS.ProcessEnv,
): Partial<CodexOptions> {
  const value = (name: string) => env[name] || undefined;
  const continuation = value("CONTINUE_SESSION");
  if (continuation !== undefined && !["true", "false"].includes(continuation))
    throw new Error("continue_session must be true or false");
  return {
    model: value("CODEX_MODEL"),
    baseURL: value("OPENAI_BASE_URL"),
    effort: value("CODEX_EFFORT"),
    sandbox: value("CODEX_SANDBOX"),
    appendSystemPrompt: value("APPEND_SYSTEM_PROMPT"),
    systemPrompt: value("SYSTEM_PROMPT"),
    maxTurns: value("MAX_TURNS"),
    maxBudgetUsd: value("MAX_BUDGET_USD"),
    fallbackModel: value("FALLBACK_MODEL"),
    allowedTools: value("ALLOWED_TOOLS"),
    disallowedTools: value("DISALLOWED_TOOLS"),
    additionalDirectories: value("ADDITIONAL_DIRECTORIES")
      ?.split("\n")
      .map((item) => item.trim())
      .filter(Boolean),
    settingSources: value("SETTING_SOURCES")
      ?.split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean),
    permissionMode: value("PERMISSION_MODE"),
    resumeThreadId: value("RESUME_SESSION"),
    continueSession:
      continuation === undefined ? undefined : continuation === "true",
  };
}
