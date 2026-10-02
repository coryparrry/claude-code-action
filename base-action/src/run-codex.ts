import * as core from "@actions/core";
import {
  Usage,
  OpenAIProvider,
  type AgentInputItem,
  type JsonSchemaDefinition,
  type Model,
  type ModelProvider,
  type ModelSettings,
} from "@openai/agents";
import Ajv from "ajv";
import { randomUUID } from "node:crypto";
import { readFile, realpath, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { redactSecrets } from "../../src/github/utils/sanitizer";
import { writeExecutionFile } from "./execution-file";
import {
  resolveCompatibility,
  normalizeCodexEffort,
  type DirectCompatibilityOptions,
} from "./codex-compat";
import { workflowToolEnvironment } from "./codex-tool-environment";
import { nativeModelSettings } from "./agent-native-controls";
import { scrubMcpEnvironment } from "./mcp-environment";
import { createOpenAIAuthentication } from "./openai-auth";
import { loadAgentConfiguration } from "./agent-configuration";
import { AgentPermissions } from "./agent-permissions";
import type { BackgroundAgentTask } from "./agent-tools";
import { resolveAgentCommand } from "./agent-additional-tools";
import { createCodexAgentRuntime } from "./codex-agent-runtime";
import { selectConfiguredAgent, childMcpConfig } from "./codex-agent-selection";
import {
  createAgentCompaction,
  supportsAgentCompaction,
} from "./agent-compaction";
import {
  AgentBudget,
  configuredModelPrices,
  DEFAULT_MODEL_PRICES,
  type ModelPrice,
} from "./agent-budget";
import {
  agentSessionDirectory,
  loadAgentSession,
  saveAgentSession,
} from "./agent-sessions";
import {
  runOpenAIAgent,
  OpenAIAgentRunError,
  type OpenAIAgentEvent,
  type OpenAIAgentResult,
} from "./openai-agent-runner";

export type CodexRunResult = {
  executionFile?: string;
  sessionId?: string;
  conclusion: "success" | "failure";
  structuredOutput?: unknown;
};
export type CodexOptions = Omit<
  DirectCompatibilityOptions,
  "model" | "fallbackModel"
> & {
  mcpConfig: string;
  compatibilityArgs?: string;
  defaultAllowedTools?: string[];
  settings?: string;
  plugins?: string;
  pluginMarketplaces?: string;
  githubEnvironment?: Partial<
    Record<
      | "GH_TOKEN"
      | "GITHUB_REPOSITORY"
      | "GITHUB_EVENT_PATH"
      | "GITHUB_WORKSPACE"
      | "GH_HOST",
      string
    >
  >;
  /** Retained for input compatibility; execution uses the installed Agents SDK. */
  executable?: string;
  model?: string | Model;
  fallbackModel?: string | Model;
  modelProvider?: ModelProvider;
  baseURL?: string;
  sandbox?: string;
  showFullOutput?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  configurationHome?: string;
  sessionStoragePath?: string;
  modelPrices?: Record<string, ModelPrice>;
  workspace?: string;
};
const DEFAULT_MODEL = "gpt-6-luna";
export function resolveCodexModel(
  model: string | Model | undefined,
): string | Model {
  if (!model) return DEFAULT_MODEL;
  if (typeof model !== "string") return model;
  const alias = /^(default|opus|sonnet|haiku)(?:\[1m\])?$/.exec(model)?.[1];
  return alias
    ? ({
        default: DEFAULT_MODEL,
        opus: "gpt-6-astra",
        sonnet: "gpt-6.1-sol",
        haiku: DEFAULT_MODEL,
      }[alias] ?? model)
    : model;
}
async function readPrompt(
  path: string,
): Promise<{ context: string; request?: string }> {
  const context = await readFile(path, "utf8");
  for (const filename of [
    "codex-user-request.txt",
    "claude-user-request.txt",
  ]) {
    try {
      return {
        context,
        request: await readFile(join(dirname(path), filename), "utf8"),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { context };
}
function usageReport(usage: Usage) {
  const cached = usage.inputTokensDetails.reduce(
    (sum, item) => sum + (item.cached_tokens ?? item.cachedTokens ?? 0),
    0,
  );
  return {
    input_tokens: Math.max(0, usage.inputTokens - cached),
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: cached,
  };
}

/** Real Agents SDK execution; credentials are confined to the model provider. */
export async function runCodex(
  promptPath: string,
  options: CodexOptions,
): Promise<CodexRunResult> {
  const authenticationSecrets: string[] = [];
  let registerAuthentication = (value: string) => {
    authenticationSecrets.push(value);
    core.setSecret(value);
  };
  const authentication = await createOpenAIAuthentication(
    {
      ...process.env,
      ...(options.baseURL ? { OPENAI_BASE_URL: options.baseURL } : {}),
    },
    { register: (value) => registerAuthentication(value) },
  );
  const apiKey = authentication.credential;
  const baseURL = options.baseURL ?? authentication.baseURL;
  const modelProvider =
    options.modelProvider ??
    new OpenAIProvider({ openAIClient: authentication.client });
  const sandbox = options.sandbox ?? "workspace-write";
  if (!["read-only", "workspace-write"].includes(sandbox))
    throw new Error("Codex sandbox must be read-only or workspace-write");
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("Codex timeout must be a positive integer");
  const workspace = await realpath(
    resolve(
      options.workspace ??
        options.githubEnvironment?.GITHUB_WORKSPACE ??
        process.cwd(),
    ),
  );
  const started = Date.now(),
    deadline = started + timeoutMs;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  let debug =
    options.showFullOutput === "true" ||
    process.env.ACTIONS_STEP_DEBUG === "true";
  const secrets = new Set<string>([apiKey, ...authenticationSecrets]);
  for (const [name, value] of Object.entries(process.env))
    if (
      value &&
      /key|token|secret|password|credential|authorization/i.test(name)
    )
      secrets.add(value);
  const register = (value: string) => {
    if (value) {
      secrets.add(value);
      core.setSecret(value);
    }
  };
  registerAuthentication = register;
  const redact = (input: string): string => {
    for (const value of [...secrets].sort((a, b) => b.length - a.length))
      input = input.split(value).join("[REDACTED]");
    return redactSecrets(input);
  };
  const sanitize = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          redact(key),
          sanitize(item),
        ]),
      );
    return value;
  };
  const messages: Record<string, unknown>[] = [];
  const backgroundTasks = new Map<string, BackgroundAgentTask>();
  let runtime: Awaited<ReturnType<typeof createCodexAgentRuntime>> | undefined;
  let result: Omit<OpenAIAgentResult, "finalOutput"> | undefined;
  let finalOutput: unknown, failure: string | undefined;
  let fatalFailure: string | undefined;
  let sessionId: string = randomUUID();
  const sessionDirectory = agentSessionDirectory(
    options.sessionStoragePath ??
      join(process.env.RUNNER_TEMP ?? tmpdir(), "codex-action-sessions"),
    workspace,
  );
  let budget: AgentBudget | undefined;
  const totalUsage = new Usage();
  let compaction: ReturnType<typeof createAgentCompaction> | undefined;
  let logBytes = 0;
  let outputFormat = options.outputFormat;
  const partials = new Map<string, string>();
  const flushPartials = () => {
    for (const [itemId, text] of partials) {
      const message = {
        type: "stream_event",
        session_id: sessionId,
        event: {
          type: "content_block_delta",
          item_id: itemId,
          delta: { type: "text_delta", text: redact(text) },
        },
      };
      messages.push(message);
      if (debug || outputFormat === "stream-json")
        core.info(JSON.stringify(message).slice(0, 16 * 1024));
    }
    partials.clear();
  };
  let cacheDirectory: string | undefined;
  let persistSession = true;
  let hasSessionHistory = false;
  const emit = (event: OpenAIAgentEvent) => {
    // Buffer within each response so secrets split across streamed fragments stay masked.
    if (event.type === "assistant.delta") {
      const id = event.itemId ?? "assistant";
      partials.set(id, (partials.get(id) ?? "") + event.text);
      return;
    }
    if (event.type === "model.response") {
      flushPartials();
      totalUsage.add(event.response.usage);
      try {
        budget?.accept(
          event.response.usage,
          event.activeModelName,
          event.response.output,
        );
      } catch (error) {
        fatalFailure = error instanceof Error ? error.message : String(error);
        controller.abort();
        throw error;
      }
    }
    if (event.type === "assistant")
      messages.push({
        type: "assistant",
        session_id: sessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: event.text }],
        },
      });
    else if (event.type === "tool.started")
      messages.push({
        type: "assistant",
        session_id: sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: event.callId ?? randomUUID(),
              name: event.toolName,
              input: event.input,
            },
          ],
        },
      });
    else if (event.type === "tool.completed")
      messages.push({
        type: "user",
        session_id: sessionId,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: event.callId,
              content: event.output,
            },
          ],
        },
      });
    if ((debug || outputFormat === "stream-json") && logBytes < 128 * 1024) {
      const line = JSON.stringify(sanitize(event)).slice(0, 16 * 1024);
      logBytes += line.length;
      core.info(line);
    }
  };
  try {
    const direct = {
      ...options,
      model: typeof options.model === "string" ? options.model : undefined,
      fallbackModel:
        typeof options.fallbackModel === "string"
          ? options.fallbackModel
          : undefined,
    };
    const initial = await resolveCompatibility(
      options.compatibilityArgs ?? "",
      options.settings ?? "",
      options.mcpConfig,
      options.defaultAllowedTools,
      direct,
    );
    persistSession = initial.persistSession !== false;
    debug ||= initial.debug === true || initial.verbose === true;
    outputFormat = initial.outputFormat ?? outputFormat;
    const githubEnvironment = options.githubEnvironment ?? {};
    if (
      Object.entries(githubEnvironment).some(
        ([name, value]) =>
          ![
            "GH_TOKEN",
            "GITHUB_REPOSITORY",
            "GITHUB_EVENT_PATH",
            "GITHUB_WORKSPACE",
            "GH_HOST",
          ].includes(name) ||
          typeof value !== "string" ||
          value.includes(apiKey),
      )
    )
      throw new Error("Invalid trusted GitHub environment");
    if (githubEnvironment.GH_TOKEN) register(githubEnvironment.GH_TOKEN);
    const environment = () => {
      const env = workflowToolEnvironment(
        { ...process.env, ...initial.toolEnvironment },
        [...secrets],
      );
      for (const name of [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
      ]) {
        const value = process.env[name];
        if (value && ![...secrets].some((secret) => value.includes(secret)))
          env[name] = value;
      }
      return { ...env, ...githubEnvironment };
    };
    cacheDirectory = await mkdtemp(join(tmpdir(), "codex-action-config-"));
    const configuration = await loadAgentConfiguration({
      workspace,
      home: options.configurationHome,
      cacheDirectory,
      dataDirectoryRoot: join(
        process.env.RUNNER_TEMP ?? tmpdir(),
        "codex-action-plugin-data",
      ),
      strictMcpConfig: initial.strictMcpConfig,
      pluginRoots: initial.pluginRoots,
      settings: initial.normalizedSettings,
      settingSources: initial.settingSources,
      plugins: options.plugins,
      pluginMarketplaces: options.pluginMarketplaces,
      environment: environment(),
      deadline,
      signal: controller.signal,
    });
    const compatibility = await resolveCompatibility(
      options.compatibilityArgs ?? "",
      JSON.stringify(configuration.settings),
      JSON.stringify({
        mcpServers: {
          ...JSON.parse(initial.mcpConfig).mcpServers,
          ...configuration.mcpServers,
        },
      }),
      options.defaultAllowedTools,
      direct,
    );
    const selectedAgent = await selectConfiguredAgent(
      configuration,
      compatibility.agentName,
      compatibility.agentDefinitions,
      cacheDirectory,
    );
    if (selectedAgent?.mcpServers)
      compatibility.mcpConfig = childMcpConfig(
        compatibility.mcpConfig,
        selectedAgent.mcpServers,
      );
    let model = resolveCodexModel(
      options.model ?? compatibility.model ?? selectedAgent?.model,
    );
    const fallbackModel =
      options.fallbackModel === undefined &&
      compatibility.fallbackModel === undefined
        ? undefined
        : resolveCodexModel(
            options.fallbackModel ?? compatibility.fallbackModel,
          );
    const effort = normalizeCodexEffort(
      compatibility.effort,
      typeof model === "string" ? model : DEFAULT_MODEL,
    );
    if (
      effort &&
      !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        effort,
      )
    )
      throw new Error("Unsupported Codex reasoning effort");
    const modelSettings: ModelSettings = {
      ...nativeModelSettings(configuration.settings),
      ...(effort
        ? {
            reasoning: {
              ...nativeModelSettings(configuration.settings).reasoning,
              effort: effort as NonNullable<
                ModelSettings["reasoning"]
              >["effort"],
            },
          }
        : {}),
    };
    budget = new AgentBudget(compatibility.maxBudgetUsd, {
      ...DEFAULT_MODEL_PRICES,
      ...configuredModelPrices(
        configuration.settings.modelPrices ??
          configuration.settings.model_prices,
      ),
      ...options.modelPrices,
    });
    if (typeof model === "string") budget.assertModel(model);
    if (typeof fallbackModel === "string") budget.assertModel(fallbackModel);
    const scan = (value: unknown, sensitive = false) => {
      if (typeof value === "string") {
        if (value.includes(apiKey))
          throw new Error(
            "MCP configuration cannot receive the OpenAI API key",
          );
        if (sensitive) register(value);
      } else if (Array.isArray(value))
        value.forEach((item) => scan(item, sensitive));
      else if (value && typeof value === "object")
        for (const [key, item] of Object.entries(value))
          scan(
            item,
            sensitive ||
              /key|token|secret|password|credential|authorization|headers|cookie/i.test(
                key,
              ),
          );
    };
    scan(JSON.parse(compatibility.mcpConfig));
    const toolEnvironment: Record<string, string> = environment();
    Object.assign(
      toolEnvironment,
      workflowToolEnvironment(compatibility.toolEnvironment ?? {}, [
        ...secrets,
      ]),
    );
    const permissions = new AgentPermissions({
      cwd: workspace,
      sandboxMode: sandbox,
      permissionMode: selectedAgent?.readonly
        ? "read-only"
        : (selectedAgent?.permissionMode ?? compatibility.permissionMode),
      additionalDirectories: compatibility.additionalDirectories,
      allowedTools: compatibility.allowedTools,
      disallowedTools: [
        ...new Set([
          ...(compatibility.disallowedTools ?? []),
          ...(selectedAgent?.denied ?? []),
        ]),
      ],
      askTools: compatibility.askTools,
      permissionSettingsPaths: {
        userSettings:
          configuration.sources
            .filter(
              (path) =>
                path.endsWith("settings.json") &&
                !path.startsWith(workspace + "/"),
            )
            .at(-1) ??
          (compatibility.settingSources?.includes("user")
            ? join(
                options.configurationHome ?? homedir(),
                ".claude",
                "settings.json",
              )
            : undefined),
        projectSettings:
          configuration.sources
            .filter(
              (path) =>
                path.endsWith("settings.json") &&
                path.startsWith(workspace + "/"),
            )
            .at(-1) ??
          (compatibility.settingSources?.includes("project")
            ? join(workspace, ".claude", "settings.json")
            : undefined),
        localSettings:
          configuration.sources
            .filter(
              (path) =>
                path.endsWith("settings.local.json") &&
                path.startsWith(workspace + "/"),
            )
            .at(-1) ??
          (compatibility.settingSources?.includes("local")
            ? join(workspace, ".claude", "settings.local.json")
            : undefined),
      },
    });
    const saved = await loadAgentSession(
      sessionDirectory,
      workspace,
      compatibility.resumeThreadId,
      compatibility.continueSession,
    );
    if (saved) {
      sessionId = saved.sessionId;
      result = {
        history: saved.history,
        usage: new Usage(),
        turns: 0,
        sessionId,
      };
      hasSessionHistory = true;
    }
    messages.push({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: typeof model === "string" ? model : "custom-model",
      tools: [],
    });
    const mcpEnvironment = scrubMcpEnvironment(
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            ![...secrets].some((secret) => entry[1]!.includes(secret)),
        ),
      ),
    );
    Object.assign(mcpEnvironment, toolEnvironment);
    runtime = await createCodexAgentRuntime({
      openAIClient: authentication.client,
      apiKey,
      baseURL,
      modelProvider,
      getModel: () => model,
      setModel: (next) => {
        model = resolveCodexModel(next);
      },
      assertModel: (next) => {
        if (fatalFailure) throw new Error(fatalFailure);
        controller.signal.throwIfAborted();
        if (typeof next === "string") budget!.assertModel(next);
        else if (compatibility.maxBudgetUsd !== undefined)
          throw new Error("USD budget requires a named model");
      },
      inheritedInstructions: [
        compatibility.systemPrompt ??
          "You are Codex, a coding assistant working on a GitHub task.",
        configuration.projectInstructions,
        selectedAgent?.instructions,
        compatibility.appendSystemPrompt,
      ]
        .filter(Boolean)
        .join("\n\n"),
      fallbackModel,
      modelSettings,
      resolveModel: resolveCodexModel,
      configuration,
      permissions,
      sessionId,
      deadline,
      signal: controller.signal,
      maxTurns: compatibility.maxTurns,
      mcpConfig: compatibility.mcpConfig,
      mcpEnvironment,
      toolEnvironment,
      trustedEnvironmentKeys: Object.keys(githubEnvironment),
      backgroundTasks,
      register,
      redact,
      emit,
      sessionStoragePath: sessionDirectory,
      removeSecretAliases: () => {
        for (const [name, value] of Object.entries(toolEnvironment))
          if (
            !(name in githubEnvironment) &&
            [...secrets].some((secret) => value.includes(secret))
          )
            delete toolEnvironment[name];
      },
    });
    const { hooks, applyHook: checkHook, toolOptions } = runtime;
    let tools = runtime.tools;
    if (compatibility.tools)
      tools = tools.filter((tool) => compatibility.tools!.includes(tool.name));
    if (selectedAgent?.tools)
      tools = tools.filter((tool) => selectedAgent.tools!.includes(tool.name));
    const prompt = await readPrompt(promptPath);
    const command = compatibility.disableSlashCommands
      ? undefined
      : await resolveAgentCommand(
          prompt.request ?? prompt.context,
          configuration,
          toolOptions,
        );
    if (command?.allowedTools)
      permissions.update({
        allowedTools: [
          ...new Set([
            ...(permissions.options.allowedTools ?? []),
            ...command.allowedTools,
          ]),
        ],
      });
    if (command?.model) model = resolveCodexModel(command.model);
    const userPrompt = [
      prompt.request ? prompt.context : undefined,
      command?.instructions ?? prompt.request ?? prompt.context,
    ]
      .filter(Boolean)
      .join("\n\n");
    const sessionContext = checkHook(
      await hooks.run("SessionStart", { source: saved ? "resume" : "startup" }),
    );
    const userContext = checkHook(
      await hooks.run("UserPromptSubmit", { prompt: userPrompt }),
    );
    const instructions = [
      compatibility.systemPrompt ??
        "You are Codex, a coding assistant working on a GitHub task. Use the provided tools and follow repository instructions.",
      configuration.projectInstructions,
      selectedAgent?.instructions,
      compatibility.appendSystemPrompt,
      sessionContext,
      userContext,
    ]
      .filter(Boolean)
      .join("\n\n");
    const schema = compatibility.schema as
      | JsonSchemaDefinition["schema"]
      | undefined;
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = schema ? ajv.compile(schema) : undefined;
    if (typeof model === "string" && supportsAgentCompaction(model))
      compaction = createAgentCompaction({
        openAIClient: authentication.client,
        apiKey,
        baseURL,
        model,
        sessionId,
        signal: controller.signal,
        onBeforeCompact: async (context) => {
          checkHook(
            await hooks.run("PreCompact", {
              trigger: context.trigger,
              custom_instructions: "",
            }),
          );
        },
        onAfterCompact: async (context) => {
          checkHook(
            await hooks.run("PostCompact", {
              trigger: "auto",
              compacted_history: context.history,
            }),
          );
        },
        onUsage: (usage, activeModel) => {
          const recorded = new Usage({
            requests: 1,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            inputTokensDetails: [usage.inputTokensDetails],
            outputTokensDetails: [usage.outputTokensDetails],
          });
          emit({
            type: "model.response",
            response: { usage: recorded, output: [] },
            turn: 0,
            activeModelName: activeModel,
          });
        },
      });
    core.info("Running Codex through the OpenAI Agents SDK");
    const final = await runOpenAIAgent(
      saved
        ? [...saved.history, { role: "user", content: userPrompt }]
        : userPrompt,
      {
        apiKey,
        baseURL,
        model,
        fallbackModel,
        modelProvider,
        resolveModel: () => model,
        includePartialMessages: compatibility.includePartialMessages,
        instructions,
        tools,
        modelSettings,
        schema,
        maxTurns: compatibility.maxTurns ?? selectedAgent?.maxTurns,
        deadline,
        signal: controller.signal,
        sessionId,
        onEvent: (event) => {
          if (event.type === "model.response")
            compaction?.observeResponse(event.response, event.activeModelName);
          emit(event);
        },
        prepareModelInput: compaction?.prepareModelInput,
        transformHistory: compaction?.projectHistory,
        additionalUsage: compaction?.getAdditionalUsage,
        onContextLimit: compaction
          ? (_input, context) => compaction!.forceCompact(context, _input)
          : undefined,
        validateOutput: validate
          ? (output) => {
              if (!validate(output))
                throw new Error(
                  `Structured output did not match JSON schema: ${ajv.errorsText(validate.errors)}`,
                );
            }
          : undefined,
        onBeforeModel: () => {
          if (fatalFailure) throw new Error(fatalFailure);
          controller.signal.throwIfAborted();
          return runtime!.beforeModel();
        },
        onSessionFinal: (candidate, state) =>
          runtime!.onFinal(
            typeof candidate.finalOutput === "string"
              ? candidate.finalOutput
              : JSON.stringify(candidate.finalOutput),
            state.stopHookActive,
          ),
      },
    );
    result = final;
    hasSessionHistory = true;
    finalOutput = final.finalOutput;
    if (
      finalOutput === undefined ||
      (typeof finalOutput === "string" && !finalOutput.trim())
    )
      throw new Error("Codex did not produce a final assistant message");
    checkHook(await hooks.run("SessionEnd", { reason: "success" }));
  } catch (error) {
    if (error instanceof OpenAIAgentRunError) {
      result = error.partialResult;
      sessionId = result.sessionId;
      hasSessionHistory = true;
    }
    failure = redact(
      fatalFailure ?? (error instanceof Error ? error.message : String(error)),
    ).slice(0, 4000);
    if (runtime && !controller.signal.aborted) {
      try {
        runtime.applyHook(
          await runtime.hooks.run("StopFailure", { error: failure }),
        );
        runtime.applyHook(
          await runtime.hooks.run("SessionEnd", { reason: "failure" }),
        );
      } catch (hookError) {
        core.warning(
          redact(
            hookError instanceof Error ? hookError.message : String(hookError),
          ),
        );
      }
    }
    if (controller.signal.aborted)
      failure = options.signal?.aborted
        ? "Agent execution cancelled"
        : Date.now() >= deadline
          ? "Agent execution timed out"
          : failure;
  } finally {
    flushPartials();
    controller.abort();
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    const cleanup = await Promise.allSettled([
      ...(runtime ? [runtime.close()] : []),
      ...[...backgroundTasks.values()].map((task) => task.stop()),
    ]);
    for (const item of cleanup)
      if (item.status === "rejected")
        failure ??= redact(
          item.reason instanceof Error
            ? item.reason.message
            : String(item.reason),
        );
    try {
      if (persistSession && hasSessionHistory)
        await saveAgentSession(sessionDirectory, {
          version: 1,
          sessionId,
          workspace,
          history: sanitize(result?.history ?? []) as AgentInputItem[],
        });
    } catch (error) {
      failure ??= redact(
        error instanceof Error ? error.message : String(error),
      );
    }
    messages.push({
      type: "result",
      subtype: failure ? "error_during_execution" : "success",
      is_error: !!failure,
      session_id: sessionId,
      result:
        failure ??
        (typeof finalOutput === "string"
          ? finalOutput
          : JSON.stringify(finalOutput)),
      duration_ms: Date.now() - started,
      num_turns: result?.turns ?? 0,
      usage: usageReport(totalUsage),
      ...(budget?.costKnown ? { total_cost_usd: budget.cost } : {}),
      ...(failure ? { errors: [failure] } : {}),
      ...(finalOutput !== undefined && typeof finalOutput !== "string"
        ? { structured_output: finalOutput }
        : {}),
    });
  }
  if (cacheDirectory)
    await rm(cacheDirectory, { recursive: true, force: true });
  const executionFile = await writeExecutionFile(
    sanitize(messages) as unknown[],
  );
  if (outputFormat) core.info(JSON.stringify(sanitize(messages.at(-1))));
  if (failure) throw new Error(redact(failure));
  return {
    conclusion: "success",
    executionFile,
    sessionId,
    ...(finalOutput !== undefined && typeof finalOutput !== "string"
      ? { structuredOutput: sanitize(finalOutput) }
      : {}),
  };
}
