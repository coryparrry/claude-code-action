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

test("anchors each finding at its own file and hunk", () => {
  const files = [
    { filename: "other.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
    file,
  ];
  for (const item of [finding("other.ts", 1), finding("code.ts", 31)])
    expect(findReviewAnchor(files, item)).toEqual({
      path: item.path,
      line: item.line,
      side: item.side,
    });
});

test("accepts removed lines and either side of context with correct counters", () => {
  for (const [line, side] of [
    [11, "LEFT"],
    [12, "RIGHT"],
    [13, "RIGHT"],
    [12, "LEFT"],
  ] as const) {
    expect(findReviewAnchor([file], finding("code.ts", line, side))).toEqual({
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
      finding("old name.ts", 11, "LEFT"),
    ),
  ).toEqual({ path: "new name.ts", line: 11, side: "LEFT" });
});

test("never substitutes another line or file for an invalid model location", () => {
  expect(
    findReviewAnchor([file], finding("unchanged.ts", 1000)),
  ).toBeUndefined();
  expect(findReviewAnchor([file], finding("code.ts", 1000))).toBeUndefined();
});

test("handles creation, deletion, missing patches and zero-length hunks", () => {
  expect(
    findReviewAnchor(
      [{ filename: "新 file.ts", patch: "@@ -0,0 +1,2 @@\n+one\n+two" }],
      finding("新 file.ts", 2),
    ),
  ).toEqual({ path: "新 file.ts", line: 2, side: "RIGHT" });
  expect(
    findReviewAnchor(
      [
        {
          filename: "gone.ts",
          patch: "@@ -1,2 +0,0 @@\n-one\n-two\n\\ No newline at end of file",
        },
      ],
      finding("gone.ts", 1, "LEFT"),
    ),
  ).toEqual({ path: "gone.ts", line: 1, side: "LEFT" });
  expect(
    findReviewAnchor([{ filename: "image.png" }], finding("image.png", 1)),
  ).toBeUndefined();
  expect(
    findReviewAnchor(
      [{ filename: "empty.ts", patch: "@@ -0,0 +0,0 @@\n+invalid" }],
      finding("empty.ts", 1),
    ),
  ).toBeUndefined();
});

test("ignores lines beyond hunk bounds and wrong diff sides", () => {
  expect(
    findReviewAnchor(
      [{ filename: "code.ts", patch: "@@ -1 +1 @@\n-old\n+new\n+outside" }],
      finding("code.ts", 2),
    ),
  ).toBeUndefined();
  expect(
    findReviewAnchor([file], finding("code.ts", 30, "RIGHT")),
  ).toBeUndefined();
  expect(
    findReviewAnchor([file], finding("code.ts", 31, "LEFT")),
  ).toBeUndefined();
});
