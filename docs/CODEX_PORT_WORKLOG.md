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

- `bun test`: 1,144 passed, 0 failed, 3,496 assertions across 75 files.
- Root and base-action `bun run typecheck`: passed.
- Root `bun run format:check` and `git diff --check`: passed.
- Fresh root/base `bun install --production --frozen-lockfile --ignore-scripts`:
  passed (165/116 packages); real SDK imports passed; no Claude, Anthropic or
  native Codex runtime packages installed.
- Fixtures exercise the real SDK Runner/tool loop and Responses transport,
  local HTTP/stdio MCP, plugins/hooks/workflows, shared limits, failure reports,
  sessions, compaction and the isolated inline classifier without paid calls.
- Independent GitHub, runtime and sandbox reviews have no open material
  findings. Regressions cover budget cancellation before another request,
  isolated subagent permissions/deadlines/instructions, Stop-hook continuations,
  first-request context recovery and VM-local workflow errors.
- Linux CI first exposed an MCP/Zod schema mismatch, a Mac-only hook fixture
  path and filesystem-dependent ordering. Root/base MCP now both pin 1.31.0;
  hook fixtures use the system temporary directory; file listings are stable.
  All four production GitHub MCP servers now have real stdio schema regressions.
  Prevention: validate production protocols against the locked dependency graph,
  rather than relying on a different local base-action installation.
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

## GitHub Action review — 2026-10-02

Scope: the root/base GitHub Actions, excluding the standalone installer CLI.
Compared current upstream `97c53473391bff1901034d4b454b5bac7ab7a029` with
local baseline `e582297`. All 28 shared non-vendor action inputs and six
upstream outputs are present; the detailed comparison and remaining differences
are in [feature-parity.md](./feature-parity.md).

Changes cover exact custom Bun executables and paths with spaces; the current
SDK's Node 22 requirement; preserved user tool policies; SSH-signing precedence;
GitHub Enterprise links; sticky-comment pagination/fallback; per-run inline
buffers and retry-safe delivery; scoped agent tools, permissions and shell job
limits; optional/open JSON schemas; MCP images/PDFs with bounded diagnostics;
WIF token expiry; and AWS SigV4 credentials from a caller's OIDC login step.

CI now freezes dependency resolution, checks both TypeScript projects and
verifies isolated production installations plus a real offline SDK turn for
each action. Primary setup docs describe direct Actions workflows and current
OpenAI provider contracts.

Independent review additionally caught a parent permission grant overriding a
scoped agent rule and mutation of a signed AWS compaction body after a model
switch. Both are covered by offline regression checks. Review also caught preparation
helpers terminating the process before App-token cleanup and two tool-option
parsing cases; these are included in the corrected orchestration contracts.

No live model/cloud account, hosted workflow, release tag or consumer installation
is claimed by this local audit. Existing example commit pins need updating when
the reviewed source is published.

### Final verification for this audit

- `bun --no-env-file test --timeout 30000`: **1,326 passed, 0 failed**,
  4,530 assertions across 91 files. A temporary PATH entry made the selected Bun
  executable available to existing child-process fixtures. Local HTTP fixtures
  required permission to bind loopback sockets outside the sandbox.
- `node node_modules/typescript/bin/tsc --noEmit`: passed.
- `node node_modules/typescript/bin/tsc --noEmit -p base-action/tsconfig.json`: passed.
- `prettier --check .` and `git diff --check`: passed.
- `BUN_EXECUTABLE=<bun-1.4.2> node scripts/verify-action-package.mjs`: passed.
  Frozen production installs completed independently for root (231 packages) and
  base (182 packages); both ran the real Agents SDK with an offline model.
- Independent packaging, provider, runtime and GitHub orchestration reviewers
  checked separate scopes. Material findings were fixed and covered by regression
  tests; no paid API or real GitHub write was needed for these checks.
