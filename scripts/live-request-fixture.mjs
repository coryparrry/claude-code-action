import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
const repo = process.env.GITHUB_REPOSITORY;
const root = `repos/${repo}`;
const number = Number(process.env.LIVE_PR);
const temp = process.env.RUNNER_TEMP;
const api = (path, args = []) =>
  JSON.parse(
    execFileSync("gh", ["api", `${root}/${path}`, ...args], {
      encoding: "utf8",
    }),
  );
const mode = process.argv[2];
if (mode === "prepare") {
  const repository = JSON.parse(
    execFileSync("gh", ["api", root], { encoding: "utf8" }),
  );
  const sender = JSON.parse(
    execFileSync("gh", ["api", "users/coryparrry"], { encoding: "utf8" }),
  );
  const pull_request = api(`pulls/${number}`);
  const issue = api(`issues/${number}`);
  const diagnosis = api(`issues/${number}/comments`).find((c) =>
    c.body.includes("/verify-codex diagnose"),
  );
  const reply = api(`pulls/${number}/comments`).find((c) =>
    c.body.includes("/verify-codex fix this"),
  );
  assert(diagnosis && reply, "Both authorized fixture requests must exist");
  const common = { repository, sender };
  const events = {
    diagnosis: { ...common, action: "created", issue, comment: diagnosis },
    inline: { ...common, action: "created", pull_request, comment: reply },
    issue: { ...common, action: "opened", issue: api("issues/8") },
  };
  for (const [name, event] of Object.entries(events))
    writeFileSync(join(temp, `live-${name}.json`), JSON.stringify(event));
  console.log(
    JSON.stringify({
      fixture_pr: number,
      source_sha: pull_request.head.sha,
      issue: 8,
      parent: reply.in_reply_to_id,
    }),
  );
} else {
  assert.equal(
    process.env.LIVE_CONCLUSION,
    "success",
    "The composite action must finish successfully",
  );
  const report = JSON.parse(readFileSync(process.env.LIVE_REPORT, "utf8"));
  assert.equal(report.model, "gpt-6.1-terra");
  copyFileSync(process.env.LIVE_REPORT, join(temp, `live-${mode}-report.json`));
  if (mode === "issue") {
    const branch = process.env.LIVE_BRANCH;
    assert(branch && branch !== "codex/requested-change-workflows");
    const file = api("contents/test/fixtures/live-request/issue-result.txt", [
      "-X",
      "GET",
      "-f",
      `ref=${branch}`,
    ]);
    assert.equal(
      Buffer.from(file.content, "base64").toString(),
      "issue-handoff-terra-max-20261031\n",
    );
    const comments = api("issues/8/comments");
    assert(
      comments.some(
        (c) => c.body.includes("Create a PR") && c.body.includes(branch),
      ),
      "Issue must receive a branch-specific PR creation handoff",
    );
    writeFileSync(join(temp, "live-issue-branch.txt"), branch);
    console.log(
      JSON.stringify({ scenario: mode, branch, model: report.model }),
    );
  } else if (mode === "diagnosis") {
    const comments = api(`issues/${number}/comments`);
    assert(
      comments.some(
        (c) =>
          /normalizeLabel/.test(c.body) &&
          /null/.test(c.body) &&
          /actions\/runs\//.test(c.body),
      ),
      "Diagnosis must cite the observed failing code and a run",
    );
    console.log(
      JSON.stringify({
        scenario: mode,
        head_sha: api(`pulls/${number}`).head.sha,
        model: report.model,
      }),
    );
  } else if (mode === "inline") {
    execFileSync(
      "bun",
      ["--no-env-file", "test", "test/fixtures/live-request/normalize.test.ts"],
      { stdio: "inherit" },
    );
    const pull = api(`pulls/${number}`);
    const file = api("contents/test/fixtures/live-request/normalize.ts", [
      "-X",
      "GET",
      "-f",
      `ref=${pull.head.sha}`,
    ]);
    assert(
      !Buffer.from(file.content, "base64").toString().includes("value!.trim()"),
    );
    console.log(
      JSON.stringify({
        scenario: mode,
        pushed_sha: pull.head.sha,
        model: report.model,
      }),
    );
  }
}
