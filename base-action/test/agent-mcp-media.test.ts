import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import {
  RunContext,
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentMcpTools,
  summarizeMcpToolOutput,
  type AgentMcpOptions,
} from "../src/agent-mcp";
import { AgentPermissions } from "../src/agent-permissions";
import { runOpenAIAgent } from "../src/openai-agent-runner";
import { runCodex } from "../src/run-codex";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const pdf = Buffer.from("%PDF-1.4\nfixture").toString("base64");
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(result: unknown) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "mcp-media-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "fixture.cjs");
  await writeFile(
    path,
    `const result = ${JSON.stringify(result)};
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let response;
  if (message.method === 'initialize') response = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'media', version: '1' } };
  else if (message.method === 'tools/list') response = { tools: [{ name: 'snapshot', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  else if (message.method === 'tools/call') response = result;
  else response = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: response }) + '\\n');
});`,
  );
  return {
    directory,
    mcpConfig: JSON.stringify({
      mcpServers: { media: { command: process.execPath, args: [path] } },
    }),
  };
}

async function connect(result: unknown, extra: Partial<AgentMcpOptions> = {}) {
  const setup = await fixture(result);
  const connected = await createAgentMcpTools({
    mcpConfig: setup.mcpConfig,
    environment: {},
    deadline: Date.now() + 10000,
    permissions: new AgentPermissions({
      cwd: setup.directory,
      permissionMode: "bypassPermissions",
    }),
    ...extra,
  });
  cleanup.push(connected.close);
  return connected;
}

class MediaModel implements Model {
  readonly requests: ModelRequest[] = [];
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      usage: new Usage({ requests: 1, inputTokens: 4, outputTokens: 2 }),
      output:
        this.requests.length === 1
          ? [
              {
                type: "function_call",
                name: "mcp__media__snapshot",
                callId: "media-call",
                arguments: "{}",
                status: "completed",
              },
            ]
          : [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Image received" }],
                status: "completed",
              },
            ],
    };
  }
  async *getStreamedResponse(): AsyncGenerator<never> {
    throw new Error("Offline fixture uses non-streaming SDK orchestration");
  }
}

async function modelOutput(connected: Awaited<ReturnType<typeof connect>>) {
  const model = new MediaModel();
  await runOpenAIAgent("Inspect the tool image", {
    apiKey: "offline-media-fixture",
    model,
    instructions: "Offline image fixture",
    tools: connected.tools,
    deadline: Date.now() + 10000,
    maxTurns: 2,
  });
  const input = model.requests[1]!.input;
  if (typeof input === "string") throw new Error("Expected model history");
  const output = input.find((item) => item.type === "function_call_result");
  if (!output || output.type !== "function_call_result")
    throw new Error("Missing tool output");
  return output.output;
}

describe("MCP media at the real Agents SDK model boundary", () => {
  test("image bytes reach the model as input_image while text remains bounded", async () => {
    const connected = await connect(
      {
        content: [
          { type: "text", text: "oversized ".repeat(500) },
          { type: "image", data: png, mimeType: "image/png" },
        ],
      },
      { environment: { MAX_MCP_OUTPUT_TOKENS: "256" } },
    );
    const output = await modelOutput(connected);
    expect(output).toEqual([
      { type: "input_text", text: expect.any(String) },
      { type: "input_image", image: `data:image/png;base64,${png}` },
    ]);
    if (!Array.isArray(output) || output[0]?.type !== "input_text")
      throw new Error("Expected structured output");
    expect(Buffer.byteLength(output[0].text)).toBeLessThanOrEqual(256);
    expect(output[0].text).toContain("[MCP output truncated]");
    expect(output[0].text).not.toContain(png);
  });

  test("embedded images and PDFs are native content; resource identifiers and errors survive", async () => {
    const connected = await connect({
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///shot.png",
            mimeType: "image/png",
            blob: png,
          },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///report.pdf",
            mimeType: "application/pdf",
            blob: pdf,
          },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///notes.txt",
            mimeType: "text/plain",
            text: "Resource text",
          },
        },
        {
          type: "resource_link",
          uri: "file:///linked.txt",
          name: "Linked text",
          mimeType: "text/plain",
        },
      ],
      isError: true,
      structuredContent: { partial: true },
    });
    const output = await modelOutput(connected);
    expect(output).toMatchObject([
      { type: "input_text" },
      { type: "input_image", image: `data:image/png;base64,${png}` },
      {
        type: "input_file",
        file: `data:application/pdf;base64,${pdf}`,
        filename: "report.pdf",
      },
    ]);
    if (!Array.isArray(output) || output[0]?.type !== "input_text")
      throw new Error("Expected structured output");
    const envelope = JSON.parse(output[0].text);
    expect(envelope).toMatchObject({
      isError: true,
      structuredContent: { partial: true },
    });
    expect(envelope.content[0].resource.uri).toBe("file:///shot.png");
    expect(envelope.content[2].resource.text).toBe("Resource text");
    expect(envelope.content[3]).toMatchObject({
      type: "resource_link",
      uri: "file:///linked.txt",
    });
    expect(output[0].text).not.toContain(png);
    expect(output[0].text).not.toContain(pdf);
  });

  test("unsupported audio and blobs report their limits without leaking base64 into text", async () => {
    const binary = Buffer.from("unsupported media fixture").toString("base64");
    const connected = await connect({
      content: [
        { type: "audio", mimeType: "audio/wav", data: binary },
        { type: "image", mimeType: "image/svg+xml", data: binary },
        {
          type: "resource",
          resource: {
            uri: "file:///data.bin",
            mimeType: "application/octet-stream",
            blob: binary,
          },
        },
      ],
    });
    const output = JSON.stringify(await modelOutput(connected));
    expect(output).toContain("Unsupported MCP media omitted: audio/wav");
    expect(output).toContain("Unsupported MCP media omitted: image/svg+xml");
    expect(output).toContain(
      "Unsupported MCP media omitted: application/octet-stream",
    );
    expect(output).not.toContain(binary);
    expect(output).not.toContain("input_image");
  });

  test("post hooks replace media before forwarding and direct invocation returns bounded text", async () => {
    let original: string | undefined;
    const connected = await connect(
      { content: [{ type: "image", data: png, mimeType: "image/png" }] },
      {
        beforeTool: async () => ({ additionalContext: "Hook context" }),
        afterTool: async (event) => {
          original = event.output;
          return {
            updatedMCPToolOutput: {
              content: [{ type: "text", text: "Replaced by hook" }],
              isError: true,
            },
          };
        },
      },
    );
    const output = JSON.stringify(await modelOutput(connected));
    expect(original).toContain(png);
    expect(output).toContain("Replaced by hook");
    expect(output).toContain("Hook context");
    expect(output).not.toContain("input_image");
    const direct = await connected.invokeServer(
      "media",
      "snapshot",
      {},
      { skipHooks: true },
    );
    expect(direct).toContain("image/png");
    expect(direct).not.toContain(png);
  });

  test("permission denial still prevents a media tool call", async () => {
    let afterCalls = 0;
    const connected = await connect(
      { content: [{ type: "image", data: png, mimeType: "image/png" }] },
      {
        beforeTool: async () => ({ permissionDecision: "deny" }),
        afterTool: async () => {
          afterCalls++;
        },
      },
    );
    const tool = connected.tools[0]!;
    if (tool.type !== "function") throw new Error("Expected function tool");
    await expect(tool.invoke(new RunContext(), "{}")).rejects.toThrow("denied");
    expect(afterCalls).toBe(1);
  });

  test("execution artifacts and debug logs omit image bytes without changing model input", async () => {
    const setup = await fixture({
      content: [{ type: "image", data: png, mimeType: "image/png" }],
    });
    const savedEnv = { ...process.env };
    cleanup.push(() => {
      process.env = savedEnv;
    });
    process.env.OPENAI_API_KEY = "offline-media-fixture";
    process.env.RUNNER_TEMP = setup.directory;
    process.env.HOME = setup.directory;
    const logs: string[] = [];
    const info = spyOn(core, "info").mockImplementation((message) => {
      logs.push(message);
    });
    const secret = spyOn(core, "setSecret").mockImplementation(() => {});
    cleanup.push(() => {
      info.mockRestore();
      secret.mockRestore();
    });
    const prompt = join(setup.directory, "prompt.txt");
    await writeFile(prompt, "Inspect image");
    const model = new MediaModel();
    const result = await runCodex(prompt, {
      model,
      workspace: setup.directory,
      configurationHome: setup.directory,
      sessionStoragePath: join(setup.directory, "sessions"),
      mcpConfig: setup.mcpConfig,
      settingSources: [],
      permissionMode: "bypassPermissions",
      showFullOutput: "true",
      timeoutMs: 10000,
    });
    expect(result.conclusion).toBe("success");
    const transcript = await readFile(result.executionFile!, "utf8");
    expect(transcript).toContain("Media content omitted from transcript");
    expect(transcript).not.toContain(png);
    expect(logs.join("\n")).not.toContain(png);
    expect(JSON.stringify(model.requests[1]!.input)).toContain(
      `data:image/png;base64,${png}`,
    );
    expect(summarizeMcpToolOutput("plain text")).toBe("plain text");
  });
});
