# Codex port worklog

## Outcome

Adapt the MIT-licensed Claude Code Action in its own fork to use Codex and an
existing OpenAI API key, preserving GitHub issue/PR automation and rejecting fork
PRs. Keep the Intents checkout untouched until the adapted action is verified.

## Acceptance

- Codex is the only engine; no Claude runtime, SDK, credentials, or provider backend remains.
- Mention tasks and automated prompts retain GitHub context, comments, branches,
  signing, cleanup, and execution status.
- Fork PRs are rejected before preparation for direct, comment, review, and
  workflow-run triggers. Incomplete source identity fails closed.
- The actual request sidecar is consumed. MCP servers work through isolated Codex
  configuration. Unsupported Claude options fail clearly.
- API credentials are masked and excluded from tool subprocess environments and
  saved execution reports. PR-authored Codex config/instructions are restored
  from the trusted base before execution.
- Preserve the upstream MIT notices and document how to use the fork.
- Run adapter integration/regression tests, relevant upstream suites, typecheck,
  formatting, and diff checks. Review the stable diff independently.

## Progress

- Created `coryparrry/claude-code-action`; isolated branch `codex/openai-runtime`.
- Inspected upstream preparation, MCP, runner, reporting, and cleanup contracts.
- Installed temporary Bun and the fork's locked dependencies.
- No OpenAI key is present in this environment or Intents Actions secrets.
  Live API execution remains unverified pending the user's existing key.

## Completed verification

- `bun test`: 1,033 passed, 0 failed (2,434 assertions).
- `bun test base-action/test/run-codex.test.ts`: 21 passed, 0 failed
  (80 assertions), using fake CLI processes and test credentials.
- `bun run typecheck`: passed.
- `bun run format:check`: passed.
- Installed the pinned public Codex CLI `0.159.2`; `codex mcp list --json`
  accepted the adapter's isolated configuration and MCP registration without
  invoking a model or MCP server. Strict configuration mode is unsupported for
  this MCP-list command; the check establishes parsing, not full execution.
- Independent GitHub integration and runner reviews completed. Fixed workflow
  token revocation, Codex sticky-comment reuse, timing-test readiness, and the
  stderr-redaction test's unreachable diagnostic. Recheck passed.
- Buffered-comment postprocessing skips fork/unresolved executions and only
  supplies Anthropic classification credentials for the explicit Claude engine.
- The user chose offline verification. Live OpenAI and GitHub task execution
  remain unverified; the adapted action is prepared for review in its own fork.

## Fork CI reconciliation

The inherited CI pinned Bun 1.2.12, whose TOML parser decoded an escaped tab as
form feed in the new round-trip regression. Local tests passed under Bun 1.4.2;
the action and CI now pin that same runtime. The full 1,033-case suite already
includes the adapter tests; the separate 21-case command is an additional
focused run, not an additional set of unique cases.

Inherited live-Claude tests, review/triage bots, and upstream artifact publishing
workflows are preserved under `examples/upstream-workflows` so they no longer
execute in this fork. Fork CI retains offline tests, formatting, type checking,
and workflow security checks. In-flight inherited live-test runs were cancelled.

## Codex-only follow-up

User requested removal of Claude compatibility. Removing Claude runners/SDK,
provider authentication/settings/plugins, App token exchange, classifier calls,
legacy examples, and obsolete provider-specific CI. GitHub tools now derive from
task context rather than Claude argument parsing. Queued inline comments require
no model classifier. Historical verification above predates this follow-up;
updated checks will be recorded after integration. Offline-only preference remains.

### Follow-up verification

- `bun test`: 834 passed, 0 failed, 2,044 assertions; process exited 0.
  Removed suites exclusively covered deleted Claude functionality.
- `bun run typecheck`: passed.
- `bun run format:check` and `git diff --check`: passed.
- Fresh frozen-lock production installs passed for root (132 packages) and base
  (7 packages), with no Anthropic SDK or OpenAI Agents SDK installed.
- Two independent scoped reviews completed. Added the missing standalone base
  Bun config and its regression; removed a redundant explicit exit-code write
  that contaminated Bun's in-process negative tests (Actions core still marks
  real executions failed).
- Fork rejection, actual entity/workflow-run actor write checks, trusted Codex
  configuration restoration, credential redaction, and fake-CLI process
  timeout/cancellation contracts remain covered.
- No live model calls, credentials, or target-repository installation performed.
