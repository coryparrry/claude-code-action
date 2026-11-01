/** Verify issue creation against GitHub; never execute this live harness locally. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
async function issues(cleanup = false) {
  const urls = [
    process.env.CREATED_ISSUE_URLS,
    process.env.FAILED_CREATED_ISSUE_URLS,
  ].flatMap((value) => (value ? (JSON.parse(value) as string[]) : []));
  const records = new Map<number, any>();
  for (const url of urls) {
    const prefix = `https://github.com/${repository}/issues/`;
    assert.ok(typeof url === "string" && url.startsWith(prefix));
    const number = Number(url.slice(prefix.length));
    assert.ok(Number.isSafeInteger(number) && number > 0);
    const issue = await api(`issues/${number}`);
    assert.equal(issue.html_url, url);
    records.set(issue.number, issue);
  }
  if (cleanup || !urls.length) {
    for (const issue of await api(
      "issues?state=all&sort=created&direction=desc&per_page=100",
    ))
      records.set(issue.number, issue);
  }
  return selectQualificationIssues(
    [...records.values()],
    title,
    body,
    urls,
    cleanup,
  );
}

/** Select verified fixtures; cleanup also accepts receipt-owned URLs or the exact run title. */
export function selectQualificationIssues(
  all: any[],
  expectedTitle: string,
  expectedBody: string,
  receiptUrls: string[] = [],
  cleanup = false,
): any[] {
  return all.filter(
    (issue) =>
      !issue.pull_request &&
      (cleanup
        ? issue.user?.login === "github-actions[bot]" &&
          (issue.title === expectedTitle ||
            issue.title === `${expectedTitle} (expected agent failure)` ||
            receiptUrls.includes(issue.html_url))
        : issue.title === expectedTitle && issue.body === expectedBody),
  );
}

if (import.meta.main) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
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
  } else if (mode === "verify" || mode === "verify-failure") {
    const success = mode === "verify";
    assert.equal(
      process.env.ACTION_CONCLUSION,
      success ? "success" : "failure",
    );
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
      success ? 2 : 1,
      "The model must really call the new tool twice",
    );
    assert.equal(report.at(-1).is_error, !success);
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
    assert.equal(results.length, success ? 2 : 1);
    for (const result of results) {
      const envelope = JSON.parse(result.content);
      assert.notEqual(envelope.isError, true);
      const text = envelope.content.find(
        (entry: any) => entry.type === "text",
      )?.text;
      assert.equal(JSON.parse(text).url, issue.html_url);
    }
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
    const receipts = JSON.parse(process.env.CREATED_ISSUE_URLS || "[]");
    assert.ok(
      receipts.includes(issue.html_url),
      "Confirmed URL must survive outside the model report",
    );
    await writeFile(
      `${process.env.RUNNER_TEMP}/issue-creation-${success ? "success" : "failure"}-report.json`,
      JSON.stringify(report),
    );
    await writeFile(
      `${process.env.RUNNER_TEMP}/issue-creation-${success ? "success" : "failure"}-evidence.json`,
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
    for (const issue of await issues(true)) {
      assert.equal(issue.user.login, "github-actions[bot]");
      await api(`issues/${issue.number}`, "PATCH", { state: "closed" });
      console.log(`Closed qualification issue #${issue.number}`);
    }
  } else throw new Error("Unknown qualification mode");
}
