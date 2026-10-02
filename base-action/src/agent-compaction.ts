import {
  MemorySession,
  OpenAIResponsesCompactionSession,
  Usage,
  type AgentInputItem,
  type ModelResponse,
  type OpenAIResponsesCompactionArgs,
  type RequestUsage,
  type RunContext,
  type Session,
} from "@openai/agents";
import OpenAI from "openai";

// https://developers.openai.com/api/docs/models/gpt-5.3-codex
const DEFAULT_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-5.3-codex": 400_000,
};

export type AgentCompactionOptions = {
  openAIClient?: OpenAI;
  apiKey: string;
  baseURL?: string;
  model: string;
  underlyingSession?: Session;
  sessionId?: string;
  signal: AbortSignal;
  contextWindowTokens?: number;
  thresholdRatio?: number;
  onBeforeCompact?: (context: {
    model: string;
    trigger: "auto" | "context_limit";
  }) => void | Promise<void>;
  onAfterCompact?: (context: {
    model: string;
    history: AgentInputItem[];
    usage: RequestUsage;
  }) => void | Promise<void>;
  onUsage?: (usage: RequestUsage, model: string) => void;
};

function completedPrefixLength(items: AgentInputItem[]): number {
  const results = new Set(
    items.flatMap((item) =>
      "callId" in item &&
      typeof item.callId === "string" &&
      item.type?.endsWith("_call_result")
        ? [item.callId]
        : [],
    ),
  );
  const boundary = items.findIndex(
    (item) =>
      ("callId" in item &&
        typeof item.callId === "string" &&
        item.type?.endsWith("_call") &&
        !results.has(item.callId)) ||
      ("status" in item &&
        item.status === "in_progress" &&
        item.type === "message"),
  );
  return boundary < 0 ? items.length : boundary;
}

/** SDK 0.18 accepts OpenAI model naming conventions, including unknown gpt variants. */
export function supportsAgentCompaction(model: string): boolean {
  const root = model.trim().replace(/^ft:/, "").split(":", 1)[0] ?? "";
  return root.startsWith("gpt-") || /^o\d[a-z0-9-]*$/i.test(root);
}

/** Actual SDK session compaction, triggered by observed token use rather than text length. */
export function createAgentCompaction(options: AgentCompactionOptions) {
  const ratio = options.thresholdRatio ?? 0.8;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1)
    throw new Error("Compaction thresholdRatio must be between zero and one");
  if (
    options.contextWindowTokens !== undefined &&
    (!Number.isSafeInteger(options.contextWindowTokens) ||
      options.contextWindowTokens <= 0)
  )
    throw new Error("Compaction context window must be a positive integer");
  const baseURL = options.baseURL ?? "https://api.openai.com/v1";
  const endpoint = new URL(baseURL);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error(
      "Compaction baseURL must use HTTP/HTTPS without embedded credentials",
    );
  let activeModel = options.model;
  let observedTokens = 0;
  let requestModel = activeModel;
  let currentSignal = options.signal;
  let forceInProgress = false;
  let forcedPending: AgentInputItem[] = [];
  let successfulCompactions = 0;
  const additionalUsage = new Usage();
  let lastSource: AgentInputItem[] = [];
  let lastPrepared: AgentInputItem[] = [];
  let compactedPrefix:
    | { sourceLength: number; items: AgentInputItem[] }
    | undefined;
  const projectHistory = (input: AgentInputItem[]): AgentInputItem[] => {
    if (!compactedPrefix) return input;
    const marker = compactedPrefix.items.find(
      (item) => item.type === "compaction",
    );
    if (
      marker?.type === "compaction" &&
      input.some(
        (item) =>
          item.type === "compaction" &&
          item.encrypted_content === marker.encrypted_content,
      )
    )
      return input;
    return [
      ...compactedPrefix.items,
      ...input.slice(compactedPrefix.sourceLength),
    ];
  };
  const store =
    options.underlyingSession ??
    new MemorySession({ sessionId: options.sessionId });
  const clientOptions = { maxRetries: 0 };
  const client = options.openAIClient
    ? options.openAIClient.withOptions(clientOptions)
    : new OpenAI({ apiKey: options.apiKey, baseURL, ...clientOptions });
  const compact = client.responses.compact.bind(client.responses);
  client.responses.compact = (body, requestOptions) => {
    currentSignal.throwIfAborted();
    requestModel = activeModel;
    const signal = requestOptions?.signal
      ? AbortSignal.any([requestOptions.signal, currentSignal])
      : currentSignal;
    // Select the active model before serialization and provider signing, while
    // retaining the selected client's authentication and transport.
    return compact(
      { ...body, model: requestModel },
      { ...requestOptions, signal },
    );
  };
  const before = async (trigger: "auto" | "context_limit") => {
    currentSignal.throwIfAborted();
    await options.onBeforeCompact?.({ model: activeModel, trigger });
    currentSignal.throwIfAborted();
  };

  class ObservedCompactionSession extends OpenAIResponsesCompactionSession {
    override async runCompaction(
      args: OpenAIResponsesCompactionArgs = {},
      context?: RunContext,
      ownership?: object | null,
    ) {
      if (args.force) await before("context_limit");
      const original = await this.getItems();
      const result = await super.runCompaction(args, context, ownership);
      if (result) {
        successfulCompactions++;
        if (forcedPending.length) await this.addItems(forcedPending);
        observedTokens = 0;
        // Runner accounts decorator calls with a RunContext; boundary/manual calls need separate accounting.
        if (!context)
          additionalUsage.add(
            new Usage({
              requests: 1,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
              inputTokensDetails: result.usage.inputTokensDetails,
              outputTokensDetails: result.usage.outputTokensDetails,
              requestUsageEntries: [result.usage],
            }),
          );
        const items = await this.getItems();
        compactedPrefix = {
          sourceLength: lastSource.length
            ? Math.max(
                0,
                lastSource.length +
                  original.length +
                  forcedPending.length -
                  lastPrepared.length,
              )
            : original.length,
          items,
        };
        lastPrepared = items;
        // Report charges before hooks, including a completed request that exhausts the budget.
        options.onUsage?.(result.usage, requestModel);
        await options.onAfterCompact?.({
          model: requestModel,
          history: await this.getItems(),
          usage: result.usage,
        });
      }
      return result;
    }
  }
  const session = new ObservedCompactionSession({
    client,
    model: options.model,
    underlyingSession: store,
    compactionMode: "input",
    shouldTriggerCompaction: async ({ sessionItems }) => {
      const window =
        activeModel === options.model &&
        options.contextWindowTokens !== undefined
          ? options.contextWindowTokens
          : DEFAULT_CONTEXT_WINDOWS[activeModel];
      if (
        !window ||
        observedTokens < window * ratio ||
        completedPrefixLength(sessionItems) !== sessionItems.length
      )
        return false;
      await before("auto");
      return true;
    },
  });
  return {
    session,
    getAdditionalUsage() {
      const snapshot = new Usage();
      snapshot.add(additionalUsage);
      return snapshot;
    },
    projectHistory,
    async prepareModelInput(
      input: AgentInputItem[],
      context?: { signal: AbortSignal },
    ): Promise<AgentInputItem[]> {
      if (context)
        currentSignal = AbortSignal.any([options.signal, context.signal]);
      lastSource = input;
      const prepared = projectHistory(input);
      lastPrepared = prepared;
      const window =
        activeModel === options.model &&
        options.contextWindowTokens !== undefined
          ? options.contextWindowTokens
          : DEFAULT_CONTEXT_WINDOWS[activeModel];
      if (
        window &&
        observedTokens >= window * ratio &&
        completedPrefixLength(prepared) === prepared.length
      ) {
        await session.clearSession();
        await session.addItems(prepared);
        await session.runCompaction({ compactionMode: "input", store: false });
      }
      return projectHistory(input);
    },
    observeResponse(response: ModelResponse, modelName?: string) {
      if (modelName) activeModel = modelName;
      observedTokens = response.usage.inputTokens + response.usage.outputTokens;
    },
    async forceCompact(
      context?: { signal: AbortSignal; activeModelName?: string },
      input?: AgentInputItem[],
    ): Promise<AgentInputItem[] | undefined> {
      if (context)
        currentSignal = AbortSignal.any([options.signal, context.signal]);
      if (context?.activeModelName) activeModel = context.activeModelName;
      if (forceInProgress) return undefined;
      forceInProgress = true;
      let original: AgentInputItem[] = [];
      let pending: AgentInputItem[] = [];
      const previousCompactions = successfulCompactions;
      try {
        if (input) {
          lastSource = input;
          lastPrepared = projectHistory(input);
          await session.clearSession();
          await session.addItems(lastPrepared);
        } else if (
          (await session.getItems()).length === 0 &&
          lastPrepared.length
        ) {
          await session.addItems(lastPrepared);
        }
        original = await session.getItems();
        const boundary = completedPrefixLength(original);
        if (boundary === 0) {
          forceInProgress = false;
          return undefined;
        }
        pending = original.slice(boundary);
        if (pending.length) {
          await session.clearSession();
          await session.addItems(original.slice(0, boundary));
        }
        forcedPending = pending;
        const result = await session.runCompaction({
          force: true,
          compactionMode: "input",
          store: false,
        });
        if (!result) {
          if (pending.length) {
            await session.clearSession();
            await session.addItems(original);
          }
          return undefined;
        }
        return await session.getItems();
      } catch (error) {
        // SDK handles failed API replacement transactionally; restore a temporarily split suffix.
        if (pending.length && successfulCompactions === previousCompactions) {
          await session.clearSession();
          await session.addItems(original);
        }
        throw error;
      } finally {
        forcedPending = [];
        forceInProgress = false;
      }
    },
  };
}
