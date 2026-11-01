import { createHash } from "node:crypto";
import type { ModelSettings } from "@openai/agents";

/** Keep cache accounting stable across commits/reruns without exposing repository paths or paying for longer retention. */
export function promptCacheSettings(
  repository: string,
  phase: string,
): ModelSettings {
  const key = createHash("sha256")
    .update(JSON.stringify([repository, phase]))
    .digest("hex")
    .slice(0, 32);
  return {
    providerData: { prompt_cache_key: `codex-action:v1:${key}` },
  };
}
