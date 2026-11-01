import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

const repo = process.env.GITHUB_REPOSITORY;
assert.equal(repo, "coryparrry/claude-code-action");
const root = `repos/${repo}`;
const number = Number(process.env.LIVE_PR);
const temp = process.env.RUNNER_TEMP;
const pin = "39cf9a682e1fc1fd562672af07a8bc8866643d2b";

/** Read only the disposable fixture's GitHub objects without printing credentials. */
function api(path, args = []) {
  return JSON.parse(
    execFileSync("gh", ["api", path ? `${root}/${path}` : root, ...args], {
      encoding: "utf8",
    }),
  );
}
/** Record trusted delivery values for the separate read-only validation jobs. */
function output(values) {
  for (const [key, value] of Object.entries(values))
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
/** Parse and preserve one real model report before a later action invocation replaces it. */
function report(mode, file = process.env.LIVE_REPORT) {
  assert.equal(
    process.env.LIVE_CONCLUSION,
    "success",
    "Composite action must succeed",
  );
  const records = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(
    records.find((item) => item.type === "system" && item.subtype === "init")
      ?.model,
    "gpt-6.1-terra",
  );
  copyFileSync(file, join(temp, `live-${mode}-report.json`));
  return records;
}
/** Identify the action-owned individual finding comments, retaining historical copies for counting. */
function findings() {
  return api(`pulls/${number}/comments`).filter(
    (comment) =>
      comment.user?.login === "github-actions[bot]" &&
      /<!-- codex-action:finding:[a-f0-9]{12} -->/.test(comment.body),
  );
}
/** Get actual tool names recorded by the runtime rather than model prose. */
function tools(records) {
  return records
    .flatMap((item) => item.message?.content || [])
    .filter((item) => item.type === "tool_use")
    .map((item) => item.name);
}

const mode = process.argv[2];
if (mode === "prepare") {
  copyFileSync(
    new URL(import.meta.url),
    join(temp, "live-request-fixture.mjs"),
  );
  const bun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(temp, "live-bun"),
    '#!/bin/sh\nexport GITHUB_EVENT_NAME="$LIVE_EVENT_NAME"\nexport GITHUB_EVENT_PATH="$LIVE_EVENT_PATH"\nexec "' +
      bun +
      '" "$@"\n',
    { mode: 0o700 },
  );
  const repository = api("");
  const sender = JSON.parse(
    execFileSync("gh", ["api", "users/coryparrry"], { encoding: "utf8" }),
  );
  const pull_request = api(`pulls/${number}`);
  assert.equal(
    pull_request.head.sha,
    process.env.LIVE_EXPECTED_SHA,
    "Do not test a stale event checkout",
  );
  const common = { repository, sender };
  const metadata = {
    head_sha: pull_request.head.sha,
    before_findings: findings().length,
  };
  writeFileSync(join(temp, "live-meta.json"), JSON.stringify(metadata));
  writeFileSync(
    join(temp, "live-review.json"),
    JSON.stringify({ ...common, action: "synchronize", number, pull_request }),
  );
  if (process.env.LIVE_PHASE === "commands") {
    const issue = api(`issues/${number}`);
    const diagnosis = api(`issues/${number}/comments`).findLast((comment) =>
      comment.body.includes("/verify-codex diagnose"),
    );
    const reply = api(`pulls/${number}/comments`).findLast(
      (comment) =>
        comment.in_reply_to_id &&
        comment.body.includes("/verify-codex fix this"),
    );
    assert(diagnosis && reply, "Authorized live requests must exist");
    for (const [name, event] of Object.entries({
      diagnosis: { ...common, action: "created", issue, comment: diagnosis },
      inline: { ...common, action: "created", pull_request, comment: reply },
      issue: { ...common, action: "opened", issue: api("issues/8") },
    }))
      writeFileSync(join(temp, `live-${name}.json`), JSON.stringify(event));
  }
  console.log(
    JSON.stringify({ fixture_pr: number, ...metadata, runtime: pin }),
  );
} else if (mode === "review") {
  const first = report("reviewer");
  const second = report("verifier", process.env.LIVE_VERIFIER_REPORT);
  const meta = JSON.parse(readFileSync(join(temp, "live-meta.json"), "utf8"));
  const current = api(`pulls/${number}`);
  assert.equal(current.head.sha, meta.head_sha);
  const last = second.findLast((item) => item.type === "result");
  assert.equal(last.structured_output.head_sha, meta.head_sha);
  assert(
    last.read_evidence?.some((read) => read.path === ".git/codex-review.diff"),
    "Verifier must actually read the prepared patch",
  );
  const currentFindings = findings();
  const expectedNew = process.env.LIVE_EXPECT_MEMORY === "true" ? 0 : 1;
  assert.equal(
    currentFindings.length - meta.before_findings,
    expectedNew,
    "Expected one real defect, then zero repeated flags",
  );
  if (expectedNew) {
    const finding = currentFindings.at(-1);
    assert.equal(finding.path, "test/fixtures/live-request/normalize.ts");
    assert(finding.body.includes("Confidence: high"));
    assert(last.read_evidence.some((read) => read.path === finding.path));
    output({ finding_id: finding.id });
  }
  const reviews = api(`pulls/${number}/reviews`).filter(
    (review) =>
      review.user?.login === "github-actions[bot]" &&
      review.body.includes("codex-action:review:"),
  );
  const active = reviews.filter(
    (review) => !review.body.startsWith("Superseded by"),
  );
  assert.equal(active.length, 1, "Only one full overview must remain");
  assert.equal(active[0].commit_id, meta.head_sha);
  console.log(
    JSON.stringify({
      scenario: expectedNew
        ? "verified-real-defect"
        : "durable-memory-no-repost",
      head_sha: meta.head_sha,
      new_inline: expectedNew,
      current_overviews: active.length,
      reviewer_turns: first.findLast((item) => item.type === "result")
        ?.num_turns,
      verifier_turns: last.num_turns,
    }),
  );
} else {
  const records = report(mode);
  if (mode === "diagnosis") {
    const body = api(`issues/comments/${process.env.LIVE_COMMENT}`).body;
    const metadata = JSON.parse(
      readFileSync(join(temp, "live-meta.json"), "utf8"),
    );
    assert(
      tools(records).includes("mcp__github_ci__download_job_log"),
      "Diagnosis must download actual failed-job evidence",
    );
    assert(
      JSON.stringify(records).includes("excerpt"),
      "Log evidence must be returned inline",
    );
    assert(
      /normalizeLabel/.test(body) &&
        /null/.test(body) &&
        /actions\/runs\//.test(body),
    );
    assert(
      body.includes(metadata.head_sha) ||
        body.includes(metadata.head_sha.slice(0, 7)),
      "Diagnosis must identify the current revision",
    );
    assert(
      !JSON.stringify(records).includes(
        "Path is outside permitted directories",
      ),
    );
    console.log(
      JSON.stringify({
        scenario: mode,
        head_sha: metadata.head_sha,
        comment: process.env.LIVE_COMMENT,
      }),
    );
  } else {
    const sha = process.env.LIVE_HEAD;
    assert(
      /^[a-f0-9]{40}$/.test(sha || ""),
      "Trusted delivery receipt must identify the push",
    );
    const branch = process.env.LIVE_BRANCH;
    assert.equal(api(`git/ref/heads/${branch}`).object.sha, sha);
    assert(tools(records).includes("mcp__github_git__push"));
    const path =
      mode === "inline"
        ? "test/fixtures/live-request/normalize.ts"
        : "test/fixtures/live-request/issue-result.txt";
    const file = api(`contents/${path}`, ["-X", "GET", "-f", `ref=${sha}`]);
    const content = Buffer.from(file.content, "base64").toString();
    if (mode === "inline") {
      assert.equal(api(`pulls/${number}`).head.sha, sha);
      assert(!content.includes("value!.trim()"));
    } else {
      assert.equal(content, "issue-handoff-terra-max-20261031\n");
      const comment = api(`issues/comments/${process.env.LIVE_COMMENT}`).body;
      assert(
        comment.includes("Create a PR") &&
          (comment.includes(branch) ||
            comment.includes(encodeURIComponent(branch))),
      );
    }
    output({ head_sha: sha, branch, comment_id: process.env.LIVE_COMMENT });
    console.log(
      JSON.stringify({
        scenario: mode,
        branch,
        pushed_sha: sha,
        comment: process.env.LIVE_COMMENT,
      }),
    );
  }
}
