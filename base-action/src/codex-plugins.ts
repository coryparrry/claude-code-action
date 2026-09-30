import { spawn } from "node:child_process";

export function pluginSetupCommands(
  plugins = "",
  marketplaces = "",
): string[][] {
  const lines = (value: string) =>
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const commands: string[][] = [];
  for (const source of lines(marketplaces)) {
    if (source.startsWith("-") || /[\x00-\x1f\x7f]/.test(source))
      throw new Error("Invalid Codex plugin marketplace source");
    commands.push(["plugin", "marketplace", "add", source, "--json"]);
  }
  for (const plugin of lines(plugins)) {
    if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(plugin))
      throw new Error(
        "Codex plugins must use plugin@marketplace selectors and Codex-compatible manifests",
      );
    commands.push(["plugin", "add", plugin, "--json"]);
  }
  return commands;
}

/** Plugin installation belongs to this run's disposable CODEX_HOME. */
export async function setupCodexPlugins(
  executable: string,
  commands: string[][],
  env: NodeJS.ProcessEnv,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  for (const args of commands) {
    if (signal?.aborted) throw new Error("Codex execution cancelled");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Codex plugin setup timed out");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        env,
        stdio: "ignore",
        shell: false,
        detached: process.platform !== "win32",
      });
      let failure: string | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (value: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, value);
          else child.kill(value);
        } catch {
          /* Process group already exited. */
        }
      };
      const terminate = (message: string) => {
        failure ??= message;
        kill("SIGTERM");
        escalation ??= setTimeout(() => kill("SIGKILL"), 1000);
      };
      const abort = () => terminate("Codex execution cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => terminate("Codex plugin setup timed out"),
        remaining,
      );
      child.once("error", () => {
        failure ??= "Failed to launch Codex plugin setup";
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (escalation) {
          clearTimeout(escalation);
          kill("SIGKILL");
        }
        if (failure || code !== 0)
          reject(
            new Error(
              failure ||
                `Codex plugin setup failed with exit code ${code}; the marketplace must provide a Codex-compatible plugin manifest`,
            ),
          );
        else resolve();
      });
    });
  }
}
