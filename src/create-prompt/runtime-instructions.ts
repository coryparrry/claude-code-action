/** Runtime-specific wording for action-owned instructions, never user content. */
export function getRuntimeInstructions() {
  const codex = process.env.ACTION_ENGINE === "codex";
  return {
    codex,
    name: codex ? "Codex" : "Claude",
    product: codex ? "Codex" : "Claude Code",
    repoInstructions: codex ? "AGENTS.md" : "CLAUDE.md",
    productUrl: codex
      ? "https://developers.openai.com/codex"
      : "https://claude.ai/code",
    helpLabel: codex ? "Codex documentation" : "FAQ",
    helpUrl: codex
      ? "https://developers.openai.com/codex"
      : "https://github.com/anthropics/claude-code-action/blob/main/docs/faq.md",
    readFiles: codex ? "Use the available file tools" : "Use the Read tool",
    viewImages: codex
      ? "Use the available image-viewing tool"
      : "Use Read tool",
    shell: codex ? "shell tool" : "Bash tool",
    command: (command: string) =>
      codex ? `\`${command}\`` : `Bash(${command})`,
    commentTool: codex
      ? "IMPORTANT: Use the mcp__github_comment__update_claude_comment tool to update your comment."
      : "IMPORTANT: Use the mcp__github_comment__update_claude_comment tool to update your comment (load it with ToolSearch first).",
  };
}
