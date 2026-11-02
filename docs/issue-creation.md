# Opening GitHub issues

Ask `/codex Open an issue about ...` in a trusted comment or new-issue request.
The action opens it in that same repository and returns the confirmed URL in the
tracking comment. Supply a title, description and existing label names if needed.
The job needs `issues: write`, and the repository's Issues feature must be enabled.
Generated command workflows already request that permission.

## Scope and opt-in

Automatic PR reviews do not receive issue creation. Read-only/plan policy blocks
it even with an explicit grant. Prompt-driven tasks, automatic tracking reviews,
label/assignment automation and agent mode must explicitly opt in, for example:

```yaml
codex_args: --allowedTools mcp__github_issues__create_issue
```

Explicit `settings.permissions.allow` grants in JSON or settings files also install the tool. Scoped rules remain scoped and do not become unrestricted grants. Deleted comments and requests whose author differs from the checked actor cannot install the tool.

Runtime-compatible namespace and wildcard grants, including
`mcp__github_issues__*`, also work. The tool takes title, body and optional labels;
the model cannot select an owner or repository. It uses the action-owned token
and existing dependencies, with no Docker requirement.

Issue bodies retain literal Markdown, accessible image descriptions, HTML
attributes and fenced reproductions. Secret-format redaction and the runtime's registered-credential redactor apply before publication, after any hook changes.
Ordinary reviews do not turn findings into backlog issues automatically.

## Delivery and retries

Confirmed creations are recorded outside the model's workspace. The JSON-array
`created_issue_urls` action output and the tracking comment retain those URLs when
the agent subsequently errors or exhausts its turn/time limit. Agent failure still
remains a failure; a created issue does not imply the rest of a task succeeded.

Identical concurrent/repeated calls within one MCP server process share their
first result. Potentially completed issue POSTs are never automatically retried.
Server-local deduplication does not span workflow runs or independent subagent
servers. Inspect GitHub before retrying an uncertain request.

## GitHub qualification

The installed implementation pin is `a6b7ec0bdd4ed98520d40c727bb9be85946f6e0b`.

- [Implementation CI](https://github.com/coryparrry/claude-code-action/actions/runs/41368047400) and [driver CI](https://github.com/coryparrry/claude-code-action/actions/runs/41368603697) passed: **1,598 tests, zero failures, 5,962 assertions across 118 files**. Both typechecks, formatting, isolated production execution and all composite boundaries passed.
- [Exact-pin live qualification](https://github.com/coryparrry/claude-code-action/actions/runs/41368603724) made two identical calls and created one [issue #30](https://github.com/coryparrry/claude-code-action/issues/30), reused its confirmed URL and preserved the PR head.
- The same run deliberately exhausted a one-turn agent after creating [issue #31](https://github.com/coryparrry/claude-code-action/issues/31). Its URL survived in action outputs and failure tracking. The action failure was expected; all subsequent assertions passed.
- A real issues-read token was rejected and created no issue. Both fixtures were closed.
- Hosted regressions cover scope, validation, literal bodies, duplicate calls, uncertain POSTs, failed tracking finalization, cleanup, wildcard grants, scoped grants from every supported explicit input, JSON/settings-file installation, and deleted/author-mismatched comments.
- An actual runtime-to-MCP-to-REST fixture verifies that an opaque registered Azure credential is removed from title, body and labels before publication. Hook-replaced arguments are also redacted. This uses synthetic credentials on GitHub, not a live Azure account.
- New named-symbol documentation coverage is **21/22 (95.5%)**, exceeding 85%. Repository-wide coverage was not audited. No tests ran locally.

Qualification has `contents: read`, excludes Git/edit tools and explicitly denies mutations. Verification uses direct receipt IDs. Normal creation checks the exact requested body and identical tool inputs; the failure case checks its nonce/title and compares the stored body with the actual submitted input. Both require confirmed URLs in outputs/tracking and an unchanged PR head.

The two native reviews identified ten findings; all have fixes covered by hosted rechecks. Focused independent review checked the final trust, permission, publication and harness changes. Paid reruns require the trusted actor, isolated branch and `test-issue-creation` label; the label was removed after qualification.

The [machine-readable evidence](./issue-creation-evidence.json) records exact source identities. No release or main-branch merge is performed by qualification.
