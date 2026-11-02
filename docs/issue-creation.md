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

Runtime-compatible namespace and wildcard grants, including
`mcp__github_issues__*`, also work. The tool takes title, body and optional labels;
the model cannot select an owner or repository. It uses the action-owned token
and existing dependencies, with no Docker requirement.

Issue bodies retain literal Markdown, accessible image descriptions, HTML
attributes and fenced reproductions. Secret redaction applies before publication.
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

The installed implementation pin is
`62daf7d83c5282e2344579369f72d496eb6fd923`.

- [Qualified-source CI](https://github.com/coryparrry/claude-code-action/actions/runs/41362349119) and [consumer-pin CI](https://github.com/coryparrry/claude-code-action/actions/runs/41363172107) passed: 1,580 tests, zero failures, 5,898 assertions across 117 files; both typechecks, formatting, production packages and all composite boundaries passed.
- [Exact-pin live qualification](https://github.com/coryparrry/claude-code-action/actions/runs/41363173970) called the creation tool twice and created one [fixture issue #26](https://github.com/coryparrry/claude-code-action/issues/26), reusing its confirmed URL and preserving the PR head.
- The same run deliberately failed a one-turn agent after creating [fixture issue #27](https://github.com/coryparrry/claude-code-action/issues/27). The confirmed URL survived in both action outputs and failure tracking feedback. Expected-failure action annotations are part of this case; subsequent assertions must pass.
- A real `issues: read` token was rejected and created no issue. Both created fixtures were closed.
- Hosted regressions cover automation opt-in, wildcard installation, scope, payload validation, literal body preservation, secret redaction, concurrency, uncertain POSTs, failed tracking finalization and cleanup after changed model text.
- New named-symbol documentation coverage is 16/17 (94.1%), exceeding 85%. Repository-wide coverage was not audited. No tests ran locally.

The qualification workflow itself has `contents: read`, excludes Git/edit tools
and explicitly denies mutations. Confirmed issue IDs are fetched directly for
verification and cleanup, avoiding dependence on a lagging issue-list response.
Paid reruns require `test-issue-creation`, the trusted actor and the isolated
`codex/issue-creation` branch; the label is removed after qualification.

All six initial native-review findings were fixed and covered by the hosted
rechecks. [Current PR checks](https://github.com/coryparrry/claude-code-action/pull/18/checks)
include an additional regression enforcing the qualification's Git/tool ceiling.
The [machine-readable evidence](./issue-creation-evidence.json) records the exact
source identities. No release or main-branch merge is performed by qualification.

Second-review fixes preserve settings/scoped grants, reject deleted or author-mismatched comment requests, and apply registered-credential redaction before issue subprocess transmission. Hosted requalification of these changes is pending.
