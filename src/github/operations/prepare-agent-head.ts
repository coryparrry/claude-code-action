import { execFileSync } from "node:child_process";
import { isPullRequestEvent, type GitHubContext } from "../context";

/** Replace GitHub's clean synthetic merge checkout with the actual PR head before agent writes. */
export function prepareAgentPrHead(
  context: GitHubContext,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): void {
  if (
    !isPullRequestEvent(context) ||
    env.CODEX_BRANCH ||
    !/^refs\/pull\/\d+\/merge$/.test(env.GITHUB_REF || "")
  )
    return;
  const head = context.payload.pull_request.head.sha;
  if (!/^[a-f0-9]{40}$/.test(head))
    throw new Error("PR checkout requires a valid head SHA");
  /** Inspect and prepare the checkout without invoking repository hooks. */
  const git = (args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  if (git(["rev-parse", "HEAD"]) === head) return;
  if (git(["status", "--porcelain", "--untracked-files=all"]))
    throw new Error(
      "Cannot prepare PR head over existing work; check out the PR head before invoking the action",
    );
  try {
    git(["cat-file", "-e", `${head}^{commit}`]);
  } catch {
    git(["fetch", "--no-tags", "--depth=1", "origin", head]);
  }
  git(["checkout", "--no-overwrite-ignore", "--detach", head]);
}
