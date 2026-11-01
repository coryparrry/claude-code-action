import { execFileSync } from "node:child_process";
import { lstat, realpath, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { validatePathWithinRepo } from "../../mcp/path-validation";
import { recordDelivery } from "./delivery";
import { redactSecrets } from "../utils/sanitizer";

export type TaskGitOptions = {
  repoDir: string;
  branch: string;
  baseBranch: string;
  readOnly?: boolean;
  receiptFile?: string;
};

/** Execute fixed Git operations without exposing arbitrary shell arguments or paths. */
export class TaskGit {
  /** Capture the repository, branch and write boundary prepared by the action. */
  constructor(private readonly options: TaskGitOptions) {}

  /** Run Git with repository hooks and external diff programs disabled. */
  private git(args: string[]): string {
    try {
      return execFileSync(
        "git",
        [
          "--literal-pathspecs",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ],
        {
          cwd: this.options.repoDir,
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      const result = error as {
        stderr?: string | Buffer;
        stdout?: string | Buffer;
      };
      throw new Error(
        redactSecrets(
          String(result.stderr || result.stdout || "Git operation failed"),
        ),
      );
    }
  }

  /** Validate explicit file selections, including physical paths and Git metadata. */
  private async paths(
    files: string[],
    allowDirectories = false,
  ): Promise<string[]> {
    const root = await realpath(this.options.repoDir);
    const result: string[] = [];
    const gitDirectory = this.git(["rev-parse", "--absolute-git-dir"]).trim();
    for (const file of files) {
      if (!file || isAbsolute(file) || file.split(/[\\/]/).includes(".."))
        throw new Error("Git paths must be explicit repository-relative paths");
      const lexical = resolve(root, file);
      const local = relative(root, lexical);
      if (!local || local === ".git" || local.startsWith(`.git${sep}`))
        throw new Error(
          "Git metadata and repository-wide file selections are unavailable",
        );
      const physical = await validatePathWithinRepo(file, root);
      if (
        physical === gitDirectory ||
        physical.startsWith(`${gitDirectory}${sep}`)
      )
        throw new Error("Git metadata is unavailable");
      const info = await lstat(lexical).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (!allowDirectories && info?.isDirectory())
        throw new Error("Select individual files, not directories");
      result.push(local.split(sep).join("/"));
    }
    return [...new Set(result)];
  }

  /** Bound and redact Git output before it enters model context. */
  private output(text: string) {
    const bytes = Buffer.from(redactSecrets(text));
    return {
      text: bytes.subarray(0, 48_000).toString("utf8"),
      truncated: bytes.length > 48_000,
    };
  }

  /** Report branch and working-tree state without invoking fsmonitor hooks. */
  status() {
    return this.output(
      this.git(["status", "--short", "--branch", "--untracked-files=all"]),
    );
  }

  /** Compare repository files only; callers cannot enable no-index, textconv or external diff. */
  async diff(
    options: { staged?: boolean; base?: boolean; paths?: string[] } = {},
  ) {
    const files = await this.paths(options.paths ?? [], true);
    const args = ["diff", "--no-ext-diff", "--no-textconv"];
    if (options.staged) args.push("--cached");
    if (options.base) {
      if (options.staged)
        throw new Error("Choose either staged or PR-base comparison");
      args.push(`origin/${this.options.baseBranch}...HEAD`);
    }
    return this.output(this.git([...args, "--", ...files]));
  }

  /** Commit only selected files, treating the complete message as literal argv data. */
  async commit(files: string[], message: string) {
    if (this.options.readOnly) throw new Error("Git writes are disabled");
    if (!message.trim() || message.includes("\0"))
      throw new Error("A valid commit message is required");
    const paths = await this.paths(files);
    if (!paths.length) throw new Error("Select at least one file");
    const staged = this.git(["diff", "--cached", "--name-only", "-z"]).split(
      "\0",
    );
    if (paths.some((file) => staged.includes(file)))
      throw new Error(
        "A selected file already has staged changes; preserve that staging before committing",
      );
    this.git(["add", "-A", "--", ...paths]);
    this.git(["commit", "--only", "--message", message, "--", ...paths]);
    return { head_sha: this.git(["rev-parse", "HEAD"]).trim(), files: paths };
  }

  /** Delete selected files without shell expansion, then commit only those deletions. */
  async remove(files: string[], message: string) {
    if (this.options.readOnly) throw new Error("Git writes are disabled");
    if (!message.trim() || message.includes("\0"))
      throw new Error("A valid commit message is required");
    const paths = await this.paths(files);
    const staged = this.git(["diff", "--cached", "--name-only", "-z"]).split(
      "\0",
    );
    if (paths.some((file) => staged.includes(file)))
      throw new Error("A selected file already has staged changes");
    for (const file of paths) await unlink(resolve(this.options.repoDir, file));
    return this.commit(paths, message);
  }

  /** Push HEAD to the prepared branch, preserving punctuation as literal data. */
  push() {
    if (this.options.readOnly) throw new Error("Git writes are disabled");
    this.git(["check-ref-format", "--branch", this.options.branch]);
    const head_sha = this.git(["rev-parse", "HEAD"]).trim();
    this.git([
      "push",
      "origin",
      `${head_sha}:refs/heads/${this.options.branch}`,
    ]);
    recordDelivery(head_sha, this.options.branch, this.options.receiptFile);
    return { head_sha, branch: this.options.branch };
  }
}
