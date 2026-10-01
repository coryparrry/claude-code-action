import type { Usage, ModelResponse } from "@openai/agents";

export type ModelPrice = { input: number; cachedInput: number; output: number };
export function configuredModelPrices(
  value: unknown,
): Record<string, ModelPrice> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("modelPrices must be an object of token rates per million");
  const prices: Record<string, ModelPrice> = {};
  for (const [name, price] of Object.entries(value)) {
    if (!price || typeof price !== "object" || Array.isArray(price))
      throw new Error(`Invalid token prices for ${name}`);
    const rates = price as Record<string, unknown>;
    if (
      [rates.input, rates.cachedInput, rates.output].some(
        (rate) =>
          typeof rate !== "number" || !Number.isFinite(rate) || rate < 0,
      )
    )
      throw new Error(`Invalid token prices for ${name}`);
    Object.defineProperty(prices, name, {
      value: rates as ModelPrice,
      enumerable: true,
    });
  }
  return prices;
}
// Standard token rates, USD per million, verified against the official model page.
// https://developers.openai.com/api/docs/models/gpt-5.3-codex
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
};
export class AgentBudget {
  cost = 0;
  costKnown = true;
  constructor(
    readonly limit?: number,
    readonly prices: Record<string, ModelPrice> = DEFAULT_MODEL_PRICES,
  ) {
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0))
      throw new Error("Agent budget must be positive");
    for (const price of Object.values(prices))
      if (
        [price.input, price.cachedInput, price.output].some(
          (rate) => !Number.isFinite(rate) || rate < 0,
        )
      )
        throw new Error("Invalid model token prices");
  }
  assertModel(model: string): void {
    if (this.limit !== undefined && !this.prices[model])
      throw new Error(
        `USD budget requires configured token prices for ${model}`,
      );
  }
  accept(
    usage: Usage,
    model?: string,
    output: ModelResponse["output"] = [],
  ): void {
    if (!model) {
      if (this.limit !== undefined)
        throw new Error("USD budget requires a named model");
      this.costKnown = false;
      return;
    }
    this.assertModel(model);
    const price = this.prices[model];
    if (!price) {
      this.costKnown = false;
      return;
    }
    const cached = usage.inputTokensDetails.reduce(
      (total, entry) =>
        total + (entry.cached_tokens ?? entry.cachedTokens ?? 0),
      0,
    );
    this.cost +=
      (Math.max(0, usage.inputTokens - cached) * price.input +
        cached * price.cachedInput +
        usage.outputTokens * price.output) /
      1_000_000;
    // Standard Responses web search pricing: $10 / 1,000 calls. Search-content
    // tokens are accounted for in model usage above; no charge is guessed twice.
    // https://developers.openai.com/api/docs/pricing
    this.cost +=
      output.filter(
        (item) =>
          item.type === "hosted_tool_call" && item.name === "web_search_call",
      ).length * 0.01;
    if (this.limit !== undefined && this.cost >= this.limit)
      throw new Error(`Agent exceeded the USD budget of ${this.limit}`);
  }
}
