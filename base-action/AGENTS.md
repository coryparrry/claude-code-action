# AGENTS.md

## Commands

- Typecheck: `bun --no-env-file run typecheck`
- Format: `bun --no-env-file run format`
- Check formatting: `bun --no-env-file run format:check`
- Run tests: `bun --no-env-file test`
- Run one test file: `bun --no-env-file test test/prepare-prompt.test.ts`
- Install locked dependencies: `bun --no-env-file install --frozen-lockfile`

## Architecture

This composite GitHub Action runs Codex through the OpenAI Agents SDK and
Responses API. `action.yml` maps inputs to environment variables;
`src/index.ts` validates them, prepares the prompt and sets action outputs.
`src/run-codex.ts` owns tools, permissions, hooks, sessions and execution
reports. `src/openai-agent-runner.ts` owns SDK inference and execution limits.

Keep the public inputs and outputs compatible. Model authentication lives in
`src/openai-auth.ts`; OpenAI API keys and the implemented WIF, Bedrock and Azure
adapters are separate from GitHub authentication. Provider-specific live
verification remains documented in the repository's parity report.

## Verification

Tests include configuration units, actual SDK/tool loops, HTTP provider and
child-process entrypoint cases. The repository's `action-boundaries` CI job
also invokes this composite action with an isolated inference fixture and
checks expected success and failure outputs. See
`../docs/runtime-verification.md` for required behavior and qualification limits.

Run tests with `--no-env-file` and fake credentials. Do not add paid model calls
to deterministic tests or load the developer's home configuration into them.

## Runtime contracts

- Blank final output gets one tool-free recovery attempt inside the original
  turn cap, deadline and cancellation signal.
- Failures retain completed work, usage and redacted diagnostics. Exit status,
  action conclusion and execution report must agree.
- Reports use `RUNNER_TEMP/codex-execution-output.json`. Preflight cannot expose
  an earlier run's report.
- Structured output must pass schema validation before it reaches action outputs.
- Tool policies enforce workspace and read-only restrictions; they are not an
  operating-system filesystem or network sandbox.
