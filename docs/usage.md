# Usage

> The runtime uses `@openai/agents` pinned to `0.18.0` with the OpenAI Responses API and `gpt-6-luna` by default. The Agents SDK owns the model/tool loop; this action does not install or run the Codex CLI, Claude Code, or the Claude Agent SDK. Legacy configuration names remain adapter inputs; Anthropic provider authentication is historical only. Fork pull requests are rejected before execution.

Start with the [complete workflow](../README.md#quickstart) and [provider setup](./cloud-providers.md). The example below illustrates additional options for `.github/workflows/codex.yml`:

```yaml
name: Codex Assistant
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned, labeled]
  pull_request_review:
    types: [submitted]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  codex-response:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Authentication uses an OpenAI API key; Anthropic OAuth is unsupported.

          # Optional: provide a prompt for automation workflows
          # prompt: "Review this PR for security issues"

          # Optional: pass advanced arguments to Agents SDK runner
          # codex_args: |
          #   --max-turns 10
          #   --model gpt-6-luna

          # Optional: add custom plugin marketplaces
          # plugin_marketplaces: "https://github.com/user/marketplace1.git\nhttps://github.com/user/marketplace2.git"
          # Optional: install plugins from a supported plugin marketplace manifest
          # plugins: "my-plugin@my-codex-marketplace"

          # Optional: add custom trigger phrase (default: /codex)
          # trigger_phrase: "/codex"
          # Optional: add assignee trigger for issues
          # assignee_trigger: "codex-bot"
          # Optional: add label trigger for issues
          # label_trigger: "codex"
          # Optional: grant additional permissions (requires corresponding GitHub token permissions)
          # additional_permissions: |
          #   actions: read
          # Optional: allow bot users to trigger the action
          # allowed_bots: "dependabot[bot],renovate[bot]"
```

## Inputs

Additional SDK runtime inputs are `codex_model`, `codex_effort`, `codex_sandbox`, and `codex_args`. See [action.yml](../action.yml) for exact defaults. The SDK also owns `max_turns`, `max_budget_usd`, tool permission controls, hooks, task/workflow tools, fallback, and session continuation. Offline verification does not establish live model/GitHub completion. `codex_args` and the legacy `claude_args` name use the same compatibility parser; these inputs configure the SDK loop and do not launch a CLI.

| Input                       | Description                                                                                                                                                                                                                        | Required          | Default        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------- |
| `openai_api_key`            | OpenAI API key; falls back to `OPENAI_API_KEY` in the environment                                                                                                                                                                  | Yes for execution | -              |
| `prompt`                    | Instructions for Codex. Can be a direct prompt or custom template for automation workflows                                                                                                                                         | No                | -              |
| `track_progress`            | Force tag mode with tracking comments. Only works with specific PR/issue events. Preserves GitHub context                                                                                                                          | No                | `false`        |
| `include_fix_links`         | Include 'Fix this' links in PR code review feedback that open Codex with context to fix the identified issue                                                                                                                       | No                | `true`         |
| `claude_args`               | Compatibility arguments: model, effort, MCP, schema, appended instructions, registered tool rules and run limits                                                                                                                   | No                | ""             |
| `base_branch`               | The base branch to use for creating new branches (e.g., 'main', 'develop')                                                                                                                                                         | No                | -              |
| `use_sticky_comment`        | Use just one comment to deliver PR comments (only applies for pull_request event workflows)                                                                                                                                        | No                | `false`        |
| `classify_inline_comments`  | Classify queued inline comments with Codex before posting; set false to skip classification                                                                                                                                        | No                | `true`         |
| `github_token`              | Repository token; defaults to the workflow token. Set explicitly for non-write-user overrides or custom GitHub apps                                                                                                                | No                | Workflow token |
| `assignee_trigger`          | The assignee username that triggers the action (e.g. /codex). Only used for issue assignment                                                                                                                                       | No                | -              |
| `label_trigger`             | The label name that triggers the action when applied to an issue (e.g. "claude")                                                                                                                                                   | No                | -              |
| `trigger_phrase`            | The trigger phrase to look for in comments, issue/PR bodies, and issue titles                                                                                                                                                      | No                | `/codex`       |
| `branch_prefix`             | The prefix to use for Codex branches (defaults to 'codex/', use 'claude-' for dash format)                                                                                                                                         | No                | `codex/`       |
| `settings`                  | Codex settings as JSON string or path to settings JSON file                                                                                                                                                                        | No                | ""             |
| `additional_permissions`    | Additional permissions to enable. Currently supports 'actions: read' for viewing workflow results                                                                                                                                  | No                | ""             |
| `use_commit_signing`        | Enable commit signing using GitHub's API. Simple but cannot perform complex git operations like rebasing. See [Security](./security.md#commit-signing)                                                                             | No                | `false`        |
| `ssh_signing_key`           | SSH private key for signing commits. Enables signed commits with full git CLI support (rebasing, etc.). See [Security](./security.md#commit-signing)                                                                               | No                | ""             |
| `bot_id`                    | GitHub user ID to use for git operations (defaults to Codex's bot ID). Required with `ssh_signing_key` for verified commits                                                                                                        | No                | `41898282`     |
| `bot_name`                  | GitHub bot username for git operations and sticky comments when using a custom token                                                                                                                                               | No                | ""             |
| `include_comments_by_actor` | Comma-separated list of actor usernames to INCLUDE in comments. Supports the `*[bot]` wildcard to match all bot accounts. Empty (default) includes all actors                                                                      | No                | ""             |
| `exclude_comments_by_actor` | Comma-separated list of actor usernames to EXCLUDE from comments. Supports the `*[bot]` wildcard to match all bot accounts. If an actor matches both lists, exclusion takes priority                                               | No                | ""             |
| `allowed_bots`              | Comma-separated list of allowed bot usernames, or '\*' to allow all bots. Empty string (default) allows no bots. **⚠️ On public repos with `'*'`, external Apps may be able to invoke this action.** See [Security](./security.md) | No                | ""             |
| `allowed_non_write_users`   | **⚠️ RISKY**: Comma-separated list of usernames to allow without write permissions, or '\*' for all users. Only works with `github_token` input. See [Security](./security.md)                                                     | No                | ""             |
| `path_to_bun_executable`    | Optional path to a custom Bun executable. Skips automatic Bun installation. Useful for Nix, custom containers, or specialized environments                                                                                         | No                | ""             |
| `plugin_marketplaces`       | Newline-separated Git URLs with supported plugin marketplace manifests; supported legacy and Codex manifests are interpreted by this action                                                                                        | No                | ""             |
| `plugins`                   | Newline-separated list of Codex plugin names to install (e.g., see example in workflow above). Plugins are installed before Codex execution                                                                                        | No                | ""             |

<details>
<summary>Original provider input rows — not supported by this Codex fork</summary>

| Input                          | Description                                                                                                                                                                                                                     | Required | Default                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------- |
| `anthropic_api_key`            | Anthropic API key (required for direct API, not needed for Bedrock/Vertex)                                                                                                                                                      | No\*     | -                           |
| `claude_code_oauth_token`      | Claude Code OAuth token (alternative to anthropic_api_key)                                                                                                                                                                      | No\*     | -                           |
| `anthropic_federation_rule_id` | Workload identity federation rule ID (`fdrl_...`). With `anthropic_organization_id`, authenticates via the workflow's GitHub OIDC token instead of a static API key. See [Setup Guide](./setup.md#workload-identity-federation) | No\*     | -                           |
| `anthropic_organization_id`    | Anthropic organization UUID for workload identity federation                                                                                                                                                                    | No\*     | -                           |
| `anthropic_service_account_id` | Service account ID (`svac_...`) the federated token acts as (optional)                                                                                                                                                          | No       | -                           |
| `anthropic_workspace_id`       | Workspace ID (`wrkspc_...`) for workload identity federation. Optional when the federation rule targets a single workspace                                                                                                      | No       | -                           |
| `anthropic_oidc_audience`      | Audience requested on the GitHub OIDC token used for workload identity federation                                                                                                                                               | No       | `https://api.anthropic.com` |
| `use_bedrock`                  | Use Amazon Bedrock with OIDC authentication instead of direct Anthropic API                                                                                                                                                     | No       | `false`                     |
| `use_vertex`                   | Use Google Vertex AI with OIDC authentication instead of direct Anthropic API                                                                                                                                                   | No       | `false`                     |

</details>

## Migrating upstream inputs

Use `openai_api_key` instead of Anthropic authentication. The action retains `claude_args` as an alias for `codex_args` and accepts the original settings, hooks, plugins, commands, skills and MCP configuration formats.

| Upstream control                             | Codex equivalent                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `--model`                                    | `codex_model` or `codex_args: '--model gpt-5.3-codex'`                                  |
| `--max-turns`                                | `max_turns` or the same argument in `codex_args`; elapsed time is controlled separately |
| `--max-budget-usd`                           | `max_budget_usd` or the same argument; custom model rates use `settings.modelPrices`    |
| `--fallback-model`                           | `fallback_model` or the same argument in `codex_args`                                   |
| `--allowedTools` / `--disallowedTools`       | `allowed_tools` / `disallowed_tools` or the same arguments in `codex_args`              |
| `--append-system-prompt` / `--system-prompt` | `append_system_prompt` / `system_prompt` or the same arguments in `codex_args`          |
| `--mcp-config`                               | The same argument in `codex_args`; the base action also accepts `mcp_config`            |
| `--continue` / `--resume`                    | `continue_session` / `resume_session` or the same arguments in `codex_args`             |
| `direct_prompt` / `override_prompt`          | `prompt`                                                                                |
| `claude_env`                                 | Workflow step `env` or supported `settings.env`                                         |

Mode selection remains automatic. Authentication supports OpenAI API keys, OpenAI workload identity federation, Bedrock credentials, and Azure OpenAI credentials. See the [provider guide](./cloud-providers.md) for the exact contracts and remaining differences from Anthropic providers.

<details>
<summary>Upstream v0.x migration patterns — historical reference</summary>

## Upgrading from v0.x?

For a comprehensive guide on migrating from v0.x to v1.0, including step-by-step instructions and examples, see our **[Migration Guide](./migration-guide.md)**.

### Quick Migration Examples

#### Interactive Workflows (with /codex mentions)

**Before (v0.x):**

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    mode: "tag"
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    custom_instructions: "Focus on security"
    max_turns: "10"
```

**After (v1.0):**

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    claude_args: |
      --append-system-prompt "Focus on security"
```

#### Automation Workflows

**Before (v0.x):**

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    mode: "agent"
    direct_prompt: "Update the API documentation"
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    model: "gpt-5.4"
    allowed_tools: "Edit,Read,Write"
```

**After (v1.0):**

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    prompt: |
      REPO: ${{ github.repository }}
      PR NUMBER: ${{ github.event.pull_request.number }}

      Update the API documentation to reflect changes in this PR
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    claude_args: |
      --model gpt-5.4
      --allowedTools Edit,Read,Write
```

#### Custom Templates

**Before (v0.x):**

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    override_prompt: |
      Analyze PR #$PR_NUMBER for security issues.
      Focus on: $CHANGED_FILES
```

**After (v1.0):**

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    prompt: |
      Analyze PR #${{ github.event.pull_request.number }} for security issues.
      Focus on the changed files in this PR.
```

</details>

## Structured Outputs

Get validated JSON results from Codex that automatically become GitHub Action outputs. This enables building complex automation workflows where Codex analyzes data and subsequent steps use the results.

### Basic Example

```yaml
- name: Detect flaky tests
  id: analyze
  uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt: |
      Check the CI logs and determine if this is a flaky test.
      Return: is_flaky (boolean), confidence (0-1), summary (string)
    claude_args: |
      --json-schema '{"type":"object","properties":{"is_flaky":{"type":"boolean"},"confidence":{"type":"number"},"summary":{"type":"string"}},"required":["is_flaky"]}'

- name: Retry if flaky
  if: fromJSON(steps.analyze.outputs.structured_output).is_flaky == true
  run: gh workflow run CI
```

### How It Works

1. **Define Schema**: Provide a JSON schema via `--json-schema` flag in `claude_args`
2. **Codex Executes**: Codex uses tools to complete your task
3. **Validated Output**: Result is validated against your schema
4. **JSON Output**: All fields are returned in a single `structured_output` JSON string

### Accessing Structured Outputs

All structured output fields are available in the `structured_output` output as a JSON string:

**In GitHub Actions expressions:**

```yaml
if: fromJSON(steps.analyze.outputs.structured_output).is_flaky == true
run: |
  CONFIDENCE=${{ fromJSON(steps.analyze.outputs.structured_output).confidence }}
```

**In bash with jq:**

```yaml
- name: Process results
  run: |
    OUTPUT='${{ steps.analyze.outputs.structured_output }}'
    IS_FLAKY=$(echo "$OUTPUT" | jq -r '.is_flaky')
    SUMMARY=$(echo "$OUTPUT" | jq -r '.summary')
```

**Note**: Due to GitHub Actions limitations, composite actions cannot expose dynamic outputs. All fields are bundled in the single `structured_output` JSON string.

### Complete Example

See `examples/test-failure-analysis.yml` for a working example that:

- Detects flaky test failures
- Uses confidence thresholds in conditionals
- Auto-retries workflows
- Comments on PRs

### Documentation

For complete details on JSON Schema syntax and Agent SDK structured outputs:
[base-action structured output reference](../base-action/README.md#outputs)

## Ways to Tag /codex

These examples show how to interact with Codex using comments in PRs and issues. By default, Codex will be triggered anytime you mention `/codex`, but you can customize the exact trigger phrase using the `trigger_phrase` input in the workflow.

Codex will see the full PR context, including any comments.

### Ask Questions

Add a comment to a PR or issue:

```
/codex What does this function do and how could we improve it?
```

Codex will analyze the code and provide a detailed explanation with suggestions.

### Request Fixes

Ask Codex to implement specific changes:

```
/codex Can you add error handling to this function?
```

### Code Review

Get a thorough review:

```
/codex Please review this PR and suggest improvements
```

Codex will analyze the changes and provide feedback.

### Fix Bugs from Screenshots

Upload a screenshot of a bug and ask Codex to fix it:

```
/codex Here's a screenshot of a bug I'm seeing [upload screenshot]. Can you fix it?
```

Codex can see and analyze images, making it easy to fix visual bugs or UI issues.
