import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAgentConfiguration,
  substitutePluginConfiguration,
} from "../src/agent-configuration";
import { resolveAgentCommand } from "../src/agent-markdown";
import { createHookRunner, runConfigurationCommand } from "../src/agent-hooks";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-config-")));
  roots.push(root);
  const workspace = join(root, "workspace"),
    home = join(root, "home");
  await Promise.all([mkdir(workspace), mkdir(home)]);
  return { root, workspace, home };
}
async function json(path: string, data: unknown) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(data));
}
async function plugin(
  root: string,
  name = "example",
  extra: Record<string, unknown> = {},
) {
  await json(join(root, ".claude-plugin/plugin.json"), { name, ...extra });
  return root;
}

describe("agent configuration compatibility", () => {
  test("command object maps resolve inline/source bodies and preserve override metadata through the real command catalog", async () => {
    const f = await fixture();
    const root = await plugin(join(f.root, "example"), "example", {
      commands: {
        about: {
          content: "Explain $ARGUMENTS at ${CLAUDE_PLUGIN_ROOT}",
          allowedTools: ["Read"],
          model: "codex-inline",
          description: "Plugin help",
          argumentHint: "<topic>",
        },
        status: {
          source: "./commands/source.md",
          allowedTools: ["Grep"],
          model: "codex-source",
          description: "Override description",
          argumentHint: "<path>",
        },
      },
    });
    await mkdir(join(root, "commands"));
    const sourcePath = join(root, "commands/source.md");
    const original =
      "---\nname: old-name\nallowed-tools: [Write]\nmodel: old-model\ndescription: Old\nextra: preserved\n---\nInspect $ARGUMENTS\n";
    await writeFile(sourcePath, original);
    const cache = join(f.root, "private-cache");
    const config = await loadAgentConfiguration({
      ...f,
      pluginRoots: [root],
      cacheDirectory: cache,
    });
    expect(config.commandDirectories).toHaveLength(1);
    expect(config.commandDirectories[0]?.directory).toStartWith(
      `${cache}/command-definitions-`,
    );
    expect(config.commandDirectories[0]?.pluginRoot).toBe(root);
    const options = {
      cwd: f.workspace,
      env: {},
      allowedTools: ["Read", "Grep"],
      deadline: Date.now() + 5000,
    };
    const inline = await resolveAgentCommand(
      "/example:about architecture",
      config,
      options,
    );
    expect(inline).toMatchObject({
      name: "example:about",
      allowedTools: ["Read"],
      model: "codex-inline",
      instructions: `Explain architecture at ${root}`,
    });
    expect(inline?.metadata).toMatchObject({
      description: "Plugin help",
      "argument-hint": "<topic>",
    });
    const sourced = await resolveAgentCommand(
      "/example:status src",
      config,
      options,
    );
    expect(sourced).toMatchObject({
      name: "example:status",
      allowedTools: ["Grep"],
      model: "codex-source",
      instructions: "Inspect src\n",
    });
    expect(sourced?.metadata).toMatchObject({
      description: "Override description",
      extra: "preserved",
      "argument-hint": "<path>",
    });
    expect(await readFile(sourcePath, "utf8")).toBe(original);
    await expect(
      resolveAgentCommand("/example:source", config, options),
    ).rejects.toThrow("Unknown configured command");
  });

  test("command object maps reject ambiguous content, malformed metadata and escaped source paths", async () => {
    const f = await fixture();
    const root = await plugin(join(f.root, "example"), "example", {
      commands: { ambiguous: { content: "inline", source: "./source.md" } },
    });
    await expect(
      loadAgentConfiguration({ ...f, pluginRoots: [root] }),
    ).rejects.toThrow("exactly one");
    await plugin(root, "example", {
      commands: { broken: { content: "body", allowedTools: "Read" } },
    });
    await expect(
      loadAgentConfiguration({ ...f, pluginRoots: [root] }),
    ).rejects.toThrow("string array");
    await writeFile(join(f.root, "outside.md"), "outside");
    await plugin(root, "example", {
      commands: { escape: { source: "../outside.md" } },
    });
    await expect(
      loadAgentConfiguration({ ...f, pluginRoots: [root] }),
    ).rejects.toThrow("escapes plugin root");
  });
  test("marketplace inline declarations and default layouts work without a plugin manifest", async () => {
    const f = await fixture();
    const market = join(f.root, "market"),
      root = join(market, "example");
    await mkdir(join(root, "commands"), { recursive: true });
    await writeFile(join(root, "commands/review.md"), "Review");
    await json(join(market, ".claude-plugin/marketplace.json"), {
      name: "inline",
      plugins: [
        {
          name: "example",
          source: "./example",
          strict: false,
          mcpServers: { fixture: { command: "fixture" } },
        },
      ],
    });
    const config = await loadAgentConfiguration({
      ...f,
      pluginMarketplaces: market,
      plugins: "example@inline",
    });
    expect(config.plugins[0]?.name).toBe("example");
    expect(config.mcpServers["plugin:example:fixture"]).toEqual({
      command: "fixture",
    });
    expect(config.commandDirectories[0]?.directory).toBe(
      join(root, "commands"),
    );
  });
  test("strict MCP configuration ignores ambient user/project servers while retaining explicit settings", async () => {
    const f = await fixture();
    await json(join(f.workspace, ".mcp.json"), {
      mcpServers: { ambient: { command: "ambient" } },
    });
    await json(join(f.home, ".claude/settings.json"), {
      mcpServers: { user: { command: "user" } },
    });
    const root = await plugin(join(f.root, "example"), "example", {
      mcpServers: { pluginAmbient: { command: "plugin" } },
    });
    await json(join(root, ".mcp.json"), {
      mcpServers: { pluginDefault: { command: "default" } },
    });
    const config = await loadAgentConfiguration({
      ...f,
      strictMcpConfig: true,
      pluginRoots: [root],
      settings: { mcpServers: { explicit: { command: "explicit" } } },
    });
    expect(config.mcpServers).toEqual({ explicit: { command: "explicit" } });
    expect(config.settings.mcpServers).toEqual({
      explicit: { command: "explicit" },
    });
  });

  test("userConfig remains argv data and shell-form templates fail before execution", async () => {
    const f = await fixture();
    const root = await plugin(join(f.root, "example"), "example", {
      userConfig: {
        argument: { type: "string", default: "data; literal shell text" },
      },
    });
    await json(join(root, "hooks/hooks.json"), {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "/usr/bin/printf",
                args: ["%s", "${user_config.argument}"],
              },
            ],
          },
        ],
      },
    });
    const config = await loadAgentConfiguration({ ...f, pluginRoots: [root] });
    expect(
      (
        await createHookRunner({
          workspace: f.workspace,
          hooks: config.hooks,
        }).run("SessionStart")
      ).additionalContext,
    ).toEqual(["data; literal shell text"]);
    await json(join(root, "hooks/hooks.json"), {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "echo ${user_config.argument}" },
            ],
          },
        ],
      },
    });
    await expect(
      loadAgentConfiguration({ ...f, pluginRoots: [root] }),
    ).rejects.toThrow("Shell-form hooks");
  });
  test("loads userConfig defaults/saved options, exports hook env, masks sensitive model text and isolates plugin data", async () => {
    const f = await fixture();
    const root = await plugin(join(f.root, "example"), "example", {
      userConfig: {
        endpoint: { type: "string", default: "default-endpoint" },
        retries: { type: "number", default: 2, min: 1, max: 4 },
        token: { type: "string", sensitive: true, required: true },
      },
      mcpServers: {
        fixture: {
          command: "fixture",
          args: ["${user_config.endpoint}"],
          env: { AUTH: "${user_config.token}" },
        },
      },
    });
    await json(join(root, "hooks/hooks.json"), {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "printf '%s' \"$CLAUDE_PLUGIN_OPTION_ENDPOINT:$CLAUDE_PLUGIN_OPTION_RETRIES\"",
              },
            ],
          },
        ],
      },
    });
    const config = await loadAgentConfiguration({
      ...f,
      pluginRoots: [root],
      dataDirectoryRoot: join(f.root, "runner-data"),
      settings: {
        pluginConfigs: {
          example: {
            endpoint: "saved-endpoint",
            token: "fixture-private-value",
          },
        },
      },
    });
    expect(config.plugins[0]?.dataDirectory).toBe(
      join(f.root, "runner-data/example"),
    );
    expect(config.mcpServers["plugin:example:fixture"]).toMatchObject({
      args: ["saved-endpoint"],
      env: { AUTH: "fixture-private-value" },
    });
    expect(
      substitutePluginConfiguration(
        "Use ${user_config.endpoint}; private ${user_config.token}",
        config.plugins[0]!,
      ),
    ).toBe("Use saved-endpoint; private [sensitive plugin option: token]");
    expect(
      (
        await createHookRunner({
          hooks: config.hooks,
          workspace: f.workspace,
        }).run("SessionStart")
      ).additionalContext,
    ).toEqual(["saved-endpoint:2"]);
    await expect(
      loadAgentConfiguration({
        ...f,
        pluginRoots: [root],
        settings: {
          pluginConfigs: { example: { token: "private", retries: 10 } },
        },
      }),
    ).rejects.toThrow("numeric bounds");
  });

  test("discovers plugin workflows and selected output style while accepting inactive channel/experimental assets", async () => {
    const f = await fixture();
    const root = await plugin(join(f.root, "example"), "example", {
      outputStyles: "./styles",
      workflows: "./flows",
      channels: [{ server: "fixture" }],
      experimental: { themes: "./theme.json" },
    });
    await mkdir(join(root, "styles"));
    await mkdir(join(root, "flows"));
    await writeFile(
      join(root, "styles/brief.md"),
      "---\nname: Brief\n---\nUse concise answers.",
    );
    const config = await loadAgentConfiguration({
      ...f,
      pluginRoots: [root],
      settings: { outputStyle: "example:brief" },
    });
    expect(config.workflowDirectories).toEqual([
      {
        directory: join(root, "flows"),
        namespace: "example",
        pluginRoot: root,
      },
    ]);
    expect(config.projectInstructions).toContain("Use concise answers.");
    expect(config.projectInstructions).not.toContain("name: Brief");
    await expect(
      loadAgentConfiguration({
        ...f,
        pluginRoots: [root],
        settings: { outputStyle: "unknown" },
      }),
    ).rejects.toThrow("Selected output style not found");
  });

  test("uses full commit sha before ref and loads git-subdir sources from deterministic offline checkouts", async () => {
    const f = await fixture();
    const repository = join(f.root, "repository"),
      root = await plugin(join(repository, "plugins/example"));
    const git = async (args: string[]) => {
      const result = await runConfigurationCommand("git", args, {
        workspace: repository,
        environment: { PATH: "/usr/bin:/bin", HOME: f.home },
        deadline: Date.now() + 15_000,
      });
      expect(result.code).toBe(0);
      return result.stdout.trim();
    };
    await json(join(root, ".mcp.json"), {
      mcpServers: { fixture: { command: "old" } },
    });
    await git(["init"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "old",
    ]);
    const sha = await git(["rev-parse", "HEAD"]);
    await json(join(root, ".mcp.json"), {
      mcpServers: { fixture: { command: "new" } },
    });
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "new",
    ]);
    const market = join(f.root, "market");
    await json(join(market, ".claude-plugin/marketplace.json"), {
      name: "pinned",
      plugins: [
        {
          name: "example",
          source: {
            source: "git-subdir",
            url: `file://${repository}`,
            path: "plugins/example",
            ref: "missing-ref-sha-wins",
            sha,
          },
        },
      ],
    });
    const config = await loadAgentConfiguration({
      ...f,
      pluginMarketplaces: market,
      plugins: "example@pinned",
      cacheDirectory: join(f.root, "cache"),
    });
    expect(config.mcpServers["plugin:example:fixture"]).toEqual({
      command: "old",
    });
    expect(config.plugins[0]?.root).toEndWith("plugins/example");
    const badMarket = {
      name: "pinned",
      plugins: [
        {
          name: "example",
          source: { source: "url", url: `file://${repository}`, sha: "abc" },
        },
      ],
    };
    await json(join(market, ".claude-plugin/marketplace.json"), badMarket);
    await expect(
      loadAgentConfiguration({
        ...f,
        pluginMarketplaces: market,
        plugins: "example@pinned",
        cacheDirectory: join(f.root, "cache"),
      }),
    ).rejects.toThrow("40-character");
  });
  test("loads native Codex TOML settings and MCP configuration", async () => {
    const f = await fixture();
    await mkdir(join(f.workspace, ".codex"));
    await writeFile(
      join(f.workspace, ".codex/config.toml"),
      'model = "codex-fixture"\n[mcp_servers.fixture]\ncommand = "fixture-command"',
    );
    const config = await loadAgentConfiguration(f);
    expect(config.settings.model).toBe("codex-fixture");
    expect(config.mcpServers.fixture).toEqual({ command: "fixture-command" });
  });

  test("exposes plugin agents and merged LSP definitions with path interpolation", async () => {
    const f = await fixture();
    const root = await plugin(join(f.root, "example"), "example", {
      lspServers: {
        extra: { command: "${CLAUDE_PLUGIN_ROOT}/language-server", args: [] },
      },
    });
    await mkdir(join(root, "agents"));
    await writeFile(
      join(root, "agents/reviewer.md"),
      "---\nname: reviewer\n---\nReview carefully",
    );
    await json(join(root, ".lsp.json"), { default: { command: "fixture" } });
    const config = await loadAgentConfiguration({ ...f, pluginRoots: [root] });
    expect(config.agentDirectories).toEqual([
      {
        directory: join(root, "agents"),
        namespace: "example",
        pluginRoot: root,
      },
    ]);
    expect(config.lspServers).toEqual({
      "plugin:example:default": { command: "fixture" },
      "plugin:example:extra": { command: `${root}/language-server`, args: [] },
    });
  });
  test("merges user/project/local settings, prefers Codex equivalents and explicit overrides", async () => {
    const f = await fixture();
    await json(join(f.home, ".claude/settings.json"), {
      env: { A: "user", B: "user" },
      permissions: { allow: ["Read"] },
      model: "user",
    });
    await json(join(f.workspace, ".claude/settings.json"), {
      env: { A: "project" },
      permissions: { allow: ["Bash", "Read"] },
      model: "project",
    });
    await json(join(f.workspace, ".codex/settings.json"), { model: "codex" });
    await json(join(f.workspace, ".claude/settings.local.json"), {
      env: { A: "local" },
    });
    const result = await loadAgentConfiguration({
      ...f,
      settings: { env: { C: "explicit" } },
    });
    expect(result.settings).toEqual({
      env: { A: "local", B: "user", C: "explicit" },
      permissions: { allow: ["Read", "Bash"] },
      model: "codex",
    });
    expect(result.sources).toHaveLength(4);
  });

  test("setting-sources chooses scopes without reversing precedence; empty disables them", async () => {
    const f = await fixture();
    await json(join(f.home, ".claude/settings.json"), { model: "user" });
    await json(join(f.workspace, ".claude/settings.json"), {
      model: "project",
    });
    await json(join(f.workspace, ".claude/settings.local.json"), {
      model: "local",
    });
    expect(
      (await loadAgentConfiguration({ ...f, settingSources: "project,user" }))
        .settings.model,
    ).toBe("project");
    expect(
      (await loadAgentConfiguration({ ...f, settingSources: "" })).settings,
    ).toEqual({});
    await expect(
      loadAgentConfiguration({ ...f, settingSources: "managed" }),
    ).rejects.toThrow("setting-sources");
  });

  test("loads explicit JSON file/TOML and fails malformed existing sources", async () => {
    const f = await fixture();
    await json(join(f.workspace, "explicit.json"), { model: "explicit" });
    expect(
      (await loadAgentConfiguration({ ...f, settings: "explicit.json" }))
        .settings.model,
    ).toBe("explicit");
    expect(
      (await loadAgentConfiguration({ ...f, settings: 'model = "codex"' }))
        .settings.model,
    ).toBe("codex");
    await mkdir(join(f.workspace, ".claude"));
    await writeFile(join(f.workspace, ".claude/settings.json"), "broken");
    await expect(loadAgentConfiguration(f)).rejects.toThrow(
      "Cannot load configuration",
    );
  });

  test("collects selected commands/skills, trusted instructions and layered MCP", async () => {
    const f = await fixture();
    await mkdir(join(f.home, ".claude/commands"), { recursive: true });
    await mkdir(join(f.workspace, ".codex/skills"), { recursive: true });
    await json(join(f.home, ".mcp.json"), {
      mcpServers: {
        user: { command: "user" },
        shared: { command: "old", args: [] },
      },
    });
    await json(join(f.workspace, ".mcp.json"), {
      mcpServers: { shared: { command: "new" } },
    });
    await writeFile(
      join(f.workspace, "AGENTS.md"),
      "Trusted project instructions",
    );
    await writeFile(join(f.home, "CLAUDE.md"), "Trusted user instructions");
    const result = await loadAgentConfiguration(f);
    expect(result.mcpServers).toEqual({
      user: { command: "user" },
      shared: { command: "new", args: [] },
    });
    expect(result.commandDirectories[0]?.directory).toBe(
      join(f.home, ".claude/commands"),
    );
    expect(result.skillDirectories[0]?.directory).toBe(
      join(f.workspace, ".codex/skills"),
    );
    expect(result.projectInstructions).toContain(
      "Trusted project instructions",
    );
    expect(result.projectInstructions).toContain("Trusted user instructions");
    expect(
      (await loadAgentConfiguration({ ...f, settingSources: "project" }))
        .mcpServers,
    ).toEqual({ shared: { command: "new" } });
  });

  test("loads legacy marketplace commands, skills, MCP and hooks without any vendor runtime", async () => {
    const f = await fixture();
    const market = join(f.root, "market"),
      root = join(market, "plugins/example");
    await plugin(root, "example", {
      commands: ["./commands/review.md"],
      skills: "./extra-skills",
      mcpServers: {
        direct: {
          command: "${CLAUDE_PLUGIN_ROOT}/server",
          env: { DATA: "${CLAUDE_PLUGIN_DATA}" },
        },
      },
    });
    await json(join(market, ".claude-plugin/marketplace.json"), {
      name: "local",
      plugins: [{ name: "example", source: "./plugins/example" }],
    });
    await mkdir(join(root, "commands"));
    await writeFile(join(root, "commands/review.md"), "Review $ARGUMENTS");
    await mkdir(join(root, "skills"));
    await mkdir(join(root, "extra-skills"));
    await json(join(root, ".mcp.json"), {
      mcpServers: { default: { command: "fixture" } },
    });
    await json(join(root, "hooks/hooks.json"), {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "printf '%s' \"$CLAUDE_PLUGIN_ROOT\"",
              },
            ],
          },
        ],
      },
    });
    const config = await loadAgentConfiguration({
      ...f,
      pluginMarketplaces: market,
      plugins: "example@local",
    });
    expect(config.plugins[0]?.root).toBe(root);
    expect(config.commandDirectories[0]).toMatchObject({
      directory: join(root, "commands/review.md"),
      namespace: "example",
    });
    expect(config.skillDirectories).toHaveLength(2);
    expect(config.mcpServers["plugin:example:direct"]).toMatchObject({
      command: `${root}/server`,
      env: { DATA: join(f.home, ".codex/plugin-data/example") },
    });
    expect(config.mcpServers["plugin:example:default"]).toEqual({
      command: "fixture",
    });
    const hooks = await createHookRunner({
      hooks: config.hooks,
      workspace: f.workspace,
    }).run("SessionStart");
    expect(hooks.additionalContext).toEqual([root]);
  });

  test("enabledPlugins, extraKnownMarketplaces and disableAllHooks are honored", async () => {
    const f = await fixture();
    const market = join(f.root, "market");
    await plugin(join(market, "example"));
    await json(join(market, ".claude-plugin/marketplace.json"), {
      name: "local",
      plugins: [{ name: "example", source: "./example" }],
    });
    await json(join(f.workspace, ".claude/settings.json"), {
      enabledPlugins: { "example@local": true, "missing@local": false },
      extraKnownMarketplaces: {
        local: { source: { source: "directory", path: market } },
      },
      disableAllHooks: true,
      hooks: { Stop: [{ hooks: [{ type: "command", command: "exit 2" }] }] },
    });
    const result = await loadAgentConfiguration(f);
    expect(result.plugins.map((plugin) => plugin.name)).toEqual(["example"]);
    expect(result.hooks).toEqual({});
  });

  test("rejects missing required plugin options and component path escapes", async () => {
    const f = await fixture();
    const root = await plugin(join(f.root, "example"), "example", {
      userConfig: { endpoint: { type: "string", required: true } },
    });
    await expect(
      loadAgentConfiguration({ ...f, pluginRoots: [root] }),
    ).rejects.toThrow("Required plugin option missing");
    await plugin(root, "example", { commands: "../outside.md" });
    await writeFile(join(f.root, "outside.md"), "outside");
    await expect(
      loadAgentConfiguration({ ...f, pluginRoots: [root] }),
    ).rejects.toThrow("escapes plugin root");
  });

  test("rejects duplicate plugin identities and unsafe property merges", async () => {
    const f = await fixture();
    const a = await plugin(join(f.root, "a")),
      b = await plugin(join(f.root, "b"));
    await expect(
      loadAgentConfiguration({ ...f, pluginRoots: [a, b] }),
    ).rejects.toThrow("Duplicate plugin name");
    await expect(
      loadAgentConfiguration({
        ...f,
        settings: '{"env":{"__proto__":{"unsafe":true}}}',
      }),
    ).rejects.toThrow("reserved property");
  });

  test("clones a Git marketplace into caller cache and loads plugin resources offline", async () => {
    const f = await fixture();
    const market = join(f.root, "market");
    await plugin(join(market, "example"));
    await json(join(market, ".claude-plugin/marketplace.json"), {
      name: "git-fixture",
      plugins: [{ name: "example", source: "./example" }],
    });
    for (const args of [
      ["init"],
      ["add", "."],
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
    ]) {
      const result = await runConfigurationCommand("git", args, {
        workspace: market,
        environment: { PATH: "/usr/bin:/bin", HOME: f.home },
        deadline: Date.now() + 10_000,
      });
      expect(result.code).toBe(0);
    }
    const result = await loadAgentConfiguration({
      ...f,
      pluginMarketplaces: `file://${market}`,
      plugins: "example@git-fixture",
      cacheDirectory: join(f.root, "cache"),
      deadline: Date.now() + 15_000,
    });
    expect(result.plugins[0]?.root).toContain("cache/marketplace-");
    expect(
      JSON.parse(
        await readFile(
          join(result.plugins[0]!.root, ".claude-plugin/plugin.json"),
          "utf8",
        ),
      ).name,
    ).toBe("example");
  });

  test("downloads HTTP marketplace manifests and clones remote entry sources against local fixtures", async () => {
    const f = await fixture();
    const root = await plugin(join(f.root, "example"));
    for (const args of [
      ["init"],
      ["add", "."],
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
    ])
      expect(
        (
          await runConfigurationCommand("git", args, {
            workspace: root,
            environment: { PATH: "/usr/bin:/bin", HOME: f.home },
            deadline: Date.now() + 10_000,
          })
        ).code,
      ).toBe(0);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json({
          name: "http-fixture",
          plugins: [
            {
              name: "example",
              source: { source: "git", url: `file://${root}` },
            },
          ],
        }),
    });
    try {
      const config = await loadAgentConfiguration({
        ...f,
        pluginMarketplaces: `${server.url}marketplace.json`,
        plugins: "example@http-fixture",
        cacheDirectory: join(f.root, "cache"),
      });
      expect(config.plugins[0]?.name).toBe("example");
      expect(config.plugins[0]?.root).toContain("cache/plugin-");
    } finally {
      server.stop(true);
    }
  });

  test("remote installation requires owned cache and honors cancellation before spawn", async () => {
    const f = await fixture();
    await expect(
      loadAgentConfiguration({
        ...f,
        pluginMarketplaces: "https://example.invalid/market.git",
      }),
    ).rejects.toThrow("cacheDirectory");
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadAgentConfiguration({
        ...f,
        pluginMarketplaces: "https://example.invalid/market.git",
        cacheDirectory: join(f.root, "cache"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
});
