import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const base = new URL("../", import.meta.url).pathname;

describe("Codex-only base action", () => {
  test("contains no removed runtime modules or SDK dependency", () => {
    for (const name of [
      "run-claude.ts",
      "run-claude-sdk.ts",
      "parse-sdk-options.ts",
      "setup-claude-code-settings.ts",
      "install-plugins.ts",
      "workload-identity.ts",
    ]) {
      expect(existsSync(join(base, "src", name))).toBe(false);
    }
    for (const directory of [base, join(base, "..")]) {
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      expect(
        manifest.dependencies["@anthropic-ai/claude-agent-sdk"],
      ).toBeUndefined();
      expect(manifest.dependencies["@openai/agents"]).toBe("0.18.0");
      expect(manifest.dependencies["@openai/codex-sdk"]).toBeUndefined();
    }
    for (const name of readdirSync(join(base, "src"))) {
      const source = readFileSync(join(base, "src", name), "utf8");
      expect(source).not.toMatch(
        /from ["\']@anthropic-ai|runClaude\(|installClaude\(|setupWorkloadIdentity\(/,
      );
    }
  });

  test("offers only Codex execution and OpenAI authentication", () => {
    const metadata = readFileSync(join(base, "action.yml"), "utf8");
    expect(metadata).toContain('name: "Codex Base Action"');
    expect(metadata).not.toContain("npm install --global");
    expect(metadata).not.toContain("Install Codex CLI");
    expect(metadata).toContain("defaults to gpt-5.3-codex");
    expect(metadata).toContain("bun-version: 1.4.2");
    expect(metadata).toContain("OPENAI_API_KEY: ${{ inputs.openai_api_key }}");
    expect(metadata).toContain("claude_args:");
    expect(metadata).toContain("codex_args:");
    expect(metadata).not.toMatch(
      /anthropic|bedrock|vertex|foundry|claude_code_oauth_token/i,
    );
  });

  test("preserves direct workflow controls and the original runtime overrides", () => {
    const controls = [
      "max_turns",
      "max_budget_usd",
      "allowed_tools",
      "disallowed_tools",
      "system_prompt",
      "append_system_prompt",
      "fallback_model",
      "additional_directories",
      "setting_sources",
      "permission_mode",
      "continue_session",
      "resume_session",
    ];
    for (const directory of [base, join(base, "..")]) {
      const metadata = readFileSync(join(directory, "action.yml"), "utf8");
      for (const control of controls) {
        expect(metadata).toContain(`  ${control}:`);
        expect(metadata).toContain(`inputs.${control} }}`);
      }
      expect(metadata).toContain("env.NODE_VERSION || '18.x'");
      expect(metadata).toContain("inputs.use_node_cache == 'true'");
      expect(metadata).toContain("bun-version: 1.4.2");
      expect(metadata).not.toContain("path_to_codex_executable");
      expect(metadata).not.toContain("codex_version");
    }
  });
});
