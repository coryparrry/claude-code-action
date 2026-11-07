#!/usr/bin/env bun

import * as core from "@actions/core";
import { actionCreatedIssueMarker } from "../issue-origin";
import {
  isIssuesEvent,
  isIssuesAssignedEvent,
  isIssueCommentEvent,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
} from "../context";
import type { GitHubContext, ParsedGitHubContext } from "../context";

/** Prevent self-triggering openings while preserving independent workflow automation. */
export function isActionCreatedIssueOpening(context: GitHubContext): boolean {
  return (
    !!process.env.GITHUB_WORKFLOW_REF &&
    isIssuesEvent(context) &&
    context.eventAction === "opened" &&
    context.payload.issue?.user?.type === "Bot" &&
    context.payload.issue.user.login === context.actor &&
    context.payload.issue.user.login === context.inputs.botName &&
    !!context.payload.issue.body?.startsWith(
      `${actionCreatedIssueMarker()}\n\n`,
    )
  );
}

/** Check command, assignee and label triggers for a GitHub entity event. */
export function checkContainsTrigger(context: ParsedGitHubContext): boolean {
  const {
    inputs: { assigneeTrigger, labelTrigger, triggerPhrase, prompt },
  } = context;

  if (isActionCreatedIssueOpening(context)) return false;

  // If prompt is provided, always trigger
  if (prompt) {
    console.log(`Prompt provided, triggering action`);
    return true;
  }

  // Check for assignee trigger
  if (isIssuesAssignedEvent(context)) {
    // Remove @ symbol from assignee_trigger if present
    let triggerUser = assigneeTrigger.replace(/^@/, "");
    const assigneeUsername = context.payload.assignee?.login || "";

    if (triggerUser && assigneeUsername === triggerUser) {
      console.log(`Issue assigned to trigger user '${triggerUser}'`);
      return true;
    }
  }

  // Check for label trigger
  if (isIssuesEvent(context) && context.eventAction === "labeled") {
    const labelName = (context.payload as any).label?.name || "";

    if (
      labelTrigger &&
      labelName.toLowerCase() === labelTrigger.toLowerCase()
    ) {
      console.log(`Issue labeled with trigger label '${labelTrigger}'`);
      return true;
    }
  }

  // Check for issue body and title trigger on issue creation
  if (isIssuesEvent(context) && context.eventAction === "opened") {
    const issueBody = context.payload.issue.body || "";
    const issueTitle = context.payload.issue.title || "";
    // Check for exact match with word boundaries or punctuation
    const regex = new RegExp(
      `(^|\\s)${escapeRegExp(triggerPhrase)}([\\s.,!?;:]|$)`,
      "i",
    );

    // Check in body
    if (regex.test(issueBody)) {
      console.log(
        `Issue body contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }

    // Check in title
    if (regex.test(issueTitle)) {
      console.log(
        `Issue title contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }
  }

  // Check for pull request body and title trigger
  if (isPullRequestEvent(context)) {
    const prBody = context.payload.pull_request.body || "";
    const prTitle = context.payload.pull_request.title || "";
    // Check for exact match with word boundaries or punctuation
    const regex = new RegExp(
      `(^|\\s)${escapeRegExp(triggerPhrase)}([\\s.,!?;:]|$)`,
      "i",
    );

    // Check in body
    if (regex.test(prBody)) {
      console.log(
        `Pull request body contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }

    // Check in title
    if (regex.test(prTitle)) {
      console.log(
        `Pull request title contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }
  }

  // Check for pull request review body trigger
  if (
    isPullRequestReviewEvent(context) &&
    (context.eventAction === "submitted" || context.eventAction === "edited")
  ) {
    const reviewBody = context.payload.review.body || "";
    // Check for exact match with word boundaries or punctuation
    const regex = new RegExp(
      `(^|\\s)${escapeRegExp(triggerPhrase)}([\\s.,!?;:]|$)`,
      "i",
    );
    if (regex.test(reviewBody)) {
      console.log(
        `Pull request review contains exact trigger phrase '${triggerPhrase}'`,
      );
      return true;
    }
  }

  // Check for comment trigger
  if (
    isIssueCommentEvent(context) ||
    isPullRequestReviewCommentEvent(context)
  ) {
    const commentBody = isIssueCommentEvent(context)
      ? context.payload.comment.body
      : context.payload.comment.body;
    // Check for exact match with word boundaries or punctuation
    const regex = new RegExp(
      `(^|\\s)${escapeRegExp(triggerPhrase)}([\\s.,!?;:]|$)`,
      "i",
    );
    if (regex.test(commentBody)) {
      console.log(`Comment contains exact trigger phrase '${triggerPhrase}'`);
      return true;
    }
  }

  console.log(`No trigger was met for ${triggerPhrase}`);

  return false;
}

export function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function checkTriggerAction(context: ParsedGitHubContext) {
  const containsTrigger = checkContainsTrigger(context);
  core.setOutput("contains_trigger", containsTrigger.toString());
  return containsTrigger;
}
