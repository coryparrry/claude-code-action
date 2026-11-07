# Release qualification — 1 November 2026

Qualification source: `4a40cc19a351f218b80dcd2357c1513617a71475`.
Installed action: `633c206996a8849aedeb77687369e1e7a31e3a37`.
All tests described below ran on GitHub Actions. Local work prepared fixtures and
collected evidence. Fixture PRs target disposable branches; main is unchanged.

## Acceptance contract

Every advertised feature must have an explicit evidence row. Passing a protocol
fixture establishes the exercised implementation contract; it does not establish
access to a live cloud account. Live calls use the existing GitHub OpenAI secret.
The release is not qualified for provider accounts or credentials that were not
available. No release tag or marketplace publication is part of this run.

## Hosted baseline

[Fresh source CI](https://github.com/coryparrry/claude-code-action/actions/runs/41351441397)
passed the complete suite: 1,559 tests, zero failures, 5,831 assertions, 116 files.
Root/base typechecks, formatting, complexity, isolated production-package execution
and all three actual composite-action boundary cases also passed.

Two boundary cases deliberately fail the action. Their subsequent assertions require
failure, a matching execution report, preserved usage and the expected side effects.
Red annotations from those negative action steps are expected. Probe warnings in the
unit suite likewise exercise comment suppression. Unexpected outcomes fail the job.
The qualification PR labels these cases and explains them in job summaries.

## Feature matrix

The evidence below refers to the complete hosted suite unless a live run is linked.
“Fixture” means a deterministic API, SDK, process or transport fixture on GitHub.

| Feature                                                     | Hosted coverage                                                   | Live evidence / limitation                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent/tag mode and direct prompts                           | `test/modes/`, action execution and prompt tests                  | Composite and actual issue/inline requests passed                                                                                                                                                                                                                                   |
| Mentions, custom triggers, labels and assignees             | Trigger validation, extraction, actor and tag-mode tests          | Real `/codex` issue and inline triggers passed; custom event variants are fixture coverage                                                                                                                                                                                          |
| Issue/PR/comment/review context                             | Context, fetcher, formatter, attachment and actor-filter tests    | Actual review and inline reply used real GitHub context                                                                                                                                                                                                                             |
| Native reviews and independent finding verification         | Native review, verification, anchors and visual-renderer tests    | [Controlled null defect](https://github.com/coryparrry/claude-code-action/actions/runs/41352827775) produced one independently verified inline finding                                                                                                                              |
| Requested edit on an open PR                                | Delivery, Git handoff, path validation and branch tests           | [Inline edit](https://github.com/coryparrry/claude-code-action/actions/runs/41353167303) changed only the requested file; separate validation and tracking-reply update passed                                                                                                      |
| Issue branch and PR handoff                                 | Branch source/template, issue delivery and cleanup tests          | [Issue request](https://github.com/coryparrry/claude-code-action/actions/runs/41352989671) created and pushed a new branch, supplied the PR link and passed separate validation                                                                                                     |
| Closed-PR branch handling                                   | `closed-pr-branch.test.ts`, branch source and cleanup tests       | Fixture coverage                                                                                                                                                                                                                                                                    |
| CI runs, jobs, pagination and bounded redacted logs         | Actions context/server/pagination and task-guidance tests         | [Live read-only diagnosis](https://github.com/coryparrry/claude-code-action/actions/runs/41353710140) reported current-head action_required accurately, cited exact-SHA validation and preserved the head; historical inventory and exact policy reason were unavailable            |
| Progress, sticky comments and validation updates            | Sticky/tracking/comment rendering and task delivery tests         | Both live requested-change runs updated their tracking replies with the delivered SHA's successful validation                                                                                                                                                                       |
| Inline feedback delivery, buffering and retries             | Inline integration/delivery/classifier tests                      | Real native inline finding and reply update passed                                                                                                                                                                                                                                  |
| Signed memory production, pending state and publication     | Memory proof, publisher, store and lifecycle regressions          | Final-pin [producer/retry](https://github.com/coryparrry/claude-code-action/actions/runs/41352295152/attempts/2) passed; exact merged head published and stale pending head retired                                                                                                 |
| Relevant retrieval, rename inventory and prompt budgets     | Repository-learning/memory and escaping regressions               | [Later rename review](https://github.com/coryparrry/claude-code-action/actions/runs/41353399115/attempts/1) retrieved source PR #12's published knowledge                                                                                                                           |
| Completed attempt and reviewed-base identity                | Memory regression/proof tests                                     | Final-pin same-head retry passed; [retargeted provenance was rejected](https://github.com/coryparrry/claude-code-action/actions/runs/41353917395), and [alternate-base retrieval excluded earlier notes](https://github.com/coryparrry/claude-code-action/actions/runs/41354255451) |
| Installer, managed workflows and repository guards          | Installer, review install/diff and fork tests                     | Generated-workflow and GitHub API fixtures; new live installer account setup not repeated                                                                                                                                                                                           |
| GitHub token acquisition/revocation and signing             | Token, permissions, SSH signing and Git configuration tests       | Live default workflow token passed; custom App live account unavailable                                                                                                                                                                                                             |
| Structured outputs and Actions outputs                      | Entrypoint-boundary and schema tests                              | [Live installed composite](https://github.com/coryparrry/claude-code-action/actions/runs/41353172403) exposed matching schema, conclusion, session and execution-file outputs                                                                                                       |
| Models, effort, compatibility args and fallback             | Runtime options, Codex compatibility and runner tests             | Terra 6.1/max in actual GitHub workflows; Luna/low in live runtime cases; fallback failure classes use fixtures                                                                                                                                                                     |
| Turn/deadline/budget limits and failure recovery            | Budget, retry, entrypoint and real SDK tests                      | Hosted actual composite success/expected-failure cases passed; caps also bounded live runs                                                                                                                                                                                          |
| Read/Write/Edit/Glob/Grep/shell tools                       | Agent tools and tool-environment tests                            | Live case verified exact calls, shell success and file contents                                                                                                                                                                                                                     |
| Web, notebook, todo and background tools                    | Additional-tools and workflow tests                               | Real local transport/process fixtures on GitHub; no arbitrary external site qualification                                                                                                                                                                                           |
| LSP                                                         | Agent LSP process tests                                           | Protocol/process fixtures on GitHub                                                                                                                                                                                                                                                 |
| Skill, command, agent/plugin and instruction loading        | Configuration, instruction and runtime tests                      | Live Skill and configured Task executed; saved child checkpoint and real child read were verified                                                                                                                                                                                   |
| Subagents, inherited permissions, checkpoints and worktrees | Subagent-state, runtime and workflow tests                        | Live child write was denied under inherited read-only policy; isolated worktree details use fixtures                                                                                                                                                                                |
| Workflow orchestration                                      | Real isolated workflow interpreter tests                          | Process/SDK fixtures on GitHub                                                                                                                                                                                                                                                      |
| Hooks and permission decisions                              | Agent hooks and permission tests                                  | Live trusted SessionStart hook ran; exact requested Write was denied and no file appeared                                                                                                                                                                                           |
| Sessions and compaction                                     | Session, compaction and runtime tests                             | Live session resumed the same ID and recalled a random token; compaction uses real SDK/provider fixtures                                                                                                                                                                            |
| MCP stdio/HTTP/SSE and media                                | MCP transport, environment, media and server-schema tests         | Live stdio MCP returned an unpredictable nonce and confirmed the model credential was absent; other transports/media use fixtures                                                                                                                                                   |
| OpenAI direct API authentication                            | Auth requests, runner and entrypoint tests                        | Live OpenAI calls passed                                                                                                                                                                                                                                                            |
| OpenAI workload identity                                    | Federation and auth-request tests                                 | Hosted protocol fixtures only; no trust policy/account supplied                                                                                                                                                                                                                     |
| Amazon Bedrock bearer/SigV4                                 | Auth, XML dependency and SDK request tests                        | Hosted protocol fixtures only; no AWS account credentials supplied                                                                                                                                                                                                                  |
| Azure/Foundry key or supplied Entra token                   | Auth, API-version and SDK request tests                           | Hosted protocol fixtures only; no Azure account credentials supplied                                                                                                                                                                                                                |
| Security boundaries, forks and credential redaction         | Permissions, sanitization, path, fork and environment regressions | Live read-only denial and MCP secret isolation passed; no penetration-test claim                                                                                                                                                                                                    |

Unsupported Vertex AI and subscription/OAuth backends are excluded from the supported
feature contract. Headless questions/planning use trusted configured answers; there
is no interactive human approval UI. Tool policies are not an OS sandbox.

## Live runtime results

[All six hosted cases passed](https://github.com/coryparrry/claude-code-action/actions/runs/41353172403):
tools, session/schema resume, MCP, configured components/inherited policy, hooks and
the exact installed composite action. The first harness run exposed an incorrect
assumption about the SDK report's argument envelope. The parser was fixed; all six
cases passed the affected GitHub recheck. Production runtime code was unchanged.

Independent review strengthened the harness before execution: explicit MCP exposure,
paired tool results, exact targets, real child checkpoints and observable denials.
[Harness CI](https://github.com/coryparrry/claude-code-action/actions/runs/41354638757) passed the full suite and verified documentation on **8/8 new named symbols (100%)**, against an 85% minimum. Repository-wide documentation coverage was not audited.
The live workflow now requires the `live-qualification` label as well as its trusted
actor and isolated-branch checks. Add that label to rerun live cases; remove it to
keep report-only edits from making additional paid calls. Ordinary CI remains active.
The completed live runs above predate this scheduling-only gate; their runtime test
code and production inputs are unchanged.

## Remaining live account limits

The owner confirmed that AWS, Azure, OpenAI workload-identity and custom GitHub App
test credentials are unavailable. Their hosted fixtures passed, but successful live
account authentication, trust policy and deployment availability remain unverified.
These integrations must not be advertised as live-qualified by this report.

The CI tools enumerate current-head runs. The live diagnosis correctly declined to
attribute older failures or guess the reason for an `action_required` gate when the
API supplied no jobs or reason. The separate validation on the delivered SHA passed;
this does not turn the blocked ordinary PR workflow runs into successful runs.

## Cleanup and final evidence

Read-only CI diagnosis and retarget/base-isolation checks passed within their documented API scope. [Current draft checks](https://github.com/coryparrry/claude-code-action/pull/14/checks) validate the final harness, documentation gate and CI labels.

Cleanup completed: fixture PR #12 merged only into its disposable base; PRs #13, #16 and #17 and issue #15 are closed. Seven fixture branches and all three fixture memory records were removed. The empty memory store remains available. Issues was restored to its original disabled setting. Main, unrelated PR #2 and the existing local uncommitted work were preserved.

The [machine-readable evidence](./release-qualification-2026-11-01.json) retains exact run and source identities. Draft PR #14 retains the test harness and report for review. No release was published.
