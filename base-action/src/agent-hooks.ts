import { runConfigurationCommand, runHttpHook } from "./agent-hook-io";
export { runConfigurationCommand } from "./agent-hook-io";
import { workflowToolEnvironment } from "./codex-tool-environment";
import type { PermissionUpdate } from "./agent-permissions";
import {
  hookConditionMatches,
  parsePermissionUpdates,
  substituteHookInput,
} from "./agent-hook-policy";

export type HookHandler = {
  type: "command" | "prompt" | "agent" | "http" | "mcp_tool";
  command?: string;
  prompt?: string;
  model?: string;
  timeout?: number;
  statusMessage?: string;
  once?: boolean;
  async?: boolean;
  asyncRewake?: boolean;
  if?: string;
  server?: string;
  tool?: string;
  input?: Record<string, unknown>;
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  args?: string[];
  shell?: "bash" | "powershell";
  pluginRoot?: string;
  pluginDataDirectory?: string;
  pluginOptions?: Record<string, unknown>;
};
export type HookGroup = { matcher?: string; hooks: HookHandler[] };
export type HookMap = Record<string, HookGroup[]>;
export type HookResult = {
  blocked: boolean;
  reason?: string;
  permissionDecision?: "allow" | "deny" | "ask" | "defer";
  updatedInput?: Record<string, unknown>;
  updatedMCPToolOutput?: unknown;
  updatedPermissions?: PermissionUpdate[];
  additionalContext: string[];
  systemMessage: string[];
  stop: boolean;
  suppressOutput: boolean;
};
export type ModelHookRequest = {
  type: "prompt" | "agent";
  prompt: string;
  model?: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  deadline: number;
};
export type HookRunnerOptions = {
  hooks: HookMap;
  workspace: string;
  environment?: NodeJS.ProcessEnv;
  sessionId?: string;
  permissionMode?: string;
  transcriptPath?: string;
  deadline?: number;
  signal?: AbortSignal;
  /** SDK-backed evaluator returns {ok,reason}; no secondary vendor/runtime required. */
  modelHook?: (request: ModelHookRequest) => Promise<unknown>;
  onStatusMessage?: (message: string) => void;
  onWake?: (context: string) => void;
  mcpHook?: (request: {
    server: string;
    tool: string;
    input: Record<string, unknown>;
    signal: AbortSignal;
    deadline: number;
  }) => Promise<unknown>;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function checkKeys(
  value: Record<string, unknown>,
  keys: string[],
  label: string,
) {
  for (const key of Object.keys(value))
    if (!keys.includes(key))
      throw new Error(`Unsupported ${label} field: ${key}`);
}
const events = new Set([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  "PreCompact",
  "PostCompact",
  "StopFailure",
  "Setup",
]);

/** Validate early, including unsupported handler fields, so configured behavior is never dropped. */
export function parseHooks(
  value: unknown,
  plugin: Pick<
    HookHandler,
    "pluginRoot" | "pluginDataDirectory" | "pluginOptions"
  > = {},
): HookMap {
  const result: HookMap = {};
  for (const [event, groups] of Object.entries(object(value, "hooks"))) {
    if (!events.has(event)) throw new Error(`Unsupported hook event: ${event}`);
    if (!Array.isArray(groups))
      throw new Error(`Hook ${event} must contain matcher groups`);
    result[event] = groups.map((item) => {
      const group = object(item, `Hook ${event} group`);
      checkKeys(group, ["matcher", "hooks"], "hook group");
      if (group.matcher !== undefined && typeof group.matcher !== "string")
        throw new Error("Hook matcher must be a string");
      if (typeof group.matcher === "string" && group.matcher !== "*") {
        try {
          new RegExp(group.matcher);
        } catch {
          throw new Error(`Invalid hook matcher: ${group.matcher}`);
        }
      }
      if (!Array.isArray(group.hooks))
        throw new Error("Hook group must contain a hooks array");
      const hooks = group.hooks.map((item): HookHandler => {
        const handler = object(item, "Hook handler");
        checkKeys(
          handler,
          [
            "type",
            "command",
            "prompt",
            "model",
            "timeout",
            "statusMessage",
            "once",
            "async",
            "url",
            "headers",
            "allowedEnvVars",
            "args",
            "shell",
            "if",
            "asyncRewake",
            "server",
            "tool",
            "input",
          ],
          "hook handler",
        );
        if (
          !["command", "prompt", "agent", "http", "mcp_tool"].includes(
            String(handler.type),
          )
        )
          throw new Error(`Unsupported hook type: ${handler.type}`);
        const key =
          handler.type === "command"
            ? "command"
            : handler.type === "http"
              ? "url"
              : handler.type === "mcp_tool"
                ? "tool"
                : "prompt";
        if (typeof handler[key] !== "string" || !handler[key])
          throw new Error(`Hook ${handler.type} requires ${key}`);
        if (
          handler.timeout !== undefined &&
          (typeof handler.timeout !== "number" ||
            !Number.isFinite(handler.timeout) ||
            handler.timeout <= 0)
        )
          throw new Error("Hook timeout must be positive seconds");
        for (const key of ["statusMessage", "model"])
          if (handler[key] !== undefined && typeof handler[key] !== "string")
            throw new Error(`Hook ${key} must be a string`);
        if (handler.once !== undefined && typeof handler.once !== "boolean")
          throw new Error("Hook once must be boolean");
        if (
          handler.if !== undefined &&
          (typeof handler.if !== "string" ||
            !/^([^()]+)(?:\((.*)\))?$/.test(handler.if))
        )
          throw new Error("Hook if must be a permission rule");
        if (
          handler.asyncRewake !== undefined &&
          (typeof handler.asyncRewake !== "boolean" ||
            handler.type !== "command")
        )
          throw new Error(
            "Hook asyncRewake is supported only for command hooks",
          );
        if (handler.type === "mcp_tool") {
          if (typeof handler.server !== "string" || !handler.server)
            throw new Error("MCP hook requires server");
          if (handler.input !== undefined)
            object(handler.input, "MCP hook input");
        } else if (
          handler.server !== undefined ||
          handler.tool !== undefined ||
          handler.input !== undefined
        )
          throw new Error("MCP hook fields require type mcp_tool");
        if (
          handler.async !== undefined &&
          (typeof handler.async !== "boolean" || handler.type !== "command")
        )
          throw new Error("Hook async is supported only for command hooks");
        if (
          handler.args !== undefined &&
          (handler.type !== "command" ||
            !Array.isArray(handler.args) ||
            handler.args.some((value) => typeof value !== "string"))
        )
          throw new Error("Hook args must be a string array on command hooks");
        if (
          handler.shell !== undefined &&
          (handler.type !== "command" ||
            !["bash", "powershell"].includes(String(handler.shell)))
        )
          throw new Error("Hook shell must be bash or powershell");
        if (
          handler.type === "command" &&
          (handler.prompt !== undefined || handler.model !== undefined)
        )
          throw new Error("Prompt/model fields require a prompt or agent hook");
        if (handler.type !== "command" && handler.command !== undefined)
          throw new Error("Hook command requires type command");
        if (handler.type === "http") {
          if (handler.headers !== undefined) {
            const headers = object(handler.headers, "HTTP hook headers");
            if (
              Object.values(headers).some((value) => typeof value !== "string")
            )
              throw new Error("HTTP hook headers must contain strings");
          }
          if (
            handler.allowedEnvVars !== undefined &&
            (!Array.isArray(handler.allowedEnvVars) ||
              handler.allowedEnvVars.some(
                (name) =>
                  typeof name !== "string" ||
                  !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
              ))
          )
            throw new Error(
              "HTTP hook allowedEnvVars must contain environment variable names",
            );
        } else if (
          handler.url !== undefined ||
          handler.headers !== undefined ||
          handler.allowedEnvVars !== undefined
        )
          throw new Error("HTTP hook fields require type http");
        return { ...handler, ...plugin } as HookHandler;
      });
      return { matcher: group.matcher as string | undefined, hooks };
    });
  }
  return result;
}

/** Do not inherit process.env. Explicit runtime credentials/control variables are removed. */
export function hookEnvironment(
  environment: NodeJS.ProcessEnv,
  workspace: string,
  handler?: HookHandler,
): Record<string, string> {
  const env: Record<string, string> = {
    ...workflowToolEnvironment(environment),
    PATH: environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: environment.HOME ?? workspace,
    TMPDIR: environment.TMPDIR ?? "/tmp",
    LANG: environment.LANG ?? "C.UTF-8",
    CLAUDE_PROJECT_DIR: workspace,
    CODEX_PROJECT_DIR: workspace,
  };
  if (handler?.pluginRoot) {
    env.CLAUDE_PLUGIN_ROOT = env.CODEX_PLUGIN_ROOT = handler.pluginRoot;
  }
  if (handler?.pluginDataDirectory) {
    env.CLAUDE_PLUGIN_DATA = env.CODEX_PLUGIN_DATA =
      handler.pluginDataDirectory;
  }
  for (const [name, value] of Object.entries(handler?.pluginOptions ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error("Invalid plugin option environment name");
    const text = Array.isArray(value) ? JSON.stringify(value) : String(value);
    env[`CLAUDE_PLUGIN_OPTION_${name.toUpperCase()}`] = text;
    env[`CODEX_PLUGIN_OPTION_${name.toUpperCase()}`] = text;
  }
  return env;
}

function emptyResult(): HookResult {
  return {
    blocked: false,
    additionalContext: [],
    systemMessage: [],
    stop: false,
    suppressOutput: false,
  };
}

function applyOutput(result: HookResult, output: unknown, event: string) {
  const data = object(output, "Hook output");
  checkKeys(
    data,
    [
      "continue",
      "stopReason",
      "suppressOutput",
      "systemMessage",
      "decision",
      "reason",
      "hookSpecificOutput",
    ],
    "hook output",
  );
  if (data.continue !== undefined && typeof data.continue !== "boolean")
    throw new Error("Hook continue must be boolean");
  if (
    data.suppressOutput !== undefined &&
    typeof data.suppressOutput !== "boolean"
  )
    throw new Error("Hook suppressOutput must be boolean");
  for (const key of ["stopReason", "systemMessage", "reason"])
    if (data[key] !== undefined && typeof data[key] !== "string")
      throw new Error(`Hook ${key} must be a string`);
  if (data.continue === false) {
    result.stop = true;
    result.reason = data.stopReason as string | undefined;
  }
  if (data.suppressOutput === true) result.suppressOutput = true;
  if (typeof data.systemMessage === "string")
    result.systemMessage.push(data.systemMessage);
  if (
    data.decision !== undefined &&
    !["approve", "block"].includes(String(data.decision))
  )
    throw new Error("Unsupported hook decision");
  if (data.decision === "block") {
    result.blocked = true;
    result.reason = data.reason as string | undefined;
  }
  if (
    data.decision === "approve" &&
    event === "PreToolUse" &&
    !result.permissionDecision
  )
    result.permissionDecision = "allow";
  if (data.hookSpecificOutput === undefined) return;
  const specific = object(data.hookSpecificOutput, "hookSpecificOutput");
  checkKeys(
    specific,
    [
      "hookEventName",
      "permissionDecision",
      "permissionDecisionReason",
      "updatedInput",
      "additionalContext",
      "updatedMCPToolOutput",
      "decision",
    ],
    "hookSpecificOutput",
  );
  if (specific.hookEventName !== event)
    throw new Error(`Hook output event does not match ${event}`);
  if (specific.permissionDecision !== undefined) {
    if (event !== "PreToolUse")
      throw new Error("permissionDecision is supported only for PreToolUse");
    const decision = specific.permissionDecision;
    if (!["allow", "deny", "ask", "defer"].includes(String(decision)))
      throw new Error("Invalid permissionDecision");
    // A later allow may never clear a deny/ask/defer from an earlier hook.
    if (
      !result.permissionDecision ||
      result.permissionDecision === "allow" ||
      decision === "deny"
    )
      result.permissionDecision = decision as HookResult["permissionDecision"];
    if (decision !== "allow") {
      result.blocked = true;
      result.reason =
        typeof specific.permissionDecisionReason === "string"
          ? specific.permissionDecisionReason
          : `Hook requested ${decision}`;
    }
  }
  if (
    specific.permissionDecisionReason !== undefined &&
    typeof specific.permissionDecisionReason !== "string"
  )
    throw new Error("permissionDecisionReason must be a string");
  if (specific.updatedInput !== undefined) {
    if (!["PreToolUse", "PermissionRequest"].includes(event))
      throw new Error(`updatedInput is not supported for ${event}`);
    result.updatedInput = object(specific.updatedInput, "updatedInput");
  }
  if (specific.updatedMCPToolOutput !== undefined) {
    if (event !== "PostToolUse")
      throw new Error("updatedMCPToolOutput is supported only for PostToolUse");
    result.updatedMCPToolOutput = specific.updatedMCPToolOutput;
  }
  if (specific.additionalContext !== undefined) {
    if (typeof specific.additionalContext !== "string")
      throw new Error("additionalContext must be a string");
    result.additionalContext.push(specific.additionalContext);
  }
  if (specific.decision !== undefined) {
    if (event !== "PermissionRequest")
      throw new Error(
        "Nested decision is supported only for PermissionRequest",
      );
    const decision = object(specific.decision, "PermissionRequest decision");
    checkKeys(
      decision,
      [
        "behavior",
        "updatedInput",
        "updatedPermissions",
        "message",
        "interrupt",
      ],
      "permission decision",
    );
    if (!["allow", "deny"].includes(String(decision.behavior)))
      throw new Error("Invalid PermissionRequest behavior");
    if (decision.behavior === "deny") {
      result.blocked = true;
      result.permissionDecision = "deny";
      result.reason =
        typeof decision.message === "string"
          ? decision.message
          : "Permission hook denied tool";
    } else if (!result.permissionDecision) result.permissionDecision = "allow";
    if (decision.updatedInput !== undefined)
      result.updatedInput = object(decision.updatedInput, "updatedInput");
    if (decision.updatedPermissions !== undefined) {
      if (decision.behavior !== "allow")
        throw new Error("updatedPermissions requires allow behavior");
      result.updatedPermissions = [
        ...(result.updatedPermissions ?? []),
        ...parsePermissionUpdates(decision.updatedPermissions),
      ];
    }
    if (decision.interrupt === true) result.stop = true;
  }
}

/** Caller must still enforce its tool allow/deny policy after any updatedInput. */
export function createHookRunner(options: HookRunnerOptions) {
  const completed = new Set<HookHandler>();
  const backgroundController = new AbortController();
  const background: Promise<void>[] = [];
  const pending = emptyResult();
  let backgroundFailure: unknown;
  const drain = (): HookResult => {
    if (backgroundFailure) throw backgroundFailure;
    const result = {
      ...pending,
      additionalContext: pending.additionalContext.splice(0),
      systemMessage: pending.systemMessage.splice(0),
    };
    return result;
  };
  return {
    /** Async command hooks contribute context/messages once finished, never permission decisions. */
    drain,
    async close(options: { abort?: boolean } = {}): Promise<HookResult> {
      if (options.abort) backgroundController.abort();
      await Promise.all(background);
      return drain();
    },
    async run(
      event: string,
      input: Record<string, unknown> = {},
    ): Promise<HookResult> {
      if (!events.has(event))
        throw new Error(`Unsupported hook event: ${event}`);
      const result = emptyResult();
      const payload: Record<string, unknown> = {
        ...input,
        cwd: options.workspace,
        session_id: options.sessionId ?? "",
        transcript_path: options.transcriptPath ?? "",
        permission_mode: options.permissionMode ?? "default",
        hook_event_name: event,
      };
      const matchValue = String(
        input.tool_name ??
          input.matcher ??
          input.source ??
          input.reason ??
          input.notification_type ??
          input.agent_type ??
          "",
      );
      for (const group of options.hooks[event] ?? []) {
        if (
          group.matcher &&
          group.matcher !== "*" &&
          !new RegExp(group.matcher).test(matchValue)
        )
          continue;
        for (const handler of group.hooks) {
          if (handler.once && completed.has(handler)) continue;
          if (
            handler.if &&
            !hookConditionMatches(handler.if, event, payload, options.workspace)
          )
            continue;
          if (handler.statusMessage)
            options.onStatusMessage?.(handler.statusMessage);
          const deadline = Math.min(
            options.deadline ?? Infinity,
            Date.now() +
              (handler.timeout ?? (handler.type === "command" ? 600 : 60)) *
                1000,
          );
          if (handler.type === "command") {
            const execute = async () => {
              const response = await runConfigurationCommand(
                handler.args
                  ? handler.command!
                  : handler.shell === "powershell"
                    ? "pwsh"
                    : "/bin/bash",
                handler.args ??
                  (handler.shell === "powershell"
                    ? [
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        handler.command!,
                      ]
                    : ["-c", handler.command!]),
                {
                  workspace: options.workspace,
                  environment: hookEnvironment(
                    options.environment ?? {},
                    options.workspace,
                    handler,
                  ),
                  input: JSON.stringify(payload),
                  deadline,
                  signal:
                    handler.async || handler.asyncRewake
                      ? options.signal
                        ? AbortSignal.any([
                            options.signal,
                            backgroundController.signal,
                          ])
                        : backgroundController.signal
                      : options.signal,
                },
              );
              if (handler.async || handler.asyncRewake) {
                if (handler.asyncRewake && response.code === 2) {
                  const context =
                    response.stderr.trim() ||
                    response.stdout.trim() ||
                    "Background hook requested another turn";
                  pending.additionalContext.push(context);
                  options.onWake?.(context);
                  return;
                }
                if (response.code !== 0) {
                  pending.systemMessage.push(
                    `Async hook exited ${response.code}: ${response.stderr.trim()}`,
                  );
                  return;
                }
                if (response.stdout.trim().startsWith("{")) {
                  const asyncResult = emptyResult();
                  applyOutput(asyncResult, JSON.parse(response.stdout), event);
                  // This follows async hook semantics: control decisions cannot affect completed calls.
                  pending.additionalContext.push(
                    ...asyncResult.additionalContext,
                  );
                  pending.systemMessage.push(...asyncResult.systemMessage);
                } else if (
                  ["SessionStart", "UserPromptSubmit", "Setup"].includes(
                    event,
                  ) &&
                  response.stdout.trim()
                )
                  pending.additionalContext.push(response.stdout.trim());
                return;
              }
              if (response.code === 2) {
                if (
                  [
                    "PreToolUse",
                    "PostToolUse",
                    "Stop",
                    "SubagentStop",
                    "UserPromptSubmit",
                  ].includes(event)
                ) {
                  result.blocked = true;
                  result.reason =
                    response.stderr.trim() || "Hook blocked operation";
                } else if (
                  event !== "PermissionRequest" &&
                  response.stderr.trim()
                )
                  result.systemMessage.push(response.stderr.trim());
              } else if (response.code !== 0)
                result.systemMessage.push(
                  `Hook command exited ${response.code}: ${response.stderr.trim()}`,
                );
              else if (response.stdout.trim().startsWith("{"))
                applyOutput(result, JSON.parse(response.stdout), event);
              else if (
                ["SessionStart", "UserPromptSubmit", "Setup"].includes(event) &&
                response.stdout.trim()
              )
                result.additionalContext.push(response.stdout.trim());
            };
            if (handler.async || handler.asyncRewake)
              background.push(
                execute().catch((error) => {
                  backgroundFailure ??= error;
                }),
              );
            else await execute();
          } else if (handler.type === "http") {
            const output = await runHttpHook(
              handler,
              payload,
              options,
              deadline,
            );
            if (output !== undefined) applyOutput(result, output, event);
          } else if (handler.type === "mcp_tool") {
            if (!options.mcpHook)
              throw new Error("MCP hook requires an mcpHook callback");
            const controller = new AbortController();
            const abort = () => controller.abort();
            options.signal?.addEventListener("abort", abort, { once: true });
            const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
            try {
              if (options.signal?.aborted || deadline <= Date.now())
                throw new Error("MCP hook cancelled or timed out");
              const response = await Promise.race([
                options.mcpHook({
                  server: handler.server!,
                  tool: handler.tool!,
                  input: object(
                    substituteHookInput(handler.input ?? {}, payload),
                    "MCP hook input",
                  ),
                  signal: controller.signal,
                  deadline,
                }),
                new Promise<never>((_, reject) =>
                  controller.signal.addEventListener(
                    "abort",
                    () => reject(new Error("MCP hook cancelled or timed out")),
                    { once: true },
                  ),
                ),
              ]);
              applyOutput(
                result,
                typeof response === "string" ? JSON.parse(response) : response,
                event,
              );
            } finally {
              clearTimeout(timer);
              controller.abort();
              options.signal?.removeEventListener("abort", abort);
            }
          } else {
            if (!options.modelHook)
              throw new Error(
                `Hook ${handler.type} requires an Agents SDK modelHook callback`,
              );
            const controller = new AbortController();
            const abort = () => controller.abort();
            options.signal?.addEventListener("abort", abort, { once: true });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              if (options.signal?.aborted || deadline <= Date.now())
                throw new Error("Model hook execution cancelled or timed out");
              const response = await Promise.race([
                options.modelHook({
                  type: handler.type,
                  prompt: handler.prompt!.replaceAll(
                    "$ARGUMENTS",
                    JSON.stringify(payload),
                  ),
                  model: handler.model,
                  input: payload,
                  deadline,
                  signal: controller.signal,
                }),
                new Promise<never>((_, reject) => {
                  controller.signal.addEventListener(
                    "abort",
                    () =>
                      reject(
                        new Error(
                          "Model hook execution cancelled or timed out",
                        ),
                      ),
                    { once: true },
                  );
                  timer = setTimeout(
                    () => controller.abort(),
                    Math.max(1, deadline - Date.now()),
                  );
                }),
              ]);
              const verdict = object(response, "Model hook verdict");
              checkKeys(verdict, ["ok", "reason"], "model hook verdict");
              if (typeof verdict.ok !== "boolean")
                throw new Error("Model hook must return a boolean ok verdict");
              if (
                verdict.reason !== undefined &&
                typeof verdict.reason !== "string"
              )
                throw new Error("Model hook reason must be a string");
              if (!verdict.ok) {
                result.blocked = true;
                result.reason = verdict.reason as string | undefined;
              }
            } finally {
              if (timer) clearTimeout(timer);
              controller.abort();
              options.signal?.removeEventListener("abort", abort);
            }
          }
          if (handler.once && !result.blocked && !result.stop)
            completed.add(handler);
          if (result.updatedInput) payload.tool_input = result.updatedInput;
          if (result.stop) return result;
        }
      }
      return result;
    },
  };
}
