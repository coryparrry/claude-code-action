import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { setupGitHubToken } from "../src/github/token";

describe("GitHub token authentication", () => {
  let originalToken: string | undefined;
  let originalOverride: string | undefined;
  let secretSpy: ReturnType<typeof spyOn>;
  let oidcSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    originalToken = process.env.GITHUB_TOKEN;
    originalOverride = process.env.OVERRIDE_GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.OVERRIDE_GITHUB_TOKEN;
    secretSpy = spyOn(core, "setSecret").mockImplementation(() => {});
    oidcSpy = spyOn(core, "getIDToken").mockRejectedValue(
      new Error("OIDC must not be called"),
    );
    fetchSpy = spyOn(global, "fetch").mockRejectedValue(
      new Error("No external token exchange"),
    );
  });
  afterEach(() => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    if (originalOverride === undefined)
      delete process.env.OVERRIDE_GITHUB_TOKEN;
    else process.env.OVERRIDE_GITHUB_TOKEN = originalOverride;
    expect(oidcSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    secretSpy.mockRestore();
    oidcSpy.mockRestore();
    fetchSpy.mockRestore();
  });
  test("uses the workflow token and masks it", async () => {
    process.env.GITHUB_TOKEN = "workflow-token";
    expect(await setupGitHubToken()).toBe("workflow-token");
    expect(secretSpy).toHaveBeenCalledWith("workflow-token");
  });
  test("prefers the explicitly supplied GitHub token", async () => {
    process.env.GITHUB_TOKEN = "workflow-token";
    process.env.OVERRIDE_GITHUB_TOKEN = "custom-token";
    expect(await setupGitHubToken()).toBe("custom-token");
    expect(secretSpy).toHaveBeenCalledWith("custom-token");
  });
  for (const value of [undefined, "", "   "]) {
    test(`rejects a missing or blank GitHub token (${JSON.stringify(value)})`, async () => {
      if (value !== undefined) process.env.GITHUB_TOKEN = value;
      await expect(setupGitHubToken()).rejects.toThrow(
        "A GitHub token is required",
      );
      expect(secretSpy).not.toHaveBeenCalled();
    });
  }
});
