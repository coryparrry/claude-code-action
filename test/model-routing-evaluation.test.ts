import { expect, test } from "bun:test";
import {
  evaluateRouting,
  gradeReview,
  type RoutingObservation,
} from "../scripts/model-routing/evaluation";
import { parse } from "yaml";
import { readFile } from "node:fs/promises";

/** Construct a valid pair with independently checked quality and a 50% saving. */
function pair(): RoutingObservation[] {
  return [
    { case: "task", repeat: 0, arm: "baseline", passed: true, cost_usd: 1 },
    { case: "task", repeat: 0, arm: "routed", passed: true, cost_usd: 0.5 },
  ];
}

test("acceptance needs savings and passing outcomes, not cheaper tokens alone", () => {
  expect(evaluateRouting(pair(), 1).accepted).toBe(true);
  for (const cost of [0.9, 1.1, NaN, -1]) {
    const rows = pair();
    rows[1]!.cost_usd = cost;
    expect(evaluateRouting(rows, 1).accepted).toBe(false);
  }
  const failed = pair();
  failed[1]!.passed = false;
  expect(evaluateRouting(failed, 1).paired_regressions).toEqual([
    { case: "task", repeat: 0 },
  ]);
  expect(evaluateRouting(failed, 1).accepted).toBe(false);
  failed[0]!.passed = false;
  expect(evaluateRouting(failed, 1).accepted).toBe(false);
});
test("incomplete, duplicate and unrelated pairs cannot qualify", () => {
  expect(evaluateRouting([], 0).accepted).toBe(false);
  expect(evaluateRouting(pair().slice(0, 1), 1).accepted).toBe(false);
  expect(evaluateRouting(pair(), 2).accepted).toBe(false);
  const unrelated = pair();
  unrelated[1]!.case = "different";
  expect(evaluateRouting(unrelated, 1).accepted).toBe(false);
  expect(evaluateRouting([...pair(), ...pair()], 2).accepted).toBe(false);
});
test("both action manifests forward the public routing input", async () => {
  for (const [path, envName] of [
    ["action.yml", "MODEL_ROUTING"],
    ["base-action/action.yml", "INPUT_MODEL_ROUTING"],
  ]) {
    const manifest = parse(await readFile(path!, "utf8"));
    expect(manifest.inputs.model_routing.default).toBe("");
    expect(
      manifest.runs.steps.some(
        (step: { env?: Record<string, string> }) =>
          step.env?.[envName!] === "${{ inputs.model_routing }}",
      ),
    ).toBe(true);
  }
});

test("review grading requires both boundary defects but accepts a combined explanation", () => {
  const expected = [
    { category: "bounds", from: 2, to: 3, explanation_pattern: "length" },
    {
      category: "bounds",
      from: 2,
      to: 3,
      explanation_pattern: "noninteger|NaN",
    },
  ];
  const end = {
    file: "src/item.ts",
    line: 2,
    category: "bounds",
    explanation:
      "Index equal to values.length returns undefined, violating the contract.",
  };
  const fractional = {
    ...end,
    explanation:
      "A noninteger index or NaN returns undefined, violating the contract.",
  };
  expect(gradeReview("src/item.ts", expected, { findings: [end] })).toBe(false);
  expect(
    gradeReview("src/item.ts", expected, { findings: [end, fractional] }),
  ).toBe(true);
  expect(
    gradeReview("src/item.ts", expected, {
      findings: [
        { ...end, explanation: end.explanation + fractional.explanation },
      ],
    }),
  ).toBe(true);
  expect(gradeReview("src/item.ts", [], { findings: [end] })).toBe(false);
  expect(
    gradeReview("src/item.ts", expected, {
      findings: [{ ...end, file: "wrong.ts" }, fractional],
    }),
  ).toBe(false);
});
