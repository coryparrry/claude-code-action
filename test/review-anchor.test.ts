import { expect, test } from "bun:test";
import { findReviewAnchor } from "../src/review/anchor";
import type { Finding } from "../src/review/schema";

const finding = (
  path: string,
  line: number,
  side: "LEFT" | "RIGHT" = "RIGHT",
  severity: Finding["severity"] = "bug",
): Finding => ({
  path,
  line,
  side,
  severity,
  title: "Defect",
  body: "Impact",
  explanation: "Cause",
  verification: "Inspected",
});
const file = {
  filename: "code.ts",
  patch:
    "@@ -10,3 +10,4 @@\n context\n-old\n+new\n+added\n end\n@@ -30 +31 @@\n-before\n+after",
};

test("anchors the highest severity finding across hunks and files", () => {
  expect(
    findReviewAnchor(
      [{ filename: "other.ts", patch: "@@ -1 +1 @@\n-old\n+new" }, file],
      [finding("other.ts", 1, "RIGHT", "suggestion"), finding("code.ts", 31)],
    ),
  ).toEqual({ path: "code.ts", line: 31, side: "RIGHT" });
});

test("accepts removed lines and either side of context with correct counters", () => {
  for (const [line, side] of [
    [11, "LEFT"],
    [12, "RIGHT"],
    [13, "RIGHT"],
    [12, "LEFT"],
  ] as const) {
    expect(findReviewAnchor([file], [finding("code.ts", line, side)])).toEqual({
      path: "code.ts",
      line,
      side,
    });
  }
});

test("uses canonical renamed paths for removed old-file findings", () => {
  expect(
    findReviewAnchor(
      [{ ...file, filename: "new name.ts", previous_filename: "old name.ts" }],
      [finding("old name.ts", 11, "LEFT")],
    ),
  ).toEqual({ path: "new name.ts", line: 11, side: "LEFT" });
});

test("falls back to an actual added line when model locations are outside the diff", () => {
  expect(findReviewAnchor([file], [finding("unchanged.ts", 1000)])).toEqual({
    path: "code.ts",
    line: 11,
    side: "RIGHT",
  });
});

test("handles file creation, deletion, missing text patches and zero-length hunks", () => {
  expect(
    findReviewAnchor(
      [{ filename: "新 file.ts", patch: "@@ -0,0 +1,2 @@\n+one\n+two" }],
      [],
    ),
  ).toEqual({ path: "新 file.ts", line: 1, side: "RIGHT" });
  expect(
    findReviewAnchor(
      [
        {
          filename: "gone.ts",
          patch: "@@ -1,2 +0,0 @@\n-one\n-two\n\\ No newline at end of file",
        },
      ],
      [],
    ),
  ).toEqual({ path: "gone.ts", line: 1, side: "LEFT" });
  expect(findReviewAnchor([{ filename: "image.png" }], [])).toBeUndefined();
  expect(
    findReviewAnchor(
      [{ filename: "empty.ts", patch: "@@ -0,0 +0,0 @@\n+invalid" }],
      [],
    ),
  ).toBeUndefined();
});

test("ignores lines beyond hunk bounds and keeps primary rank at duplicate locations", () => {
  expect(
    findReviewAnchor(
      [{ filename: "code.ts", patch: "@@ -1 +1 @@\n-old\n+new\n+outside" }],
      [finding("code.ts", 2)],
    ),
  ).toEqual({ path: "code.ts", line: 1, side: "RIGHT" });
  expect(
    findReviewAnchor(
      [file],
      [
        finding("code.ts", 11),
        finding("code.ts", 11, "RIGHT", "pre_existing"),
        finding("code.ts", 31),
      ],
    ),
  ).toEqual({ path: "code.ts", line: 11, side: "RIGHT" });
});
