# Codex Base Action

Run a Codex model through the OpenAI Agents SDK with an inline prompt or a prompt file. This base action skips the GitHub trigger and comment orchestration in the repository's main action.

Use the base action from your copy of this fork:

```yaml
- uses: actions/checkout@v4
- uses: your-owner/your-fork/base-action@your-pinned-ref
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    prompt: "Review the repository and describe any clear defects."
    codex_sandbox: read-only
```

Authentication supports an OpenAI API key, OpenAI workload identity federation, Amazon Bedrock bearer credentials, or Azure OpenAI credentials. The runtime uses `@openai/agents` pinned to `0.18.0` with the OpenAI Responses API and `gpt-6-luna` by default. The Agents SDK owns the model/tool loop; this action does not install or run the Codex CLI, Claude Code, or the Claude Agent SDK. Agent tools enforce the configured read-only or workspace-write policy; unattended permission decisions follow the supplied tool policy. The runtime restricts inherited environment variables and redacts known credentials from logs and execution reports. Workspace-write permits repository changes; review those changes before publishing them.

## Inputs

| Input                         | Description                                                              | Default             |
| ----------------------------- | ------------------------------------------------------------------------ | ------------------- |
| `prompt`                      | Inline prompt; specify exactly one of prompt or prompt_file              | Empty               |
| `prompt_file`                 | Path to a non-empty prompt file                                          | Empty               |
| `openai_api_key`              | OpenAI API key used by Codex                                             | Empty               |
| `openai_provider`             | OpenAI API provider: openai, bedrock or azure                            | Empty               |
| `openai_identity_provider_id` | OpenAI workload identity provider ID (requires id-token: write)          | Empty               |
| `openai_service_account_id`   | OpenAI workload identity mapped service account ID                       | Empty               |
| `openai_oidc_audience`        | Audience configured for the OpenAI workload identity provider            | Empty               |
| `bedrock_api_key`             | AWS Bedrock bearer token for OpenAI models; region comes from AWS_REGION | Empty               |
| `azure_openai_endpoint`       | Azure OpenAI endpoint for the selected deployment                        | Empty               |
| `azure_openai_api_key`        | Azure OpenAI API key (alternative to Azure AD token)                     | Empty               |
| `azure_openai_ad_token`       | Azure AD token for Azure OpenAI (alternative to API key)                 | Empty               |
| `codex_model`                 | OpenAI model used by the Agents SDK; defaults to gpt-6-luna              | Empty               |
| `codex_effort`                | Optional reasoning effort: none, minimal, low, medium, high, or xhigh    | Empty               |
| `codex_sandbox`               | Codex sandbox: read-only or workspace-write                              | `workspace-write`   |
| `codex_timeout_minutes`       | Positive integer timeout for the agent run                               | `30`                |
| `mcp_config`                  | JSON object with stdio or streamable HTTP mcpServers                     | `{"mcpServers":{}}` |
| `append_system_prompt`        | Additional instructions appended to the prompt                           | Empty               |
| `path_to_bun_executable`      | Use an existing Bun executable instead of installing Bun                 | Empty               |
| `show_full_output`            | Show redacted Codex events in the Actions log                            | `false`             |
| `codex_args`                  | Codex and supported legacy CLI arguments                                 | Empty               |
| `claude_args`                 | Compatibility alias for codex_args                                       | Empty               |
| `settings`                    | Codex configuration or supported legacy settings                         | Empty               |
| `plugins`                     | Newline-separated Codex plugin names                                     | Empty               |
| `plugin_marketplaces`         | Newline-separated Codex plugin marketplace sources                       | Empty               |
| `max_turns`                   | Maximum model turns before execution fails                               | Empty               |
| `max_budget_usd`              | Maximum estimated API cost in USD before execution fails                 | Empty               |
| `allowed_tools`               | Comma-separated allowed tool rules                                       | Empty               |
| `disallowed_tools`            | Comma-separated denied tool rules                                        | Empty               |
| `system_prompt`               | Replacement trusted system instructions                                  | Empty               |
| `fallback_model`              | Fallback model for eligible API failures                                 | Empty               |
| `additional_directories`      | Newline-separated additional workspace directories                       | Empty               |
| `setting_sources`             | Comma-separated settings sources: user, project, local                   | Empty               |
| `permission_mode`             | Tool permission mode for this unattended run                             | Empty               |
| `continue_session`            | Continue the latest saved session when true                              | Empty               |
| `resume_session`              | Saved session ID to resume                                               | Empty               |
| `use_node_cache`              | Enable the Node npm cache when true                                      | `false`             |

## Outputs

| Output              | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `conclusion`        | success or failure.                                              |
| `structured_output` | JSON result when an output schema is supplied.                   |
| `execution_file`    | Redacted JSON report at RUNNER_TEMP/codex-execution-output.json. |
| `session_id`        | Agent session ID for report correlation or explicit resume.      |

The report keeps assistant messages, terminal status, and available token usage in the shape used by the main action's execution tracker. Failure transcripts are also written when the process fails, times out, emits invalid output, or is cancelled. MCP servers preserve stdio command/args/env configuration or streamable HTTP URL, headers, and bearer token environment authentication through SDK integrations. Unsupported transports or fields fail clearly.

For a custom working directory, set CODEX_WORKING_DIR in the step environment. Additional request text can be placed in codex-user-request.txt alongside a supplied prompt file.

## Development

Run `bun install`, `bun test`, and `bun run typecheck` in this directory. Tests use offline model/transport fixtures and require no API key or live model calls. Their results do not establish a complete live GitHub task.

The original MIT license and attribution are preserved in LICENSE.

## Adapted configuration inputs

The Agents SDK owns the execution loop. The action registers tools, permission checks, hooks, MCP servers, commands, skills, Task subagents, and Workflow handling with that loop. `settings` and plugin/command formats are interpreted by this action. Legacy `.claude` names are accepted configuration compatibility, not a Claude runtime. No native Codex CLI is installed for execution.

`codex_args` and its `claude_args` alias accept supported action controls including model, effort, MCP, schema, tool rules, hooks/settings, and run limits. `system_prompt` replaces trusted system instructions; `append_system_prompt` appends guidance. `structured_output` contains validated JSON requested by `--json-schema` or `--output-schema`.

## Run limits, costs, and sessions

`max_turns` limits model turns; `codex_timeout_minutes` limits elapsed time. `max_budget_usd` checks an estimate from reported model token usage and the configured token-rate table after model responses. This is not an account spending cap: a response can cross the estimate before execution stops. Cached input, output tokens and standard hosted web-search call charges are included. Other separately billed tools, pricing tiers, and actual invoiced charges are not included. With a USD limit, models without a configured rate fail before a request. For a custom or fallback model, supply its rates in `settings.modelPrices`, keyed by model name, with `input`, `cachedInput`, and `output` rates in USD per million tokens; for example, `{"modelPrices":{"custom-codex":{"input":1,"cachedInput":0.1,"output":2}}}`.

`continue_session` selects the latest saved session, and `resume_session` selects a specific saved ID. History is stored on the runner and scoped to the workspace. It survives repeated runs only while that storage exists; persistence across Actions jobs requires a suitable Actions cache or other explicit storage. Protect session history as repository data and restore it only for the same trusted workspace.

## Trust model

The base action runs the supplied prompt in the caller's working directory. It does not perform the main action's actor checks, fork guards, tracking comments, or base-branch configuration restoration. The caller must trust the checkout, prompt, and configured MCP/plugin servers. Use the [main action](../README.md) when you need those GitHub boundaries. Read-only sandboxing restricts repository writes; it does not make untrusted prompt content safe or remove MCP write capabilities.

## Runtime Environment

Use `CODEX_WORKING_DIR` for an explicit working directory. Nonsecret build/test variables from the workflow step and supported `settings.env` reach the model's tools; runtime controls and credentials are excluded. `NODE_VERSION` selects the Node setup version. `use_node_cache` enables its npm cache; it does not persist agent sessions. No Codex CLI executable/version input is needed.

See [configuration](../docs/configuration.md), [authentication setup](../docs/setup.md), and the [feature comparison](../docs/feature-parity.md) for configuration and remaining differences.
