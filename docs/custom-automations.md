# Custom Automations

> This fork runs Codex with `OPENAI_API_KEY`. GitHub triggers, tracking comments, branch handling, signing, and MCP integrations retain the upstream workflow shape. `claude_args` is a compatibility alias; use the preferred `codex_args` name for the same supported argument subset. Legacy `--allowedTools` / `--disallowedTools` support MCP names and simple Bash rules, not the full Claude permission language. Use a supported OpenAI model; there is no native `--max-turns`, Anthropic OAuth, WIF, Bedrock, or Vertex backend. Fork pull requests are rejected. See [configuration](./configuration.md) and [the action inputs](../action.yml).

These examples show how to configure Codex to act automatically based on GitHub events. When you provide a `prompt` input, the action automatically runs in agent mode without requiring manual @mentions. Without a `prompt`, it runs in interactive mode, responding to /codex mentions.

## Mode Detection & Tracking Comments

The action automatically detects which mode to use based on your configuration:

- **Interactive Mode** (no `prompt` input): Responds to /codex mentions, creates tracking comments with progress indicators
- **Automation Mode** (with `prompt` input): Executes immediately, **does not create tracking comments**

> **Note**: In v1, automation mode intentionally does not create tracking comments by default to reduce noise in automated workflows. If you need progress tracking, use the `track_progress: true` input parameter.

## Supported GitHub Events

This action supports the following GitHub events ([learn more GitHub event triggers](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows)):

- `pull_request` or `pull_request_target` - When PRs are opened or synchronized
- `issue_comment` - When comments are created on issues or PRs
- `pull_request_comment` - When comments are made on PR diffs
- `issues` - When issues are opened or assigned
- `pull_request_review` - When PR reviews are submitted
- `pull_request_review_comment` - When comments are made on PR reviews
- `repository_dispatch` - Custom events triggered via API
- `workflow_dispatch` - Manual workflow triggers (coming soon)

## Automated Documentation Updates

Automatically update documentation when specific files change (see [`examples/pr-review-filtered-paths.yml`](../examples/pr-review-filtered-paths.yml)):

```yaml
on:
  pull_request:
    paths:
      - "src/api/**/*.ts"

steps:
  - uses: coryparrry/claude-code-action@codex/openai-runtime
    with:
      prompt: |
        Update the API documentation in README.md to reflect
        the changes made to the API endpoints in this PR.
      openai_api_key: ${{ secrets.OPENAI_API_KEY }}
      github_token: ${{ secrets.GITHUB_TOKEN }}
```

When API files are modified, the action automatically detects that a `prompt` is provided and runs in agent mode. Codex updates your README with the latest endpoint documentation and pushes the changes back to the PR, keeping your docs in sync with your code.

## Author-Specific Code Reviews

Automatically review PRs from specific authors or external contributors (see [`examples/pr-review-filtered-authors.yml`](../examples/pr-review-filtered-authors.yml)):

```yaml
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review-by-author:
    if: |
      github.event.pull_request.user.login == 'developer1' ||
      github.event.pull_request.user.login == 'external-contributor'
    steps:
      - uses: coryparrry/claude-code-action@codex/openai-runtime
        with:
          prompt: |
            Please provide a thorough review of this pull request.
            Pay extra attention to coding standards, security practices,
            and test coverage since this is from an external contributor.
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

Perfect for automatically reviewing PRs from new team members, external contributors, or specific developers who need extra guidance. The action automatically runs in agent mode when a `prompt` is provided.

## Custom Prompt Templates

Use the `prompt` input with GitHub context variables for dynamic automation:

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    prompt: |
      Analyze PR #${{ github.event.pull_request.number }} in ${{ github.repository }} for security vulnerabilities.

      Focus on:
      - SQL injection risks
      - XSS vulnerabilities
      - Authentication bypasses
      - Exposed secrets or credentials

      Provide severity ratings (Critical/High/Medium/Low) for any issues found.
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

You can access any GitHub context variable using the standard GitHub Actions syntax:

- `${{ github.repository }}` - The repository name
- `${{ github.event.pull_request.number }}` - PR number
- `${{ github.event.issue.number }}` - Issue number
- `${{ github.event.pull_request.title }}` - PR title
- `${{ github.event.pull_request.body }}` - PR description
- `${{ github.event.comment.body }}` - Comment text
- `${{ github.actor }}` - User who triggered the workflow
- `${{ github.base_ref }}` - Base branch for PRs
- `${{ github.head_ref }}` - Head branch for PRs

## Advanced Configuration with claude_args

For more control over Codex's behavior, use the `claude_args` input to pass supported compatibility arguments:

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    prompt: "Review this PR for performance issues"
    claude_args: |
      --model gpt-5.4
      --allowedTools Edit,Read,Write,Bash
      --append-system-prompt "You are a performance optimization expert. Focus on identifying bottlenecks and suggesting improvements."
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
```

This provides the supported Codex compatibility controls while maintaining the simplified action interface.
