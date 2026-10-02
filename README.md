# Codex GitHub Action

A fork of [Anthropic's Claude Code Action](https://github.com/anthropics/claude-code-action) that uses **the OpenAI Agents SDK with a Codex model and your OpenAI API key**. It retains the GitHub issue/PR context, mention triggers, tracking comments, branch handling, tools, and cleanup. The runtime uses `@openai/agents` pinned to `0.18.0` with the OpenAI Responses API and `gpt-6-luna` by default. The Agents SDK owns the model/tool loop; this action does not install or run the Codex CLI, Claude Code, or the Claude Agent SDK.

This is an independent adaptation, not an official OpenAI or Anthropic release. The upstream MIT copyright and license notices are retained in [LICENSE](LICENSE).

## Quickstart

From this checkout, run the guided installer:

```bash
npm run install-github-app
```

It guides you through GitHub login, repository selection, the OpenAI API-key
secret and a Linux or macOS runner. Review the setup before it writes anything.
The installer opens a draft workflow PR in each selected repository; merge it
onto the default branch to enable automatic PR reviews. Trusted users' non-draft,
same-repository PRs are reviewed when opened, updated, reopened or marked ready.
Use `/codex` in issue titles/bodies, comments or reviews to ask questions or request
implementations. Both jobs show progress; automatic reviews use read-only code
access and newer runs cancel older reviews for the same PR.
The generated workflow explicitly uses **Luna 6 (`gpt-6-luna`)** and a reviewed
action commit. Existing repository secrets are reused, and existing workflows
are preserved.

The installer needs Node.js and [GitHub CLI](https://cli.github.com/), but does not
need Bun or the action's SDK dependencies. To use it from any directory, run
`npm link --ignore-scripts` in this checkout, then `codex-action install`.
See [installer options and troubleshooting](docs/installer.md).

### Manual setup

Add your existing OpenAI key as the repository Actions secret `OPENAI_API_KEY`. Save this workflow as `.github/workflows/codex.yml` in the repository where you want the action to operate. Replace `your-github-username` with the trusted user's login. The workflow must be on the default branch for `issue_comment` events.

```yaml
name: Codex

on:
  issue_comment:
    types: [created]
  issues:
    types: [opened]
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  codex:
    if: >-
      (github.actor == 'your-github-username') &&
      (
        ((github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment') &&
          contains(github.event.comment.body, '/codex')) ||
        (github.event_name == 'pull_request_review' &&
          contains(github.event.review.body, '/codex')) ||
        (github.event_name == 'issues' &&
          (contains(github.event.issue.body, '/codex') ||
           contains(github.event.issue.title, '/codex')))
      )
    runs-on: ubuntu-latest
    timeout-minutes: 35
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: coryparrry/claude-code-action@d5affec7c70adde54f12056313ccfd6e08bdd1cd
        with:
          trigger_phrase: "/codex"
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          codex_model: "gpt-6-luna"
          codex_effort: low
          max_turns: "30"
          track_progress: "true"

  codex_review:
    if: >-
      github.event_name == 'pull_request' &&
      (github.actor == 'your-github-username') &&
      !github.event.pull_request.draft &&
      github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: read
      issues: write
      pull-requests: write
    concurrency:
      group: codex-review-${{ github.repository }}-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    runs-on: ubuntu-latest
    timeout-minutes: 35
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
      - name: Prepare PR diff
        env:
          CODEX_PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}
          CODEX_PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: >-
          git diff --no-ext-diff --no-textconv "$CODEX_PR_BASE_SHA...$CODEX_PR_HEAD_SHA" -- > .git/codex-review.diff
      - uses: coryparrry/claude-code-action@d5affec7c70adde54f12056313ccfd6e08bdd1cd
        with:
          trigger_phrase: "/codex"
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          codex_model: "gpt-6-luna"
          codex_effort: low
          max_turns: "30"
          track_progress: "true"
          codex_sandbox: read-only
          codex_args: >-
            --allowedTools "mcp__github_inline_comment__create_inline_comment"
          prompt: |
            Review this pull request's changes for concrete correctness, security and regression defects.
            Read the prepared patch in .git/codex-review.diff first; it includes removed lines as well as additions.
            Use the repository and PR context. Post actionable inline feedback where appropriate and a concise summary.
            Do not edit files, commit changes or implement fixes during this review.
            The author can request an implementation in a comment with /codex.
```

Mention `/codex` in an issue or PR comment to ask a question, review code, or request a change. For a shared repository, adjust the workflow's actor restriction for trusted collaborators; the action also verifies repository write access.

For an existing installation, change the workflow's mention condition to
`/codex` and set `trigger_phrase: "/codex"` on the action step. Both
must agree, including when the workflow pins an older action revision. The
guided installer now generates both settings explicitly. Custom trigger phrases
remain supported.

The example pins the reviewed action commit. The action uses the workflow GitHub token. A repository-scoped `github_token` can be supplied when a custom bot or additional permissions are needed. Set `bot_name` to that token's comment author login for sticky comments. Changes pushed with the default workflow token follow GitHub's normal restrictions on triggering other workflows.

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

The runtime uses `@openai/agents` pinned to `0.18.0` with the OpenAI Responses API and `gpt-6-luna` by default. The Agents SDK owns the model/tool loop; this action does not install or run the Codex CLI, Claude Code, or the Claude Agent SDK.

Preparation builds the GitHub context and scoped MCP configuration. The SDK then executes the agent with registered file, shell, MCP, task, and workflow tools and adapts completed messages into the action's execution report. An incomplete or failed agent run fails the action.

| Input or feature                                       | Agents SDK adaptation                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `codex_model`, `codex_effort`                          | OpenAI model selection and reasoning effort; default model is `gpt-6-luna`.                                                 |
| `max_turns`, `max_budget_usd`, `fallback_model`        | SDK-owned turn limits, estimated token budget, and eligible model-request fallback.                                         |
| `allowed_tools`, `disallowed_tools`, `permission_mode` | Tool permission policy applied to registered tools before execution.                                                        |
| `system_prompt`, appended instructions                 | Trusted system instructions and additional task guidance.                                                                   |
| `settings`, `setting_sources`                          | User/project/local settings, environment, hooks, MCP, and component configuration.                                          |
| `plugins`, `plugin_marketplaces`                       | Configuration components loaded by this action; supported Codex and legacy manifest formats do not select a Claude runtime. |
| Commands, skills, Task, Workflow                       | Repository/plugin instructions, command arguments, subagents, and workflow execution in the SDK loop.                       |
| `mcp_config`, tool selection                           | Custom stdio/HTTP MCP servers and existing GitHub integrations.                                                             |
| `structured_output`                                    | Validated JSON result for a supplied schema.                                                                                |
| Progress, sticky comments, inline review               | Existing GitHub presentation, classification, signing, branch handling, and cleanup.                                        |

`codex_args` takes precedence over the legacy `claude_args` name. Both describe action configuration; they are not arbitrary arguments to a CLI subprocess. Legacy `.claude` settings, command, and plugin format names are compatibility inputs, not a Claude execution backend. Authentication supports OpenAI API keys, OpenAI WIF, Bedrock bearer credentials and Azure OpenAI credentials. See [setup](docs/setup.md) and the [feature comparison](docs/feature-parity.md) for limits. `additional_permissions` requests installed App permissions; it cannot elevate a workflow token.

See [all action inputs](action.yml), the [base-action reference](base-action/README.md), and the retained [workflow feature guides](docs/usage.md). The available adapter surfaces are distinct from live qualification: offline checks do not establish a complete model-driven GitHub task end to end.

Trusted write tasks receive the scoped GitHub token and repository/event metadata for existing `gh` and script workflows. OpenAI model credentials remain excluded from tool subprocesses. Non-write exceptions use configured GitHub MCP capabilities rather than exposing the GitHub token to shell commands.

## Run limits, costs, and sessions

`max_turns` limits model turns. Set job `timeout-minutes` for the main action; the base action also exposes `codex_timeout_minutes` for its agent run. `max_budget_usd` checks an estimate from reported model token usage and the configured token-rate table after model responses. This is not an account spending cap: a response can cross the estimate before execution stops. Cached input, cache writes, long-context rates, output tokens and standard hosted web-search call charges are included. Other separately billed tools, pricing tiers and actual invoiced charges are not included. With a USD limit, models without a configured rate fail rather than assuming zero cost.

`continue_session` selects the latest saved session, and `resume_session` selects a specific saved ID. History is stored on the runner and scoped to the workspace. It survives repeated runs only while that storage exists; persistence across Actions jobs requires a suitable Actions cache or other explicit storage. Protect session history as repository data and restore it only for the same trusted workspace.

## Fork policy and credentials

Fork PR execution is disabled, including PR/review events, PR comments, and associated workflow-run events. This is enforced before preparation or model execution. Confirmed fork requests produce `skipped_due_to_fork=true`; missing source identity or lookup failures fail closed. An upstream comment workflow with no PR association also fails closed because its default-branch commit cannot establish which PR was commented on. This policy blocks action execution; it does not prevent people from forking a public repository.

API authentication uses the OpenAI key supplied to the SDK model client. Shell subprocess environments exclude OpenAI credentials; GitHub MCP tools receive their scoped GitHub token, and trusted write tasks receive explicit GitHub CLI authentication. Execution artifacts and diagnostics redact recognized keys and active credentials. Root and nested PR-authored Codex configuration/instructions are restored from the trusted base, with inert review copies preserved. Workflow tokens are retained for later workflow steps. When configured with GitHub App credentials, the action mints a repository-scoped installation token and attempts revocation after final comment classification.

## Verification status

Verification uses offline model/transport fixtures, configuration parsing, and relevant upstream regression suites. A live Luna tool-loop test passed during initial qualification. Live GitHub task execution and the newly added cloud authentication paths remain unverified. See [the port worklog](docs/CODEX_PORT_WORKLOG.md) for the completed checks.

Fork CI runs offline tests, formatting, type checking, and the inherited workflow checks with Bun `1.4.2`. Original documentation and examples are retained and adapted; provider-specific historical references are identified explicitly. Upstream model-calling CI remains preserved under `examples/upstream-workflows` without running in this fork.

Nonsecret build/test variables from the workflow environment and `settings.env` reach Codex tools. Reserved runtime controls and credential variables remain excluded.
