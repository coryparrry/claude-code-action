import {
  tool,
  type Model,
  type ModelRequest,
  type ModelSettings,
} from "@openai/agents";
import { z } from "zod";
import { AgentBudget, type ModelPrice } from "./agent-budget";

const effort = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const modelName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
const routingSchema = z
  .object({
    cheap_model: modelName,
    strong_model: modelName,
    cheap_effort: effort.default("low"),
    strong_effort: effort.default("high"),
    max_cheap_turns: z.number().int().min(1).max(10).default(3),
    max_cheap_input_bytes: z
      .number()
      .int()
      .min(1024)
      .max(1_000_000)
      .default(80_000),
  })
  .strict();

export type ModelRoutingConfig = z.input<typeof routingSchema>;
type Decision = { model: string; reason: string };

/** Validate the opt-in routing JSON; a blank input preserves existing model selection. */
export function parseModelRouting(value?: string | ModelRoutingConfig) {
  if (value === undefined || value === "") return undefined;
  return routingSchema.parse(
    typeof value === "string" ? JSON.parse(value) : value,
  );
}

/** Share a bounded cheap phase and one-way escalation across a run and its auxiliary agents. */
export class ModelRouter {
  readonly config: z.output<typeof routingSchema>;
  readonly decisions: Decision[] = [];
  private strong = false;
  private cheapCalls = 0;
  private readonly costs = new Map<string, AgentBudget>();

  /** Require prices for both configurable models so routing never hides unknown costs. */
  constructor(config: ModelRoutingConfig, prices: Record<string, ModelPrice>) {
    this.config = routingSchema.parse(config);
    for (const name of [this.config.cheap_model, this.config.strong_model]) {
      if (!Object.hasOwn(prices, name))
        throw new Error(`Routing requires token prices for ${name}`);
      this.costs.set(name, new AgentBudget(undefined, prices));
    }
    const cheap = prices[this.config.cheap_model]!;
    const strong = prices[this.config.strong_model]!;
    if (
      cheap.input > strong.input ||
      cheap.output > strong.output ||
      cheap.cachedInput > strong.cachedInput
    )
      throw new Error(
        "Routing cheap_model must not have higher token rates than strong_model",
      );
  }

  /** Reject unpriced or unnamed auxiliary/fallback models before any inference is paid for. */
  assertPricedModel(model: string | Model): void {
    if (
      typeof model !== "string" ||
      !Object.hasOwn(this.costs.values().next().value!.prices, model)
    )
      throw new Error(
        "Routing requires token prices for every named model, including fallbacks",
      );
  }

  /** Honor explicit strong requests; reject a third role rather than silently substituting cheap inference. */
  requestModel(model: string | Model): void {
    if (model === this.config.strong_model)
      this.escalate("explicit stronger-model selection");
    else if (model !== this.config.cheap_model)
      throw new Error(
        "Explicit model overrides with routing must name cheap_model or strong_model",
      );
  }

  /** Select without a paid classifier; risky paths, large context and exhausted cheap turns escalate. */
  select(request: ModelRequest): string {
    const input =
      typeof request.input === "string"
        ? request.input
        : JSON.stringify(request.input);
    if (
      Buffer.byteLength(
        JSON.stringify({
          input: request.input,
          instructions: request.systemInstructions,
          tools: request.tools,
        }),
      ) > this.config.max_cheap_input_bytes
    )
      this.escalate("input exceeds the configured cheap-model byte limit");
    else if (
      /(?:\b(?:authentication|authorization|cryptography|race condition|deadlock|sql injection|bounds?|indices|index|pagination|overflow|underflow)\b|(?:^|[\s"'\/])(?:auth|payments?|migrations?|permissions?|crypto)[\/\.])/im.test(
        input,
      )
    )
      this.escalate("task contains a sensitive path or complex failure mode");
    else if (this.cheapCalls >= this.config.max_cheap_turns)
      this.escalate("shared cheap-model turn allowance exhausted");
    const model = this.strong
      ? this.config.strong_model
      : this.config.cheap_model;
    if (!this.decisions.length)
      this.decisions.push({ model, reason: "bounded cheap-model execution" });
    if (!this.strong) this.cheapCalls++;
    return model;
  }

  /** Escalate at most once without replaying tool calls or restarting the conversation. */
  escalate(reason: string): void {
    if (this.strong) return;
    this.strong = true;
    this.decisions.push({ model: this.config.strong_model, reason });
  }

  /** Set the selected tier's reasoning effort while preserving other workflow settings. */
  settings(model: string, settings?: ModelSettings): ModelSettings {
    if (model !== this.config.cheap_model && model !== this.config.strong_model)
      return settings ?? {};
    return {
      ...settings,
      reasoning: {
        ...settings?.reasoning,
        effort:
          model === this.config.cheap_model && !this.strong
            ? this.config.cheap_effort
            : this.config.strong_effort,
      },
    };
  }

  /** Account every observed response, including auxiliary and API-fallback models. */
  record(
    model: string | undefined,
    usage: Parameters<AgentBudget["accept"]>[0],
    output: Parameters<AgentBudget["accept"]>[2],
  ): void {
    if (!model)
      throw new Error("Routing cost accounting requires named models");
    let budget = this.costs.get(model);
    if (!budget) {
      const prices = this.costs.values().next().value!.prices;
      if (!Object.hasOwn(prices, model))
        throw new Error(`Routing requires token prices for ${model}`);
      budget = new AgentBudget(undefined, prices);
      this.costs.set(model, budget);
    }
    budget.accept(usage, model, output);
  }

  /** Expose actual accounted costs and decisions; never label a counterfactual as savings. */
  report() {
    return {
      cheap_model: this.config.cheap_model,
      strong_model: this.config.strong_model,
      cheap_calls: this.cheapCalls,
      escalated: this.strong,
      decisions: this.decisions,
      cost_by_model_usd: Object.fromEntries(
        [...this.costs].map(([name, budget]) => [name, budget.cost]),
      ),
    };
  }

  /** Let the cheap model request help before guessing, editing uncertain code or publishing findings. */
  escalationTool() {
    return tool({
      name: "request_stronger_model",
      description:
        "Switch permanently to the configured stronger model when reasoning is uncertain, tests fail, or the task is too complex. Call before guessing or publishing uncertain results. The conversation and completed tools are retained.",
      parameters: z.object({ reason: z.string().min(1).max(500) }),
      execute: async ({ reason }) => {
        this.escalate(reason);
        return "The next model response will use the configured stronger model with the existing conversation.";
      },
    });
  }
}

export const ROUTING_INSTRUCTIONS =
  "A cheaper model may be handling this task. If you cannot reliably finish, discover a complex or sensitive change, or encounter failed validation you cannot resolve, call request_stronger_model before proceeding. Do not claim checks passed without running them.";
