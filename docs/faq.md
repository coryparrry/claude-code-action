# Frequently Asked Questions (FAQ)

> This fork runs Codex with `OPENAI_API_KEY`. GitHub triggers, tracking comments, branch handling, signing, and MCP integrations retain the upstream workflow shape. `claude_args` is a compatibility alias; use the preferred `codex_args` name for the same supported argument subset. Legacy `--allowedTools` / `--disallowedTools` support MCP names and simple Bash rules, not the full Claude permission language. Use a supported OpenAI model; there is no native `--max-turns`, Anthropic OAuth, WIF, Bedrock, or Vertex backend. Fork pull requests are rejected. See [configuration](./configuration.md) and [the action inputs](../action.yml).

This FAQ addresses common questions and gotchas when using the Codex GitHub Action.

## Triggering and Authentication

### Why doesn't tagging /codex from my automated workflow work?

The `github-actions` user cannot trigger subsequent GitHub Actions workflows. This is a GitHub security feature to prevent infinite loops. To make this work, you need to use a Personal Access Token (PAT) instead, which will act as a regular user, or use a separate app token of your own. When posting a comment on an issue or PR from your workflow, use your PAT instead of the `GITHUB_TOKEN` generated in your workflow.

### Why does Codex say I don't have permission to trigger it?

Only users with **write permissions** to the repository can trigger Codex. This is a security feature to prevent unauthorized use. Make sure the user commenting has at least write access to the repository.

<details>
<summary>Historical upstream reference — not supported by the Codex runtime</summary>

### Why can't I assign @claude to an issue on my repository?

If you're in a public repository, you should be able to assign to Claude without issue. If it's a private organization repository, you can only assign to users in your own organization, which Claude isn't. In this case, you'll need to make a custom user in that case.

### Why am I getting OIDC authentication errors?

If you're using the default GitHub App authentication, you must add the `id-token: write` permission to your workflow:

```yaml
permissions:
  contents: read
  id-token: write # Required for OIDC authentication
```

The OIDC token is required in order for the Claude GitHub app to function. If you wish to not use the GitHub app, you can instead provide a `github_token` input to the action for Claude to operate with. See the [Claude Code permissions documentation][perms] for more.

### Why am I getting '403 Resource not accessible by integration' errors?

This error occurs when the action tries to fetch the authenticated user information using a GitHub App installation token. GitHub App tokens have limited access and cannot access the `/user` endpoint, which causes this 403 error.

**Solution**: The action now includes `bot_id` and `bot_name` inputs that default to Claude's bot credentials. This avoids the need to fetch user information from the API.

For the default claude[bot]:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    # bot_id and bot_name have sensible defaults, no need to specify
```

For custom bots, specify both:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    bot_id: "12345678" # Your bot's GitHub user ID
    bot_name: "my-bot" # Your bot's username
```

This issue typically only affects agent/automation mode workflows. Interactive workflows (with @claude mentions) don't encounter this issue as they use the comment author's information.

</details>

### GitHub Authentication

The workflow token is used by default. Pass a custom `github_token` and configure `bot_id` / `bot_name` for a separate bot identity. OpenAI authentication uses `openai_api_key` or `OPENAI_API_KEY`; Anthropic OIDC and OAuth are unsupported.

## Codex's Capabilities and Limitations

### Why won't Codex update workflow files when I ask it to?

The workflow token has only the permissions granted by your workflow and repository policy. This prevents Codex from modifying CI/CD configurations that could potentially create unintended consequences. This is something we may reconsider in the future.

### Why won't Codex rebase my branch?

Codex only creates and pushes commits. It does not merge branches, rebase, force push, or perform other destructive git operations. Specifically, Codex is configured to:

- Never push to branches other than where it was invoked (either its own branch or the PR branch)
- Never force push or perform destructive operations

This restriction is enforced in Codex's system prompt, so it applies even if you grant the underlying git tools (for example `--allowedTools "Bash(git rebase:*)"`). In that case Codex will still decline rebase requests and explain the limitation rather than running the command.

If you need to rebase, do it yourself locally — or with the Codex CLI outside of this action — and push the result.

### Why won't Codex create a pull request?

Codex doesn't create PRs by default. Instead, it pushes commits to a branch and provides a link to a pre-filled PR submission page. This approach ensures your repository's branch protection rules are still adhered to and gives you final control over PR creation.

### Can Codex see my GitHub Actions CI results?

Yes! Codex can access GitHub Actions workflow runs, job logs, and test results on the PR where it's tagged. To enable this:

1. Add `actions: read` permission to your workflow:

   ```yaml
   permissions:
     contents: write
     pull-requests: write
     issues: write
     actions: read
   ```

2. Configure the action with additional permissions:
   ```yaml
   - uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
     with:
       additional_permissions: |
         actions: read
   ```

Codex will then be able to analyze CI failures and help debug workflow issues. For running tests locally before commits, you can still instruct Codex to do so in your request.

### Why does Codex only update one comment instead of creating new ones?

Codex is configured to update a single comment to avoid cluttering PR/issue discussions. All of Codex's responses, including progress updates and final results, will appear in the same comment with checkboxes showing task progress.

## Branch and Commit Behavior

### Why did Codex create a new branch when commenting on a closed PR?

Codex's branch behavior depends on the context:

- **Open PRs**: Pushes directly to the existing PR branch
- **Closed/Merged PRs**: Creates a new branch (cannot push to closed PR branches)
- **Issues**: Always creates a new branch with a timestamp

### Why are my commits shallow/missing history?

For performance, Codex uses shallow clones:

- PRs: `--depth=20` (last 20 commits)
- New branches: `--depth=1` (single commit)

If you need full history, you can configure this in your workflow before calling Codex in the `actions/checkout` step.

```
- uses: actions/checkout@v6
  depth: 0 # will fetch full repo history
```

## Configuration and Tools

### How does automatic mode detection work?

The action intelligently detects whether to run in interactive mode or automation mode:

- **With `prompt` input**: Runs in automation mode - executes immediately without waiting for /codex mentions
- **Without `prompt` input**: Runs in interactive mode - waits for /codex mentions in comments

This automatic detection eliminates the need to manually configure modes.

Example:

```yaml
# Automation mode - runs automatically
prompt: "Review this PR for security vulnerabilities"
# Interactive mode - waits for /codex mention
# (no prompt provided)
```

### What happened to `direct_prompt` and `custom_instructions`?

**These inputs are deprecated in v1.0:**

- **`direct_prompt`** → Use `prompt` instead
- **`custom_instructions`** → Use `claude_args` with `--append-system-prompt` (appends to the default system prompt, matching v0 behavior; `--append-system-prompt` also appends instructions)

Migration examples:

```yaml
# Old (v0.x)
direct_prompt: "Review this PR"
custom_instructions: "Focus on security"

# New (v1.0)
prompt: "Review this PR"
claude_args: |
  --append-system-prompt "Focus on security"
```

### Why doesn't Codex execute my bash commands?

Use simple Bash patterns in `claude_args` to filter the action bridge. Native shell access also depends on Codex config and sandbox settings:

```yaml
claude_args: |
  --allowedTools "Bash(npm:*),Bash(git:*)"  # Allows only npm and git commands
```

### Can Codex work across multiple repositories?

No, Codex's GitHub app token is sandboxed to the current repository only. It cannot push to any other repositories. It can, however, read public repositories, but to get access to this, you must configure it with tools to do so.

### Which account posts comments?

With `secrets.GITHUB_TOKEN`, GitHub attributes comments to `github-actions[bot]`. A custom token uses its owning user or app identity. Configure `bot_name` when sticky comments need to match that identity.

<details>
<summary>Original upstream bot identity guidance — not supported by this Codex fork</summary>

### Why aren't comments posted as github-actions[bot]?

Comments appear as github-actions[bot] when the action uses its built-in authentication. However, if you provide a `github_token` in your workflow, the action will use that token's authentication instead, causing comments to appear under a different username.

**Solution**: Remove `github_token` from your workflow file unless you're using a custom GitHub App.

**Note**: The `use_sticky_comment` feature only works with github-actions[bot] authentication. If you're using a custom `github_token`, sticky comments won't update properly since they expect the github-actions[bot] username.

</details>

## MCP Servers and Extended Functionality

### What MCP servers are available by default?

The action configures its GitHub MCP integration plus contextual comment, CI, and file-operation servers. Custom stdio or streamable HTTP servers can be merged through `--mcp-config`.

However, tools from these servers still need to be explicitly allowed via `claude_args` with `--allowedTools`.

## Troubleshooting

### How can I debug what Codex is doing?

Check the GitHub Action log for Codex's run for the full execution trace.

### Why can't I trigger Codex with `@codex-mention` or `claude!`?

The trigger uses word boundaries, so `/codex` must be a complete word. Variations like `@codex-bot`, `/codex!`, or `claude@mention` won't work unless you customize the `trigger_phrase`.

### How can I use custom executables in specialized environments?

For specialized environments like Nix, NixOS, or custom container setups where you need to provide your own executables:

**Using a custom Codex executable:**

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    path_to_codex_executable: "/path/to/custom/codex"
    # ... other inputs
```

**Using a custom Bun executable:**

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_token: ${{ secrets.GITHUB_TOKEN }}
    path_to_bun_executable: "/path/to/custom/bun"
    # ... other inputs
```

**Common use cases:**

- Nix/NixOS environments where packages are managed differently
- Docker containers with pre-installed executables
- Custom build environments with specific version requirements
- Debugging specific issues with particular versions

**Important notes:**

- Using an older Codex version may cause problems if the action uses newer features
- Using an incompatible Bun version may cause runtime errors
- The action will skip automatic installation when custom paths are provided
- Ensure the custom executables are available in your GitHub Actions environment

## Best Practices

1. **Always specify permissions explicitly** in your workflow file
2. **Use GitHub Secrets** for API keys - never hardcode them
3. **Be specific with tool permissions** - only enable what's necessary via `claude_args`
4. **Test in a separate branch** before using on important PRs
5. **Monitor Codex's token usage** to avoid hitting API limits
6. **Review Codex's changes** carefully before merging

## Getting Help

If you encounter issues not covered here:

1. Check the [GitHub Issues](https://github.com/coryparrry/claude-code-action/issues)
2. Review the [example workflows](https://github.com/coryparrry/claude-code-action#examples)

[perms]: https://docs.anthropic.com/en/docs/claude-code/settings#permissions
