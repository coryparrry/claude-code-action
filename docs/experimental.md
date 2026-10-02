# Experimental Features

> This fork runs OpenAI models through the OpenAI Agents SDK. Use `codex_args` for supported action controls; `claude_args` is a compatibility alias. Fork PRs are rejected before execution. Start with the [current workflow](../README.md#quickstart), [provider setup](./cloud-providers.md), and [feature comparison](./feature-parity.md). Historical Claude-specific examples do not establish support in this runtime.

**Note:** Experimental features are considered unstable and not supported for production use. They may change or be removed at any time.

## Automatic Mode Detection

The action intelligently detects the appropriate execution mode based on your workflow context, eliminating the need for manual mode configuration.

### Interactive Mode (Tag Mode)

Activated when Codex detects @mentions, issue assignments, or labels—without an explicit `prompt`.

- **Triggers**: `/codex` mentions in comments, issue assignment to claude user, label application
- **Features**: Creates tracking comments with progress checkboxes, full implementation capabilities
- **Use case**: Interactive code assistance, Q&A, and implementation requests

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    # No prompt needed - responds to /codex mentions
```

### Automation Mode (Agent Mode)

Automatically activated when you provide a `prompt` input.

- **Triggers**: Any GitHub event when `prompt` input is provided
- **Features**: Direct execution without requiring /codex mentions, streamlined for automation
- **Use case**: Automated PR reviews, scheduled tasks, workflow automation

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    prompt: |
      Check for outdated dependencies and create an issue if any are found.
    # Automatically runs in agent mode when prompt is provided
```

### How It Works

The action uses this logic to determine the mode:

1. **If `prompt` is provided** → Runs in **agent mode** for automation
2. **If no `prompt` but /codex is mentioned** → Runs in **tag mode** for interaction
3. **If neither** → No action is taken

This automatic detection ensures your workflows are simpler and more intuitive, without needing to understand or configure different modes.

### Advanced Mode Control

For specialized use cases, you can fine-tune behavior using `claude_args`:

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    prompt: "Review this PR"
    claude_args: |
      --append-system-prompt "You are a code review specialist"
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
```
