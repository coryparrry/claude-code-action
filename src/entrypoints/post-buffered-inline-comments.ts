#!/usr/bin/env bun
/** Posts queued inline comments, discarding calls explicitly marked confirmed=false. */
import { readFileSync } from "fs";
import { createOctokit } from "../github/api/client";
import { redactSecrets } from "../github/utils/sanitizer";

const BUFFER_PATH = "/tmp/inline-comments-buffer.jsonl";

type BufferedComment = {
  ts: string;
  path: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  commit_id?: string;
  body: string;
  confirmed?: boolean;
};

async function postComment(
  octokit: ReturnType<typeof createOctokit>["rest"],
  owner: string,
  repo: string,
  pull_number: number,
  headSha: string,
  c: BufferedComment,
): Promise<boolean> {
  const params: Parameters<typeof octokit.rest.pulls.createReviewComment>[0] = {
    owner,
    repo,
    pull_number,
    body: redactSecrets(c.body),
    path: c.path,
    side: c.side || "RIGHT",
    commit_id: c.commit_id || headSha,
  };
  if (c.startLine) {
    params.start_line = c.startLine;
    params.start_side = c.side || "RIGHT";
    params.line = c.line;
  } else {
    params.line = c.line;
  }
  try {
    await octokit.rest.pulls.createReviewComment(params);
    return true;
  } catch (e) {
    console.log(
      `  failed ${c.path}:${c.line}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

async function main() {
  let raw: string;
  try {
    raw = readFileSync(BUFFER_PATH, "utf8");
  } catch {
    console.log("No buffered inline comments");
    return;
  }

  const comments: BufferedComment[] = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (comments.length === 0) {
    console.log("No buffered inline comments");
    return;
  }

  console.log(`Found ${comments.length} buffered inline comment(s)`);

  const githubToken = process.env.GITHUB_TOKEN;
  const owner = process.env.REPO_OWNER;
  const repo = process.env.REPO_NAME;
  const prNumber = process.env.PR_NUMBER;

  if (!githubToken || !owner || !repo || !prNumber) {
    console.log(
      "::warning::Missing GITHUB_TOKEN/REPO_OWNER/REPO_NAME/PR_NUMBER — cannot post buffered comments",
    );
    return;
  }

  // Partition: confirmed=false are never posted; the rest are candidates
  const neverPost = comments.filter((c) => c.confirmed === false);
  const candidates = comments.filter((c) => c.confirmed !== false);

  if (neverPost.length > 0) {
    console.log(`  ${neverPost.length} with confirmed=false — not posting`);
  }

  if (candidates.length === 0) {
    return;
  }

  const toPost = candidates;

  const octokit = createOctokit(githubToken).rest;
  const pull_number = parseInt(prNumber, 10);
  const pr = await octokit.pulls.get({ owner, repo, pull_number });
  const headSha = pr.data.head.sha;

  console.log(`Posting ${toPost.length} buffered comment(s)`);
  let posted = 0;
  for (const c of toPost) {
    if (await postComment(octokit, owner, repo, pull_number, headSha, c)) {
      console.log(`  posted ${c.path}:${c.line}`);
      posted++;
    }
  }
  console.log(`Posted ${posted}/${toPost.length}`);
}

main().catch((e) => {
  console.error("post-buffered-inline-comments failed:", e);
  process.exit(1);
});
