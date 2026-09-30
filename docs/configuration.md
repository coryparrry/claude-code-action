# Advanced Configuration

> This fork runs Codex with `OPENAI_API_KEY`. GitHub triggers, tracking comments, branch handling, signing, and MCP integrations retain the upstream workflow shape. `claude_args` is a compatibility alias; use the preferred `codex_args` name for the same supported argument subset. Legacy `--allowedTools` / `--disallowedTools` support MCP names and simple Bash rules, not the full Claude permission language. Use a supported OpenAI model; there is no native `--max-turns`, Anthropic OAuth, WIF, Bedrock, or Vertex backend. Fork pull requests are rejected. See [configuration](./configuration.md) and [the action inputs](../action.yml).

## Using Custom MCP Configuration

You can add custom MCP (Model Context Protocol) servers to extend Codex's capabilities using the `--mcp-config` flag in `claude_args`. These servers merge with the built-in GitHub MCP servers.

### Basic Example: Adding a Sequential Thinking Server

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    claude_args: |
      --mcp-config '{"mcpServers": {"sequential-thinking": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]}}}'
      --allowedTools mcp__sequential-thinking__sequentialthinking
    # ... other inputs
```

### Passing Secrets to MCP Servers

For MCP servers that require sensitive information like API keys or tokens, you can create a configuration file with GitHub Secrets:

```yaml
- name: Create MCP Config
  run: |
    cat > /tmp/mcp-config.json << 'EOF'
    {
      "mcpServers": {
        "custom-api-server": {
          "command": "npx",
          "args": ["-y", "@example/api-server"],
          "env": {
            "API_KEY": "${{ secrets.CUSTOM_API_KEY }}",
            "BASE_URL": "https://api.example.com"
          }
        }
      }
    }
    EOF

- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    claude_args: |
      --mcp-config /tmp/mcp-config.json
    # ... other inputs
```

### Using Python MCP Servers with uv

For Python-based MCP servers managed with `uv`, you need to specify the directory containing your server:

```yaml
- name: Create MCP Config for Python Server
  run: |
    cat > /tmp/mcp-config.json << 'EOF'
    {
      "mcpServers": {
        "my-python-server": {
          "type": "stdio",
          "command": "uv",
          "args": [
            "--directory",
            "${{ github.workspace }}/path/to/server/",
            "run",
            "server_file.py"
          ]
        }
      }
    }
    EOF

- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    claude_args: |
      --mcp-config /tmp/mcp-config.json
      --allowedTools my-python-server__<tool_name>  # Replace <tool_name> with your server's tool names
    # ... other inputs
```

For example, if your Python MCP server is at `mcp_servers/weather.py`, you would use:

```yaml
"args":
  ["--directory", "${{ github.workspace }}/mcp_servers/", "run", "weather.py"]
```

### Multiple MCP Servers

You can add multiple MCP servers by using multiple `--mcp-config` flags:

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    claude_args: |
      --mcp-config /tmp/config1.json
      --mcp-config /tmp/config2.json
      --mcp-config '{"mcpServers": {"inline-server": {"command": "npx", "args": ["@example/server"]}}}'
    # ... other inputs
```

**Important**:

- Always use GitHub Secrets (`${{ secrets.SECRET_NAME }}`) for sensitive values like API keys, tokens, or passwords. Never hardcode secrets directly in the workflow file.
- Your custom servers will override any built-in servers with the same name.
- The `claude_args` supports multiple `--mcp-config` flags that will be merged together.

## Additional Permissions for CI/CD Integration

The `additional_permissions` input allows Codex to access GitHub Actions workflow information when you grant the necessary permissions. This is particularly useful for analyzing CI/CD failures and debugging workflow issues.

### Enabling GitHub Actions Access

To allow Codex to view workflow run results, job logs, and CI status:

1. **Grant the necessary permission to your GitHub token**:

   - When using the default `GITHUB_TOKEN`, add the `actions: read` permission to your workflow:

   ```yaml
   permissions:
     contents: write
     pull-requests: write
     issues: write
     actions: read # Add this line
   ```

2. **Configure the action with additional permissions**:

   ```yaml
   - uses: coryparrry/claude-code-action@codex/openai-runtime
     with:
       openai_api_key: ${{ secrets.OPENAI_API_KEY }}
       github_token: ${{ secrets.GITHUB_TOKEN }}
       additional_permissions: |
         actions: read
       # ... other inputs
   ```

3. **Codex will automatically get access to CI/CD tools**:
   When you enable `actions: read`, Codex can use the following MCP tools:
   - `mcp__github_ci__get_ci_status` - View workflow run statuses
   - `mcp__github_ci__get_workflow_run_details` - Get detailed workflow information
   - `mcp__github_ci__download_job_log` - Download and analyze job logs

### Example: Debugging Failed CI Runs

```yaml
name: Codex CI Helper
on:
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write
  actions: read # Required for CI access

jobs:
  codex-ci-helper:
    runs-on: ubuntu-latest
    steps:
      - uses: coryparrry/claude-code-action@codex/openai-runtime
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
          additional_permissions: |
            actions: read
          # Now Codex can respond to "@codex why did the CI fail?"
```

**Important Notes**:

- The GitHub token must have the corresponding permission in your workflow
- If the permission is missing, Codex will warn you and suggest adding it
- The following additional permissions can be requested beyond the defaults:
  - `actions: read`
  - `checks: read`
  - `discussions: read` or `discussions: write`
  - `workflows: read` or `workflows: write`
- Standard permissions (`contents: write`, `pull_requests: write`, `issues: write`) are always included and do not need to be specified

## Custom Environment Variables

Set environment variables on the action step using GitHub Actions `env:`. Nonsecret legacy `settings.env` values are supported; reserved runtime controls and credential variables are excluded. Do not place model or GitHub credentials into custom settings or MCP environment values.

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  env:
    NODE_ENV: test
    CI: "true"
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

<details>
<summary>settings.env example (nonsecret values only)</summary>

## Custom Environment Variables

You can pass custom environment variables to Codex execution using the `settings` input. This is useful for CI/test setups that require specific environment variables:

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    settings: |
      {
        "env": {
          "NODE_ENV": "test",
          "CI": "true",
          "DATABASE_URL": "postgres://test:test@localhost:5432/test_db"
        }
      }
    # ... other inputs
```

These environment variables will be available to Codex during execution, allowing it to run tests, build processes, or other commands that depend on specific environment configurations.

</details>

<details>
<summary>Historical upstream reference — not supported by the Codex runtime</summary>

## Limiting Conversation Turns

You can limit the number of back-and-forth exchanges Claude can have during task execution using the `claude_args` input. This is useful for:

- Controlling costs by preventing runaway conversations
- Setting time boundaries for automated workflows
- Ensuring predictable behavior in CI/CD pipelines

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    claude_args: |
      --max-turns 5  # Limit to 5 conversation turns
    # ... other inputs
```

When the turn limit is reached, Claude will stop execution gracefully. Choose a value that gives Claude enough turns to complete typical tasks while preventing excessive usage.

</details>

## Time and Cost Bounds

Codex has no `--max-turns` equivalent. Set `timeout-minutes` on the GitHub job to bound elapsed time; this is not a turn or spend limit.

## Custom Tools

The compatibility bridge filters the action MCP servers and supports simple Bash rules. Codex file and shell capabilities also depend on the sandbox and config; the full Claude tool/permission system is not reproduced. Complex Claude patterns fail rather than silently broadening permissions.

By default, Codex only has access to:

- File operations (reading, committing, editing files, read-only git commands)
- Comment management (creating/updating comments)
- Basic GitHub operations

Use the compatibility tool filters to select supported command and MCP capabilities for your workflow:

**Note**: Pass custom stdio or streamable HTTP servers explicitly through `--mcp-config` or supported `settings` MCP keys. HTTP servers accept `url`, `headers` (or `http_headers`), and `bearer_token_env_var`; legacy SSE transport has no native translation. Do not assume Claude project configuration files are loaded by native Codex.

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    claude_args: |
      --allowedTools "Bash(npm install),Bash(npm run test),Edit,Read,Write"
      --disallowedTools "Bash(rm:*)"
    # ... other inputs
```

**Note**: The base GitHub tools are always included. Use `--allowedTools` to add additional tools (including specific Bash commands), and `--disallowedTools` to prevent specific tools from being used.

## Custom Model

Specify a Codex model using `claude_args`:

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    claude_args: |
      --model gpt-5.4
    # ... other inputs
```

<details>
<summary>Historical upstream reference — not supported by the Codex runtime</summary>

For provider-specific models:

```yaml
# AWS Bedrock
- uses: anthropics/claude-code-action@v1
  with:
    use_bedrock: "true"
    claude_args: |
      --model anthropic.claude-4-0-sonnet-20250805-v1:0
    # ... other inputs

# Google Vertex AI
- uses: anthropics/claude-code-action@v1
  with:
    use_vertex: "true"
    claude_args: |
      --model claude-4-0-sonnet@20250805
    # ... other inputs
```

### 1M context models through an API gateway

When `ANTHROPIC_BASE_URL` points to an Anthropic-compatible API gateway,
Claude Code may not be able to verify that the gateway supports a model's native
1M context window and can budget the session at 200K instead. Append the
`[1m]` selector to explicitly use the 1M context window for supported models,
including Claude Opus 5 and Claude Sonnet 5:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    claude_args: |
      --model "claude-opus-5[1m]"
    # ... other inputs
```

Use the same selector when setting a model through `ANTHROPIC_MODEL` or another
Claude Code model environment variable. The selector is resolved by Claude Code
before requests are sent to the provider. The action's sanitized result output
includes each model's resolved
`contextWindow` and `maxOutputTokens` under `modelUsage`, so these limits are
visible without enabling `show_full_output`.

</details>

## Codex Settings

You can provide Codex settings to customize behavior such as model selection and supported permissions, and supported permissions. Settings can be provided either as a JSON string or a path to a settings file.

### Option 1: Settings File

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    settings: "path/to/settings.json"
    # ... other inputs
```

<details>
<summary>Historical upstream reference — not supported by the Codex runtime</summary>

### Option 2: Inline Settings

```yaml
- uses: anthropics/claude-code-action@v1
  with:
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
    # ... other inputs
```

The settings support all Claude Code settings options including:

- `model`: Override the default model
- `env`: Nonsecret build and test values are supported; credential and runtime variables are excluded
- `permissions`: Tool usage permissions
- `hooks`: Pre/post tool execution hooks
- And more...

For a complete list of available settings and their descriptions, see the [Claude Code settings documentation](https://docs.anthropic.com/en/docs/claude-code/settings).

**Notes**:

- The `enableAllProjectMcpServers` setting is always set to `true` by this action to ensure MCP servers work correctly.
- The `claude_args` input provides direct access to Claude Code CLI arguments and takes precedence over settings.
- We recommend using `claude_args` for simple configurations and `settings` for complex configurations with hooks and environment variables.

</details>

### Native Codex Configuration

`settings` accepts inline TOML or JSON, or a settings file. Native settings use Codex configuration keys. Supported legacy JSON fields are `model`, `permissions`, and nonsecret `env` values; reserved credential/runtime variables are excluded; Claude hooks and other Claude settings are not supported. `codex_args` uses the same supported argument parser; `claude_args` translates only the documented compatibility subset.

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    settings: |
      model_reasoning_effort = "medium"
```

## Migration from Deprecated Inputs

Many individual input parameters have been consolidated into `claude_args` or `settings`. Here's how to migrate:

| Old Input             | New Approach                                                    |
| --------------------- | --------------------------------------------------------------- |
| `allowed_tools`       | Use `claude_args: "--allowedTools Tool1,Tool2"`                 |
| `disallowed_tools`    | Use `claude_args: "--disallowedTools Tool1,Tool2"`              |
| `max_turns`           | No native equivalent; use job `timeout-minutes` to bound time   |
| `model`               | Use `claude_args: "--model gpt-5.4"`                            |
| `claude_env`          | Workflow step `env` or nonsecret `settings.env`                 |
| `custom_instructions` | Use `claude_args: "--append-system-prompt 'Your instructions'"` |
| `mcp_config`          | Use `claude_args: "--mcp-config '{...}'"`                       |
| `direct_prompt`       | Use `prompt` input instead                                      |
| `override_prompt`     | Use `prompt` with GitHub context variables                      |

## Custom Executables for Specialized Environments

For specialized environments like Nix, custom container setups, or other package management systems where the default installation doesn't work, you can provide your own executables:

### Custom Codex Executable

Use `path_to_codex_executable` to provide your own Codex binary instead of using the automatically installed version:

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    path_to_codex_executable: "/path/to/custom/codex"
    # ... other inputs
```

### Custom Bun Executable

Use `path_to_bun_executable` to provide your own Bun runtime instead of the default installation:

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    path_to_bun_executable: "/path/to/custom/bun"
    # ... other inputs
```

**Important**: Using incompatible versions may cause the action to fail. Ensure your custom executables are compatible with the action's requirements.
