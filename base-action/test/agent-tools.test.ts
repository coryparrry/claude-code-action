import { afterEach, describe, expect, test } from "bun:test";
import { RunContext, type FunctionTool } from "@openai/agents";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentTools,
  type AgentToolOptions,
  type BackgroundAgentTask,
} from "../src/agent-tools";
import { AgentPermissions } from "../src/agent-permissions";

const directories: string[] = [];
async function setup(options: Partial<AgentToolOptions> = {}) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agent-tools-")));
  directories.push(cwd);
  const tools = createAgentTools({
    cwd,
    env: { PATH: "/usr/bin:/bin", BUILD_LABEL: "explicit-test-env" },
    allowedTools: [
      "Bash",
      "PowerShell",
      "Read",
      "Write",
      "Edit",
      "NotebookEdit",
      "Glob",
      "Grep",
      "LS",
      "TodoWrite",
      "BashOutput",
      "KillShell",
    ],
    ...options,
  });
  async function invokeRaw(name: string, input: Record<string, unknown>) {
    const selected = tools.find(
      (candidate) => candidate.name === name,
    ) as FunctionTool;
    expect(selected?.type).toBe("function");
    return selected.invoke(new RunContext(), JSON.stringify(input));
  }
  async function invoke(name: string, input: Record<string, unknown>) {
    return String(await invokeRaw(name, input));
  }
  return { cwd, invoke, invokeRaw, tools };
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("real SDK local tools", () => {
  test("background shell registry exposes shared output, stop, and completion", async () => {
    const tasks = new Map<string, BackgroundAgentTask>();
    const { invoke } = await setup({ backgroundTasks: tasks });
    const result = JSON.parse(
      await invoke("Bash", { command: "sleep 10", run_in_background: true }),
    );
    const task = tasks.get(result.shell_id);
    expect(task?.type).toBe("shell");
    expect(task?.getOutput()).toContain("running");
    expect(await task?.stop()).toContain("exit code");
    await task?.done;
    expect(tasks.has(result.shell_id)).toBe(false);
  });

  test("plan entry shares readonly state and exit needs explicit approval before restoring mode", async () => {
    let exitRequests = 0;
    const { invoke } = await setup({
      permissionMode: "acceptEdits",
      permissionRequest: async ({ name }) => {
        if (name === "ExitPlanMode") {
          exitRequests++;
          return { permissionDecision: "allow" };
        }
      },
    });
    expect(JSON.parse(await invoke("EnterPlanMode", {})).message).toContain(
      "Entered plan mode",
    );
    expect(
      await invoke("Write", { file_path: "a", content: "blocked" }),
    ).toContain("read-only/plan");
    expect(
      JSON.parse(
        await invoke("ExitPlanMode", {
          plan: "Approved plan",
          allowedPrompts: [{ tool: "Bash", prompt: "run tests" }],
        }),
      ),
    ).toEqual({ plan: "Approved plan", isAgent: false });
    expect(exitRequests).toBe(1);
    expect(
      await invoke("Write", { file_path: "a", content: "after approval" }),
    ).toContain("Wrote");
    const noApproval = await setup({ permissionMode: "bypassPermissions" });
    await noApproval.invoke("EnterPlanMode", {});
    expect(await noApproval.invoke("ExitPlanMode", {})).toContain(
      "without approval",
    );
    expect(
      await noApproval.invoke("Write", {
        file_path: "a",
        content: "still blocked",
      }),
    ).toContain("read-only/plan");
  });

  test("AskUserQuestion preserves native question/answer fields and requires trusted injection", async () => {
    const questions = [
      {
        question: "Which mode?",
        header: "Mode",
        options: [
          { label: "First", description: "Use first", preview: "preview" },
          { label: "Second", description: "Use second" },
        ],
        multiSelect: false,
      },
    ];
    const denied = await setup({ permissionMode: "bypassPermissions" });
    expect(
      await denied.invoke("AskUserQuestion", {
        questions,
        answers: { "Which mode?": "First" },
      }),
    ).toContain("without approval");
    const injected = await setup({
      beforeTool: async ({ name, input }) =>
        name === "AskUserQuestion"
          ? {
              updatedInput: {
                ...input,
                answers: { "Which mode?": "Second" },
                annotations: {
                  "Which mode?": { preview: "preview", notes: "chosen" },
                },
              },
            }
          : undefined,
    });
    expect(
      JSON.parse(
        await injected.invoke("AskUserQuestion", {
          questions,
          metadata: { source: "test" },
        }),
      ),
    ).toEqual({
      questions,
      answers: { "Which mode?": "Second" },
      annotations: { "Which mode?": { preview: "preview", notes: "chosen" } },
    });
    const requestInjected = await setup({
      permissionRequest: async ({ input }) => ({
        updatedInput: { ...input, answers: { "Which mode?": "First" } },
      }),
    });
    expect(
      JSON.parse(await requestInjected.invoke("AskUserQuestion", { questions }))
        .answers,
    ).toEqual({ "Which mode?": "First" });
    expect(
      await injected.invoke("AskUserQuestion", { questions: [] }),
    ).toContain("error");
    const globalAsk = await setup({
      askTools: ["*"],
      beforeTool: async ({ input }) => ({
        permissionDecision: "allow",
        updatedInput: { ...input, answers: { "Which mode?": "First" } },
      }),
    });
    expect(await globalAsk.invoke("AskUserQuestion", { questions })).toContain(
      "ask rule",
    );
  });

  test("default permission modes preapprove reads and ask before unlisted writes", async () => {
    let requests = 0;
    const { cwd, invoke } = await setup({
      allowedTools: ["Read(src/**)"],
      permissionRequest: async () => {
        requests++;
        return { permissionDecision: "allow" };
      },
    });
    await writeFile(join(cwd, "outside-scoped-allow.txt"), "readable");
    expect(
      await invoke("Read", { file_path: "outside-scoped-allow.txt" }),
    ).toContain("readable");
    expect(requests).toBe(0);
    expect(
      await invoke("Write", { file_path: "new.txt", content: "approved" }),
    ).toContain("Wrote");
    expect(requests).toBe(1);
    const headless = await setup({ allowedTools: ["Read"] });
    expect(
      await headless.invoke("Write", { file_path: "denied", content: "bad" }),
    ).toContain("without approval");
  });

  test("hook grants are per-call and cannot bypass deny or global ask rules", async () => {
    let beforeCalls = 0,
      requests = 0;
    const single = await setup({
      allowedTools: ["Read"],
      beforeTool: async () => {
        beforeCalls++;
        return beforeCalls === 1 ? { permissionDecision: "allow" } : undefined;
      },
    });
    expect(
      await single.invoke("Write", { file_path: "a", content: "first" }),
    ).toContain("Wrote");
    expect(
      await single.invoke("Write", { file_path: "a", content: "second" }),
    ).toContain("without approval");
    for (const policy of [
      { disallowedTools: ["Write"] },
      { askTools: ["*"] },
    ]) {
      const blocked = await setup({
        ...policy,
        permissionMode: "bypassPermissions",
        beforeTool: async () => ({ permissionDecision: "allow" }),
        permissionRequest: async () => {
          requests++;
          return { permissionDecision: "allow" };
        },
      });
      expect(
        await blocked.invoke("Write", { file_path: "blocked", content: "bad" }),
      ).toMatch(/denied|ask rule/);
    }
    expect(requests).toBe(0);
  });

  test("PermissionRequest can rewrite input and update shared session approvals", async () => {
    const { cwd } = await setup();
    const shared = new AgentPermissions({ cwd, allowedTools: ["Read"] });
    let requests = 0;
    const fixture = await setup({
      cwd,
      permissions: shared,
      permissionRequest: async () => {
        requests++;
        return {
          permissionDecision: "allow",
          updatedInput: { file_path: "approved.txt", content: "rewritten" },
          updatedPermissions: [
            {
              type: "addRules",
              behavior: "allow",
              rules: [{ toolName: "Write" }],
              destination: "session",
            },
          ],
        };
      },
    });
    expect(
      await fixture.invoke("Write", {
        file_path: "original.txt",
        content: "original",
      }),
    ).toContain("Wrote");
    expect(await readFile(join(cwd, "approved.txt"), "utf8")).toBe("rewritten");
    expect(
      await fixture.invoke("Write", { file_path: "next.txt", content: "next" }),
    ).toContain("Wrote");
    expect(requests).toBe(1);
    shared.applyUpdates([
      {
        type: "addRules",
        behavior: "deny",
        rules: [{ toolName: "Write", ruleContent: "private/**" }],
      },
    ]);
    expect(
      await fixture.invoke("Write", {
        file_path: "private/file",
        content: "bad",
      }),
    ).toContain("denied");
  });

  test("acceptEdits autoapproves supported workspace shell edits and rejects escapes", async () => {
    const { cwd, invoke } = await setup({
      permissionMode: "acceptEdits",
      allowedTools: ["Read"],
    });
    expect(
      await invoke("Bash", { command: "mkdir -p src; touch src/a" }),
    ).toContain("without approval");
    expect(await invoke("Bash", { command: "mkdir -p src" })).toContain(
      "exit code: 0",
    );
    expect(await invoke("Bash", { command: "touch src/a" })).toContain(
      "exit code: 0",
    );
    expect(await invoke("Bash", { command: "touch ../escape" })).toContain(
      "without approval",
    );
    const outside = await setup();
    await symlink(outside.cwd, join(cwd, "alias"));
    expect(await invoke("Bash", { command: "touch alias/escape" })).toContain(
      "Symlink",
    );
    expect(await invoke("Bash", { command: "rm -rf ." })).toContain(
      "without approval",
    );
    expect(
      await invoke("Bash", { command: "sed -i 's/x/y/e' src/a" }),
    ).toContain("without approval");
  });

  test("PowerShell fails clearly on unsupported platforms and obeys readonly policy", async () => {
    if (process.platform !== "win32") {
      const { invoke } = await setup();
      expect(
        await invoke("PowerShell", { command: "Write-Output test" }),
      ).toContain("only on Windows");
      const readonly = await setup({ sandboxMode: "read-only" });
      expect(
        await readonly.invoke("PowerShell", { command: "Write-Output test" }),
      ).toContain("read-only/plan");
    }
  });

  test("Read emits SDK-native images/PDFs while hooks receive only metadata", async () => {
    const hookOutputs: string[] = [];
    const { cwd, invokeRaw, invoke } = await setup({
      sandboxMode: "read-only",
      beforeTool: async () => ({ additionalContext: "media hook context" }),
      afterTool: async ({ output }) => {
        if (output) hookOutputs.push(output);
      },
    });
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(cwd, "pixel.png"), image);
    const result = (await invokeRaw("Read", { file_path: "pixel.png" })) as {
      type: string;
      image?: { data: Uint8Array; mediaType: string };
      text?: string;
    }[];
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]?.type).toBe("image");
    expect(result[0]?.image?.mediaType).toBe("image/png");
    expect(Buffer.from(result[0]!.image!.data)).toEqual(image);
    expect(result[1]).toEqual({ type: "text", text: "media hook context" });
    expect(hookOutputs[0]).toBe("[structured image content]");
    expect(hookOutputs[0]).not.toContain(image.toString("base64"));
    const pdf = Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
    );
    await writeFile(join(cwd, "document.pdf"), pdf);
    const fileResult = (await invokeRaw("Read", {
      file_path: "document.pdf",
    })) as {
      type: string;
      file?: { data: Uint8Array; mediaType: string; filename: string };
    }[];
    expect(fileResult[0]?.type).toBe("file");
    expect(fileResult[0]?.file?.mediaType).toBe("application/pdf");
    expect(fileResult[0]?.file?.filename).toBe("document.pdf");
    expect(Buffer.from(fileResult[0]!.file!.data)).toEqual(pdf);
    expect(hookOutputs[1]).toBe("[structured file content: document.pdf]");
    expect(
      await invoke("Read", { file_path: "pixel.png", offset: 1 }),
    ).toContain("only to text");
  });

  test("Read recognizes supported signatures and rejects unsupported/oversized binaries", async () => {
    const { cwd, invokeRaw, invoke } = await setup();
    for (const [name, data, mediaType] of [
      ["photo.jpg", Buffer.from([255, 216, 255, 224, 0, 16]), "image/jpeg"],
      [
        "animation.gif",
        Buffer.from("GIF89a\u0001\u0000\u0001\u0000"),
        "image/gif",
      ],
      ["photo.webp", Buffer.from("RIFFxxxxWEBPVP8 "), "image/webp"],
    ] as const) {
      await writeFile(join(cwd, name), data);
      const output = (await invokeRaw("Read", { file_path: name })) as {
        type: string;
        image: { data: Uint8Array; mediaType: string };
      }[];
      expect(output[0]?.type).toBe("image");
      expect(output[0]?.image.mediaType).toBe(mediaType);
      expect(Buffer.from(output[0]!.image.data)).toEqual(data);
    }
    await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    expect(await invoke("Read", { file_path: "binary.bin" })).toContain(
      "Unsupported binary file",
    );
    await writeFile(join(cwd, "fake.png"), "plain text");
    expect(await invoke("Read", { file_path: "fake.png" })).toContain(
      "invalid image/PDF",
    );
    await writeFile(join(cwd, "huge.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(await invoke("Read", { file_path: "huge.bin" })).toContain("8 MiB");
  });

  test("writes, reads, edits exact literals, and refuses ambiguous/missing edits", async () => {
    const { cwd, invoke } = await setup();
    expect(
      await invoke("Write", {
        file_path: "nested/a.txt",
        content: "one\ntwo two\n",
      }),
    ).toContain("Wrote");
    expect(
      await invoke("Read", { file_path: "nested/a.txt", offset: 2, limit: 1 }),
    ).toBe("2\ttwo two");
    expect(
      await invoke("Edit", {
        file_path: "nested/a.txt",
        old_string: "two",
        new_string: "three",
      }),
    ).toContain("ambiguous");
    expect(
      await invoke("Edit", {
        file_path: "nested/a.txt",
        old_string: "missing",
        new_string: "three",
      }),
    ).toContain("not found");
    await invoke("Edit", {
      file_path: "nested/a.txt",
      old_string: "two",
      new_string: "$& literal",
      replace_all: true,
    });
    expect(await readFile(join(cwd, "nested/a.txt"), "utf8")).toBe(
      "one\n$& literal $& literal\n",
    );
    expect(
      await invoke("MultiEdit", {
        file_path: "nested/a.txt",
        edits: [
          { old_string: "one", new_string: "changed" },
          { old_string: "not present", new_string: "fail" },
        ],
      }),
    ).toContain("not found");
    expect(await readFile(join(cwd, "nested/a.txt"), "utf8")).toContain("one");
    expect(
      await invoke("MultiEdit", {
        file_path: "nested/a.txt",
        edits: [{ old_string: "one", new_string: "changed" }],
      }),
    ).toContain("Applied 1");
  });

  test("finds files and content, without traversing symlinks", async () => {
    const { cwd, invoke } = await setup();
    const outside = await setup();
    await invoke("Write", { file_path: "src/a.ts", content: "Alpha\nbeta\n" });
    await invoke("Write", { file_path: "src/nested/b.ts", content: "beta\n" });
    await writeFile(join(outside.cwd, "secret.ts"), "beta\n");
    await symlink(outside.cwd, join(cwd, "linked"));
    expect(await invoke("Glob", { pattern: "**/*.ts" })).toBe(
      "src/a.ts\nsrc/nested/b.ts",
    );
    expect(await invoke("LS", { path: "." })).toBe("linked [symlink]\nsrc/");
    expect(await invoke("LS", { path: "src", ignore: ["*.ts"] })).toBe(
      "nested/",
    );
    expect(await invoke("Grep", { pattern: "ALPHA", "-i": true })).toBe(
      "src/a.ts:1:Alpha",
    );
    expect(await invoke("Grep", { pattern: "beta", glob: "src/*.ts" })).toBe(
      "src/a.ts:2:beta",
    );
    expect(await invoke("Grep", { pattern: "[" })).toContain("error");
    expect(await invoke("Read", { file_path: "linked/secret.ts" })).toContain(
      "Symlink",
    );
    expect(
      await invoke("Write", { file_path: "../escape", content: "bad" }),
    ).toContain("outside");
  });

  test("edits notebook cells and maintains todos", async () => {
    const { cwd, invoke } = await setup();
    await writeFile(
      join(cwd, "a.ipynb"),
      JSON.stringify({
        nbformat: 4,
        cells: [
          {
            id: "first",
            cell_type: "code",
            source: ["old"],
            outputs: ["stale"],
            execution_count: 5,
            metadata: {},
          },
        ],
      }),
    );
    expect(
      await invoke("NotebookEdit", {
        notebook_path: "a.ipynb",
        cell_id: "first",
        new_source: "new\nline",
      }),
    ).toContain("replace");
    let notebook = JSON.parse(await readFile(join(cwd, "a.ipynb"), "utf8"));
    expect(notebook.cells[0].source).toEqual(["new\n", "line"]);
    expect(notebook.cells[0].outputs).toEqual([]);
    await invoke("NotebookEdit", {
      notebook_path: "a.ipynb",
      cell_index: 1,
      edit_mode: "insert",
      cell_type: "markdown",
      new_source: "notes",
    });
    await invoke("NotebookEdit", {
      notebook_path: "a.ipynb",
      cell_index: 0,
      edit_mode: "delete",
      new_source: "",
    });
    notebook = JSON.parse(await readFile(join(cwd, "a.ipynb"), "utf8"));
    expect(notebook.cells).toHaveLength(1);
    expect(notebook.cells[0].cell_type).toBe("markdown");
    expect(
      await invoke("TodoWrite", {
        todos: [
          { content: "verify", activeForm: "verifying", status: "in_progress" },
        ],
      }),
    ).toContain("in_progress");
  });

  test("shell receives only explicitly supplied environment and captures bounded output", async () => {
    const { invoke } = await setup({ maxOutputBytes: 256 });
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "parent-auth-must-not-leak";
    try {
      expect(
        await invoke("Bash", {
          command: 'printf \'%s|%s\' "$BUILD_LABEL" "$OPENAI_API_KEY"',
        }),
      ).toContain("explicit-test-env|");
      expect(
        await invoke("Bash", { command: "printf '%s' \"$OPENAI_API_KEY\"" }),
      ).not.toContain("parent-auth");
      expect(
        await invoke("Bash", { command: "yes output | head -c 2000" }),
      ).toContain("truncated");
      expect(
        await invoke("Bash", { command: "echo stderr >&2; exit 7" }),
      ).toContain("exit code: 7");
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  test("shell timeouts terminate and background jobs can be read and stopped", async () => {
    const { invoke } = await setup();
    expect(
      await invoke("Bash", { command: "sleep 10", timeout: 20 }),
    ).toContain("timed out");
    const output = JSON.parse(
      await invoke("Bash", {
        command: "echo started; sleep 10",
        run_in_background: true,
      }),
    );
    expect(await invoke("BashOutput", { bash_id: output.shell_id })).toContain(
      "running",
    );
    expect(await invoke("KillShell", { shell_id: output.shell_id })).toContain(
      "exit code",
    );
    expect(await invoke("KillShell", { shell_id: "unknown" })).toContain(
      "Unknown",
    );
  });

  test("hooks cannot rewrite an allowed input to escape policy and after receives errors", async () => {
    const events: string[] = [];
    const { invoke } = await setup({
      allowedTools: ["Bash(gh:*)"],
      beforeTool: async () => ({ updatedInput: { command: "touch denied" } }),
      afterTool: async (event) => {
        events.push(event.error ? "error" : "success");
      },
    });
    expect(await invoke("Bash", { command: "gh issue view 1" })).toContain(
      "not allowed",
    );
    expect(events).toEqual(["error"]);
    const second = await setup({
      beforeTool: async () => ({ additionalContext: "hook context" }),
    });
    expect(await second.invoke("TodoWrite", { todos: [] })).toBe(
      "[]\nhook context",
    );
  });

  test("read-only mode refuses mutation through SDK execution", async () => {
    const { cwd, invoke } = await setup({ sandboxMode: "read-only" });
    await writeFile(join(cwd, "a.txt"), "original");
    expect(await invoke("Read", { file_path: "a.txt" })).toContain("original");
    for (const [name, input] of [
      ["Bash", { command: "touch a.txt" }],
      ["Write", { file_path: "a.txt", content: "bad" }],
      [
        "Edit",
        { file_path: "a.txt", old_string: "original", new_string: "bad" },
      ],
      [
        "MultiEdit",
        {
          file_path: "a.txt",
          edits: [{ old_string: "original", new_string: "bad" }],
        },
      ],
      ["NotebookEdit", { notebook_path: "a.txt", new_source: "bad" }],
    ] as const)
      expect(await invoke(name, input)).toContain("read-only/plan");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("original");
  });

  test("pre-aborted and expired calls fail before execution", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await setup({ signal: controller.signal });
    expect(await cancelled.invoke("Bash", { command: "echo fail" })).toContain(
      "cancelled",
    );
    const expired = await setup({ deadline: Date.now() - 1 });
    expect(
      await expired.invoke("Write", { file_path: "a", content: "bad" }),
    ).toContain("timed out");
  });

  test("active cancellation and deadlines stop shell side effects", async () => {
    const controller = new AbortController();
    const cancelled = await setup({ signal: controller.signal });
    const running = cancelled.invoke("Bash", {
      command: "sleep 0.2; touch escaped",
    });
    const timer = setTimeout(() => controller.abort(), 15);
    expect(await running).toContain("cancelled");
    clearTimeout(timer);
    const expired = await setup({ deadline: Date.now() + 25 });
    expect(
      await expired.invoke("Bash", { command: "sleep 0.2; touch escaped" }),
    ).toContain("timed out");
    await new Promise((done) => setTimeout(done, 220));
    await expect(access(join(cancelled.cwd, "escaped"))).rejects.toThrow();
    await expect(access(join(expired.cwd, "escaped"))).rejects.toThrow();
  });

  test("adversarial regular expressions remain bounded by deadline", async () => {
    const { cwd, invoke } = await setup({ deadline: Date.now() + 100 });
    await writeFile(join(cwd, "a.txt"), "a".repeat(50000) + "!");
    expect(await invoke("Grep", { pattern: "(a+)+$" })).toContain("timed out");
  });

  test("post hooks execute once even when the hook itself fails", async () => {
    let count = 0;
    const { invoke } = await setup({
      afterTool: async () => {
        count++;
        throw new Error("post hook failed");
      },
    });
    expect(await invoke("TodoWrite", { todos: [] })).toContain(
      "post hook failed",
    );
    expect(count).toBe(1);
  });

  test("original tag tool list plus acceptEdits allows workspace changes", async () => {
    const { cwd, invoke } = await setup({
      permissionMode: "acceptEdits",
      allowedTools: ["Glob", "Grep", "LS", "Read", "Bash(git:*)"],
    });
    expect(
      await invoke("Write", { file_path: "a.txt", content: "original" }),
    ).toContain("Wrote");
    expect(
      await invoke("Edit", {
        file_path: "a.txt",
        old_string: "original",
        new_string: "changed",
      }),
    ).toContain("Edited");
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("changed");
    expect(
      await invoke("Write", { file_path: "../outside", content: "denied" }),
    ).toContain("outside");
    const denied = await setup({
      permissionMode: "acceptEdits",
      allowedTools: ["Read"],
      disallowedTools: ["Edit"],
    });
    await writeFile(join(denied.cwd, "a.txt"), "original");
    expect(
      await denied.invoke("Edit", {
        file_path: "a.txt",
        old_string: "original",
        new_string: "changed",
      }),
    ).toContain("denied");
  });
});
