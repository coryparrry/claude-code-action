import type { GitHubContext } from "../github/context";
import { toolMatchesRule } from "../../base-action/src/agent-permissions";

/** Restrict default creation to interactive requests; automation must explicitly opt in. */
export function issueCreationAllowed(
  context: GitHubContext,
  mode: "tag" | "agent",
  allowedTools: string[],
): boolean {
  if (
    allowedTools.some((rule) =>
      toolMatchesRule("mcp__github_issues__create_issue", rule),
    )
  )
    return true;
  if (mode !== "tag" || context.inputs.prompt) return false;
  return (
    [
      "issue_comment",
      "pull_request_review_comment",
      "pull_request_review",
    ].includes(context.eventName) ||
    (context.eventName === "issues" && context.eventAction === "opened")
  );
}
