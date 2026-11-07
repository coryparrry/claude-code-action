import { actionCreatedIssueMarker } from "../src/github/issue-origin";
import { checkContainsTrigger } from "../src/github/validation/trigger";
import { afterEach, expect, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "@babel/parser";
import { parse as parseYaml } from "yaml";
import { resolveCompatibility } from "../base-action/src/codex-compat";
import {
  createRepositoryIssue,
  issueCreationError,
  issueInputSchema,
} from "../src/mcp/github-issues-server";
import { issueCreationAllowed } from "../src/mcp/issue-creation-policy";
import {
  initializeIssueReceipts,
  readCreatedIssues,
} from "../src/github/operations/issue-creation-receipts";
import {
  assertOpeningIsSkipped,
  selectQualificationIssues,
} from "../scripts/qualify-issue-creation";
import { prepareMcpConfig } from "../src/mcp/install-mcp-server";
import { AgentPermissions } from "../base-action/src/agent-permissions";
import { createMockContext } from "./mockContext";

const environment = { ...process.env };
afterEach(() => {
  process.env = { ...environment };
});

/** Construct a fake API client that records repository scope and mutation count. */
function apiFixture(status?: number) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    rest: {
      issues: {
        /** Simulate exactly one issue POST for the service tests. */
        async create(input: Record<string, unknown>) {
          calls.push(input);
          if (status)
            throw Object.assign(new Error("sensitive-server-message"), {
              status,
            });
          return {
            data: {
              number: 19,
              title: input.title,
              html_url: "https://github.com/owner/repo/issues/19",
            },
          };
        },
      },
    },
  } as unknown as Octokit;
  return { client, calls };
}

test("issue publication masks opaque URL credentials without registered secrets", async () => {
  const { client, calls } = apiFixture();
  const password = "opaque-connection-value";
  const connection = `postgresql://reader:${password}@embedded@db.example/reports`;
  const encoded = "mongodb+srv://reader:p%40ss%3Aword@cluster.example/data";
  await createRepositoryIssue(
    client,
    { owner: "owner", repo: "repo" },
    {
      title: connection,
      body: `${connection}\n${encoded}\nhttps://docs.example/database`,
      labels: ["https://reader:short@db.test"],
    },
  );
  const posted = JSON.stringify(calls[0]);
  expect(posted).not.toContain(password);
  expect(posted).not.toContain("embedded");
  expect(posted).not.toContain("p%40ss%3Aword");
  expect(posted).not.toContain("reader:");
  expect(calls[0]!.title).toBe("postgresql://[REDACTED]@db.example/reports");
  expect(calls[0]!.body).toContain(
    "mongodb+srv://[REDACTED]@cluster.example/data",
  );
  expect(calls[0]!.body).toContain("https://docs.example/database");
  expect(calls[0]!.labels).toEqual(["https://[REDACTED]@db.test"]);
});

test("creates a repository-scoped issue with sanitized content and confirmed URL", async () => {
  const { client, calls } = apiFixture();
  const result = await createRepositoryIssue(
    client,
    { owner: "owner", repo: "repo" },
    {
      title: "  Follow-up  ",
      body: "Do not publish sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      labels: ["bug"],
    },
  );
  expect(result).toEqual({
    number: 19,
    title: "Follow-up",
    url: "https://github.com/owner/repo/issues/19",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    owner: "owner",
    repo: "repo",
    labels: ["bug"],
  });
  expect(JSON.stringify(calls)).not.toContain("sk-proj-");
});

test.each([403, 410, 422, 500])(
  "does not retry failed or uncertain issue POSTs (%s)",
  async (status) => {
    const { client, calls } = apiFixture(status);
    await expect(
      createRepositoryIssue(
        client,
        { owner: "owner", repo: "repo" },
        { title: "Follow-up", body: "Body" },
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(
      issueCreationError({ status, message: "sensitive-server-message" }),
    ).not.toContain("sensitive");
  },
);

test("rejects empty/oversized input and model-supplied repository identity before writing", async () => {
  const { client, calls } = apiFixture();
  for (const input of [
    { title: " ", body: "Body" },
    { title: "X", body: "💡".repeat(20000) },
    { title: "X", body: "Body", owner: "other" },
  ]) {
    expect(issueInputSchema.safeParse(input).success).toBe(false);
    await expect(
      createRepositoryIssue(
        client,
        { owner: "owner", repo: "repo" },
        input as any,
      ),
    ).rejects.toThrow();
  }
  expect(calls).toHaveLength(0);
});

test.each(["plan", "read-only"])(
  "hard-denies issue creation in %s despite an explicit allow",
  (mode) => {
    const permissions = new AgentPermissions({
      cwd: tmpdir(),
      permissionMode: mode,
      allowedTools: ["mcp__github_issues__create_issue"],
    });
    expect(() =>
      permissions.assertDenied("mcp__github_issues__create_issue"),
    ).toThrow("read-only/plan");
  },
);

test.each([
  ["tag", false, false, false, true],
  ["agent", false, false, false, false],
  ["agent", true, false, false, true],
  ["tag", true, true, false, false],
  ["tag", true, false, true, false],
] as const)(
  "issue server installation respects mode/grants/plan/untrusted scope %s %s %s %s",
  async (mode, grant, plan, untrusted, enabled) => {
    delete process.env.DEFAULT_WORKFLOW_TOKEN;
    delete process.env.CODEX_SANDBOX;
    process.env.CODEX_ARGS = plan ? "--permission-mode plan" : "";
    process.env.GITHUB_ACTION_PATH = "/trusted/action";
    const config = JSON.parse(
      await prepareMcpConfig({
        githubToken: "fixture-token",
        owner: "owner",
        repo: "repo",
        branch: "feature",
        baseBranch: "main",
        allowedTools: grant ? ["mcp__github_issues__create_issue"] : [],
        mode,
        context: createMockContext({
          eventAction: "created",
          payload: { comment: { user: { login: "test-actor" } } } as any,
          inputs: { allowedNonWriteUsers: untrusted ? "reader" : "" },
        }),
      }),
    );
    expect(Boolean(config.mcpServers.github_issues)).toBe(enabled);
    if (enabled) {
      expect(config.mcpServers.github_issues.env.REPO_OWNER).toBe("owner");
      expect(config.mcpServers.github_issues.env.REPO_NAME).toBe("repo");
      expect(config.mcpServers.github).toBeUndefined();
    }
  },
);

test("actual stdio tool creates once for concurrent identical calls and caches uncertain failures", async () => {
  let posts = 0;
  const requests: any[] = [];
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0 /** Serve the issue REST boundary without real credentials. */,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/repos/owner/repo/issues");
      posts++;
      const payload = (await request.json()) as any;
      requests.push(payload);
      if (payload.title === "Uncertain")
        return Response.json(
          { message: "sensitive-server-message" },
          { status: 500 },
        );
      return Response.json(
        {
          number: 19,
          title: payload.title,
          html_url: "https://github.com/owner/repo/issues/19",
        },
        { status: 201 },
      );
    },
  });
  const home = await mkdtemp(join(tmpdir(), "issue-protocol-"));
  const receipt = initializeIssueReceipts({ RUNNER_TEMP: home });
  const client = new Client({ name: "issue-protocol-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "../src/mcp/github-issues-server.ts")],
    cwd: home,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH!,
      HOME: home,
      GITHUB_TOKEN: "fixture-token",
      REPO_OWNER: "owner",
      REPO_NAME: "repo",
      GITHUB_API_URL: String(http.url).replace(/\/$/, ""),
      CODEX_CREATED_ISSUES_RECEIPT: receipt,
    },
  });
  try {
    await client.connect(transport);
    const results = await Promise.all([
      client.callTool({
        name: "create_issue",
        arguments: { title: "One issue", body: "Body" },
      }),
      client.callTool({
        name: "create_issue",
        arguments: { title: "One issue", body: "Body" },
      }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.isError).not.toBe(true);
    expect(posts).toBe(1);
    expect(readCreatedIssues("owner", "repo", receipt)).toHaveLength(1);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await client.callTool({
        name: "create_issue",
        arguments: { title: "Uncertain", body: "Body" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Inspect the repository");
      expect(JSON.stringify(result)).not.toContain("sensitive-server-message");
    }
    expect(posts).toBe(2);
    expect(requests[0]).not.toHaveProperty("owner");
  } finally {
    await client.close();
    await transport.close();
    http.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});

/** Collect documentation status for new named functions/methods without counting callbacks. */
function documentation(node: any, results: boolean[], inherited: any[] = []) {
  if (!node || typeof node !== "object") return;
  const comments = [...inherited, ...(node.leadingComments ?? [])];
  if (
    (node.type === "FunctionDeclaration" && node.id) ||
    ["ObjectMethod", "ClassMethod"].includes(node.type)
  )
    results.push(
      comments.some(
        (c: any) => c.type === "CommentBlock" && c.value.startsWith("*"),
      ),
    );
  for (const [key, value] of Object.entries(node)) {
    if (key.endsWith("Comments")) continue;
    const next = node.type === "ExportNamedDeclaration" ? comments : [];
    if (Array.isArray(value))
      for (const child of value) documentation(child, results, next);
    else if (value && typeof value === "object")
      documentation(value, results, next);
  }
}

test("new issue-creation code meets the 85% documentation requirement", async () => {
  const results: boolean[] = [];
  for (const file of [
    "src/mcp/github-issues-server.ts",
    "src/github/issue-origin.ts",
    "src/github/operations/action-settings.ts",
    "src/mcp/issue-creation-policy.ts",
    "src/github/operations/issue-creation-receipts.ts",
    "test/issue-creation.test.ts",
    "test/issue-creation-grants.test.ts",
    "scripts/qualify-issue-creation.ts",
  ])
    documentation(
      parse(await readFile(join(import.meta.dir, "..", file), "utf8"), {
        sourceType: "module",
        plugins: ["typescript"],
      }),
      results,
    );
  const documented = results.filter(Boolean).length;
  console.log(
    `Issue creation documentation: ${documented}/${results.length} named symbols`,
  );
  expect(documented / results.length).toBeGreaterThanOrEqual(0.85);
});

test("tracking reviews need an explicit issue-creation grant, including wildcard grants", () => {
  const review = createMockContext({
    eventName: "pull_request",
    eventAction: "opened",
    inputs: { trackProgress: true, prompt: "Review this PR" },
  });
  expect(issueCreationAllowed(review, "tag", [])).toBe(false);
  expect(issueCreationAllowed(review, "agent", [])).toBe(false);
  for (const rule of [
    "mcp__github_issues__*",
    "mcp__github_issues",
    "mcp__github_*__create_issue",
  ])
    expect(issueCreationAllowed(review, "agent", [rule])).toBe(true);
  expect(
    issueCreationAllowed(
      createMockContext({ eventName: "issues", eventAction: "labeled" }),
      "tag",
      [],
    ),
  ).toBe(false);
});

test("literal Markdown, accessible image descriptions and fenced examples survive issue creation", async () => {
  process.env.GITHUB_WORKFLOW_REF =
    "owner/repo/.github/workflows/create.yml@refs/heads/main";
  const { client, calls } = apiFixture();
  const body =
    '![Meaningful chart description](https://example.com/chart.png)\n```html\n<img alt="Reproduction" title="Example">\n<!-- literal regression marker -->\n```';
  await createRepositoryIssue(
    client,
    { owner: "owner", repo: "repo" },
    { title: "Reproduction", body },
  );
  expect(calls[0]!.body).toBe(`${actionCreatedIssueMarker()}\n\n${body}`);
  const context = createMockContext({
    eventName: "issues",
    eventAction: "opened",
    actor: "github-actions[bot]",
    inputs: {
      triggerPhrase: "/codex",
      prompt: "Explicit command",
      botName: "github-actions[bot]",
    },
    payload: {
      issue: {
        body: calls[0]!.body,
        title: "/codex Do not run",
        user: { login: "github-actions[bot]", type: "Bot" },
      },
    } as any,
  });
  expect(checkContainsTrigger(context)).toBe(false);
  process.env.GITHUB_WORKFLOW_REF =
    "owner/repo/.github/workflows/create.yml@refs/heads/release";
  expect(checkContainsTrigger(context)).toBe(false);
  process.env.GITHUB_WORKFLOW_REF =
    "owner/repo/.github/workflows/create.yml@refs/heads/feature/notify@team";
  expect(checkContainsTrigger(context)).toBe(false);
  process.env.GITHUB_WORKFLOW_REF =
    "owner/repo/.github/workflows/triage.yml@refs/heads/main";
  expect(checkContainsTrigger(context)).toBe(true);
  delete process.env.GITHUB_WORKFLOW_REF;
  expect(checkContainsTrigger(context)).toBe(true);
  expect(
    checkContainsTrigger({
      ...context,
      inputs: { ...context.inputs, prompt: "" },
      actor: "human",
      payload: {
        issue: {
          body: calls[0]!.body,
          title: "/codex Do run",
          user: { login: "human", type: "User" },
        },
      } as any,
    }),
  ).toBe(true);
});

test("cleanup finds confirmed fixtures with changed titles or bodies without touching another author's issue", () => {
  const records = [
    {
      title: "Expected",
      body: "Body plus extra",
      html_url: "https://github.com/o/r/issues/1",
      user: { login: "github-actions[bot]" },
    },
    {
      title: "Changed",
      body: "Changed",
      html_url: "https://github.com/o/r/issues/2",
      user: { login: "github-actions[bot]" },
    },
    {
      title: "Expected",
      body: "Body",
      html_url: "https://github.com/o/r/issues/3",
      user: { login: "human" },
    },
  ];
  const matches = selectQualificationIssues(
    records,
    "Expected",
    "Body",
    [records[1]!.html_url],
    true,
  );
  expect(matches.map((issue) => issue.html_url)).toEqual(
    records.slice(0, 2).map((issue) => issue.html_url),
  );
});

test("configuration installs wildcard issue grants but not an implicit automatic tracking review", async () => {
  delete process.env.DEFAULT_WORKFLOW_TOKEN;
  delete process.env.CODEX_SANDBOX;
  process.env.CODEX_ARGS = "";
  process.env.GITHUB_ACTION_PATH = "/trusted/action";
  const options = {
    githubToken: "fixture-token",
    owner: "owner",
    repo: "repo",
    branch: "feature",
    baseBranch: "main",
    context: createMockContext({
      eventName: "pull_request",
      eventAction: "opened",
      inputs: { trackProgress: true, prompt: "Review this PR" },
    }),
  };
  const implicit = JSON.parse(
    await prepareMcpConfig({ ...options, allowedTools: [], mode: "tag" }),
  );
  expect(implicit.mcpServers.github_issues).toBeUndefined();
  const explicit = JSON.parse(
    await prepareMcpConfig({
      ...options,
      allowedTools: ["mcp__github_issues__*"],
      mode: "agent",
    }),
  );
  expect(explicit.mcpServers.github_issues).toBeDefined();
});

test("issue-only qualification cannot expose or authorize Git and file mutation tools", async () => {
  const workflow = parseYaml(
    await readFile(
      join(
        import.meta.dir,
        "../.github/workflows/issue-creation-qualification.yml",
      ),
      "utf8",
    ),
  );
  expect(workflow.jobs.create.permissions.contents).toBe("read");
  const agent = workflow.jobs.create.steps.find(
    (step: any) => step.id === "creator",
  );
  const options = await resolveCompatibility(
    agent.with.codex_args,
    "",
    '{"mcpServers":{}}',
    ["*"],
  );
  const permissions = new AgentPermissions({
    cwd: tmpdir(),
    permissionMode: options.permissionMode,
    allowedTools: ["*"],
    disallowedTools: options.disallowedTools,
  });
  for (const tool of [
    "Write",
    "Edit",
    "Bash",
    "mcp__github_git__push",
    "mcp__github_git__commit_files",
    "mcp__github_git__delete_files",
    "mcp__github_file_ops__commit_files",
  ]) {
    expect(options.tools).not.toContain(tool);
    expect(() => permissions.assertDenied(tool)).toThrow();
  }
  expect(() =>
    permissions.assertDenied("mcp__github_issues__create_issue"),
  ).not.toThrow();
});

test.each(["deleted", "edited", "created"])(
  "comment %s cannot lend the actor's trust to another author",
  (eventAction) => {
    const context = createMockContext({
      eventAction,
      actor: "maintainer",
      payload: { comment: { user: { login: "outsider" } } } as any,
    });
    expect(issueCreationAllowed(context, "tag", [])).toBe(false);
    expect(
      issueCreationAllowed(context, "tag", [
        "mcp__github_issues__create_issue",
      ]),
    ).toBe(false);
  },
);

test("only live author-matching comment requests get the default creation tool", () => {
  const context = createMockContext({
    eventAction: "created",
    payload: { comment: { user: { login: "test-actor" } } } as any,
  });
  expect(issueCreationAllowed(context, "tag", [])).toBe(true);
  expect(
    issueCreationAllowed({ ...context, eventAction: "deleted" }, "tag", ["*"]),
  ).toBe(false);
  expect(
    issueCreationAllowed({ ...context, payload: {} as any }, "tag", []),
  ).toBe(false);
});

test("qualification replays an actual configured-bot opening without credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "issue-opening-replay-"));
  process.env.RUNNER_TEMP = directory;
  process.env.GITHUB_REPOSITORY = "owner/repo";
  process.env.GITHUB_RUN_ID = "fixture";
  try {
    process.env.GITHUB_WORKFLOW_REF =
      "owner/repo/.github/workflows/create.yml@refs/heads/main";
    await assertOpeningIsSkipped({
      number: 1,
      title: "/codex fixture",
      body: `${actionCreatedIssueMarker()}\n\nReplay only`,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("qualification counts matching issues absent from creation receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "issue-inventory-"));
  const first = {
    number: 1,
    title: "Run fixture",
    body: "Unique body",
    html_url: "https://github.com/owner/repo/issues/1",
  };
  const duplicate = {
    ...first,
    number: 2,
    html_url: "https://github.com/owner/repo/issues/2",
  };
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    /** Return a receipt issue separately from the independent repository inventory. */
    fetch(request) {
      return Response.json(
        new URL(request.url).pathname.endsWith("/issues/1")
          ? first
          : [first, duplicate],
      );
    },
  });
  try {
    const script = join(directory, "inventory.ts");
    await writeFile(
      script,
      `import { issues } from ${JSON.stringify(join(import.meta.dir, "../scripts/qualify-issue-creation.ts"))};
const found=await issues();
if (found.length!==2) throw new Error("Unrecorded duplicate was ignored");
console.log("INVENTORY_OK");
`,
    );
    const child = Bun.spawn({
      cmd: [process.execPath, "--no-env-file", script],
      env: {
        PATH: process.env.PATH!,
        GITHUB_REPOSITORY: "owner/repo",
        GITHUB_API_URL: String(http.url).replace(/\/$/, ""),
        GH_TOKEN: "fixture",
        ISSUE_TEST_TITLE: first.title,
        ISSUE_TEST_BODY: first.body,
        CREATED_ISSUE_URLS: JSON.stringify([first.html_url]),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, diagnostics: code ? stderr : "" }).toEqual({
      code: 0,
      diagnostics: "",
    });
    expect(stdout).toContain("INVENTORY_OK");
  } finally {
    http.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
