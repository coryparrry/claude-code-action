# Runtime verification boundaries

The GitHub workflow and replacement agent runtime must agree on completion,
failure, limits, permissions and outputs. Test counts alone do not establish
that agreement or full parity with Claude Code Action.

## Required behavior

| Boundary               | Required behavior                                                                                                                                                                  | Evidence                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Blank final message    | One summary recovery attempt keeps completed history and usage. It exposes no tools or MCP servers and requests `tool_choice: none`. Unexpected tool calls fail without executing. | Completion regressions and real HTTP entrypoint tests        |
| Missing assistant item | SDK continuation stays within the original turn cap; exhausted limits fail.                                                                                                        | Real HTTP entrypoint test                                    |
| Limits and hooks       | Recovery retains the original deadline, cancellation signal and turn cap. A later Stop-hook continuation can authorize new work using the original tools.                          | Real SDK regression tests                                    |
| Failure                | Process exit status, `conclusion`, execution report and error flag agree. Completed work and paid usage remain recorded; credentials are redacted.                                 | Real HTTP entrypoint tests and hosted composite-action cases |
| Structured output      | Valid output reaches the action output; invalid output fails validation and is not exposed as a successful structured result.                                                      | Real HTTP entrypoint tests                                   |
| Permissions            | Read-only configuration prevents a requested write even when permission mode would otherwise allow tools.                                                                          | Real HTTP entrypoint test                                    |
| Report identity        | Preflight failure cannot expose a previous base-action run's report.                                                                                                               | Real entrypoint regression                                   |

## Verification layers

`base-action/test/action-entrypoint-boundaries.test.ts` launches the shipped Bun
entrypoint as a child process with isolated fake credentials, a temporary home
and workspace, GitHub output files and a local Responses API fixture. The
provider, SDK loop, tools, permissions, reporting and file commands are real;
model responses are deterministic fixtures.

The `action-boundaries` CI job runs `./base-action` on Linux for successful
recovery, a forbidden recovery tool call and repeated blank completions. Its
verification step requires the expected step outcome, action output, report,
usage and file side effect. `continue-on-error` permits inspection of expected
failures; it does not make an unexpected failure or false success pass CI.
These cases also upload their fixture reports with seven-day retention, so
hosted runs verify report storage after the successful and failed action steps.
The fixture server is stopped in an always-running cleanup step.

The production-package check verifies isolated production installs separately.
A real automatic PR review must also run the exact candidate action revision.
That live run qualifies the exercised review path, not every provider, issue
command, authentication method or feature in the parity table.

The installed command and review jobs save execution reports as GitHub Actions
artifacts for seven days, including failed runs that produced a report. Runs
without a report skip the upload. Names include the job, run ID and attempt.
Reports can contain prompts, repository content and tool output, accessible
under the repository's GitHub permissions.
