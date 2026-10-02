import { basename, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const AMBIENT_CREDENTIAL =
  /^(?:GITHUB_APP_|ACTIONS_ID_TOKEN_REQUEST_|OPENAI_|AZURE_OPENAI_|CODEX_API_KEY$|ANTHROPIC_|AWS_BEARER_TOKEN_BEDROCK$|BUN_OPTIONS$|BUN_CONFIG$|NODE_OPTIONS$)/i;

/** Remove action/model credentials before a child MCP process receives its env. */
export function scrubMcpEnvironment(
  environment: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !AMBIENT_CREDENTIAL.test(name),
    ),
  );
}

function isBun(command: string): boolean {
  return /^(?:bun|bunx)(?:\.exe)?$/i.test(basename(command));
}

function withoutConfiguredEnvFiles(args: string[]): string[] {
  const result: string[] = [];
  const valueFlags = new Set([
    "--preload",
    "--define",
    "--loader",
    "--conditions",
    "--cwd",
    "--filter",
    "--shell",
  ]);
  let parsingRuntimeOptions = true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!parsingRuntimeOptions) {
      result.push(argument);
      continue;
    }
    if (argument === "--env-file") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--env-file=")) continue;
    if (argument === "--config") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--config=")) continue;
    result.push(argument);
    if (valueFlags.has(argument)) {
      if (index + 1 < args.length) result.push(args[++index]!);
      continue;
    }
    if (!argument.startsWith("-") && !["run", "x"].includes(argument)) {
      parsingRuntimeOptions = false;
    }
  }
  return result;
}

/** Add Bun isolation flags and a neutral bunfig outside the MCP working directory. */
export async function prepareMcpStdioCommand(
  command: string,
  args: string[],
): Promise<{ command: string; args: string[]; cleanup?: () => Promise<void> }> {
  if (!isBun(command)) return { command, args };
  const directory = await mkdtemp(join(tmpdir(), "codex-action-mcp-bun-"));
  const config = join(directory, "bunfig.toml");
  await writeFile(config, "", { mode: 0o600 });
  const cleanArgs = withoutConfiguredEnvFiles(args);
  return {
    command,
    args: ["--no-env-file", `--config=${config}`, ...cleanArgs],
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}
