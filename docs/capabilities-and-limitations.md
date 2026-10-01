# Capabilities and Limitations

> This fork runs Codex with `OPENAI_API_KEY`. GitHub triggers, tracking comments, branch handling, signing, and MCP integrations retain the upstream workflow shape. `claude_args` is a compatibility alias; use the preferred `codex_args` name for the same supported argument subset. Legacy `--allowedTools` / `--disallowedTools` support MCP names and simple Bash rules, not the full Claude permission language. Use a supported OpenAI model; there is no native `--max-turns`, Anthropic OAuth, WIF, Bedrock, or Vertex backend. Fork pull requests are rejected. See [configuration](./configuration.md) and [the action inputs](../action.yml).

## What Codex Can Do

- **Respond in a Single Comment**: Codex operates by updating a single initial comment with progress and results
- **Answer Questions**: Analyze code and provide explanations
- **Implement Code Changes**: Make simple to moderate code changes based on requests
- **Prepare Pull Requests**: Creates commits on a branch and links back to a prefilled PR creation page
- **Perform Code Reviews**: Analyze PR changes and provide detailed feedback
- **Smart Branch Handling**:
  - When triggered on an **issue**: Always creates a new branch for the work
  - When triggered on an **open PR**: Always pushes directly to the existing PR branch
  - When triggered on a **closed PR**: Creates a new branch since the original is no longer active
- **View GitHub Actions Results**: Can access workflow runs, job logs, and test results on the PR where it's tagged when `actions: read` permission is configured (see [Additional Permissions for CI/CD Integration](./configuration.md#additional-permissions-for-cicd-integration))

## What Codex Cannot Do

- **Submit PR Reviews**: Codex cannot submit formal GitHub PR reviews
- **Approve PRs**: For security reasons, Codex cannot approve pull requests
- **Post Multiple Comments**: Codex only acts by updating its initial comment
- **Execute Commands Outside Its Context**: Codex only has access to the repository and PR/issue context it's triggered in
- **Run Arbitrary Bash Commands**: Shell execution depends on Codex config and sandbox settings; simple bridge command filters use `claude_args: --allowedTools`
- **Perform Branch Operations**: Cannot merge branches, rebase, or perform other git operations beyond pushing commits

## How It Works

1. **Trigger Detection**: Listens for comments containing the trigger phrase (default: `@codex`) or issue assignment to a specific user
2. **Context Gathering**: Analyzes the PR/issue, comments, code changes
3. **Smart Responses**: Either answers questions or implements changes
4. **Branch Management**: Creates a branch for issue requests and closed PRs; open PR requests use the existing branch
5. **Communication**: Posts updates at every step to keep you informed

This fork uses the local [Codex base action](../base-action/README.md) while retaining the upstream GitHub workflow integration.
