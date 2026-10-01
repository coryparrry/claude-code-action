import { lstat, realpath } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  persistPermissionUpdates,
  type PermissionSettingsPaths,
} from "./agent-permission-persistence";

export type AgentPermissionOptions = {
  cwd: string;
  additionalDirectories?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  askTools?: string[];
  permissionMode?: string;
  sandboxMode?: string;
  permissionSettingsPaths?: PermissionSettingsPaths;
};
export type PermissionUpdate =
  | {
      type: "addRules" | "replaceRules" | "removeRules";
      rules: { toolName: string; ruleContent?: string }[];
      behavior: "allow" | "deny" | "ask";
      destination?: string;
    }
  | { type: "setMode"; mode: string; destination?: string }
  | {
      type: "addDirectories" | "removeDirectories";
      directories: string[];
      destination?: string;
    };

const aliases: Record<string, string> = {
  shell: "Bash",
  exec_command: "Bash",
  write_stdin: "Bash",
  read_file: "Read",
  write_file: "Write",
  apply_patch: "Edit",
  MultiEdit: "Edit",
  glob: "Glob",
  grep: "Grep",
  ls: "LS",
  list_directory: "LS",
  notebook_edit: "NotebookEdit",
  todo_write: "TodoWrite",
  TaskOutput: "BashOutput",
  TaskStop: "KillShell",
};
export function canonicalToolName(name: string): string {
  return aliases[name] ?? name;
}

/** Glob matching for permission paths and file discovery, without a shell. */
export function globPattern(pattern: string): RegExp {
  let result = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          result += "(?:.*/)?";
        } else result += ".*";
      } else result += "[^/]*";
    } else if (character === "?") result += "[^/]";
    else result += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${result}$`);
}

function ruleParts(rule: string): { name: string; scope?: string } {
  const match = /^([^()]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!match) throw new Error(`Invalid tool permission rule: ${rule}`);
  return { name: canonicalToolName(match[1]!), scope: match[2] };
}

function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === "" ||
    (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part))
  );
}

/** Scoped shell rules reject all shell composition, even in quoted arguments. */
export function isSimpleShellCommand(command: string): boolean {
  return (
    command.trim().length > 0 &&
    !/[;&|<>`$(){}\n\r\\#]/.test(command) &&
    shellWords(command) !== undefined
  );
}

function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "",
    quote = "",
    started = false;
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = "";
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

export class AgentPermissions {
  private allowed?: ReturnType<typeof ruleParts>[];
  private denied: ReturnType<typeof ruleParts>[] = [];
  private asked: ReturnType<typeof ruleParts>[] = [];
  private readonly authorization = new AsyncLocalStorage<{
    name: string;
    target?: string;
  }>();
  private roots?: Promise<string[]>;

  constructor(readonly options: AgentPermissionOptions) {
    this.update(options);
  }

  get readOnly(): boolean {
    return (
      this.options.sandboxMode === "read-only" ||
      ["plan", "readonly", "read-only"].includes(
        this.options.permissionMode ?? "",
      )
    );
  }

  update(update: Partial<AgentPermissionOptions>): void {
    if (update.cwd !== undefined && update.cwd !== this.options.cwd)
      throw new Error("Permission updates cannot change the workspace root");
    const combined = { ...this.options, ...update };
    const allowed = combined.allowedTools?.map(ruleParts);
    const denied = (combined.disallowedTools ?? []).map(ruleParts);
    const asked = (combined.askTools ?? []).map(ruleParts);
    Object.assign(this.options, combined);
    this.allowed = allowed;
    this.denied = denied;
    this.asked = asked;
    this.roots = undefined;
  }

  applyUpdates(updates: PermissionUpdate[]): void {
    const next = { ...this.options };
    for (const update of updates) {
      if (update.type === "setMode") next.permissionMode = update.mode;
      else if (
        update.type === "addDirectories" ||
        update.type === "removeDirectories"
      ) {
        const directories = update.directories.map((path) =>
          resolve(next.cwd, path),
        );
        const current = (next.additionalDirectories ?? []).map((path) =>
          resolve(next.cwd, path),
        );
        next.additionalDirectories =
          update.type === "addDirectories"
            ? [...new Set([...current, ...directories])]
            : current.filter((path) => !directories.includes(path));
      } else if ("rules" in update) {
        const key =
          update.behavior === "allow"
            ? "allowedTools"
            : update.behavior === "deny"
              ? "disallowedTools"
              : "askTools";
        const rules = update.rules.map((rule) =>
          rule.ruleContent === undefined
            ? rule.toolName
            : `${rule.toolName}(${rule.ruleContent})`,
        );
        const current = next[key] ?? [];
        next[key] =
          update.type === "replaceRules"
            ? rules
            : update.type === "addRules"
              ? [...new Set([...current, ...rules])]
              : current.filter((rule) => !rules.includes(rule));
      }
    }
    next.allowedTools?.map(ruleParts);
    next.disallowedTools?.map(ruleParts);
    next.askTools?.map(ruleParts);
    persistPermissionUpdates(updates, next.permissionSettingsPaths ?? {});
    this.update(next);
  }

  private matches(
    rule: ReturnType<typeof ruleParts>,
    name: string,
    target?: string,
  ): boolean {
    if (
      !globPattern(rule.name).test(name) &&
      !(
        rule.name.startsWith("mcp__") &&
        !rule.name.includes("__", 5) &&
        name.startsWith(`${rule.name}__`)
      )
    )
      return false;
    if (rule.scope === undefined) return true;
    if (target === undefined) return false;
    if (name === "WebFetch" && rule.scope.startsWith("domain:")) {
      try {
        return globPattern(rule.scope.slice(7).toLowerCase()).test(
          new URL(target).hostname.toLowerCase(),
        );
      } catch {
        return false;
      }
    }
    if (name === "Bash" || name === "PowerShell") {
      if (!isSimpleShellCommand(target)) return false;
      const prefix = rule.scope.endsWith(":*")
        ? rule.scope.slice(0, -2)
        : rule.scope;
      const commandWords = shellWords(target)!;
      const prefixWords = shellWords(prefix);
      if (!prefixWords?.length) return false;
      return (
        prefixWords.every((word, index) => commandWords[index] === word) &&
        (rule.scope.endsWith(":*") ||
          commandWords.length === prefixWords.length)
      );
    }
    const absolute = resolve(this.options.cwd, rule.scope);
    if (
      rule.scope.endsWith("/**") &&
      resolve(this.options.cwd, target) ===
        resolve(this.options.cwd, rule.scope.slice(0, -3))
    )
      return true;
    return globPattern(absolute.split(sep).join("/")).test(
      resolve(this.options.cwd, target).split(sep).join("/"),
    );
  }

  assertDenied(name: string, target?: string): void {
    name = canonicalToolName(name);
    if (
      this.readOnly &&
      [
        "Bash",
        "PowerShell",
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
      ].includes(name)
    )
      throw new Error(`${name} is unavailable in read-only/plan mode`);
    // A composed command must never bypass a scoped deny rule by hiding the denied
    // executable behind another command. Unrestricted deny rules also match normally.
    if (
      ["Bash", "PowerShell"].includes(name) &&
      target &&
      !isSimpleShellCommand(target) &&
      this.denied.some((rule) => rule.name === name && rule.scope !== undefined)
    )
      throw new Error(
        "Shell composition is denied when scoped Bash denials exist",
      );
    if (this.denied.some((rule) => this.matches(rule, name, target)))
      throw new Error(`Tool permission denied: ${name}`);
    if (
      this.asked.some((rule) => this.matches(rule, name, target)) ||
      (["Bash", "PowerShell"].includes(name) &&
        target &&
        !isSimpleShellCommand(target) &&
        this.asked.some(
          (rule) => rule.name === name && rule.scope !== undefined,
        ))
    )
      throw new Error(
        `Tool permission requires an interactive ask rule: ${name}`,
      );
  }

  needsApproval(name: string, target?: string): boolean {
    name = canonicalToolName(name);
    this.assertDenied(name, target);
    if (name === "AskUserQuestion") return true;
    if (name === "ExitPlanMode")
      return !this.allowed?.some((rule) => this.matches(rule, name, target));
    if (
      [
        "Read",
        "Glob",
        "Grep",
        "LS",
        "TodoWrite",
        "BashOutput",
        "KillShell",
        "EnterPlanMode",
      ].includes(name)
    )
      return false;
    const acceptedEdit =
      this.options.permissionMode === "acceptEdits" &&
      (["Write", "Edit", "NotebookEdit"].includes(name) ||
        (name === "Bash" &&
          target !== undefined &&
          this.automaticShellPaths(target) !== undefined));
    if (
      name === "Bash" &&
      target &&
      isSimpleShellCommand(target) &&
      ["pwd", "echo", "printf", "true", "false"].includes(
        shellWords(target)![0] ?? "",
      )
    )
      return false;
    return (
      !acceptedEdit &&
      this.options.permissionMode !== "bypassPermissions" &&
      !this.allowed?.some((rule) => this.matches(rule, name, target))
    );
  }

  authorize(
    name: string,
    target?: string,
    decision?: "allow" | "deny" | "ask" | "defer",
  ): void {
    this.assertDenied(name, target);
    if (decision === "deny" || decision === "ask")
      throw new Error(
        `Tool permission ${decision === "deny" ? "denied by hook" : "requires interactive approval"}: ${name}`,
      );
    if (decision !== "allow" && this.needsApproval(name, target))
      throw new Error(`Tool permission not allowed without approval: ${name}`);
  }

  async withAuthorization<T>(
    name: string,
    target: string | undefined,
    execute: () => Promise<T>,
  ): Promise<T> {
    if (
      name === "Bash" &&
      target &&
      this.options.permissionMode === "acceptEdits"
    ) {
      const paths = this.automaticShellPaths(target);
      if (paths) for (const path of paths) await this.resolveBoundary(path);
    }
    return this.authorization.run(
      {
        name: canonicalToolName(name),
        target: this.normalizedTarget(name, target),
      },
      execute,
    );
  }

  private automaticShellPaths(command: string): string[] | undefined {
    if (!isSimpleShellCommand(command)) return undefined;
    const words = shellWords(command)!;
    const executable = words.shift();
    if (
      !["mkdir", "touch", "rm", "rmdir", "mv", "cp", "sed"].includes(
        executable ?? "",
      )
    )
      return undefined;
    const flags = new Set([
      "--",
      "-p",
      "-f",
      "-r",
      "-R",
      "-rf",
      "-fr",
      "-a",
      "-n",
      "-v",
      "-i",
      "-i.bak",
    ]);
    const paths: string[] = [];
    let expression = executable !== "sed";
    for (const word of words) {
      if (word.startsWith("-")) {
        if (!flags.has(word)) return undefined;
        continue;
      }
      if (!expression) {
        if (!/^s([^\w\s]).*\1.*\1[gIp]*$/.test(word)) return undefined;
        expression = true;
        continue;
      }
      if (!word || /[*?\[\]~]/.test(word)) return undefined;
      const path = resolve(this.options.cwd, word);
      const roots = [
        this.options.cwd,
        ...(this.options.additionalDirectories ?? []).map((root) =>
          resolve(this.options.cwd, root),
        ),
      ];
      if (!roots.some((root) => within(root, path))) return undefined;
      if (
        (executable === "rm" || executable === "rmdir") &&
        roots.some((root) => path === root || path === resolve(root, ".git"))
      )
        return undefined;
      if (
        [".git", ".claude"].some(
          (directory) =>
            path === resolve(this.options.cwd, directory) ||
            within(resolve(this.options.cwd, directory), path),
        )
      )
        return undefined;
      paths.push(path);
    }
    return expression && paths.length > 0 ? paths : undefined;
  }

  private normalizedTarget(name: string, target?: string): string | undefined {
    if (target === undefined) return target;
    return [
      "Read",
      "Write",
      "Edit",
      "NotebookEdit",
      "Glob",
      "Grep",
      "LS",
      "LSP",
    ].includes(canonicalToolName(name))
      ? resolve(this.options.cwd, target)
      : target;
  }

  assertTool(name: string, target?: string): void {
    this.assertDenied(name, target);
    const grant = this.authorization.getStore();
    if (
      grant?.name === canonicalToolName(name) &&
      grant.target === this.normalizedTarget(name, target)
    )
      return;
    this.authorize(name, target);
  }

  /** Check both lexical and physical roots, including the nearest existing parent. */
  async resolvePath(name: string, path: string): Promise<string> {
    const absolute = resolve(this.options.cwd, path);
    this.assertTool(name, absolute);
    return this.resolveBoundary(absolute);
  }

  async resolveBoundary(path: string): Promise<string> {
    const absolute = resolve(this.options.cwd, path);
    this.roots ??= Promise.all(
      [this.options.cwd, ...(this.options.additionalDirectories ?? [])].map(
        async (root) => {
          const resolved = resolve(this.options.cwd, root);
          const physical = await realpath(resolved);
          if (physical !== resolved)
            throw new Error(
              `Permission root must not be a symlink: ${resolved}`,
            );
          return physical;
        },
      ),
    );
    const roots = await this.roots;
    if (!roots.some((root) => within(root, absolute)))
      throw new Error("Path is outside permitted directories");
    let existing = absolute;
    while (true) {
      try {
        await lstat(existing);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
    const physical = await realpath(existing);
    // Reject internal symlinks too: this makes path-scoped allow/deny rules reliable.
    if (physical !== existing || !roots.some((root) => within(root, physical)))
      throw new Error("Symlink paths are not permitted");
    return absolute;
  }
}
