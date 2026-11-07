import { expect, test } from "bun:test";
import { actionRuntimeOptions } from "../src/entrypoints/runtime-options";

test("empty Actions inputs preserve argument and SDK defaults", () => {
  const options = actionRuntimeOptions({
    CODEX_MODEL: "",
    MAX_TURNS: "",
    MAX_BUDGET_USD: "",
    SETTING_SOURCES: "",
    CONTINUE_SESSION: "",
    PERMISSION_MODE: "",
  });
  expect(Object.values(options).every((value) => value === undefined)).toBe(
    true,
  );
});
test("explicit controls retain values and directory spaces", () => {
  expect(
    actionRuntimeOptions({
      MAX_TURNS: "7",
      SYSTEM_PROMPT: "higher priority",
      SETTING_SOURCES: "project,local",
      ADDITIONAL_DIRECTORIES: "/tmp/with spaces\n/tmp/other",
      CONTINUE_SESSION: "true",
    }),
  ).toMatchObject({
    maxTurns: "7",
    systemPrompt: "higher priority",
    settingSources: ["project", "local"],
    additionalDirectories: ["/tmp/with spaces", "/tmp/other"],
    continueSession: true,
  });
  expect(
    actionRuntimeOptions({ CONTINUE_SESSION: "false" }).continueSession,
  ).toBe(false);
  expect(() => actionRuntimeOptions({ CONTINUE_SESSION: "yes" })).toThrow(
    "true or false",
  );
});

test("routing JSON is passed intact from the main action", () => {
  const modelRouting = JSON.stringify({
    cheap_model: "chosen-small",
    strong_model: "chosen-large",
  });
  expect(
    actionRuntimeOptions({ MODEL_ROUTING: modelRouting }).modelRouting,
  ).toBe(modelRouting);
});

test("tracing is automatic unless the action input explicitly opts out", () => {
  expect(actionRuntimeOptions({}).tracingEnabled).toBeUndefined();
  expect(actionRuntimeOptions({ ENABLE_TRACING: "true" }).tracingEnabled).toBe(
    true,
  );
  expect(actionRuntimeOptions({ ENABLE_TRACING: "false" }).tracingEnabled).toBe(
    false,
  );
  expect(() => actionRuntimeOptions({ ENABLE_TRACING: "invalid" })).toThrow(
    "enable_tracing",
  );
});
