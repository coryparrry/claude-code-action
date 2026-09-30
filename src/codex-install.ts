import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_CODEX_VERSION = "0.159.2";

export function codexInstallArgs(version: string, prefix: string): string[] {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
    throw new Error("codex_version must be an exact npm version");
  }
  return [
    "install",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    `@openai/codex@${version}`,
  ];
}

export async function installCodex(): Promise<string> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Codex execution requires a Linux or macOS runner");
  }
  let executable = process.env.PATH_TO_CODEX_EXECUTABLE;
  if (executable && /[\x00-\x1f\x7f]/.test(executable)) {
    throw new Error("path_to_codex_executable contains control characters");
  }
  if (!executable) {
    if (!process.env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is required");
    const prefix = join(process.env.RUNNER_TEMP, "codex-action-cli");
    await mkdir(prefix, { recursive: true });
    const version = process.env.CODEX_VERSION || DEFAULT_CODEX_VERSION;
    const args = codexInstallArgs(version, prefix);
    console.log(`Installing Codex CLI ${version}`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("npm", args, { stdio: "inherit" });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else
          reject(new Error(`Codex installation failed with exit code ${code}`));
      });
    });
    executable = join(prefix, "node_modules", ".bin", "codex");
  }
  const executableDir = dirname(executable);
  if (process.env.GITHUB_PATH) {
    await appendFile(process.env.GITHUB_PATH, `${executableDir}\n`);
  }
  process.env.PATH = `${executableDir}:${process.env.PATH || ""}`;
  return executable;
}

export function validateCodexInputs(): void {
  if (process.env.ACTION_ENGINE && process.env.ACTION_ENGINE !== "codex") {
    throw new Error(
      "This action supports Codex only; remove the engine setting",
    );
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("Codex requires openai_api_key or OPENAI_API_KEY");
  }
}
