import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GITHUB_SERVER_URL } from "../api/config";

export type CreatedIssue = {
  owner: string;
  repo: string;
  number: number;
  url: string;
};

/** Allocate a fresh action-owned receipt outside the model's repository boundary. */
export function initializeIssueReceipts(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const file = join(
    mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "codex-created-issues-")),
    "receipts.jsonl",
  );
  writeFileSync(file, "", { mode: 0o600 });
  return file;
}

/** Persist each confirmed GitHub creation before returning control to the model. */
export function recordCreatedIssue(
  issue: CreatedIssue,
  file = process.env.CODEX_CREATED_ISSUES_RECEIPT,
): void {
  if (file) appendFileSync(file, JSON.stringify(issue) + "\n", { mode: 0o600 });
}

/** Read only confirmed, repository-matching issue URLs from this invocation's receipt. */
export function readCreatedIssues(
  owner: string,
  repo: string,
  file = process.env.CODEX_CREATED_ISSUES_RECEIPT,
): CreatedIssue[] {
  if (!file) return [];
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const issues = new Map<string, CreatedIssue>();
  for (const line of content.split("\n")) {
    try {
      const issue = JSON.parse(line) as CreatedIssue;
      const expected = `${GITHUB_SERVER_URL}/${owner}/${repo}/issues/${issue.number}`;
      if (
        issue.owner.toLowerCase() === owner.toLowerCase() &&
        issue.repo.toLowerCase() === repo.toLowerCase() &&
        Number.isSafeInteger(issue.number) &&
        issue.number > 0 &&
        typeof issue.url === "string" &&
        issue.url.toLowerCase() === expected.toLowerCase()
      )
        issues.set(issue.url, issue);
    } catch {
      /* Ignore incomplete or malformed receipt lines. */
    }
  }
  return [...issues.values()];
}

/** Keep confirmed URLs visible even when the model or final response fails. */
export function appendCreatedIssueFeedback(
  body: string,
  owner: string,
  repo: string,
  file = process.env.CODEX_CREATED_ISSUES_RECEIPT,
): string {
  const issues = readCreatedIssues(owner, repo, file);
  if (!issues.length) return body;
  const clean = body.replace(
    /\n*<!-- codex-created-issues -->[\s\S]*?<!-- \/codex-created-issues -->/g,
    "",
  );
  return `${clean}\n\n<!-- codex-created-issues -->\n### Created issues\n${issues.map((issue) => `- [#${issue.number}](${issue.url})`).join("\n")}\n<!-- /codex-created-issues -->`;
}
