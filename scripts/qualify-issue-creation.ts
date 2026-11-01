/** Verify issue creation against GitHub; never execute this live harness locally. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

assert.equal(process.env.GITHUB_ACTIONS, "true");
const repository = process.env.GITHUB_REPOSITORY!;
const title = process.env.ISSUE_TEST_TITLE!;
const body = process.env.ISSUE_TEST_BODY!;
const mode = process.argv[2];

/** Access only this runner's GitHub repository without logging credentials. */
async function api(path: string, method = "GET", data?: unknown) {
  const response = await fetch(
    `${process.env.GITHUB_API_URL}/repos/${repository}/${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        ...(data ? { "Content-Type": "application/json" } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    },
  );
  assert.ok(
    response.ok,
    `GitHub qualification request failed: ${response.status}`,
  );
  return response.status === 204
    ? undefined
    : (response.json() as Promise<any>);
}

/** Find only this run's issue, including closed records, for assertions and cleanup. */
async function issues() {
  return (
    await api("issues?state=all&sort=created&direction=desc&per_page=100")
  ).filter(
    (issue: any) =>
      !issue.pull_request && issue.title === title && issue.body === body,
  );
}

if (mode === "denied") {
  const client = new Client({ name: "live-issue-permissions", version: "1" });
  const [owner, repo] = repository.split("/");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "../src/mcp/github-issues-server.ts")],
    stderr: "pipe",
    env: {
      PATH: process.env.PATH!,
      GITHUB_TOKEN: process.env.GH_TOKEN!,
      REPO_OWNER: owner!,
      REPO_NAME: repo!,
      GITHUB_API_URL: process.env.GITHUB_API_URL!,
    },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "create_issue",
      arguments: { title, body },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /issues: write/);
    assert.equal(
      (await issues()).length,
      0,
      "A read-only token must not create an issue",
    );
    console.log("Live GitHub permission denial passed");
  } finally {
    await client.close();
    await transport.close();
  }
} else if (mode === "verify") {
  assert.equal(process.env.ACTION_CONCLUSION, "success");
  const report = JSON.parse(
    await readFile(process.env.EXECUTION_REPORT!, "utf8"),
  );
  const calls = report
    .flatMap((entry: any) => entry.message?.content ?? [])
    .filter(
      (item: any) =>
        item.type === "tool_use" &&
        item.name === "mcp__github_issues__create_issue",
    );
  assert.equal(
    calls.length,
    2,
    "The model must really call the new tool twice",
  );
  const matches = await issues();
  assert.equal(
    matches.length,
    1,
    "Identical tool calls must create exactly one actual issue",
  );
  const issue = matches[0];
  assert.equal(issue.user.login, "github-actions[bot]");
  assert.ok(
    issue.html_url.startsWith(`https://github.com/${repository}/issues/`),
  );
  const results = report
    .flatMap((entry: any) => entry.message?.content ?? [])
    .filter(
      (item: any) =>
        item.type === "tool_result" &&
        calls.some((call: any) => call.id === item.tool_use_id),
    );
  assert.equal(results.length, 2);
  for (const result of results)
    assert.equal(JSON.parse(result.content).url, issue.html_url);
  const tracking = await api(
    `issues/comments/${process.env.TRACKING_COMMENT_ID}`,
  );
  assert.ok(
    tracking.body.includes(issue.html_url),
    "The user must receive the actual created issue URL",
  );
  const pull = await api(`pulls/${process.env.QUALIFICATION_PR}`);
  assert.equal(
    pull.head.sha,
    process.env.QUALIFICATION_HEAD,
    "Creating an issue must not edit the PR",
  );
  await writeFile(
    `${process.env.RUNNER_TEMP}/issue-creation-evidence.json`,
    JSON.stringify(
      {
        repository,
        issue: issue.html_url,
        number: issue.number,
        toolCalls: calls.length,
        actualIssues: matches.length,
        headUnchanged: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      issue: issue.html_url,
      toolCalls: calls.length,
      actualIssues: matches.length,
    }),
  );
} else if (mode === "cleanup") {
  for (const issue of await issues()) {
    assert.equal(issue.user.login, "github-actions[bot]");
    await api(`issues/${issue.number}`, "PATCH", { state: "closed" });
    console.log(`Closed qualification issue #${issue.number}`);
  }
} else throw new Error("Unknown qualification mode");
