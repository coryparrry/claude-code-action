/** A paired observation records all accounted API cost and an externally checked task outcome. */
export type RoutingObservation = {
  case: string;
  repeat: number;
  arm: "baseline" | "routed";
  passed: boolean;
  cost_usd: number;
};

/** Require complete pairs, passing quality checks and at least 20% aggregate savings. */
export function evaluateRouting(
  rows: RoutingObservation[],
  expectedPairs: number,
) {
  const baseline = rows.filter((r) => r.arm === "baseline");
  const routed = rows.filter((r) => r.arm === "routed");
  const keys = new Set(rows.map((r) => `${r.case}:${r.repeat}`));
  const complete =
    expectedPairs > 0 &&
    keys.size === expectedPairs &&
    rows.length === expectedPairs * 2 &&
    [...keys].every((key) =>
      ["baseline", "routed"].every(
        (arm) =>
          rows.filter((r) => `${r.case}:${r.repeat}` === key && r.arm === arm)
            .length === 1,
      ),
    );
  const knownCost = rows.every(
    (r) => Number.isFinite(r.cost_usd) && r.cost_usd >= 0,
  );
  const baselineCost = baseline.reduce((sum, r) => sum + r.cost_usd, 0);
  const routedCost = routed.reduce((sum, r) => sum + r.cost_usd, 0);
  const regressions = routed.filter(
    (r) =>
      !r.passed &&
      baseline.some(
        (b) => b.case === r.case && b.repeat === r.repeat && b.passed,
      ),
  );
  return {
    baseline_cost_usd: baselineCost,
    routed_cost_usd: routedCost,
    savings_fraction:
      knownCost && baselineCost > 0 ? 1 - routedCost / baselineCost : null,
    baseline_passed: baseline.filter((r) => r.passed).length,
    routed_passed: routed.filter((r) => r.passed).length,
    runs_per_arm: baseline.length,
    paired_regressions: regressions.map((r) => ({
      case: r.case,
      repeat: r.repeat,
    })),
    complete_pairs: complete,
    accepted:
      complete &&
      knownCost &&
      baselineCost > 0 &&
      baseline.every((r) => r.passed) &&
      routed.every((r) => r.passed) &&
      routedCost <= baselineCost * 0.8,
  };
}

/** Accept combined or separate findings only when every expected defect is explained and no extra defect is asserted. */
export function gradeReview(
  path: string,
  expected: {
    category: string;
    from: number;
    to: number;
    explanation_pattern?: string;
  }[],
  output: unknown,
): boolean {
  const findings = (output as { findings?: unknown[] })?.findings;
  if (!Array.isArray(findings)) return false;
  if (expected.length === 0) return findings.length === 0;
  if (findings.length === 0 || findings.length > expected.length) return false;
  /** Match a concrete location/category plus the distinguishing evidence for this defect. */
  const matches = (raw: unknown, spec: (typeof expected)[number]) => {
    if (!raw || typeof raw !== "object") return false;
    const finding = raw as Record<string, unknown>;
    return (
      finding.file === path &&
      finding.category === spec.category &&
      typeof finding.line === "number" &&
      finding.line >= spec.from &&
      finding.line <= spec.to &&
      typeof finding.explanation === "string" &&
      finding.explanation.length >= 20 &&
      (!spec.explanation_pattern ||
        new RegExp(spec.explanation_pattern, "i").test(finding.explanation))
    );
  };
  return (
    expected.every((spec) => findings.some((f) => matches(f, spec))) &&
    findings.every((f) => expected.some((spec) => matches(f, spec)))
  );
}
