import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCompatibility,
  splitCompatibilityArgs,
  normalizeCodexEffort,
} from "../src/codex-compat";
import { expandCommand } from "../src/codex-commands";
import { pluginSetupCommands } from "../src/codex-plugins";

const empty = '{"mcpServers":{}}';
test("legacy efforts use supported Sol values while explicit older models retain their limits", () => {
  expect(normalizeCodexEffort("none")).toBe("low");
  expect(normalizeCodexEffort("minimal")).toBe("low");
  expect(normalizeCodexEffort("ultra")).toBe("max");
  expect(normalizeCodexEffort("max")).toBe("max");
  expect(normalizeCodexEffort("max", "gpt-5.3-codex")).toBe("xhigh");
});
describe("Codex compatibility controls", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "compat-controls-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("parses quoted values without executing shell syntax", () => {
    expect(
      splitCompatibilityArgs(
        "--model '$(touch /tmp/no)' --append-system-prompt \"hello world\"\\\n --effort=high",
      ),
    ).toEqual([
      "--model",
      "$(touch /tmp/no)",
      "--append-system-prompt",
      "hello world",
      "--effort=high",
    ]);
    expect(() => splitCompatibilityArgs("--model 'broken")).toThrow(
      "unterminated",
    );
  });
  test("ignores full-line comments while preserving quoted hashes and continued arguments", () => {
    expect(
      splitCompatibilityArgs(
        `# --allowedTools Bash\n--model test\n  # --effort low\n--effort \\\n high\n--append-system-prompt 'Keep\n# this literal\ntext'`,
      ),
    ).toEqual([
      "--model",
      "test",
      "--effort",
      "high",
      "--append-system-prompt",
      "Keep\n# this literal\ntext",
    ]);
  });
  test("maps MCP tools, deny precedence and whole shell permissions", async () => {
    const action = JSON.stringify({
      mcpServers: { github: { command: "bun" }, other: { command: "bun" } },
    });
    const result = await resolveCompatibility(
      '--model test --effort high --allowedTools "mcp__github__read,mcp__github__write" --disallowedTools mcp__github__write',
      "",
      action,
    );
    expect(result.model).toBe("test");
    expect(result.effort).toBe("high");
    expect(result.configOverrides).toContain(
      'mcp_servers."github".enabled_tools=["read","write"]',
    );
    expect(result.configOverrides).toContain(
      'mcp_servers."github".disabled_tools=["write"]',
    );
    expect(result.configOverrides).toContain(
      'mcp_servers."other".enabled=false',
    );
    expect(result.configOverrides).toContain("features.shell_tool=false");
    expect(result.configOverrides).toContain("features.unified_exec=false");
    expect(result.configOverrides).toContain(
      "features.apply_patch_freeform=false",
    );
    const wholeServer = await resolveCompatibility(
      "--allowedTools mcp__github --disallowedTools mcp__other",
      "",
      action,
    );
    expect(wholeServer.configOverrides).not.toContain(
      'mcp_servers."github".enabled=false',
    );
    expect(wholeServer.configOverrides).toContain(
      'mcp_servers."other".enabled=false',
    );
    const bash = await resolveCompatibility(
      "--allowedTools Bash mcp__github__*",
      "",
      action,
    );
    expect(bash.configOverrides).not.toContain("features.shell_tool=false");
    expect(bash.configOverrides).not.toContain(
      'mcp_servers."github".enabled=false',
    );
  });
  test("unions repeated tool flags and aliases with settings permissions before denies", async () => {
    const mcp = JSON.stringify({ mcpServers: { github: { command: "bun" } } });
    const result = await resolveCompatibility(
      "--allowedTools mcp__github__read --allowed-tools mcp__github__write mcp__github__read --allowedTools=mcp__github__list --disallowedTools mcp__github__write --disallowed-tools mcp__github__delete --disallowedTools=mcp__github__write",
      JSON.stringify({
        permissions: {
          allow: ["mcp__github__settings_read"],
          deny: ["mcp__github__settings_delete"],
        },
      }),
      mcp,
    );
    expect(result.configOverrides).toContain(
      'mcp_servers."github".enabled_tools=["settings_read","read","write","list"]',
    );
    expect(result.configOverrides).toContain(
      'mcp_servers."github".disabled_tools=["settings_delete","write","delete"]',
    );
  });
  test("preserves each additional directory across repeated flags and consecutive values", async () => {
    const result = await resolveCompatibility(
      "--add-dir '/tmp/one space' /tmp/two --add-dir=/tmp/three --add-dir /tmp/two --model test",
      "",
      empty,
    );
    expect(result.additionalDirectories).toEqual([
      "/tmp/one space",
      "/tmp/two",
      "/tmp/three",
    ]);
    expect(result.model).toBe("test");
    await expect(resolveCompatibility("--add-dir", "", empty)).rejects.toThrow(
      "requires a value",
    );
  });
  test("separates replacement and appended instructions and preserves resume thread id", async () => {
    const result = await resolveCompatibility(
      "--system-prompt 'Replacement role' --append-system-prompt 'Appended role instructions' --resume thread-test-id",
      '{"developer_instructions":"Original role"}',
      empty,
    );
    expect(result.systemPrompt).toBe("Replacement role");
    expect(result.appendSystemPrompt).toBe("Appended role instructions");
    expect(result.resumeThreadId).toBe("thread-test-id");
    expect(result.configOverrides).toContain(
      'developer_instructions="Replacement role"',
    );
    expect(result.configOverrides).not.toContain(
      'developer_instructions="Original role"',
    );
    const last = await resolveCompatibility(
      "--system-prompt first --system-prompt second",
      "",
      empty,
    );
    expect(last.systemPrompt).toBe("second");
    expect(last.configOverrides).toEqual(['developer_instructions="second"']);
    await expect(resolveCompatibility("--resume", "", empty)).rejects.toThrow(
      "requires a value",
    );
  });
  test("preserves custom MCP JSON and file servers with generated action servers", async () => {
    const custom = join(directory, "mcp.json");
    await writeFile(
      custom,
      JSON.stringify({
        mcpServers: {
          extra: {
            command: "custom",
            args: ["--flag"],
            env: { CUSTOM_TOKEN: "fake" },
          },
        },
      }),
    );
    const result = await resolveCompatibility(
      `--mcp-config '${custom}'`,
      "",
      JSON.stringify({ mcpServers: { action: { command: "bun" } } }),
    );
    expect(Object.keys(JSON.parse(result.mcpConfig).mcpServers)).toEqual([
      "action",
      "extra",
    ]);
    const overridden = await resolveCompatibility(
      `--mcp-config '${custom}'`,
      "",
      '{"mcpServers":{"extra":{"command":"action"}}}',
    );
    expect(JSON.parse(overridden.mcpConfig).mcpServers.extra.command).toBe(
      "custom",
    );
  });
  test("maps native TOML/JSON and legacy settings tool permissions", async () => {
    const toml = await resolveCompatibility(
      "",
      'model = "test"\nmodel_reasoning_effort = "high"\n[features]\nunified_exec = false',
      empty,
    );
    expect(toml.configOverrides).toEqual([
      'model="test"',
      'model_reasoning_effort="high"',
      "features.unified_exec=false",
    ]);
    const settings = await resolveCompatibility(
      "",
      '{"model":"test","permissions":{"allow":["Bash"],"deny":[]}}',
      empty,
    );
    expect(settings.configOverrides).toEqual(['model="test"']);
  });
  test.each(["--unknown option", "--model"])(
    "rejects unknown flags and missing values: %s",
    async (args) => {
      await expect(resolveCompatibility(args, "", empty)).rejects.toThrow();
    },
  );
  test.each(["approval_policy", "shell_environment_policy", "model_provider"])(
    "rejects unsupported or security-changing settings %s",
    async (field) => {
      await expect(
        resolveCompatibility("", JSON.stringify({ [field]: {} }), empty),
      ).rejects.toThrow("Unsupported settings field");
    },
  );
  test("loads schema JSON/file, append instructions and nonrepository mode", async () => {
    const schema = {
      type: "object",
      properties: { done: { type: "boolean" } },
      required: ["done"],
      additionalProperties: false,
    };
    const path = join(directory, "schema.json");
    await writeFile(path, JSON.stringify(schema));
    const result = await resolveCompatibility(
      `--skip-git-repo-check --json-schema '${path}' --append-system-prompt 'Extra instructions'`,
      "",
      empty,
    );
    expect(result.schema).toEqual(schema);
    expect(result.skipGitRepoCheck).toBe(true);
    expect(result.appendSystemPrompt).toBe("Extra instructions");
    await expect(
      resolveCompatibility("--json-schema 'broken'", "", empty),
    ).rejects.toThrow();
  });
  test("retains scoped builtin permissions from original tag-mode/user/direct sources without widening", async () => {
    const result = await resolveCompatibility(
      '--permission-mode acceptEdits --allowedTools "Glob,Grep,Read,Bash(git add:*),Bash(git commit:*)" --allowed-tools "Bash(gh pr:*),Read(//tmp/**)" --disallowedTools Bash(rm:*),Bash(sudo:*)',
      JSON.stringify({
        permissions: {
          allow: ["Edit(src/**)"],
          deny: ["Write(secrets/**)"],
          defaultMode: "default",
        },
      }),
      empty,
      ["Read", "Bash(git status:*)"],
      {
        allowedTools: "View,Bash(cat:*)",
        disallowedTools: ["Bash(rm:*)", "Edit(config/**)"],
      },
    );
    expect(result.allowedTools).toEqual([
      "Edit(src/**)",
      "Glob",
      "Grep",
      "Read",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(gh pr:*)",
      "Read(//tmp/**)",
      "View",
      "Bash(cat:*)",
      "Bash(git status:*)",
    ]);
    expect(result.allowedTools).not.toContain("Bash");
    expect(result.disallowedTools).toEqual([
      "Write(secrets/**)",
      "Bash(rm:*)",
      "Bash(sudo:*)",
      "Edit(config/**)",
    ]);
    expect(result.permissionMode).toBe("acceptEdits");
  });
  test("preserves the Agents SDK turn/budget/fallback controls instead of substituting timeouts", async () => {
    const result = await resolveCompatibility(
      "--max-turns 7 --max-budget-usd 1.25 --fallback-model fallback --model primary",
      "",
      empty,
    );
    expect(result.maxTurns).toBe(7);
    expect(result.maxBudgetUsd).toBe(1.25);
    expect(result.fallbackModel).toBe("fallback");
    expect(result.model).toBe("primary");
    const direct = await resolveCompatibility(
      "--max-turns 7 --model flag-model --fallback-model flag-fallback",
      "",
      empty,
      [],
      {
        maxTurns: "11",
        maxBudgetUsd: 2.5,
        model: "direct-model",
        fallbackModel: "direct-fallback",
        systemPrompt: "direct system",
        appendSystemPrompt: "direct append",
      },
    );
    expect(direct.maxTurns).toBe(11);
    expect(direct.maxBudgetUsd).toBe(2.5);
    expect(direct.model).toBe("direct-model");
    expect(direct.fallbackModel).toBe("direct-fallback");
    expect(direct.systemPrompt).toBe("direct system");
    expect(direct.appendSystemPrompt).toBe("direct append");
  });
  test.each([
    "--max-turns 0",
    "--max-turns -1",
    "--max-turns 1.5",
    "--max-turns nope",
    "--max-turns 9007199254740992",
    "--max-budget-usd 0",
    "--max-budget-usd Infinity",
  ])("rejects invalid run controls %s", async (args) => {
    await expect(resolveCompatibility(args, "", empty)).rejects.toThrow(
      "positive",
    );
  });
  test("preserves resume/continue, setting sources and explicit tools including no tools", async () => {
    const result = await resolveCompatibility(
      "--resume thread-id --continue --setting-sources project,local --permission-mode plan --tools Read,Grep",
      "",
      empty,
    );
    expect(result.resumeThreadId).toBe("thread-id");
    expect(result.continueSession).toBe(true);
    expect(result.settingSources).toEqual(["project", "local"]);
    expect(result.permissionMode).toBe("plan");
    expect(result.tools).toEqual(["Read", "Grep"]);
    const disabled = await resolveCompatibility(
      '--tools "" --setting-sources "" --continue=false',
      "",
      empty,
    );
    expect(disabled.tools).toEqual([]);
    expect(disabled.settingSources).toEqual([]);
    expect(disabled.continueSession).toBe(false);
  });
  test("keeps original settings-source defaults and honors explicit model overrides over settings", async () => {
    const fromSettings = await resolveCompatibility(
      "",
      '{"model":"settings-model","model_reasoning_effort":"high","developer_instructions":"Settings instructions"}',
      empty,
    );
    expect(fromSettings.settingSources).toEqual(["user", "project", "local"]);
    expect(fromSettings.model).toBe("settings-model");
    expect(fromSettings.effort).toBe("high");
    expect(fromSettings.systemPrompt).toBe("Settings instructions");
    const overridden = await resolveCompatibility(
      "--model flag-model --effort low",
      '{"model":"settings-model","model_reasoning_effort":"high"}',
      empty,
      [],
      { model: "direct-model" },
    );
    expect(overridden.model).toBe("direct-model");
    expect(overridden.effort).toBe("low");
  });
  test("retains normalized legacy hook/plugin settings for the engine loader", async () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "node guard.js" }],
          },
        ],
      },
      enabledPlugins: { "plugin@market": true },
      permissions: {
        additionalDirectories: ["/tmp/extra"],
        defaultMode: "acceptEdits",
        allow: ["Read"],
        deny: ["Write(private/**)"],
      },
    };
    const result = await resolveCompatibility(
      "",
      JSON.stringify(settings),
      empty,
    );
    expect(result.normalizedSettings).toEqual(settings);
    expect(result.additionalDirectories).toEqual(["/tmp/extra"]);
    expect(result.permissionMode).toBe("acceptEdits");
    expect(result.allowedTools).toEqual(["Read"]);
    expect(result.disallowedTools).toEqual(["Write(private/**)"]);
  });
  test("retains explicit ask rules under bypass and merges direct asks without widening", async () => {
    const result = await resolveCompatibility(
      "--permission-mode bypassPermissions",
      JSON.stringify({
        permissions: {
          allow: ["Bash"],
          ask: ["Bash(rm:*)", "Read(private/**)"],
        },
      }),
      empty,
      [],
      { askTools: ["Bash(rm:*)", "Edit(config/**)"] },
    );
    expect(result.permissionMode).toBe("bypassPermissions");
    expect(result.askTools).toEqual([
      "Bash(rm:*)",
      "Read(private/**)",
      "Edit(config/**)",
    ]);
    expect(result.allowedTools).toEqual(["Bash"]);
    await expect(
      resolveCompatibility("", '{"permissions":{"ask":[false]}}', empty),
    ).rejects.toThrow("permissions.ask must be a string array");
  });
  test("distinguishes default tool availability from explicitly empty tools and accepts direct resumeSession", async () => {
    expect((await resolveCompatibility("", "", empty)).tools).toBeUndefined();
    expect((await resolveCompatibility('--tools ""', "", empty)).tools).toEqual(
      [],
    );
    expect(
      (
        await resolveCompatibility("", "", empty, [], {
          tools: "",
          resumeSession: "retained-session",
        })
      ).tools,
    ).toEqual([]);
    expect(
      (
        await resolveCompatibility("", "", empty, [], {
          resumeSession: "retained-session",
        })
      ).resumeThreadId,
    ).toBe("retained-session");
  });
  test("maps max/ultra effort to the selected model's supported API value", async () => {
    expect((await resolveCompatibility("--effort max", "", empty)).effort).toBe(
      "max",
    );
    expect(
      (
        await resolveCompatibility(
          "--model gpt-5.3-codex --effort ultra",
          "",
          empty,
        )
      ).effort,
    ).toBe("xhigh");
    expect(
      (
        await resolveCompatibility("", "", empty, [], {
          model: "gpt-5.3-codex",
          effort: "ultra",
        })
      ).effort,
    ).toBe("xhigh");
    expect(
      (
        await resolveCompatibility(
          "--model custom-model --effort ultra",
          "",
          empty,
        )
      ).effort,
    ).toBe("ultra");
  });
  test.each([
    "OPENAI_API_KEY",
    "INPUT_SETTINGS",
    "GITHUB_OUTPUT",
    "ALLINPUTS",
    "ALL_INPUTS",
    "MAX_TURNS",
    "SYSTEM_PROMPT",
    "FALLBACK_MODEL",
    "OUTPUT_FILE",
    "PATH_TO_CODEX_EXECUTABLE",
    "SHOW_FULL_OUTPUT",
  ])(
    "protects runtime/auth/output variable %s in settings.env",
    async (name) => {
      await expect(
        resolveCompatibility(
          "",
          JSON.stringify({ env: { [name]: "replacement" } }),
          empty,
        ),
      ).rejects.toThrow("reserved or credential variable");
    },
  );
  test("rejects credentials hidden under an otherwise ordinary settings.env name", async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "offline-scoped-token-for-alias-test";
    try {
      await expect(
        resolveCompatibility(
          "",
          JSON.stringify({ env: { BUILD_CONFIG: process.env.GITHUB_TOKEN } }),
          empty,
        ),
      ).rejects.toThrow("reserved or credential variable");
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });
  test("preserves ordinary build variables and generic legacy output/config settings", async () => {
    const settings = {
      env: { NODE_ENV: "test", CI: "true" },
      outputStyle: "Explanatory",
      includeCoAuthoredBy: false,
      enabledPlugins: { "plugin@market": true },
      alwaysThinkingEnabled: true,
    };
    const result = await resolveCompatibility(
      "",
      JSON.stringify(settings),
      empty,
    );
    expect(result.toolEnvironment).toEqual({ NODE_ENV: "test", CI: "true" });
    expect(result.normalizedSettings).toEqual(settings);
  });
  test("retains genuine headless engine controls without altering explicit MCP servers", async () => {
    const result = await resolveCompatibility(
      "--strict-mcp-config --no-session-persistence --disable-slash-commands --debug --verbose --output-format stream-json",
      "",
      '{"mcpServers":{"action":{"command":"bun"}}}',
    );
    expect(result.strictMcpConfig).toBe(true);
    expect(result.persistSession).toBe(false);
    expect(result.disableSlashCommands).toBe(true);
    expect(result.debug).toBe(true);
    expect(result.verbose).toBe(true);
    expect(result.outputFormat).toBe("stream-json");
    expect(JSON.parse(result.mcpConfig).mcpServers.action.command).toBe("bun");
    const overrides = await resolveCompatibility(
      "--debug --verbose --strict-mcp-config --no-session-persistence",
      "",
      empty,
      [],
      {
        debug: false,
        verbose: false,
        strictMcpConfig: false,
        persistSession: true,
      },
    );
    expect(overrides.debug).toBe(false);
    expect(overrides.verbose).toBe(false);
    expect(overrides.strictMcpConfig).toBe(false);
    expect(overrides.persistSession).toBe(true);
  });
  test("unions repeated plugin directories and preserves agent definitions for the configuration loader", async () => {
    const definitions = {
      reviewer: {
        description: "Reviews changes",
        prompt: "Check the diff",
        tools: ["Read"],
        maxTurns: 3,
      },
    };
    const result = await resolveCompatibility(
      `--plugin-dir './one space' ./two --plugin-dir ./one --plugin-dir ./two --agents '${JSON.stringify(definitions)}' --agent reviewer`,
      "",
      empty,
      [],
      {
        pluginRoots: ["./direct"],
        agentDefinitions: {
          explorer: {
            description: "Inspects source",
            prompt: "Find relevant files",
          },
        },
      },
    );
    expect(result.pluginRoots).toEqual([
      "./one space",
      "./two",
      "./one",
      "./direct",
    ]);
    expect(result.agentName).toBe("reviewer");
    expect(result.agentDefinitions?.reviewer).toEqual(definitions.reviewer);
    expect(result.agentDefinitions?.explorer).toEqual({
      description: "Inspects source",
      prompt: "Find relevant files",
    });
    await expect(
      resolveCompatibility("--agents broken", "", empty),
    ).rejects.toThrow("JSON agent definitions");
    await expect(
      resolveCompatibility("--agents '[]'", "", empty),
    ).rejects.toThrow("JSON agent definitions");
  });
  test("loads original prompt-file flags into replacement/appended instructions in argument order", async () => {
    const system = join(directory, "system.txt");
    const append = join(directory, "append.txt");
    await writeFile(system, "Replacement instructions from file");
    await writeFile(append, "Appended instructions from file");
    const result = await resolveCompatibility(
      `--system-prompt ignored --system-prompt-file '${system}' --append-system-prompt ignored --append-system-prompt-file '${append}'`,
      "",
      empty,
    );
    expect(result.systemPrompt).toBe("Replacement instructions from file");
    expect(result.appendSystemPrompt).toBe("Appended instructions from file");
    expect(result.configOverrides).toContain(
      'developer_instructions="Replacement instructions from file"',
    );
    await expect(
      resolveCompatibility(
        `--system-prompt-file '${join(directory, "missing")}'`,
        "",
        empty,
      ),
    ).rejects.toThrow();
  });
  test("exposes partial-message intent to the runtime without inventing partial output", async () => {
    expect(
      (
        await resolveCompatibility(
          "--include-partial-messages --output-format stream-json",
          "",
          empty,
        )
      ).includePartialMessages,
    ).toBe(true);
    expect(
      (
        await resolveCompatibility(
          "--include-partial-messages=false --output-format json",
          "",
          empty,
        )
      ).includePartialMessages,
    ).toBe(false);
    await expect(
      resolveCompatibility("--output-format text", "", empty),
    ).rejects.toThrow("must be json or stream-json");
    await expect(
      resolveCompatibility("--debug=api", "", empty),
    ).rejects.toThrow("requires a boolean");
  });
  test("expands explicit repository commands with arguments and rejects missing/unsafe commands", async () => {
    await mkdir(join(directory, ".claude/commands"), { recursive: true });
    await writeFile(
      join(directory, ".claude/commands/label-issue.md"),
      "---\nallowed-tools: Bash\n---\nLabel $1 using $ARGUMENTS",
    );
    expect(await expandCommand("/label-issue owner/repo 3", directory)).toBe(
      "Label owner/repo using owner/repo 3",
    );
    expect(await expandCommand("Context: /missing", directory)).toBe(
      "Context: /missing",
    );
    await expect(expandCommand("/missing", directory)).rejects.toThrow(
      "not found",
    );
    await expect(expandCommand("/../outside", directory)).rejects.toThrow(
      "Invalid",
    );
    await writeFile(join(directory, "outside.md"), "outside");
    await symlink(
      join(directory, "outside.md"),
      join(directory, ".claude/commands/escape.md"),
    );
    await expect(expandCommand("/escape", directory)).rejects.toThrow("inside");
  });
  test("uses native Codex plugin commands and validates selectors without shell execution", () => {
    expect(
      pluginSetupCommands(
        "tool@market\nsecond@market",
        "owner/repo\n./marketplace",
      ),
    ).toEqual([
      ["plugin", "marketplace", "add", "owner/repo", "--json"],
      ["plugin", "marketplace", "add", "./marketplace", "--json"],
      ["plugin", "add", "tool@market", "--json"],
      ["plugin", "add", "second@market", "--json"],
    ]);
    expect(() => pluginSetupCommands("tool; bad", "")).toThrow(
      "Codex-compatible",
    );
    expect(() => pluginSetupCommands("", "--bad")).toThrow("Invalid");
  });
});
