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
    }
    for (const name of readdirSync(join(base, "src"))) {
      const source = readFileSync(join(base, "src", name), "utf8");
      expect(source).not.toMatch(
        /@anthropic-ai|run-claude|CLAUDE_CODE_|ANTHROPIC_/,
      );
    }
  });

  test("offers only Codex execution and OpenAI authentication", () => {
    const metadata = readFileSync(join(base, "action.yml"), "utf8");
    expect(metadata).toContain('name: "Codex Base Action"');
    expect(metadata).toContain(
      'npm install --global "@openai/codex@$CODEX_VERSION"',
    );
    expect(metadata).toContain("OPENAI_API_KEY: ${{ inputs.openai_api_key }}");
    expect(metadata).not.toMatch(/claude|anthropic|bedrock|vertex|foundry/i);
  });
});
