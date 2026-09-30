import * as core from "@actions/core";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { redactSecrets } from "../../src/github/utils/sanitizer";
import { writeExecutionFile } from "./execution-file";
import {
  codexEnvironment,
  SECURITY_OVERRIDES,
  serializeMcpConfig,
} from "./codex-config";
import { expandCommand } from "./codex-commands";
import { pluginSetupCommands, setupCodexPlugins } from "./codex-plugins";
import { tomlString } from "./codex-config";
import { resolveCompatibility } from "./codex-compat";
import { workflowToolEnvironment } from "./codex-tool-environment";
import { CodexTranscript } from "./codex-transcript";

export type CodexRunResult = {
  executionFile?: string;
  sessionId?: string;
  conclusion: "success" | "failure";
  structuredOutput?: unknown;
};

export type CodexOptions = {
  mcpConfig: string;
  compatibilityArgs?: string;
  defaultAllowedTools?: string[];
  settings?: string;
  plugins?: string;
  pluginMarketplaces?: string;
  githubEnvironment?: Partial<
    Record<
      | "GH_TOKEN"
      | "GITHUB_REPOSITORY"
      | "GITHUB_EVENT_PATH"
      | "GITHUB_WORKSPACE"
      | "GH_HOST",
      string
    >
  >;
  executable: string;
  model?: string;
  effort?: string;
  sandbox?: string;
  appendSystemPrompt?: string;
  showFullOutput?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_LAST_MESSAGE_BYTES = 4 * 1024 * 1024;

async function createPrompt(path: string, appended?: string): Promise<string> {
  let context = await readFile(path, "utf8");
  let request = "";
  try {
    request = await readFile(
      join(dirname(path), "codex-user-request.txt"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (request) request = await expandCommand(request);
  else context = await expandCommand(context);
  return [
    context,
    appended ? `Additional instructions:\n${appended}` : "",
    request ? `User request:\n${request}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Runs only the API-key-authenticated CLI, without touching the user's Codex home. */
export async function runCodex(
  promptPath: string,
  options: CodexOptions,
): Promise<CodexRunResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey?.trim())
    throw new Error("OPENAI_API_KEY is required to run Codex");
  core.setSecret(apiKey);
  const compatibility = await resolveCompatibility(
    options.compatibilityArgs || "",
    options.settings || "",
    options.mcpConfig,
    options.defaultAllowedTools,
  );
  const model = options.model || compatibility.model;
  const effort = options.effort || compatibility.effort;
  const sandbox = options.sandbox || "workspace-write";
  if (!["read-only", "workspace-write"].includes(sandbox)) {
    throw new Error("Codex sandbox must be read-only or workspace-write");
  }
  if (
    effort &&
    ![
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ].includes(effort)
  ) {
    throw new Error("Unsupported Codex reasoning effort");
  }
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("Codex timeout must be a positive integer");

  const pluginCommands = pluginSetupCommands(
    options.plugins,
    options.pluginMarketplaces,
  );
  const deadline = Date.now() + timeoutMs;
  const githubEnvironment = options.githubEnvironment || {};
  if (
    Object.keys(githubEnvironment).some(
      (name) =>
        ![
          "GH_TOKEN",
          "GITHUB_REPOSITORY",
          "GITHUB_EVENT_PATH",
          "GITHUB_WORKSPACE",
          "GH_HOST",
        ].includes(name),
    ) ||
    Object.values(githubEnvironment).some((value) => typeof value !== "string")
  )
    throw new Error("Invalid trusted GitHub environment");
  const mcp = serializeMcpConfig(compatibility.mcpConfig);
  const toolEnvironment = workflowToolEnvironment(
    {
      ...process.env,
      ...compatibility.toolEnvironment,
    },
    mcp.secrets,
  );
  for (const variable of Object.keys(mcp.clientEnvironment))
    delete toolEnvironment[variable];
  Object.assign(toolEnvironment, githubEnvironment);
  const securityOverrides = SECURITY_OVERRIDES.map((value) =>
    value === "shell_environment_policy.set={}"
      ? `shell_environment_policy.set={${Object.entries(toolEnvironment)
          .map(([name, value]) => `${tomlString(name)}=${tomlString(value!)}`)
          .join(",")}}`
      : value,
  );
  const secrets = [
    apiKey,
    ...mcp.secrets,
    ...(githubEnvironment.GH_TOKEN ? [githubEnvironment.GH_TOKEN] : []),
    ...Object.entries(process.env)
      .filter(
        ([name, value]) =>
          /key|token|secret|password|credential|authorization/i.test(name) &&
          !!value,
      )
      .map(([, value]) => value!),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const secret of mcp.secrets) core.setSecret(secret);
  if (githubEnvironment.GH_TOKEN) core.setSecret(githubEnvironment.GH_TOKEN);
  const redact = (value: string): string => {
    for (const secret of secrets)
      value = value.split(secret).join("[REDACTED]");
    return redactSecrets(value);
  };
  const redactObject = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(redactObject);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          redact(key),
          redactObject(item),
        ]),
      );
    return value;
  };

  const transcript = new CodexTranscript();
  let home: string | undefined;
  let failure: string | undefined;
  let executionFile: string | undefined;
  let structuredOutput: unknown;
  try {
    const prompt = await createPrompt(
      promptPath,
      [options.appendSystemPrompt, compatibility.appendSystemPrompt]
        .filter(Boolean)
        .join("\n\n"),
    );
    home = await mkdtemp(join(tmpdir(), "codex-action-"));
    await writeFile(
      join(home, "config.toml"),
      `${securityOverrides.join("\n")}\n${mcp.toml}\n`,
      { mode: 0o600 },
    );
    await setupCodexPlugins(
      options.executable,
      pluginCommands,
      codexEnvironment(home, apiKey),
      deadline,
      options.signal,
    );
    const lastMessagePath = join(home, "last-message.txt");
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--color",
      "never",
      "--sandbox",
      sandbox,
      "--output-last-message",
      lastMessagePath,
    ];
    for (const override of compatibility.configOverrides)
      args.push("-c", override);
    // Security settings always win over supplied settings and project configuration.
    for (const override of securityOverrides) args.push("-c", override);
    if (compatibility.skipGitRepoCheck) args.push("--skip-git-repo-check");
    if (compatibility.schema) {
      const schemaPath = join(home, "output-schema.json");
      await writeFile(schemaPath, JSON.stringify(compatibility.schema), {
        mode: 0o600,
      });
      args.push("--output-schema", schemaPath);
    }
    if (model) args.push("--model", model);
    if (effort)
      args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
    args.push("-");
    core.info("Running Codex with API key authentication");

    await new Promise<void>((resolve) => {
      if (options.signal?.aborted) {
        failure = "Codex execution cancelled";
        resolve();
        return;
      }
      const child = spawn(options.executable, args, {
        env: { ...codexEnvironment(home!, apiKey), ...mcp.clientEnvironment },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        shell: false,
      });
      let pending = "";
      let stderr = "";
      let stderrBytes = 0;
      let outputBytes = 0;
      let logBytes = 0;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const terminate = (message: string) => {
        failure ??= message;
        const kill = (signal: NodeJS.Signals) => {
          try {
            if (process.platform !== "win32" && child.pid)
              process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch {
            /* Process may already have exited. */
          }
        };
        kill("SIGTERM");
        escalation ??= setTimeout(() => kill("SIGKILL"), 1000);
      };
      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event: unknown = JSON.parse(line);
          if (!event || typeof event !== "object" || Array.isArray(event))
            throw new Error();
          const sanitized = redactObject(event) as Record<string, unknown>;
          transcript.accept(sanitized);
          if (options.showFullOutput === "true" && logBytes < 128 * 1024) {
            const log = JSON.stringify(sanitized).slice(0, 16 * 1024);
            logBytes += log.length;
            core.info(log);
          }
        } catch {
          terminate("Codex emitted invalid JSON output");
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_OUTPUT_BYTES) {
          terminate("Codex output exceeded the 32 MiB limit");
          return;
        }
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          consumeLine(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_OUTPUT_BYTES) {
          // Do not truncate a raw secret in half before redaction.
          stderr = "";
          terminate("Codex diagnostics exceeded the 32 MiB limit");
          return;
        }
        stderr += chunk;
      });
      // EPIPE is expected if startup fails before Codex consumes stdin.
      child.stdin.on("error", () => {});
      child.on("error", () => {
        failure ??= "Failed to launch the Codex executable";
      });
      const abort = () => terminate("Codex execution cancelled");
      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => terminate("Codex execution timed out"),
        Math.max(1, deadline - Date.now()),
      );
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (pending) consumeLine(pending);
        if (escalation) {
          clearTimeout(escalation);
          // A cancelled parent may exit while an MCP descendant ignores SIGTERM.
          try {
            if (process.platform !== "win32" && child.pid)
              process.kill(-child.pid, "SIGKILL");
          } catch {
            /* The process group may already be gone. */
          }
        }
        if (code !== 0)
          failure ??= `Codex exited ${signal ? `with signal ${signal}` : `with code ${code}`}`;
        if (failure && stderr) core.warning(redact(stderr).slice(-4000));
        resolve();
      });
      child.stdin.end(prompt);
    });

    try {
      const metadata = await stat(lastMessagePath);
      if (metadata.size > MAX_LAST_MESSAGE_BYTES)
        failure ??= "Codex final message exceeded the 4 MiB limit";
      else {
        const final = redact(await readFile(lastMessagePath, "utf8"));
        if (final.trim() && final !== transcript.finalMessage)
          transcript.addAssistant(final);
        if (final.trim()) transcript.finalMessage = final;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (transcript.failed) failure ??= "Codex reported an error or failed turn";
    if (!transcript.completed)
      failure ??= "Codex did not emit a completed turn";
    if (!transcript.finalMessage?.trim())
      failure ??= "Codex did not produce a final assistant message";
    if (compatibility.schema && !failure) {
      try {
        structuredOutput = JSON.parse(transcript.finalMessage!);
      } catch {
        failure = "Codex schema response was not valid JSON";
      }
    }
  } catch (error) {
    failure ??= redact(
      error instanceof Error ? error.message : String(error),
    ).slice(0, 4000);
  } finally {
    transcript.finish(failure, structuredOutput);
    try {
      executionFile = await writeExecutionFile(
        transcript.messages.map(redactObject),
      );
    } finally {
      if (home) await rm(home, { recursive: true, force: true });
    }
  }
  if (failure) throw new Error(redact(failure));
  return {
    conclusion: "success",
    executionFile,
    sessionId: transcript.sessionId,
    structuredOutput,
  };
}
