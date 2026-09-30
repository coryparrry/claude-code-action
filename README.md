# Codex GitHub Action

A fork of [Anthropic's Claude Code Action](https://github.com/anthropics/claude-code-action) that uses **Codex CLI and your OpenAI API key** exclusively. It retains the upstream GitHub issue/PR context, mention triggers, tracking comments, branch handling, MCP tools, and cleanup. Neither the Claude Agent SDK nor the OpenAI Agents SDK is installed or used.

This is an independent adaptation, not an official OpenAI or Anthropic release. The upstream MIT copyright and license notices are retained in [LICENSE](LICENSE).

## Quickstart

Add your existing OpenAI key as the repository Actions secret `OPENAI_API_KEY`. Save this workflow in the repository where you want the action to operate. The workflow must be on the default branch for `issue_comment` events.

```yaml
name: Codex tasks
on:
  issue_comment:
    types: [created]
  issues:
    types: [opened]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  codex:
    if: >-
      contains(github.event.comment.body || github.event.issue.body, '@codex')
      && github.actor == github.repository_owner
    runs-on: ubuntu-latest
    timeout-minutes: 35
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: coryparrry/claude-code-action@codex/openai-runtime
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

Mention `@codex` in an issue or PR comment to ask a question, review code, or request a change. For a shared repository, adjust the workflow's actor restriction for trusted collaborators; the action also verifies repository write access.

Use an immutable commit SHA in `uses:` when adopting a reviewed version. The development branch above is for reviewing this port. The action uses the workflow GitHub token. A repository-scoped `github_token` can be supplied when a custom bot or additional permissions are needed. Set `bot_name` to that token's comment author login for sticky comments. Changes pushed with the default workflow token follow GitHub's normal restrictions on triggering other workflows.

## Automated prompts

The upstream `prompt` input supports non-interactive automation, for example a manually dispatched code review:

```yaml
name: Codex review
on: workflow_dispatch
permissions:
  contents: read
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 35
    steps:
      - uses: actions/checkout@v6
      - uses: coryparrry/claude-code-action@codex/openai-runtime
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          codex_sandbox: read-only
          prompt: Review the repository and report concrete bugs without editing files.
```

## Runtime inputs

| Input                      | Behavior                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `openai_api_key`           | Existing OpenAI API key, or supply `OPENAI_API_KEY` through the workflow environment. |
| `codex_model`              | Optional model; empty uses the pinned Codex CLI's default.                            |
| `codex_effort`             | Optional reasoning effort supported by the selected model.                            |
| `codex_sandbox`            | `workspace-write` by default; `read-only` for analysis.                               |
| `codex_version`            | Exact npm CLI version; defaults to `0.159.2`.                                         |
| `path_to_codex_executable` | Optional existing CLI executable, bypassing installation.                             |
| `trigger_phrase`           | Defaults to `@codex`.                                                                 |
| `branch_prefix`            | Defaults to `codex/`.                                                                 |
| `bot_name`                 | Optional comment author login for a custom GitHub token.                              |

Codex requires a Linux or macOS runner. Preparation generates scoped GitHub MCP servers, which are translated to isolated Codex TOML configuration. Execution combines the prepared context and actual request, runs `codex exec`, and adapts completed messages into the existing action report format. A successful process exit without a completed turn and final answer fails the action.

This fork has no engine selector, Claude credentials, cloud-provider backends, plugins, Claude CLI arguments, or model-based inline-comment classifier. Use the Codex inputs above. Existing integration inputs such as `use_sticky_comment`, `track_progress`, and `use_commit_signing` remain available.

Inline review tools are available for PR tasks in both mention and automated-prompt mode. `buffer_inline_comments` defaults to `true`: comments are queued until execution ends, except `confirmed=true` calls post immediately and `confirmed=false` calls are discarded. No extra model call is made to classify comments. General GitHub API automation through the upstream Docker MCP server and Claude tool allowlists has been removed; this action supplies its own scoped comment, review, CI-read, and signed-file tools.

## Fork policy and credentials

Fork PR execution is disabled, including PR/review events, PR comments, and associated workflow-run events. This is enforced before preparation or model execution. Confirmed fork requests produce `skipped_due_to_fork=true`; missing source identity or lookup failures fail closed. An upstream comment workflow with no PR association also fails closed because its default-branch commit cannot establish which PR was commented on. This policy blocks action execution; it does not prevent people from forking a public repository.

API authentication uses a temporary Codex home and ephemeral API credentials. Shell subprocess environments exclude API and Actions credentials; GitHub MCP tools receive their scoped GitHub token. Execution artifacts and diagnostics redact recognized keys and active credentials. Root and nested PR-authored Codex configuration/instructions are restored from the trusted base, with inert review copies preserved. Workflow tokens are retained for later workflow steps. The action does not mint or revoke App tokens.

## Verification status

This port is verified offline with fake-CLI integration tests, configuration parsing, and relevant upstream regression suites. Live OpenAI calls and GitHub task execution are **not yet verified**. See [the port worklog](docs/CODEX_PORT_WORKLOG.md) for the completed checks.

Fork CI runs offline tests, formatting, and type checking with Bun `1.4.2`. Legacy upstream workflows, provider examples, and Claude documentation have been removed. The original implementation remains available in the [upstream repository](https://github.com/anthropics/claude-code-action).
