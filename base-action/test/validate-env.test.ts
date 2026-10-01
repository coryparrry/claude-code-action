import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { validateEnvironmentVariables } from "../src/validate-env";

describe("Codex authentication", () => {
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    process.env = savedEnv;
  });

  test.each([undefined, "", "  \n\t"])(
    "requires a non-empty OpenAI API key (%s)",
    (value) => {
      if (value === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = value;
      expect(validateEnvironmentVariables).toThrow(
        "OPENAI_API_KEY is required",
      );
    },
  );

  test("accepts an OpenAI API key", () => {
    process.env.OPENAI_API_KEY = "offline-fake-key";
    expect(validateEnvironmentVariables).not.toThrow();
  });

  test("does not accept credentials for the removed provider", () => {
    process.env.ANTHROPIC_API_KEY = "offline-fake-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "offline-fake-token";
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    expect(validateEnvironmentVariables).toThrow("OPENAI_API_KEY is required");
  });
});
