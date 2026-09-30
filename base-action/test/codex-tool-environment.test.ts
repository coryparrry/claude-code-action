import { describe, expect, test } from "bun:test";
import { resolveCompatibility } from "../src/codex-compat";
import { workflowToolEnvironment } from "../src/codex-tool-environment";

describe("workflow build environment compatibility", () => {
  test("retains build/test variables while excluding runtime controls and credentials", () => {
    expect(
      workflowToolEnvironment({
        NODE_ENV: "test",
        CI: "true",
        SERVICE_URL: "http://localhost:8080",
        DATABASE_URL: "postgres://test:private@host/db",
        OPENAI_API_KEY: "private",
        GH_TOKEN: "private",
        ACTIONS_RUNTIME_TOKEN: "private",
        NODE_OPTIONS: "--import=untrusted",
        LD_PRELOAD: "untrusted",
        INPUT_SETTINGS: "{}",
      }),
    ).toEqual({
      NODE_ENV: "test",
      CI: "true",
      SERVICE_URL: "http://localhost:8080",
    });
  });
  test("excludes serialized and aliased credential values from ordinary environment", () => {
    const auth = "offline-authorization-value";
    expect(
      workflowToolEnvironment({
        AUTHORIZATION: auth,
        APP_CONFIG: JSON.stringify({ authorization: auth }),
        NODE_ENV: "test",
      }),
    ).toEqual({ NODE_ENV: "test" });
  });
  test("adapts nonsecret legacy settings.env and refuses auth/control overrides", async () => {
    const config = await resolveCompatibility(
      "",
      JSON.stringify({ env: { NODE_ENV: "production", APP_MODE: "fixture" } }),
      '{"mcpServers":{}}',
    );
    expect(config.toolEnvironment).toEqual({
      NODE_ENV: "production",
      APP_MODE: "fixture",
    });
    for (const name of [
      "OPENAI_API_KEY",
      "GH_TOKEN",
      "NODE_OPTIONS",
      "DATABASE_PASSWORD",
    ])
      await expect(
        resolveCompatibility(
          "",
          JSON.stringify({ env: { [name]: "private" } }),
          '{"mcpServers":{}}',
        ),
      ).rejects.toThrow("reserved or credential variable");
  });
});
