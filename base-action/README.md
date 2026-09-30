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

| Input                      | Description                                                        | Default         |
| -------------------------- | ------------------------------------------------------------------ | --------------- |
| `prompt`                   | Inline prompt; specify exactly one prompt input.                   | Empty           |
| `prompt_file`              | Path to a non-empty prompt file.                                   | Empty           |
| `openai_api_key`           | Required OpenAI API key.                                           | Required        |
| `codex_model`              | Optional model name.                                               | CLI default     |
| `codex_effort`             | none, minimal, low, medium, high, or xhigh.                        | CLI default     |
| `codex_sandbox`            | read-only or workspace-write.                                      | workspace-write |
| `codex_version`            | Exact CLI version installed when no custom executable is provided. | 0.159.2         |
| `codex_timeout_minutes`    | Positive integer process timeout in minutes.                       | 30              |
| `mcp_config`               | JSON with an mcpServers object containing stdio servers.           | Empty servers   |
| `append_system_prompt`     | Additional instructions appended to the prompt.                    | Empty           |
| `path_to_codex_executable` | Custom Codex CLI path; skips installation.                         | Empty           |
| `path_to_bun_executable`   | Custom Bun executable path; skips installation.                    | Empty           |
| `show_full_output`         | Log redacted JSON events when true.                                | false           |

## Outputs

| Output           | Description                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| `conclusion`     | success or failure.                                                           |
| `execution_file` | Redacted JSON report at RUNNER_TEMP/codex-execution-output.json.              |
| `session_id`     | Codex thread ID for report correlation. Ephemeral sessions cannot be resumed. |

The report keeps assistant messages, terminal status, and available token usage in the shape used by the main action's execution tracker. Failure transcripts are also written when the process fails, times out, emits invalid output, or is cancelled. MCP servers support command, string args, and string env fields; HTTP servers and unknown fields are rejected.

For a custom working directory, set CODEX_WORKING_DIR in the step environment. Additional request text can be placed in codex-user-request.txt alongside a supplied prompt file.

## Development

Run `bun install`, `bun test`, and `bun run typecheck` in this directory. Tests use a local fake CLI and require no API key or live model calls.

The original MIT license and attribution are preserved in LICENSE.
