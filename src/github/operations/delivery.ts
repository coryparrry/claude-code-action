import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokits } from "../api/client";
import { retryGitHubRead } from "../api/retry";

/** Allocate a fresh receipt outside the model's repository file boundary. */
export function initializeDeliveryReceipt(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = join(
    mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "codex-git-delivery-")),
    "receipt.json",
  );
  writeFileSync(path, "", { mode: 0o600 });
  return path;
}

/** Record only a successful trusted Git push or GitHub API reference update. */
export function recordDelivery(
  sha: string,
  branch: string,
  path = process.env.CODEX_GIT_DELIVERY_RECEIPT,
): void {
  if (!path) return;
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid pushed commit SHA");
  writeFileSync(path, JSON.stringify({ sha, branch }), { mode: 0o600 });
}

/** Emit only this invocation's pushed commit when GitHub still confirms its receipt. */
export async function deliveredHead(
  octokit: Octokits,
  owner: string,
  repo: string,
  branch: string,
  path = process.env.CODEX_GIT_DELIVERY_RECEIPT,
): Promise<string> {
  if (!path) return "";
  let receipt: { sha?: string; branch?: string };
  try {
    receipt = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return "";
  }
  if (receipt.branch !== branch || !/^[a-f0-9]{40}$/.test(receipt.sha || ""))
    return "";
  try {
    const { data } = await retryGitHubRead(() =>
      octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` }),
    );
    return data.object.sha === receipt.sha ? receipt.sha! : "";
  } catch (error) {
    if ((error as { status?: number }).status === 404) return "";
    throw error;
  }
}
