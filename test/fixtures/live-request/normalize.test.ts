import { expect, test } from "bun:test";
import { normalizeLabel } from "./normalize";
test("normalizes labels including null", () => {
  expect(normalizeLabel("  hello  ")).toBe("hello");
  expect(normalizeLabel(null)).toBe("");
});
