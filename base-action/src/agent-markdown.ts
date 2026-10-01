import { parseDocument } from "yaml";
import { substitutePluginConfiguration } from "./agent-configuration";
import { spawn } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type {
  AgentConfiguration,
  AgentComponentLocation,
} from "./agent-configuration";
import { AgentPermissions } from "./agent-permissions";
import type { AgentToolOptions } from "./agent-tools";
export type AgentMarkdown = {
  name: string;
  path: string;
  namespace?: string;
  pluginRoot?: string;
  metadata: Record<string, unknown>;
  instructions: string;
};
const MAX_MARKDOWN = 1024 * 1024;
/** Parse full YAML frontmatter with bounded aliases and reserved-key rejection. */
export function parseAgentMarkdown(content: string): {
  metadata: Record<string, unknown>;
  instructions: string;
} {
  content = content.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(content))
    return { metadata: {}, instructions: content };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new Error("Unterminated Markdown frontmatter");
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(
      `Invalid Markdown frontmatter: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  const metadata: unknown = document.toJS({ maxAliasCount: 50 });
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("Markdown frontmatter must be an object");
  let visited = 0;
  function check(value: unknown, depth: number) {
    if (++visited > 2000 || depth > 20)
      throw new Error("Markdown frontmatter exceeds structural limits");
    if (Array.isArray(value)) {
      for (const item of value) check(item, depth + 1);
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw new Error("Reserved frontmatter key");
        check(item, depth + 1);
      }
    }
  }
  check(metadata, 0);
  return {
    metadata: metadata as Record<string, unknown>,
    instructions: content.slice(match[0].length),
  };
}
function within(root: string, path: string) {
  const part = relative(root, path);
  return (
    part !== ".." &&
    !part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(part)
  );
}
export async function catalog(
  locations: AgentComponentLocation[],
  kind: "skill" | "command" | "agent",
  check: () => void = () => {},
  configuration?: AgentConfiguration,
): Promise<AgentMarkdown[]> {
  const output: AgentMarkdown[] = [];
  let visited = 0;
  for (const location of locations) {
    check();
    const physical = await realpath(location.directory);
    const root = (await stat(physical)).isDirectory()
      ? physical
      : dirname(physical);
    const securityRoot =
      location.materializedRoot || location.pluginRoot
        ? await realpath(location.materializedRoot ?? location.pluginRoot!)
        : root;
    if (!within(securityRoot, physical))
      throw new Error("Configured Markdown escapes its plugin root");
    const files: string[] = [];
    async function walk(path: string, depth: number) {
      check();
      if (++visited > 2000 || depth > 8)
        throw new Error("Markdown catalog exceeds 2000 entries or 8 levels");
      if (!(await stat(path)).isDirectory()) {
        if (path.endsWith(".md")) files.push(path);
        return;
      }
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        if (
          entry.isDirectory() ||
          (entry.isFile() && entry.name.endsWith(".md"))
        )
          await walk(join(path, entry.name), depth + 1);
      }
    }
    await walk(physical, 0);
    for (const path of files.sort()) {
      if (kind === "skill" && basename(path) !== "SKILL.md") continue;
      check();
      const canonical = await realpath(path);
      if (canonical !== path || !within(securityRoot, canonical))
        throw new Error("Configured Markdown symlinks are unsupported");
      if ((await stat(path)).size > MAX_MARKDOWN)
        throw new Error("Markdown exceeds 1 MiB");
      const content = await readFile(path, "utf8");
      if (Buffer.byteLength(content) > MAX_MARKDOWN)
        throw new Error("Markdown exceeds 1 MiB");
      const plugin = configuration?.plugins.find(
        (item) => item.root === location.pluginRoot,
      );
      const parsed = (
        plugin
          ? substitutePluginConfiguration(parseAgentMarkdown(content), plugin)
          : parseAgentMarkdown(content)
      ) as ReturnType<typeof parseAgentMarkdown>;
      const pathName =
        kind === "skill"
          ? basename(dirname(path))
          : relative(root, path).replace(/\.md$/, "").split(/[\\/]/).join(":");
      const localName =
        typeof parsed.metadata.name === "string" && parsed.metadata.name
          ? parsed.metadata.name
          : pathName;
      const name = location.namespace
        ? `${location.namespace}:${localName}`
        : localName;
      if (!output.some((item) => item.name === name))
        output.push({
          name,
          path,
          namespace: location.namespace,
          pluginRoot: location.pluginRoot,
          ...parsed,
        });
    }
  }
  return output;
}
/** Native task agents remain available; configured definitions take precedence. */
export async function agentDefinitions(
  configuration: AgentConfiguration,
  check: () => void = () => {},
): Promise<AgentMarkdown[]> {
  const configured = await catalog(
    configuration.agentDirectories ?? [],
    "agent",
    check,
    configuration,
  );
  const readonlyTools = [
    "Read",
    "Glob",
    "Grep",
    "LS",
    "LSP",
    "WebFetch",
    "WebSearch",
  ];
  const builtin: AgentMarkdown[] = [
    {
      name: "general-purpose",
      path: "",
      metadata: { description: "General coding and research task" },
      instructions:
        "Complete the assigned task using the inherited tools and permissions. Verify relevant results.",
    },
    {
      name: "Explore",
      path: "",
      metadata: {
        description: "Read-only codebase exploration",
        tools: readonlyTools,
        permissionMode: "plan",
      },
      instructions:
        "Explore the codebase and report precise findings. Read files and search; preserve all workspace files.",
    },
    {
      name: "Plan",
      path: "",
      metadata: {
        description: "Read-only implementation planning",
        tools: readonlyTools,
        permissionMode: "plan",
      },
      instructions:
        "Inspect relevant source and produce a concrete implementation plan. Preserve all workspace files.",
    },
  ];
  return [
    ...configured,
    ...builtin.filter(
      (agent) => !configured.some((item) => item.name === agent.name),
    ),
  ];
}
export function stringList(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) return;
  if (typeof value === "string")
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  if (Array.isArray(value) && value.every((item) => typeof item === "string"))
    return value;
  throw new Error(`${label} must be a list or comma-separated string`);
}
export function substitute(
  entry: AgentMarkdown,
  argumentsText: string,
  configuration: AgentConfiguration,
): string {
  const args = (
    argumentsText.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) ?? []
  ).map((arg) =>
    arg.startsWith('"')
      ? String(JSON.parse(arg))
      : arg.startsWith("'")
        ? arg.slice(1, -1)
        : arg,
  );
  const root = entry.pluginRoot ?? dirname(entry.path);
  const data =
    configuration.plugins.find((plugin) => plugin.root === entry.pluginRoot)
      ?.dataDirectory ?? "";
  const result = entry.instructions.replace(
    /\$ARGUMENTS\[(\d+)\]|\$(\d+)|\$ARGUMENTS\b|\$\{(?:CLAUDE|CODEX)_PLUGIN_(?:ROOT|DATA)\}|\$\{(?:CLAUDE|CODEX)_SKILL_DIR\}/g,
    (match, bracket: string | undefined, bare: string | undefined) => {
      if (bracket !== undefined || bare !== undefined)
        return args[Number(bracket ?? bare)] ?? "";
      if (match === "$ARGUMENTS") return argumentsText;
      return match.endsWith("SKILL_DIR}")
        ? dirname(entry.path)
        : match.endsWith("DATA}")
          ? data
          : root;
    },
  );
  const plugin = configuration.plugins.find(
    (item) => item.root === entry.pluginRoot,
  );
  return plugin
    ? String(substitutePluginConfiguration(result, plugin))
    : result;
}
export function markdownEnvironment(
  entry: AgentMarkdown,
  configuration: AgentConfiguration,
  environment: Record<string, string>,
): Record<string, string> {
  const data =
    configuration.plugins.find((plugin) => plugin.root === entry.pluginRoot)
      ?.dataDirectory ?? "";
  return {
    ...environment,
    CLAUDE_PLUGIN_ROOT: entry.pluginRoot ?? dirname(entry.path),
    CODEX_PLUGIN_ROOT: entry.pluginRoot ?? dirname(entry.path),
    CLAUDE_PLUGIN_DATA: data,
    CODEX_PLUGIN_DATA: data,
    CLAUDE_SKILL_DIR: dirname(entry.path),
    CODEX_SKILL_DIR: dirname(entry.path),
  };
}
export async function preprocess(
  content: string,
  options: AgentToolOptions,
  permissions: AgentPermissions,
): Promise<string> {
  const snippets = [...content.matchAll(/!`([^`]+)`/g)];
  if (snippets.length > 32)
    throw new Error("Command preprocessing exceeds 32 snippets");
  for (const snippet of snippets) {
    const command = snippet[1]!;
    permissions.assertTool("Bash", command);
    if (options.signal?.aborted || Date.now() >= (options.deadline ?? Infinity))
      throw new Error("Command preprocessing cancelled or timed out");
    const output = await new Promise<string>((done, reject) => {
      const child = spawn(
        "/bin/bash",
        ["--noprofile", "--norc", "-c", command],
        {
          cwd: options.cwd,
          env: { ...options.env },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );
      let text = "";
      let error: Error | undefined;
      const kill = () => {
        if (child.pid) {
          try {
            process.kill(
              process.platform === "win32" ? child.pid : -child.pid,
              "SIGKILL",
            );
          } catch {
            child.kill("SIGKILL");
          }
        }
      };
      const abort = () => {
        error = new Error("Command preprocessing cancelled or timed out");
        kill();
      };
      const timer = setTimeout(
        abort,
        Math.max(
          1,
          Math.min(
            30_000,
            (options.deadline ?? Date.now() + 30_000) - Date.now(),
          ),
        ),
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      const append = (chunk: Buffer) => {
        if (
          Buffer.byteLength(text) + chunk.length >
          (options.maxOutputBytes ?? 64 * 1024)
        ) {
          error = new Error("Command preprocessing output limit exceeded");
          kill();
        } else text += chunk.toString("utf8");
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.once("error", (cause) => {
        error = cause;
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error || code !== 0)
          reject(
            error ??
              new Error(`Command preprocessing failed with exit ${code}`),
          );
        else done(text.trimEnd());
      });
      if (options.signal?.aborted) abort();
    });
    content = content.replace(snippet[0], () => output);
  }
  return content;
}
export type ResolvedAgentCommand = AgentMarkdown & {
  allowedTools?: string[];
  model?: string;
};
/** Explicit user slash commands may use disable-model-invocation skills. */
export async function resolveAgentCommand(
  request: string,
  configuration: AgentConfiguration,
  options: AgentToolOptions,
): Promise<ResolvedAgentCommand | undefined> {
  const invocation = /^\s*\/([\w.:-]+)(?:\s+([\s\S]*))?\s*$/.exec(request);
  if (!invocation) return;
  const entries = [
    ...(await catalog(
      configuration.skillDirectories,
      "skill",
      undefined,
      configuration,
    )),
    ...(await catalog(
      configuration.commandDirectories,
      "command",
      undefined,
      configuration,
    )),
  ];
  const entry = entries.find((item) => item.name === invocation[1]);
  if (!entry) throw new Error(`Unknown configured command: ${invocation[1]}`);
  const allowedTools = stringList(
    entry.metadata["allowed-tools"],
    "Command allowed-tools",
  );
  const permissions = new AgentPermissions({
    ...options,
    allowedTools:
      options.allowedTools && allowedTools
        ? [...new Set([...options.allowedTools, ...allowedTools])]
        : options.allowedTools,
  });
  new AgentPermissions(options).assertDenied("Skill", entry.name);
  const prepared = await preprocess(
    entry.instructions,
    { ...options, env: markdownEnvironment(entry, configuration, options.env) },
    permissions,
  );
  return {
    ...entry,
    instructions: substitute(
      { ...entry, instructions: prepared },
      invocation[2] ?? "",
      configuration,
    ),
    allowedTools,
    model:
      typeof entry.metadata.model === "string"
        ? entry.metadata.model
        : undefined,
  };
}
