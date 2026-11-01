import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdtemp, realpath, rm, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  private git(args: string[], input?: string): string {
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
          input,
          stdio: ["pipe", "pipe", "pipe"],
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
    const changed = this.git([
      ...args,
      "--name-only",
      "--no-renames",
      "-z",
      "--",
      ...files,
    ])
      .split("\0")
      .filter(Boolean);
    return {
      ...this.output(this.git([...args, "--", ...files])),
      files: changed,
    };
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

  /** Delete a complete selection or restore its exact files and staging if deletion/commit fails. */
  async remove(files: string[], message: string) {
    if (this.options.readOnly) throw new Error("Git writes are disabled");
    if (!message.trim() || message.includes("\0"))
      throw new Error("A valid commit message is required");
    const paths = await this.paths(files);
    if (!paths.length) throw new Error("Select at least one file");
    const staged = this.git(["diff", "--cached", "--name-only", "-z"]).split(
      "\0",
    );
    if (paths.some((file) => staged.includes(file)))
      throw new Error("A selected file already has staged changes");
    await Promise.all(
      paths.map((file) => lstat(resolve(this.options.repoDir, file))),
    );
    this.git(["ls-files", "--error-unmatch", "--", ...paths]);
    const directory = await mkdtemp(
      join(
        this.git(["rev-parse", "--absolute-git-dir"]).trim(),
        "codex-delete-",
      ),
    );
    const removed: number[] = [];
    let retain = false;
    const copyOptions = {
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      force: false,
      errorOnExist: true,
    };
    try {
      for (const [index, file] of paths.entries())
        await cp(
          resolve(this.options.repoDir, file),
          join(directory, String(index)),
          copyOptions,
        );
      for (const [index, file] of paths.entries()) {
        await unlink(resolve(this.options.repoDir, file));
        removed.push(index);
      }
      return await this.commit(paths, message);
    } catch (error) {
      try {
        for (const index of removed)
          await cp(
            join(directory, String(index)),
            resolve(this.options.repoDir, paths[index]!),
            copyOptions,
          );
        this.git(["reset", "--quiet", "HEAD", "--", ...paths]);
      } catch {
        retain = true;
        throw new Error(
          `Deletion could not be restored completely; original files remain in ${directory}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (!retain)
        await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Reject new LFS pointer objects rather than publishing pointers without a trusted object upload. */
  private checkPushObjects(
    head: string,
    advertised: Map<string, string>,
  ): void {
    const namespace = `refs/codex-delivery/${randomUUID()}`;
    const refs = [...advertised.entries()].map(([name, sha], index) => ({
      name,
      sha,
      local: `${namespace}/${index}`,
    }));
    let objects: string[];
    try {
      if (refs.length)
        this.git([
          "fetch",
          "--no-tags",
          "origin",
          ...refs.map(({ name, local }) => `${name}:${local}`),
        ]);
      const tips = refs.map(({ local, sha }) => {
        const fetched = this.git(["rev-parse", local]).trim();
        if (fetched !== sha)
          throw new Error(
            "Remote ancestry changed during push preflight; retry with current refs",
          );
        return fetched;
      });
      objects = this.git([
        "rev-list",
        "--objects",
        head,
        ...(tips.length ? ["--not", ...tips] : []),
      ])
        .split("\n")
        .map((line) =>
          /^[a-f0-9]{40}(?: |$)/.test(line) ? line.slice(0, 40) : "",
        )
        .filter(Boolean);
    } finally {
      for (const { local } of refs) this.git(["update-ref", "-d", local]);
    }
    if (!objects.length) return;
    const metadata = this.git(
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      objects.join("\n") + "\n",
    );
    for (const line of metadata.trim().split("\n")) {
      const [sha, type, size] = line.split(" ");
      if (type !== "blob" || Number(size) > 1024) continue;
      const content = this.git(["cat-file", "blob", sha!]);
      if (
        /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(
          content,
        ) &&
        /^oid sha256:[a-f0-9]{64}\r?$/m.test(content) &&
        /^size \d+\r?$/m.test(content)
      )
        throw new Error(
          "Push blocked: new Git LFS objects require a trusted LFS upload; repository hooks remain disabled",
        );
    }
  }

  /** Push HEAD to the prepared branch, preserving punctuation as literal data. */
  push() {
    if (this.options.readOnly) throw new Error("Git writes are disabled");
    this.git(["check-ref-format", "--branch", this.options.branch]);
    const head_sha = this.git(["rev-parse", "HEAD"]).trim();
    const destination = `refs/heads/${this.options.branch}`;
    this.git(["check-ref-format", "--branch", this.options.baseBranch]);
    const advertised = new Map(
      this.git([
        "ls-remote",
        "origin",
        destination,
        `refs/heads/${this.options.baseBranch}`,
      ])
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, name] = line.split(/\s+/);
          return [name!, sha!] as const;
        }),
    );
    if (advertised.get(destination) === head_sha)
      return { head_sha, branch: this.options.branch, changed: false };
    this.checkPushObjects(head_sha, advertised);
    const pushed = this.git([
      "push",
      "--porcelain",
      "origin",
      `${head_sha}:${destination}`,
    ]);
    const changed = pushed
      .split("\n")
      .some(
        (line) =>
          /^[ *+]\t/.test(line) &&
          line.split("\t")[1]?.endsWith(`:${destination}`),
      );
    if (!changed)
      return { head_sha, branch: this.options.branch, changed: false };
    recordDelivery(head_sha, this.options.branch, this.options.receiptFile);
    return { head_sha, branch: this.options.branch, changed: true };
  }
}
