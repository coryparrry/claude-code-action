import { expect, test } from "bun:test";
import { normalizeLabel } from "./normalize";

test("normalizes present and absent labels", () => {
  expect(normalizeLabel(" Ready ")).toBe("ready");
  expect(normalizeLabel(null)).toBe("");
});
