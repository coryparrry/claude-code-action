import { test, expect } from "bun:test";
import { Usage } from "@openai/agents";
import { AgentBudget, configuredModelPrices } from "../src/agent-budget";
import { boundMcpOutput } from "../src/agent-mcp-output";

test("Luna budgets account standard, cached and long-context requests separately", () => {
  const budget = new AgentBudget(1);
  budget.assertModel("gpt-6-luna");
  budget.accept(
    new Usage({
      requestUsageEntries: [
        {
          inputTokens: 1000,
          outputTokens: 100,
          totalTokens: 1100,
          inputTokensDetails: { cached_tokens: 100, cache_write_tokens: 200 },
        },
        {
          inputTokens: 300000,
          outputTokens: 100,
          totalTokens: 300100,
          inputTokensDetails: { cached_tokens: 1000 },
        },
      ],
    }),
    "gpt-6-luna",
  );
  expect(budget.cost).toBeCloseTo(
    (700 * 0.1 +
      100 * 0.01 +
      200 * 0.125 +
      100 * 0.5 +
      299000 * 0.2 +
      1000 * 0.02 +
      100 * 0.75) /
      1000000,
    10,
  );
  expect(() =>
    new AgentBudget(0.000001).accept(
      new Usage({ inputTokens: 1000 }),
      "gpt-6-luna",
    ),
  ).toThrow("exceeded");
});

test("MCP token bounds preserve Unicode and mark truncated results", () => {
  const result = boundMcpOutput("😀".repeat(100), 50);
  expect(Buffer.byteLength(result)).toBeLessThanOrEqual(50);
  expect(result).toContain("truncated");
  expect(result).not.toContain("�");
  expect(boundMcpOutput("ok", 50)).toBe("ok");
});

test.each([
  { input: Number.NaN, cachedInput: 0, output: 0 },
  { input: 1, cachedInput: 0, output: 0, cacheWrite: Number.POSITIVE_INFINITY },
  {
    input: 1,
    cachedInput: 0,
    output: 0,
    longContext: { input: 1, cachedInput: 0, output: -1 },
  },
  {
    input: 1,
    cachedInput: 0,
    output: 0,
    longContext: {
      input: 1,
      cachedInput: 0,
      output: 1,
      longContext: { input: 1, cachedInput: 0, output: 1 },
    },
  },
])("rejects invalid custom pricing rates", (rates) => {
  expect(() => configuredModelPrices({ fixture: rates })).toThrow(
    "Invalid token prices for fixture",
  );
});
