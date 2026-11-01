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
