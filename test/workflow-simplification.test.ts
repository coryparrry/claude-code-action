import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  renderCommandWorkflow,
  renderReviewWorkflow,
} from "../scripts/github-action-installer/workflow.mjs";
import { renderFinding, renderReview } from "../src/review/schema";

const options = { repository: "owner/repo", actors: ["owner"] };

test("generated and installed PR workflows contain only the review job", async () => {
  for (const source of [
    renderReviewWorkflow(options),
    await readFile(".github/workflows/codex.yml", "utf8"),
  ]) {
    const workflow = parse(source);
    expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
    expect(Object.keys(workflow.jobs)).toEqual(["codex_review"]);
    expect(workflow.jobs.codex_review.permissions.contents).toBe("read");
    expect(workflow.jobs.codex_review.if).toContain(
      "head.repo.full_name == github.repository",
    );
  }
});
test("command workflows retain validation isolation and never trigger on PR updates", async () => {
  for (const source of [
    renderCommandWorkflow(options),
    await readFile(".github/workflows/codex-commands.yml", "utf8"),
  ]) {
    const workflow = parse(source);
    expect(workflow.on.pull_request).toBeUndefined();
    expect(workflow.on.issue_comment).toBeDefined();
    expect(Object.keys(workflow.jobs)).toEqual([
      "codex",
      "validate_change",
      "report_validation",
    ]);
    expect(workflow.jobs.validate_change.needs).toBe("codex");
    expect(workflow.jobs.validate_change.permissions).toEqual({
      contents: "read",
    });
    expect(
      workflow.jobs.codex.steps.find((s: any) => s.id === "agent").with
        .disallowed_tools,
    ).toBe("Bash,PowerShell");
  }
});
test("issue creation qualification requires an explicit label action", async () => {
  const workflow = parse(
    await readFile(
      ".github/workflows/issue-creation-qualification.yml",
      "utf8",
    ),
  );
  expect(workflow.on.pull_request.types).toEqual(["labeled"]);
  for (const job of Object.values(workflow.jobs) as any[])
    expect(job.if).toContain("test-issue-creation");
});
test("AI findings and overviews label their execution limits visibly", () => {
  const finding = {
    title: "Bug",
    path: "src/a.ts",
    line: 1,
    side: "RIGHT" as const,
    severity: "bug" as const,
    body: "A concrete failure.",
    explanation: "Inspected source.",
    verification: "Read the changed function.",
  };
  expect(renderFinding(finding, undefined, "high")).toContain(
    "AI-verified · not reproduced",
  );
  expect(renderFinding(finding)).toContain("AI review · not reproduced");
  expect(renderFinding(finding, undefined, "high")).not.toContain(
    "Confidence: high",
  );
  const review = {
    summary: "Found a defect.",
    walkthrough: "Updates handling.",
    changes: [],
    risk: { level: "low" as const, explanation: "Source inspection only." },
    flow: null,
    reviewed: [],
    reasoning: "No execution.",
    findings: [finding],
  };
  expect(renderReview(review, "a".repeat(40))).toContain(
    "AI review · tests not executed",
  );
});
