import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCompatibility,
  splitCompatibilityArgs,
} from "../src/codex-compat";
import { expandCommand } from "../src/codex-commands";
import { pluginSetupCommands } from "../src/codex-plugins";

const empty = '{"mcpServers":{}}';
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
      "extra",
      "action",
    ]);
    await expect(
      resolveCompatibility(
        `--mcp-config '${custom}'`,
        "",
        '{"mcpServers":{"extra":{"command":"action"}}}',
      ),
    ).rejects.toThrow("conflicts");
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
  test.each([
    "--max-turns 5",
    '--allowedTools "Bash(gh:*)"',
    "--allowedTools Read",
    "--unknown option",
    "--model",
  ])("rejects controls without a safe native equivalent: %s", async (args) => {
    await expect(resolveCompatibility(args, "", empty)).rejects.toThrow();
  });
  test.each([
    "approval_policy",
    "shell_environment_policy",
    "model_provider",
    "hooks",
  ])("rejects unsupported or security-changing settings %s", async (field) => {
    await expect(
      resolveCompatibility("", JSON.stringify({ [field]: {} }), empty),
    ).rejects.toThrow("Unsupported settings field");
  });
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
