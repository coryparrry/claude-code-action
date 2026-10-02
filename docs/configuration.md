# Advanced Configuration

> This fork runs OpenAI models through the OpenAI Agents SDK. It preserves the upstream GitHub workflow and adapts runtime controls. See the [feature comparison](./feature-parity.md) for verified coverage and remaining differences.

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
          # Now Codex can respond to "/codex why did the CI fail?"
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
          "DATABASE_URL": "postgres://localhost:5432/test_db"
        }
      }
    # ... other inputs
```

These environment variables will be available to Codex during execution, allowing it to run tests, build processes, or other commands that depend on specific environment configurations.

</details>

## Time and Cost Bounds

`max_turns` or `--max-turns` bounds model turns. `max_budget_usd` bounds estimated usage costs after each response; it is not an account spending cap. Set job `timeout-minutes` for elapsed time. Luna, Sol and Astra have built-in standard token rates, including cached input and long-context rates. Other models require `settings.modelPrices` when a USD limit is set.

## Custom Tools

Tool policy supports names, MCP server/tool rules, Bash command prefixes and wildcards, file scopes, and WebFetch domains. Read-only and workspace-write policies protect registered file tools; they do not provide operating-system isolation for Bash or arbitrary MCP servers.

By default, Codex only has access to:

- File operations (reading, committing, editing files, read-only git commands)
- Comment management (creating/updating comments)
- Basic GitHub operations

Use the compatibility tool filters to select supported command and MCP capabilities for your workflow:

**Note**: Pass custom stdio or streamable HTTP servers explicitly through `--mcp-config` or supported `settings` MCP keys. HTTP servers accept `url`, `headers` (or `http_headers`), and `bearer_token_env_var`; SSE transport is supported as well. The action loads supported project configuration before SDK execution.

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    claude_args: |
      --allowedTools "Bash(npm install),Bash(npm run test),Edit,Read,Write"
      --disallowedTools "Bash(rm:*)"
    # ... other inputs
```

**Note**: Tool filters apply to registered local and GitHub/MCP tools. `--disallowedTools` takes priority over allow rules.

## Custom Model

Specify a Codex model using `claude_args`:

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    claude_args: |
      --model gpt-6-luna
    # ... other inputs
```

## Codex Settings

You can provide Codex settings to customize behavior such as model selection and supported permissions, and supported permissions. Settings can be provided either as a JSON string or a path to a settings file.

### Option 1: Settings File

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    settings: "path/to/settings.json"
    # ... other inputs
```

### Native Codex Configuration

`settings` accepts inline TOML or JSON, or a settings file. Supported configuration includes model, permissions, nonsecret environment, hooks, MCP servers, commands, skills, agents and plugins. Native reasoning summary, verbosity, shell, edit and web-search controls are mapped to SDK settings and tools. `codex_args` and the `claude_args` alias use the same validated action-control parser. Unsupported arguments fail instead of silently doing nothing.

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
| `model`               | Use `claude_args: "--model gpt-6-luna"`                         |
| `claude_env`          | Workflow step `env` or nonsecret `settings.env`                 |
| `custom_instructions` | Use `claude_args: "--append-system-prompt 'Your instructions'"` |
| `mcp_config`          | Use `claude_args: "--mcp-config '{...}'"`                       |
| `direct_prompt`       | Use `prompt` input instead                                      |
| `override_prompt`     | Use `prompt` with GitHub context variables                      |

## Custom Executables for Specialized Environments

For specialized environments like Nix, custom container setups, or other package management systems where the default installation doesn't work, you can provide your own executables:

Execution uses the pinned OpenAI Agents SDK. A custom Codex CLI executable is not an action input.

### Custom Bun Executable

Use `path_to_bun_executable` to provide your own Bun runtime instead of the default installation:

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    path_to_bun_executable: "/path/to/custom/bun"
    # ... other inputs
```

**Important**: Using incompatible versions may cause the action to fail. Ensure your custom executables are compatible with the action's requirements.
