/** Preserve ordinary build/test environment while reserving auth and runtime controls. */
export function permittedToolVariable(name: string, value: string): boolean {
  if (
    [process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY].some(
      (secret) => secret && value.includes(secret),
    )
  )
    return false;
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !/^(?:ALL_INPUTS$|ACTION_ENGINE$|PROMPT$|INPUT_|ACTIONS_|GITHUB_|GH_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE_)/i.test(
      name,
    ) &&
    !/key|token|secret|password|credential|authorization/i.test(name) &&
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
