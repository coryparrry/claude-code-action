import { spawnSync } from "node:child_process";
import { WORKFLOW_PATH } from "./workflow.mjs";

function runGh(args, { input, inherit = false } = {}) {
  const result = spawnSync("gh", args, {
    input,
    encoding: "utf8",
    env: { ...process.env, GH_HOST: "github.com" },
    stdio: inherit ? "inherit" : "pipe",
    timeout: inherit ? undefined : 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT")
    throw new Error("Install GitHub CLI (gh) before running this installer.");
  return result;
}

export class GitHubClient {
  constructor({ run = runGh } = {}) {
    this.run = run;
  }

  async execute(args, options = {}) {
    let result;
    try {
      result = await this.run(args, options);
    } catch {
      throw new Error(
        "Unable to start GitHub CLI. Check that gh is installed.",
      );
    }
    if (result.status !== 0) {
      // gh may include response bodies or input in diagnostics. Never echo them.
      const error = new Error(
        "GitHub request failed. Check your login, repository access and network connection.",
      );
      error.notFound = /HTTP 404|Not Found/i.test(result.stderr ?? "");
      throw error;
    }
    return result.stdout ?? "";
  }

  async json(args, options) {
    const output = await this.execute(args, options);
    try {
      return JSON.parse(output);
    } catch {
      throw new Error("GitHub CLI returned an invalid response.");
    }
  }

  api(endpoint, method = "GET", payload) {
    const args = ["api", endpoint, "--method", method];
    if (payload !== undefined) args.push("--input", "-");
    return this.json(args, {
      input: payload === undefined ? undefined : JSON.stringify(payload),
    });
  }

  async authenticated() {
    try {
      await this.execute(["auth", "status", "--hostname", "github.com"]);
      return true;
    } catch {
      return false;
    }
  }

  login() {
    return this.execute(
      [
        "auth",
        "login",
        "--web",
        "--git-protocol",
        "https",
        "--hostname",
        "github.com",
        "--scopes",
        "repo,workflow",
      ],
      { inherit: true },
    );
  }

  user() {
    return this.api("user");
  }

  repositories(login) {
    return this.json([
      "repo",
      "list",
      login,
      "--limit",
      "100",
      "--json",
      "nameWithOwner,isArchived,viewerPermission",
    ]);
  }

  repository(repository) {
    return this.json([
      "repo",
      "view",
      repository,
      "--json",
      "nameWithOwner,defaultBranchRef,viewerPermission,isArchived,url",
    ]);
  }

  secrets(repository) {
    return this.json([
      "secret",
      "list",
      "--repo",
      repository,
      "--json",
      "name",
    ]);
  }

  async workflow(repository, ref) {
    let response;
    try {
      response = await this.api(
        `repos/${repository}/contents/${WORKFLOW_PATH}?ref=${encodeURIComponent(ref)}`,
      );
    } catch (error) {
      if (error.notFound) return null;
      throw error;
    }
    if (response.type !== "file" || response.encoding !== "base64")
      throw new Error("The workflow path is not a readable file.");
    return {
      sha: response.sha,
      content: Buffer.from(response.content, "base64").toString("utf8"),
    };
  }

  pullRequests(repository, base) {
    return this.json([
      "pr",
      "list",
      "--repo",
      repository,
      "--base",
      base,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "url,headRefName,isCrossRepository",
    ]);
  }

  compare(repository, base, head) {
    return this.api(
      `repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
  }

  async head(repository, branch) {
    const response = await this.api(
      `repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    return response.object.sha;
  }

  async setSecret(repository, apiKey) {
    await this.execute(
      ["secret", "set", "OPENAI_API_KEY", "--repo", repository],
      {
        input: `${apiKey}\n`,
      },
    );
  }

  createBranch(repository, branch, sha) {
    return this.api(`repos/${repository}/git/refs`, "POST", {
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  writeWorkflow(repository, branch, content, sha) {
    return this.api(`repos/${repository}/contents/${WORKFLOW_PATH}`, "PUT", {
      message: "chore(ci): install Codex GitHub Action",
      content: Buffer.from(content).toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    });
  }

  async createPullRequest(repository, branch, base) {
    const response = await this.api(`repos/${repository}/pulls`, "POST", {
      title: "chore(ci): install Codex GitHub Action",
      head: branch,
      base,
      draft: true,
      body: "## Summary\nAutomatically review trusted users' same-repository, non-draft pull requests when opened, updated, reopened or marked ready. Use `/codex` in issue titles/bodies, comments or reviews to ask questions and request implementations. Both jobs show progress and use the selected OpenAI model.\n\n| Mechanism | What changes |\n|---|---|\n| Automatic reviews | Post feedback with read-only code access; newer runs cancel older reviews for the same PR. |\n| Requested tasks | Answer questions or implement changes with write access when a trusted user asks. |\n\n## Design decisions\n- **Trusted events.** Both jobs are restricted to the selected GitHub users; automatic reviews exclude drafts and fork PRs.\n- **Action revision.** The workflow pins the reviewed action commit.\n\n## Setup\nThe installer configures `OPENAI_API_KEY` or reuses the existing secret. Merge onto the default branch to enable automatic reviews, then try `/codex Summarise this issue. Do not change any files.` Automatic reviews call the selected model on qualifying PR events.\n\n## Verification\nGenerated by the guided installer. Check actual event delivery and task execution in this repository after merging.",
    });
    return response.html_url;
  }
}
