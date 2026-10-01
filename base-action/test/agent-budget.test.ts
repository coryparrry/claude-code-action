import { expect, test } from "bun:test";
import { Usage } from "@openai/agents";
import { AgentBudget, configuredModelPrices } from "../src/agent-budget";

test("configured model rates require all three finite nonnegative token prices", () => {
  expect(configuredModelPrices(undefined)).toEqual({});
  expect(
    configuredModelPrices({
      custom: { input: 1, cachedInput: 0.1, output: 2 },
    }),
  ).toEqual({
    custom: { input: 1, cachedInput: 0.1, output: 2 },
  });
  for (const invalid of [
    null,
    [],
    "prices",
    { custom: {} },
    { custom: { input: -1, cachedInput: 0, output: 2 } },
    { custom: { input: 1, cachedInput: 0, output: Infinity } },
    { custom: { input: 1, cachedInput: 0, output: 1, cacheWrite: -1 } },
    {
      custom: {
        input: 1,
        cachedInput: 0,
        output: 1,
        longContext: { threshold: 0, input: 2, cachedInput: 0, output: 2 },
      },
    },
  ]) {
    expect(() => configuredModelPrices(invalid)).toThrow();
  }
});
test("Sol prices separate cache reads/writes and apply the full-request long-context tier", () => {
  const short = new AgentBudget();
  short.accept(
    new Usage({
      inputTokens: 1000,
      outputTokens: 10,
      inputTokensDetails: { cached_tokens: 100, cache_write_tokens: 200 },
    }),
    "gpt-6.1-sol",
  );
  expect(short.cost).toBeCloseTo(0.00201, 9);
  const boundary = new AgentBudget();
  boundary.accept(
    new Usage({ inputTokens: 272_000, outputTokens: 1 }),
    "gpt-6.1-sol",
  );
  expect(boundary.cost).toBeCloseTo(0.54401, 9);
  const long = new AgentBudget(1);
  expect(() =>
    long.accept(
      new Usage({
        inputTokens: 272_001,
        outputTokens: 10,
        inputTokensDetails: { cached_tokens: 100, cache_write_tokens: 200 },
      }),
      "gpt-6.1-sol",
    ),
  ).toThrow("USD budget");
  expect(long.cost).toBeCloseTo(1.087974, 9);
});
test("budget accounts cached tokens and stops after the response that reaches the limit", () => {
  const usage = new Usage({
    inputTokens: 1000,
    outputTokens: 10,
    inputTokensDetails: { cached_tokens: 100 },
  });
  const budget = new AgentBudget(0.003);
  budget.accept(usage, "gpt-5.3-codex");
  expect(budget.cost).toBeCloseTo(0.0017325, 9);
  expect(() => budget.accept(usage, "gpt-5.3-codex")).toThrow("budget");
  expect(() => new AgentBudget(1).assertModel("unpriced-model")).toThrow(
    "token prices",
  );
});
test("budget includes hosted search calls and does not claim an unknown model costs zero", () => {
  const budget = new AgentBudget(0.02);
  const usage = new Usage({ inputTokens: 0, outputTokens: 0 });
  budget.accept(usage, "gpt-5.3-codex", [
    { type: "hosted_tool_call", name: "web_search_call", status: "completed" },
  ]);
  expect(budget.cost).toBe(0.01);
  expect(() =>
    budget.accept(usage, "gpt-5.3-codex", [
      {
        type: "hosted_tool_call",
        name: "web_search_call",
        status: "completed",
      },
    ]),
  ).toThrow("budget");
  const unknown = new AgentBudget();
  unknown.accept(usage, "unpriced-model");
  expect(unknown.costKnown).toBe(false);
});
