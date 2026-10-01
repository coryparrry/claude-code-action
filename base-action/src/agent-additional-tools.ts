import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type { AgentConfiguration } from "./agent-configuration";
import {
  AgentPermissions,
  type AgentPermissionOptions,
} from "./agent-permissions";
import type { AgentToolOptions } from "./agent-tools";
import { createAgentLsp } from "./agent-lsp";
import { randomUUID } from "node:crypto";
import { parseHooks, type HookMap } from "./agent-hooks";
import { createWorkflowRunner } from "./agent-workflows";
import type { BackgroundAgentTask } from "./agent-tools";
import {
  catalog,
  agentDefinitions,
  stringList,
  substitute,
  markdownEnvironment,
  preprocess,
  type AgentMarkdown,
} from "./agent-markdown";
export { parseAgentMarkdown, resolveAgentCommand } from "./agent-markdown";
export type { AgentMarkdown, ResolvedAgentCommand } from "./agent-markdown";

export type SubagentRequest = {
  agent: AgentMarkdown;
  name: string;
  instructions: string;
  prompt: string;
  description?: string;
  hooks?: HookMap;
  mcpServers?: unknown;
  preloadedSkills?: AgentMarkdown[];
  schema?: Record<string, unknown>;
  label?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionOptions: AgentPermissionOptions;
  deadline: number;
  signal: AbortSignal;
};
export type SummarizeRequest = {
  url: string;
  prompt: string;
  content: string;
  contentType: string;
  deadline: number;
  signal: AbortSignal;
};
export type SearchRequest = {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  deadline: number;
  signal: AbortSignal;
};
export type LoadedAgentSkill = AgentMarkdown & {
  allowedTools?: string[];
  model?: string;
  context?: string;
};
export type AdditionalAgentToolOptions = AgentToolOptions & {
  configuration: AgentConfiguration;
  onSkillLoaded?: (skill: LoadedAgentSkill) => Promise<void>;
  permissions?: AgentPermissions;
  runSubagent?: (request: SubagentRequest) => Promise<string>;
  summarize?: (request: SummarizeRequest) => Promise<string>;
  search?: (request: SearchRequest) => Promise<string>;
  toolTimeoutMs?: number;
  fetchMaxBytes?: number;
  sessionStoragePath?: string;
  workflowMaxConcurrent?: number;
};
const optionalString = z.string().nullable().optional();
function safeUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("WebFetch requires an HTTP(S) URL without credentials");
  url.hash = "";
  return url;
}
export function sanitizeFetchedContent(
  content: string,
  contentType: string,
): string {
  if (!contentType.includes("html")) return content.replace(/\x00/g, "");
  return content
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|iframe|object|svg|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      " ",
    )
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&#(?:x([0-9a-f]+)|(\d+));/gi,
      (_match, hex: string | undefined, decimal: string | undefined) => {
        const code = parseInt(hex ?? decimal!, hex ? 16 : 10);
        return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
          ? String.fromCodePoint(code)
          : " ";
      },
    )
    .replace(
      /&(amp|lt|gt|quot|apos|nbsp);/gi,
      (_match, entity: string) =>
        ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[
          entity.toLowerCase()
        ]!,
    )
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
async function fetchContent(
  raw: string,
  signal: AbortSignal,
  maxBytes: number,
  authorize: (url: string) => void,
): Promise<{ url: string; content: string; contentType: string }> {
  let url = safeUrl(raw);
  for (let redirects = 0; redirects <= 5; redirects++) {
    authorize(redirects ? url.href : raw);
    const response = await fetch(url, {
      signal,
      redirect: "manual",
      credentials: "omit",
      headers: {
        Accept: "text/html,text/plain,application/json,text/markdown;q=0.9",
        "User-Agent": "Codex-Action-Agent/1.0",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location || redirects === 5)
        throw new Error("WebFetch redirect limit exceeded or missing location");
      const redirected = safeUrl(new URL(location, url).href);
      if (url.protocol === "https:" && redirected.protocol !== "https:")
        throw new Error("WebFetch refuses an HTTPS downgrade");
      url = redirected;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`WebFetch failed with HTTP ${response.status}`);
    }
    const contentType =
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() ?? "text/plain";
    if (
      !/^text\//.test(contentType) &&
      !/^application\/(?:json|(?:[\w.-]+\+)?xml|xhtml\+xml|[\w.-]+\+json)$/.test(
        contentType,
      )
    ) {
      await response.body?.cancel();
      throw new Error(`WebFetch unsupported content type: ${contentType}`);
    }
    if (!response.body) return { url: url.href, content: "", contentType };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes)
          throw new Error(`WebFetch body exceeds ${maxBytes} bytes`);
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return {
      url: url.href,
      content: sanitizeFetchedContent(
        Buffer.concat(chunks).toString("utf8"),
        contentType,
      ),
      contentType,
    };
  }
  throw new Error("WebFetch redirect limit exceeded");
}

/** Real SDK tools; the parent runner supplies model callbacks and their budget. */
export function createAdditionalAgentTools(
  options: AdditionalAgentToolOptions,
): {
  tools: Tool[];
  close(): Promise<void>;
  drainDiagnostics(): string[];
  notifyFileChanged(filePath: string): Promise<void>;
} {
  const permissions = options.permissions ?? new AgentPermissions(options);
  const outputLimit = options.maxOutputBytes ?? 64 * 1024,
    fetchLimit = options.fetchMaxBytes ?? 1024 * 1024,
    timeout = options.toolTimeoutMs ?? 120_000;
  if (
    !Number.isSafeInteger(outputLimit) ||
    outputLimit < 256 ||
    outputLimit > 8 * 1024 * 1024
  )
    throw new Error("maxOutputBytes must be between 256 and 8388608");
  if (
    !Number.isSafeInteger(fetchLimit) ||
    fetchLimit < 256 ||
    fetchLimit > 8 * 1024 * 1024
  )
    throw new Error("fetchMaxBytes must be between 256 and 8388608");
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600_000)
    throw new Error("toolTimeoutMs must be between 1 and 600000");
  if (options.deadline !== undefined && !Number.isFinite(options.deadline))
    throw new Error("deadline must be finite");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let closed = false;
  const check = () => {
    if (closed || controller.signal.aborted)
      throw new Error("Additional tool execution cancelled");
    if (Date.now() >= (options.deadline ?? Infinity))
      throw new Error("Additional tool execution timed out");
  };
  const bounded = (text: string) => {
    const bytes = Buffer.from(text);
    return bytes.length > outputLimit
      ? bytes.subarray(0, outputLimit).toString("utf8") + "\n[output truncated]"
      : text;
  };
  let skills: Promise<AgentMarkdown[]> | undefined,
    agents: Promise<AgentMarkdown[]> | undefined;
  const skillCatalog = () =>
    (skills ??= Promise.all([
      catalog(
        options.configuration.skillDirectories,
        "skill",
        check,
        options.configuration,
      ),
      catalog(
        options.configuration.commandDirectories,
        "command",
        check,
        options.configuration,
      ),
    ]).then(([skills, commands]) => [
      ...skills,
      ...commands.filter(
        (command) => !skills.some((skill) => skill.name === command.name),
      ),
    ]));
  const agentCatalog = () =>
    (agents ??= agentDefinitions(options.configuration, check));
  const lsp = createAgentLsp({
    cwd: options.cwd,
    env: options.env,
    servers: options.configuration.lspServers ?? {},
    permissions,
    signal: controller.signal,
    deadline: options.deadline,
  });
  const backgroundTasks =
    options.backgroundTasks ?? new Map<string, BackgroundAgentTask>();
  const active = new Map<string, AbortController>();
  const ownedBackgroundIds = new Set<string>();
  const workflows = createWorkflowRunner({
    configuration: options.configuration,
    cwd: options.cwd,
    permissions,
    signal: controller.signal,
    deadline: options.deadline,
    sessionStoragePath: options.sessionStoragePath,
    runSubagent: options.runSubagent,
    maxConcurrent: options.workflowMaxConcurrent,
  });
  function startBackground(
    run: (signal: AbortSignal, deadline: number) => Promise<string>,
  ): string {
    if (active.size >= 32) throw new Error("Background subagent limit reached");
    const id = randomUUID(),
      child = new AbortController();
    active.set(id, child);
    ownedBackgroundIds.add(id);
    let output = "",
      status = "running";
    const abort = () => child.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    const deadline = options.deadline ?? Date.now() + 600_000;
    const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
    const cancelled = new Promise<never>((_, reject) =>
      child.signal.addEventListener(
        "abort",
        () => reject(new Error("Background task cancelled or timed out")),
        { once: true },
      ),
    );
    const done = Promise.race([run(child.signal, deadline), cancelled])
      .then(
        (result) => {
          output = bounded(result);
          status = "completed";
        },
        (error) => {
          output = String(error.message ?? error);
          status = child.signal.aborted ? "stopped" : "failed";
        },
      )
      .finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        active.delete(id);
      });
    const getOutput = () =>
      JSON.stringify({ task_id: id, type: "agent", status, output });
    backgroundTasks.set(id, {
      type: "agent",
      getOutput,
      done,
      stop: async () => {
        child.abort();
        await done;
        return getOutput();
      },
    });
    return JSON.stringify({ status: "async_launched", task_id: id });
  }
  async function limited<T>(
    run: (signal: AbortSignal, deadline: number) => Promise<T>,
  ): Promise<T> {
    check();
    const local = new AbortController();
    const deadline = Math.min(
      options.deadline ?? Infinity,
      Date.now() + timeout,
    );
    let rejectAbort!: (error: Error) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      local.abort();
      rejectAbort(
        new Error("Additional tool execution cancelled or timed out"),
      );
    };
    controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
    try {
      if (controller.signal.aborted) abort();
      return await Promise.race([run(local.signal, deadline), cancellation]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abort);
      local.abort();
    }
  }
  function define<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    execute: (
      input: z.infer<z.ZodObject<S>>,
      signal: AbortSignal,
      deadline: number,
    ) => Promise<string>,
  ): Tool {
    const schema = z.object(shape);
    const executeTool = async (original: unknown) => {
      let input = schema.parse(original),
        afterCalled = false;
      try {
        check();
        const targetFor = async () =>
          String(
            (input as Record<string, unknown>)[
              {
                Skill: "skill",
                Task: "subagent_type",
                WebFetch: "url",
                WebSearch: "query",
                LSP: "filePath",
                Workflow: "name",
              }[name] ?? ""
            ] ?? "",
          ) || undefined;
        permissions.assertDenied(name, await targetFor());
        const before = await options.beforeTool?.({
          name,
          input: input as Record<string, unknown>,
        });
        if (before?.updatedInput) input = schema.parse(before.updatedInput);
        if (before?.updatedPermissions)
          permissions.applyUpdates(before.updatedPermissions);
        let context = before?.additionalContext;
        let decision = before?.permissionDecision;
        let target = await targetFor();
        permissions.assertDenied(name, target);
        if (decision === "deny") permissions.authorize(name, target, decision);
        if (
          (decision === "ask" ||
            (decision !== "allow" &&
              permissions.needsApproval(name, target))) &&
          options.permissionRequest
        ) {
          const request = await options.permissionRequest({
            name,
            input: input as Record<string, unknown>,
          });
          if (request?.updatedInput) input = schema.parse(request.updatedInput);
          if (request?.updatedPermissions)
            permissions.applyUpdates(request.updatedPermissions);
          context = [context, request?.additionalContext]
            .filter(Boolean)
            .join("\n");
          target = await targetFor();
          decision = request?.permissionDecision;
        }
        permissions.authorize(name, target, decision);
        check();
        const output = bounded(
          await permissions.withAuthorization(name, target, () =>
            limited((signal, deadline) => execute(input, signal, deadline)),
          ),
        );
        check();
        afterCalled = true;
        await options.afterTool?.({
          name,
          input: input as Record<string, unknown>,
          output,
        });
        check();
        return bounded(context ? `${output}\n${context}` : output);
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
    if (name === "Workflow") {
      const json = schema.toJSONSchema({ unrepresentable: "any" });
      return tool({
        name,
        description,
        strict: false,
        parameters: {
          type: "object",
          properties: (json.properties ?? {}) as Record<
            string,
            Record<string, unknown>
          >,
          required: json.required ?? [],
          additionalProperties: true,
        },
        execute: executeTool,
      });
    }
    return tool({
      name,
      description,
      parameters: schema,
      execute: executeTool,
    });
  }
  const tools: Tool[] = [
    define(
      "Skill",
      "Load a configured skill/slash command by name (plugin:name for plugin entries), or omit skill to list entries.",
      { skill: optionalString, args: optionalString },
      async ({ skill, args }, signal, deadline) => {
        permissions.assertTool("Skill", skill ?? undefined);
        const entries = await skillCatalog();
        if (!skill)
          return JSON.stringify(
            entries.map(({ name, metadata }) => ({
              name,
              description: metadata.description ?? "",
              argumentHint: metadata["argument-hint"] ?? "",
            })),
          );
        const entry = entries.find(
          (item) => item.name === skill.replace(/^\//, ""),
        );
        if (!entry) throw new Error(`Unknown configured skill: ${skill}`);
        if (entry.metadata["disable-model-invocation"] === true)
          throw new Error("This skill disables model invocation");
        const allowedTools = stringList(
          entry.metadata["allowed-tools"],
          "Skill allowed-tools",
        );
        const skillPermissions = new AgentPermissions({
          ...permissions.options,
          allowedTools: [
            ...new Set([
              ...(permissions.options.allowedTools ?? []),
              ...(allowedTools ?? []),
            ]),
          ],
        });
        const loaded: LoadedAgentSkill = {
          ...entry,
          allowedTools,
          model:
            typeof entry.metadata.model === "string"
              ? entry.metadata.model
              : undefined,
          context:
            typeof entry.metadata.context === "string"
              ? entry.metadata.context
              : undefined,
          instructions: substitute(
            {
              ...entry,
              instructions: await preprocess(
                entry.instructions,
                {
                  ...options,
                  env: markdownEnvironment(
                    entry,
                    options.configuration,
                    options.env,
                  ),
                  signal,
                  deadline,
                },
                skillPermissions,
              ),
            },
            args ?? "",
            options.configuration,
          ),
        };
        if (loaded.context === "fork") {
          if (!options.runSubagent)
            throw new Error("Forked skill subagent runner is unavailable");
          const name =
            typeof entry.metadata.agent === "string"
              ? entry.metadata.agent
              : "general-purpose";
          const selected = (await agentCatalog()).find(
            (agent) =>
              agent.name === name ||
              agent.name === `${entry.namespace}:${name}`,
          );
          if (!selected) throw new Error(`Unknown skill subagent: ${name}`);
          const preloadedSkills: AgentMarkdown[] = [];
          let instructions = selected.instructions;
          for (const skill of stringList(
            selected.metadata.skills,
            "Agent skills",
          ) ?? []) {
            const configured = (await skillCatalog()).find(
              (item) =>
                item.name === skill ||
                item.name === `${selected.namespace}:${skill}`,
            );
            if (!configured)
              throw new Error(`Unknown preloaded agent skill: ${skill}`);
            preloadedSkills.push(configured);
            instructions += `\n\nPreloaded skill ${configured.name}:\n${substitute(configured, "", options.configuration)}`;
          }
          const maxTurns =
            entry.metadata.maxTurns ?? selected.metadata.maxTurns;
          if (
            maxTurns !== undefined &&
            (!Number.isSafeInteger(maxTurns) ||
              Number(maxTurns) < 1 ||
              Number(maxTurns) > 100)
          )
            throw new Error("Skill maxTurns must be between 1 and 100");
          const hooks = parseHooks(selected.metadata.hooks ?? {}, {
            pluginRoot: selected.pluginRoot,
          });
          for (const [event, groups] of Object.entries(
            parseHooks(entry.metadata.hooks ?? {}, {
              pluginRoot: entry.pluginRoot,
            }),
          ))
            hooks[event] = [...(hooks[event] ?? []), ...groups];
          const readonly =
            permissions.readOnly ||
            ["plan", "readonly", "read-only"].includes(
              String(selected.metadata.permissionMode),
            );
          return options.runSubagent({
            agent: { ...selected, instructions },
            name: selected.name,
            instructions,
            prompt: loaded.instructions,
            model:
              loaded.model ??
              (typeof selected.metadata.model === "string"
                ? selected.metadata.model
                : undefined),
            allowedTools: stringList(selected.metadata.tools, "Agent tools"),
            disallowedTools: stringList(
              selected.metadata.disallowedTools,
              "Agent disallowedTools",
            ),
            maxTurns: maxTurns as number | undefined,
            hooks,
            preloadedSkills,
            mcpServers: options.configuration.strictMcpConfig
              ? undefined
              : selected.metadata.mcpServers,
            permissionOptions: {
              ...skillPermissions.options,
              ...(readonly
                ? { sandboxMode: "read-only", permissionMode: "read-only" }
                : {}),
            },
            signal,
            deadline,
          });
        }
        await options.onSkillLoaded?.(loaded);
        return JSON.stringify(loaded);
      },
    ),
    define(
      "Task",
      "Run a configured custom/plugin subagent through the parent SDK runner with inherited permissions. Omit subagent_type to list entries.",
      {
        subagent_type: optionalString,
        prompt: optionalString,
        description: optionalString,
        model: optionalString,
        max_turns: z.number().int().positive().max(100).nullable().optional(),
        run_in_background: z.boolean().nullable().optional(),
      },
      async (input, signal, deadline) => {
        permissions.assertTool("Task", input.subagent_type ?? undefined);
        const entries = await agentCatalog();
        if (!input.subagent_type)
          return JSON.stringify(
            entries.map(({ name, metadata }) => ({
              name,
              description: metadata.description ?? "",
            })),
          );
        const agent = entries.find((item) => item.name === input.subagent_type);
        if (!agent)
          throw new Error(
            `Unknown configured subagent: ${input.subagent_type}`,
          );
        if (!input.prompt?.trim()) throw new Error("Task requires a prompt");
        if (!options.runSubagent)
          throw new Error("Task subagent runner is unavailable");
        const maxTurns = input.max_turns ?? agent.metadata.maxTurns;
        if (
          maxTurns !== undefined &&
          (typeof maxTurns !== "number" ||
            !Number.isSafeInteger(maxTurns) ||
            maxTurns < 1 ||
            maxTurns > 100)
        )
          throw new Error("Subagent maxTurns must be between 1 and 100");
        let instructions = substitute(
          agent,
          input.prompt,
          options.configuration,
        );
        const preloadedSkills: AgentMarkdown[] = [];
        for (const name of stringList(agent.metadata.skills, "Agent skills") ??
          []) {
          const entry = (await skillCatalog()).find(
            (item) =>
              item.name === name || item.name === `${agent.namespace}:${name}`,
          );
          if (!entry) throw new Error(`Unknown preloaded agent skill: ${name}`);
          preloadedSkills.push(entry);
          instructions += `\n\nPreloaded skill ${entry.name}:\n${substitute(entry, "", options.configuration)}`;
        }
        const hooks = parseHooks(agent.metadata.hooks ?? {}, {
          pluginRoot: agent.pluginRoot,
        });
        const run = (signal: AbortSignal, deadline: number) =>
          options.runSubagent!({
            agent: { ...agent, instructions },
            name: agent.name,
            instructions,
            preloadedSkills,
            hooks,
            mcpServers: options.configuration.strictMcpConfig
              ? undefined
              : agent.metadata.mcpServers,
            prompt: input.prompt!,
            description: input.description ?? undefined,
            model:
              input.model ??
              (typeof agent.metadata.model === "string"
                ? agent.metadata.model
                : undefined),
            maxTurns: maxTurns as number | undefined,
            allowedTools: stringList(agent.metadata.tools, "Agent tools"),
            disallowedTools: stringList(
              agent.metadata.disallowedTools,
              "Agent disallowedTools",
            ),
            permissionOptions: {
              ...permissions.options,
              ...(permissions.readOnly ||
              ["plan", "readonly", "read-only"].includes(
                String(agent.metadata.permissionMode),
              )
                ? { sandboxMode: "read-only", permissionMode: "read-only" }
                : {}),
            },
            deadline,
            signal,
          });
        return input.run_in_background
          ? startBackground(run)
          : run(signal, deadline);
      },
    ),
    define(
      "TaskOutput",
      "Retrieve a background shell, subagent, or workflow result. block waits until completion or the supplied timeout.",
      {
        task_id: z.string(),
        block: z.boolean().nullable().optional(),
        timeout: z
          .number()
          .int()
          .nonnegative()
          .max(300000)
          .nullable()
          .optional(),
      },
      async (input, signal, deadline) => {
        const job = backgroundTasks.get(input.task_id);
        if (!job) throw new Error("Unknown background task");
        if (input.block ?? true) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let rejectAbort!: (error: Error) => void;
          const abort = () => rejectAbort(new Error("TaskOutput cancelled"));
          const cancellation = new Promise<never>((_, reject) => {
            rejectAbort = reject;
          });
          signal.addEventListener("abort", abort, { once: true });
          try {
            await Promise.race([
              job.done,
              new Promise<void>((resolve) => {
                timer = setTimeout(
                  resolve,
                  Math.max(
                    1,
                    Math.min(input.timeout ?? 30000, deadline - Date.now()),
                  ),
                );
              }),
              cancellation,
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            signal.removeEventListener("abort", abort);
          }
        }
        return job.getOutput();
      },
    ),
    define(
      "TaskStop",
      "Stop a background shell, subagent, or workflow and return its final status.",
      { task_id: optionalString, shell_id: optionalString },
      async ({ task_id, shell_id }) => {
        const id = task_id ?? shell_id;
        if (!id) throw new Error("TaskStop requires task_id");
        const job = backgroundTasks.get(id);
        if (!job) throw new Error("Unknown background task");
        return job.stop();
      },
    ),
    define(
      "Workflow",
      "Launch an isolated JavaScript workflow using agent/parallel/pipeline/phase/log/args. Runs in the background; retrieve results with TaskOutput or stop with TaskStop.",
      {
        name: optionalString,
        script: optionalString,
        scriptPath: optionalString,
        resumeFromRunId: optionalString,
        args: z.unknown().nullable().optional(),
      },
      async (input) => {
        if (!input.name && !input.script && !input.scriptPath)
          return JSON.stringify(
            (await workflows.list()).map(({ name, meta }) => ({
              name,
              description: meta.description,
            })),
          );
        const launch = await workflows.launch(input);
        ownedBackgroundIds.add(launch.runId);
        backgroundTasks.set(launch.runId, {
          type: "workflow",
          getOutput: launch.output,
          stop: launch.stop,
          done: launch.done,
        });
        return JSON.stringify({
          status: "async_launched",
          taskId: launch.runId,
          task_id: launch.runId,
          runId: launch.runId,
          workflowName: launch.name,
          scriptPath: launch.scriptPath,
        });
      },
    ),
    define(
      "WebFetch",
      "Fetch bounded HTTP(S) text without credentials, remove executable HTML, and answer a prompt through the parent SDK summarizer.",
      { url: z.string().min(1), prompt: z.string().min(1) },
      async ({ url, prompt }, signal, deadline) => {
        permissions.assertTool("WebFetch", url);
        if (!options.summarize)
          throw new Error("WebFetch summarization runner is unavailable");
        return options.summarize({
          ...(await fetchContent(url, signal, fetchLimit, (url) =>
            permissions.assertTool("WebFetch", url),
          )),
          prompt,
          deadline,
          signal,
        });
      },
    ),
    define(
      "WebSearch",
      "Search the web through the parent SDK hosted search runner with optional domain filters.",
      {
        query: z.string().min(1),
        allowed_domains: z.array(z.string()).nullable().optional(),
        blocked_domains: z.array(z.string()).nullable().optional(),
      },
      async (input, signal, deadline) => {
        permissions.assertTool("WebSearch", input.query);
        if (!options.search)
          throw new Error("WebSearch hosted search runner is unavailable");
        for (const domain of [
          ...(input.allowed_domains ?? []),
          ...(input.blocked_domains ?? []),
        ])
          if (
            !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain)
          )
            throw new Error("WebSearch filters must be domain names");
        if (
          (input.allowed_domains?.length ?? 0) > 100 ||
          (input.blocked_domains?.length ?? 0) > 100
        )
          throw new Error("WebSearch domain filters exceed 100 entries");
        return options.search({
          query: input.query,
          allowedDomains: input.allowed_domains ?? undefined,
          blockedDomains: input.blocked_domains ?? undefined,
          deadline,
          signal,
        });
      },
    ),
  ];
  if (Object.keys(options.configuration.lspServers ?? {}).length)
    tools.push(
      define(
        "LSP",
        "Read-only language-server definitions, references, hover, symbols, implementations and call hierarchy. Positions are one-based.",
        {
          operation: z.enum([
            "goToDefinition",
            "findReferences",
            "hover",
            "documentSymbol",
            "workspaceSymbol",
            "goToImplementation",
            "prepareCallHierarchy",
            "incomingCalls",
            "outgoingCalls",
          ]),
          filePath: z.string().min(1),
          line: z.number().int().positive().nullable().optional(),
          character: z.number().int().positive().nullable().optional(),
          query: optionalString,
        },
        async (input, signal) =>
          JSON.stringify(await lsp.execute(input, signal)),
      ),
    );
  return {
    tools,
    drainDiagnostics: lsp.drainDiagnostics,
    notifyFileChanged: lsp.notifyFileChanged,
    close: async () => {
      if (closed) return;
      closed = true;
      controller.abort();
      options.signal?.removeEventListener("abort", abort);
      await Promise.all([
        lsp.close(),
        workflows.close(),
        ...[...ownedBackgroundIds].map((id) => backgroundTasks.get(id)?.stop()),
      ]);
    },
  };
}
