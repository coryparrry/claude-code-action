import { createHash } from "node:crypto";
import { z } from "zod";
import { redactSecrets, sanitizeContent } from "../github/utils/sanitizer";
import { GITHUB_SERVER_URL } from "../github/api/config";
import { renderDetails } from "../github/operations/comments/render";

export const GROUPED_REVIEW_MARKER = "<!-- codex-action:grouped-review -->";
export const MAX_REVIEW_COMMENT_BYTES = 60000;
export type ReviewLocation = {
  owner: string;
  repo: string;
  base: string;
  head: string;
  renamedPaths?: Record<string, string>;
};

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
        side: z
          .enum(["LEFT", "RIGHT"])
          .describe(
            "RIGHT for current code, including unchanged files; LEFT only for removed lines in the prepared patch",
          ),
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

/** One expandable finding inside the grouped inline discussion. */
export function renderFinding(
  finding: Finding,
  location?: ReviewLocation,
): string {
  const marker = { bug: "🔴", suggestion: "🟡", pre_existing: "🟣" }[
    finding.severity
  ];
  const position = `${clean(finding.path)}:${finding.line}`;
  const anchor = createHash("sha256")
    .update(location?.renamedPaths?.[finding.path] ?? finding.path)
    .digest("hex");
  const sourcePath = finding.path.split("/").map(encodeURIComponent).join("/");
  const repository = location
    ? `${GITHUB_SERVER_URL}/${location.owner}/${location.repo}`
    : undefined;
  const link = location
    ? finding.side === "LEFT"
      ? `${repository}/compare/${location.base}...${location.head}#diff-${anchor}L${finding.line}`
      : `${repository}/blob/${location.head}/${sourcePath}#L${finding.line}`
    : undefined;
  const code = link
    ? `[View code](${link})`
    : `\`${position}\` (${finding.side})`;
  return renderDetails(
    `${marker} ${clean(finding.title)} · ${position}`,
    `${code}\n\n${clean(finding.body)}\n\n**Why this was flagged**\n\n${clean(finding.explanation)}\n\n**Verification:** ${clean(finding.verification)}\n\n<sub>Finding ID: \`f-${findingId(finding)}\`</sub>\n\n<!-- codex-action:finding:${findingId(finding)} -->`,
  );
}

/** Only publisher-owned footer metadata determines whether a head was reviewed. */
export function reviewHead(body: string): string | undefined {
  return body.match(
    /<!-- codex-action:review:([a-f0-9]{40}) -->(?:\s*<!-- codex-action:grouped-review -->)?\s*$/,
  )?.[1];
}

/** One inline discussion holds every severity, with links to each finding's location. */
export function renderFindings(
  review: Review,
  head: string,
  location?: ReviewLocation,
): string {
  return `**Findings (${review.findings.length})**\n\nAll findings are grouped in this discussion. Each section links to its code location.\n\n${review.findings.map((finding) => renderFinding(finding, location)).join("\n\n")}\n\n<!-- codex-action:grouped-findings:${head} -->`;
}

/** Preserve the native main review summary; its grouped inline discussion sits below. */
export function renderReview(
  review: Review,
  head: string,
  location?: ReviewLocation,
  includeFindings = false,
): string {
  const findings =
    includeFindings && review.findings.length
      ? `\n\n${renderFindings(review, head, location)}`
      : "";
  const coverage = renderDetails(
    "What was reviewed",
    review.reviewed.map((item) => `- [x] ${clean(item)}`).join("\n"),
  );
  const evidence = renderDetails("Review details", clean(review.reasoning));
  const revision = location
    ? ` · [\`${head.slice(0, 7)}\`](${GITHUB_SERVER_URL}/${location.owner}/${location.repo}/commit/${head})`
    : "";
  const discussion =
    review.findings.length && !includeFindings
      ? `\n\n${review.findings.length} finding${review.findings.length === 1 ? "" : "s"} grouped in one inline discussion below.`
      : "";
  const fallback =
    includeFindings && review.findings.length
      ? "\n\nThis diff has no inline-commentable text line; the findings are included in this review."
      : "";
  return `**Codex review**${revision}\n\n${clean(review.summary)}${discussion}${fallback}${findings}\n\n${coverage}\n\n${evidence}\n\n<!-- codex-action:review:${head} -->\n${GROUPED_REVIEW_MARKER}`;
}
