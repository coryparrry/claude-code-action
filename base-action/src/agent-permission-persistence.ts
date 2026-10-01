import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { PermissionUpdate } from "./agent-permissions";

export type PermissionSettingsPaths = {
  userSettings?: string;
  projectSettings?: string;
  localSettings?: string;
};

/** Merge trusted hook updates into explicitly supplied settings files. */
export function persistPermissionUpdates(
  updates: PermissionUpdate[],
  paths: PermissionSettingsPaths,
): void {
  const prepared = new Map<string, Record<string, unknown>>();
  for (const update of updates) {
    if (!update.destination || update.destination === "session") continue;
    if (
      !["userSettings", "projectSettings", "localSettings"].includes(
        update.destination,
      )
    )
      throw new Error(
        `Unsupported permission destination: ${update.destination}`,
      );
    const pathInput =
      paths[update.destination as keyof PermissionSettingsPaths];
    if (!pathInput)
      throw new Error(
        `No trusted settings path configured for ${update.destination}`,
      );
    const path = resolve(pathInput);
    let existing = dirname(path);
    while (true) {
      try {
        lstatSync(existing);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        existing = dirname(existing);
      }
    }
    if (realpathSync(existing) !== existing)
      throw new Error("Permission settings paths cannot traverse symlinks");
    let document = prepared.get(path);
    if (!document) {
      try {
        const info = lstatSync(path);
        if (info.isSymbolicLink())
          throw new Error("Permission settings file cannot be a symlink");
        if (info.size > 1024 * 1024)
          throw new Error("Permission settings exceed 1 MiB");
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Permission settings must be a JSON object");
        document = parsed as Record<string, unknown>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        document = {};
      }
      prepared.set(path, document);
    }
    const value = document.permissions ?? {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Settings permissions must be an object");
    const permissions = { ...(value as Record<string, unknown>) };
    if (update.type === "setMode") permissions.defaultMode = update.mode;
    else if ("directories" in update) {
      const key = "additionalDirectories";
      const current = permissions[key] ?? [];
      if (
        !Array.isArray(current) ||
        current.some((entry) => typeof entry !== "string")
      )
        throw new Error(`Settings permissions.${key} must contain strings`);
      permissions[key] =
        update.type === "addDirectories"
          ? [...new Set([...current, ...update.directories])]
          : current.filter((path) => !update.directories.includes(path));
    } else if ("rules" in update) {
      const key = update.behavior;
      const current = permissions[key] ?? [];
      if (
        !Array.isArray(current) ||
        current.some((entry) => typeof entry !== "string")
      )
        throw new Error(`Settings permissions.${key} must contain strings`);
      const rules = update.rules.map((rule) =>
        rule.ruleContent === undefined
          ? rule.toolName
          : `${rule.toolName}(${rule.ruleContent})`,
      );
      permissions[key] =
        update.type === "replaceRules"
          ? rules
          : update.type === "addRules"
            ? [...new Set([...current, ...rules])]
            : current.filter((rule) => !rules.includes(rule));
    }
    document.permissions = permissions;
  }
  for (const [path, document] of prepared) {
    mkdirSync(dirname(path), { recursive: true });
    if (realpathSync(dirname(path)) !== dirname(path))
      throw new Error("Permission settings paths cannot traverse symlinks");
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(document, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
