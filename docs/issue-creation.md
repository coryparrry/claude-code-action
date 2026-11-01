# Opening GitHub issues

Ask `/codex Open an issue about ...` in a trusted issue or PR request. The action
can create the issue in that same repository and returns its actual URL in the
tracking comment. Supply a title, description and existing label names if needed.

The command job needs `issues: write`, and the repository's Issues feature must be
enabled. Generated command workflows already request that permission. Automatic
reviews and read-only/plan runs cannot create issues. Creation is reserved for an
explicit request; ordinary reviews do not turn findings into backlog issues.

Agent-mode workflows opt in by allowing `mcp__github_issues__create_issue` through
`codex_args: --allowedTools mcp__github_issues__create_issue`. The tool takes title,
body and optional labels, with no model-selected owner or repository. It uses the
action's repository-scoped token and does not need Docker or a separate MCP service.

Identical calls within one MCP server process share the same result, including
concurrent calls. The action never retries a potentially completed issue POST.
For uncertain failures, inspect GitHub before another request. Deduplication does
not persist across separate workflow runs; do not rerun a creation request blindly.

## Verification

Regression and real stdio/API tests cover scope, input validation, sanitization,
duplicate calls, ambiguous failures, permissions, disabled Issues and read-only
policy. The GitHub live workflow requires the `test-issue-creation` label, the
trusted actor and the isolated `codex/issue-creation` branch. It checks actual issue
creation through the command action, a repeated tool call returning the same URL,
tracking-comment delivery, an unchanged PR head and rejection by a read-only token.
Fixture issues are closed after verification. Hosted results are pending.
