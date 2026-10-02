import type { Usage, ModelResponse } from "@openai/agents";

export type ModelPrice = {
  input: number;
  cachedInput: number;
  output: number;
  cacheWrite?: number;
  longContext?: {
    input: number;
    cachedInput: number;
    output: number;
    cacheWrite?: number;
  };
};
function validRates(value: unknown): value is ModelPrice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rates = value as Record<string, unknown>;
  const validRate = (rate: unknown) =>
    typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
  return (
    [rates.input, rates.cachedInput, rates.output].every(validRate) &&
    (rates.cacheWrite === undefined || validRate(rates.cacheWrite)) &&
    (rates.longContext === undefined ||
      (validRates(rates.longContext) &&
        !("longContext" in (rates.longContext as object))))
  );
}
export function configuredModelPrices(
  value: unknown,
): Record<string, ModelPrice> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("modelPrices must be an object of token rates per million");
  const prices: Record<string, ModelPrice> = {};
  for (const [name, price] of Object.entries(value)) {
    if (!validRates(price)) throw new Error(`Invalid token prices for ${name}`);
    Object.defineProperty(prices, name, {
      value: price,
      enumerable: true,
    });
  }
  return prices;
}
// Standard token rates, USD per million, verified against the official model page.
// https://developers.openai.com/api/docs/models/gpt-5.3-codex
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  // Standard rates, verified 2026-10-01: https://developers.openai.com/api/docs/pricing
  "gpt-6-luna": {
    input: 0.1,
    cachedInput: 0.01,
    output: 0.5,
    cacheWrite: 0.125,
    longContext: {
      input: 0.2,
      cachedInput: 0.02,
      output: 0.75,
      cacheWrite: 0.25,
    },
  },
  "gpt-6.1-sol": {
    input: 2,
    cachedInput: 0.1,
    output: 10,
    cacheWrite: 2.5,
    longContext: { input: 4, cachedInput: 0.2, output: 15, cacheWrite: 5 },
  },
  "gpt-6-astra": {
    input: 10,
    cachedInput: 1,
    output: 50,
    cacheWrite: 12.5,
    longContext: { input: 20, cachedInput: 2, output: 75, cacheWrite: 25 },
  },
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
      if (!validRates(price)) throw new Error("Invalid model token prices");
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
    const details: Record<string, number> = {};
    for (const entry of usage.inputTokensDetails)
      for (const [key, value] of Object.entries(entry))
        details[key] = (details[key] ?? 0) + value;
    const requests = usage.requestUsageEntries?.length
      ? usage.requestUsageEntries
      : [
          {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            inputTokensDetails: details,
          },
        ];
    for (const request of requests) {
      const rates =
        request.inputTokens > 272_000 && price.longContext
          ? price.longContext
          : price;
      const cached =
        request.inputTokensDetails.cached_tokens ??
        request.inputTokensDetails.cachedTokens ??
        0;
      const written =
        request.inputTokensDetails.cache_write_tokens ??
        request.inputTokensDetails.cache_creation_input_tokens ??
        0;
      this.cost +=
        (Math.max(0, request.inputTokens - cached - written) * rates.input +
          cached * rates.cachedInput +
          written * (rates.cacheWrite ?? rates.input) +
          request.outputTokens * rates.output) /
        1_000_000;
    }
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
