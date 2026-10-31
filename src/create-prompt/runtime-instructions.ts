/** Wording for action-owned instructions, never user content. */
export function getRuntimeInstructions() {
  return {
    name: "Codex",
    product: "Codex",
    repoInstructions: "AGENTS.md",
    productUrl: "https://developers.openai.com/codex",
    helpLabel: "Codex documentation",
    helpUrl: "https://developers.openai.com/codex",
    readFiles: "Use the available file tools",
    viewImages: "Use the available image-viewing tool",
    shell: "shell tool",
    command: (command: string) => `\`${command}\``,
    commentTool:
      "IMPORTANT: Use the mcp__github_comment__update_codex_comment tool to update your comment.",
    progressComment: `Use GitHub-native formatting for progress: a task-specific checklist, plus a short current-step label in a <details open><summary>...</summary>...</details> section. Put observed results, relevant files and verification evidence inside expandable sections. Collapse completed step details and mark checkboxes complete only after doing the work. Replace the initial generic checklist with the actual tasks. Update the same comment at meaningful milestones, not on a timer. GitHub controls when open pages show edits; do not promise immediate live refresh. Do not use HTML progress bars, scripts, custom styles, fabricated percentages, or private chain-of-thought. Finish with concise results and actual completed steps, and remove loading indicators.`,
  };
}
