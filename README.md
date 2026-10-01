# Codex GitHub Action

A fork of [Anthropic's Claude Code Action](https://github.com/anthropics/claude-code-action) that uses **the OpenAI Agents SDK with a Codex model and your OpenAI API key**. It retains the GitHub issue/PR context, mention triggers, tracking comments, branch handling, tools, and cleanup. The runtime uses `@openai/agents` pinned to `0.18.0` with the OpenAI Responses API and `gpt-5.3-codex` by default. The Agents SDK owns the model/tool loop; this action does not install or run the Codex CLI, Claude Code, or the Claude Agent SDK.

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

## Runtime and configuration

The runtime uses `@openai/agents` pinned to `0.18.0` with the OpenAI Responses API and `gpt-5.3-codex` by default. The Agents SDK owns the model/tool loop; this action does not install or run the Codex CLI, Claude Code, or the Claude Agent SDK.

Preparation builds the GitHub context and scoped MCP configuration. The SDK then executes the agent with registered file, shell, MCP, task, and workflow tools and adapts completed messages into the action's execution report. An incomplete or failed agent run fails the action.

| Input or feature                                       | Agents SDK adaptation                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `codex_model`, `codex_effort`                          | OpenAI model selection and reasoning effort; default model is `gpt-5.3-codex`.                                              |
| `max_turns`, `max_budget_usd`, `fallback_model`        | SDK-owned turn limits, estimated token budget, and eligible model-request fallback.                                         |
| `allowed_tools`, `disallowed_tools`, `permission_mode` | Tool permission policy applied to registered tools before execution.                                                        |
| `system_prompt`, appended instructions                 | Trusted system instructions and additional task guidance.                                                                   |
| `settings`, `setting_sources`                          | User/project/local settings, environment, hooks, MCP, and component configuration.                                          |
| `plugins`, `plugin_marketplaces`                       | Configuration components loaded by this action; supported Codex and legacy manifest formats do not select a Claude runtime. |
| Commands, skills, Task, Workflow                       | Repository/plugin instructions, command arguments, subagents, and workflow execution in the SDK loop.                       |
| `mcp_config`, tool selection                           | Custom stdio/HTTP MCP servers and existing GitHub integrations.                                                             |
| `structured_output`                                    | Validated JSON result for a supplied schema.                                                                                |
| Progress, sticky comments, inline review               | Existing GitHub presentation, classification, signing, branch handling, and cleanup.                                        |

`codex_args` takes precedence over the legacy `claude_args` name. Both describe action configuration; they are not arbitrary arguments to a CLI subprocess. Legacy `.claude` settings, command, and plugin format names are compatibility inputs, not a Claude execution backend. Anthropic OAuth, WIF, Bedrock, and Vertex authentication are not supported. Grant GitHub permissions in the calling workflow or supplied token; `additional_permissions` cannot elevate a workflow token.

See [all action inputs](action.yml), the [base-action reference](base-action/README.md), and the retained [workflow feature guides](docs/usage.md). The available adapter surfaces are distinct from live qualification: offline checks do not establish a complete model-driven GitHub task end to end.

Trusted write tasks receive the scoped GitHub token and repository/event metadata for existing `gh` and script workflows. OpenAI model credentials remain excluded from tool subprocesses. Non-write exceptions use configured GitHub MCP capabilities rather than exposing the GitHub token to shell commands.

## Run limits, costs, and sessions

`max_turns` limits model turns. Set job `timeout-minutes` for the main action; the base action also exposes `codex_timeout_minutes` for its agent run. `max_budget_usd` checks an estimate from reported model token usage and the configured token-rate table after model responses. This is not an account spending cap: a response can cross the estimate before execution stops. Cached input and output tokens are included. Hosted search or other separately billed tools, pricing tiers, and actual invoiced charges are not included. With a USD limit, models without a configured rate fail rather than assuming zero cost.

`continue_session` selects the latest saved session, and `resume_session` selects a specific saved ID. History is stored on the runner and scoped to the workspace. It survives repeated runs only while that storage exists; persistence across Actions jobs requires a suitable Actions cache or other explicit storage. Protect session history as repository data and restore it only for the same trusted workspace.

## Fork policy and credentials

Fork PR execution is disabled, including PR/review events, PR comments, and associated workflow-run events. This is enforced before preparation or model execution. Confirmed fork requests produce `skipped_due_to_fork=true`; missing source identity or lookup failures fail closed. An upstream comment workflow with no PR association also fails closed because its default-branch commit cannot establish which PR was commented on. This policy blocks action execution; it does not prevent people from forking a public repository.

API authentication uses the OpenAI key supplied to the SDK model client. Shell subprocess environments exclude OpenAI credentials; GitHub MCP tools receive their scoped GitHub token, and trusted write tasks receive explicit GitHub CLI authentication. Execution artifacts and diagnostics redact recognized keys and active credentials. Root and nested PR-authored Codex configuration/instructions are restored from the trusted base, with inert review copies preserved. Workflow tokens are retained for later workflow steps. The action does not mint or revoke App tokens.

## Verification status

Verification uses offline model/transport fixtures, configuration parsing, and relevant upstream regression suites. Live OpenAI calls and GitHub task execution are **not yet verified**. See [the port worklog](docs/CODEX_PORT_WORKLOG.md) for the completed checks.

Fork CI runs offline tests, formatting, type checking, and the inherited workflow checks with Bun `1.4.2`. Original documentation and examples are retained and adapted; provider-specific historical references are identified explicitly. Upstream model-calling CI remains preserved under `examples/upstream-workflows` without running in this fork.

Nonsecret build/test variables from the workflow environment and `settings.env` reach Codex tools. Reserved runtime controls and credential variables remain excluded.
