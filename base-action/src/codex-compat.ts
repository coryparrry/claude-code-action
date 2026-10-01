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
  systemPrompt?: string;
  appendSystemPrompt?: string;
  additionalDirectories?: string[];
  resumeThreadId?: string;
  resumeSession?: string;
  continueSession?: boolean;
  strictMcpConfig?: boolean;
  pluginRoots?: string[];
  agentName?: string;
  agentDefinitions?: ObjectValue;
  persistSession?: boolean;
  disableSlashCommands?: boolean;
  debug?: boolean;
  verbose?: boolean;
  outputFormat?: "json" | "stream-json";
  includePartialMessages?: boolean;
  maxTurns?: number;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  permissionMode?: string;
  settingSources?: string[];
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  askTools?: string[];
  normalizedSettings?: ObjectValue;
  schema?: ObjectValue;
  skipGitRepoCheck?: boolean;
  mcpConfig: string;
  configOverrides: string[];
  toolEnvironment?: Record<string, string>;
};

export type DirectCompatibilityOptions = {
  model?: string;
  effort?: string;
  maxTurns?: number | string;
  maxBudgetUsd?: number | string;
  fallbackModel?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  additionalDirectories?: string[];
  resumeThreadId?: string;
  resumeSession?: string;
  continueSession?: boolean;
  strictMcpConfig?: boolean;
  pluginRoots?: string[];
  agentName?: string;
  agentDefinitions?: ObjectValue;
  persistSession?: boolean;
  disableSlashCommands?: boolean;
  debug?: boolean;
  verbose?: boolean;
  outputFormat?: "json" | "stream-json";
  includePartialMessages?: boolean;
  permissionMode?: string;
  settingSources?: string[];
  tools?: string | string[];
  allowedTools?: string | string[];
  disallowedTools?: string | string[];
  askTools?: string | string[];
};

/** The default Codex model exposes xhigh as its highest supported API effort. */
export function normalizeCodexEffort(
  effort?: string,
  model = "gpt-5.3-codex",
): string | undefined {
  return (effort === "max" || effort === "ultra") &&
    (model === "gpt-5.3-codex" || model.startsWith("gpt-5.3-codex-"))
    ? "xhigh"
    : effort;
}

/** Keep scoped rule contents intact, including whitespace/commas inside parentheses. */
function toolRules(values: string | string[]): string[] {
  const rules: string[] = [];
  for (const value of typeof values === "string" ? [values] : values) {
    let rule = "";
    let depth = 0;
    for (const character of value) {
      if (character === "(") depth++;
      else if (character === ")") depth = Math.max(0, depth - 1);
      if (depth === 0 && /[\s,]/.test(character)) {
        if (rule.trim()) rules.push(rule.trim());
        rule = "";
      } else rule += character;
    }
    if (rule.trim()) rules.push(rule.trim());
  }
  return [...new Set(rules)];
}

function booleanFlag(token: string): boolean {
  const separator = token.indexOf("=");
  if (separator < 0) return true;
  const value = token.slice(separator + 1);
  if (!["true", "false"].includes(value))
    throw new Error(
      `${token.slice(0, separator)} requires a boolean when assigned a value`,
    );
  return value === "true";
}

function positiveNumber(
  value: string | number,
  label: string,
  integer = false,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (
    (typeof value === "string" && !value.trim()) ||
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    (integer && !Number.isSafeInteger(parsed))
  )
    throw new Error(
      `${label} must be a positive ${integer ? "safe integer" : "number"}`,
    );
  return parsed;
}

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
  directOptions: DirectCompatibilityOptions = {},
): Promise<Compatibility> {
  const result: Compatibility = {
    mcpConfig: actionMcpConfig,
    configOverrides: [],
    settingSources: ["user", "project", "local"],
  };
  const customServers: ObjectValue = {};
  let allowed: string[] | undefined;
  let denied: string[] = [];
  let asked: string[] = [];
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
    result.normalizedSettings = settings;
    for (const [key, value] of Object.entries(settings)) {
      if (key === "permissions" && isObject(value)) {
        if (value.defaultMode !== undefined) {
          if (typeof value.defaultMode !== "string")
            throw new Error(
              "settings permissions.defaultMode must be a string",
            );
          result.permissionMode = value.defaultMode;
        }
        if (value.additionalDirectories !== undefined) {
          if (
            !Array.isArray(value.additionalDirectories) ||
            value.additionalDirectories.some((item) => typeof item !== "string")
          )
            throw new Error(
              "settings permissions.additionalDirectories must be a string array",
            );
          result.additionalDirectories =
            value.additionalDirectories as string[];
        }
        for (const name of ["allow", "deny", "ask"]) {
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
        asked = (value.ask ?? []) as string[];
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
        if (key === "model") result.model = value as string;
        if (key === "model_reasoning_effort") result.effort = value as string;
        if (key === "developer_instructions")
          result.systemPrompt = value as string;
        result.configOverrides.push(`${key}=${settingValue(value)}`);
      } else if (
        [
          "approval_policy",
          "shell_environment_policy",
          "model_provider",
          "forced_login_method",
          "cli_auth_credentials_store",
        ].includes(key)
      ) {
        throw new Error(
          `Unsupported settings field: ${key}; authentication and security are controlled by the action`,
        );
      }
      // Other legacy settings (including hooks/plugins) remain available to the engine loader.
    }
  }
  const args = splitCompatibilityArgs(raw);
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    const separator = token.indexOf("=");
    const flag = separator < 0 ? token : token.slice(0, separator);
    const booleans: Record<
      string,
      | "strictMcpConfig"
      | "disableSlashCommands"
      | "debug"
      | "verbose"
      | "includePartialMessages"
    > = {
      "--strict-mcp-config": "strictMcpConfig",
      "--disable-slash-commands": "disableSlashCommands",
      "--debug": "debug",
      "--verbose": "verbose",
      "--include-partial-messages": "includePartialMessages",
    };
    const booleanName = booleans[flag];
    if (booleanName) {
      result[booleanName] = booleanFlag(token);
      continue;
    }
    if (flag === "--no-session-persistence") {
      result.persistSession = !booleanFlag(token);
      continue;
    }
    if (flag === "--skip-git-repo-check") {
      result.skipGitRepoCheck = true;
      continue;
    }
    if (flag === "--continue") {
      if (
        separator >= 0 &&
        !["true", "false"].includes(token.slice(separator + 1))
      )
        throw new Error("--continue requires a boolean when assigned a value");
      result.continueSession =
        separator < 0 || token.slice(separator + 1) === "true";
      continue;
    }
    if (
      ![
        "--model",
        "--max-turns",
        "--max-budget-usd",
        "--fallback-model",
        "--permission-mode",
        "--setting-sources",
        "--tools",
        "--plugin-dir",
        "--agent",
        "--agents",
        "--output-format",
        "--system-prompt-file",
        "--append-system-prompt-file",
        "--effort",
        "--mcp-config",
        "--json-schema",
        "--output-schema",
        "--allowedTools",
        "--allowed-tools",
        "--disallowedTools",
        "--disallowed-tools",
        "--add-dir",
        "--system-prompt",
        "--resume",
        "--append-system-prompt",
      ].includes(flag)
    )
      throw new Error(`Unsupported claude_args flag: ${flag}`);
    const value = separator < 0 ? args[++index] : token.slice(separator + 1);
    if (
      value === undefined ||
      (value === "" && !["--tools", "--setting-sources"].includes(flag)) ||
      value.startsWith("--")
    )
      throw new Error(`${flag} requires a value`);
    if (flag === "--model") result.model = value;
    else if (flag === "--max-turns")
      result.maxTurns = positiveNumber(value, "--max-turns", true);
    else if (flag === "--max-budget-usd")
      result.maxBudgetUsd = positiveNumber(value, "--max-budget-usd");
    else if (flag === "--fallback-model") result.fallbackModel = value;
    else if (flag === "--permission-mode") result.permissionMode = value;
    else if (flag === "--setting-sources") {
      result.settingSources = toolRules(value);
      if (
        result.settingSources.some(
          (source) => !["user", "project", "local"].includes(source),
        )
      )
        throw new Error("--setting-sources supports user, project, and local");
    } else if (flag === "--plugin-dir") {
      const roots = [value];
      if (separator < 0)
        while (args[index + 1] && !args[index + 1]!.startsWith("--"))
          roots.push(args[++index]!);
      result.pluginRoots = [
        ...new Set([...(result.pluginRoots || []), ...roots]),
      ];
    } else if (flag === "--agent") result.agentName = value;
    else if (flag === "--agents") {
      let definitions: unknown;
      try {
        definitions = JSON.parse(value);
      } catch {
        throw new Error("--agents must contain JSON agent definitions");
      }
      if (!isObject(definitions))
        throw new Error("--agents must contain JSON agent definitions");
      result.agentDefinitions = {
        ...(result.agentDefinitions || {}),
        ...definitions,
      };
    } else if (flag === "--output-format") {
      if (!["json", "stream-json"].includes(value))
        throw new Error(
          "--output-format must be json or stream-json for action report output",
        );
      result.outputFormat = value as "json" | "stream-json";
    } else if (flag === "--system-prompt-file")
      result.systemPrompt = await readFile(value, "utf8");
    else if (flag === "--append-system-prompt-file")
      result.appendSystemPrompt = await readFile(value, "utf8");
    else if (flag === "--effort") result.effort = value;
    else if (flag === "--system-prompt") {
      result.systemPrompt = value;
      result.configOverrides = result.configOverrides.filter(
        (override) => !override.startsWith("developer_instructions="),
      );
      result.configOverrides.push(
        `developer_instructions=${tomlString(value)}`,
      );
    } else if (flag === "--resume") result.resumeThreadId = value;
    else if (flag === "--add-dir") {
      const directories = [value];
      if (separator < 0)
        while (args[index + 1] && !args[index + 1]!.startsWith("--"))
          directories.push(args[++index]!);
      result.additionalDirectories = [
        ...new Set([...(result.additionalDirectories || []), ...directories]),
      ];
    } else if (flag === "--append-system-prompt")
      result.appendSystemPrompt = value;
    else if (flag === "--mcp-config") {
      const configs = [value];
      if (separator < 0)
        while (args[index + 1] && !args[index + 1]!.startsWith("--"))
          configs.push(args[++index]!);
      for (const config of configs)
        addMcp(await jsonObject(config, "--mcp-config"));
    } else if (flag === "--json-schema" || flag === "--output-schema")
      result.schema = await jsonObject(value, "--json-schema");
    else {
      const tools = [value];
      if (separator < 0)
        while (args[index + 1] && !args[index + 1]!.startsWith("--"))
          tools.push(args[++index]!);
      const entries = toolRules(tools);
      if (flag === "--tools") result.tools = entries;
      else if (flag === "--allowedTools" || flag === "--allowed-tools")
        allowed = [...new Set([...(allowed || []), ...entries])];
      else denied = [...new Set([...denied, ...entries])];
    }
  }
  const action = await jsonObject(
    actionMcpConfig || '{"mcpServers":{}}',
    "MCP configuration",
  );
  if (!isObject(action.mcpServers))
    throw new Error("MCP configuration must contain an mcpServers object");
  const servers = { ...action.mcpServers, ...customServers };
  if (directOptions.allowedTools !== undefined)
    allowed = [
      ...new Set([
        ...(allowed || []),
        ...toolRules(directOptions.allowedTools),
      ]),
    ];
  if (directOptions.disallowedTools !== undefined)
    denied = [
      ...new Set([...denied, ...toolRules(directOptions.disallowedTools)]),
    ];
  if (directOptions.askTools !== undefined)
    asked = [...new Set([...asked, ...toolRules(directOptions.askTools)])];
  for (const field of [
    "model",
    "effort",
    "fallbackModel",
    "systemPrompt",
    "appendSystemPrompt",
    "resumeThreadId",
    "continueSession",
    "strictMcpConfig",
    "agentName",
    "persistSession",
    "disableSlashCommands",
    "debug",
    "verbose",
    "outputFormat",
    "includePartialMessages",
    "permissionMode",
    "settingSources",
  ] as const) {
    const value = directOptions[field];
    if (value !== undefined) Object.assign(result, { [field]: value });
  }
  if (directOptions.pluginRoots)
    result.pluginRoots = [
      ...new Set([...(result.pluginRoots || []), ...directOptions.pluginRoots]),
    ];
  if (directOptions.agentDefinitions)
    result.agentDefinitions = {
      ...(result.agentDefinitions || {}),
      ...directOptions.agentDefinitions,
    };
  if (
    result.outputFormat &&
    !["json", "stream-json"].includes(result.outputFormat)
  )
    throw new Error(
      "outputFormat must be json or stream-json for action report output",
    );
  if (directOptions.resumeSession !== undefined)
    result.resumeThreadId = directOptions.resumeSession;
  result.resumeSession = result.resumeThreadId;
  result.effort = normalizeCodexEffort(result.effort, result.model);
  result.askTools = asked.length ? [...new Set(asked)] : undefined;
  if (directOptions.maxTurns !== undefined)
    result.maxTurns = positiveNumber(directOptions.maxTurns, "maxTurns", true);
  if (directOptions.maxBudgetUsd !== undefined)
    result.maxBudgetUsd = positiveNumber(
      directOptions.maxBudgetUsd,
      "maxBudgetUsd",
    );
  if (directOptions.additionalDirectories)
    result.additionalDirectories = [
      ...new Set([
        ...(result.additionalDirectories || []),
        ...directOptions.additionalDirectories,
      ]),
    ];
  if (directOptions.tools !== undefined)
    result.tools = toolRules(directOptions.tools);
  if (result.systemPrompt !== undefined) {
    result.configOverrides = result.configOverrides.filter(
      (override) => !override.startsWith("developer_instructions="),
    );
    result.configOverrides.push(
      `developer_instructions=${tomlString(result.systemPrompt)}`,
    );
  }
  result.mcpConfig = JSON.stringify({ mcpServers: servers });
  const shellNames = new Set(["Bash", "shell", "exec_command", "write_stdin"]);
  if (allowed !== undefined) {
    const availableDefaults = defaultAllowedTools.filter(
      (entry) =>
        !entry.startsWith("mcp__") ||
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
      if (!match || !Object.hasOwn(servers, match[1]!)) continue;
      if (match[2]!.includes("*") && match[2] !== "*") continue;
      (byServer[match[1]!] ??= []).push(match[2]!);
    }
    return byServer;
  };
  result.allowedTools = allowed;
  result.disallowedTools = denied.length ? [...new Set(denied)] : undefined;
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
