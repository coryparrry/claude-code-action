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
  };
}
