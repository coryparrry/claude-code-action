# Codex Base Action

Run OpenAI Codex with an inline prompt or a prompt file. This base action skips the GitHub trigger and comment orchestration in the repository's main action.

Use the base action from your copy of this fork:

```yaml
- uses: actions/checkout@v4
- uses: your-owner/your-fork/base-action@your-pinned-ref
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    prompt: "Review the repository and describe any clear defects."
    codex_sandbox: read-only
```

API key authentication is required. Codex runs with a temporary home, ephemeral sessions, disabled approval prompts, and either read-only or workspace-write access. The runtime restricts inherited environment variables and redacts known credentials from logs and execution reports. Workspace-write permits repository changes; review those changes before publishing them.

## Inputs

| Input                      | Description                                                                 | Default         |
| -------------------------- | --------------------------------------------------------------------------- | --------------- |
| `prompt`                   | Inline prompt; specify exactly one prompt input.                            | Empty           |
| `prompt_file`              | Path to a non-empty prompt file.                                            | Empty           |
| `openai_api_key`           | Required OpenAI API key.                                                    | Required        |
| `codex_model`              | Optional model name.                                                        | CLI default     |
| `codex_effort`             | none, minimal, low, medium, high, or xhigh.                                 | CLI default     |
| `codex_sandbox`            | read-only or workspace-write.                                               | workspace-write |
| `codex_version`            | Exact CLI version installed when no custom executable is provided.          | 0.159.2         |
| `codex_timeout_minutes`    | Positive integer process timeout in minutes.                                | 30              |
| `mcp_config`               | JSON with an mcpServers object containing stdio or streamable HTTP servers. | Empty servers   |
| `append_system_prompt`     | Additional instructions appended to the prompt.                             | Empty           |
| `path_to_codex_executable` | Custom Codex CLI path; skips installation.                                  | Empty           |
| `path_to_bun_executable`   | Custom Bun executable path; skips installation.                             | Empty           |
| `show_full_output`         | Log redacted JSON events when true.                                         | false           |

| `codex_args` | Supported Codex/legacy runtime arguments. | Empty |
| `claude_args` | Compatibility alias for codex_args. | Empty |
| `settings` | Supported TOML/JSON or settings file. | Empty |
| `plugins` | Native Codex plugin names. | Empty |
| `plugin_marketplaces` | Native Codex marketplace sources. | Empty |

## Outputs

| Output           | Description                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| `conclusion`     | success or failure.                                                           |
| `execution_file` | Redacted JSON report at RUNNER_TEMP/codex-execution-output.json.              |
| `session_id`     | Codex thread ID for report correlation. Ephemeral sessions cannot be resumed. |

The report keeps assistant messages, terminal status, and available token usage in the shape used by the main action's execution tracker. Failure transcripts are also written when the process fails, times out, emits invalid output, or is cancelled. MCP servers preserve stdio command/args/env configuration or streamable HTTP URL, headers, and bearer token environment authentication. Unsupported transports or fields fail clearly.

For a custom working directory, set CODEX_WORKING_DIR in the step environment. Additional request text can be placed in codex-user-request.txt alongside a supplied prompt file.

## Development

Run `bun install`, `bun test`, and `bun run typecheck` in this directory. Tests use a local fake CLI and require no API key or live model calls.

The original MIT license and attribution are preserved in LICENSE.

## Adapted configuration inputs

The base action preserves prompt/file execution, custom MCP servers, appended
instructions, and structured output. `codex_args` accepts translated model,
effort, MCP, schema, and tool options; `claude_args` remains a compatibility
alias. `settings` accepts supported Codex TOML/JSON (inline or a file) and
supported legacy model/env/permission settings. `plugins` and
`plugin_marketplaces` install native Codex plugins into the disposable home.
Plugin manifests must match Codex; Claude-specific plugin manifests are not
claimed compatible. Explicit `.claude/commands` and `.codex/commands` slash
commands are expanded as instructions before execution.

`structured_output` contains the JSON final result requested by
`--json-schema` or `--output-schema`. Unsupported controls such as Claude's
`--max-turns` and patterned Bash/individual Read/Edit/Write permission policies
fail clearly because Codex exec has no equivalent.

Nonsecret build/test variables from the workflow environment and `settings.env` reach Codex tools. Reserved runtime controls and credential variables remain excluded.

## Trust model

The base action runs the supplied prompt in the caller's working directory. It does not perform the main action's actor checks, fork guards, tracking comments, or base-branch configuration restoration. The caller must trust the checkout, prompt, and configured MCP/plugin servers. Use the [main action](../README.md) when you need those GitHub boundaries. Read-only sandboxing restricts repository writes; it does not make untrusted prompt content safe or remove MCP write capabilities.

## Runtime Environment

Use `CODEX_WORKING_DIR` for an explicit working directory. Nonsecret build/test variables from the workflow step and supported `settings.env` reach the model's tools; runtime controls and credentials are excluded. The former `NODE_VERSION` runtime selector is not used by this Codex action. Set `codex_version` or supply `path_to_codex_executable` instead.

## Usage

Add the following to your workflow file:

```yaml
# Using a direct prompt
- name: Run Codex with direct prompt
  uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
  with:
    prompt: "Your prompt here"
    codex_args: '--allowedTools "Bash(git:*),Read,Glob,Grep"'
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}

# Or using a prompt from a file
- name: Run Codex with prompt file
  uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
  with:
    prompt_file: "/path/to/prompt.txt"
    codex_args: '--allowedTools "Bash(git:*),Read,Glob,Grep"'
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}

# Bound execution time (Codex has no turn-limit equivalent)
- name: Run Codex with a time limit
  uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
  with:
    prompt: "Your prompt here"
    codex_args: |
      --allowedTools "Bash(git:*),Read,Glob,Grep"
    codex_timeout_minutes: 5
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}

# Append custom instructions (the Codex system prompt is not replaced)
- name: Run Codex with custom instructions
  uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
  with:
    prompt: "Build a REST API"
    codex_args: |
      --append-system-prompt "You are a senior backend engineer. Focus on security, performance, and maintainability."
      --allowedTools "Bash(git:*),Read,Glob,Grep"
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}

# Or appending to the default system prompt
- name: Run Codex with appended system prompt
  uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
  with:
    prompt: "Create a database schema"
    codex_args: |
      --append-system-prompt "After writing code, be sure to code review yourself."
      --allowedTools "Bash(git:*),Read,Glob,Grep"
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}

# Using custom environment variables
- name: Run Codex with custom environment variables
  uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
  with:
    prompt: "Deploy to staging environment"
    settings: |
      {
        "env": {
          "ENVIRONMENT": "staging",
          "API_URL": "https://api-staging.example.com",
          "DEBUG": "true"
        }
      }
    codex_args: '--allowedTools "Bash(git:*),Read,Glob,Grep"'
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

## Custom Environment Variables

You can pass custom environment variables to Codex through the `env` object in `settings`:

```yaml
- name: Deploy with custom environment
  uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
  with:
    prompt: "Deploy the application to the staging environment"
    settings: |
      {
        "env": {
          "ENVIRONMENT": "staging",
          "API_BASE_URL": "https://api-staging.example.com",
          "DATABASE_URL": "postgres://localhost/staging",
          "DEBUG": "true",
          "LOG_LEVEL": "debug"
        }
      }
    codex_args: '--allowedTools "Bash(git:*),Read,Glob,Grep"'
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

The `settings` input accepts either inline JSON or a path to a settings JSON file. Values in the `env` object are available during the Codex session and can reference GitHub secrets.

Reserved runtime controls and credential-like variables are excluded from tool environments. Supply MCP-specific credentials only in that server's explicit MCP configuration.

## Using Settings Configuration

`settings` accepts supported inline TOML, JSON, or a file. Native fields include model, reasoning effort/summary, verbosity, developer instructions, web search, supported tool features, and MCP servers. Legacy `model`, `env`, and simple `permissions.allow` / `permissions.deny` are adapted. Claude hooks, arbitrary Claude settings, and full patterned permission policies are unsupported and fail clearly.

```yaml
- uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    prompt: "Review the repository."
    settings: |
      model_reasoning_effort = "medium"
      web_search = "disabled"
```

## Using MCP Config

You can provide MCP configuration in two ways:

### Option 1: MCP Configuration File

Provide a path to a JSON file containing MCP configuration:

```yaml
- name: Run Codex with MCP config file
  uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
  with:
    prompt: "Your prompt here"
    codex_args: |
      --mcp-config "path/to/mcp-config.json"
      --allowedTools "Bash(git:*),Read,Glob,Grep"
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

### Option 2: Inline MCP Configuration

Provide the MCP configuration directly as a JSON string:

```yaml
- name: Run Codex with inline MCP config
  uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
  with:
    prompt: "Your prompt here"
    codex_args: >-
      --mcp-config '{"mcpServers":{"server-name":{"command":"node","args":["./server.js"],"env":{"API_KEY":"${{ secrets.CUSTOM_MCP_API_KEY }}"}}}}'
      --allowedTools "Bash(git:*),Read,Glob,Grep"
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

The MCP config file should follow this format:

```json
{
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["./server.js"],
      "env": {
        "API_KEY": "${{ secrets.CUSTOM_MCP_API_KEY }}"
      }
    }
  }
}
```

You can combine MCP config with other inputs like allowed tools:

```yaml
# Using multiple inputs together
- name: Run Codex with MCP and custom tools
  uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
  with:
    prompt: "Access the custom MCP server and use its tools"
    codex_args: |
      --mcp-config "mcp-config.json"
      --allowedTools "Bash(git:*),Read,mcp__server-name__custom_tool"
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

## Example: PR Code Review

```yaml
name: Codex Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  code-review:
    # This base action does not apply actor/fork guards. Restrict the review
    # to trusted same-repository PRs; use the main action for its actor checks.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout code
        uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: Run Code Review with Codex
        id: code-review
        uses: coryparrry/claude-code-action/base-action@codex/openai-runtime
        with:
          prompt: "Review the PR changes. Focus on code quality, potential bugs, and performance issues. Suggest improvements where appropriate. Write your review as markdown text."
          codex_args: '--allowedTools "Bash(git diff --name-only HEAD~1),Bash(git diff HEAD~1),Read,Glob,Grep,Write"'
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}

      - name: Extract and Comment PR Review
        if: steps.code-review.outputs.conclusion == 'success'
        uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const fs = require('fs');
            const executionFile = '${{ steps.code-review.outputs.execution_file }}';
            const executionLog = JSON.parse(fs.readFileSync(executionFile, 'utf8'));

            // Extract the review content from the execution log.
            // The SDK writes top-level events with `type`; assistant text is nested
            // under `message.content`.
            let review = '';

            // Prefer the final result event when it is available.
            for (let i = executionLog.length - 1; i >= 0; i--) {
              const entry = executionLog[i];
              if (entry?.type === 'result' && typeof entry.result === 'string') {
                review = entry.result;
                break;
              }
            }

            // Fallback to the last assistant text block if no result event was written.
            if (!review) {
              for (let i = executionLog.length - 1; i >= 0; i--) {
                const entry = executionLog[i];
                if (entry?.type !== 'assistant' || !Array.isArray(entry.message?.content)) {
                  continue;
                }

                review = entry.message.content
                  .filter((block) => block?.type === 'text' && typeof block.text === 'string')
                  .map((block) => block.text)
                  .join('\n');

                if (review) {
                  break;
                }
              }
            }

            if (review) {
              github.rest.issues.createComment({
                issue_number: context.issue.number,
                owner: context.repo.owner,
                repo: context.repo.repo,
                body: "## Codex Review\n\n" + review + "\n\n*Generated by Codex*"
              });
            }
```

For typed automation output, prefer passing `--json-schema` in `codex_args`
and reading `steps.<id>.outputs.structured_output` instead of parsing the full
execution log.

Check out additional examples in [`./examples`](./examples).

## Security Best Practices

**⚠️ IMPORTANT: Never commit API keys directly to your repository! Always use GitHub Actions secrets.**

To securely use your Anthropic API key:

1. Add your API key as a repository secret:

   - Go to your repository's Settings
   - Navigate to "Secrets and variables" → "Actions"
   - Click "New repository secret"
   - Name it `OPENAI_API_KEY`
   - Paste your API key as the value

2. Reference the secret in your workflow:
   ```yaml
   openai_api_key: ${{ secrets.OPENAI_API_KEY }}
   ```

**Never do this:**

```yaml
# ❌ WRONG - Exposes your API key
openai_api_key: "sk-example-..."
```

**Always do this:**

```yaml
# ✅ CORRECT - Uses GitHub secrets
openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

This applies to all sensitive values including API keys, access tokens, and credentials.
We also recommend that you always use short-lived tokens when possible

## Historical upstream configuration

The following original examples document Anthropic upstream behavior. OAuth, WIF, Bedrock, Vertex, fallback models, hooks, and `--max-turns` are not working Codex controls. OpenAI API keys authenticate this fork; `codex_timeout_minutes` bounds elapsed time, not turns or spend.

<details>
<summary>Original provider and settings examples (historical only)</summary>

```yaml
# Using fallback model for handling API errors
- name: Run Claude Code with fallback model
  uses: anthropics/claude-code-base-action@beta
  with:
    prompt: "Review and fix TypeScript errors"
    claude_args: |
      --model "claude-opus-4-1-20250805"
      --fallback-model "claude-sonnet-4-20250514"
      --allowedTools "Bash(git:*),Read,Glob,Grep"
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}

# Using OAuth token instead of API key
- name: Run Claude Code with OAuth token
  uses: anthropics/claude-code-base-action@beta
  with:
    prompt: "Update dependencies"
    claude_args: '--allowedTools "Bash(git:*),Read,Glob,Grep"'
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

### Workload Identity Federation

Instead of a static API key or OAuth token, you can authenticate via [Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation): the action fetches the workflow's GitHub OIDC token and the Claude Code CLI exchanges it for a short-lived access token. Requires the `id-token: write` permission on the job:

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - name: Run Claude Code with workload identity federation
    uses: anthropics/claude-code-base-action@beta
    with:
      prompt: "Your prompt here"
      anthropic_federation_rule_id: fdrl_xxxxxxxxxxxx
      anthropic_organization_id: 00000000-0000-0000-0000-000000000000
      anthropic_service_account_id: svac_xxxxxxxxxxxx
```

Do not set `anthropic_api_key` or `claude_code_oauth_token` alongside the federation inputs — a static credential takes precedence and federation will not be used.

## Using Settings Configuration

You can provide Claude Code settings configuration in two ways:

### Option 1: Settings Configuration File

Provide a path to a JSON file containing Claude Code settings:

```yaml
- name: Run Claude Code with settings file
  uses: anthropics/claude-code-base-action@beta
  with:
    prompt: "Your prompt here"
    settings: "path/to/settings.json"
    claude_args: '--allowedTools "Bash(git:*),Read,Glob,Grep"'
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Option 2: Inline Settings Configuration

Provide the settings configuration directly as a JSON string:

```yaml
- name: Run Claude Code with inline settings
  uses: anthropics/claude-code-base-action@beta
  with:
    prompt: "Your prompt here"
    settings: |
      {
        "model": "claude-opus-4-1-20250805",
        "env": {
          "DEBUG": "true",
          "API_URL": "https://api.example.com"
        },
        "permissions": {
          "allow": ["Bash", "Read"],
          "deny": ["WebFetch"]
        },
        "hooks": {
          "PreToolUse": [{
            "matcher": "Bash",
            "hooks": [{
              "type": "command",
              "command": "echo Running bash command..."
            }]
          }]
        }
      }
    claude_args: '--allowedTools "Bash(git:*),Read,Glob,Grep"'
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The settings file supports all Claude Code settings options including:

- `model`: Override the default model
- `env`: Environment variables for the session
- `permissions`: Tool usage permissions
- `hooks`: Pre/post tool execution hooks
- `includeCoAuthoredBy`: Include co-authored-by in git commits
- And more...

**Note**: The `enableAllProjectMcpServers` setting is always set to `true` by this action to ensure MCP servers work correctly.

## Using Cloud Providers

You can authenticate with Claude using any of these methods:

1. Direct Anthropic API (default) - requires API key or OAuth token
2. Amazon Bedrock - requires OIDC authentication and automatically uses cross-region inference profiles
3. Google Vertex AI - requires OIDC authentication

**Note**:

- Bedrock and Vertex use OIDC authentication exclusively
- AWS Bedrock automatically uses cross-region inference profiles for certain models
- For cross-region inference profile models, you need to request and be granted access to the Claude models in all regions that the inference profile uses
- The Bedrock API endpoint URL is automatically constructed using the AWS_REGION environment variable (e.g., `https://bedrock-runtime.us-west-2.amazonaws.com`)
- You can override the Bedrock API endpoint URL by setting the `ANTHROPIC_BEDROCK_BASE_URL` environment variable

### Model Configuration

Use provider-specific model names based on your chosen provider:

```yaml
# For direct Anthropic API (default)
- name: Run Claude Code with Anthropic API
  uses: anthropics/claude-code-base-action@beta
  with:
    prompt: "Your prompt here"
    claude_args: "--model claude-3-7-sonnet-20250219"
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}

# For Amazon Bedrock (requires OIDC authentication)
- name: Configure AWS Credentials (OIDC)
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}
    aws-region: us-west-2

- name: Run Claude Code with Bedrock
  uses: anthropics/claude-code-base-action@beta
  with:
    prompt: "Your prompt here"
    claude_args: "--model anthropic.claude-3-7-sonnet-20250219-v1:0"
    use_bedrock: "true"

# For Google Vertex AI (requires OIDC authentication)
- name: Authenticate to Google Cloud
  uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
    service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}

- name: Run Claude Code with Vertex AI
  uses: anthropics/claude-code-base-action@beta
  with:
    prompt: "Your prompt here"
    claude_args: "--model claude-3-7-sonnet@20250219"
    use_vertex: "true"
```

## Example: Using OIDC Authentication for AWS Bedrock

This example shows how to use OIDC authentication with AWS Bedrock:

```yaml
- name: Configure AWS Credentials (OIDC)
  uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}
    aws-region: us-west-2

- name: Run Claude Code with AWS OIDC
  uses: anthropics/claude-code-base-action@beta
  with:
    prompt: "Your prompt here"
    use_bedrock: "true"
    claude_args: |
      --model "anthropic.claude-3-7-sonnet-20250219-v1:0"
      --allowedTools "Bash(git:*),Read,Glob,Grep"
```

## Example: Using OIDC Authentication for GCP Vertex AI

This example shows how to use OIDC authentication with GCP Vertex AI:

```yaml
- name: Authenticate to Google Cloud
  uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
    service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}

- name: Run Claude Code with GCP OIDC
  uses: anthropics/claude-code-base-action@beta
  with:
    prompt: "Your prompt here"
    use_vertex: "true"
    claude_args: |
      --model "claude-3-7-sonnet@20250219"
      --allowedTools "Bash(git:*),Read,Glob,Grep"
```

</details>
