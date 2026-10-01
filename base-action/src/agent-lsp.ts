import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentPermissions } from "./agent-permissions";

export type LspOperation =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "goToImplementation"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls";
export type LspInput = {
  operation: LspOperation;
  filePath: string;
  line?: number | null;
  character?: number | null;
  query?: string | null;
};
export type AgentLspOptions = {
  cwd: string;
  env: Record<string, string>;
  servers: Record<string, unknown>;
  permissions: AgentPermissions;
  signal?: AbortSignal;
  deadline?: number;
  requestTimeoutMs?: number;
};
type ServerConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
  extensionToLanguage: Record<string, string>;
  initializationOptions?: unknown;
  startupTimeout: number;
  shutdownTimeout: number;
  workspaceFolder?: string;
  settings?: Record<string, unknown>;
  restartOnCrash: boolean;
  maxRestarts: number;
  diagnostics: boolean;
};
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
};
const MAX_MESSAGE = 4 * 1024 * 1024;
const MAX_DOCUMENT = 2 * 1024 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function config(value: unknown, name: string): ServerConfig {
  if (
    !record(value) ||
    typeof value.command !== "string" ||
    !value.command ||
    /[\x00\n\r]/.test(value.command)
  )
    throw new Error(`LSP ${name} requires a command`);
  if (
    value.transport !== undefined &&
    !["stdio", "socket"].includes(String(value.transport))
  )
    throw new Error(
      `LSP ${name} requires stdio/socket transport (both use stdio)`,
    );
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) ||
      value.args.some((arg) => typeof arg !== "string" || arg.includes("\0")))
  )
    throw new Error(`LSP ${name} args must be strings`);
  if (
    value.env !== undefined &&
    (!record(value.env) ||
      Object.values(value.env).some((item) => typeof item !== "string"))
  )
    throw new Error(`LSP ${name} env must contain strings`);
  if (
    !record(value.extensionToLanguage) ||
    Object.keys(value.extensionToLanguage).length === 0 ||
    Object.entries(value.extensionToLanguage).some(
      ([key, item]) =>
        !key.startsWith(".") || typeof item !== "string" || !item,
    )
  )
    throw new Error(`LSP ${name} requires extensionToLanguage`);
  for (const key of ["startupTimeout", "shutdownTimeout", "maxRestarts"]) {
    const number = value[key];
    if (
      number !== undefined &&
      (!Number.isSafeInteger(number) ||
        Number(number) < (key === "maxRestarts" ? 0 : 1))
    )
      throw new Error(`LSP ${name} ${key} must be a valid integer`);
  }
  for (const key of ["restartOnCrash", "diagnostics"])
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error(`LSP ${name} ${key} must be boolean`);
  if (value.settings !== undefined && !record(value.settings))
    throw new Error(`LSP ${name} settings must be an object`);
  if (
    value.workspaceFolder !== undefined &&
    (typeof value.workspaceFolder !== "string" ||
      value.workspaceFolder.includes("\0"))
  )
    throw new Error(`LSP ${name} workspaceFolder must be a path`);
  const startupTimeout = value.startupTimeout ?? 10_000;
  if (
    typeof startupTimeout !== "number" ||
    !Number.isFinite(startupTimeout) ||
    startupTimeout <= 0 ||
    startupTimeout > 120_000
  )
    throw new Error(
      `LSP ${name} startupTimeout must be between 1 and 120000 ms`,
    );
  return {
    command: value.command,
    args: (value.args ?? []) as string[],
    env: (value.env ?? {}) as Record<string, string>,
    extensionToLanguage: value.extensionToLanguage as Record<string, string>,
    initializationOptions: value.initializationOptions,
    startupTimeout,
    shutdownTimeout: (value.shutdownTimeout ?? 1000) as number,
    workspaceFolder: value.workspaceFolder as string | undefined,
    settings: value.settings as Record<string, unknown> | undefined,
    restartOnCrash: value.restartOnCrash !== false,
    maxRestarts: (value.maxRestarts ?? 3) as number,
    diagnostics: value.diagnostics !== false,
  };
}

class StdioLsp {
  private child?: ChildProcessWithoutNullStreams;
  private initialization?: Promise<void>;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, Pending>();
  private readonly opened = new Map<
    string,
    { text: string; version: number }
  >();
  private nextId = 1;
  private failure?: Error;
  private closed = false;
  private crashed = false;
  private readonly diagnostics: string[] = [];
  get didCrash() {
    return this.crashed;
  }
  drainDiagnostics() {
    return this.diagnostics.splice(0);
  }
  private get workspace() {
    return resolve(
      this.options.cwd,
      this.settings.workspaceFolder ?? this.options.cwd,
    );
  }
  private queued: Promise<unknown> = Promise.resolve();
  private readonly abort = () =>
    this.stop(new Error("LSP execution cancelled"));
  constructor(
    private readonly options: AgentLspOptions,
    private readonly settings: ServerConfig,
  ) {}
  private check() {
    if (this.closed || this.options.signal?.aborted)
      throw new Error("LSP execution cancelled");
    if (
      this.options.deadline !== undefined &&
      Date.now() >= this.options.deadline
    )
      throw new Error("LSP execution timed out");
    if (this.failure) throw this.failure;
  }
  private stop(error: Error) {
    this.failure ??= error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      this.options.signal?.removeEventListener("abort", entry.abort);
      entry.reject(error);
    }
    this.pending.clear();
    const child = this.child;
    if (child?.pid) {
      try {
        process.kill(
          process.platform === "win32" ? child.pid : -child.pid,
          "SIGKILL",
        );
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
  private send(message: Record<string, unknown>) {
    if (!this.child || this.child.stdin.destroyed)
      throw new Error("LSP server is unavailable");
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    if (Buffer.byteLength(body) > MAX_MESSAGE)
      throw new Error("LSP request exceeds 4 MiB");
    this.child.stdin.write(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }
  private notify(method: string, params?: unknown) {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }
  private request(
    method: string,
    params?: unknown,
    timeout = this.options.requestTimeoutMs ?? 30_000,
  ): Promise<unknown> {
    this.check();
    if (this.pending.size >= 32)
      throw new Error("LSP concurrent request limit reached");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.stop(new Error("LSP execution cancelled"));
      };
      const timer = setTimeout(
        () => this.stop(new Error(`LSP ${method} timed out`)),
        Math.max(
          1,
          Math.min(
            timeout,
            (this.options.deadline ?? Date.now() + timeout) - Date.now(),
          ),
        ),
      );
      this.pending.set(id, { resolve, reject, timer, abort });
      this.options.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.stop(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private receive(chunk: Buffer) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_MESSAGE + 8192)
        throw new Error("LSP response exceeds 4 MiB");
      for (;;) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.buffer.length > 8192) throw new Error("Invalid LSP header");
          break;
        }
        if (end > 8192) throw new Error("Invalid LSP header");
        const header = this.buffer.subarray(0, end).toString("ascii");
        const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
        if (!match) throw new Error("LSP response has no Content-Length");
        const length = Number(match[1]);
        if (!Number.isSafeInteger(length) || length > MAX_MESSAGE)
          throw new Error("LSP response exceeds 4 MiB");
        if (this.buffer.length < end + 4 + length) break;
        const message: unknown = JSON.parse(
          this.buffer.subarray(end + 4, end + 4 + length).toString("utf8"),
        );
        this.buffer = this.buffer.subarray(end + 4 + length);
        if (!record(message) || message.jsonrpc !== "2.0")
          throw new Error("Invalid LSP JSON-RPC message");
        if (typeof message.method === "string") {
          if (
            message.method === "textDocument/publishDiagnostics" &&
            this.settings.diagnostics &&
            record(message.params)
          ) {
            const text = JSON.stringify({
              type: "lsp_diagnostics",
              uri: message.params.uri,
              diagnostics: Array.isArray(message.params.diagnostics)
                ? message.params.diagnostics.slice(0, 100)
                : [],
            });
            this.diagnostics.push(
              Buffer.byteLength(text) > 65536
                ? text.slice(0, 65536) + " [diagnostics truncated]"
                : text,
            );
            if (this.diagnostics.length > 32) this.diagnostics.shift();
          }
          if (message.id !== undefined) {
            if (message.method === "workspace/configuration") {
              const items =
                record(message.params) && Array.isArray(message.params.items)
                  ? message.params.items
                  : [];
              this.send({
                id: message.id,
                result: items.map((item) => {
                  if (!record(item) || typeof item.section !== "string")
                    return this.settings.settings ?? null;
                  let value: unknown = this.settings.settings;
                  for (const key of item.section.split(".")) {
                    value =
                      record(value) &&
                      !["__proto__", "constructor", "prototype"].includes(key)
                        ? value[key]
                        : undefined;
                  }
                  return value ?? null;
                }),
              });
            } else if (message.method === "workspace/workspaceFolders")
              this.send({
                id: message.id,
                result: [
                  {
                    uri: pathToFileURL(this.workspace).href,
                    name: "workspace",
                  },
                ],
              });
            else if (message.method === "workspace/applyEdit")
              this.send({
                id: message.id,
                result: {
                  applied: false,
                  failureReason: "The LSP tool is read-only",
                },
              });
            else if (
              [
                "client/registerCapability",
                "client/unregisterCapability",
                "window/workDoneProgress/create",
                "window/showMessageRequest",
              ].includes(message.method)
            )
              this.send({ id: message.id, result: null });
            else
              this.send({
                id: message.id,
                error: { code: -32601, message: "Unsupported client method" },
              });
          }
          continue;
        }
        if (typeof message.id !== "number") continue;
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        this.options.signal?.removeEventListener("abort", entry.abort);
        if (message.error !== undefined)
          entry.reject(
            new Error(`LSP server error: ${JSON.stringify(message.error)}`),
          );
        else entry.resolve(message.result);
      }
    } catch (error) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private async initialize() {
    this.check();
    this.child = spawn(this.settings.command, this.settings.args, {
      cwd: this.options.cwd,
      env: { ...this.options.env, ...this.settings.env },
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    // Drain stderr without returning environment/configuration secrets to the model.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () =>
      this.stop(new Error("LSP input stream closed")),
    );
    this.child.once("error", () => {
      if (!this.failure && !this.closed) this.crashed = true;
      this.stop(new Error("LSP server failed to start"));
    });
    this.child.once("close", () => {
      if (!this.failure && !this.closed) this.crashed = true;
      this.stop(new Error("LSP server exited"));
    });
    this.options.signal?.addEventListener("abort", this.abort, { once: true });
    if (this.options.signal?.aborted) this.abort();
    await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: pathToFileURL(this.workspace).href,
        workspaceFolders: [
          { uri: pathToFileURL(this.workspace).href, name: "workspace" },
        ],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            synchronization: { didSave: false },
            definition: { linkSupport: true },
            implementation: { linkSupport: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
          },
        },
        initializationOptions: this.settings.initializationOptions ?? null,
      },
      this.settings.startupTimeout,
    );
    this.notify("initialized", {});
    if (this.settings.settings)
      this.notify("workspace/didChangeConfiguration", {
        settings: this.settings.settings,
      });
  }
  private async synchronize(path: string, language: string): Promise<string> {
    const uri = pathToFileURL(path).href;
    if ((await stat(path)).size > MAX_DOCUMENT)
      throw new Error("LSP document exceeds 2 MiB");
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > MAX_DOCUMENT)
      throw new Error("LSP document exceeds 2 MiB");
    this.check();
    const previous = this.opened.get(uri);
    if (!previous) {
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: language, version: 1, text },
      });
      this.opened.set(uri, { text, version: 1 });
    } else if (previous.text !== text) {
      previous.version++;
      previous.text = text;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: previous.version },
        contentChanges: [{ text }],
      });
    }
    return uri;
  }
  async notifyFileChanged(path: string, language: string): Promise<void> {
    const action = this.queued.then(async () => {
      this.check();
      if (!this.initialization) return;
      await this.initialization;
      await this.synchronize(path, language);
    });
    this.queued = action.catch(() => {});
    await action;
  }
  async execute(
    input: LspInput,
    path: string,
    language: string,
  ): Promise<unknown> {
    // Synchronize didOpen/didChange with each request to keep concurrent calls coherent.
    const action = this.queued.then(async () => {
      this.check();
      this.initialization ??= this.initialize();
      await this.initialization;
      const uri = await this.synchronize(path, language);
      const position = {
        line: (input.line ?? 1) - 1,
        character: (input.character ?? 1) - 1,
      };
      const params = { textDocument: { uri }, position };
      if (input.operation === "workspaceSymbol")
        return this.request("workspace/symbol", { query: input.query ?? "" });
      if (input.operation === "documentSymbol")
        return this.request("textDocument/documentSymbol", {
          textDocument: { uri },
        });
      if (input.operation === "findReferences")
        return this.request("textDocument/references", {
          ...params,
          context: { includeDeclaration: true },
        });
      if (
        input.operation === "incomingCalls" ||
        input.operation === "outgoingCalls"
      ) {
        const items = await this.request(
          "textDocument/prepareCallHierarchy",
          params,
        );
        if (!Array.isArray(items) || !items.length) return [];
        const output: unknown[] = [];
        for (const item of items.slice(0, 32))
          output.push(
            await this.request(`callHierarchy/${input.operation}`, { item }),
          );
        return output.flat();
      }
      const method = {
        goToDefinition: "definition",
        hover: "hover",
        goToImplementation: "implementation",
        prepareCallHierarchy: "prepareCallHierarchy",
      }[input.operation];
      return this.request(`textDocument/${method}`, params);
    });
    this.queued = action.catch(() => {});
    return action;
  }
  cancel() {
    this.stop(new Error("LSP execution cancelled"));
  }
  async close() {
    if (this.closed) return;
    if (this.child && !this.failure && !this.options.signal?.aborted) {
      try {
        await this.request(
          "shutdown",
          undefined,
          this.settings.shutdownTimeout,
        );
        this.notify("exit");
      } catch {
        /* forced termination below */
      }
    }
    this.closed = true;
    this.options.signal?.removeEventListener("abort", this.abort);
    this.stop(new Error("LSP server closed"));
    this.opened.clear();
  }
}

/** Read-only LSP facade. Configured servers are launched lazily with explicit env. */
export function createAgentLsp(options: AgentLspOptions): {
  execute(input: LspInput, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
  drainDiagnostics(): string[];
  notifyFileChanged(filePath: string): Promise<void>;
} {
  if (options.deadline !== undefined && !Number.isFinite(options.deadline))
    throw new Error("LSP deadline must be finite");
  if (
    options.requestTimeoutMs !== undefined &&
    (!Number.isFinite(options.requestTimeoutMs) ||
      options.requestTimeoutMs <= 0 ||
      options.requestTimeoutMs > 120_000)
  )
    throw new Error("LSP requestTimeoutMs must be between 1 and 120000 ms");
  const entries = Object.entries(options.servers).map(([name, value]) => ({
    name,
    settings: config(value, name),
    client: undefined as StdioLsp | undefined,
    restarts: 0,
    restarting: undefined as Promise<void> | undefined,
  }));
  let closed = false;
  const notices: string[] = [];
  return {
    execute: async (input, signal) => {
      if (signal?.aborted) throw new Error("LSP execution cancelled");
      if (closed) throw new Error("LSP server closed");
      if (!input.filePath) throw new Error("LSP filePath is required");
      for (const number of [input.line, input.character])
        if (number != null && (!Number.isSafeInteger(number) || number < 1))
          throw new Error("LSP positions must be positive one-based integers");
      const path = await options.permissions.resolvePath("LSP", input.filePath);
      const extension = extname(path);
      const entry = entries.find(
        ({ settings }) => settings.extensionToLanguage[extension],
      );
      if (!entry) throw new Error(`No configured LSP server for ${extension}`);
      for (;;) {
        entry.client ??= new StdioLsp(options, entry.settings);
        const client = entry.client,
          abort = () => client.cancel();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (signal?.aborted) abort();
          return await client.execute(
            input,
            path,
            entry.settings.extensionToLanguage[extension]!,
          );
        } catch (error) {
          if (
            !closed &&
            !signal?.aborted &&
            !options.signal?.aborted &&
            client.didCrash &&
            entry.settings.restartOnCrash &&
            (entry.restarting ||
              entry.client !== client ||
              entry.restarts < entry.settings.maxRestarts)
          ) {
            entry.restarting ??= (async () => {
              if (entry.client === client) {
                entry.restarts++;
                await client.close();
                entry.client = new StdioLsp(options, entry.settings);
              }
            })();
            const restarting = entry.restarting;
            await restarting;
            if (entry.restarting === restarting) entry.restarting = undefined;
            continue;
          }
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      }
    },
    notifyFileChanged: async (filePath) => {
      if (closed || options.signal?.aborted) return;
      let path: string;
      try {
        options.permissions.assertDenied("LSP", filePath);
        path = await options.permissions.resolvePath("Read", filePath);
      } catch {
        return;
      }
      const entry = entries.find(
        (item) =>
          item.client && item.settings.extensionToLanguage[extname(path)],
      );
      if (!entry?.client) return;
      try {
        await entry.client.notifyFileChanged(
          path,
          entry.settings.extensionToLanguage[extname(path)]!,
        );
      } catch (error) {
        if (entry.settings.diagnostics) {
          notices.push(
            JSON.stringify({
              type: "lsp_diagnostics_unavailable",
              filePath,
              error: String((error as Error).message).slice(0, 256),
            }),
          );
          if (notices.length > 32) notices.shift();
        }
      }
    },
    drainDiagnostics: () => [
      ...notices.splice(0),
      ...entries.flatMap((entry) => entry.client?.drainDiagnostics() ?? []),
    ],
    close: async () => {
      closed = true;
      await Promise.all(entries.map((entry) => entry.client?.close()));
    },
  };
}
