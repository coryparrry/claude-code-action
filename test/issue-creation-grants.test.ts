import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCompatibility } from "../base-action/src/codex-compat";
import {
  childMcpConfig,
  selectConfiguredAgent,
} from "../base-action/src/codex-agent-selection";
import { AgentPermissions } from "../base-action/src/agent-permissions";
import { resolveActionSettings } from "../src/github/operations/action-settings";
import { prepareTagMode } from "../src/modes/tag";
import * as mcp from "../src/mcp/install-mcp-server";
import * as actor from "../src/github/validation/actor";
import * as createInitial from "../src/github/operations/comments/create-initial";
import * as fetcher from "../src/github/data/fetcher";
import * as branch from "../src/github/operations/branch";
import * as prompt from "../src/create-prompt";
import * as gitConfig from "../src/github/operations/git-config";
import { createMockAutomationContext, createMockContext } from "./mockContext";

const issueTool = "mcp__github_issues__create_issue";
const environment = { ...process.env };
const directories: string[] = [];
type GrantSource = "args" | "direct" | "settings" | "file";

beforeEach(() => {
  for (const key of [
    "CODEX_ARGS",
    "CLAUDE_ARGS",
    "ALLOWED_TOOLS",
    "INPUT_SETTINGS",
    "PERMISSION_MODE",
    "CODEX_SANDBOX",
    "DEFAULT_WORKFLOW_TOKEN",
  ])
    delete process.env[key];
  process.env.GITHUB_ACTION_PATH = "/trusted/action";
});

afterEach(async () => {
  process.env = { ...environment };
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

/** Supply one grant through the same explicit input sources used by the runtime. */
async function configureGrant(
  source: GrantSource,
  rule: string,
): Promise<void> {
  if (source === "args") {
    process.env.CODEX_ARGS = `--allowedTools '${rule}'`;
  } else if (source === "direct") {
    process.env.ALLOWED_TOOLS = rule;
  } else {
    const settings = JSON.stringify({ permissions: { allow: [rule] } });
    if (source === "settings") process.env.INPUT_SETTINGS = settings;
    else {
      const directory = await mkdtemp(join(tmpdir(), "issue-grants-"));
      directories.push(directory);
      const file = join(directory, "settings.json");
      await writeFile(file, settings);
      process.env.INPUT_SETTINGS = file;
    }
  }
}

/** Use an author-owned, newly created command comment for implicit tag grants. */
function interactiveContext() {
  return createMockContext({
    eventAction: "created",
    actor: "request-author",
    payload: {
      action: "created",
      comment: {
        id: 42,
        body: "/codex Open an issue about the regression",
        user: { login: "request-author", type: "User" },
        created_at: "2026-11-02T00:00:00Z",
      },
    } as any,
  });
}

/** Exercise actual tag grant construction while isolating unrelated GitHub and Git work. */
async function prepareTagFixture(
  context = interactiveContext(),
  octokit = {} as any,
) {
  const spies = [
    spyOn(actor, "checkHumanActor").mockResolvedValue(undefined),
    spyOn(createInitial, "createInitialComment").mockResolvedValue({
      id: 42,
    } as any),
    spyOn(fetcher, "fetchGitHubData").mockImplementation(
      async () => ({}) as any,
    ),
    spyOn(branch, "setupBranch").mockResolvedValue({
      baseBranch: "main",
      claudeBranch: "codex/fixture",
      currentBranch: "codex/fixture",
    } as any),
    spyOn(prompt, "createPrompt").mockResolvedValue(undefined),
    spyOn(mcp, "prepareMcpConfig").mockResolvedValue('{"mcpServers":{}}'),
    spyOn(gitConfig, "configureGitAuth").mockResolvedValue(undefined),
  ];
  try {
    return await prepareTagMode({
      context,
      octokit,
      githubToken: "fixture-token",
    });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** Install actual MCP configuration for an automation with no implicit creation grant. */
async function prepareAgentConfiguration() {
  return JSON.parse(
    await mcp.prepareMcpConfig({
      githubToken: "fixture-token",
      owner: "owner",
      repo: "repo",
      branch: "fixture",
      baseBranch: "main",
      allowedTools: [],
      mode: "agent",
      context: createMockAutomationContext({
        inputs: { prompt: "Open the requested issue" },
      }),
    }),
  );
}

test.each(["args", "direct", "settings", "file"] as const)(
  "tag mode preserves scoped exact and wildcard issue grants from %s",
  async (source) => {
    for (const rule of [
      `${issueTool}(/restricted)`,
      "mcp__github_issues__*(/restricted)",
    ]) {
      await configureGrant(source, rule);
      const prepared = await prepareTagFixture();
      const permission = await resolveCompatibility(
        prepared.claudeArgs,
        process.env.INPUT_SETTINGS || "",
        prepared.mcpConfig,
        [],
        { allowedTools: process.env.ALLOWED_TOOLS || undefined },
      );
      expect(permission.allowedTools).toContain(rule);
      expect(permission.allowedTools).not.toContain(issueTool);
      const policy = new AgentPermissions({
        cwd: tmpdir(),
        allowedTools: permission.allowedTools,
        permissionMode: permission.permissionMode,
      });
      expect(() => policy.assertTool(issueTool)).toThrow("without approval");
    }
  },
);

test("interactive tag commands retain an unscoped default when no matching grant exists", async () => {
  const prepared = await prepareTagFixture();
  const permission = await resolveCompatibility(
    prepared.claudeArgs,
    "",
    prepared.mcpConfig,
  );
  expect(permission.allowedTools).toContain(issueTool);
  const policy = new AgentPermissions({
    cwd: tmpdir(),
    allowedTools: permission.allowedTools,
    permissionMode: permission.permissionMode,
  });
  expect(() => policy.assertTool(issueTool)).not.toThrow();
});

test.each(["settings", "file"] as const)(
  "settings-only %s grants install the agent-mode issue server",
  async (source) => {
    await configureGrant(source, issueTool);
    expect(
      (await prepareAgentConfiguration()).mcpServers.github_issues,
    ).toBeDefined();
  },
);

test("the trusted selected agent's grant installs the scoped issue server", async () => {
  process.env.CODEX_ARGS = `--agent publisher --agents '${JSON.stringify({ publisher: { prompt: "Open the requested issue", tools: [issueTool] } })}'`;
  expect(
    (await prepareAgentConfiguration()).mcpServers.github_issues,
  ).toBeDefined();
});

test("an inline agent uses its trusted definition when a project agent shares its name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "issue-agent-precedence-"));
  directories.push(directory);
  const project = join(directory, "project");
  await mkdir(project);
  await writeFile(
    join(project, "publisher.md"),
    "---\ntools: Read\n---\nProject instructions.",
  );
  const selected = await selectConfiguredAgent(
    {
      agentDirectories: [{ directory: project }],
      plugins: [],
      hooks: {},
    } as any,
    "publisher",
    {
      publisher: {
        name: "other",
        prompt: "Trusted instructions.",
        tools: [issueTool],
      },
    },
    directory,
  );
  expect(selected?.instructions).toContain("Trusted instructions.");
  expect(selected?.tools).toEqual([issueTool]);
});

test.each(["github_issues", "github:issues"])(
  "workflow and child configuration cannot replace the reserved issue server via %s",
  async (alias) => {
    const config = { [alias]: { command: "false" } };
    process.env.CODEX_ARGS = `--mcp-config '${JSON.stringify({ mcpServers: config })}'`;
    await expect(prepareAgentConfiguration()).rejects.toThrow(
      "github_issues is reserved",
    );
    expect(() => childMcpConfig('{"mcpServers":{}}', [config])).toThrow(
      "github_issues is reserved",
    );
    process.env.CODEX_ARGS = `--agent publisher --agents '${JSON.stringify({ publisher: { prompt: "Open an issue", mcpServers: [config] } })}'`;
    await expect(prepareAgentConfiguration()).rejects.toThrow(
      "github_issues is reserved",
    );
  },
);

test("invalid settings fail before tag mode posts a working comment", async () => {
  process.env.INPUT_SETTINGS = '{"permissions":{"allow":"Read"}}';
  const checkActor = spyOn(actor, "checkHumanActor").mockResolvedValue(
    undefined,
  );
  const createComment = spyOn(createInitial, "createInitialComment");
  try {
    await expect(
      prepareTagMode({
        context: interactiveContext(),
        octokit: {} as any,
        githubToken: "fixture",
      }),
    ).rejects.toThrow("permissions.allow");
    expect(createComment).not.toHaveBeenCalled();
  } finally {
    checkActor.mockRestore();
    createComment.mockRestore();
  }
});

test.each(["plan", "readonly", "read-only"])(
  "settings-based %s permission mode prevents issue-server installation",
  async (defaultMode) => {
    process.env.INPUT_SETTINGS = JSON.stringify({
      permissions: { allow: [issueTool], defaultMode },
    });
    expect(
      (await prepareAgentConfiguration()).mcpServers.github_issues,
    ).toBeUndefined();
  },
);

test("settings-only scoped grants install the server without authorizing an unscoped call", async () => {
  const rule = `${issueTool}(/restricted)`;
  await configureGrant("settings", rule);
  expect(
    (await prepareAgentConfiguration()).mcpServers.github_issues,
  ).toBeDefined();
  const permission = await resolveCompatibility(
    "",
    process.env.INPUT_SETTINGS!,
    '{"mcpServers":{}}',
  );
  const policy = new AgentPermissions({
    cwd: tmpdir(),
    allowedTools: permission.allowedTools,
  });
  expect(() => policy.assertTool(issueTool)).toThrow("without approval");
});

test.each(["pull_request", "issue_comment"] as const)(
  "tag and runtime ignore workspace grants for a PR %s event",
  async (eventName) => {
    const workspace = await mkdtemp(join(tmpdir(), "issue-pr-settings-"));
    directories.push(workspace);
    process.env.GITHUB_WORKSPACE = workspace;
    process.env.INPUT_SETTINGS = join(workspace, "settings.json");
    await writeFile(
      process.env.INPUT_SETTINGS,
      JSON.stringify({ permissions: { allow: ["*"] } }),
    );

    const base = "a".repeat(40);
    const context = createMockContext({
      eventName,
      eventAction: eventName === "pull_request" ? "opened" : "created",
      isPR: true,
      inputs: { prompt: "Review this change", trackProgress: true },
      payload: (eventName === "pull_request"
        ? { pull_request: { base: { sha: base } } }
        : interactiveContext().payload) as any,
    });
    const requested: unknown[] = [];
    const pullRequests: unknown[] = [];
    const settings = JSON.stringify({ permissions: { allow: ["Read"] } });
    const prepared = await prepareTagFixture(context, {
      rest: {
        pulls: {
          /** Resolve the base commit for PR comment events that do not carry it. */
          async get(request: unknown) {
            pullRequests.push(request);
            return { data: { base: { sha: base } } };
          },
        },
        repos: {
          /** Supply settings from the exact requested base SHA. */
          async getContent(request: unknown) {
            requested.push(request);
            return {
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from(settings).toString("base64"),
              },
            };
          },
        },
      },
    });
    expect(requested).toEqual([
      {
        owner: context.repository.owner,
        repo: context.repository.repo,
        path: "settings.json",
        ref: base,
      },
    ]);
    expect(pullRequests).toEqual(
      eventName === "issue_comment"
        ? [
            {
              owner: context.repository.owner,
              repo: context.repository.repo,
              pull_number: context.entityNumber,
            },
          ]
        : [],
    );
    const runtime = await resolveCompatibility(
      prepared.claudeArgs,
      prepared.settings,
      prepared.mcpConfig,
    );
    expect(runtime.allowedTools).toContain("Read");
    expect(runtime.allowedTools).not.toContain("*");
    expect(runtime.allowedTools).not.toContain(issueTool);
    const config = await mcp.prepareMcpConfig({
      context,
      settings: prepared.settings,
      allowedTools: [],
      githubToken: "fixture-token",
      owner: context.repository.owner,
      repo: context.repository.repo,
      branch: "fixture",
      baseBranch: "main",
      mode: "tag",
    });
    expect(JSON.parse(config).mcpServers.github_issues).toBeUndefined();
  },
);

test.each(["external", "workspace"])(
  "a PR symlink cannot redirect an external settings alias to another %s file",
  async (destination) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "issue-settings-alias-")),
    );
    directories.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    process.env.GITHUB_WORKSPACE = workspace;
    const redirected = join(
      destination === "workspace" ? workspace : root,
      "different-settings.json",
    );
    const alias = join(root, "workflow-alias.json");
    const fromPR = join(workspace, "settings.json");
    await writeFile(redirected, '{"permissions":{"allow":["*"]}}');
    await symlink(fromPR, alias);
    await symlink(redirected, fromPR);
    await expect(
      resolveActionSettings(
        createMockContext({ eventName: "pull_request", isPR: true }),
        {} as any,
        alias,
      ),
    ).rejects.toThrow("require a direct file path");
  },
);
