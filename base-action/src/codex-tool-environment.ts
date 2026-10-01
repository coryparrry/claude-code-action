/** Preserve ordinary build/test environment while reserving auth and runtime controls. */
export function permittedToolVariable(name: string, value: string): boolean {
  if (
    [process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY].some(
      (secret) => secret && value.includes(secret),
    )
  )
    return false;
  if (
    Object.entries(process.env).some(
      ([name, secret]) =>
        /key|token|secret|password|credential|authorization|^ALL_?INPUTS$/i.test(
          name,
        ) &&
        secret &&
        secret.length >= 8 &&
        value.includes(secret),
    )
  )
    return false;
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !/^(?:ALL_?INPUTS$|ACTION_ENGINE$|PROMPT$|INPUT_|ACTIONS_|GITHUB_|GH_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/i.test(
      name,
    ) &&
    !/key|token|secret|password|credential|authorization/i.test(name) &&
    !/^(?:MAX_TURNS|MAX_BUDGET_USD|SYSTEM_PROMPT|APPEND_SYSTEM_PROMPT|FALLBACK_MODEL|MODEL|EFFORT|PERMISSION_MODE|SETTING_SOURCES|TOOLS|ALLOWED_TOOLS|DISALLOWED_TOOLS|ASK_TOOLS|MCP_CONFIG|PLUGINS|PLUGIN_MARKETPLACES|SETTINGS|SHOW_FULL_OUTPUT|DISPLAY_REPORT|OUTPUT_FILE|EXECUTION_FILE|ACTION_OUTPUT_FILE|PROMPT_FILE|RESUME_SESSION|RESUME_THREAD_ID|CONTINUE_SESSION|PATH_TO_CODEX_EXECUTABLE|PATH_TO_CLAUDE_CODE_EXECUTABLE|TIMEOUT_MINUTES|RUNTIME_.*)$/i.test(
      name,
    ) &&
    !/^(?:BASH_ENV|ENV|NODE_OPTIONS|BUN_OPTIONS|BUN_RUNTIME_TRANSPILER_CACHE_PATH|LD_|DYLD_|PYTHONPATH|PYTHONHOME|GIT_|PATH$|HOME$|SHELL$|USER$|LOGNAME$|PWD$|SHLVL$|_$|TMPDIR$|TMP$|TEMP$|TERM$|LANG$|LC_)/i.test(
      name,
    ) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@]*:[^/@]+@/.test(value)
  );
}

export function workflowToolEnvironment(
  env: NodeJS.ProcessEnv,
  additionalSecrets: string[] = [],
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        permittedToolVariable(entry[0], entry[1]) &&
        !additionalSecrets.some(
          (secret) => secret && entry[1]!.includes(secret),
        ) &&
        !Object.entries(env).some(
          ([name, secret]) =>
            /key|token|secret|password|credential|authorization/i.test(name) &&
            secret &&
            secret.length >= 8 &&
            entry[1]!.includes(secret),
        ),
    ),
  );
}
