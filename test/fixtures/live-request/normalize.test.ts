import { expect, test } from "bun:test";
import { normalizeLabel } from "./normalize";
test("normalizes null to an empty label", () => {
  expect(normalizeLabel(null)).toBe("");
});

test("trims surrounding whitespace without changing internal whitespace", () => {
  expect(normalizeLabel("  hello  ")).toBe("hello");
  expect(normalizeLabel("\t hello   world \n")).toBe("hello   world");
});

test("normalizes empty and whitespace-only labels", () => {
  expect(normalizeLabel("")).toBe("");
  expect(normalizeLabel(" \t\n ")).toBe("");
});

test("preserves labels that do not need trimming", () => {
  expect(normalizeLabel("hello")).toBe("hello");
});
