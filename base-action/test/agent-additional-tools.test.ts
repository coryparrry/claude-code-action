import { afterEach, describe, expect, test } from "bun:test";
import { RunContext, type FunctionTool } from "@openai/agents";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import {
  createAdditionalAgentTools,
  parseAgentMarkdown,
  resolveAgentCommand,
  type AdditionalAgentToolOptions,
  type SubagentRequest,
  type SummarizeRequest,
  type SearchRequest,
} from "../src/agent-additional-tools";
import type { AgentConfiguration } from "../src/agent-configuration";
const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];
const servers: Server[] = [];
async function setup(overrides: Partial<AdditionalAgentToolOptions> = {}) {
  const cwd = await realpath(
    await mkdtemp(join(tmpdir(), "additional-tools-")),
  );
  directories.push(cwd);
  const configuration: AgentConfiguration = {
    settings: {},
    sources: [],
    plugins: [],
    mcpServers: {},
    lspServers: {},
    commandDirectories: [],
    skillDirectories: [],
    agentDirectories: [],
    workflowDirectories: [],
    outputStyleDirectories: [],
    hooks: {},
    projectInstructions: "",
  };
  const options: AdditionalAgentToolOptions = {
    cwd,
    configuration,
    env: { PATH: "/usr/bin:/bin" },
    allowedTools: ["Skill", "Task", "WebFetch", "WebSearch", "LSP", "Bash"],
    ...overrides,
  };
  const instance = createAdditionalAgentTools(options);
  closers.push(instance.close);
  const invoke = async (name: string, input: Record<string, unknown>) => {
    const selected = instance.tools.find(
      (candidate) => candidate.name === name,
    ) as FunctionTool;
    expect(selected.type).toBe("function");
    return String(
      await selected.invoke(new RunContext(), JSON.stringify(input)),
    );
  };
  return {
    cwd,
    options,
    configuration: options.configuration,
    invoke,
    close: instance.close,
  };
}
async function serve() {
  const received: Record<string, string | string[] | undefined>[] = [];
  const server = createServer((request, response) => {
    received.push(request.headers);
    if (request.url === "/escape") {
      const address = server.address();
      response.writeHead(302, {
        Location: `http://localhost:${typeof address === "object" && address ? address.port : 0}/page`,
      });
      response.end();
    } else if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/page" });
      response.end();
    } else if (request.url === "/loop") {
      response.writeHead(302, { Location: "/loop" });
      response.end();
    } else if (request.url === "/large") {
      response.setHeader("Content-Type", "text/plain");
      response.end("x".repeat(4096));
    } else if (request.url === "/binary") {
      response.setHeader("Content-Type", "image/png");
      response.end("bytes");
    } else if (request.url === "/error") {
      response.writeHead(500);
      response.end("bad");
    } else {
      response.setHeader("Content-Type", "text/html");
      response.end(
        '<h1>Title</h1><script>secret script</script><style>hidden style</style><form>input</form><p onclick="bad()">Visible &amp; &#x41;</p>',
      );
    }
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing address");
  return { base: `http://127.0.0.1:${address.port}`, received };
}
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("additional real SDK tools", () => {
  test("parses flat frontmatter lists and multiline descriptions and rejects malformed structures", () => {
    expect(
      parseAgentMarkdown(
        '---\nname: inspect\ntools: [Read, "Bash(git:*)"]\ndescription: >-\n  Inspect code\n  with care\nmaxTurns: 3\n---\nInstructions',
      ).metadata,
    ).toEqual({
      name: "inspect",
      tools: ["Read", "Bash(git:*)"],
      description: "Inspect code with care",
      maxTurns: 3,
    });
    expect(
      parseAgentMarkdown("---\ntools:\n  - Read\n  - Grep\n---\nbody").metadata
        .tools,
    ).toEqual(["Read", "Grep"]);
    expect(() => parseAgentMarkdown("---\nname: a")).toThrow("Unterminated");
    expect(() => parseAgentMarkdown("---\nname: a\nname: b\n---\nx")).toThrow(
      "unique",
    );
    expect(
      parseAgentMarkdown("---\nhooks:\n  nested: value\n---\nx").metadata.hooks,
    ).toEqual({ nested: "value" });
  });
  test("loads namespaced skills and nested commands, substitutes arguments and plugin roots", async () => {
    const { cwd, configuration, invoke } = await setup();
    const plugin = join(cwd, "plugin");
    await mkdir(join(plugin, "skills", "review"), { recursive: true });
    await mkdir(join(plugin, "commands", "group"), { recursive: true });
    await writeFile(
      join(plugin, "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review files\nallowed-tools: Read, Grep\n---\nAll $ARGUMENTS; first $0; second $ARGUMENTS[1]; root ${CLAUDE_PLUGIN_ROOT}; dir ${CODEX_SKILL_DIR}; data ${CODEX_PLUGIN_DATA}",
    );
    await writeFile(
      join(plugin, "commands", "group", "inspect.md"),
      "Inspect $1",
    );
    configuration.plugins.push({
      name: "example",
      root: plugin,
      dataDirectory: join(cwd, "data"),
      manifest: {},
    });
    configuration.skillDirectories.push({
      directory: join(plugin, "skills"),
      namespace: "example",
      pluginRoot: plugin,
    });
    configuration.commandDirectories.push({
      directory: join(plugin, "commands"),
      namespace: "example",
      pluginRoot: plugin,
    });
    expect(await invoke("Skill", {})).toContain("example:group:inspect");
    const result = JSON.parse(
      await invoke("Skill", {
        skill: "example:review",
        args: '"file one" file2',
      }),
    );
    expect(result.instructions).toContain("first file one; second file2");
    expect(result.instructions).toContain(plugin);
    expect(result.instructions).toContain(join(cwd, "data"));
    expect(result.metadata["allowed-tools"]).toBe("Read, Grep");
    expect(await invoke("Skill", { skill: "missing" })).toContain("Unknown");
  });
  test("does not follow component symlinks or allow model-only invocation of manual commands", async () => {
    const { cwd, configuration, invoke, options } = await setup();
    const root = join(cwd, "commands");
    await mkdir(root);
    await writeFile(join(cwd, "outside.md"), "outside");
    await symlink(join(cwd, "outside.md"), join(root, "linked.md"));
    await writeFile(
      join(root, "manual.md"),
      "---\ndisable-model-invocation: true\n---\nmanual $ARGUMENTS",
    );
    configuration.commandDirectories.push({ directory: root });
    expect(await invoke("Skill", {})).not.toContain("linked");
    expect(await invoke("Skill", { skill: "manual" })).toContain("disables");
    expect(
      (await resolveAgentCommand("/manual hello", configuration, options))
        ?.instructions,
    ).toBe("manual hello");
  });
  test("runs configured subagents through the callback with inherited read-only permissions and metadata", async () => {
    let request: SubagentRequest | undefined;
    const { cwd, configuration, invoke } = await setup({
      sandboxMode: "read-only",
      runSubagent: async (input) => {
        request = input;
        return "finished";
      },
    });
    await mkdir(join(cwd, "agents"));
    await writeFile(
      join(cwd, "agents", "auditor.md"),
      "---\nname: audit\ntools: Read, Grep\ndisallowedTools: Bash\nmodel: gpt-test\nmaxTurns: 5\n---\nInspect $ARGUMENTS",
    );
    configuration.agentDirectories.push({
      directory: join(cwd, "agents"),
      namespace: "plugin",
    });
    expect(await invoke("Task", {})).toContain("plugin:audit");
    expect(
      await invoke("Task", {
        subagent_type: "plugin:audit",
        prompt: "code",
        description: "audit",
      }),
    ).toBe("finished");
    expect(request?.instructions).toBe("Inspect code");
    expect(request?.allowedTools).toEqual(["Read", "Grep"]);
    expect(request?.disallowedTools).toEqual(["Bash"]);
    expect(request?.model).toBe("gpt-test");
    expect(request?.maxTurns).toBe(5);
    expect(request?.permissionOptions.sandboxMode).toBe("read-only");
    expect(request?.signal.aborted).toBe(true);
    expect(
      await invoke("Task", { subagent_type: "unknown", prompt: "code" }),
    ).toContain("Unknown");
  });
  test("Task passes permission, memory, isolation, and resume metadata without weakening parent denies", async () => {
    let request: SubagentRequest | undefined;
    const { cwd, configuration, invoke } = await setup({
      disallowedTools: ["Write"],
      runSubagent: async (value) => {
        request = value;
        return "resumed";
      },
    });
    const agents = join(cwd, "agents");
    await mkdir(agents);
    await writeFile(
      join(agents, "remember.md"),
      "---\npermissionMode: acceptEdits\nmemory: local\nisolation: worktree\n---\nRemember useful details",
    );
    configuration.agentDirectories.push({ directory: agents });
    const resumeId = "da6c7f40-7d32-4cc2-87c0-f3a45409dd14";
    expect(
      await invoke("Task", {
        subagent_type: "remember",
        prompt: "continue",
        resume_task_id: resumeId,
      }),
    ).toBe("resumed");
    expect(request?.resumeTaskId).toBe(resumeId);
    expect(request?.permissionOptions.permissionMode).toBe("acceptEdits");
    expect(request?.permissionOptions.disallowedTools).toContain("Write");
    expect(request?.memoryScope).toBe("local");
    expect(request?.isolation).toBe("worktree");
    expect(
      await invoke("Task", {
        subagent_type: "remember",
        prompt: "bad id",
        resume_task_id: "../bad",
      }),
    ).toContain("Invalid subagent resume ID");
  });
  test("normal skills apply metadata callbacks and forked skills run the selected read-only agent", async () => {
    let loaded:
      | import("../src/agent-additional-tools").LoadedAgentSkill
      | undefined;
    let request: SubagentRequest | undefined;
    const { cwd, configuration, invoke } = await setup({
      allowedTools: ["Skill"],
      onSkillLoaded: async (value) => {
        loaded = value;
      },
      runSubagent: async (value) => {
        request = value;
        return "fork result";
      },
    });
    await mkdir(join(cwd, "skills", "normal"), { recursive: true });
    await mkdir(join(cwd, "skills", "fork"), { recursive: true });
    await writeFile(
      join(cwd, "skills", "normal", "SKILL.md"),
      "---\nallowed-tools: Bash(printf:*)\nmodel: gpt-test\n---\nPrepared !`printf ready`",
    );
    await writeFile(
      join(cwd, "skills", "fork", "SKILL.md"),
      "---\ncontext: fork\nagent: Explore\nmodel: gpt-child\n---\nInspect $ARGUMENTS",
    );
    configuration.skillDirectories.push({ directory: join(cwd, "skills") });
    expect(
      JSON.parse(await invoke("Skill", { skill: "normal" })).instructions,
    ).toBe("Prepared ready");
    expect(loaded?.allowedTools).toEqual(["Bash(printf:*)"]);
    expect(loaded?.model).toBe("gpt-test");
    expect(await invoke("Skill", { skill: "fork", args: "files" })).toBe(
      "fork result",
    );
    expect(request?.name).toBe("Explore");
    expect(request?.prompt).toBe("Inspect files");
    expect(request?.permissionOptions.sandboxMode).toBe("read-only");
    expect(request?.model).toBe("gpt-child");
    expect(loaded?.name).toBe("normal");
  });
  test("native Explore and Plan inherit a read-only tool set and custom definitions override names", async () => {
    let request: SubagentRequest | undefined;
    const { cwd, configuration, invoke } = await setup({
      runSubagent: async (input) => {
        request = input;
        return "done";
      },
    });
    expect(
      await invoke("Task", { subagent_type: "Explore", prompt: "inspect" }),
    ).toBe("done");
    expect(request?.permissionOptions.sandboxMode).toBe("read-only");
    expect(request?.allowedTools).not.toContain("Bash");
    await mkdir(join(cwd, "agents"));
    await writeFile(
      join(cwd, "agents", "custom.md"),
      "---\nname: general-purpose\n---\nCustom agent",
    );
    configuration.agentDirectories.push({ directory: join(cwd, "agents") });
    const second = createAdditionalAgentTools({
      ...{ cwd, configuration, env: {}, allowedTools: ["Task"] },
      runSubagent: async (input) => {
        request = input;
        return "custom";
      },
    });
    closers.push(second.close);
    const task = second.tools.find(
      (item) => item.name === "Task",
    ) as FunctionTool;
    await task.invoke(
      new RunContext(),
      JSON.stringify({ subagent_type: "general-purpose", prompt: "go" }),
    );
    expect(request?.instructions).toBe("Custom agent");
  });
  test("PermissionRequest can approve one callback while deny and ask rules still win", async () => {
    let approved = 0;
    const { invoke } = await setup({
      allowedTools: [],
      permissionRequest: async () => ({ permissionDecision: "allow" }),
      search: async () => {
        approved++;
        return "yes";
      },
    });
    expect(await invoke("WebSearch", { query: "question" })).toBe("yes");
    expect(approved).toBe(1);
    const denied = await setup({
      allowedTools: [],
      disallowedTools: ["WebSearch"],
      permissionRequest: async () => ({ permissionDecision: "allow" }),
      search: async () => "bad",
    });
    expect(await denied.invoke("WebSearch", { query: "question" })).toContain(
      "denied",
    );
  });
  test("dontAsk rejects unapproved additional tools without invoking PermissionRequest", async () => {
    let requests = 0;
    let searches = 0;
    const { invoke } = await setup({
      allowedTools: [],
      permissionMode: "dontAsk",
      permissionRequest: async () => {
        requests++;
        return { permissionDecision: "allow" };
      },
      search: async () => {
        searches++;
        return "unexpected search";
      },
    });
    expect(await invoke("WebSearch", { query: "question" })).toContain(
      "not allowed without approval",
    );
    expect(requests).toBe(0);
    expect(searches).toBe(0);
  });
  test("rechecks permissions after hooks and reports errors once", async () => {
    const events: boolean[] = [];
    let called = false;
    const { invoke } = await setup({
      allowedTools: ["WebSearch(good)"],
      beforeTool: async () => ({ updatedInput: { query: "denied" } }),
      afterTool: async (event) => {
        events.push(!!event.error);
      },
      search: async () => {
        called = true;
        return "bad";
      },
    });
    expect(await invoke("WebSearch", { query: "good" })).toContain(
      "not allowed",
    );
    expect(called).toBe(false);
    expect(events).toEqual([true]);
  });
  test("fetches redirected local HTTP text without cookies/auth and supplies sanitized content", async () => {
    const { base, received } = await serve();
    let request: SummarizeRequest | undefined;
    const { invoke } = await setup({
      summarize: async (input) => {
        request = input;
        return "summary";
      },
    });
    expect(
      await invoke("WebFetch", {
        url: `${base}/redirect#fragment`,
        prompt: "Explain",
      }),
    ).toBe("summary");
    expect(request?.url).toBe(`${base}/page`);
    expect(request?.content).toContain("Visible & A");
    expect(request?.content).not.toContain("secret");
    expect(request?.content).not.toContain("onclick");
    expect(request?.prompt).toBe("Explain");
    expect(
      received.every((headers) => !headers.authorization && !headers.cookie),
    ).toBe(true);
    expect(
      await invoke("WebFetch", { url: "file:///etc/passwd", prompt: "read" }),
    ).toContain("HTTP(S)");
    expect(
      await invoke("WebFetch", {
        url: base.replace("//", "//user:password@"),
        prompt: "read",
      }),
    ).toContain("credentials");
  });
  test("redirected domains cannot bypass WebFetch scoped denials", async () => {
    const { base, received } = await serve();
    let summaries = 0;
    const { invoke } = await setup({
      allowedTools: ["WebFetch(domain:127.0.0.1)"],
      disallowedTools: ["WebFetch(domain:localhost)"],
      summarize: async () => {
        summaries++;
        return "bad";
      },
    });
    expect(
      await invoke("WebFetch", { url: `${base}/escape`, prompt: "read" }),
    ).toContain("denied");
    expect(received).toHaveLength(1);
    expect(summaries).toBe(0);
  });
  test("rejects oversized, binary, error and looping web responses", async () => {
    const { base } = await serve();
    let calls = 0;
    const { invoke } = await setup({
      fetchMaxBytes: 256,
      summarize: async () => {
        calls++;
        return "summary";
      },
    });
    expect(
      await invoke("WebFetch", { url: `${base}/large`, prompt: "read" }),
    ).toContain("exceeds");
    expect(
      await invoke("WebFetch", { url: `${base}/binary`, prompt: "read" }),
    ).toContain("content type");
    expect(
      await invoke("WebFetch", { url: `${base}/error`, prompt: "read" }),
    ).toContain("HTTP 500");
    expect(
      await invoke("WebFetch", { url: `${base}/loop`, prompt: "read" }),
    ).toContain("redirect limit");
    expect(calls).toBe(0);
  });
  test("search passes domain filters and bounds callback output", async () => {
    let request: SearchRequest | undefined;
    const { invoke } = await setup({
      maxOutputBytes: 256,
      search: async (input) => {
        request = input;
        return "x".repeat(1000);
      },
    });
    expect(
      await invoke("WebSearch", {
        query: "question",
        allowed_domains: ["example.com"],
        blocked_domains: ["bad.example"],
      }),
    ).toContain("truncated");
    expect(request?.allowedDomains).toEqual(["example.com"]);
    expect(request?.blockedDomains).toEqual(["bad.example"]);
    expect(
      await invoke("WebSearch", {
        query: "question",
        allowed_domains: ["https://example.com"],
      }),
    ).toContain("domain names");
  });
  test("callback deadline/cancellation stops waiting and close disables tools", async () => {
    let signal: AbortSignal | undefined;
    const { invoke, close } = await setup({
      toolTimeoutMs: 25,
      search: async (input) => {
        signal = input.signal;
        return new Promise(() => {});
      },
    });
    expect(await invoke("WebSearch", { query: "slow" })).toContain("timed out");
    expect(signal?.aborted).toBe(true);
    await close();
    expect(await invoke("Skill", {})).toContain("cancelled");
    const controller = new AbortController();
    controller.abort();
    const second = await setup({ signal: controller.signal });
    expect(await second.invoke("Skill", {})).toContain("cancelled");
  });
  test("explicit command preprocesses snippets under allowed-tools without expanding argument shell code", async () => {
    const { cwd, configuration, options } = await setup();
    await mkdir(join(cwd, "commands"));
    await writeFile(
      join(cwd, "commands", "inspect.md"),
      "---\nallowed-tools: Bash(printf:*)\nmodel: gpt-test\n---\nValue !`printf okay`; args $ARGUMENTS",
    );
    configuration.commandDirectories.push({ directory: join(cwd, "commands") });
    const resolved = await resolveAgentCommand(
      "/inspect literal $(touch escaped)",
      configuration,
      options,
    );
    expect(resolved?.instructions).toBe(
      "Value okay; args literal $(touch escaped)",
    );
    expect(
      (
        await resolveAgentCommand(
          "/inspect !`touch escaped`",
          configuration,
          options,
        )
      )?.instructions,
    ).toBe("Value okay; args !`touch escaped`");
    expect(resolved?.allowedTools).toEqual(["Bash(printf:*)"]);
    expect(resolved?.model).toBe("gpt-test");
    expect(
      await readFile(join(cwd, "commands", "inspect.md"), "utf8"),
    ).toContain("!`printf okay`");
    await expect(
      resolveAgentCommand("/inspect", configuration, {
        ...options,
        disallowedTools: ["Bash"],
      }),
    ).rejects.toThrow("denied");
    await expect(
      resolveAgentCommand("/inspect", configuration, {
        ...options,
        sandboxMode: "read-only",
      }),
    ).rejects.toThrow("read-only");
    await expect(
      resolveAgentCommand("/missing", configuration, options),
    ).rejects.toThrow("Unknown");
    expect(
      await resolveAgentCommand("normal prompt", configuration, options),
    ).toBeUndefined();
  });
});
