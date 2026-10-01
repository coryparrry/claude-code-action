import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunContext, type Tool } from "@openai/agents";
import { AgentPermissions } from "../src/agent-permissions";
import { createAgentMcpTools, type AgentMcpOptions } from "../src/agent-mcp";

const schema = {
  type: "object" as const,
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false as const,
};
function reply(
  message: {
    id?: string | number;
    method: string;
    params?: { arguments?: Record<string, unknown>; name?: string };
  },
  environment: Record<string, string | undefined> = {},
) {
  if (message.id === undefined) return;
  let result: unknown;
  if (message.method === "initialize")
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    };
  else if (message.method === "tools/list")
    result = {
      tools: [
        { name: "echo", description: "Echo", inputSchema: schema },
        { name: "fail", inputSchema: schema },
      ],
    };
  else if (message.method === "tools/call")
    result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            input: message.params?.arguments,
            environment,
          }),
        },
      ],
      isError: message.params?.name === "fail",
    };
  else if (message.method === "ping") result = {};
  else
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Unknown method" },
    };
  return { jsonrpc: "2.0", id: message.id, result };
}
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const options = (
  mcpServers: Record<string, unknown>,
  extra: Partial<AgentMcpOptions> = {},
): AgentMcpOptions => ({
  mcpConfig: JSON.stringify({ mcpServers }),
  environment: {},
  deadline: Date.now() + 5000,
  permissions: new AgentPermissions({
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    allowedTools: extra.allowedTools,
    disallowedTools: extra.disallowedTools,
  }),
  ...extra,
});
async function invoke(
  tools: Tool[],
  name: string,
  input: Record<string, unknown> = { value: "hello" },
): Promise<string> {
  const item = tools.find(
    (entry) => entry.type === "function" && entry.name === name,
  );
  if (!item || item.type !== "function")
    throw new Error(`Missing tool: ${name}`);
  return (await item.invoke(new RunContext(), JSON.stringify(input))) as string;
}
async function stdio() {
  const directory = await mkdtemp(join(tmpdir(), "agent-mcp-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "fixture.cjs");
  await writeFile(
    path,
    `const readline = require('node:readline');\nconst schema = ${JSON.stringify(schema)};\nconst reply = ${reply.toString()};\nlet toolCalls = 0;\nreadline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line); if (m.params?.arguments?.value === 'hang') return; const output = reply(m, {HOME: process.env.HOME, CUSTOM_TOKEN: process.env.CUSTOM_TOKEN, OPENAI_API_KEY: process.env.OPENAI_API_KEY, AMBIENT_TOKEN: process.env.AMBIENT_TOKEN}); if(output && m.method === 'tools/call') output.result._meta = { fixtureCallCount: ++toolCalls }; if(output) process.stdout.write(JSON.stringify(output)+'\\n'); });\n`,
  );
  return {
    command: process.execPath,
    args: [path],
    env: { CUSTOM_TOKEN: "explicit-secret" },
  };
}
async function connected(
  config: Record<string, unknown>,
  extra: Partial<AgentMcpOptions> = {},
) {
  const result = await createAgentMcpTools(options(config, extra));
  cleanup.push(result.close);
  return result;
}

describe("Agents SDK MCP transport adapter", () => {
  test("stdio preserves legacy names, schemas, hook arguments, errors and explicit environment", async () => {
    const original = process.env.AMBIENT_TOKEN;
    process.env.AMBIENT_TOKEN = "must-not-inherit";
    cleanup.push(() => {
      if (original === undefined) delete process.env.AMBIENT_TOKEN;
      else process.env.AMBIENT_TOKEN = original;
    });
    const events: unknown[] = [];
    const result = await connected(
      { fixture: await stdio() },
      {
        environment: {
          OPENAI_API_KEY: "never-forward",
          HOME: "/explicit-home",
        },
        beforeTool: async () => ({ updatedInput: { value: "changed" } }),
        afterTool: async (event) => {
          events.push(event);
        },
      },
    );
    const echo = result.tools.find(
      (entry) =>
        entry.type === "function" && entry.name === "mcp__fixture__echo",
    );
    expect(echo?.type).toBe("function");
    if (echo?.type === "function") {
      expect(echo.strict).toBe(false);
      expect(echo.parameters).toEqual(schema);
    }
    const output = JSON.parse(await invoke(result.tools, "mcp__fixture__echo"));
    expect(output.isError).toBe(false);
    expect(JSON.parse(output.content[0].text)).toEqual({
      input: { value: "changed" },
      environment: { HOME: "/explicit-home", CUSTOM_TOKEN: "explicit-secret" },
    });
    expect(
      JSON.parse(await invoke(result.tools, "mcp__fixture__fail")).isError,
    ).toBe(true);
    expect(result.secrets).toContain("explicit-secret");
    expect(events).toHaveLength(2);
    await result.close();
    await expect(invoke(result.tools, "mcp__fixture__echo")).rejects.toThrow(
      "cancelled",
    );
  });

  test("ordinary MCP environment and interpolation values are not secrets, credential aliases are", async () => {
    const fixture = await stdio();
    const environment = {
      OWNER: "github",
      BRANCH: "feature-branch",
      PATH: "/ordinary/bin",
      TEST_MODE: "1",
      GITHUB_TOKEN: "configured-credential",
      SECRET_ALIAS: "aliased-secret",
    };
    const result = await connected(
      {
        fixture: {
          ...fixture,
          args: [...fixture.args, "${OWNER}", "${BRANCH}", "${TEST_MODE}"],
          env: {
            ...fixture.env,
            OWNER: "${OWNER}",
            BRANCH: "${BRANCH}",
            PATH: "${PATH}",
            TEST_MODE: "1",
            TOKEN: "literal-credential",
            ORDINARY_ALIAS: "${GITHUB_TOKEN}",
            COPY_OF_SECRET: "${SECRET_ALIAS}",
            ARBITRARY_ALIAS: "configured-credential",
          },
        },
      },
      { environment },
    );
    for (const ordinary of ["github", "feature-branch", "/ordinary/bin", "1"])
      expect(result.secrets).not.toContain(ordinary);
    for (const sensitive of [
      "explicit-secret",
      "literal-credential",
      "configured-credential",
      "aliased-secret",
    ])
      expect(result.secrets).toContain(sensitive);
    expect(
      result.tools.map((entry) =>
        entry.type === "function" ? entry.name : "",
      ),
    ).toContain("mcp__fixture__echo");
    expect(
      JSON.parse(await invoke(result.tools, "mcp__fixture__echo")).isError,
    ).toBe(false);
  });

  test("server and individual rules honor denial and hook-modified args are validated", async () => {
    const result = await connected(
      { fixture: await stdio() },
      {
        allowedTools: ["mcp__fixture"],
        disallowedTools: ["mcp__fixture__fail"],
        beforeTool: async () => ({ updatedInput: { value: 42 } }),
      },
    );
    expect(
      result.tools.map((entry) =>
        entry.type === "function" ? entry.name : "",
      ),
    ).toEqual(["mcp__fixture__echo", "mcp__fixture__fail"]);
    await expect(invoke(result.tools, "mcp__fixture__fail")).rejects.toThrow(
      "permission denied",
    );
    await expect(invoke(result.tools, "mcp__fixture__echo")).rejects.toThrow(
      "Invalid MCP tool arguments",
    );
    const denied = await connected(
      { fixture: await stdio() },
      {
        allowedTools: ["mcp__fixture__echo"],
        disallowedTools: ["mcp__fixture"],
      },
    );
    expect(denied.tools).toHaveLength(2);
    await expect(invoke(denied.tools, "mcp__fixture__echo")).rejects.toThrow(
      "permission denied",
    );
  });

  test("permission is rechecked after the before hook", async () => {
    const permissions = new AgentPermissions({
      cwd: process.cwd(),
      permissionMode: "bypassPermissions",
    });
    const result = await connected(
      { fixture: await stdio() },
      {
        permissions,
        beforeTool: async () => {
          permissions.update({ disallowedTools: ["mcp__fixture__echo"] });
          return { updatedInput: { value: "changed" } };
        },
      },
    );
    await expect(invoke(result.tools, "mcp__fixture__echo")).rejects.toThrow(
      "permission denied",
    );
  });

  test("allow rules approve calls rather than hiding unlisted tools; permission hooks can approve and rewrite", async () => {
    const permissions = new AgentPermissions({
      cwd: process.cwd(),
      allowedTools: ["mcp__fixture__echo"],
    });
    let requests = 0;
    const result = await connected(
      { fixture: await stdio() },
      {
        permissions,
        permissionRequest: async () => {
          requests++;
          return {
            permissionDecision: "allow",
            updatedInput: { value: "approved" },
          };
        },
      },
    );
    expect(result.tools).toHaveLength(2);
    await invoke(result.tools, "mcp__fixture__echo");
    expect(requests).toBe(0);
    const output = JSON.parse(await invoke(result.tools, "mcp__fixture__fail"));
    expect(requests).toBe(1);
    expect(JSON.parse(output.content[0].text).input.value).toBe("approved");
  });

  test("configured hook dispatch skips recursive hooks, approves one call, and retains deny and ask rules", async () => {
    const permissions = new AgentPermissions({ cwd: process.cwd() });
    let hooks = 0;
    const result = await connected(
      { "plugin:demo:fixture": await stdio() },
      {
        permissions,
        beforeTool: async () => {
          hooks++;
        },
      },
    );
    const output = await result.invokeServer(
      "plugin:demo:fixture",
      "echo",
      { value: "hook" },
      { skipHooks: true },
    );
    expect(JSON.parse(output).isError).toBe(false);
    expect(hooks).toBe(0);
    await expect(
      invoke(result.tools, "mcp__plugin_demo_fixture__echo"),
    ).rejects.toThrow("without approval");
    permissions.update({ disallowedTools: ["mcp__plugin:demo:fixture"] });
    await expect(
      result.invokeServer(
        "plugin:demo:fixture",
        "echo",
        { value: "hook" },
        { skipHooks: true },
      ),
    ).rejects.toThrow("permission denied");
    permissions.update({
      disallowedTools: [],
      askTools: ["mcp__plugin:demo:fixture"],
    });
    await expect(
      result.invokeServer(
        "plugin:demo:fixture",
        "echo",
        { value: "hook" },
        { skipHooks: true },
      ),
    ).rejects.toThrow("ask rule");
  });

  test("expired or invalid invocation deadlines reject before hooks or MCP RPC", async () => {
    let hooks = 0;
    const result = await connected(
      { fixture: await stdio() },
      {
        beforeTool: async () => {
          hooks++;
        },
      },
    );
    const baseline = JSON.parse(
      await result.invokeServer(
        "fixture",
        "echo",
        { value: "baseline" },
        { skipHooks: true },
      ),
    );
    expect(baseline._meta.fixtureCallCount).toBe(1);
    for (const deadline of [Date.now() - 1, Number.NaN, Infinity, -Infinity]) {
      await expect(
        result.invokeServer(
          "fixture",
          "echo",
          { value: "must-not-call" },
          { deadline },
        ),
      ).rejects.toThrow("deadline");
      await expect(
        result.invokeServer(
          "fixture",
          "echo",
          { value: "must-not-call" },
          { deadline, skipHooks: true },
        ),
      ).rejects.toThrow("deadline");
    }
    expect(hooks).toBe(0);
    const next = JSON.parse(
      await result.invokeServer(
        "fixture",
        "echo",
        { value: "next" },
        { skipHooks: true },
      ),
    );
    expect(next._meta.fixtureCallCount).toBe(2);
  });

  test("MCP tool timeout is validated and limits actual hanging calls", async () => {
    await expect(
      createAgentMcpTools(
        options({}, { environment: { MCP_TIMEOUT: "invalid" } }),
      ),
    ).rejects.toThrow("MCP_TIMEOUT");
    await expect(
      createAgentMcpTools(
        options({}, { environment: { MCP_TOOL_TIMEOUT: "0" } }),
      ),
    ).rejects.toThrow("MCP_TOOL_TIMEOUT");
    const result = await connected(
      { fixture: await stdio() },
      { environment: { MCP_TIMEOUT: "1000", MCP_TOOL_TIMEOUT: "120" } },
    );
    const started = Date.now();
    await expect(
      result.invoke("mcp__fixture__echo", { value: "hang" }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("hanging calls are cancelled and closed within the deadline", async () => {
    const result = await connected(
      { fixture: await stdio() },
      { deadline: Date.now() + 700 },
    );
    const started = Date.now();
    await expect(
      invoke(result.tools, "mcp__fixture__echo", { value: "hang" }),
    ).rejects.toThrow();
    await result.close();
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("abort and failed initialization close connections", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createAgentMcpTools(
        options({ fixture: await stdio() }, { signal: controller.signal }),
      ),
    ).rejects.toThrow("cancelled");
    await expect(
      createAgentMcpTools(
        options({ broken: { command: "/nonexistent-mcp-fixture" } }),
      ),
    ).rejects.toThrow();
  });

  test.each(["http", "sse"])(
    "real %s transports send configured authentication and preserve MCP errors",
    async (type) => {
      const requests: {
        authorization: string | null;
        custom: string | null;
      }[] = [];
      let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
      const encoder = new TextEncoder();
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
          requests.push({
            authorization: request.headers.get("authorization"),
            custom: request.headers.get("x-custom"),
          });
          if (request.method === "DELETE")
            return new Response(null, { status: 200 });
          if (request.method === "GET") {
            if (type !== "sse") return new Response(null, { status: 405 });
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  stream = controller;
                  controller.enqueue(
                    encoder.encode("event: endpoint\ndata: /messages\n\n"),
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          }
          const message = (await request.json()) as Parameters<typeof reply>[0];
          const response = reply(message);
          if (type === "sse") {
            if (response)
              stream?.enqueue(
                encoder.encode(
                  `event: message\ndata: ${JSON.stringify(response)}\n\n`,
                ),
              );
            return new Response(null, { status: 202 });
          }
          return response
            ? Response.json(response)
            : new Response(null, { status: 202 });
        },
      });
      cleanup.push(() => {
        try {
          stream?.close();
        } catch {}
        server.stop(true);
      });
      const result = await connected(
        {
          web: {
            type,
            url: `http://127.0.0.1:${server.port}/${type === "sse" ? "sse" : "mcp"}`,
            bearer_token_env_var: "MCP_TOKEN",
            headers: { "x-custom": "${CUSTOM}" },
          },
        },
        {
          environment: { MCP_TOKEN: "bearer-secret", CUSTOM: "header-secret" },
        },
      );
      expect(
        JSON.parse(await invoke(result.tools, "mcp__web__fail")).isError,
      ).toBe(true);
      expect(requests.length).toBeGreaterThan(1);
      expect(
        requests.every(
          (entry) =>
            entry.authorization === "Bearer bearer-secret" &&
            entry.custom === "header-secret",
        ),
      ).toBe(true);
      expect(result.secrets).toContain("bearer-secret");
      expect(result.secrets).toContain("header-secret");
      await result.close();
    },
  );
});
