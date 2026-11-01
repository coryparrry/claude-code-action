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
Fixture issues are closed after verification.

GitHub qualification passed on 1 November 2026:

- [Full CI](https://github.com/coryparrry/claude-code-action/actions/runs/41358060261): 1,575 tests passed, zero failures, 5,884 assertions across 117 files; root/base typechecks, formatting, production-package checks and composite boundaries passed.
- [Live command action and permission check](https://github.com/coryparrry/claude-code-action/actions/runs/41358060324): two identical tool calls produced one actual [fixture issue #20](https://github.com/coryparrry/claude-code-action/issues/20), the same confirmed URL reached the tracking comment, and the PR head was unchanged. Cleanup closed the issue.
- A real `issues: read` token was rejected and created no issue. Regression fixtures also covered disabled Issues, invalid payloads, repository scope, concurrent calls and uncertain API failures.
- New named-symbol documentation coverage was **10/11 (90.9%)**, above the 85% requirement. No tests ran locally.

The tested implementation is `8124d92dee8a03455fb16b024b430bc9f9135c63`; the installer, managed workflows and quickstart pin that revision. The live harness's subsequent MCP-envelope parser correction did not change production code. Separate workflow runs have separate deduplication scope.
