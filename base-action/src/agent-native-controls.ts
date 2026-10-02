import type { ModelSettings, Tool } from "@openai/agents";

/** Translate native controls into SDK settings and the tools actually exposed. */
export function nativeModelSettings(
  settings: Record<string, unknown>,
): ModelSettings {
  const summary = settings.model_reasoning_summary;
  const verbosity = settings.model_verbosity;
  return {
    ...(typeof verbosity === "string"
      ? { verbosity: verbosity as "low" | "medium" | "high" }
      : {}),
    ...(typeof summary === "string"
      ? {
          reasoning: {
            summary:
              summary === "none"
                ? null
                : (summary as "auto" | "concise" | "detailed"),
          },
        }
      : {}),
  };
}

export function filterNativeTools(
  tools: Tool[],
  settings: Record<string, unknown>,
): Tool[] {
  const features = settings.features as Record<string, unknown> | undefined;
  const disabled = new Set<string>();
  if (features?.shell_tool === false || features?.unified_exec === false)
    ["Bash", "BashOutput", "KillShell"].forEach((name) => disabled.add(name));
  if (features?.apply_patch_freeform === false) disabled.add("Edit");
  if (settings.web_search === "disabled") disabled.add("WebSearch");
  return tools.filter((tool) => !disabled.has(tool.name));
}
