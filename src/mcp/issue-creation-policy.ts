import type { GitHubContext } from "../github/context";
import { toolMatchesRule } from "../../base-action/src/agent-permissions";

/** Preserve explicit scopes and default only to requests authored by the checked actor. */
export function issueCreationGrants(
  context: GitHubContext,
  mode: "tag" | "agent",
  allowedTools: string[],
): string[] {
  const tool = "mcp__github_issues__create_issue";
  const payload = context.payload;
  if (
    [
      "issue_comment",
      "pull_request_review_comment",
      "pull_request_review",
    ].includes(context.eventName)
  ) {
    const author =
      "comment" in payload
        ? payload.comment?.user?.login
        : "review" in payload
          ? payload.review?.user?.login
          : undefined;
    const actions =
      context.eventName === "pull_request_review"
        ? ["submitted", "edited"]
        : ["created", "edited"];
    if (
      !actions.includes(context.eventAction ?? "") ||
      !author ||
      author !== context.actor
    )
      return [];
  }
  const grants = allowedTools.filter((rule) => toolMatchesRule(tool, rule));
  if (grants.length) return grants;
  if (mode !== "tag" || context.inputs.prompt) return [];
  if (
    [
      "issue_comment",
      "pull_request_review_comment",
      "pull_request_review",
    ].includes(context.eventName)
  )
    return [tool];
  if (
    context.eventName === "issues" &&
    context.eventAction === "opened" &&
    "issue" in payload &&
    payload.issue?.user?.login === context.actor
  )
    return [tool];
  return [];
}

/** Whether a trusted request or explicit workflow grant can install the scoped server. */
export function issueCreationAllowed(
  context: GitHubContext,
  mode: "tag" | "agent",
  allowedTools: string[],
): boolean {
  return issueCreationGrants(context, mode, allowedTools).length > 0;
}
