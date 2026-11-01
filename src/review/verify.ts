import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runCodex,
  type CodexOptions,
  type CodexRunResult,
} from "../../base-action/src/run-codex";
import { resolveCompatibility } from "../../base-action/src/codex-compat";
import { nativeReviewOptions } from "./runtime";
import { reviewSchema } from "./schema";
import {
  applyVerification,
  verificationJsonSchema,
  verificationPrompt,
} from "./verification";
import type { RememberedFinding } from "./memory";

/** Normalize action-wide limits once using the runtime's existing strict argument validation. */
async function limits(options: Partial<CodexOptions>) {
  return resolveCompatibility("", "", '{"mcpServers":{}}', [], {
    maxTurns: options.maxTurns,
    maxBudgetUsd: options.maxBudgetUsd,
  });
}

/** Reserve one third of configured review turns/cost for the independent verification phase. */
export async function candidateLimits(
  options: Partial<CodexOptions>,
): Promise<Partial<CodexOptions>> {
  const total = await limits(options);
  if (total.maxTurns !== undefined && total.maxTurns < 2)
    throw new Error(
      "Native review needs at least two total turns for review and verification",
    );
  return {
    ...(total.maxTurns !== undefined && {
      maxTurns: Math.max(1, Math.floor((total.maxTurns * 2) / 3)),
    }),
    ...(total.maxBudgetUsd !== undefined && {
      maxBudgetUsd: (total.maxBudgetUsd * 2) / 3,
    }),
  };
}

/** Run a fresh, read-only verifier within the remaining shared limits; failures never publish candidates. */
export async function verifyReviewCandidates(
  candidate: CodexRunResult,
  options: Partial<CodexOptions>,
  head: string,
  memory: RememberedFinding[],
  runner: typeof runCodex = runCodex,
) {
  const review = reviewSchema.parse(candidate.structuredOutput);
  const total = await limits(options);
  let maxTurns: number | undefined;
  let maxBudgetUsd: number | undefined;
  if (total.maxTurns !== undefined) {
    if (!Number.isSafeInteger(candidate.numTurns) || candidate.numTurns! < 0)
      throw new Error(
        "Reviewer turn usage is unavailable; cannot enforce the shared limit",
      );
    maxTurns = total.maxTurns - candidate.numTurns!;
    if (maxTurns < 1)
      throw new Error("No review turns remain for independent verification");
  }
  if (total.maxBudgetUsd !== undefined) {
    if (
      candidate.costUsd === undefined ||
      !Number.isFinite(candidate.costUsd) ||
      candidate.costUsd < 0
    )
      throw new Error(
        "Reviewer cost is unavailable; cannot enforce the shared budget",
      );
    maxBudgetUsd = total.maxBudgetUsd - candidate.costUsd;
    if (maxBudgetUsd <= 0)
      throw new Error("No review budget remains for independent verification");
  }
  const prompt = join(
    process.env.RUNNER_TEMP || tmpdir(),
    `codex-review-verifier-${crypto.randomUUID()}.txt`,
  );
  await writeFile(prompt, verificationPrompt(review, head, memory), {
    mode: 0o600,
  });
  const verified = await runner(prompt, {
    ...(await nativeReviewOptions("", options, verificationJsonSchema)),
    mcpConfig: '{"mcpServers":{}}',
    maxTurns,
    maxBudgetUsd,
    executionFileName: "codex-review-verifier-output.json",
  });
  if (verified.conclusion !== "success")
    throw new Error(
      "Independent review verification failed; no findings will be published",
    );
  return {
    ...applyVerification(
      review,
      verified.structuredOutput,
      head,
      memory,
      verified.readEvidence ?? [],
    ),
    executionFile: verified.executionFile,
  };
}
