import { spawn } from "node:child_process";
import type { HookHandler, HookRunnerOptions } from "./agent-hooks";

/** Bounded command execution used by hooks and configuration installation. */
export function runConfigurationCommand(
  executable: string,
  args: string[],
  options: {
    workspace: string;
    environment: NodeJS.ProcessEnv;
    input?: string;
    deadline: number;
    signal?: AbortSignal;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (options.signal?.aborted)
    return Promise.reject(new Error("Hook/configuration execution cancelled"));
  if (options.deadline <= Date.now())
    return Promise.reject(new Error("Hook/configuration execution timed out"));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.workspace,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });
    let stdout = "",
      stderr = "",
      failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Already exited. */
      }
    };
    const terminate = (message: string) => {
      failure ??= new Error(message);
      kill("SIGTERM");
      escalation ??= setTimeout(() => kill("SIGKILL"), 250);
    };
    const abort = () => terminate("Hook/configuration execution cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => terminate("Hook/configuration execution timed out"),
      Math.max(1, options.deadline - Date.now()),
    );
    const capture = (type: "stdout" | "stderr", chunk: Buffer) => {
      if (type === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (stdout.length + stderr.length > 1024 * 1024)
        terminate("Hook/configuration output exceeded 1 MiB");
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") failure ??= error;
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (escalation) {
        clearTimeout(escalation);
        kill("SIGKILL");
      }
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? "");
  });
}

export async function runHttpHook(
  handler: HookHandler,
  payload: Record<string, unknown>,
  options: HookRunnerOptions,
  deadline: number,
): Promise<unknown> {
  const url = new URL(handler.url!);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "HTTP hook requires an HTTP(S) URL without embedded credentials",
    );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const allowed = new Set(handler.allowedEnvVars ?? []);
  for (const [name, value] of Object.entries(handler.headers ?? {}))
    headers[name] = value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_, first: string | undefined, second: string | undefined) => {
        const key = first ?? second!;
        const pluginVariable =
          /^(?:CLAUDE|CODEX)_PLUGIN_(?:ROOT|DATA|OPTION_[A-Z0-9_]+)$/.test(key);
        if (!allowed.has(key))
          throw new Error(
            `HTTP hook header variable ${key} must be listed in allowedEnvVars`,
          );
        if (
          !pluginVariable &&
          /^(?:OPENAI_|CODEX_|ANTHROPIC_|CLAUDE_|GITHUB_|GH_|ACTIONS_|INPUT_|NODE_OPTIONS$|BASH_ENV$)/i.test(
            key,
          )
        )
          throw new Error(
            `HTTP hooks cannot access reserved credential/runtime variable: ${key}`,
          );
        let entry = options.environment?.[key];
        if (pluginVariable) {
          if (key.endsWith("_ROOT")) entry = handler.pluginRoot;
          else if (key.endsWith("_DATA")) entry = handler.pluginDataDirectory;
          else {
            const name = key.replace(/^(?:CLAUDE|CODEX)_PLUGIN_OPTION_/, "");
            const value = Object.entries(handler.pluginOptions ?? {}).find(
              ([key]) => key.toUpperCase() === name,
            )?.[1];
            entry =
              value === undefined
                ? undefined
                : typeof value === "string"
                  ? value
                  : JSON.stringify(value);
          }
        }
        if (entry === undefined)
          throw new Error(
            `HTTP hook header variable ${key} is missing from explicit environment`,
          );
        return entry;
      },
    );
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
  try {
    if (options.signal?.aborted || deadline <= Date.now())
      throw new Error("HTTP hook cancelled or timed out");
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify(payload),
      headers,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`HTTP hook failed with status ${response.status}`);
    if (!response.body) return;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 1024 * 1024) {
        await reader.cancel();
        throw new Error("HTTP hook response exceeded 1 MiB");
      }
      chunks.push(chunk.value);
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    return text ? JSON.parse(text) : undefined;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error("HTTP hook cancelled or timed out");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
