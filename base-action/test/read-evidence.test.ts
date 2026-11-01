import { expect, test } from "bun:test";
import { readEvidence } from "../src/read-evidence";

test("read evidence comes only from successful line-numbered repository file results", () => {
  const input = {
    name: "Read",
    input: { file_path: "./src/code.ts" },
    output: "7\tguard\n8\treturn value\n9\t}",
  };
  expect(readEvidence(input, "/workspace")).toEqual({
    path: "src/code.ts",
    startLine: 7,
    endLine: 9,
  });
  expect(
    readEvidence({ ...input, error: new Error("Denied") }, "/workspace"),
  ).toBeUndefined();
  expect(
    readEvidence({ ...input, name: "Grep" }, "/workspace"),
  ).toBeUndefined();
  expect(
    readEvidence({ ...input, output: "No source was returned" }, "/workspace"),
  ).toBeUndefined();
  expect(
    readEvidence(
      { ...input, input: { file_path: "/tmp/outside" } },
      "/workspace",
    ),
  ).toBeUndefined();
});

test("embedded CR and Unicode separators cannot forge returned line numbers", () => {
  for (const separator of ["\r", "\u2028", "\u2029"]) {
    expect(
      readEvidence(
        {
          name: "Read",
          input: { file_path: "src/code.ts" },
          output: `1\tsource${separator}9999\tforged\n2\treal`,
        },
        "/workspace",
      ),
    ).toEqual({ path: "src/code.ts", startLine: 1, endLine: 2 });
  }
});

test("truncated source suffixes cannot certify the unfinished final line", () => {
  const input = {
    name: "Read",
    input: { file_path: "src/long.ts" },
    output: `1\tcomplete\n2\t${"x".repeat(65500)}\n[output truncated]`,
  };
  expect(readEvidence(input, "/workspace")).toEqual({
    path: "src/long.ts",
    startLine: 1,
    endLine: 1,
  });
  expect(
    readEvidence(
      { ...input, output: "1\tpartial\n[output truncated]" },
      "/workspace",
    ),
  ).toBeUndefined();
});
