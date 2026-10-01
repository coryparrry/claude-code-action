import { canonicalToolName } from "./agent-permissions";
import type { PermissionUpdate } from "./agent-permissions";

function glob(pattern: string, file = false): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else source += ".*";
      } else source += file ? "[^/]*" : ".*";
    } else if (character === "?") source += file ? "[^/]" : ".";
    else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Hook conditions are best-effort filters, never a replacement for tool authorization. */
export function hookConditionMatches(
  rule: string,
  event: string,
  input: Record<string, unknown>,
  workspace: string,
): boolean {
  if (
    ![
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionRequest",
    ].includes(event)
  )
    return false;
  const parts = /^([^()]+)(?:\((.*)\))?$/.exec(rule)!;
  const name = canonicalToolName(String(input.tool_name ?? ""));
  const requested = canonicalToolName(parts[1]!);
  if (
    !glob(requested).test(name) &&
    !(requested.startsWith("mcp__") && name.startsWith(`${requested}__`))
  )
    return false;
  const scope = parts[2];
  if (scope === undefined) return true;
  const parameters =
    input.tool_input && typeof input.tool_input === "object"
      ? (input.tool_input as Record<string, unknown>)
      : {};
  if (name === "Bash") {
    const command = String(parameters.command ?? "");
    // Expansion makes the executable uncertain. Conservatively activate the hook.
    if (/[$`]/.test(command)) return true;
    const pattern = scope.endsWith(":*") ? `${scope.slice(0, -2)}*` : scope;
    return command
      .split(/[;&|\n]+/)
      .some((piece) =>
        glob(pattern).test(
          piece
            .trim()
            .replace(
              /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)+/,
              "",
            ),
        ),
      );
  }
  const target =
    parameters.file_path ??
    parameters.path ??
    parameters.pattern ??
    parameters.url;
  if (target === undefined) return true;
  const path = String(target).replaceAll("\\", "/");
  const relative = path.startsWith(`${workspace}/`)
    ? path.slice(workspace.length + 1)
    : path;
  const pattern = scope.startsWith("./") ? scope.slice(2) : scope;
  return (
    glob(pattern, true).test(relative) ||
    (!pattern.includes("/") &&
      glob(pattern, true).test(relative.split("/").at(-1)!))
  );
}

export function parsePermissionUpdates(value: unknown): PermissionUpdate[] {
  if (!Array.isArray(value))
    throw new Error("updatedPermissions must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Permission update must be an object");
    const update = entry as Record<string, unknown>;
    if (
      update.destination !== undefined &&
      !["session", "localSettings", "projectSettings", "userSettings"].includes(
        String(update.destination),
      )
    )
      throw new Error("Invalid permission update destination");
    let fields: string[];
    if (
      ["addRules", "replaceRules", "removeRules"].includes(String(update.type))
    ) {
      fields = ["type", "rules", "behavior", "destination"];
      if (
        !["allow", "deny", "ask"].includes(String(update.behavior)) ||
        !Array.isArray(update.rules)
      )
        throw new Error(
          "Permission rule update requires rules and allow/deny/ask behavior",
        );
      for (const entry of update.rules) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          throw new Error("Permission rule must be an object");
        const rule = entry as Record<string, unknown>;
        if (
          typeof rule.toolName !== "string" ||
          !rule.toolName ||
          (rule.ruleContent !== undefined &&
            typeof rule.ruleContent !== "string") ||
          Object.keys(rule).some(
            (key) => !["toolName", "ruleContent"].includes(key),
          )
        )
          throw new Error("Invalid permission update rule");
      }
    } else if (update.type === "setMode") {
      fields = ["type", "mode", "destination"];
      if (
        ![
          "default",
          "auto",
          "acceptEdits",
          "dontAsk",
          "bypassPermissions",
          "plan",
          "manual",
        ].includes(String(update.mode))
      )
        throw new Error("Invalid permission update mode");
    } else if (
      ["addDirectories", "removeDirectories"].includes(String(update.type))
    ) {
      fields = ["type", "directories", "destination"];
      if (
        !Array.isArray(update.directories) ||
        update.directories.some((path) => typeof path !== "string" || !path)
      )
        throw new Error("Permission directory update requires path strings");
    } else
      throw new Error(`Unsupported permission update type: ${update.type}`);
    if (Object.keys(update).some((key) => !fields.includes(key)))
      throw new Error("Unsupported permission update field");
    return update as PermissionUpdate;
  });
}

export function substituteHookInput(
  value: unknown,
  payload: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    const read = (path: string): unknown =>
      path
        .split(".")
        .reduce<unknown>(
          (current, key) =>
            current && typeof current === "object"
              ? (current as Record<string, unknown>)[key]
              : undefined,
          payload,
        );
    const full = /^\$\{([A-Za-z_][A-Za-z0-9_.]*)\}$/.exec(value);
    if (full) return read(full[1]!);
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g,
      (_, path: string) => {
        const item = read(path);
        return typeof item === "string" ? item : (JSON.stringify(item) ?? "");
      },
    );
  }
  if (Array.isArray(value))
    return value.map((item) => substituteHookInput(item, payload));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substituteHookInput(item, payload),
      ]),
    );
  return value;
}
