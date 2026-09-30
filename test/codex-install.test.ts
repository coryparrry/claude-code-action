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
  test("accepts an explicit existing key and rejects incompatible options", () => {
    process.env.OPENAI_API_KEY = "test-value";
    for (const name of [
      "CLAUDE_ARGS",
      "INPUT_SETTINGS",
      "INPUT_PLUGINS",
      "INPUT_PLUGIN_MARKETPLACES",
      "ALLOWED_NON_WRITE_USERS",
    ])
      delete process.env[name];
    expect(validateCodexInputs).not.toThrow();
    process.env.CLAUDE_ARGS = "--allowedTools Bash";
    expect(validateCodexInputs).toThrow("claude_args is unsupported");
    delete process.env.CLAUDE_ARGS;
    process.env.ALLOWED_NON_WRITE_USERS = "*";
    expect(validateCodexInputs).toThrow(
      "allowed_non_write_users is unsupported",
    );
  });
});
