import { expect, test } from "bun:test";
import { promptCacheSettings } from "../src/prompt-cache";

test("cache keys survive fresh runs and commits but separate repositories and phases", () => {
  const first = promptCacheSettings("owner/repo", "review");
  expect(first).toEqual(promptCacheSettings("owner/repo", "review"));
  expect(first.promptCacheOptions).toBeUndefined();
  expect(first.providerData?.prompt_cache_key).not.toBe(
    promptCacheSettings("other/repo", "review").providerData?.prompt_cache_key,
  );
  expect(first.providerData?.prompt_cache_key).not.toBe(
    promptCacheSettings("owner/repo", "verify").providerData?.prompt_cache_key,
  );
  expect(first.providerData?.prompt_cache_key).not.toContain("owner/repo");
  expect(
    promptCacheSettings("owner/repo", "review").promptCacheOptions,
  ).toBeUndefined();
});
