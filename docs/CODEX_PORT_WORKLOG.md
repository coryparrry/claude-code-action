# Codex action port worklog

## Goal and scope

Port the MIT-licensed Claude Code Action in `coryparrry/claude-code-action`
to an OpenAI Codex model, preserving headless GitHub automation and the
original action controls. Reject fork PRs before preparation. Leave Intents
untouched. The selected backend is the OpenAI Agents SDK; verification is
offline, with no paid model calls, merge or target installation.

## Implementation

- Branch `codex/openai-runtime`, existing draft PR #1.
- `@openai/agents` 0.18.0 and the Responses API run `gpt-5.3-codex` by default.
  No Claude SDK, Claude CLI, Anthropic provider or native Codex CLI dependency.
- The original GitHub preparation, modes, comments, file operations, actor
  controls, branch/signing behavior, reports and inline classifier remain.
  Tag-mode permission rules are forwarded without granting unrestricted Bash.
- The adapter supplies coding tools, scoped allow/deny/ask permissions, MCP
  transports, settings, hooks, plugins, commands, skills, nested/background
  tasks, workflows, LSP, sessions, compaction, schema output and fallback.
- Main model-turn limits stay separate from subagent limits. Dollar estimates
  share one budget across all model calls, including compaction and hosted
  search. Custom/fallback token rates can be supplied in `settings.modelPrices`.
- Provider authentication uses an OpenAI API key. Original configuration names
  remain compatible inputs; Anthropic provider authentication is historical.
- Baseline audited: upstream `12dd8d74`, Claude CLI 2.1.286 and Agent SDK
  `^0.3.286`. Earlier broad deletion was rejected: controls and integrations
  must be exercised through the replacement SDK before declaring completion.

## Verification

- `bun test`: 1,140 passed, 0 failed, 3,478 assertions across 74 files.
- Root and base-action `bun run typecheck`: passed.
- Root `bun run format:check` and `git diff --check`: passed.
- Fresh root/base `bun install --production --frozen-lockfile --ignore-scripts`:
  passed (156/116 packages); real SDK imports passed; no Claude, Anthropic or
  native Codex runtime packages installed.
- Fixtures exercise the real SDK Runner/tool loop and Responses transport,
  local HTTP/stdio MCP, plugins/hooks/workflows, shared limits, failure reports,
  sessions, compaction and the isolated inline classifier without paid calls.
- Independent GitHub, runtime and sandbox reviews have no open material
  findings. Regressions cover budget cancellation before another request,
  isolated subagent permissions/deadlines/instructions, Stop-hook continuations,
  first-request context recovery and VM-local workflow errors.
- Live paid OpenAI/GitHub completion and an actual Windows runner remain
  unverified. The draft PR is the delivery artifact; merging is out of scope.

## Credential scan

Commit `0574bb0` introduced no new PAT-shaped strings compared with upstream;
all matches were inherited sanitizer examples/tests. A silent exact-value scan
found no signed-in GitHub credential in any blob of that commit. Published port
commits also introduce no new distinct PAT patterns. GitGuardian's precise
flagged line is unavailable, so this is evidence of inherited fixtures rather
than a definitive classification of its alert. No credential values were
printed and no history rewrite or credential revocation was performed.
