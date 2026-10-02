import { afterEach, describe, expect, test } from "bun:test";
import { collectActionInputsPresence } from "../src/entrypoints/collect-inputs";

const originalAllInputs = process.env.ALL_INPUTS;
afterEach(() => {
  if (originalAllInputs === undefined) delete process.env.ALL_INPUTS;
  else process.env.ALL_INPUTS = originalAllInputs;
});

describe("collectActionInputsPresence trigger default", () => {
  test("treats /codex as the default and legacy @codex as an explicit override", () => {
    process.env.ALL_INPUTS = JSON.stringify({ trigger_phrase: "/codex" });
    expect(JSON.parse(collectActionInputsPresence()).trigger_phrase).toBe(
      false,
    );

    process.env.ALL_INPUTS = JSON.stringify({ trigger_phrase: "@codex" });
    expect(JSON.parse(collectActionInputsPresence()).trigger_phrase).toBe(true);
  });
});
