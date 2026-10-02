import { afterEach, describe, expect, test } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentInputItem } from "@openai/agents";
import {
  createSubagentWorktree,
  loadSubagentCheckpoint,
  loadSubagentMemory,
  preserveChangedWorktree,
  saveSubagentCheckpoint,
  saveSubagentMemory,
  subagentMemoryPath,
} from "../src/agent-subagent-state";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const worktrees: Array<{ root: string; path: string; branch: string }> = [];
const id = "da6c7f40-7d32-4cc2-87c0-f3a45409dd14";
afterEach(async () => {
  for (const worktree of worktrees.splice(0)) {
    try {
      await execFile(
        "git",
        ["worktree", "remove", "--force", "--", worktree.path],
        { cwd: worktree.root },
      );
      await execFile("git", ["branch", "-D", "--", worktree.branch], {
        cwd: worktree.root,
      });
    } catch {
      // Clean worktrees are already removed by the behavior under test.
    }
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function git(cwd: string, ...args: string[]) {
  return execFile("git", args, { cwd });
}

describe("persistent subagent state", () => {
  test("stores resumable transcript with identity checks and private file permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-state-"));
    roots.push(root);
    const history: AgentInputItem[] = [{ role: "user", content: "inspect" }];
    await saveSubagentCheckpoint(root, {
      version: 1,
      taskId: id,
      agentName: "reviewer",
      history,
    });
    const saved = await loadSubagentCheckpoint(root, id, "reviewer");
    expect(saved.history).toEqual(history);
    await expect(
      loadSubagentCheckpoint(root, id, "different-agent"),
    ).rejects.toThrow("different agent");
    const info = await Bun.file(join(root, `subagent-${id}.json`)).stat();
    expect(info.mode & 0o077).toBe(0);
  });

  test("keeps memory in the requested project or local directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-memory-"));
    roots.push(root);
    const projectFile = subagentMemoryPath(root, "reviewer", "project");
    const localFile = subagentMemoryPath(root, "reviewer", "local");
    expect(projectFile).toContain(".claude/agent-memory/reviewer/MEMORY.md");
    expect(localFile).toContain(
      ".claude/agent-memory.local/reviewer/MEMORY.md",
    );
    await saveSubagentMemory(root, "reviewer", "local", "Keep tests offline.");
    await saveSubagentMemory(root, "reviewer", "local", "Updated memory.");
    expect(await loadSubagentMemory(root, "reviewer", "local")).toBe(
      "Updated memory.",
    );
    expect((await Bun.file(localFile).stat()).mode & 0o077).toBe(0);
    expect(
      await loadSubagentMemory(root, "reviewer", "project"),
    ).toBeUndefined();
  });

  test("rejects traversal identities and symlinked memory paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-memory-safe-"));
    const outside = await mkdtemp(join(tmpdir(), "subagent-memory-outside-"));
    roots.push(root, outside);

    expect(() => subagentMemoryPath(root, "..", "project")).toThrow(
      "unsupported characters",
    );
    expect(() => subagentMemoryPath(root, ".", "project")).toThrow(
      "unsupported characters",
    );

    const outsideMemory = join(outside, "MEMORY.md");
    await writeFile(outsideMemory, "outside fixture\n", { mode: 0o600 });

    const agentDirectory = join(root, ".claude", "agent-memory", "reviewer");
    await mkdir(join(root, ".claude", "agent-memory"), { recursive: true });
    await symlink(outside, agentDirectory, "dir");
    await expect(
      loadSubagentMemory(root, "reviewer", "project"),
    ).rejects.toThrow("symlinks");
    await expect(
      saveSubagentMemory(root, "reviewer", "project", "must not escape"),
    ).rejects.toThrow("symlinks");
    expect(await readFile(outsideMemory, "utf8")).toBe("outside fixture\n");

    const localDirectory = join(
      root,
      ".claude",
      "agent-memory.local",
      "reviewer",
    );
    await mkdir(localDirectory, { recursive: true });
    const linkedMemory = join(localDirectory, "MEMORY.md");
    await rm(linkedMemory, { force: true });
    await symlink(outsideMemory, linkedMemory, "file");
    await expect(loadSubagentMemory(root, "reviewer", "local")).rejects.toThrow(
      "symlinks",
    );
    await expect(
      saveSubagentMemory(root, "reviewer", "local", "must not replace link"),
    ).rejects.toThrow("symlinks");
    expect(await readFile(outsideMemory, "utf8")).toBe("outside fixture\n");
  });

  test("creates a real isolated worktree, removes a clean one, and preserves changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-worktree-repo-"));
    roots.push(root);
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.email", "codex@example.invalid");
    await git(root, "config", "user.name", "Codex Test");
    await writeFile(join(root, "README.md"), "fixture\n");
    await git(root, "add", "README.md");
    await git(root, "commit", "-m", "fixture");

    const clean = await createSubagentWorktree(root, "reviewer");
    worktrees.push({ root, ...clean });
    expect(await readFile(join(clean.path, "README.md"), "utf8")).toBe(
      "fixture\n",
    );
    expect(await preserveChangedWorktree(root, clean)).toBe(false);
    await expect(readFile(clean.path)).rejects.toThrow();

    const changed = await createSubagentWorktree(root, "reviewer");
    worktrees.push({ root, ...changed });
    await writeFile(join(changed.path, "result.txt"), "review result\n");
    expect(await preserveChangedWorktree(root, changed)).toBe(true);
    expect(await readFile(join(changed.path, "result.txt"), "utf8")).toBe(
      "review result\n",
    );
    expect(
      (await git(changed.path, "branch", "--show-current")).stdout.trim(),
    ).toBe(changed.branch);

    const committed = await createSubagentWorktree(root, "reviewer");
    worktrees.push({ root, ...committed });
    await writeFile(join(committed.path, "committed.txt"), "saved branch\n");
    await git(committed.path, "add", "committed.txt");
    await git(committed.path, "commit", "-m", "agent result");
    expect(await preserveChangedWorktree(root, committed)).toBe(true);
    expect(
      (await git(committed.path, "rev-parse", "HEAD")).stdout.trim(),
    ).not.toBe(committed.baseSha);
  });
});
