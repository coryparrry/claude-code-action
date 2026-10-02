import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { AgentInputItem } from "@openai/agents";

const execFileAsync = promisify(execFile);
export type SubagentCheckpoint = {
  version: 1;
  taskId: string;
  agentName: string;
  history: AgentInputItem[];
  isolation?: "worktree";
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeBaseSha?: string;
};

function safeName(value: string): string {
  if (!/^[\w.:-]{1,100}$/.test(value) || value === "." || value === "..")
    throw new Error("Subagent identity contains unsupported characters");
  return value.replace(/:/g, "--");
}

function taskId(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value))
    throw new Error("Invalid subagent resume ID");
  return value;
}

export async function loadSubagentCheckpoint(
  directory: string | undefined,
  id: string,
  name: string,
): Promise<SubagentCheckpoint> {
  if (!directory) throw new Error("Task resume requires session storage");
  let checkpoint: unknown;
  try {
    checkpoint = JSON.parse(
      await readFile(join(directory, `subagent-${taskId(id)}.json`), "utf8"),
    );
  } catch {
    throw new Error("Unknown subagent resume ID");
  }
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    (checkpoint as SubagentCheckpoint).version !== 1 ||
    (checkpoint as SubagentCheckpoint).taskId !== id ||
    (checkpoint as SubagentCheckpoint).agentName !== name ||
    !Array.isArray((checkpoint as SubagentCheckpoint).history)
  )
    throw new Error(
      "Subagent resume ID belongs to a different agent or is invalid",
    );
  return checkpoint as SubagentCheckpoint;
}

export async function saveSubagentCheckpoint(
  directory: string | undefined,
  checkpoint: SubagentCheckpoint,
): Promise<void> {
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `subagent-${taskId(checkpoint.taskId)}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
  await rename(temporary, path);
}

export function subagentMemoryPath(
  cwd: string,
  name: string,
  scope: "user" | "project" | "local",
): string {
  const agent = safeName(name);
  const directory =
    scope === "user"
      ? join(homedir(), ".claude", "agent-memory", agent)
      : scope === "project"
        ? join(resolve(cwd), ".claude", "agent-memory", agent)
        : join(resolve(cwd), ".claude", "agent-memory.local", agent);
  return join(directory, "MEMORY.md");
}

async function checkedMemoryPath(
  cwd: string,
  name: string,
  scope: "user" | "project" | "local",
  create: boolean,
): Promise<string> {
  const unresolved = subagentMemoryPath(cwd, name, scope);
  const anchor = await realpath(scope === "user" ? homedir() : resolve(cwd));
  const relative = unresolved.slice(
    (scope === "user" ? homedir() : resolve(cwd)).length,
  );
  const components = relative.split(/[\\/]+/).filter(Boolean);
  let current = anchor;

  for (let index = 0; index < components.length; index += 1) {
    current = join(current, components[index]!);
    const isFile = index === components.length - 1;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new Error("Subagent memory path must not contain symlinks");
      if (isFile ? !info.isFile() : !info.isDirectory())
        throw new Error("Subagent memory path contains an invalid component");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) throw error;
      if (isFile) return current;
      await mkdir(current, { mode: 0o700 });
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Subagent memory path must not contain symlinks");
    }
  }
  return current;
}

export async function loadSubagentMemory(
  cwd: string,
  name: string,
  scope: "user" | "project" | "local" | undefined,
): Promise<string | undefined> {
  if (!scope) return undefined;
  try {
    const path = await checkedMemoryPath(cwd, name, scope, false);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveSubagentMemory(
  cwd: string,
  name: string,
  scope: "user" | "project" | "local" | undefined,
  content: string,
): Promise<void> {
  if (!scope) return;
  const path = await checkedMemoryPath(cwd, name, scope, true);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.isSymbolicLink())
      throw new Error("Subagent memory path must not contain symlinks");
    if (existing && !existing.isFile())
      throw new Error("Subagent memory path contains an invalid component");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export type SubagentWorktree = {
  path: string;
  branch: string;
  baseSha: string;
};

export async function createSubagentWorktree(
  cwd: string,
  name: string,
): Promise<SubagentWorktree> {
  const id = randomUUID();
  const root = join(await realpath(tmpdir()), "codex-action-subagents");
  const path = join(root, id);
  const branch = `codex-agent/${safeName(name)}-${id}`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  let baseSha = "";
  try {
    const revision = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd,
      timeout: 10_000,
    });
    baseSha = revision.stdout.trim();
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", branch, "--", path, "HEAD"],
      {
        cwd,
        timeout: 30_000,
      },
    );
  } catch {
    await rm(path, { recursive: true, force: true });
    throw new Error("Could not create isolated subagent worktree");
  }
  return { path, branch, baseSha };
}

export async function preserveChangedWorktree(
  cwd: string,
  worktree: SubagentWorktree,
): Promise<boolean> {
  let changed = true;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: worktree.path, timeout: 10_000 },
    );
    changed = stdout.trim().length > 0;
    if (!changed) {
      const { stdout: head } = await execFileAsync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: worktree.path, timeout: 10_000 },
      );
      changed = head.trim() !== worktree.baseSha;
    }
  } catch {
    return true;
  }
  if (changed) return true;
  try {
    await execFileAsync(
      "git",
      ["worktree", "remove", "--force", "--", worktree.path],
      {
        cwd,
        timeout: 30_000,
      },
    );
    await execFileAsync("git", ["branch", "-D", "--", worktree.branch], {
      cwd,
      timeout: 10_000,
    });
    return false;
  } catch {
    return true;
  }
}
