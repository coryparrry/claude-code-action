# Codex GitHub Action

A fork of [Anthropic's Claude Code Action](https://github.com/anthropics/claude-code-action) that uses **Codex CLI and your OpenAI API key** exclusively. It retains the upstream GitHub issue/PR context, mention triggers, tracking comments, branch handling, MCP tools, and cleanup. The coding backend is Codex CLI. Neither the Claude Agent SDK nor the OpenAI Agents SDK is installed or used.

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

The surrounding action retains its original workflow capabilities: mention and automated-prompt modes, custom prompts and MCP servers, GitHub tool selection, sticky/progress comments, inline review/classification, signing, branch handling, and cleanup. The general GitHub Docker MCP server is available through the existing tool configuration. `claude_args` remains a compatibility alias; `codex_args` takes precedence.

| Preserved input or feature       | Codex adaptation                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `claude_args` / `codex_args`     | Model, effort, appended instructions, MCP config, JSON schema, and supported tool filters map to Codex.        |
| `settings`                       | Supported Codex TOML/JSON or a file, plus supported legacy model/env/permission fields.                        |
| `plugins`, `plugin_marketplaces` | Native Codex plugin installation in the disposable runtime home.                                               |
| Slash commands                   | Explicit requests resolve `.codex/commands` or existing `.claude/commands`; argument substitution is retained. |
| `structured_output`              | Parsed JSON result from a supplied schema.                                                                     |
| `classify_inline_comments`       | Same review-vs-probe filtering and fallback, using an isolated Codex classifier.                               |
| `include_fix_links`              | Links to affected PR changes with concrete fix context.                                                        |
| `allowed_non_write_users`        | Original opt-in exception with an explicitly supplied GitHub token; fork PRs remain disabled.                  |

Provider-specific semantics need adaptation: Claude cloud/OAuth authentication is replaced by an OpenAI key; Claude plugin manifests are not Codex plugin manifests; `--max-turns` and fine-grained Claude Bash/Read/Edit/Write permissions have no exact Codex exec counterpart and fail clearly. There is no fallback to a Claude backend. Grant GitHub permissions in the calling workflow or supplied token; the legacy `additional_permissions` input cannot elevate a workflow token.

Trusted write tasks receive the scoped GitHub token and repository/event metadata for existing `gh` and script workflows. OpenAI model credentials remain excluded from tool subprocesses. Non-write exceptions use configured GitHub MCP capabilities rather than exposing the GitHub token to shell commands.

## Fork policy and credentials

Fork PR execution is disabled, including PR/review events, PR comments, and associated workflow-run events. This is enforced before preparation or model execution. Confirmed fork requests produce `skipped_due_to_fork=true`; missing source identity or lookup failures fail closed. An upstream comment workflow with no PR association also fails closed because its default-branch commit cannot establish which PR was commented on. This policy blocks action execution; it does not prevent people from forking a public repository.

API authentication uses a temporary Codex home and ephemeral API credentials. Shell subprocess environments exclude OpenAI credentials; GitHub MCP tools receive their scoped GitHub token, and trusted write tasks receive explicit GitHub CLI authentication. Execution artifacts and diagnostics redact recognized keys and active credentials. Root and nested PR-authored Codex configuration/instructions are restored from the trusted base, with inert review copies preserved. Workflow tokens are retained for later workflow steps. The action does not mint or revoke App tokens.

## Verification status

This port is verified offline with fake-CLI integration tests, configuration parsing, and relevant upstream regression suites. Live OpenAI calls and GitHub task execution are **not yet verified**. See [the port worklog](docs/CODEX_PORT_WORKLOG.md) for the completed checks.

Fork CI runs offline tests, formatting, type checking, and the inherited workflow checks with Bun `1.4.2`. Original documentation and examples are retained and adapted; provider-specific historical references are identified explicitly. Upstream model-calling CI remains preserved under `examples/upstream-workflows` without running in this fork.

Nonsecret build/test variables from the workflow environment and `settings.env` reach Codex tools. Reserved runtime controls and credential variables remain excluded.
