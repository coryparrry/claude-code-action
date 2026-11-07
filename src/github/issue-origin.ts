/** Identify the producing workflow across refs without suppressing other automations. */
export function actionCreatedIssueMarker(
  workflowRef = process.env.GITHUB_WORKFLOW_REF ?? "",
): string {
  const separator = workflowRef.indexOf("@refs/");
  const workflow =
    separator < 0 ? workflowRef : workflowRef.slice(0, separator);
  return `<!-- codex-action:created-issue:v2:${Buffer.from(workflow).toString("base64url")} -->`;
}
