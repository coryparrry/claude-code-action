import {
  Agent,
  AgentsError,
  MaxTurnsExceededError,
  OpenAIProvider,
  RunContext,
  RunState,
  Runner,
  Usage,
  type AgentInputItem,
  type JsonSchemaDefinition,
  type MCPServer,
  type Model,
  type ModelProvider,
  type ModelResponse,
  type ModelRequest,
  type ModelSettings,
  type Session,
  type Tool,
} from "@openai/agents";
import { randomUUID } from "node:crypto";

export type OpenAIAgentEvent =
  | { type: "tool.started"; toolName: string; callId?: string; input: unknown }
  | {
      type: "tool.completed";
      toolName: string;
      callId?: string;
      output: string;
    }
  | { type: "assistant"; text: string }
  | { type: "assistant.delta"; text: string; itemId?: string }
  | {
      type: "model.response";
      response: ModelResponse;
      turn: number;
      activeModelName?: string;
    }
  | { type: "model.fallback" };

export type OpenAIAgentOptions = {
  apiKey: string;
  baseURL?: string;
  model: string | Model;
  fallbackModel?: string | Model;
  resolveModel?: () => string | Model | Promise<string | Model>;
  includePartialMessages?: boolean;
  /** Testable model boundary; production defaults to an API-key-only OpenAI provider. */
  modelProvider?: ModelProvider;
  instructions: string;
  tools: Tool[];
  mcpServers?: MCPServer[];
  modelSettings?: ModelSettings;
  schema?: JsonSchemaDefinition["schema"];
  validateOutput?: (output: unknown) => void;
  maxTurns?: number;
  deadline: number;
  signal?: AbortSignal;
  session?: Session;
  sessionId?: string;
  onEvent?: (event: OpenAIAgentEvent) => void;
  /** Append hook context at the SDK model-input boundary without restarting the run. */
  onBeforeModel?: (
    input: AgentInputItem[],
    context: { turn: number; signal: AbortSignal; sessionId: string },
  ) => AgentInputItem[] | undefined | Promise<AgentInputItem[] | undefined>;
  prepareModelInput?: (
    input: AgentInputItem[],
    context: { signal: AbortSignal },
  ) => Promise<AgentInputItem[]>;
  transformHistory?: (input: AgentInputItem[]) => AgentInputItem[];
  additionalUsage?: () => Usage;
  onContextLimit?: (
    input: AgentInputItem[],
    context: { signal: AbortSignal; activeModelName?: string },
  ) => Promise<AgentInputItem[] | undefined>;
  /** Returning instructions continues a Stop-blocked session within the original limits. */
  onSessionFinal?: (
    result: OpenAIAgentResult,
    context: { stopHookActive: boolean },
  ) => string | undefined | Promise<string | undefined>;
};

export type OpenAIAgentResult = {
  finalOutput: unknown;
  history: AgentInputItem[];
  usage: Usage;
  turns: number;
  sessionId: string;
};

export class OpenAIAgentRunError extends Error {
  constructor(
    message: string,
    readonly partialResult: Omit<OpenAIAgentResult, "finalOutput">,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "OpenAIAgentRunError";
  }
}

function canFallback(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return (
    status === 404 ||
    status === 429 ||
    (typeof status === "number" && status >= 500 && status <= 599) ||
    code === "model_not_found" ||
    code === "context_length_exceeded"
  );
}

/** One real Agents SDK run. Fallback repeats only a failed model request, never tools. */
export async function runOpenAIAgent(
  input: string | AgentInputItem[],
  options: OpenAIAgentOptions,
): Promise<OpenAIAgentResult> {
  const maxTurns = options.maxTurns ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)
    throw new Error("Agent maxTurns must be a positive integer");
  if (!Number.isFinite(options.deadline))
    throw new Error("Agent deadline must be finite");
  if (options.signal?.aborted) throw new Error("Agent execution cancelled");
  if (options.deadline <= Date.now())
    throw new Error("Agent execution timed out");

  const baseURL = options.baseURL ?? "https://api.openai.com/v1";
  const endpoint = new URL(baseURL);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error(
      "Agent baseURL must use HTTP/HTTPS without embedded credentials",
    );
  let sessionId = options.sessionId ?? randomUUID();
  let history: AgentInputItem[] =
    typeof input === "string" ? [{ role: "user", content: input }] : input;
  let activeState:
    | { readonly history: AgentInputItem[]; readonly usage: Usage }
    | undefined;
  let hookContext: { at: number; items: AgentInputItem[] }[] = [];
  const withHookContext = (input: AgentInputItem[]): AgentInputItem[] => {
    const combined: AgentInputItem[] = [];
    let cursor = 0;
    for (const insertion of hookContext) {
      const at = Math.min(insertion.at, input.length);
      combined.push(...input.slice(cursor, at), ...insertion.items);
      cursor = at;
    }
    combined.push(...input.slice(cursor));
    return combined;
  };
  const completedUsage = new Usage();
  const modelUsage = new Usage();
  let turns = 0;

  const controller = new AbortController();
  let interruption: string | undefined;
  let rejectInterrupted!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  const interrupt = (message: string) => {
    interruption ??= message;
    controller.abort();
    rejectInterrupted(new Error(interruption));
  };
  const abort = () => interrupt("Agent execution cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => interrupt("Agent execution timed out"),
    Math.max(1, options.deadline - Date.now()),
  );
  const emit = (event: OpenAIAgentEvent) => {
    if (controller.signal.aborted) throw new Error(interruption);
    options.onEvent?.(event);
  };

  try {
    const execute = async (): Promise<OpenAIAgentResult> => {
      if (options.session) {
        if (!options.sessionId)
          sessionId = await options.session.getSessionId();
        history = [...(await options.session.getItems()), ...history];
      }
      const provider =
        options.modelProvider ??
        new OpenAIProvider({
          apiKey: options.apiKey,
          baseURL,
        });
      const resolveModel = (model: string | Model): Promise<Model> =>
        typeof model === "string"
          ? Promise.resolve(provider.getModel(model))
          : Promise.resolve(model);
      let primary = options.model;
      let selected = await resolveModel(primary);
      let activeModelName =
        typeof options.model === "string" ? options.model : undefined;
      let fallbackUsed = false;
      let contextRecoveryUsed = false;
      const model: Model = {
        async getResponse(request) {
          if (controller.signal.aborted) throw new Error(interruption);
          const desired = (await options.resolveModel?.()) ?? primary;
          if (desired !== primary) {
            primary = desired;
            selected = await resolveModel(primary);
            activeModelName = typeof primary === "string" ? primary : undefined;
            fallbackUsed = false;
          }
          if (controller.signal.aborted) throw new Error(interruption);
          turns++;
          let emittedPartial = false;
          const invoke = async (
            request: ModelRequest,
          ): Promise<ModelResponse> => {
            if (controller.signal.aborted) throw new Error(interruption);
            if (!options.includePartialMessages)
              return selected.getResponse(request);
            let completed: ModelResponse | undefined;
            for await (const event of selected.getStreamedResponse(request)) {
              if (controller.signal.aborted) throw new Error(interruption);
              if (event.type === "output_text_delta") {
                emittedPartial = true;
                emit({
                  type: "assistant.delta",
                  text: event.delta,
                  itemId: event.itemId,
                });
              } else if (event.type === "model") {
                // Once provider output starts, a failed stream cannot safely replay.
                emittedPartial = true;
              } else if (event.type === "response_done") {
                completed = {
                  output: event.response.output,
                  usage: new Usage(event.response.usage),
                  responseId: event.response.id,
                  requestId: event.response.requestId,
                  providerData: event.response.providerData,
                  rawUsage: event.response.rawUsage,
                };
              }
            }
            if (!completed)
              throw new Error(
                "Agent stream ended without a completed response",
              );
            return completed;
          };
          let response: ModelResponse;
          try {
            response = await invoke(request);
          } catch (initialError) {
            let error = initialError;
            if (
              !contextRecoveryUsed &&
              !emittedPartial &&
              options.onContextLimit &&
              !controller.signal.aborted &&
              error &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "context_length_exceeded"
            ) {
              contextRecoveryUsed = true;
              const compacted = await options.onContextLimit(
                typeof request.input === "string"
                  ? [{ role: "user", content: request.input }]
                  : request.input,
                { signal: controller.signal, activeModelName },
              );
              if (compacted) {
                request = { ...request, input: compacted };
                let recovered: ModelResponse | undefined;
                try {
                  recovered = await invoke(request);
                } catch (recoveryError) {
                  error = recoveryError;
                }
                if (recovered) {
                  modelUsage.add(recovered.usage);
                  emit({
                    type: "model.response",
                    response: recovered,
                    turn: turns,
                    activeModelName,
                  });
                  return recovered;
                }
              }
            }
            if (
              !options.fallbackModel ||
              fallbackUsed ||
              emittedPartial ||
              controller.signal.aborted ||
              !canFallback(error)
            )
              throw error;
            fallbackUsed = true;
            selected = await resolveModel(options.fallbackModel);
            activeModelName =
              typeof options.fallbackModel === "string"
                ? options.fallbackModel
                : undefined;
            emit({ type: "model.fallback" });
            response = await invoke(request);
          }
          modelUsage.add(response.usage);
          emit({
            type: "model.response",
            response,
            turn: turns,
            activeModelName,
          });
          return response;
        },
        getStreamedResponse(request) {
          return selected.getStreamedResponse(request);
        },
      };
      const agent = new Agent({
        name: "GitHub action agent",
        instructions: options.instructions,
        model,
        modelSettings: { ...options.modelSettings, store: false },
        tools: options.tools,
        mcpServers: options.mcpServers,
        outputType: options.schema
          ? {
              type: "json_schema",
              name: "action_result",
              strict: true,
              schema: options.schema,
            }
          : "text",
      });
      const runner = new Runner({ tracingDisabled: true });
      runner.on("agent_tool_start", (_context, _agent, tool, details) => {
        emit({
          type: "tool.started",
          toolName: tool.name,
          callId:
            "callId" in details.toolCall ? details.toolCall.callId : undefined,
          input: details.toolCall,
        });
      });
      runner.on("agent_tool_end", (_context, _agent, tool, output, details) => {
        emit({
          type: "tool.completed",
          toolName: tool.name,
          callId:
            "callId" in details.toolCall ? details.toolCall.callId : undefined,
          output,
        });
      });
      runner.on("agent_end", (_context, _agent, text) => {
        emit({
          type: "assistant",
          text: typeof text === "string" ? text : JSON.stringify(text),
        });
      });
      let nextInput: string | AgentInputItem[] = input;
      let continuations = 0;
      while (true) {
        const remainingTurns = maxTurns - turns;
        if (remainingTurns <= 0)
          throw new MaxTurnsExceededError(
            "Stop continuation exceeded maxTurns",
          );
        // Owned public state exposes committed history even when cancellation races a stalled model.
        const state = options.session
          ? undefined
          : new RunState(new RunContext(), nextInput, agent, remainingTurns);
        activeState = state;
        const result = await runner.run(agent, state ?? nextInput, {
          maxTurns: remainingTurns,
          signal: controller.signal,
          session: options.session,
          callModelInputFilter:
            options.onBeforeModel || options.prepareModelInput
              ? async ({ modelData }) => {
                  const input = withHookContext(modelData.input);
                  const additions = await options.onBeforeModel?.(
                    options.transformHistory?.(input) ?? input,
                    { turn: turns + 1, signal: controller.signal, sessionId },
                  );
                  if (controller.signal.aborted) throw new Error(interruption);
                  // SDK Session stores retain injections; public RunState.history omits them.
                  if (additions?.length)
                    hookContext.push({
                      at: modelData.input.length,
                      items: structuredClone(additions),
                    });
                  return {
                    ...modelData,
                    input: options.prepareModelInput
                      ? await options.prepareModelInput(
                          withHookContext(modelData.input),
                          { signal: controller.signal },
                        )
                      : withHookContext(modelData.input),
                  };
                }
              : undefined,
        });
        if (controller.signal.aborted) throw new Error(interruption);
        if (result.finalOutput === undefined)
          throw new Error("Agent did not produce a final assistant message");
        history =
          options.transformHistory?.(withHookContext(result.history)) ??
          withHookContext(result.history);
        hookContext = [];
        completedUsage.add(result.runContext.usage);
        activeState = undefined;
        const candidateUsage = new Usage();
        candidateUsage.add(completedUsage);
        if (options.additionalUsage)
          candidateUsage.add(options.additionalUsage());
        const final: OpenAIAgentResult = {
          finalOutput: result.finalOutput,
          history,
          usage: candidateUsage,
          turns,
          sessionId,
        };
        const continuation = await options.onSessionFinal?.(final, {
          stopHookActive: continuations > 0,
        });
        if (controller.signal.aborted) throw new Error(interruption);
        if (!continuation) {
          options.validateOutput?.(result.finalOutput);
          return final;
        }
        continuations++;
        nextInput = options.session
          ? continuation
          : [...history, { role: "user", content: continuation }];
      }
    };
    return await Promise.race([execute(), interrupted]);
  } catch (error) {
    const state =
      error instanceof AgentsError && error.state ? error.state : activeState;
    const usage = new Usage();
    usage.add(completedUsage);
    if (state) usage.add(state.usage);
    // Response callbacks may reject a spent API request before the SDK records it.
    const reportedUsage = new Usage();
    reportedUsage.add(
      modelUsage.inputTokens + modelUsage.outputTokens >
        usage.inputTokens + usage.outputTokens
        ? modelUsage
        : usage,
    );
    if (options.additionalUsage) reportedUsage.add(options.additionalUsage());
    let message = error instanceof Error ? error.message : String(error);
    if (interruption) message = interruption;
    else if (error instanceof MaxTurnsExceededError)
      message = `Agent exceeded the ${maxTurns} turn limit`;
    throw new OpenAIAgentRunError(
      message,
      {
        history: structuredClone(
          state
            ? (options.transformHistory?.(withHookContext(state.history)) ??
                withHookContext(state.history))
            : (options.transformHistory?.(history) ?? history),
        ),
        usage: reportedUsage,
        turns,
        sessionId,
      },
      error,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
