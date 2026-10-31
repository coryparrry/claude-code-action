import { createHash } from "node:crypto";
import { z } from "zod";
import { redactSecrets, sanitizeContent } from "../github/utils/sanitizer";

const text = z.string().trim().min(1).max(12000);
export const reviewSchema = z.strictObject({
  summary: text,
  reviewed: z.array(text).min(1).max(30),
  reasoning: text,
  findings: z
    .array(
      z.strictObject({
        title: z.string().trim().min(1).max(200),
        path: z.string().min(1).max(1000),
        line: z.number().int().positive(),
        side: z.enum(["LEFT", "RIGHT"]),
        severity: z.enum(["bug", "suggestion", "pre_existing"]),
        body: text,
        explanation: text,
        verification: text,
      }),
    )
    .max(30),
});
export type Review = z.infer<typeof reviewSchema>;
export type Finding = Review["findings"][number];
export const reviewJsonSchema = z.toJSONSchema(reviewSchema, {
  target: "draft-7",
});

/** Keep a finding's identity when its line moves in a follow-up commit. */
export function findingId(finding: Finding): string {
  return createHash("sha256")
    .update(`${finding.path}\n${finding.title.toLowerCase().trim()}`)
    .digest("hex")
    .slice(0, 12);
}

const clean = (value: string) =>
  redactSecrets(sanitizeContent(value)).replace(/<!--[\s\S]*?-->/g, "");

/** Render model evidence inside the same compact disclosure used by the reference. */
export function renderFinding(finding: Finding): string {
  return `${{ bug: "🔴", suggestion: "🟡", pre_existing: "🟣" }[finding.severity]} **${clean(finding.title)}**\n\n${clean(finding.body)}\n\n<details>\n<summary>Why this was flagged</summary>\n\n${clean(finding.explanation)}\n\n**Verification:** ${clean(finding.verification)}\n\n</details>\n\n<sub>Finding ID: \`f-${findingId(finding)}\`</sub>\n\n<!-- codex-action:finding:${findingId(finding)} -->`;
}

/** Formal COMMENT reviews deliberately cannot approve or block a pull request. */
export function renderReview(
  review: Review,
  head: string,
  duplicates = false,
): string {
  const summary = duplicates
    ? "No new findings. Previously reported findings remain in their existing threads."
    : clean(review.summary);
  const legend = review.findings.length
    ? "Findings marked 🟡 are optional suggestions and need no follow-up push.\n\n"
    : "";
  return `${legend}${summary}\n\nWhat was reviewed:\n${review.reviewed.map((item) => `- ${clean(item)}`).join("\n")}\n\n<details>\n<summary>Extended reasoning...</summary>\n\n${clean(review.reasoning)}\n\n</details>\n\n<!-- codex-action:review:${head} -->`;
}
