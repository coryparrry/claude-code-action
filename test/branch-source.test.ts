import { expect, test } from "bun:test";
import { resolveBranchSourceSha } from "../src/mcp/branch-source";

test("API branch creation uses the prepared PR head without consulting a newer base", async () => {
  const head = "a".repeat(40);
  expect(
    await resolveBranchSourceSha(head, async () => {
      throw new Error("must not read base");
    }),
  ).toBe(head);
});
test("ordinary branches retain base resolution", async () => {
  expect(await resolveBranchSourceSha(undefined, async () => "base-sha")).toBe(
    "base-sha",
  );
});
test("invalid prepared heads fail before creating a branch", async () => {
  await expect(
    resolveBranchSourceSha("main", async () => "base-sha"),
  ).rejects.toThrow("Invalid prepared branch source SHA");
});
