import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import type { Octokit } from "@octokit/rest";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isSettingsFile } from "../../../base-action/src/codex-compat";
import { validateBranchName } from "./branch";
import { retryGitHubRead } from "../api/retry";
import { isEntityContext, type GitHubContext } from "../context";

/** Freeze repository settings from the selected task base before deriving grants. */
export async function resolveActionSettings(
  context: GitHubContext,
  client: Octokit,
  mode: "tag" | "agent",
  raw = process.env.INPUT_SETTINGS ?? "",
): Promise<{ settings: string; trustedBaseSha?: string }> {
  if (!isEntityContext(context) || !isSettingsFile(raw))
    return { settings: raw };
  // Prompt-driven issue automations execute the caller checkout without setupBranch.
  if (!context.isPR && mode === "agent") return { settings: raw };

  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  /** Map a workspace file to a repository path without reading the PR copy. */
  const repositoryPath = (root: string, file: string) => {
    const path = relative(root, file);
    return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
      ? undefined
      : path.split(sep).join("/");
  };
  const file = resolve(raw);
  let path = repositoryPath(workspace, file);
  if (path === undefined) {
    const physicalWorkspace = await realpath(workspace);
    path = repositoryPath(physicalWorkspace, file);
    if (path === undefined) {
      if (!context.isPR)
        return { settings: (await readFile(file, "utf8")) + "\n" };
      // External aliases can traverse a PR symlink and change which file is read.
      if ((await realpath(file)) !== file)
        throw new Error(
          "Settings outside the PR workspace require a direct file path",
        );
      return { settings: (await readFile(file, "utf8")) + "\n" };
    }
  }

  if (!context.isPR && existsSync(file)) {
    // Trusted preceding steps may generate or override settings in the checkout.
    const { stdout } = await promisify(execFile)(
      "git",
      [
        "status",
        "--porcelain",
        "--ignored",
        "--untracked-files=all",
        "--",
        path,
      ],
      { cwd: workspace },
    );
    if (stdout.trim())
      return { settings: (await readFile(file, "utf8")) + "\n" };
  }

  const { owner, repo } = context.repository;
  const ref = !context.isPR
    ? context.inputs.baseBranch || context.repository.default_branch || "main"
    : (
        await retryGitHubRead(() =>
          client.pulls.get({ owner, repo, pull_number: context.entityNumber }),
        )
      ).data.base.sha;
  if (!context.isPR) validateBranchName(ref);
  if ((context.isPR && !/^[a-f0-9]{40}$/i.test(ref)) || !path)
    throw new Error("Cannot resolve settings from the trusted task base");

  const settings = await readTrustedSettings(
    client,
    owner,
    repo,
    path,
    ref,
    workspace,
  );
  return {
    settings: settings + "\n",
    trustedBaseSha: context.isPR ? ref : undefined,
  };
}

/** Read a base file or a regular blob within its trusted, checked-out submodule gitlink. */
async function readTrustedSettings(
  client: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  workspace: string,
): Promise<string> {
  try {
    const { data } = await retryGitHubRead(() =>
      client.repos.getContent({ owner, repo, path, ref }),
    );
    if (
      Array.isArray(data) ||
      data.type !== "file" ||
      data.encoding !== "base64"
    )
      throw new Error("Settings must be a readable file on the trusted base");
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "status" in error &&
        error.status === 404
      )
    )
      throw error;
    const parts = path.split("/");
    for (let split = parts.length - 1; split > 0; split--) {
      const modulePath = parts.slice(0, split).join("/");
      let data;
      try {
        data = (
          await retryGitHubRead(() =>
            client.repos.getContent({ owner, repo, path: modulePath, ref }),
          )
        ).data;
      } catch (ancestorError) {
        if (
          ancestorError &&
          typeof ancestorError === "object" &&
          "status" in ancestorError &&
          ancestorError.status === 404
        )
          continue;
        throw ancestorError;
      }
      if (
        Array.isArray(data) ||
        !("submodule_git_url" in data) ||
        !/^[a-f0-9]{40}$/i.test(data.sha)
      )
        continue;
      try {
        return await readSubmoduleSettings(
          resolve(workspace, modulePath),
          data.sha,
          parts.slice(split).join("/"),
        );
      } catch {
        throw new Error(
          "Settings submodule must contain a regular file at its trusted base revision",
        );
      }
    }
    throw error;
  }
}

/** Follow only committed gitlinks and regular blobs, never checkout files or symlinks. */
async function readSubmoduleSettings(
  directory: string,
  revision: string,
  path: string,
): Promise<string> {
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)(
        "git",
        ["--no-replace-objects", "-C", directory, ...args],
        { maxBuffer: 10 * 1024 * 1024 },
      )
    ).stdout;
  const entry = await git("ls-tree", "-z", revision, "--", path);
  const blob = /^(?:100644|100755) blob ([a-f0-9]{40})\t/.exec(entry)?.[1];
  if (blob) return git("cat-file", "blob", blob);
  const parts = path.split("/");
  for (let split = 1; split < parts.length; split++) {
    const modulePath = parts.slice(0, split).join("/");
    const gitlink = /^160000 commit ([a-f0-9]{40})\t/.exec(
      await git("ls-tree", "-z", revision, "--", modulePath),
    )?.[1];
    if (gitlink)
      return readSubmoduleSettings(
        resolve(directory, modulePath),
        gitlink,
        parts.slice(split).join("/"),
      );
  }
  throw new Error("Settings must be a regular trusted submodule file");
}
