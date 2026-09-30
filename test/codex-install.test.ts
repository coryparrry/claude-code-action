import { afterEach, describe, expect, test } from "bun:test";
import { codexInstallArgs, validateCodexInputs } from "../src/codex-install";

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Codex install and preflight", () => {
  test("pins an exact version and passes paths as separate arguments", () => {
    expect(codexInstallArgs("0.159.2", "/tmp/path with spaces")).toEqual([
      "install",
      "--prefix",
      "/tmp/path with spaces",
      "--no-audit",
      "--no-fund",
      "@openai/codex@0.159.2",
    ]);
    expect(() => codexInstallArgs("latest; echo bad", "/tmp/cli")).toThrow();
    expect(() => codexInstallArgs("latest", "/tmp/cli")).toThrow();
  });
  test("fails before preparation without an API key", () => {
    delete process.env.OPENAI_API_KEY;
    expect(validateCodexInputs).toThrow("requires openai_api_key");
  });
  test("rejects a legacy Claude engine before execution", () => {
    process.env.ACTION_ENGINE = "claude";
    process.env.OPENAI_API_KEY = "test-value";
    expect(validateCodexInputs).toThrow("supports Codex only");
  });
  test("accepts compatible legacy-named controls for runtime translation", () => {
    process.env.OPENAI_API_KEY = "test-value";
    delete process.env.ACTION_ENGINE;
    process.env.CLAUDE_ARGS = "--allowedTools Bash";
    process.env.INPUT_SETTINGS = '{"model":"test"}';
    process.env.ALLOWED_NON_WRITE_USERS = "trusted-user";
    process.env.INPUT_PLUGINS = "tool@market";
    process.env.INPUT_PLUGIN_MARKETPLACES = "owner/repo";
    expect(validateCodexInputs).not.toThrow();
  });
});
