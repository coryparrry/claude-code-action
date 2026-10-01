import type { AgentPlugin } from "./agent-configuration";

export function resolvePluginOptions(
  manifest: Record<string, unknown>,
  saved: Record<string, unknown>,
) {
  const schema = manifest.userConfig ?? {};
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    throw new Error("Plugin userConfig must be an object");
  const declarations = schema as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  const sensitiveKeys: string[] = [];
  for (const key of Object.keys(saved))
    if (!(key in declarations))
      throw new Error(`Unknown plugin option: ${key}`);
  for (const [key, entry] of Object.entries(declarations)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    )
      throw new Error(`Invalid plugin userConfig option: ${key}`);
    const declaration = entry as Record<string, unknown>;
    const accepted = [
      "type",
      "title",
      "description",
      "required",
      "default",
      "options",
      "multiple",
      "sensitive",
      "min",
      "max",
    ];
    if (Object.keys(declaration).some((field) => !accepted.includes(field)))
      throw new Error(`Unsupported plugin userConfig declaration: ${key}`);
    if (
      !["string", "number", "boolean", "directory", "file"].includes(
        String(declaration.type),
      )
    )
      throw new Error(`Invalid plugin option type: ${key}`);
    const value = saved[key] ?? declaration.default;
    if (
      declaration.required === true &&
      (value === undefined ||
        value === "" ||
        (Array.isArray(value) && !value.length))
    )
      throw new Error(
        `Required plugin option missing: ${key}; supply pluginConfigs values for headless execution`,
      );
    if (value === undefined) continue;
    if (declaration.multiple === true) {
      if (
        declaration.type !== "string" ||
        !Array.isArray(value) ||
        value.some((item) => typeof item !== "string")
      )
        throw new Error(`Plugin option ${key} requires a string array`);
    } else if (declaration.type === "number") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (typeof declaration.min === "number" && value < declaration.min) ||
        (typeof declaration.max === "number" && value > declaration.max)
      )
        throw new Error(`Plugin option ${key} is outside numeric bounds`);
    } else if (
      typeof value !== (declaration.type === "boolean" ? "boolean" : "string")
    )
      throw new Error(`Invalid plugin option value: ${key}`);
    if (
      declaration.options !== undefined &&
      (!Array.isArray(declaration.options) ||
        !declaration.options.includes(value))
    )
      throw new Error(`Plugin option ${key} must match a declared option`);
    values[key] = value;
    if (declaration.sensitive === true) sensitiveKeys.push(key);
  }
  return { values, sensitiveKeys };
}

/** Sensitive values are placeholders in model-visible skills/agents, usable in process config. */
export function substitutePluginConfiguration(
  value: unknown,
  plugin: AgentPlugin,
  revealSensitive = false,
): unknown {
  if (typeof value === "string")
    return value
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin.root)
      .replaceAll("${CODEX_PLUGIN_ROOT}", plugin.root)
      .replaceAll("${CLAUDE_PLUGIN_DATA}", plugin.dataDirectory)
      .replaceAll("${CODEX_PLUGIN_DATA}", plugin.dataDirectory)
      .replace(
        /\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g,
        (_, key: string) => {
          if (!revealSensitive && plugin.sensitiveConfigKeys?.includes(key))
            return `[sensitive plugin option: ${key}]`;
          const item = plugin.userConfigValues?.[key];
          if (item === undefined)
            throw new Error(`Plugin option ${key} has no configured value`);
          return typeof item === "string" ? item : JSON.stringify(item);
        },
      );
  if (Array.isArray(value))
    return value.map((item) =>
      substitutePluginConfiguration(item, plugin, revealSensitive),
    );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw new Error("Reserved plugin configuration property");
        if (
          key === "headersHelper" &&
          typeof item === "string" &&
          item.includes("${user_config.")
        )
          throw new Error(
            "MCP headersHelper must read plugin option environment variables rather than user_config shell interpolation",
          );
        return [
          key,
          substitutePluginConfiguration(item, plugin, revealSensitive),
        ];
      }),
    );
  return value;
}
