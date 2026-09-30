import { readFile } from "node:fs/promises";
import { tomlString } from "./codex-config";
import { permittedToolVariable } from "./codex-tool-environment";

type ObjectValue = Record<string, unknown>;
const isObject = (value: unknown): value is ObjectValue =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Parse arguments without a shell: substitutions and metacharacters stay literal. */
export function splitCompatibilityArgs(raw: string): string[] {
  const result: string[] = [];
  let value = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index]!;
    if (
      character === "#" &&
      !quote &&
      /^\s*$/.test(raw.slice(raw.lastIndexOf("\n", index - 1) + 1, index))
    ) {
      const end = raw.indexOf("\n", index);
      if (end < 0) break;
      index = end - 1;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      const next = raw[++index];
      if (next === undefined)
        throw new Error("claude_args ends with an incomplete escape");
      if (next !== "\n")
        value +=
          quote === '"' && !["$", "`", '"', "\\"].includes(next)
            ? "\\" + next
            : next;
      if (next !== "\n") started = true;
    } else if (quote) {
      if (character === quote) quote = "";
      else value += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) result.push(value);
      value = "";
      started = false;
    } else {
      value += character;
      started = true;
    }
  }
  if (quote) throw new Error("claude_args contains an unterminated quote");
  if (started) result.push(value);
  return result;
}

export type Compatibility = {
  model?: string;
  effort?: string;
  appendSystemPrompt?: string;
  schema?: ObjectValue;
  skipGitRepoCheck?: boolean;
  mcpConfig: string;
  configOverrides: string[];
  toolEnvironment?: Record<string, string>;
};

async function jsonObject(raw: string, label: string): Promise<ObjectValue> {
  let contents = raw;
  if (!raw.trim().startsWith("{")) contents = await readFile(raw, "utf8");
  try {
    const value: unknown = JSON.parse(contents);
    if (!isObject(value)) throw new Error();
    return value;
  } catch {
    throw new Error(`${label} must be a JSON object or a path to one`);
  }
}

const nativeSettings: Record<string, (value: unknown) => boolean> = {
  model: (value) => typeof value === "string",
  model_reasoning_effort: (value) => typeof value === "string",
  model_reasoning_summary: (value) =>
    ["auto", "concise", "detailed", "none"].includes(String(value)),
  model_verbosity: (value) => ["low", "medium", "high"].includes(String(value)),
  developer_instructions: (value) => typeof value === "string",
  web_search: (value) => ["disabled", "cached", "live"].includes(String(value)),
};

function settingValue(value: unknown): string {
  if (typeof value === "string") return tomlString(value);
  if (typeof value === "boolean") return String(value);
  throw new Error("Unsupported Codex setting value");
}

/** Supported legacy options retain their meaning; unsupported controls fail closed. */
export async function resolveCompatibility(
  raw: string,
  settingsRaw: string,
  actionMcpConfig: string,
  defaultAllowedTools: string[] = [],
): Promise<Compatibility> {
  const result: Compatibility = {
    mcpConfig: actionMcpConfig,
    configOverrides: [],
  };
  const customServers: ObjectValue = {};
  let allowed: string[] | undefined;
  let denied: string[] = [];
  const addMcp = (config: ObjectValue) => {
    if (!isObject(config.mcpServers))
      throw new Error("MCP configuration must contain an mcpServers object");
    Object.assign(customServers, config.mcpServers);
  };
  if (settingsRaw.trim()) {
    let content = settingsRaw;
    if (
      !settingsRaw.trim().startsWith("{") &&
      !settingsRaw.includes("=") &&
      !settingsRaw.includes("\n")
    )
      content = await readFile(settingsRaw, "utf8");
    let settings: unknown;
    try {
      settings = content.trim().startsWith("{")
        ? JSON.parse(content)
        : Bun.TOML.parse(content);
    } catch {
      throw new Error(
        "settings must be valid Codex TOML or JSON, or a path to a configuration file",
      );
    }
    if (!isObject(settings)) throw new Error("settings must contain an object");
    for (const [key, value] of Object.entries(settings)) {
      if (key === "permissions" && isObject(value)) {
        if (
          Object.keys(value).some((name) => !["allow", "deny"].includes(name))
        )
          throw new Error(
            "Only permissions.allow and permissions.deny can be translated to Codex tool filters",
          );
        for (const name of ["allow", "deny"]) {
          const entries = value[name];
          if (
            entries !== undefined &&
            (!Array.isArray(entries) ||
              entries.some((entry) => typeof entry !== "string"))
          )
            throw new Error(
              `settings permissions.${name} must be a string array`,
            );
        }
        allowed = value.allow as string[] | undefined;
        denied = (value.deny ?? []) as string[];
      } else if (key === "env" && isObject(value)) {
        result.toolEnvironment = {};
        for (const [name, item] of Object.entries(value)) {
          if (typeof item !== "string" || !permittedToolVariable(name, item))
            throw new Error(
              `settings.env cannot override reserved or credential variable: ${name}`,
            );
          result.toolEnvironment[name] = item;
        }
      } else if (key === "mcpServers") {
        addMcp({ mcpServers: value });
      } else if (key === "mcp_servers" && isObject(value)) {
        for (const [name, server] of Object.entries(value)) {
          if (!isObject(server))
            throw new Error("settings mcp_servers must contain server objects");
          customServers[name] = server;
        }
      } else if (key === "features" && isObject(value)) {
        for (const [name, enabled] of Object.entries(value)) {
          if (
            !["shell_tool", "unified_exec", "apply_patch_freeform"].includes(
              name,
            ) ||
            typeof enabled !== "boolean"
          )
            throw new Error(`Unsupported settings feature: ${name}`);
          result.configOverrides.push(`features.${name}=${enabled}`);
        }
      } else if (nativeSettings[key]?.(value)) {
        result.configOverrides.push(`${key}=${settingValue(value)}`);
      } else {
        throw new Error(
          `Unsupported settings field: ${key}; supply a supported Codex configuration field`,
        );
      }
    }
  }
  const args = splitCompatibilityArgs(raw);
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    const separator = token.indexOf("=");
    const flag = separator < 0 ? token : token.slice(0, separator);
    if (flag === "--skip-git-repo-check") {
      result.skipGitRepoCheck = true;
      continue;
    }
    if (flag === "--max-turns")
      throw new Error(
        "--max-turns has no equivalent in Codex exec; use codex_timeout_minutes to bound execution time",
      );
    if (
      ![
        "--model",
        "--effort",
        "--mcp-config",
        "--json-schema",
        "--output-schema",
        "--allowedTools",
        "--disallowedTools",
        "--append-system-prompt",
      ].includes(flag)
    )
      throw new Error(`Unsupported claude_args flag: ${flag}`);
    const value = separator < 0 ? args[++index] : token.slice(separator + 1);
    if (!value || value.startsWith("--"))
      throw new Error(`${flag} requires a value`);
    if (flag === "--model") result.model = value;
    else if (flag === "--effort") result.effort = value;
    else if (flag === "--append-system-prompt")
      result.appendSystemPrompt = value;
    else if (flag === "--mcp-config")
      addMcp(await jsonObject(value, "--mcp-config"));
    else if (flag === "--json-schema" || flag === "--output-schema")
      result.schema = await jsonObject(value, "--json-schema");
    else {
      const tools = [value];
      if (separator < 0)
        while (args[index + 1] && !args[index + 1]!.startsWith("--"))
          tools.push(args[++index]!);
      const entries = tools.flatMap((entry) =>
        entry.split(/[\s,]+/).filter(Boolean),
      );
      if (flag === "--allowedTools") allowed = entries;
      else denied = entries;
    }
  }
  const action = await jsonObject(
    actionMcpConfig || '{"mcpServers":{}}',
    "MCP configuration",
  );
  if (!isObject(action.mcpServers))
    throw new Error("MCP configuration must contain an mcpServers object");
  for (const name of Object.keys(customServers)) {
    if (name in action.mcpServers)
      throw new Error(
        `Custom MCP server conflicts with action server: ${name}`,
      );
  }
  const servers = { ...customServers, ...action.mcpServers };
  result.mcpConfig = JSON.stringify({ mcpServers: servers });
  const shellNames = new Set(["Bash", "shell", "exec_command", "write_stdin"]);
  if (allowed !== undefined) {
    const availableDefaults = defaultAllowedTools.filter(
      (entry) =>
        shellNames.has(entry) ||
        Object.keys(servers).some(
          (name) =>
            entry === `mcp__${name}` || entry.startsWith(`mcp__${name}__`),
        ),
    );
    allowed = [...new Set([...allowed, ...availableDefaults])];
  }
  const filters = (entries: string[]) => {
    const byServer: Record<string, string[]> = {};
    for (const entry of entries) {
      if (shellNames.has(entry)) continue;
      const wholeServer = Object.keys(servers).find(
        (name) => entry === `mcp__${name}`,
      );
      const match = wholeServer
        ? [entry, wholeServer, "*"]
        : /^mcp__([^]+?)__(.+)$/.exec(entry);
      if (!match || !Object.hasOwn(servers, match[1]!))
        throw new Error(
          `Unsupported tool permission: ${entry}; use a full Bash permission, mcp__SERVER, or mcp__SERVER__TOOL`,
        );
      if (match[2]!.includes("*") && match[2] !== "*")
        throw new Error(`Unsupported MCP tool wildcard: ${entry}`);
      (byServer[match[1]!] ??= []).push(match[2]!);
    }
    return byServer;
  };
  const permitted = allowed === undefined ? undefined : filters(allowed);
  const blocked = filters(denied);
  for (const name of Object.keys(servers)) {
    const prefix = `mcp_servers.${tomlString(name)}`;
    if (permitted && !permitted[name]?.includes("*")) {
      if (!permitted[name]?.length)
        result.configOverrides.push(`${prefix}.enabled=false`);
      else
        result.configOverrides.push(
          `${prefix}.enabled_tools=${JSON.stringify(permitted[name])}`,
        );
    }
    if (blocked[name]?.includes("*"))
      result.configOverrides.push(`${prefix}.enabled=false`);
    else if (blocked[name]?.length)
      result.configOverrides.push(
        `${prefix}.disabled_tools=${JSON.stringify(blocked[name])}`,
      );
  }
  if (
    (allowed && !allowed.some((entry) => shellNames.has(entry))) ||
    denied.some((entry) => shellNames.has(entry))
  ) {
    result.configOverrides.push(
      "features.shell_tool=false",
      "features.unified_exec=false",
      "features.apply_patch_freeform=false",
    );
  }
  return result;
}
