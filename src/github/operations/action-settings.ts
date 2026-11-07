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
  raw = process.env.INPUT_SETTINGS ?? "",
): Promise<string> {
  if (!isEntityContext(context) || !isSettingsFile(raw)) return raw;

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
      if (!context.isPR) return (await readFile(file, "utf8")) + "\n";
      // External aliases can traverse a PR symlink and change which file is read.
      if ((await realpath(file)) !== file)
        throw new Error(
          "Settings outside the PR workspace require a direct file path",
        );
      return (await readFile(file, "utf8")) + "\n";
    }
  }

  const { owner, repo } = context.repository;
  const ref = !context.isPR
    ? context.inputs.baseBranch || context.repository.default_branch || "main"
    : "pull_request" in context.payload
      ? context.payload.pull_request.base.sha
      : (
          await retryGitHubRead(() =>
            client.pulls.get({
              owner,
              repo,
              pull_number: context.entityNumber,
            }),
          )
        ).data.base.sha;
  if (!context.isPR) validateBranchName(ref);
  if ((context.isPR && !/^[a-f0-9]{40}$/i.test(ref)) || !path)
    throw new Error("Cannot resolve settings from the trusted task base");

  const { data } = await retryGitHubRead(() =>
    client.repos.getContent({ owner, repo, path, ref }),
  );
  if (Array.isArray(data) || data.type !== "file" || data.encoding !== "base64")
    throw new Error("PR settings must be a readable file on the trusted base");

  // A newline distinguishes even empty or comment-only TOML from a file path.
  return Buffer.from(data.content, "base64").toString("utf8") + "\n";
}
