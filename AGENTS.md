# AGENTS.md

## Commands

```bash
bun --no-env-file test                # Run tests
bun --no-env-file run typecheck       # TypeScript type checking
bun --no-env-file run format          # Format with prettier
bun --no-env-file run format:check    # Check formatting
```

## What This Is

A GitHub Action that lets Codex respond to `/codex` requests on issues/PRs (tag mode) or run tasks via the `prompt` input (agent mode). Mode detection lives in `src/modes/detector.ts`.

## How It Runs

`src/entrypoints/run.ts` orchestrates preparation (auth, permissions, trigger check, branch/comment creation), execution through `base-action/src/run-codex.ts`, and cleanup (tracking comment and step summary). The backend is the OpenAI Agents SDK and Responses API. SSH signing cleanup and token revocation are separate `always()` steps in `action.yml`.

`base-action/` is also usable as a standalone composite action. Preserve its public inputs and outputs. Its entrypoint reads config from `INPUT_`-prefixed environment variables set by `action.yml`.

## Key Concepts

**Authentication**: GitHub token setup lives in `src/github/token.ts`; explicit tokens, custom GitHub App credentials and the workflow token are supported. Model authentication is separate and lives in `base-action/src/openai-auth.ts`.

**Mode lifecycle**: `detectMode()` in `src/modes/detector.ts` picks the mode name ("tag" or "agent"). Trigger checking and prepare dispatch are inlined in `run.ts`: tag mode calls `prepareTagMode()` from `src/modes/tag/`, agent mode calls `prepareAgentMode()` from `src/modes/agent/`.

**Prompt construction**: Tag mode's `prepareTagMode()` builds the prompt by fetching GitHub data (`src/github/data/fetcher.ts`), formatting it as markdown (`src/github/data/formatter.ts`), and writing it to a temp file via `createPrompt()`. Agent mode writes the user's prompt directly. Preserve issue/PR context, comments, diffs and CI status.

## Things That Will Bite You

- **Strict TypeScript**: `noUnusedLocals` and `noUnusedParameters` are enabled. Typecheck will fail on unused variables.
- **Discriminated unions for GitHub context**: `GitHubContext` is a union type — call `isEntityContext(context)` before accessing entity-specific fields like `context.issue` or `context.pullRequest`.
- **Token lifecycle matters**: The GitHub App token is obtained early and revoked in a separate `always()` step in `action.yml`. If you move token revocation into `run.ts`, it won't run if the process crashes. Same for SSH signing cleanup.
- **Error phase attribution**: The catch block in `run.ts` uses `prepareCompleted` to distinguish prepare failures from execution failures. The tracking comment shows different messages for each.
- **`action.yml` outputs reference step IDs**: Outputs like `execution_file`, `branch_name`, `github_token` reference `steps.run.outputs.*`. If you rename the step ID, update the outputs section too.
- **Verification boundaries**: Unit tests, real SDK integration, child-process HTTP entrypoint tests and hosted composite-action tests are in this repository. A live PR review qualifies only the exercised path. See `docs/runtime-verification.md`.

## Code Conventions

- Runtime execution and tests use Bun. Use `--no-env-file` for tests so local credentials cannot enter fixtures.
- `moduleResolution: "bundler"` — imports don't need `.js` extensions.
- GitHub API calls should use retry logic (`src/utils/retry.ts`).
- GitHub MCP server configuration is prepared by `src/mcp/install-mcp-server.ts`.

## Security hardening for GitHub Actions

Workflow jobs in this repository that call Claude run with three protections. Keep them when you add or edit a workflow.

1. **Egress-firewall runner.** The job has `runs-on: ubuntu-24.04-firewall`, a GitHub-hosted runner that filters the job's outbound network traffic. Do not move a job that calls Claude to another runner.
2. **Network allow list.** `.github/egress-firewall.yaml` lists the hosts those jobs may reach, besides any that GitHub's firewall allows by default. Keep `mode: enforce`, which is what makes the firewall block the rest. Follow that file's header when you add a host.
3. **Auto permission mode.** Every step that runs the Claude Code action (`uses: anthropics/claude-code-action`, or this repository's own `./` and `./base-action`) passes `--permission-mode auto` in `claude_args`. A tool call that needs permission and that the allowed tools do not cover then runs only if Claude Code's safety review passes it. Allow only the tools the job needs, and keep any `--disallowedTools` list a step has. Use `claude-opus-4-6` or a newer model: on an older one Claude Code falls back to its default permission mode.

`claude.yml` answers `@claude` mentions. The Claude Code action sets `--permission-mode acceptEdits` for those, and the `--permission-mode auto` in the workflow's `claude_args`, which comes after it, replaces it.

`.github/workflows/workflow-hardening.yml` fails when a job that runs the Claude Code action or mentions `ANTHROPIC_FEDERATION_RULE_ID` breaks protection 1 or 3, or when the allow list is missing, empty, not `mode: enforce`, or names a host with `*`. It cannot see a job that calls Claude another way, so check new workflows by hand too. If a job cannot meet protection 1 or 3, add it with the reason to the matching exemption table in `.github/scripts/check_workflow_hardening.py`. A job in `EXEMPT_FROM_AUTO_MODE` must set no permission mode at all. Do not skip or weaken the check.

Keep each workflow's `permissions:` block minimal, and never print tokens or environment variables in workflow logs.

The inherited checker also recognizes this port's `claude_args` compatibility
input. Keep its firewall and permission requirements for composite fixture
jobs. The OpenAI runtime's tool policy does not provide Claude Code's model
safety reviewer; grant only the tools each workflow needs.
