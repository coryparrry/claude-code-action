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

### PR dependency remediation

The initial PR scan identified vulnerable `fast-xml-parser` 5.2.5 through the
AWS credential dependency chain. Both action manifests now override
`@aws-sdk/xml-builder` to 3.972.24, the official adapter paired with parser 5.7.3.
A parser-only override was incompatible with the older adapter. The paired
update preserves normal AWS credential XML and numeric character references,
with regression checks for invalid numeric entities and regex entity names.

After the dependency fix, the full offline suite passed **1,330 tests**,
**4,534 assertions**, and **0 failures** across 92 files. Both TypeScript
projects and scoped formatting/diff checks passed.

Independent frozen production installs also passed with the patched dependency
graph: root installed 235 packages and base installed 186; both completed the
offline SDK smoke run.

### 2026-10-31 walkthrough-led review summaries

Reworked the summary around a walkthrough of the PR's behavior changes, grouped change descriptions and an optional visible flow diagram. Merge-risk evidence and scope/verification stay collapsed. The model returns bounded structured data; the trusted renderer escapes prose and generates diagram syntax from safe labels. Each issue remains a separate coloured inline comment, with no duplicate findings index in the summary.

Risk is explicitly a code-inspection assessment. The report states that its read/search tools do not execute tests, rather than inventing passing check counts. Shared-bot work was cancelled; the existing GitHub Actions identity and runtime remain in use.

Verification: 91 scoped tests passed, 0 failed, with 417 assertions across eight files. Root TypeScript and scoped formatting/diff checks passed. Independent read-only source review found no material issues. The existing live preview was updated in place; GitHub's Mermaid graph and collapsible risk section were visually inspected in Chrome.

### 2026-10-31 unboxed HTML summary

Replaced the summary table with the selected unboxed layout: short conclusion, coverage expanded by default, collapsed review details and a small reviewed-commit footer. Removed the metadata grid and counters. Separate coloured inline findings, safe HTML escaping and review identity markers remain intact.

Verification: 89 tests passed, 0 failed, with 398 assertions across eight scoped files. Root TypeScript, scoped Prettier and diff checks passed. The existing live review preview was updated in place and visually inspected in Chrome; it shows the conclusion, open coverage and subtle footer without a table. The actual bot workflow is selected through the updated immutable action pin.

### 2026-10-31 visible HTML review summary

The main native review now renders a publisher-owned HTML summary card with a visible conclusion and a metadata row for reviewed commit, inspected areas and inline finding count. Coverage and review details remain expandable below it. Findings remain separate coloured inline comments; the card does not list their titles or evidence. Model conclusion text is escaped before insertion into HTML.

The installation guide distinguishes automatic layout adoption from a shared branded bot. The current installer uses the workflow token. Public App installation, hosted onboarding and private-key custody remain separate work, not a capability claimed by this PR.

Verification: the scoped eight-file suite passed 88 cases; one rejected-delivery child fixture hit its 10-second timeout under extreme host load, then passed in isolation (1 test, 5 assertions). Root TypeScript, scoped Prettier and diff checks passed. Independent source review found no material issues. GitHub rendered the live preview as a table with the conclusion and all three metadata cells; individual inline comments remained separate. A screenshot capture was blocked by repeated browser-tool timeouts. Hosted verification is recorded in the PR after publication.

### 2026-10-31 individual inline findings

The owner's latest correction supersedes the grouped-discussion layout: each issue gets its own coloured inline comment at its actual code location, all submitted under one native review summary. There is no combined findings comment or severity-specific review. Finding titles and impact remain visible, with supporting evidence expandable within each issue's comment.

The publisher validates each path, line and diff side before submission, including renamed and deleted code. Invalid locations fail explicitly before any review is written, rather than moving issues to unrelated lines or publishing a combined list. Size limits apply per comment; follow-up history retains all current individual comments.

Verification: 120 scoped tests passed, 0 failed, with 607 assertions across 10 files. Root TypeScript, scoped Prettier and diff checks passed. The independent review found a shared tag-prompt delivery conflict; it was corrected, regression-tested for both prompt variants and rechecked with no remaining material findings. Hosted verification is recorded in the PR after publication.

### 2026-10-31 grouped native review discussion

The owner clarified that the native GitHub review hierarchy must stay: one main review summary and one inline discussion containing every finding. The unpublished standalone-comment prototype was replaced before publication. Findings use expandable severity sections and individual code-location links inside the group. The anchor is selected from actual PR patch lines, preferring an eligible primary finding. Non-commentable diffs retain their findings in the main review.

The existing read-only OpenAI runtime and GitHub authentication remain in use. One native COMMENT review carries the summary and grouped inline comment. Reruns reuse a completed review for the same head; each newly reviewed head retains its own native commit metadata. Current review context is preserved without truncation. Native task and failure comments retain the shared disclosure renderer.

Verification: 119 scoped tests passed, 0 failed, with 572 assertions across 10 files. Coverage includes native HTTP delivery, the actual Agents SDK with an offline model fixture, child-process root-action success/failure paths, diff anchors, full review context, comment rendering and installer behavior. Root TypeScript, scoped Prettier and diff checks passed. Independent read-only review found no material issues. Hosted verification is recorded in the PR after publication.

### 2026-10-31 native comment progress layout

The live comment test showed GitHub's checkboxes, disclosure sections and animated spinner render correctly. The HTML progress element was stripped, and open-page refresh was inconsistent. Adopted the native layout without promising immediate browser refresh: interactive tasks start with a checklist/current-step disclosure, both tag prompt variants request task-specific steps and observed evidence, and native review summaries render completed coverage checkboxes.

Finalization clears the initial loading disclosure even after checklist or whitespace edits, while preserving model-authored checked/incomplete tasks and evidence. Independent scoped review found the mutable-checklist cleanup case; it was fixed and rechecked.

Verification: 71 tests passed, 0 failed, 282 assertions across comments-common, comment-logic, codex-prompt, codex-sticky-comment, native-review and inline-comment-integration tests. Root TypeScript, scoped Prettier and diff checks passed. These checks reused the existing SDK/runtime and HTTP fixtures; no paid model call was added to the tests.

### 2026-10-31 native review presentation

The owner's reference PR (#1915 upstream) uses Anthropic's managed Code Review presentation, which is separate from the public action. Added opt-in `review_mode` with native COMMENT reviews, severity-marked line findings, expandable evidence, review scope and stable finding IDs. Existing OpenAI inference, GitHub token handling and action lifecycle remain in use. Automatic review workflow generation selects this mode; interactive tasks retain tracking comments.

Validated structured output is published in one review against the event head. Follow-up history is restricted to the configured bot; duplicate findings and same-head reruns are suppressed. Changed/closed PRs, invalid output and GitHub delivery rejection fail the action. Inference receives only read/search tools and excludes inherited MCP, hooks, plugins and session resumption. No approvals or merge actions are exposed.

Scoped regression and integration checks: 69 passed, including an offline turn through the real Agents SDK and root-process/HTTP delivery cases. Root TypeScript and diff checks passed. Independent review findings were fixed and covered by regressions. The rendered Markdown was visually inspected with both disclosures expanded in an illustrative local preview. No paid model call or real GitHub review submission was used for this validation. Full managed-service parity remains unclaimed.
