import {
  BatchTraceProcessor,
  OpenAITracingExporter,
  getCurrentTrace,
  setTraceProcessors,
  withTrace,
  Span,
  type SpanData,
  type Trace,
} from "@openai/agents";
import * as core from "@actions/core";

export type AgentTracePhase = "task" | "review" | "verification" | "auxiliary";
export type AgentTraceConfig = {
  enabled: boolean;
  apiKey: string;
  workflowName: string;
  groupId: string;
  metadata: Record<string, string>;
};
let processor: BatchTraceProcessor | undefined;
let flushController: AbortController | undefined;
let pendingFlush: Promise<void> | undefined;
const EXPORT_TIMEOUT_MS = 5000;

/** Parse the public opt-out strictly without changing omitted action controls. */
export function parseTracingEnabled(value?: string): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== "true" && value !== "false")
    throw new Error("enable_tracing must be true or false");
  return value === "true";
}

/** Enable first-party OpenAI exports without disclosing cloud/gateway credentials or payload content. */
export function agentTraceConfig(options: {
  apiKey: string;
  baseURL?: string;
  enabled?: boolean;
  customModel?: boolean;
  phase?: AgentTracePhase;
  sessionId: string;
  environment?: NodeJS.ProcessEnv;
}): AgentTraceConfig {
  const env = options.environment ?? process.env;
  const endpoint = new URL(options.baseURL ?? "https://api.openai.com/v1");
  const enabled =
    options.enabled !== false &&
    !options.customModel &&
    endpoint.protocol === "https:" &&
    endpoint.hostname === "api.openai.com" &&
    !endpoint.username &&
    !endpoint.password &&
    !["1", "true"].includes(env.OPENAI_AGENTS_DISABLE_TRACING ?? "");
  const phase = options.phase ?? "task";
  const metadata: Record<string, string> = { phase };
  for (const [key, variable] of Object.entries({
    repository: "GITHUB_REPOSITORY",
    run_id: "GITHUB_RUN_ID",
    run_attempt: "GITHUB_RUN_ATTEMPT",
    event: "GITHUB_EVENT_NAME",
  })) {
    const value = env[variable];
    if (value && !value.includes(options.apiKey))
      metadata[key] = value.slice(0, 200);
  }
  const pr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "")?.[1];
  if (pr) metadata.pull_request = pr;
  return {
    enabled,
    apiKey: options.apiKey,
    workflowName: `Codex ${phase}`,
    groupId: metadata.run_id
      ? `github:${metadata.repository ?? "repository"}:${metadata.run_id}:${metadata.run_attempt ?? "1"}`
      : options.sessionId,
    metadata,
  };
}

/** Own the action process's SDK exporter so public SDK flushing can be awaited and aborted. */
function traceProcessor(): BatchTraceProcessor {
  if (!processor) {
    const exporter = new OpenAITracingExporter({ maxRetries: 1 });
    processor = new BatchTraceProcessor({
      /** Bound network export independently of inference; per-trace SDK keys select the project. */
      async export(items: (Trace | Span<SpanData>)[], signal?: AbortSignal) {
        const combined = AbortSignal.any([
          AbortSignal.timeout(EXPORT_TIMEOUT_MS),
          ...(signal ? [signal] : []),
          ...(flushController ? [flushController.signal] : []),
        ]);
        // SDK model-error messages can contain request text even with sensitive data disabled.
        for (const item of items)
          if (item instanceof Span && item.error)
            item.setError({
              message: "Operation failed; error details omitted from trace.",
            });
        if (!combined.aborted) await exporter.export(items, combined);
      },
    });
    setTraceProcessors([processor]);
  }
  return processor;
}

/** End the root trace on success/failure, while auxiliary agents reuse their caller's trace. */
export async function withAgentTrace<T>(
  config: AgentTraceConfig,
  run: () => Promise<T>,
): Promise<T> {
  if (!config.enabled || getCurrentTrace()) return run();
  traceProcessor();
  return withTrace(
    config.workflowName,
    async (trace) => {
      core.info(`OpenAI Agents SDK trace: ${trace.traceId}`);
      return run();
    },
    {
      groupId: config.groupId,
      metadata: config.metadata,
      tracingApiKey: config.apiKey,
    },
  );
}

/** Finish queued spans before returning; telemetry failures never change action success or failure. */
export async function flushAgentTraces(
  config: AgentTraceConfig,
): Promise<void> {
  if (!config.enabled || !processor || getCurrentTrace()) return;
  if (!pendingFlush) {
    flushController = new AbortController();
    const timeout = setTimeout(
      () => flushController?.abort(),
      EXPORT_TIMEOUT_MS,
    );
    pendingFlush = processor
      .forceFlush()
      .catch(() => {
        core.warning(
          "OpenAI trace export failed; action results are unchanged.",
        );
      })
      .finally(() => {
        clearTimeout(timeout);
        flushController = undefined;
        pendingFlush = undefined;
      });
  }
  await pendingFlush;
}
