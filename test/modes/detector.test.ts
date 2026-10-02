import { describe, expect, it } from "bun:test";
import { detectMode } from "../../src/modes/detector";
import type { GitHubContext } from "../../src/github/context";
import { checkContainsTrigger } from "../../src/github/validation/trigger";

describe("detectMode with enhanced routing", () => {
  const baseContext = {
    runId: "test-run",
    eventAction: "opened",
    repository: {
      owner: "test-owner",
      repo: "test-repo",
      full_name: "test-owner/test-repo",
    },
    actor: "test-user",
    inputs: {
      prompt: "",
      triggerPhrase: "@claude",
      assigneeTrigger: "",
      labelTrigger: "",
      branchPrefix: "claude/",
      useStickyComment: false,
      bufferInlineComments: true,
      classifyInlineComments: true,
      useCommitSigning: false,
      sshSigningKey: "",
      botId: "123456",
      botName: "claude-bot",
      allowedBots: "",
      allowedNonWriteUsers: "",
      trackProgress: false,
      includeFixLinks: false,
      includeCommentsByActor: "",
      excludeCommentsByActor: "",
    },
  };

  describe("PR Events with track_progress", () => {
    it("should use tag mode when track_progress is true for pull_request.opened", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "pull_request",
        eventAction: "opened",
        payload: { pull_request: { number: 1 } } as any,
        entityNumber: 1,
        isPR: true,
        inputs: { ...baseContext.inputs, trackProgress: true },
      };

      expect(detectMode(context)).toBe("tag");
    });

    it("should use tag mode when track_progress is true for pull_request.synchronize", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "pull_request",
        eventAction: "synchronize",
        payload: { pull_request: { number: 1 } } as any,
        entityNumber: 1,
        isPR: true,
        inputs: { ...baseContext.inputs, trackProgress: true },
      };

      expect(detectMode(context)).toBe("tag");
    });

    it("should use agent mode when track_progress is false for pull_request.opened", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "pull_request",
        eventAction: "opened",
        payload: { pull_request: { number: 1 } } as any,
        entityNumber: 1,
        isPR: true,
        inputs: { ...baseContext.inputs, trackProgress: false },
      };

      expect(detectMode(context)).toBe("agent");
    });

    it("should use tag mode when track_progress is true for pull_request.labeled", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "pull_request",
        eventAction: "labeled",
        payload: { pull_request: { number: 1 } } as any,
        entityNumber: 1,
        isPR: true,
        inputs: { ...baseContext.inputs, trackProgress: true },
      };

      expect(detectMode(context)).toBe("tag");
    });

    it("should throw error when track_progress is used with unsupported PR action", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "pull_request",
        eventAction: "closed",
        payload: { pull_request: { number: 1 } } as any,
        entityNumber: 1,
        isPR: true,
        inputs: { ...baseContext.inputs, trackProgress: true },
      };

      expect(() => detectMode(context)).toThrow(
        /track_progress for pull_request events is only supported for actions/,
      );
    });
  });

  describe("Issue Events with track_progress", () => {
    it("should use tag mode when track_progress is true for issues.opened", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "issues",
        eventAction: "opened",
        payload: { issue: { number: 1, body: "Test" } } as any,
        entityNumber: 1,
        isPR: false,
        inputs: { ...baseContext.inputs, trackProgress: true },
      };

      expect(detectMode(context)).toBe("tag");
    });

    it("should use agent mode when track_progress is false for issues", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "issues",
        eventAction: "opened",
        payload: { issue: { number: 1, body: "Test" } } as any,
        entityNumber: 1,
        isPR: false,
        inputs: { ...baseContext.inputs, trackProgress: false },
      };

      expect(detectMode(context)).toBe("agent");
    });

    it("should use agent mode for issues with explicit prompt", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "issues",
        eventAction: "opened",
        payload: { issue: { number: 1, body: "Test issue" } } as any,
        entityNumber: 1,
        isPR: false,
        inputs: { ...baseContext.inputs, prompt: "Analyze this issue" },
      };

      expect(detectMode(context)).toBe("agent");
    });

    it("should use tag mode for issues with @claude mention and no prompt", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "issues",
        eventAction: "opened",
        payload: { issue: { number: 1, body: "@claude help" } } as any,
        entityNumber: 1,
        isPR: false,
      };

      expect(detectMode(context)).toBe("tag");
    });
  });

  describe("Comment Events (unchanged behavior)", () => {
    it("should use tag mode for issue_comment with @claude mention", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "issue_comment",
        payload: {
          issue: { number: 1, body: "Test" },
          comment: { body: "@claude help" },
        } as any,
        entityNumber: 1,
        isPR: false,
      };

      expect(detectMode(context)).toBe("tag");
    });

    it("should use agent mode for issue_comment with prompt provided", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "issue_comment",
        payload: {
          issue: { number: 1, body: "Test" },
          comment: { body: "@claude help" },
        } as any,
        entityNumber: 1,
        isPR: false,
        inputs: { ...baseContext.inputs, prompt: "Review this PR" },
      };

      expect(detectMode(context)).toBe("agent");
    });

    it("should use tag mode for PR review comments with @claude mention", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "pull_request_review_comment",
        payload: {
          pull_request: { number: 1, body: "Test" },
          comment: { body: "@claude check this" },
        } as any,
        entityNumber: 1,
        isPR: true,
      };

      expect(detectMode(context)).toBe("tag");
    });
  });

  describe("Automation Events (should error with track_progress)", () => {
    it("should throw error when track_progress is used with workflow_dispatch", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "workflow_dispatch",
        payload: {} as any,
        inputs: { ...baseContext.inputs, trackProgress: true },
      };

      expect(() => detectMode(context)).toThrow(
        /track_progress is only supported /,
      );
    });

    it("should use agent mode for workflow_dispatch without track_progress", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "workflow_dispatch",
        payload: {} as any,
        inputs: { ...baseContext.inputs, prompt: "Run workflow" },
      };

      expect(detectMode(context)).toBe("agent");
    });
  });

  describe("Custom prompt injection in tag mode", () => {
    it("should use tag mode for PR events when both track_progress and prompt are provided", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "pull_request",
        eventAction: "opened",
        payload: { pull_request: { number: 1 } } as any,
        entityNumber: 1,
        isPR: true,
        inputs: {
          ...baseContext.inputs,
          trackProgress: true,
          prompt: "Review for security issues",
        },
      };

      expect(detectMode(context)).toBe("tag");
    });

    it("should use tag mode for issue events when both track_progress and prompt are provided", () => {
      const context: GitHubContext = {
        ...baseContext,
        eventName: "issues",
        eventAction: "opened",
        payload: { issue: { number: 1, body: "Test" } } as any,
        entityNumber: 1,
        isPR: false,
        inputs: {
          ...baseContext.inputs,
          trackProgress: true,
          prompt: "Analyze this issue",
        },
      };

      expect(detectMode(context)).toBe("tag");
    });
  });

  describe("generated workflow runtime routing", () => {
    it("triggers automatic PR review with a prompt and progress tracking", () => {
      const context = {
        ...baseContext,
        eventName: "pull_request",
        eventAction: "opened",
        payload: {
          action: "opened",
          pull_request: { number: 1, title: "Improve handling", body: "" },
        },
        entityNumber: 1,
        isPR: true,
        inputs: {
          ...baseContext.inputs,
          prompt: "Review this pull request for bugs and security issues.",
          triggerPhrase: "/codex",
          trackProgress: true,
        },
      } as unknown as GitHubContext;

      expect(detectMode(context)).toBe("tag");
      expect(checkContainsTrigger(context as any)).toBe(true);
    });

    it.each([
      {
        eventName: "issues",
        eventAction: "opened",
        payload: {
          action: "opened",
          issue: { number: 1, title: "Help", body: "/codex fix this" },
        },
        isPR: false,
      },
      {
        eventName: "issue_comment",
        eventAction: "created",
        payload: {
          action: "created",
          issue: { number: 1 },
          comment: { body: "/codex fix this" },
        },
        isPR: false,
      },
      {
        eventName: "pull_request_review_comment",
        eventAction: "created",
        payload: {
          action: "created",
          pull_request: { number: 1 },
          comment: { body: "/codex fix this" },
        },
        isPR: true,
      },
      {
        eventName: "pull_request_review",
        eventAction: "submitted",
        payload: {
          action: "submitted",
          pull_request: { number: 1 },
          review: { body: "/codex fix this", state: "commented" },
        },
        isPR: true,
      },
    ] as const)(
      "routes triggered $eventName commands with progress and no prompt",
      (event) => {
        const context = {
          ...baseContext,
          ...event,
          entityNumber: 1,
          inputs: {
            ...baseContext.inputs,
            prompt: "",
            triggerPhrase: "/codex",
            trackProgress: true,
          },
        } as unknown as GitHubContext;

        expect(detectMode(context)).toBe("tag");
        expect(checkContainsTrigger(context as any)).toBe(true);
      },
    );
  });
});
