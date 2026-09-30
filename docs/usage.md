# Usage

> This fork runs Codex with `OPENAI_API_KEY`. GitHub triggers, tracking comments, branch handling, signing, and MCP integrations retain the upstream workflow shape. `claude_args` is a compatibility alias; use the preferred `codex_args` name for the same supported argument subset. Legacy `--allowedTools` / `--disallowedTools` support MCP names and simple Bash rules, not the full Claude permission language. Use a supported OpenAI model; there is no native `--max-turns`, Anthropic OAuth, WIF, Bedrock, or Vertex backend. Fork pull requests are rejected. See [configuration](./configuration.md) and [the action inputs](../action.yml).

Add a workflow file to your repository (e.g., `.github/workflows/claude.yml`):

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

jobs:
  codex-response:
    runs-on: ubuntu-latest
    steps:
      - uses: coryparrry/claude-code-action@codex/openai-runtime
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Authentication uses an OpenAI API key; Anthropic OAuth is unsupported.

          # Optional: provide a prompt for automation workflows
          # prompt: "Review this PR for security issues"

          # Optional: pass advanced arguments to Codex CLI
          # claude_args: |
          #   # No Codex turn limit; use the job timeout-minutes for a time bound.
          #   --model gpt-5.4

          # Optional: add custom plugin marketplaces
          # plugin_marketplaces: "https://github.com/user/marketplace1.git\nhttps://github.com/user/marketplace2.git"
          # Optional: install plugins from a native Codex marketplace manifest
          # plugins: "my-plugin@my-codex-marketplace"

          # Optional: add custom trigger phrase (default: @codex)
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

Additional native inputs are `codex_model`, `codex_effort`, `codex_sandbox`, `codex_version`, and `codex_args`. See [action.yml](../action.yml) for exact defaults. `codex_args` and the legacy `claude_args` name use the same compatibility parser; arbitrary native CLI flags are not accepted.

| Input                       | Description                                                                                                                                                                                                                        | Required          | Default        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------- |
| `openai_api_key`            | OpenAI API key; falls back to `OPENAI_API_KEY` in the environment                                                                                                                                                                  | Yes for execution | -              |
| `prompt`                    | Instructions for Codex. Can be a direct prompt or custom template for automation workflows                                                                                                                                         | No                | -              |
| `track_progress`            | Force tag mode with tracking comments. Only works with specific PR/issue events. Preserves GitHub context                                                                                                                          | No                | `false`        |
| `include_fix_links`         | Include 'Fix this' links in PR code review feedback that open Codex with context to fix the identified issue                                                                                                                       | No                | `true`         |
| `claude_args`               | Compatibility arguments: model, effort, MCP, schema, appended instructions, simple tool filters                                                                                                                                    | No                | ""             |
| `base_branch`               | The base branch to use for creating new branches (e.g., 'main', 'develop')                                                                                                                                                         | No                | -              |
| `use_sticky_comment`        | Use just one comment to deliver PR comments (only applies for pull_request event workflows)                                                                                                                                        | No                | `false`        |
| `classify_inline_comments`  | Classify queued inline comments with Codex before posting; set false to skip classification                                                                                                                                        | No                | `true`         |
| `github_token`              | Repository token; defaults to the workflow token. Set explicitly for non-write-user overrides or custom GitHub apps                                                                                                                | No                | Workflow token |
| `assignee_trigger`          | The assignee username that triggers the action (e.g. @codex). Only used for issue assignment                                                                                                                                       | No                | -              |
| `label_trigger`             | The label name that triggers the action when applied to an issue (e.g. "claude")                                                                                                                                                   | No                | -              |
| `trigger_phrase`            | The trigger phrase to look for in comments, issue/PR bodies, and issue titles                                                                                                                                                      | No                | `@codex`       |
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
| `path_to_codex_executable`  | Optional path to a custom Codex executable. Skips automatic installation. Useful for Nix, custom containers, or specialized environments                                                                                           | No                | ""             |
| `path_to_bun_executable`    | Optional path to a custom Bun executable. Skips automatic Bun installation. Useful for Nix, custom containers, or specialized environments                                                                                         | No                | ""             |
| `plugin_marketplaces`       | Newline-separated Git URLs with native Codex marketplace manifests; Claude marketplace manifests are unsupported                                                                                                                   | No                | ""             |
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

<details>
<summary>Historical upstream deprecated inputs — review compatibility before migrating</summary>

### Historical Deprecated Inputs

These are upstream migration references, not accepted inputs in this fork. Do not use the old turn-limit mappings; use the job timeout instead.

| Input                 | Description                                                                                         | Migration Path                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `mode`                | **DEPRECATED**: Mode is now automatically detected based on workflow context                        | Remove this input; the action auto-detects the correct mode    |
| `direct_prompt`       | **DEPRECATED**: Use `prompt` instead                                                                | Replace with `prompt`                                          |
| `override_prompt`     | **DEPRECATED**: Use `prompt` with template variables or `claude_args` with `--append-system-prompt` | Use `prompt` for templates or `claude_args` for system prompts |
| `custom_instructions` | **DEPRECATED**: Use `claude_args` with `--append-system-prompt` or include in `prompt`              | Move instructions to `prompt` or use `claude_args`             |
| `max_turns`           | Unsupported; no native turn-limit equivalent                                                        | Use job timeout for elapsed time                               |
| `model`               | **DEPRECATED**: Use `claude_args` with `--model` instead                                            | Use `claude_args: "--model gpt-5.4"`                           |
| `fallback_model`      | **DEPRECATED**: Use `claude_args` with fallback configuration                                       | Configure fallback in `claude_args` or `settings`              |
| `allowed_tools`       | **DEPRECATED**: Use `claude_args` with `--allowedTools` instead                                     | Use `claude_args: "--allowedTools Edit,Read,Write"`            |
| `disallowed_tools`    | **DEPRECATED**: Use `claude_args` with `--disallowedTools` instead                                  | Use `claude_args: "--disallowedTools WebSearch"`               |
| `mcp_config`          | **DEPRECATED**: Use `claude_args` with `--mcp-config` instead                                       | Use `claude_args: "--mcp-config '{...}'"`                      |
| `claude_env`          | **DEPRECATED**: Use workflow step `env`                                                             | Configure environment on the workflow step                     |

An OpenAI API key is required when running Codex. No Anthropic provider inputs are accepted.

> **Note**: This action is currently in beta. Features and APIs may change as we continue to improve the integration.

</details>

<details>
<summary>Upstream v0.x migration patterns — historical reference</summary>

## Upgrading from v0.x?

For a comprehensive guide on migrating from v0.x to v1.0, including step-by-step instructions and examples, see our **[Migration Guide](./migration-guide.md)**.

### Quick Migration Examples

#### Interactive Workflows (with @codex mentions)

**Before (v0.x):**

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    mode: "tag"
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    custom_instructions: "Focus on security"
    max_turns: "10"
```

**After (v1.0):**

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    claude_args: |
      --append-system-prompt "Focus on security"
```

#### Automation Workflows

**Before (v0.x):**

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
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
- uses: coryparrry/claude-code-action@codex/openai-runtime
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
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    override_prompt: |
      Analyze PR #$PR_NUMBER for security issues.
      Focus on: $CHANGED_FILES
```

**After (v1.0):**

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
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
  uses: coryparrry/claude-code-action@codex/openai-runtime
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
https://docs.claude.com/en/docs/agent-sdk/structured-outputs

## Ways to Tag @codex

These examples show how to interact with Codex using comments in PRs and issues. By default, Codex will be triggered anytime you mention `@codex`, but you can customize the exact trigger phrase using the `trigger_phrase` input in the workflow.

Codex will see the full PR context, including any comments.

### Ask Questions

Add a comment to a PR or issue:

```
@codex What does this function do and how could we improve it?
```

Codex will analyze the code and provide a detailed explanation with suggestions.

### Request Fixes

Ask Codex to implement specific changes:

```
@codex Can you add error handling to this function?
```

### Code Review

Get a thorough review:

```
@codex Please review this PR and suggest improvements
```

Codex will analyze the changes and provide feedback.

### Fix Bugs from Screenshots

Upload a screenshot of a bug and ask Codex to fix it:

```
@codex Here's a screenshot of a bug I'm seeing [upload screenshot]. Can you fix it?
```

Codex can see and analyze images, making it easy to fix visual bugs or UI issues.
