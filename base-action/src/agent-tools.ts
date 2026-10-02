import {
  tool,
  type Tool,
  type ToolCallOutputContent,
  type ToolOutputImage,
  type ToolOutputFileContent,
  type JsonSchemaDefinition,
} from "@openai/agents";
import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { createInteractionTools } from "./agent-interaction-tools";
import {
  AgentPermissions,
  globPattern,
  type AgentPermissionOptions,
  type PermissionUpdate,
} from "./agent-permissions";

export type AgentToolEvent = {
  name: string;
  input: Record<string, unknown>;
  output?: string;
  error?: unknown;
};
export type AgentToolHookResult = {
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  permissionDecision?: "allow" | "deny" | "ask" | "defer";
  updatedPermissions?: PermissionUpdate[];
};
export type BackgroundAgentTask = {
  type: string;
  getOutput: () => string;
  stop: () => Promise<string>;
  done: Promise<void>;
};
export type AgentToolOptions = AgentPermissionOptions & {
  env: Record<string, string>;
  deadline?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  permissions?: AgentPermissions;
  backgroundTasks?: Map<string, BackgroundAgentTask>;
  beforeTool?: (event: AgentToolEvent) => Promise<void | AgentToolHookResult>;
  permissionRequest?: (
    event: AgentToolEvent,
  ) => Promise<void | AgentToolHookResult>;
  afterTool?: (
    event: AgentToolEvent,
  ) => Promise<void | { updatedMCPToolOutput?: unknown }>;
};

type ShellJob = {
  output: string;
  truncated: boolean;
  exitCode: number | null;
  running: boolean;
  stop: () => void;
  done: Promise<void>;
};
type AgentToolResult = string | ToolCallOutputContent[];
const optionalString = z.string().nullable().optional();
const optionalNumber = z.number().int().nonnegative().nullable().optional();

/** Local coding capabilities executed by the Agents SDK, without a native agent CLI. */
export function createAgentTools(options: AgentToolOptions): Tool[] {
  const permissions =
    options.permissions ?? new AgentPermissions({ ...options });
  const outputLimit = options.maxOutputBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 256)
    throw new Error("maxOutputBytes must be at least 256");
  if (options.deadline !== undefined && !Number.isFinite(options.deadline))
    throw new Error("deadline must be finite");
  const jobs = new Map<string, ShellJob>();
  const bounded = (text: string) => {
    const bytes = Buffer.from(text);
    return bytes.length > outputLimit
      ? bytes.subarray(0, outputLimit).toString("utf8") + "\n[output truncated]"
      : text;
  };
  const check = () => {
    if (options.signal?.aborted) throw new Error("Tool execution cancelled");
    if (options.deadline !== undefined && Date.now() >= options.deadline)
      throw new Error("Tool execution timed out");
  };
  const readText = async (path: string) => {
    check();
    if ((await stat(path)).size > 8 * 1024 * 1024)
      throw new Error("File exceeds the 8 MiB read limit");
    return readFile(path, "utf8");
  };
  const saveText = async (name: string, path: string, content: string) => {
    check();
    if (Buffer.byteLength(content) > 8 * 1024 * 1024)
      throw new Error("File exceeds the 8 MiB write limit");
    // Recheck immediately before mutation, including after asynchronous hooks/reads.
    await permissions.resolvePath(name, path);
    await mkdir(dirname(path), { recursive: true });
    await permissions.resolvePath(name, path);
    check();
    await writeFile(path, content, "utf8");
  };
  function define<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    execute: (input: z.infer<z.ZodObject<S>>) => Promise<AgentToolResult>,
  ): Tool {
    const schema =
      name === "ExitPlanMode" ? z.object(shape).passthrough() : z.object(shape);
    const invoke = async (original: unknown): Promise<AgentToolResult> => {
      let input = schema.parse(original);
      let additionalContext: string | undefined;
      let afterCalled = false;
      try {
        check();
        const before = await options.beforeTool?.({
          name,
          input: input as Record<string, unknown>,
        });
        permissions.assertDenied(
          name,
          permissionTarget(name, original as Record<string, unknown>),
        );
        if (before?.updatedInput) input = schema.parse(before.updatedInput);
        if (before?.updatedPermissions)
          permissions.applyUpdates(before.updatedPermissions);
        additionalContext = before?.additionalContext;
        check();
        let target = permissionTarget(name, input as Record<string, unknown>);
        permissions.assertDenied(name, target);
        let decision =
          before?.permissionDecision ??
          (name === "AskUserQuestion" && before?.updatedInput?.answers
            ? "allow"
            : undefined);
        if (decision === "deny") permissions.authorize(name, target, decision);
        if (
          (decision === "ask" ||
            (decision !== "allow" &&
              permissions.needsApproval(name, target))) &&
          options.permissionRequest &&
          permissions.options.permissionMode !== "dontAsk"
        ) {
          const request = await options.permissionRequest({
            name,
            input: input as Record<string, unknown>,
          });
          if (request?.updatedInput) input = schema.parse(request.updatedInput);
          if (request?.updatedPermissions)
            permissions.applyUpdates(request.updatedPermissions);
          if (request?.additionalContext)
            additionalContext = [additionalContext, request.additionalContext]
              .filter(Boolean)
              .join("\n");
          target = permissionTarget(name, input as Record<string, unknown>);
          decision =
            request?.permissionDecision ??
            (name === "AskUserQuestion" && request?.updatedInput?.answers
              ? "allow"
              : undefined);
        }
        permissions.authorize(name, target, decision);
        check();
        const result = await permissions.withAuthorization(name, target, () =>
          execute(input),
        );
        const output =
          typeof result === "string"
            ? bounded(result)
            : bounded(
                result
                  .map((item) => {
                    if (item.type === "text") return item.text;
                    if (item.type === "image")
                      return "[structured image content]";
                    return `[structured file content: ${typeof item.file === "object" && "filename" in item.file ? item.file.filename : "file"}]`;
                  })
                  .join("\n"),
              );
        afterCalled = true;
        await options.afterTool?.({
          name,
          input: input as Record<string, unknown>,
          output,
        });
        check();
        if (typeof result !== "string")
          return additionalContext
            ? [
                ...result,
                { type: "text" as const, text: bounded(additionalContext) },
              ]
            : result;
        return bounded(
          additionalContext ? `${output}\n${additionalContext}` : output,
        );
      } catch (error) {
        if (!afterCalled)
          await options.afterTool?.({
            name,
            input: input as Record<string, unknown>,
            error,
          });
        throw error;
      }
    };
    if (name === "AskUserQuestion" || name === "ExitPlanMode")
      return tool({
        name,
        description,
        parameters: {
          ...(z.toJSONSchema(schema, {
            io: "input",
          }) as JsonSchemaDefinition["schema"]),
          additionalProperties: true as const,
        },
        strict: false,
        execute: invoke,
      });
    return tool({
      name,
      description,
      parameters: z.object(shape),
      execute: invoke,
    });
  }

  async function files(name: string, rootInput: string): Promise<string[]> {
    const root = await permissions.resolvePath(name, rootInput);
    if (!(await stat(root)).isDirectory()) return [root];
    const result: string[] = [];
    let visited = 0;
    async function walk(directory: string): Promise<void> {
      check();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++visited > 20_000)
          throw new Error(
            "Directory search exceeds the 20,000 entry limit; narrow the path",
          );
        if (entry.name === ".git" || entry.isSymbolicLink()) continue;
        const path = resolve(directory, entry.name);
        // File-specific rules may exclude entries without excluding the entire search.
        try {
          await permissions.resolvePath(name, path);
        } catch {
          continue;
        }
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) result.push(path);
      }
    }
    await walk(root);
    return result.sort();
  }

  function startShell(
    command: string,
    timeout: number,
    name: "Bash" | "PowerShell" = "Bash",
  ): ShellJob {
    const executable =
      name === "Bash"
        ? "/bin/bash"
        : join(
            options.env.SystemRoot ?? options.env.SYSTEMROOT ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          );
    const args =
      name === "Bash"
        ? ["--noprofile", "--norc", "-c", command]
        : ["-NoProfile", "-NonInteractive", "-Command", command];
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: { ...options.env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolveDone!: () => void;
    const job: ShellJob = {
      output: "",
      truncated: false,
      exitCode: null,
      running: true,
      done: new Promise<void>((done) => {
        resolveDone = done;
      }),
      stop: () => {
        if (!job.running || !child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn(
            join(
              options.env.SystemRoot ?? options.env.SYSTEMROOT ?? "C:\\Windows",
              "System32",
              "taskkill.exe",
            ),
            ["/PID", String(child.pid), "/T", "/F"],
            { env: { ...options.env }, stdio: "ignore" },
          );
          killer.once("error", () => child.kill("SIGKILL"));
          return;
        }
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      },
    };
    const append = (chunk: Buffer) => {
      const remaining = outputLimit - Buffer.byteLength(job.output);
      if (chunk.length > remaining) job.truncated = true;
      if (remaining > 0)
        job.output += chunk.subarray(0, remaining).toString("utf8");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const abort = () => job.stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      append(Buffer.from("\n[shell timed out]"));
      job.stop();
    }, timeout);
    child.once("error", (error) => append(Buffer.from(error.message)));
    child.once("close", (code) => {
      job.exitCode = code;
      job.running = false;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolveDone();
    });
    if (options.signal?.aborted) job.stop();
    return job;
  }
  const shellResult = (job: ShellJob) =>
    `${job.output}${job.truncated ? "\n[output truncated]" : ""}\n[${job.running ? "running" : `exit code: ${job.exitCode}`} ]`;

  async function executeShell(
    name: "Bash" | "PowerShell",
    input: {
      command: string;
      timeout?: number | null;
      run_in_background?: boolean | null;
    },
  ): Promise<string> {
    permissions.assertTool(name, input.command);
    if (name === "PowerShell") {
      if (process.platform !== "win32")
        throw new Error("PowerShell is supported only on Windows runners");
      await stat(
        join(
          options.env.SystemRoot ?? options.env.SYSTEMROOT ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
      );
    }
    const requested = input.timeout ?? 120_000;
    if (requested <= 0) throw new Error("Shell timeout must be positive");
    const timeout = Math.max(
      1,
      Math.min(
        requested,
        600_000,
        (options.deadline ?? Date.now() + 600_000) - Date.now(),
      ),
    );
    const job = startShell(input.command, timeout, name);
    if (input.run_in_background) {
      if (jobs.size >= 32) {
        job.stop();
        await job.done;
        throw new Error("Background shell limit reached");
      }
      const id = randomUUID();
      jobs.set(id, job);
      options.backgroundTasks?.set(id, {
        type: "shell",
        getOutput: () => shellResult(job),
        stop: async () => {
          job.stop();
          await job.done;
          jobs.delete(id);
          options.backgroundTasks?.delete(id);
          return shellResult(job);
        },
        done: job.done,
      });
      return JSON.stringify({ shell_id: id, status: "running" });
    }
    await job.done;
    check();
    return shellResult(job);
  }

  return [
    ...createInteractionTools(permissions, define),
    define(
      "Bash",
      "Execute a shell command in the workspace. Use file tools for reading and editing files. Read-only/plan mode disables shell execution.",
      {
        command: z.string().min(1),
        timeout: optionalNumber,
        run_in_background: z.boolean().nullable().optional(),
        description: optionalString,
      },
      (input) => executeShell("Bash", input),
    ),
    define(
      "PowerShell",
      "Execute a PowerShell command on Windows runners with profiles disabled and the explicit tool environment.",
      {
        command: z.string().min(1),
        timeout: optionalNumber,
        run_in_background: z.boolean().nullable().optional(),
        description: optionalString,
      },
      (input) => executeShell("PowerShell", input),
    ),

    define(
      "BashOutput",
      "Read captured output and status of a background shell started in this run.",
      { bash_id: z.string() },
      async ({ bash_id }) => {
        permissions.assertTool("BashOutput");
        const job = jobs.get(bash_id);
        if (!job) throw new Error("Unknown background shell");
        return shellResult(job);
      },
    ),
    define(
      "KillShell",
      "Stop a background shell started in this run.",
      { shell_id: z.string() },
      async ({ shell_id }) => {
        permissions.assertTool("KillShell");
        const job = jobs.get(shell_id);
        if (!job) throw new Error("Unknown background shell");
        job.stop();
        await job.done;
        jobs.delete(shell_id);
        options.backgroundTasks?.delete(shell_id);
        return shellResult(job);
      },
    ),
    define(
      "Read",
      "Read UTF-8 text with one-based line numbers, or PNG/JPEG/GIF/WebP images and PDF files as structured model content. Files are limited to 8 MiB; offsets/limits apply only to text.",
      { file_path: z.string(), offset: optionalNumber, limit: optionalNumber },
      async ({ file_path, offset, limit }) => {
        const path = await permissions.resolvePath("Read", file_path);
        if ((await stat(path)).size > 8 * 1024 * 1024)
          throw new Error("File exceeds the 8 MiB read limit");
        const bytes = await readFile(path);
        if (bytes.length > 8 * 1024 * 1024)
          throw new Error("File exceeds the 8 MiB read limit");
        check();
        const mediaType = readMediaType(bytes);
        if (mediaType) {
          if (offset != null || limit != null)
            throw new Error("Read offset and limit apply only to text files");
          const data = new Uint8Array(bytes);
          if (mediaType === "application/pdf") {
            const file: ToolOutputFileContent = {
              type: "file",
              file: { data, mediaType, filename: basename(path) },
            };
            return [file];
          }
          const image: ToolOutputImage = {
            type: "image",
            image: { data, mediaType },
            detail: "auto",
          };
          return [image];
        }
        if (/^\.(?:png|jpe?g|gif|webp|pdf)$/i.test(extname(path)))
          throw new Error("Unsupported or invalid image/PDF file signature");
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error(
            "Unsupported binary file; Read supports UTF-8 text, PNG/JPEG/GIF/WebP images, and PDF files",
          );
        }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content))
          throw new Error(
            "Unsupported binary file; Read supports UTF-8 text, PNG/JPEG/GIF/WebP images, and PDF files",
          );
        const lines = content.split("\n");
        const start = Math.max(0, (offset ?? 1) - 1);
        return lines
          .slice(start, start + (limit ?? 2000))
          .map((line, index) => `${start + index + 1}\t${line}`)
          .join("\n");
      },
    ),
    define(
      "Write",
      "Create or replace a UTF-8 file inside permitted directories.",
      { file_path: z.string(), content: z.string() },
      async ({ file_path, content }) => {
        const path = await permissions.resolvePath("Write", file_path);
        await saveText("Write", path, content);
        return `Wrote ${Buffer.byteLength(content)} bytes to ${file_path}`;
      },
    ),
    define(
      "Edit",
      "Replace an exact string in a file. Ambiguous matches require replace_all=true.",
      {
        file_path: z.string(),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().nullable().optional(),
      },
      async (input) => {
        const path = await permissions.resolvePath("Edit", input.file_path);
        const original = await readText(path);
        const changed = replace(
          original,
          input.old_string,
          input.new_string,
          input.replace_all ?? false,
        );
        await saveText("Edit", path, changed);
        return `Edited ${input.file_path}`;
      },
    ),
    define(
      "MultiEdit",
      "Apply multiple exact-string edits atomically to one file; no write occurs if an edit fails.",
      {
        file_path: z.string(),
        edits: z
          .array(
            z.object({
              old_string: z.string().min(1),
              new_string: z.string(),
              replace_all: z.boolean().nullable().optional(),
            }),
          )
          .min(1),
      },
      async ({ file_path, edits }) => {
        const path = await permissions.resolvePath("MultiEdit", file_path);
        let content = await readText(path);
        for (const edit of edits)
          content = replace(
            content,
            edit.old_string,
            edit.new_string,
            edit.replace_all ?? false,
          );
        await saveText("MultiEdit", path, content);
        return `Applied ${edits.length} edits to ${file_path}`;
      },
    ),
    define(
      "Glob",
      "Find file paths matching *, **, and ? under a directory. Symlinks and .git are skipped.",
      { pattern: z.string(), path: optionalString },
      async ({ pattern, path }) => {
        const root = resolve(options.cwd, path ?? ".");
        const matcher = globPattern(pattern);
        const candidates = await files("Glob", path ?? ".");
        return candidates
          .filter((file) =>
            matcher.test(relative(root, file).split("\\").join("/")),
          )
          .map((file) => relative(options.cwd, file))
          .join("\n");
      },
    ),
    define(
      "LS",
      "List a directory's immediate entries. Symlinks are displayed but never followed.",
      { path: z.string(), ignore: z.array(z.string()).nullable().optional() },
      async (input) => {
        const root = await permissions.resolvePath("LS", input.path);
        const ignored = (input.ignore ?? []).map(globPattern);
        const entries = (await readdir(root, { withFileTypes: true })).sort(
          (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
        );
        if (entries.length > 20_000)
          throw new Error("Directory exceeds the 20,000 entry limit");
        const output: string[] = [];
        let bytes = 0;
        for (const entry of entries) {
          check();
          if (ignored.some((pattern) => pattern.test(entry.name))) continue;
          try {
            permissions.assertTool("LS", resolve(root, entry.name));
          } catch {
            continue;
          }
          const line =
            entry.name +
            (entry.isSymbolicLink()
              ? " [symlink]"
              : entry.isDirectory()
                ? "/"
                : "");
          output.push(line);
          bytes += Buffer.byteLength(line);
          if (bytes > outputLimit) break;
        }
        return output.join("\n");
      },
    ),
    define(
      "Grep",
      "Search UTF-8 file contents using a regular expression, returning file and line matches. Symlinks and .git are skipped.",
      {
        pattern: z.string(),
        path: optionalString,
        glob: optionalString,
        "-i": z.boolean().nullable().optional(),
        head_limit: optionalNumber,
      },
      async (input) => {
        // An adversarial regexp must not block the agent's event loop, cancellation,
        // or deadline. Isolate matching in a disposable worker with a bounded wait.
        const worker = new Worker(
          `
        const {parentPort} = require('node:worker_threads');
        parentPort.on('message', ({content, pattern, flags, limit, bytes}) => {
          try {
            const expression = new RegExp(pattern, flags);
            const matches = []; let size = 0; let limited = false;
            const lines = content.split('\\n');
            for (let i = 0; i < lines.length; i++) {
              if (!expression.test(lines[i])) continue;
              matches.push({index: i, line: lines[i]}); size += Buffer.byteLength(lines[i]);
              if (matches.length >= limit || size >= bytes) {limited = true; break;}
            }
            parentPort.postMessage({matches, limited});
          } catch (error) {parentPort.postMessage({error: error.message});}
        });
      `,
          { eval: true, env: {} },
        );
        const match = (
          content: string,
          limit: number,
        ): Promise<{
          matches: { index: number; line: string }[];
          limited: boolean;
        }> =>
          new Promise((done, fail) => {
            const cleanup = () => {
              clearTimeout(timer);
              worker.off("message", message);
              worker.off("error", error);
              options.signal?.removeEventListener("abort", abort);
            };
            const error = (error: Error) => {
              cleanup();
              fail(error);
            };
            const abort = () => error(new Error("Tool execution cancelled"));
            const message = (result: {
              error?: string;
              matches: { index: number; line: string }[];
              limited: boolean;
            }) => {
              cleanup();
              if (result.error) fail(new Error(result.error));
              else done(result);
            };
            const timer = setTimeout(
              () => error(new Error("Grep regular expression timed out")),
              Math.max(
                1,
                Math.min(
                  2000,
                  (options.deadline ?? Date.now() + 2000) - Date.now(),
                ),
              ),
            );
            worker.once("message", message);
            worker.once("error", error);
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) {
              abort();
              return;
            }
            worker.postMessage({
              content,
              pattern: input.pattern,
              flags: input["-i"] ? "i" : "",
              limit,
              bytes: outputLimit,
            });
          });
        const root = resolve(options.cwd, input.path ?? ".");
        const matcher = input.glob ? globPattern(input.glob) : undefined;
        const matches: string[] = [];
        let bytes = 0;
        try {
          for (const path of await files("Grep", input.path ?? ".")) {
            if (matcher && !matcher.test(relative(root, path))) continue;
            if ((await stat(path)).size > 8 * 1024 * 1024) continue;
            const content = await readText(path);
            if (content.includes("\0")) continue;
            const found = await match(
              content,
              Math.max(1, (input.head_limit ?? 200) - matches.length),
            );
            for (const line of found.matches) {
              const result = `${relative(options.cwd, path)}:${line.index + 1}:${line.line}`;
              matches.push(result);
              bytes += Buffer.byteLength(result);
              if (
                matches.length >= (input.head_limit ?? 200) ||
                bytes > outputLimit
              )
                return matches.join("\n") + "\n[matches limited]";
            }
            if (found.limited)
              return matches.join("\n") + "\n[matches limited]";
          }
          return matches.join("\n");
        } finally {
          await worker.terminate();
        }
      },
    ),
    define(
      "NotebookEdit",
      "Replace, insert, or delete a Jupyter notebook cell by cell_id or zero-based cell_index.",
      {
        notebook_path: z.string(),
        new_source: z.string(),
        cell_id: optionalString,
        cell_index: optionalNumber,
        cell_type: z.enum(["code", "markdown"]).nullable().optional(),
        edit_mode: z
          .enum(["replace", "insert", "delete"])
          .nullable()
          .optional(),
      },
      async (input) => {
        const path = await permissions.resolvePath(
          "NotebookEdit",
          input.notebook_path,
        );
        const notebook: unknown = JSON.parse(await readText(path));
        if (
          !notebook ||
          typeof notebook !== "object" ||
          !("cells" in notebook) ||
          !Array.isArray(notebook.cells)
        )
          throw new Error("Invalid notebook cells");
        const cells = notebook.cells as Record<string, unknown>[];
        const index = input.cell_id
          ? cells.findIndex((cell) => cell.id === input.cell_id)
          : (input.cell_index ?? 0);
        const mode = input.edit_mode ?? "replace";
        if (index < 0 || index >= cells.length + (mode === "insert" ? 1 : 0))
          throw new Error("Notebook cell does not exist");
        if (mode === "delete") cells.splice(index, 1);
        else {
          const cellType =
            input.cell_type ??
            (mode === "replace" ? cells[index]?.cell_type : "code");
          if (cellType !== "code" && cellType !== "markdown")
            throw new Error("Unsupported notebook cell type");
          const cell: Record<string, unknown> = {
            ...(mode === "replace" ? cells[index] : {}),
            id:
              mode === "replace"
                ? (cells[index]?.id ?? randomUUID())
                : randomUUID(),
            cell_type: cellType,
            metadata: mode === "replace" ? (cells[index]?.metadata ?? {}) : {},
            source: input.new_source.split(/(?<=\n)/),
          };
          if (cellType === "code") {
            cell.outputs = [];
            cell.execution_count = null;
          } else {
            delete cell.outputs;
            delete cell.execution_count;
          }
          cells.splice(index, mode === "insert" ? 0 : 1, cell);
        }
        await saveText(
          "NotebookEdit",
          path,
          JSON.stringify(notebook, null, 2) + "\n",
        );
        return `${mode} notebook cell ${index}`;
      },
    ),
    define(
      "TodoWrite",
      "Maintain the current run's task list.",
      {
        todos: z.array(
          z.object({
            content: z.string(),
            status: z.enum(["pending", "in_progress", "completed"]),
            activeForm: z.string(),
          }),
        ),
      },
      async (input) => {
        permissions.assertTool("TodoWrite");
        return JSON.stringify(input.todos);
      },
    ),
  ];
}

function replace(
  content: string,
  oldText: string,
  newText: string,
  all: boolean,
): string {
  const count = content.split(oldText).length - 1;
  if (!count) throw new Error("Edit old_string was not found");
  if (count > 1 && !all)
    throw new Error("Edit old_string is ambiguous; use replace_all");
  return all
    ? content.split(oldText).join(newText)
    : content.replace(oldText, () => newText);
}

function readMediaType(bytes: Uint8Array): string | undefined {
  const header = Buffer.from(bytes.subarray(0, 16));
  if (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (header.subarray(0, 5).toString("ascii") === "%PDF-")
    return "application/pdf";
  return undefined;
}

function permissionTarget(
  name: string,
  input: Record<string, unknown>,
): string | undefined {
  if (["Read", "Write", "Edit", "MultiEdit"].includes(name))
    return String(input.file_path);
  if (name === "NotebookEdit") return String(input.notebook_path);
  if (["Glob", "Grep", "LS"].includes(name)) return String(input.path ?? ".");
  if (name === "Bash" || name === "PowerShell") return String(input.command);
  return undefined;
}
