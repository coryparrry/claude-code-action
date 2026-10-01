import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionUpdate } from "../src/agent-permissions";
import {
  createHookRunner,
  hookEnvironment,
  parseHooks,
} from "../src/agent-hooks";

const workspace = "/private/tmp";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const output = (value: unknown) =>
  `printf '%s' ${quote(JSON.stringify(value))}`;
const command = (value: string, extra = {}) => ({
  type: "command",
  command: value,
  ...extra,
});
const preOutput = (value: Record<string, unknown>) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", ...value },
});
const runner = (event: string, handlers: unknown[], matcher?: string) =>
  createHookRunner({
    workspace,
    hooks: parseHooks({ [event]: [{ matcher, hooks: handlers }] }),
  });

describe("Agents SDK hook compatibility", () => {
  test("HTTP hooks can use declared plugin option headers while model credentials stay unavailable", async () => {
    let authorization = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorization = request.headers.get("Authorization") ?? "";
        return Response.json({});
      },
    });
    try {
      const hooks = parseHooks(
        {
          Stop: [
            {
              hooks: [
                {
                  type: "http",
                  url: String(server.url),
                  headers: {
                    Authorization: "Bearer $CLAUDE_PLUGIN_OPTION_TOKEN",
                  },
                  allowedEnvVars: ["CLAUDE_PLUGIN_OPTION_TOKEN"],
                },
              ],
            },
          ],
        },
        {
          pluginRoot: "/fixture/plugin",
          pluginOptions: { token: "fixture-plugin-token" },
        },
      );
      expect(
        (await createHookRunner({ workspace, hooks }).run("Stop")).blocked,
      ).toBe(false);
      expect(authorization).toBe("Bearer fixture-plugin-token");
    } finally {
      server.stop(true);
    }
  });
  test("permission-rule if filters tool/file inputs, shell subcommands and uncertain expansions", async () => {
    const bash = runner("PreToolUse", [
      command("exit 2", { if: "Bash(git *)" }),
    ]);
    expect(
      (
        await bash.run("PreToolUse", {
          tool_name: "Bash",
          tool_input: { command: "npm test" },
        })
      ).blocked,
    ).toBe(false);
    expect(
      (
        await bash.run("PreToolUse", {
          tool_name: "Bash",
          tool_input: { command: "npm test && FLAG=yes git push" },
        })
      ).blocked,
    ).toBe(true);
    expect(
      (
        await bash.run("PreToolUse", {
          tool_name: "Bash",
          tool_input: { command: "$EXECUTABLE push" },
        })
      ).blocked,
    ).toBe(true);
    const edit = runner("PreToolUse", [
      command("exit 2", { if: "Edit(src/**/*.ts)" }),
    ]);
    expect(
      (
        await edit.run("PreToolUse", {
          tool_name: "Edit",
          tool_input: { file_path: "src/index.ts" },
        })
      ).blocked,
    ).toBe(true);
    expect(
      (
        await edit.run("PreToolUse", {
          tool_name: "Edit",
          tool_input: { file_path: "docs/index.md" },
        })
      ).blocked,
    ).toBe(false);
    expect(
      (await runner("Stop", [command("exit 2", { if: "Bash" })]).run("Stop"))
        .blocked,
    ).toBe(false);
  });

  test("mcp_tool hooks dispatch once through supplied callback, substitute input and preserve cancellation", async () => {
    let observed: unknown;
    const hooks = parseHooks({
      PreToolUse: [
        {
          hooks: [
            {
              type: "mcp_tool",
              server: "fixture",
              tool: "guard",
              input: {
                command: "${tool_input.command}",
                data: "${tool_input}",
              },
            },
          ],
        },
      ],
    });
    const hook = createHookRunner({
      workspace,
      hooks,
      mcpHook: async (request) => {
        observed = request;
        return preOutput({
          permissionDecision: "deny",
          permissionDecisionReason: "MCP denied",
        });
      },
    });
    expect(
      await hook.run("PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "danger" },
      }),
    ).toMatchObject({ blocked: true, reason: "MCP denied" });
    expect(observed).toMatchObject({
      server: "fixture",
      tool: "guard",
      input: { command: "danger", data: { command: "danger" } },
    });
    await expect(
      createHookRunner({ workspace, hooks }).run("PreToolUse"),
    ).rejects.toThrow("mcpHook callback");
    const timed = parseHooks({
      Stop: [
        {
          hooks: [
            {
              type: "mcp_tool",
              server: "fixture",
              tool: "guard",
              timeout: 0.02,
            },
          ],
        },
      ],
    });
    await expect(
      createHookRunner({
        workspace,
        hooks: timed,
        mcpHook: () => new Promise(() => {}),
      }).run("Stop"),
    ).rejects.toThrow("timed out");
  });

  test("asyncRewake exit 2 queues context and signals wake without blocking tool execution", async () => {
    let wake = "";
    const hook = createHookRunner({
      workspace,
      onWake: (context) => {
        wake = context;
      },
      hooks: parseHooks({
        PostToolUse: [
          {
            hooks: [
              command(
                "sleep 0.03; printf 'background verification failed' >&2; exit 2",
                { asyncRewake: true },
              ),
            ],
          },
        ],
      }),
    });
    expect((await hook.run("PostToolUse")).blocked).toBe(false);
    expect((await hook.close()).additionalContext).toEqual([
      "background verification failed",
    ]);
    expect(wake).toBe("background verification failed");
    expect(hook.drain().additionalContext).toEqual([]);
  });

  test("PermissionRequest returns validated rule/mode/directory updates and rejects malformed mutations", async () => {
    const updates: PermissionUpdate[] = [
      {
        type: "addRules",
        behavior: "allow",
        rules: [{ toolName: "Bash", ruleContent: "npm test" }],
        destination: "session",
      },
      {
        type: "replaceRules",
        behavior: "deny",
        rules: [{ toolName: "Write" }],
        destination: "projectSettings",
      },
      {
        type: "removeRules",
        behavior: "ask",
        rules: [{ toolName: "Read" }],
        destination: "localSettings",
      },
      { type: "setMode", mode: "acceptEdits", destination: "userSettings" },
      {
        type: "addDirectories",
        directories: ["/fixture"],
        destination: "session",
      },
      {
        type: "removeDirectories",
        directories: ["/fixture"],
        destination: "session",
      },
    ];
    const value = (updatedPermissions: unknown) => ({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedPermissions },
      },
    });
    expect(
      (
        await runner("PermissionRequest", [
          command(output(value(updates))),
        ]).run("PermissionRequest")
      ).updatedPermissions,
    ).toEqual(updates);
    await expect(
      runner("PermissionRequest", [
        command(output(value([{ type: "setMode", mode: "invented" }]))),
      ]).run("PermissionRequest"),
    ).rejects.toThrow("Invalid permission update mode");
  });

  test("PowerShell hooks select pwsh with noninteractive arguments from the explicit path", async () => {
    const root = await mkdtemp(join(tmpdir(), "hook-powershell-"));
    try {
      await writeFile(
        join(root, "pwsh"),
        '#!/bin/sh\nprintf "%s" "$1 $2 $3"\n',
        { mode: 0o755 },
      );
      const hook = createHookRunner({
        workspace,
        environment: { PATH: root },
        hooks: parseHooks({
          SessionStart: [
            {
              hooks: [command("unused fixture text", { shell: "powershell" })],
            },
          ],
        }),
      });
      expect((await hook.run("SessionStart")).additionalContext).toEqual([
        "-NoProfile -NonInteractive -Command",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("exec-form command hooks preserve argument boundaries and report status", async () => {
    let status = "";
    const hooks = createHookRunner({
      workspace,
      onStatusMessage: (value) => {
        status = value;
      },
      hooks: parseHooks({
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "/usr/bin/printf",
                args: ["%s", "one argument with spaces; no shell"],
                statusMessage: "Preparing",
              },
            ],
          },
        ],
      }),
    });
    expect((await hooks.run("SessionStart")).additionalContext).toEqual([
      "one argument with spaces; no shell",
    ]);
    expect(status).toBe("Preparing");
  });
  test("matches regex tool names and MCP names without matching unrelated tools", async () => {
    const hooks = runner(
      "PreToolUse",
      [command("exit 2")],
      "^(Bash|mcp__github__.*)$",
    );
    expect((await hooks.run("PreToolUse", { tool_name: "Read" })).blocked).toBe(
      false,
    );
    expect((await hooks.run("PreToolUse", { tool_name: "Bash" })).blocked).toBe(
      true,
    );
    expect(
      (await hooks.run("PreToolUse", { tool_name: "mcp__github__get_issue" }))
        .blocked,
    ).toBe(true);
  });

  test("passes event stdin, applies updatedInput sequentially and preserves context", async () => {
    const hooks = runner("PreToolUse", [
      command(
        output(
          preOutput({
            permissionDecision: "allow",
            updatedInput: { command: "safe" },
            additionalContext: "Use safe command",
          }),
        ),
      ),
      command(
        `${quote(process.execPath)} -e ${quote('let s="";for await(const c of process.stdin)s+=c; const p=JSON.parse(s);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:p.hook_event_name,additionalContext:p.tool_input.command+":"+p.cwd}}));')}`,
      ),
    ]);
    const result = await hooks.run("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "original" },
    });
    expect(result.updatedInput).toEqual({ command: "safe" });
    expect(result.additionalContext).toEqual([
      "Use safe command",
      `safe:${workspace}`,
    ]);
    expect(result.permissionDecision).toBe("allow");
  });

  test("deny beats later allow; ask/defer fail closed in unattended execution", async () => {
    for (const decision of ["deny", "ask", "defer"] as const) {
      const result = await runner("PreToolUse", [
        command(
          output(
            preOutput({
              permissionDecision: decision,
              permissionDecisionReason: "fixture reason",
            }),
          ),
        ),
        command(output(preOutput({ permissionDecision: "allow" }))),
      ]).run("PreToolUse");
      expect(result.blocked).toBe(true);
      expect(result.permissionDecision).toBe(decision);
      expect(result.reason).toBe("fixture reason");
    }
  });

  test("exit 2 blocks, permission exits preserve flow and other exit codes produce diagnostics", async () => {
    expect(
      (
        await runner("PreToolUse", [
          command("printf 'deny reason' >&2; exit 2"),
        ]).run("PreToolUse")
      ).reason,
    ).toBe("deny reason");
    expect(
      await runner("PreToolUse", [command("printf 'failed' >&2; exit 1")]).run(
        "PreToolUse",
      ),
    ).toMatchObject({
      blocked: false,
      systemMessage: ["Hook command exited 1: failed"],
    });
    expect(
      await runner("PermissionRequest", [command("exit 2")]).run(
        "PermissionRequest",
      ),
    ).toMatchObject({ blocked: false });
  });

  test("Stop decisions and continue:false reach caller with reasons", async () => {
    expect(
      await runner("Stop", [
        command(output({ decision: "block", reason: "Need verification" })),
      ]).run("Stop"),
    ).toMatchObject({ blocked: true, reason: "Need verification" });
    expect(
      await runner("Stop", [
        command(
          output({
            continue: false,
            stopReason: "End now",
            suppressOutput: true,
            systemMessage: "Notice",
          }),
        ),
      ]).run("Stop"),
    ).toMatchObject({
      stop: true,
      reason: "End now",
      suppressOutput: true,
      systemMessage: ["Notice"],
    });
  });

  test("PostToolUseFailure and SubagentStop deliver event-specific fields", async () => {
    for (const event of ["PostToolUseFailure", "SubagentStop"]) {
      const result = await runner(event, [
        command(
          `${quote(process.execPath)} -e ${quote('let s="";for await(const c of process.stdin)s+=c; const p=JSON.parse(s);console.log(JSON.stringify({hookSpecificOutput:{hookEventName:p.hook_event_name,additionalContext:p.error+":"+p.agent_id}}));')}`,
        ),
      ]).run(event, { error: "failure", agent_id: "child" });
      expect(result.additionalContext).toEqual(["failure:child"]);
    }
  });

  test("PermissionRequest applies nested decision and PostToolUse changes MCP output", async () => {
    expect(
      await runner("PermissionRequest", [
        command(
          output({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: "deny", message: "No", interrupt: true },
            },
          }),
        ),
      ]).run("PermissionRequest"),
    ).toMatchObject({
      blocked: true,
      stop: true,
      permissionDecision: "deny",
      reason: "No",
    });
    expect(
      await runner("PostToolUse", [
        command(
          output({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              updatedMCPToolOutput: { safe: true },
            },
          }),
        ),
      ]).run("PostToolUse"),
    ).toMatchObject({ updatedMCPToolOutput: { safe: true } });
  });

  test("environment never inherits auth, filters explicit credentials and adds plugin variables", async () => {
    const env = hookEnvironment(
      {
        APP_MODE: "test",
        OPENAI_API_KEY: "auth-fixture-123",
        CUSTOM_SECRET: "auth-fixture-123",
        APP_CONFIG: "auth-fixture-123",
        NODE_OPTIONS: "bad",
      },
      workspace,
      {
        type: "command",
        pluginRoot: "/fixture/plugin",
        pluginDataDirectory: "/fixture/data",
      },
    );
    expect(env.APP_MODE).toBe("test");
    for (const key of [
      "OPENAI_API_KEY",
      "CUSTOM_SECRET",
      "APP_CONFIG",
      "NODE_OPTIONS",
    ])
      expect(env[key]).toBeUndefined();
    expect(env.CLAUDE_PLUGIN_ROOT).toBe("/fixture/plugin");
    expect(env.CODEX_PLUGIN_DATA).toBe("/fixture/data");
    const hook = createHookRunner({
      workspace,
      hooks: parseHooks({
        SessionStart: [
          { hooks: [command("printf '%s' \"${OPENAI_API_KEY-unset}\"")] },
        ],
      }),
      environment: { OPENAI_API_KEY: "private" },
    });
    expect((await hook.run("SessionStart")).additionalContext).toEqual([
      "unset",
    ]);
  });

  test("enforces command timeout and cancellation including child process groups", async () => {
    const start = Date.now();
    await expect(
      runner("PreToolUse", [command("sleep 10 & wait", { timeout: 0.04 })]).run(
        "PreToolUse",
      ),
    ).rejects.toThrow("timed out");
    expect(Date.now() - start).toBeLessThan(2000);
    const controller = new AbortController();
    const hook = createHookRunner({
      workspace,
      signal: controller.signal,
      hooks: parseHooks({ Stop: [{ hooks: [command("sleep 10 & wait")] }] }),
    });
    setTimeout(() => controller.abort(), 30);
    await expect(hook.run("Stop")).rejects.toThrow("cancelled");
  });

  test("prompt/agent hooks use supplied SDK callback and input substitution", async () => {
    for (const type of ["prompt", "agent"]) {
      let observed: unknown;
      const hooks = createHookRunner({
        workspace,
        hooks: parseHooks({
          Stop: [
            {
              hooks: [
                { type, prompt: "Check $ARGUMENTS", model: "codex-fixture" },
              ],
            },
          ],
        }),
        modelHook: async (request) => {
          observed = request;
          return { ok: false, reason: "Missing verification" };
        },
      });
      expect(
        await hooks.run("Stop", { last_assistant_message: "Done" }),
      ).toMatchObject({ blocked: true, reason: "Missing verification" });
      expect(observed).toMatchObject({ type, model: "codex-fixture" });
      expect((observed as { prompt: string }).prompt).toContain(
        '"last_assistant_message":"Done"',
      );
    }
  });

  test("model hooks require a callback, strict verdicts and bounded evaluation", async () => {
    const hooks = parseHooks({
      Stop: [{ hooks: [{ type: "prompt", prompt: "verify", timeout: 0.03 }] }],
    });
    await expect(
      createHookRunner({ workspace, hooks }).run("Stop"),
    ).rejects.toThrow("modelHook callback");
    await expect(
      createHookRunner({
        workspace,
        hooks,
        modelHook: async () => ({ decision: "allow" }),
      }).run("Stop"),
    ).rejects.toThrow("model hook verdict");
    await expect(
      createHookRunner({
        workspace,
        hooks,
        modelHook: () => new Promise(() => {}),
      }).run("Stop"),
    ).rejects.toThrow("timed out");
  });

  test("once handlers run only once within their runner", async () => {
    const hooks = runner("SessionStart", [
      command("printf once", { once: true }),
    ]);
    expect((await hooks.run("SessionStart")).additionalContext).toEqual([
      "once",
    ]);
    expect((await hooks.run("SessionStart")).additionalContext).toEqual([]);
  });

  test("async commands return immediately and deliver queued context when closed", async () => {
    const hooks = runner("SessionStart", [
      command("sleep 0.1; printf background", { async: true }),
    ]);
    const start = Date.now();
    expect((await hooks.run("SessionStart")).additionalContext).toEqual([]);
    expect(Date.now() - start).toBeLessThan(90);
    expect((await hooks.close()).additionalContext).toEqual(["background"]);
    expect(hooks.drain().additionalContext).toEqual([]);
  });

  test("closing async hooks can abort background process groups and reports failures", async () => {
    const hooks = runner("Stop", [command("sleep 10 & wait", { async: true })]);
    await hooks.run("Stop");
    await expect(hooks.close({ abort: true })).rejects.toThrow("cancelled");
  });

  test("HTTP hooks use explicit header environment and obey block/update output", async () => {
    let observed: unknown,
      authorization: string | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        authorization = request.headers.get("authorization");
        observed = await request.json();
        return Response.json(
          preOutput({
            permissionDecision: "deny",
            permissionDecisionReason: "HTTP denied",
            updatedInput: { command: "safe" },
          }),
        );
      },
    });
    try {
      const hooks = createHookRunner({
        workspace,
        environment: { HOOK_TOKEN: "fixture-service-token" },
        hooks: parseHooks({
          PreToolUse: [
            {
              hooks: [
                {
                  type: "http",
                  url: `${server.url}hook`,
                  headers: { Authorization: "Bearer $HOOK_TOKEN" },
                  allowedEnvVars: ["HOOK_TOKEN"],
                },
              ],
            },
          ],
        }),
      });
      expect(
        await hooks.run("PreToolUse", { tool_name: "Bash" }),
      ).toMatchObject({
        blocked: true,
        reason: "HTTP denied",
        updatedInput: { command: "safe" },
      });
      expect(authorization as string | null).toBe(
        "Bearer fixture-service-token",
      );
      expect(observed).toMatchObject({
        tool_name: "Bash",
        hook_event_name: "PreToolUse",
      });
    } finally {
      server.stop(true);
    }
  });

  test("HTTP hooks refuse unlisted variables, reserved model credentials and time out", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await Bun.sleep(150);
        return Response.json({});
      },
    });
    const hook = (
      headers: Record<string, string>,
      allowedEnvVars: string[],
      timeout = 1,
    ) =>
      createHookRunner({
        workspace,
        environment: { OPENAI_API_KEY: "private" },
        hooks: parseHooks({
          Stop: [
            {
              hooks: [
                {
                  type: "http",
                  url: String(server.url),
                  headers,
                  allowedEnvVars,
                  timeout,
                },
              ],
            },
          ],
        }),
      });
    try {
      await expect(
        hook({ Authorization: "$MISSING" }, []).run("Stop"),
      ).rejects.toThrow("allowedEnvVars");
      await expect(
        hook({ Authorization: "$OPENAI_API_KEY" }, ["OPENAI_API_KEY"]).run(
          "Stop",
        ),
      ).rejects.toThrow("reserved credential");
      await expect(hook({}, [], 0.02).run("Stop")).rejects.toThrow("timed out");
    } finally {
      server.stop(true);
    }
  });

  test("rejects unsupported schema and malformed/incorrect output rather than silently ignoring it", async () => {
    expect(() =>
      parseHooks({
        PreToolUse: [{ hooks: [command("true", { inventedHookField: true })] }],
      }),
    ).toThrow("inventedHookField");
    expect(() =>
      parseHooks({
        PreToolUse: [{ hooks: [{ type: "mcp_tool", tool: "fixture" }] }],
      }),
    ).toThrow("MCP hook requires server");
    expect(() => parseHooks({ UnknownEvent: [] })).toThrow(
      "Unsupported hook event",
    );
    expect(() =>
      parseHooks({ PreToolUse: [{ matcher: "[", hooks: [] }] }),
    ).toThrow("Invalid hook matcher");
    await expect(
      runner("Stop", [
        command(
          output({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
            },
          }),
        ),
      ]).run("Stop"),
    ).rejects.toThrow("does not match");
    await expect(
      runner("Stop", [command(output({ unknown: "ignored?" }))]).run("Stop"),
    ).rejects.toThrow("Unsupported hook output field");
  });
});
