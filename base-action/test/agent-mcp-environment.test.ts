import { afterEach, describe, expect, test } from "bun:test";
import { exists } from "node:fs/promises";
import {
  prepareMcpStdioCommand,
  scrubMcpEnvironment,
} from "../src/mcp-environment";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("MCP child environment isolation", () => {
  test("removes ambient action and provider credentials while retaining custom values", () => {
    expect(
      scrubMcpEnvironment({
        GITHUB_APP_PRIVATE_KEY: "app-secret",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
        OPENAI_API_KEY: "openai-secret",
        AZURE_OPENAI_AD_TOKEN: "azure-secret",
        CODEX_API_KEY: "codex-secret",
        ANTHROPIC_API_KEY: "anthropic-secret",
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret",
        CUSTOM_MCP_SECRET: "keep-for-config-expansion",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      CUSTOM_MCP_SECRET: "keep-for-config-expansion",
      PATH: "/usr/bin",
    });
  });

  test("Bun startup disables automatic and configured env files with a neutral config", async () => {
    const prepared = await prepareMcpStdioCommand(process.execPath, [
      "run",
      "--env-file",
      ".env.local",
      "--env-file=private.env",
      "--config",
      "unsafe.bunfig.toml",
      "--config=other.bunfig.toml",
      "fixture.ts",
      "--env-file",
      "application-argument",
    ]);
    expect(prepared.args[0]).toBe("--no-env-file");
    expect(prepared.args[1]).toStartWith("--config=");
    expect(prepared.args.slice(0, 4)).toEqual([
      "--no-env-file",
      prepared.args[1]!,
      "run",
      "fixture.ts",
    ]);
    expect(prepared.args).not.toContain(".env.local");
    expect(prepared.args).not.toContain("private.env");
    expect(prepared.args).not.toContain("unsafe.bunfig.toml");
    expect(prepared.args).not.toContain("other.bunfig.toml");
    expect(prepared.args.slice(-3)).toEqual([
      "fixture.ts",
      "--env-file",
      "application-argument",
    ]);
    const config = prepared.args[1]!.slice("--config=".length);
    expect(await exists(config)).toBe(true);
    await prepared.cleanup?.();
    expect(await exists(config)).toBe(false);
  });

  test("does not alter non-Bun commands", async () => {
    const prepared = await prepareMcpStdioCommand("node", ["server.js"]);
    expect(prepared).toEqual({ command: "node", args: ["server.js"] });
  });
});
