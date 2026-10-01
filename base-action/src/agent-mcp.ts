import {
  MCPServerStdio,
  MCPServerStreamableHttp,
  MCPServerSSE,
  tool,
  type MCPServer,
  type Tool,
} from "@openai/agents";
import Ajv from "ajv";
import type { AgentToolEvent, AgentToolHookResult } from "./agent-tools";
import { AgentPermissions } from "./agent-permissions";

export type AgentMcpInvocationContext = {
  skipHooks?: boolean;
  signal?: AbortSignal;
  deadline?: number;
};
export type AgentMcpOptions = {
  mcpConfig: string;
  environment: Record<string, string>;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissions?: AgentPermissions;
  deadline: number;
  signal?: AbortSignal;
  beforeTool?: (event: AgentToolEvent) => Promise<void | AgentToolHookResult>;
  permissionRequest?: (
    event: AgentToolEvent,
  ) => Promise<void | AgentToolHookResult>;
  afterTool?: (event: AgentToolEvent) => Promise<void>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  if (
    !record(value) ||
    Object.values(value).some((entry) => typeof entry !== "string")
  )
    throw new Error(`${label} must contain string values`);
  return value as Record<string, string>;
}
function configuredTimeout(
  env: Record<string, string>,
  key: string,
  fallback: number,
): number {
  const value = env[key];
  if (value === undefined) return fallback;
  if (
    !/^[0-9]+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > 2_147_483_647
  )
    throw new Error(`${key} must be a positive millisecond integer`);
  return Number(value);
}

/** Connect actual MCP transports and expose legacy-named SDK function tools. */
export async function createAgentMcpTools(options: AgentMcpOptions): Promise<{
  tools: Tool[];
  secrets: string[];
  close(): Promise<void>;
  invoke(
    name: string,
    args: Record<string, unknown>,
    context?: AgentMcpInvocationContext,
  ): Promise<string>;
  invokeServer(
    server: string,
    name: string,
    args: Record<string, unknown>,
    context?: AgentMcpInvocationContext,
  ): Promise<string>;
}> {
  if (!Number.isFinite(options.deadline))
    throw new Error("MCP deadline must be finite");
  let config: unknown;
  try {
    config = JSON.parse(options.mcpConfig || '{"mcpServers":{}}');
  } catch {
    throw new Error("MCP configuration must be valid JSON");
  }
  if (!record(config) || !record(config.mcpServers))
    throw new Error("MCP configuration must contain mcpServers");
  const initTimeout = configuredTimeout(
    options.environment,
    "MCP_TIMEOUT",
    30_000,
  );
  const toolTimeout = configuredTimeout(
    options.environment,
    "MCP_TOOL_TIMEOUT",
    60_000,
  );
  const permissions =
    options.permissions ??
    new AgentPermissions({
      cwd: process.cwd(),
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
    });
  const calls = new Map<
    string,
    (
      args: Record<string, unknown>,
      context?: AgentMcpInvocationContext,
    ) => Promise<string>
  >();
  const invoke = async (
    name: string,
    args: Record<string, unknown>,
    context?: AgentMcpInvocationContext,
  ): Promise<string> => {
    const call = calls.get(name);
    if (!call) throw new Error(`MCP tool is unavailable: ${name}`);
    return call(args, context);
  };
  const invokeServer = (
    server: string,
    name: string,
    args: Record<string, unknown>,
    context?: AgentMcpInvocationContext,
  ) => invoke(`mcp__${server}__${name}`, args, context);
  const servers: MCPServer[] = [];
  const secrets = new Set<string>();
  const credentialName = (name: string) =>
    /(?:key|token|secret|password|credential|authorization)/i.test(name);
  // Values of explicitly named credentials remain sensitive through ordinary aliases.
  // Repository names, PATH, and mode flags must never become redaction patterns.
  const credentialValues = new Set(
    Object.entries(options.environment)
      .filter(([name, value]) => credentialName(name) && value.length > 0)
      .map(([, value]) => value),
  );
  const isCredential = (name: string, value: string) =>
    credentialName(name) || credentialValues.has(value);
  const tools: Tool[] = [];
  const names = new Set<string>();
  const controller = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;
  const ajv = new Ajv({ strict: false, allErrors: true });
  const remaining = () => Math.max(1, options.deadline - Date.now());
  const check = (context?: AgentMcpInvocationContext) => {
    if (context?.deadline !== undefined && !Number.isFinite(context.deadline))
      throw new Error("MCP invocation deadline must be finite");
    if (context?.deadline !== undefined && Date.now() >= context.deadline)
      throw new Error("MCP invocation deadline exceeded");
    if (context?.signal?.aborted) throw new Error("MCP execution cancelled");
    if (closed || controller.signal.aborted || options.signal?.aborted)
      throw new Error("MCP execution cancelled");
    if (Date.now() >= options.deadline)
      throw new Error("MCP execution deadline exceeded");
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    controller.abort();
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onAbort);
    // A broken remote must not prevent cleanup of the remaining transports.
    closing = Promise.allSettled(
      servers.map(async (server) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            server.close(),
            new Promise<void>((done) => {
              timer = setTimeout(done, 3000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }),
    ).then(() => undefined);
    return closing;
  };
  const onAbort = () => {
    controller.abort();
    void close();
  };
  const deadlineTimer = setTimeout(onAbort, remaining());
  deadlineTimer.unref?.();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  async function bounded<T>(
    operation: () => Promise<T>,
    timeout = remaining(),
    context?: AgentMcpInvocationContext,
  ): Promise<T> {
    check(context);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          abort = () =>
            reject(new Error("MCP execution cancelled or deadline exceeded"));
          controller.signal.addEventListener("abort", abort, { once: true });
          context?.signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(
            () => {
              controller.abort();
              reject(new Error("MCP execution deadline exceeded"));
              void close();
            },
            Math.max(
              1,
              Math.min(
                remaining(),
                timeout,
                context?.deadline === undefined
                  ? Infinity
                  : context.deadline - Date.now(),
              ),
            ),
          );
          if (controller.signal.aborted) abort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) {
        controller.signal.removeEventListener("abort", abort);
        context?.signal?.removeEventListener("abort", abort);
      }
    }
  }
  const expand = (value: string): string =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
      const resolved = options.environment[key];
      if (resolved === undefined)
        throw new Error(`MCP environment variable is not set: ${key}`);
      if (resolved && isCredential(key, resolved)) secrets.add(resolved);
      return resolved;
    });
  const secretValues = (values: Record<string, string>, headers = false) => {
    // Arbitrary custom HTTP header names may carry credentials; conservatively
    // mask all configured header values. Stdio env uses credential classification.
    for (const [name, value] of Object.entries(values))
      if (value && (headers || isCredential(name, value))) secrets.add(value);
  };
  try {
    check();
    for (const [serverName, entry] of Object.entries(config.mcpServers)) {
      check();
      if (!/^[A-Za-z0-9_:-]+$/.test(serverName) || !record(entry))
        throw new Error("Invalid MCP server configuration");
      const timeout = Math.min(Math.max(initTimeout, toolTimeout), remaining());
      const common = {
        name: serverName,
        timeout,
        clientSessionTimeoutSeconds: timeout / 1000,
        cacheToolsList: true,
      };
      let server: MCPServer;
      if (typeof entry.url === "string") {
        const url = new URL(expand(entry.url));
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error(
            "MCP URL must use HTTP/HTTPS without embedded credentials",
          );
        if (entry.headers !== undefined && entry.http_headers !== undefined)
          throw new Error("Supply either headers or http_headers");
        const headers = Object.fromEntries(
          Object.entries(
            strings(entry.headers ?? entry.http_headers, "MCP headers"),
          ).map(([key, value]) => [key, expand(value)]),
        );
        for (const [key, variable] of Object.entries(
          strings(entry.env_http_headers, "MCP environment headers"),
        )) {
          if (!options.environment[variable])
            throw new Error(
              `MCP header environment variable is not set: ${variable}`,
            );
          headers[key] = options.environment[variable]!;
        }
        if (entry.bearer_token_env_var !== undefined) {
          if (
            typeof entry.bearer_token_env_var !== "string" ||
            !options.environment[entry.bearer_token_env_var]
          )
            throw new Error("MCP bearer token environment variable is not set");
          headers.Authorization = `Bearer ${options.environment[entry.bearer_token_env_var]}`;
          secrets.add(options.environment[entry.bearer_token_env_var]!);
        }
        if (
          Object.entries(headers).some(([key, value]) =>
            /[\r\n]/.test(key + value),
          )
        )
          throw new Error("MCP headers must not contain newlines");
        secretValues(headers, true);
        const fetchWithSignal = (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) =>
          fetch(input, {
            ...init,
            signal: AbortSignal.any([
              controller.signal,
              ...(init?.signal ? [init.signal] : []),
            ]),
          });
        const http = {
          ...common,
          url: url.href,
          requestInit: { headers },
          fetch: fetchWithSignal,
        };
        if (entry.type === "sse") {
          server = new MCPServerSSE({
            ...http,
            eventSourceInit: { fetch: fetchWithSignal },
          });
        } else if (
          entry.type === undefined ||
          ["http", "streamable-http"].includes(String(entry.type))
        )
          server = new MCPServerStreamableHttp(http);
        else throw new Error("Unsupported HTTP MCP transport");
      } else {
        if (entry.type !== undefined && entry.type !== "stdio")
          throw new Error("Unsupported MCP transport");
        if (
          typeof entry.command !== "string" ||
          !entry.command ||
          (entry.args !== undefined &&
            (!Array.isArray(entry.args) ||
              entry.args.some((arg) => typeof arg !== "string")))
        )
          throw new Error("MCP stdio requires command and string args");
        // The transport merges its default environment even when env is supplied.
        // Override every such default to prevent ambient HOME/PATH inheritance.
        const defaults = [
          "HOME",
          "LOGNAME",
          "PATH",
          "SHELL",
          "TERM",
          "USER",
          "APPDATA",
          "COMSPEC",
          "HOMEDRIVE",
          "HOMEPATH",
          "LOCALAPPDATA",
          "PATHEXT",
          "PROCESSOR_ARCHITECTURE",
          "PROGRAMDATA",
          "PROGRAMFILES",
          "PROGRAMFILES(X86)",
          "PROGRAMW6432",
          "SYSTEMDRIVE",
          "SYSTEMROOT",
          "TEMP",
          "USERNAME",
          "USERPROFILE",
          "WINDIR",
        ];
        const env = {
          ...Object.fromEntries(defaults.map((key) => [key, ""])),
          ...options.environment,
        };
        for (const key of Object.keys(env))
          if (/^(OPENAI_|CODEX_)/i.test(key)) delete env[key];
        const explicit = Object.fromEntries(
          Object.entries(strings(entry.env, "MCP stdio env")).map(
            ([key, value]) => [key, expand(value)],
          ),
        );
        secretValues(explicit);
        Object.assign(env, explicit);
        if (entry.cwd !== undefined && typeof entry.cwd !== "string")
          throw new Error("MCP cwd must be a string");
        server = new MCPServerStdio({
          ...common,
          command: expand(entry.command),
          args: (entry.args as string[] | undefined)?.map(expand),
          env,
          cwd: entry.cwd as string | undefined,
        });
      }
      servers.push(server);
      await bounded(() => server.connect(), initTimeout);
      const listed = await bounded(() => server.listTools(), initTimeout);
      for (const mcpTool of listed) {
        const legacyName = `mcp__${serverName}__${mcpTool.name}`;
        const name = `mcp__${serverName.replace(/:/g, "_")}__${mcpTool.name}`;
        if (!/^[A-Za-z0-9_-]+$/.test(mcpTool.name) || name.length > 64)
          throw new Error(
            "MCP tool name cannot be represented as an OpenAI function name",
          );
        if (names.has(name)) throw new Error("Duplicate MCP tool name");
        names.add(name);
        const validate = ajv.compile(mcpTool.inputSchema);
        const execute = async (
          original: Record<string, unknown>,
          context?: AgentMcpInvocationContext,
        ): Promise<string> => {
          let input = original;
          const eventName = legacyName;
          try {
            check(context);
            permissions.assertDenied(eventName);
            const hook = context?.skipHooks
              ? undefined
              : await bounded(
                  async () => options.beforeTool?.({ name: eventName, input }),
                  toolTimeout,
                  context,
                );
            input = hook?.updatedInput ?? input;
            if (hook?.updatedPermissions)
              permissions.applyUpdates(hook.updatedPermissions);
            permissions.assertDenied(eventName);
            let decision = context?.skipHooks
              ? ("allow" as const)
              : hook?.permissionDecision;
            if (decision === "deny")
              permissions.authorize(eventName, undefined, decision);
            if (
              !context?.skipHooks &&
              (decision === "ask" ||
                (decision !== "allow" &&
                  permissions.needsApproval(eventName))) &&
              options.permissionRequest
            ) {
              const request = await bounded(
                async () =>
                  options.permissionRequest?.({ name: eventName, input }),
                toolTimeout,
                context,
              );
              input = request?.updatedInput ?? input;
              if (request?.updatedPermissions)
                permissions.applyUpdates(request.updatedPermissions);
              decision = request?.permissionDecision;
            }
            permissions.authorize(eventName, undefined, decision);
            if (!validate(input))
              throw new Error(
                `Invalid MCP tool arguments: ${ajv.errorsText(validate.errors)}`,
              );
            const callSignal = context?.signal
              ? AbortSignal.any([controller.signal, context.signal])
              : controller.signal;
            const result = await bounded(
              () =>
                server.callToolResult
                  ? server.callToolResult(mcpTool.name, input, null, {
                      signal: callSignal,
                    })
                  : server
                      .callTool(mcpTool.name, input, null, {
                        signal: callSignal,
                      })
                      .then((content) => ({ content })),
              toolTimeout,
              context,
            );
            const output = JSON.stringify(result);
            if (!context?.skipHooks)
              await bounded(
                async () =>
                  options.afterTool?.({ name: eventName, input, output }),
                toolTimeout,
                context,
              );
            return hook?.additionalContext
              ? `${output}\n${hook.additionalContext}`
              : output;
          } catch (error) {
            if (!controller.signal.aborted && !context?.skipHooks)
              await bounded(
                async () =>
                  options.afterTool?.({ name: eventName, input, error }),
                toolTimeout,
                context,
              );
            throw error;
          }
        };
        if (calls.has(legacyName))
          throw new Error("Duplicate MCP tool identifier");
        calls.set(legacyName, execute);
        calls.set(name, execute);
        tools.push(
          tool({
            name,
            description: mcpTool.description ?? `MCP tool ${legacyName}`,
            // Non-strict SDK types assume additionalProperties:true, but MCP may use false.
            // Preserve the server's original JSON schema at runtime.
            parameters: mcpTool.inputSchema as typeof mcpTool.inputSchema & {
              additionalProperties: true;
            },
            strict: false,
            errorFunction: null,
            execute: async (input) => execute(input as Record<string, unknown>),
          }),
        );
      }
    }
    return { tools, secrets: [...secrets], close, invoke, invokeServer };
  } catch (error) {
    await close();
    throw error;
  }
}
