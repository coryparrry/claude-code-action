import { createHash } from "node:crypto";
import { z } from "zod";
import { redactSecrets, sanitizeContent } from "../github/utils/sanitizer";
import { GITHUB_SERVER_URL } from "../github/api/config";
import {
  renderReviewHeading,
  renderRiskDetails,
  renderScopeDetails,
} from "./visuals";
import {
  escapeHtml,
  renderDetails,
} from "../github/operations/comments/render";

export const INLINE_REVIEW_MARKER = "<!-- codex-action:inline-review -->";
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
  summary: text.describe(
    "Review outcome only: one plain-text sentence, aiming for at most 15 words; do not repeat patch changes or list findings",
  ),
  walkthrough: text.describe(
    "Main behavior change in one plain-text sentence, aiming for at most 35 words; omit implementation detail and the review outcome",
  ),
  changes: z
    .array(
      z.strictObject({
        area: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .describe("A 2–4 word area label"),
        description: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .describe(
            "One direct sentence, aiming for at most 18 words; describe the behavior without repeating the walkthrough",
          ),
        files: z.array(z.string().trim().min(1).max(500)).max(100),
      }),
    )
    .min(1)
    .max(8)
    .describe(
      "Use 2–4 groups for a broad patch or one for a small patch; up to three representative file paths per group",
    ),
  risk: z.strictObject({
    level: z.enum(["low", "moderate", "high"]),
    explanation: text.describe(
      "Evidence for this inspection-based merge-risk assessment; never claim CI passed or tests ran",
    ),
  }),
  flow: z
    .union([
      z.strictObject({
        steps: z.array(z.string().trim().min(1).max(120)).min(2).max(8),
      }),
      z.null(),
    ])
    .describe(
      "A short real sequential flow when it helps explain the change; null for trivial or non-sequential changes",
    ),
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
            "Use a commentable line in the prepared patch: RIGHT for added/context lines, LEFT for removed/context lines",
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

/** One coloured inline comment per finding, with expandable supporting evidence. */
export function renderFinding(
  finding: Finding,
  location?: ReviewLocation,
  confidence?: "high",
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
  return `${marker} **${escapeHtml(clean(finding.title))}**\n\n${clean(finding.body)}${confidence ? "\n\n<sub>Confidence: high · independent static inspection</sub>" : ""}\n\n${code}\n\n${renderDetails("Why this was flagged", `${clean(finding.explanation)}\n\n**Verification:** ${clean(finding.verification)}`)}\n\n<sub>Finding ID: \`f-${findingId(finding)}\`</sub>\n\n<!-- codex-action:finding:${findingId(finding)} -->`;
}

/** Only publisher-owned footer metadata determines whether a head was reviewed. */
export function reviewHead(
  body: string | null | undefined,
): string | undefined {
  return body?.match(
    /<!-- codex-action:review:([a-f0-9]{40}) -->(?:\s*<!-- codex-action:(?:grouped|inline)-review -->)?\s*$/,
  )?.[1];
}

/** Render a small data-only diagram; model output never supplies Mermaid syntax. */
function renderFlow(steps: string[]): string {
  const labels = steps.map((step) =>
    clean(step)
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N} /_.:()-]/gu, "")
      .trim(),
  );
  if (labels.some((label) => !label)) return "";
  const nodes = labels.map((label, index) => `  N${index}["${label}"]`);
  const edges = labels
    .slice(1)
    .map((_, index) => `  N${index} --> N${index + 1}`);
  return `${renderReviewHeading("flow")}\n\n\`\`\`mermaid\nflowchart LR\n${[...nodes, ...edges].join("\n")}\n\`\`\``;
}

/** A walkthrough-led summary keeps issue details in their individual inline comments. */
export function renderReview(
  review: Review,
  head: string,
  location?: ReviewLocation,
  verified = false,
): string {
  const html = (value: string) =>
    escapeHtml(clean(value)).replace(/\r?\n/g, "<br>");
  const changes = review.changes
    .map((change) => {
      const visibleFiles = change.files.slice(0, 3);
      const remainingFiles = change.files.slice(3);
      const files = visibleFiles.length
        ? `<br><sub>${visibleFiles.map((file) => `<code>${html(file)}</code>`).join(" · ")}</sub>`
        : "";
      const more = remainingFiles.length
        ? renderDetails(
            `${remainingFiles.length} more files`,
            remainingFiles
              .map((file) => `<code>${html(file)}</code>`)
              .join("<br>"),
          )
        : "";
      return `<li><strong>${html(change.area)}</strong>: ${html(change.description)}${files}${more}</li>`;
    })
    .join("\n");
  const walkthrough = `${renderReviewHeading("walkthrough")}\n<p>${html(review.walkthrough)}</p>\n\n<p><strong>Review outcome:</strong> ${html(review.summary)}</p>`;
  const changeSummary = `${renderReviewHeading("changes")}\n<ul>\n${changes}\n</ul>`;
  const flow = review.flow ? renderFlow(review.flow.steps) : "";
  const risk = renderRiskDetails(
    review.risk.level,
    `${html(review.risk.explanation)}\n\n<sub>Assessment from code inspection; this is not a CI result or merge approval.</sub>`,
  );
  const scope = review.reviewed
    .map((item) => `<li>${html(item)}</li>`)
    .join("\n");
  const details = renderScopeDetails(
    `<strong>What was reviewed</strong>\n<ul>\n${scope}\n</ul>\n\n<strong>Verification</strong>\n<p>This review uses read/search tools and does not execute tests.</p>\n<p>${html(review.reasoning)}</p>`,
  );
  const revision = location
    ? `<a href="${escapeHtml(`${GITHUB_SERVER_URL}/${location.owner}/${location.repo}/commit/${head}`)}"><code>${escapeHtml(head.slice(0, 7))}</code></a>`
    : `<code>${escapeHtml(head.slice(0, 7))}</code>`;
  const footer = `<p><sub>Reviewed commit ${revision}</sub></p>`;
  return `${[walkthrough, changeSummary, flow, risk, details, footer].filter(Boolean).join("\n\n")}${verified ? "\n\n<!-- codex-action:verified-review:v1 -->" : ""}\n\n<!-- codex-action:review:${head} -->\n${INLINE_REVIEW_MARKER}`;
}
