import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import * as core from "@actions/core";
import { checkWritePermissions } from "../src/github/validation/permissions";
import type { ParsedGitHubContext } from "../src/github/context";
import {
  GITHUB_ACTIONS_BOT_ID,
  GITHUB_ACTIONS_BOT_LOGIN,
} from "../src/github/constants";
import { createMockAutomationContext } from "./mockContext";

describe("checkWritePermissions", () => {
  let coreInfoSpy: any;
  let coreWarningSpy: any;
  let coreErrorSpy: any;

  beforeEach(() => {
    // Spy on core methods
    coreInfoSpy = spyOn(core, "info").mockImplementation(() => {});
    coreWarningSpy = spyOn(core, "warning").mockImplementation(() => {});
    coreErrorSpy = spyOn(core, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    coreInfoSpy.mockRestore();
    coreWarningSpy.mockRestore();
    coreErrorSpy.mockRestore();
  });

  const createMockOctokit = (permission: string) => {
    return {
      repos: {
        getCollaboratorPermissionLevel: async () => ({
          data: { permission },
        }),
      },
    } as any;
  };

  const createContext = (): ParsedGitHubContext => ({
    runId: "1234567890",
    eventName: "issue_comment",
    eventAction: "created",
    repository: {
      full_name: "test-owner/test-repo",
      owner: "test-owner",
      repo: "test-repo",
    },
    actor: "test-user",
    payload: {
      action: "created",
      issue: {
        number: 1,
        title: "Test Issue",
        body: "Test body",
        user: { login: "test-user" },
      },
      comment: {
        id: 123,
        body: "@claude test",
        user: { login: "test-user" },
        html_url:
          "https://github.com/test-owner/test-repo/issues/1#issuecomment-123",
      },
    } as any,
    entityNumber: 1,
    isPR: false,
    inputs: {
      prompt: "",
      triggerPhrase: "@claude",
      assigneeTrigger: "",
      labelTrigger: "",
      branchPrefix: "claude/",
      useStickyComment: false,
      bufferInlineComments: true,
      useCommitSigning: false,
      sshSigningKey: "",
      botId: String(GITHUB_ACTIONS_BOT_ID),
      botName: GITHUB_ACTIONS_BOT_LOGIN,
      allowedBots: "",
      trackProgress: false,
      includeCommentsByActor: "",
      excludeCommentsByActor: "",
    },
  });

  test("should return true for admin permissions", async () => {
    const mockOctokit = createMockOctokit("admin");
    const context = createContext();

    const result = await checkWritePermissions(mockOctokit, context);

    expect(result).toBe(true);
    expect(coreInfoSpy).toHaveBeenCalledWith(
      "Checking permissions for actor: test-user",
    );
    expect(coreInfoSpy).toHaveBeenCalledWith(
      "Permission level retrieved: admin",
    );
    expect(coreInfoSpy).toHaveBeenCalledWith("Actor has write access: admin");
  });

  test("should return true for write permissions", async () => {
    const mockOctokit = createMockOctokit("write");
    const context = createContext();

    const result = await checkWritePermissions(mockOctokit, context);

    expect(result).toBe(true);
    expect(coreInfoSpy).toHaveBeenCalledWith("Actor has write access: write");
  });

  test("should return false for read permissions", async () => {
    const mockOctokit = createMockOctokit("read");
    const context = createContext();

    const result = await checkWritePermissions(mockOctokit, context);

    expect(result).toBe(false);
    expect(coreWarningSpy).toHaveBeenCalledWith(
      "Actor has insufficient permissions: read",
    );
  });

  test("should return false for none permissions", async () => {
    const mockOctokit = createMockOctokit("none");
    const context = createContext();

    const result = await checkWritePermissions(mockOctokit, context);

    expect(result).toBe(false);
    expect(coreWarningSpy).toHaveBeenCalledWith(
      "Actor has insufficient permissions: none",
    );
  });

  test("should deny a bot without write permission", async () => {
    const mockOctokit = createMockOctokit("none");
    const context = createContext();
    context.actor = "test-bot[bot]";

    const result = await checkWritePermissions(mockOctokit, context);

    expect(result).toBe(false);
  });

  test("should throw error when permission check fails", async () => {
    const error = new Error("API error");
    const mockOctokit = {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          throw error;
        },
      },
    } as any;
    const context = createContext();

    await expect(checkWritePermissions(mockOctokit, context)).rejects.toThrow(
      "Failed to check permissions for test-user: Error: API error",
    );

    expect(coreErrorSpy).toHaveBeenCalledWith(
      "Failed to check permissions: Error: API error",
    );
  });

  test("should call API with correct parameters", async () => {
    let capturedParams: any;
    const mockOctokit = {
      repos: {
        getCollaboratorPermissionLevel: async (params: any) => {
          capturedParams = params;
          return { data: { permission: "write" } };
        },
      },
    } as any;
    const context = createContext();

    await checkWritePermissions(mockOctokit, context);

    expect(capturedParams).toEqual({
      owner: "test-owner",
      repo: "test-repo",
      username: "test-user",
    });
  });

  test("fails closed for a non-user actor even when allowed_bots permits it", async () => {
    const context = createContext();
    context.actor = "Copilot";
    context.inputs.allowedBots = "*";
    const octokit = {
      repos: {
        getCollaboratorPermissionLevel: async () => {
          throw new Error("Copilot is not a user");
        },
      },
    } as any;
    await expect(checkWritePermissions(octokit, context)).rejects.toThrow(
      "Failed to check permissions for Copilot",
    );
  });

  describe("allowed_bots only applies to non-user actors", () => {
    // The permission endpoint resolves the actor's account type. Actors
    // that resolve to a regular user account go through the standard write
    // permission check; allowed_bots does not short-circuit it for them.

    test("should require write permission for a user account whose name matches allowed_bots", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createContext();
      context.actor = "renovate";
      context.inputs.allowedBots = "renovate";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
      expect(coreWarningSpy).toHaveBeenCalledWith(
        "Actor has insufficient permissions: read",
      );
    });

    test("should require write permission for a user account when allowed_bots uses the [bot] form", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createContext();
      context.actor = "renovate";
      context.inputs.allowedBots = "renovate[bot]";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
    });

    test("should require write permission for a user account when allowed_bots is '*'", async () => {
      const mockOctokit = createMockOctokit("none");
      const context = createContext();
      context.actor = "some-user";
      context.inputs.allowedBots = "*";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
    });

    test("should still grant access for a user account with write permission", async () => {
      const mockOctokit = createMockOctokit("write");
      const context = createContext();
      context.actor = "renovate";
      context.inputs.allowedBots = "renovate";

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(true);
    });
  });

  describe("workflow_run contexts", () => {
    const createWorkflowRunContext = (
      actor: string,
      runActor: string = actor,
    ) =>
      createMockAutomationContext({
        eventName: "workflow_run",
        eventAction: "completed",
        actor,
        payload: {
          action: "completed",
          workflow_run: {
            id: 123,
            event: "pull_request",
            actor: { login: runActor },
            head_repository: { full_name: "fork-owner/test-repo" },
          },
        } as any,
      });

    const createMockOctokitWithLevels = (levels: Record<string, string>) =>
      ({
        repos: {
          getCollaboratorPermissionLevel: async (params: {
            username: string;
          }) => ({
            data: { permission: levels[params.username] ?? "none" },
          }),
        },
      }) as any;

    test("should return false when the run actor lacks write access", async () => {
      const mockOctokit = createMockOctokit("read");
      const context = createWorkflowRunContext("fork-contributor");

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
      expect(coreWarningSpy).toHaveBeenCalledWith(
        "Actor has insufficient permissions: read",
      );
    });

    test("should return true when the run actor has write access", async () => {
      const mockOctokit = createMockOctokit("write");
      const context = createWorkflowRunContext("maintainer");

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(true);
    });

    test("should return true when the run actor has admin access", async () => {
      const mockOctokit = createMockOctokit("admin");
      const context = createWorkflowRunContext("maintainer");

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(true);
    });

    test("should also check the payload run actor when it differs from the workflow actor", async () => {
      const mockOctokit = createMockOctokitWithLevels({
        maintainer: "write",
        "fork-contributor": "read",
      });
      const context = createWorkflowRunContext(
        "maintainer",
        "fork-contributor",
      );

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
      expect(coreInfoSpy).toHaveBeenCalledWith(
        "workflow_run was started by fork-contributor; checking permissions for that actor as well",
      );
    });

    test("should return true when both the workflow actor and run actor have write access", async () => {
      const mockOctokit = createMockOctokitWithLevels({
        maintainer: "write",
        "other-maintainer": "admin",
      });
      const context = createWorkflowRunContext(
        "maintainer",
        "other-maintainer",
      );

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(true);
    });

    test("should deny [bot] run actors without write access", async () => {
      const mockOctokit = createMockOctokit("none");
      const context = createWorkflowRunContext("dependabot[bot]");

      const result = await checkWritePermissions(mockOctokit, context);

      expect(result).toBe(false);
    });
  });
});
