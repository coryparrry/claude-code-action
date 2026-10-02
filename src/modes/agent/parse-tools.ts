import { parse as parseShellArgs } from "shell-quote";

// Flags whose values make up the allowed-tools list.
// Include both camelCase and hyphenated variants for CLI compatibility.
const ALLOWED_TOOLS_FLAGS = new Set(["allowedTools", "allowed-tools"]);

/**
 * Strip comment lines from a shell argument string.
 * Lines whose first non-whitespace character is `#` are removed entirely.
 * Mirrors the compatibility tokenizer in base-action/src/codex-compat.ts.
 */
function stripShellComments(input: string): string {
  return input
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/**
 * Tokenize compatibility tool arguments: strip full comment lines, then run
 * shell-quote. shell-quote returns
 * unquoted glob patterns (e.g. `mcp__github__*`) as `{ op: "glob", pattern }`
 * objects rather than strings, so recover their literal text; drop operator
 * tokens (`|`, `>`, `;`, ...) which carry no value.
 */
function tokenize(claudeArgs: string): string[] {
  return parseShellArgs(stripShellComments(claudeArgs))
    .map((token) => {
      if (typeof token === "string") return token;
      if (token && typeof token === "object" && "pattern" in token) {
        return (token as { pattern: string }).pattern;
      }
      return null;
    })
    .filter((token): token is string => token !== null);
}

/**
 * Parse the allowed tools from codex_args or its claude_args compatibility alias.
 *
 * This is used to decide which GitHub MCP servers to install. It MUST stay in
 * agreement with the compatibility argument adapter: otherwise a tool can be
 * granted without its MCP server being installed, or a server can be installed
 * for a tool that was never granted (#1357).
 *
 * To stay in agreement it uses the same shell-quote tokenizer and the same
 * "an accumulating flag consumes all consecutive non-flag values" semantics,
 * so `--allowedTools "Read" "Grep" "mcp__github__get_commit"` captures all
 * three values, and commented-out lines are ignored.
 */
export function parseAllowedTools(
  claudeArgs: string,
  directAllowedTools: string = "",
): string[] {
  const args = tokenize(claudeArgs);
  const tools: string[] = [];
  const seen = new Set<string>();

  // Mirror the runtime's delimiter rules without splitting scoped arguments.
  const appendTools = (value: string) => {
    let rule = "";
    let depth = 0;
    const appendRule = () => {
      const trimmed = rule.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        tools.push(trimmed);
      }
      rule = "";
    };
    for (const character of value) {
      if (character === "(") depth++;
      else if (character === ")") depth = Math.max(0, depth - 1);
      if (depth === 0 && /[\s,]/.test(character)) appendRule();
      else rule += character;
    }
    appendRule();
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith("--")) continue;
    const separator = arg.indexOf("=");
    const flag = arg.slice(2, separator < 0 ? undefined : separator);
    if (!ALLOWED_TOOLS_FLAGS.has(flag)) continue;
    if (separator >= 0) {
      appendTools(arg.slice(separator + 1));
      continue;
    }
    // Space-separated flags accumulate consecutive non-flag arguments;
    // equals-form flags consume only their own value, as the runtime does.
    while (i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
      appendTools(args[++i]!);
    }
  }
  appendTools(directAllowedTools);
  return tools;
}
