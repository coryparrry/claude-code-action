import { getRuntimeInstructions } from "../../../create-prompt/runtime-instructions";
import { GITHUB_SERVER_URL } from "../../api/config";

export const SPINNER_HTML =
  '<img src="https://github.com/user-attachments/assets/5ac382c7-e004-429b-8e35-7feb3e8f9c6f" width="14px" height="14px" style="vertical-align: middle; margin-left: 4px;" />';
export const CODEX_COMMENT_MARKER = "<!-- codex-action:tracking -->";
export const INITIAL_PROGRESS_BODY = `- [ ] Read the request and repository context
- [ ] Work on the requested task
- [ ] Report results

<details open>
<summary>Preparing the task</summary>

Loading the request and repository context.

</details>`;

export function createJobRunLink(
  owner: string,
  repo: string,
  runId: string,
): string {
  const jobRunUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${runId}`;
  return `[View job run](${jobRunUrl})`;
}

/** Encode Git-ref path segments without turning `/` into `%2F`. */
export function encodeBranchNameForUrl(branchName: string): string {
  return branchName.split("/").map(encodeURIComponent).join("/");
}

export function createBranchLink(
  owner: string,
  repo: string,
  branchName: string,
): string {
  const branchUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/tree/${encodeBranchNameForUrl(branchName)}`;
  return `\n[View branch](${branchUrl})`;
}

export function createCommentBody(
  jobRunLink: string,
  branchLink: string = "",
): string {
  return `${getRuntimeInstructions().product} is working… ${SPINNER_HTML}

${INITIAL_PROGRESS_BODY}

${jobRunLink}${branchLink}\n\n${CODEX_COMMENT_MARKER}`;
}
