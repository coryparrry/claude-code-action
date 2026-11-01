# Capabilities and Limitations

> This fork runs OpenAI models through the OpenAI Agents SDK. It preserves the upstream GitHub workflow and adapts runtime controls. See the [feature comparison](./feature-parity.md) for verified coverage and remaining differences.

For requested PR fixes, issue implementations, validation permissions and CI
diagnosis, see the [requested changes guide](./requested-changes.md).

## What Codex Can Do

- **Track Requested Work**: Codex updates one tracking comment per request with progress, delivery and separate validation results
- **Answer Questions**: Analyze code and provide explanations
- **Implement Code Changes**: Make simple to moderate code changes based on requests
- **Prepare Pull Requests**: Creates commits on a branch and links back to a prefilled PR creation page
- **Perform Code Reviews**: Submit a native PR review summary and separate inline findings after independent verification
- **Smart Branch Handling**:
  - When triggered on an **issue**: Always creates a new branch for the work
  - When triggered on an **open PR**: Always pushes directly to the existing PR branch
  - When triggered on a **closed PR**: Creates a new branch since the original is no longer active
- **View GitHub Actions Results**: Can access current-head workflow runs, job logs, and test results on the PR where it's tagged when `actions: read` permission is configured (see [Additional Permissions for CI/CD Integration](./configuration.md#additional-permissions-for-cicd-integration))

## What Codex Cannot Do

- **Approve PRs**: For security reasons, Codex cannot approve pull requests
- **Execute Commands Outside Its Context**: Codex only has access to the repository and PR/issue context it's triggered in
- **Run Arbitrary Bash Commands**: Shell execution depends on Codex config and sandbox settings; simple bridge command filters use `claude_args: --allowedTools`
- **Perform Branch Operations**: Cannot merge branches, rebase, or perform other git operations beyond pushing commits

## How It Works

1. **Trigger Detection**: The installer enables automatic reviews for trusted users' same-repository, non-draft PRs when opened, updated, reopened or marked ready. It also listens for `/codex` in issue titles/bodies, comments and reviews. Other workflows can configure labels, assignments and custom event prompts.
2. **Context Gathering**: Analyzes the PR/issue, comments, code changes
3. **Smart Responses**: Automatic reviews post feedback with read-only code access. Requested tasks answer questions or implement changes.
4. **Branch Management**: Creates a branch for issue requests and closed PRs; open PR requests use the existing branch
5. **Communication**: Posts updates at every step to keep you informed

This fork uses the local [Codex base action](../base-action/README.md) while retaining the upstream GitHub workflow integration.

## Release evidence

The [1 November qualification report](./release-qualification-2026-11-01.md) records GitHub-hosted tests and live OpenAI results. Optional cloud authentication remains fixture-tested because live account credentials were unavailable.
