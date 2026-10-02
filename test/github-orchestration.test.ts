import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as core from "@actions/core";
import * as gitConfig from "../src/github/operations/git-config";
import { setupBranch } from "../src/github/operations/branch";
import { createPrompt, buildDisallowedToolsString } from "../src/create-prompt";
import { prepareAgentMode } from "../src/modes/agent";
import { prepareMcpConfig } from "../src/mcp/install-mcp-server";
import { createMockContext } from "./mockContext";

const githubData = {
  contextData: {
    title: "Fix the bug",
    body: "Fix it",
    state: "OPEN",
    author: { login: "maintainer" },
    labels: { nodes: [] },
  },
  comments: [],
  changedFiles: [],
  changedFilesWithSHA: [],
  reviewData: null,
  imageUrlMap: new Map(),
} as any;

const environmentKeys = [
  "RUNNER_TEMP",
  "ALLOWED_TOOLS",
  "DISALLOWED_TOOLS",
  "CODEX_ARGS",
  "CLAUDE_ARGS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
];

describe("GitHub preparation contracts", () => {
  let directory: string;
  let cwd: string;
  let saved: Record<string, string | undefined>;
  let log: ReturnType<typeof spyOn>;

  beforeEach(() => {
    cwd = process.cwd();
    directory = mkdtempSync(join(tmpdir(), "codex-orchestration-"));
    saved = Object.fromEntries(
      environmentKeys.map((key) => [key, process.env[key]]),
    );
    process.env.RUNNER_TEMP = directory;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    delete process.env.CODEX_ARGS;
    delete process.env.CLAUDE_ARGS;
    delete process.env.ALLOWED_TOOLS;
    delete process.env.DISALLOWED_TOOLS;
    log = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    process.chdir(cwd);
    for (const key of environmentKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(directory, { recursive: true, force: true });
  });

  for (const sshSigningKey of ["", "test-ssh-key"]) {
    test(`branch setup honors SSH precedence: ${Boolean(sshSigningKey)}`, async () => {
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      process.chdir(directory);
      git("init", "--bare", "origin.git");
      git("init", "--initial-branch=main", "checkout");
      process.chdir(join(directory, "checkout"));
      git("config", "user.name", "Test User");
      git("config", "user.email", "test@example.com");
      git("config", "commit.gpgsign", "false");
      writeFileSync("README.md", "base\n");
      git("add", "README.md");
      git("commit", "-m", "Initial test commit");
      git("remote", "add", "origin", join(directory, "origin.git"));
      git("push", "--set-upstream", "origin", "main");
      const sha = git("rev-parse", "HEAD");
      const octokit = {
        rest: {
          repos: { get: async () => ({ data: { default_branch: "main" } }) },
          git: { getRef: async () => ({ data: { object: { sha } } }) },
        },
      } as any;
      const result = await setupBranch(
        octokit,
        githubData,
        createMockContext({
          inputs: {
            useCommitSigning: true,
            sshSigningKey,
            branchPrefix: "codex/",
            branchNameTemplate: "{{prefix}}fix-42",
          },
        }),
      );
      expect(result.claudeBranch).toBe("codex/fix-42");
      expect(git("branch", "--show-current")).toBe(
        sshSigningKey ? "codex/fix-42" : "main",
      );
      expect(result.currentBranch).toBe(
        sshSigningKey ? "codex/fix-42" : "main",
      );
    });
  }

  test("prompt generation preserves explicit tool policy and uses SSH git instructions", async () => {
    process.env.ALLOWED_TOOLS = "Read,mcp__github_inline_comment__*";
    process.env.DISALLOWED_TOOLS = "Bash(git push:*)";
    const exported = spyOn(core, "exportVariable");
    try {
      await createPrompt(
        42,
        "main",
        "codex/fix",
        githubData,
        createMockContext({
          eventName: "issues",
          eventAction: "opened",
          entityNumber: 7,
          payload: {
            issue: {
              body: "/codex fix it",
              title: "Fix the bug",
              user: { login: "maintainer", id: 1 },
            },
          } as any,
          inputs: { useCommitSigning: true, sshSigningKey: "test-key" },
        }),
      );
      const prompt = readFileSync(
        join(directory, "codex-prompts/codex-prompt.txt"),
        "utf8",
      );
      expect(prompt).toContain("git add");
      expect(prompt).not.toContain("mcp__github_file_ops__commit_files");
      expect(process.env.ALLOWED_TOOLS).toBe(
        "Read,mcp__github_inline_comment__*",
      );
      expect(process.env.DISALLOWED_TOOLS).toBe("Bash(git push:*)");
      expect(exported).not.toHaveBeenCalled();
    } finally {
      exported.mockRestore();
    }
  });

  test("direct allowed_tools installs the requested agent MCP server", async () => {
    process.env.ALLOWED_TOOLS =
      "mcp__github_inline_comment__create_inline_comment";
    const auth = spyOn(gitConfig, "configureGitAuth").mockResolvedValue();
    try {
      const result = await prepareAgentMode({
        context: createMockContext({
          isPR: true,
          inputs: { prompt: "Review this" },
        }),
        octokit: {
          rest: {
            users: { getByUsername: async () => ({ data: { type: "User" } }) },
          },
        } as any,
        githubToken: "fake-test-token",
      });
      const config = JSON.parse(result.mcpConfig);
      expect(config.mcpServers.github_inline_comment).toBeDefined();
      expect(config.mcpServers.github_inline_comment.command).toBe(
        process.execPath,
      );
    } finally {
      auth.mockRestore();
    }
  });

  test("SSH signing does not install the API commit server", async () => {
    const result = await prepareMcpConfig({
      githubToken: "fake-test-token",
      owner: "owner",
      repo: "repo",
      branch: "codex/fix",
      baseBranch: "main",
      allowedTools: [],
      mode: "agent",
      context: createMockContext({
        inputs: { useCommitSigning: true, sshSigningKey: "test-key" },
      }),
    });
    expect(JSON.parse(result).mcpServers.github_file_ops).toBeUndefined();
  });
  test("preparation failures reject so the caller can finish token cleanup", async () => {
    const exit = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("unexpected process exit");
    });
    try {
      await expect(
        createPrompt(42, "main", "codex/fix", githubData, createMockContext()),
      ).rejects.toThrow("Create prompt failed");
      await expect(
        prepareMcpConfig({
          githubToken: "fake-test-token",
          owner: "owner",
          repo: "repo",
          branch: "branch",
          baseBranch: "main",
          allowedTools: [],
          mode: "agent",
          context: {} as any,
        }),
      ).rejects.toThrow("Install MCP server failed");
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
    }
  });

  test("scoped web grants remove defaults while explicit user denials remain", () => {
    expect(
      buildDisallowedToolsString([], ["WebFetch(domain:docs.example.com)"]),
    ).toBe("WebSearch");
    expect(
      buildDisallowedToolsString(
        ["WebFetch"],
        ["WebFetch(domain:docs.example.com)"],
      ),
    ).toBe("WebSearch,WebFetch");
  });
});
