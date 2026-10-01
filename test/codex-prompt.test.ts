import { afterEach, describe, expect, test } from "bun:test";
import { generatePrompt, type PreparedContext } from "../src/create-prompt";
import type { FetchDataResult } from "../src/github/data/fetcher";
import { createCommentBody } from "../src/github/operations/comments/common";
import { updateCommentBody } from "../src/github/operations/comment-logic";
import { createMockContext } from "./mockContext";

const originalEngine = process.env.ACTION_ENGINE;
const originalSimple = process.env.USE_SIMPLE_PROMPT;
afterEach(() => {
  if (originalEngine === undefined) delete process.env.ACTION_ENGINE;
  else process.env.ACTION_ENGINE = originalEngine;
  if (originalSimple === undefined) delete process.env.USE_SIMPLE_PROMPT;
  else process.env.USE_SIMPLE_PROMPT = originalSimple;
});

const userText =
  "Keep Claude Code, CLAUDE.md, claude_args --allowedTools, /review-pr and https://claude.ai/code unchanged.";
const context: PreparedContext = {
  repository: "owner/repo",
  claudeCommentId: "123",
  triggerPhrase: "@codex",
  eventData: {
    eventName: "issue_comment",
    commentId: "456",
    isPR: false,
    issueNumber: "1",
    baseBranch: "main",
    claudeBranch: "codex/fix",
    commentBody: `@codex ${userText}`,
  },
  githubContext: createMockContext({ inputs: { prompt: userText } }),
};
const data: FetchDataResult = {
  contextData: {
    title: userText,
    body: userText,
    author: { login: "requester" },
    createdAt: "2026-09-30T00:00:00Z",
    state: "OPEN",
    labels: { nodes: [] },
    comments: { nodes: [] },
  },
  comments: [
    {
      id: "1",
      databaseId: "1",
      body: userText,
      author: null,
      createdAt: "2026-09-30T00:00:00Z",
    },
  ],
  changedFiles: [],
  changedFilesWithSHA: [],
  reviewData: null,
  imageUrlMap: new Map(),
};

function section(prompt: string, tag: string) {
  const result = prompt.split(`<${tag}>`)[1]?.split(`</${tag}>`)[0];
  if (result === undefined) throw new Error(`Missing prompt section: ${tag}`);
  return result;
}

describe("Codex action-owned instructions", () => {
  for (const simple of [false, true]) {
    test(`preserves user content and integrations in ${simple ? "simple" : "default"} tag prompt`, () => {
      process.env.USE_SIMPLE_PROMPT = String(simple);
      process.env.ACTION_ENGINE = "claude";
      const legacy = generatePrompt(context, data, true, "tag");
      process.env.ACTION_ENGINE = "codex";
      const prompt = generatePrompt(context, data, true, "tag");
      for (const tag of [
        simple ? "context" : "formatted_context",
        simple ? "issue_body" : "pr_or_issue_body",
        "comments",
        "trigger_comment",
        "custom_instructions",
      ]) {
        expect(section(prompt, tag)).toEqual(section(legacy, tag));
        expect(section(prompt, tag)).toContain(userText);
      }
      expect(prompt).toContain("mcp__github_comment__update_codex_comment");
      expect(prompt).toContain("mcp__github_file_ops__commit_files");
      expect(prompt).toContain("AGENTS.md");
      expect(prompt).not.toContain("ToolSearch");
      expect(prompt).not.toContain("unless explicitly allowed via claude_args");
      expect(prompt).not.toContain("user can update your `--allowedTools`");
      if (!simple) {
        expect(prompt).toStartWith("You are Codex");
        expect(prompt).toContain(
          "Generated with [Codex](https://developers.openai.com/codex)",
        );
      }
    });
  }

  test("uses shell commands without Claude Bash invocation syntax", () => {
    process.env.ACTION_ENGINE = "codex";
    delete process.env.USE_SIMPLE_PROMPT;
    const prompt = generatePrompt(context, data, false, "tag");
    expect(prompt).toContain("via the shell tool");
    expect(prompt).toContain("`git add <files>`");
    expect(prompt).not.toContain("Bash(");
  });

  test("agent mode returns the exact user prompt", () => {
    process.env.ACTION_ENGINE = "codex";
    expect(
      generatePrompt({ ...context, prompt: userText }, data, false, "agent"),
    ).toEqual(userText);
  });

  test("preserves fetched PR review and changed-file content and omits Claude fix links", () => {
    process.env.ACTION_ENGINE = "codex";
    delete process.env.USE_SIMPLE_PROMPT;
    const prContext: PreparedContext = {
      ...context,
      eventData: {
        eventName: "pull_request_review",
        isPR: true,
        prNumber: "1",
        baseBranch: "main",
        commentBody: userText,
      },
      githubContext: createMockContext(),
    };
    const prData: FetchDataResult = {
      ...data,
      contextData: {
        ...data.contextData,
        baseRefName: "main",
        headRefName: "claude/feature",
        headRefOid: "abc",
        isCrossRepository: false,
        headRepository: null,
        additions: 1,
        deletions: 0,
        commits: { totalCount: 1, nodes: [] },
        files: { nodes: [] },
      },
      changedFilesWithSHA: [
        {
          path: "CLAUDE.md",
          additions: 1,
          deletions: 0,
          changeType: "MODIFIED",
          sha: "abc",
        },
      ],
      reviewData: {
        nodes: [
          {
            id: "r",
            databaseId: "1",
            author: null,
            body: userText,
            state: "COMMENTED",
            submittedAt: "2026-09-30T00:00:00Z",
            comments: { nodes: [] },
          },
        ],
      },
    };
    const prompt = generatePrompt(prContext, prData, false, "tag");
    process.env.ACTION_ENGINE = "claude";
    const legacy = generatePrompt(prContext, prData, false, "tag");
    for (const tag of [
      "formatted_context",
      "pr_or_issue_body",
      "review_comments",
      "changed_files",
      "trigger_comment",
    ]) {
      expect(section(prompt, tag)).toEqual(section(legacy, tag));
    }
    expect(prompt).not.toContain("[Fix this →](https://claude.ai/code?q=");
    expect(legacy).not.toContain("[Fix this →](https://claude.ai/code?q=");
  });

  test("brands initial, final and failure comments without rewriting body content", () => {
    process.env.ACTION_ENGINE = "codex";
    const initial = createCommentBody(
      "[View job run](https://github.com/owner/repo/actions/runs/1)",
    );
    expect(initial).toStartWith("Codex is working…");
    for (const actionFailed of [false, true]) {
      const comment = updateCommentBody({
        currentBody: `${initial}\n\n${userText}`,
        actionFailed,
        executionDetails: null,
        jobUrl: "https://github.com/owner/repo/actions/runs/1",
        triggerUsername: "requester",
      });
      expect(comment).toStartWith(
        actionFailed
          ? "**Codex encountered an error**"
          : "**Codex finished @requester's task**",
      );
      expect(comment).not.toContain("Codex is working");
      expect(comment).toContain(userText);
    }
    delete process.env.ACTION_ENGINE;
    expect(createCommentBody("job")).toStartWith("Codex is working…");
    expect(
      updateCommentBody({
        currentBody: "done",
        actionFailed: false,
        executionDetails: null,
        jobUrl: "job",
        triggerUsername: "requester",
      }),
    ).toStartWith("**Codex finished @requester's task**");
  });
});
