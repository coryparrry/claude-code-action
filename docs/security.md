# Security

> This fork runs Codex with `OPENAI_API_KEY`. GitHub triggers, tracking comments, branch handling, signing, and MCP integrations retain the upstream workflow shape. `claude_args` is a compatibility alias; use the preferred `codex_args` name for the same supported argument subset. Legacy `--allowedTools` / `--disallowedTools` support MCP names and simple Bash rules, not the full Claude permission language. Use a supported OpenAI model; there is no native `--max-turns`, Anthropic OAuth, WIF, Bedrock, or Vertex backend. Fork pull requests are rejected. See [configuration](./configuration.md) and [the action inputs](../action.yml).

## Access Control

- **Repository Access**: The action can only be triggered by users with write access to the repository. This is checked for issue, pull request, comment, and review events, and for `workflow_run` events, where both the workflow actor and the actor that started the upstream run are checked. `workflow_dispatch`, `repository_dispatch`, and `schedule` events are not checked separately — GitHub itself requires write access to dispatch a workflow, and scheduled runs have no external actor.
- **Bot User Control**: By default, GitHub Apps and bots cannot trigger this action for security reasons. Use the `allowed_bots` parameter to enable specific bots or all bots
  - **⚠️ Allowed bots are not checked for repository permissions.** A bot that matches an entry does **not** need to be installed on your repository or have write access. On a **public repository**, external parties — including GitHub Apps created by anyone — may be able to trigger workflow events such as opening issues, commenting, or reviewing pull requests. If your workflow listens on those events and `allowed_bots` is set to `'*'`, any such App can invoke this action with a prompt it controls.
  - Prefer an explicit list over `'*'`
  - Only list App names you trust
  - If you need `'*'`, scope workflow `permissions:` to the minimum required
- **⚠️ Non-Write User Access (RISKY)**: The `allowed_non_write_users` parameter allows bypassing the write permission requirement. **This is a significant security risk and should only be used for workflows with extremely limited permissions** (e.g., issue labeling workflows that only have `issues: write` permission). This feature:
  - Only works when `github_token` is provided as input (not with GitHub App authentication)
  - Accepts either a comma-separated list of specific usernames or `*` to allow all users
  - **Should be used with extreme caution** as it bypasses the primary security mechanism of this action
  - Is designed for automation workflows where user permissions are already restricted by the workflow's permission scope
  - When set, the runtime performs best-effort scrubbing of OpenAI and GitHub secrets from model subprocess environments. This does not eliminate prompt injection risk; keep permissions minimal.
  - Script-cap limits and bubblewrap isolation described by the upstream Claude runtime are not guarantees of this Codex bridge.
  - When using `allowed_non_write_users`, always pass `github_token: ${{ secrets.GITHUB_TOKEN }}`. The auto-generated workflow token is scoped to the job's declared permissions and expires when the job completes. **Do not use a personal access token** — a static token does not rotate between runs and could be partially or fully recovered over time via prompt injection. Restricting allowed tools via `claude_args` reduces the rate of recovery but may not eliminate the risk. We recommend restricting allowed tools (e.g. `claude_args: '--allowedTools "Bash(gh issue view:*)"'`) to the minimum required when using `allowed_non_write_users`.
- **Token Permissions**: The workflow token is short-lived and limited by the workflow permissions; custom tokens follow their own scopes and expiry
- **No Cross-Repository Access**: Each action invocation is limited to the repository where it was triggered
- **Limited Scope**: The token cannot access other repositories or perform actions beyond the configured permissions

## Using this action with `pull_request_target` or `workflow_run`

For `workflow_run` events, the action checks the repository access of the actor that started the upstream run (for example, the author of the fork pull request that triggered your CI workflow) in addition to the workflow actor. If that actor does not have write access, the action stops before running Codex. To run on `workflow_run` events downstream of pull requests from contributors without write access, add those users to `allowed_non_write_users` and pass `github_token: ${{ secrets.GITHUB_TOKEN }}` — see the notes on that input above and keep the workflow's permissions minimal.

`pull_request_target` and `workflow_run` execute with the **base repository's secrets**. If your workflow checks out the PR head (`ref: ${{ github.event.pull_request.head.sha }}` for `pull_request_target`, `ref: ${{ github.event.workflow_run.head_sha }}` for `workflow_run`) into `$GITHUB_WORKSPACE` before this action, the action and Codex run with that checkout as the working directory.

**Do not check out an untrusted ref into the workspace root before this action.** Use one of these patterns instead:

```yaml
# Preferred — check out the base ref (default).
- uses: actions/checkout@v6 # no `ref:` → base branch
- uses: coryparrry/claude-code-action@codex/openai-runtime
```

<details>
<summary>Original add-dir checkout pattern — not supported by this Codex fork</summary>

```yaml
# If you need the PR's files locally — check out the base ref at the workspace
# root (this action expects a git repo there), then check out the head ref into
# a subdirectory and pass it via --add-dir.
- uses: actions/checkout@v6 # no `ref:` → base branch at workspace root
- uses: actions/checkout@v6
  with:
    # For workflow_run use: ${{ github.event.workflow_run.head_sha }}
    ref: ${{ github.event.pull_request.head.sha }}
    path: pr-head
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    claude_args: "--add-dir pr-head"
```

</details>

This is general guidance for these event types — see [GitHub's documentation](https://securitylab.github.com/research/github-actions-preventing-pwn-requests/).

### Which files come from the base branch on pull requests

When the action runs against a pull request, it restores a fixed list of Codex configuration paths from the PR base branch before starting Codex: `.codex/`, `.mcp.json`, `.claude.json`, `.gitmodules`, `.ripgreprc`, `AGENTS.md`, `AGENTS.override.md`, and `.husky/`. Paths in that list that do not exist on the base branch are removed, and the PR-authored versions are kept under `.claude-pr/` for reference only.

Everything else in the working tree — including `package.json`, lockfiles, `Makefile`, `node_modules/`, and formatter/linter config files — stays at the PR head. If a hook, `apiKeyHelper`, or `statusLine` command in your base-branch `.codex/settings.json` runs a package-manager script (`bun run …`, `npm run …`, `yarn …`, `pnpm run …`), a `make` target, a repo-relative script, or a tool that loads executable project config, that command resolves through files the pull request supplies. Keep such commands self-contained: invoke the tool directly with a pinned version and pass its configuration on the command line (for example `bunx prettier@3.5.3 --no-config --write .` rather than `bun run format`).

Note that the runtime executing the tool also reads project config. `bunx <tool>` runs the tool's script under `node` when `node` is on `PATH` (as it is on GitHub-hosted runners); when only Bun is available, Bun executes the script itself and reads `bunfig.toml` from the checkout — including `preload` entries — which comes from the PR head. On such runners, make sure `node` is on `PATH` for the hook, and treat `bunfig.toml` and `.npmrc` in the checkout as PR-controlled runtime config.

### `claude-code-action` vs `claude-code-base-action`

`claude-code-base-action` is a lower-level building block that installs and runs Codex with the inputs you provide. It does not perform actor permission checks or restore project configuration from the base ref. If you need those behaviors, use this action (`claude-code-action`). See the [base-action README](../base-action/README.md#trust-model) for details.

## Pull Request Creation

In its default configuration, **Codex does not create pull requests automatically** when responding to `/codex` mentions. Instead:

- Codex commits code changes to a new branch
- Codex provides a **link to the GitHub PR creation page** in its response
- **The user must click the link and create the PR themselves**, ensuring human oversight before any code is proposed for merging

This design ensures that users retain full control over what pull requests are created and can review the changes before initiating the PR workflow.

## ⚠️ Prompt Injection Risks

**Beware of potential hidden markdown when tagging Codex on untrusted content.** External contributors may include hidden instructions through HTML comments, invisible characters, hidden attributes, or other techniques. The action sanitizes content by stripping HTML comments, invisible characters, markdown image alt text, hidden HTML attributes, and HTML entities, but new bypass techniques may emerge. We recommend reviewing the raw content of all input coming from external contributors before allowing Codex to process it.

On public repos, you can also use `include_comments_by_actor` to allowlist which users' comments are passed to Codex, reducing exposure to untrusted input. Use `exclude_comments_by_actor` to filter out noisy bot comments (e.g., `dependabot[bot]`, `renovate[bot]`). If an actor matches both lists, exclusion takes priority. See [Usage](./usage.md) for details.

<details>
<summary>Historical upstream reference — not supported by the Codex runtime</summary>

## GitHub App Permissions

The [Claude Code GitHub app](https://github.com/apps/claude) requests the following permissions:

### Currently Used Permissions

- **Contents** (Read & Write): For reading repository files and creating branches
- **Pull Requests** (Read & Write): For reading PR data and creating/updating pull requests
- **Issues** (Read & Write): For reading issue data and updating issue comments

### Permissions for Future Features

The following permissions are requested but not yet actively used. These will enable planned features in future releases:

- **Discussions** (Read & Write): For interaction with GitHub Discussions
- **Actions** (Read): For accessing workflow run data and logs
- **Checks** (Read): For reading check run results
- **Workflows** (Read & Write): For triggering and managing GitHub Actions workflows

</details>

## Commit Signing

By default, commits made by Codex are unsigned. You can enable commit signing using one of two methods:

### Option 1: GitHub API Commit Signing (use_commit_signing)

This uses GitHub's API to create commits, which automatically signs them as verified from the GitHub App:

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    use_commit_signing: true
```

This is the simplest option and requires no additional setup. However, because it uses the GitHub API instead of git CLI, it cannot perform complex git operations like rebasing, cherry-picking, or interactive history manipulation.

### Option 2: SSH Signing Key (ssh_signing_key)

This uses an SSH key to sign commits via git CLI. Use this option when you need both signed commits AND standard git operations (rebasing, cherry-picking, etc.):

```yaml
- uses: coryparrry/claude-code-action@codex/openai-runtime
  with:
    ssh_signing_key: ${{ secrets.SSH_SIGNING_KEY }}
    bot_id: "YOUR_GITHUB_USER_ID"
    bot_name: "YOUR_GITHUB_USERNAME"
```

Commits will show as verified and attributed to the GitHub account that owns the signing key.

**Setup steps:**

1. Generate an SSH key pair for signing:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/signing_key -N "" -C "commit signing key"
   ```

2. Add the **public key** to your GitHub account:

   - Go to GitHub → Settings → SSH and GPG keys
   - Click "New SSH key"
   - Select **Key type: Signing Key** (important)
   - Paste the contents of `~/.ssh/signing_key.pub`

3. Add the **private key** to your repository secrets:

   - Go to your repo → Settings → Secrets and variables → Actions
   - Create a new secret named `SSH_SIGNING_KEY`
   - Paste the contents of `~/.ssh/signing_key`

4. Get your GitHub user ID:

   ```bash
   gh api users/YOUR_USERNAME --jq '.id'
   ```

5. Update your workflow with `bot_id` and `bot_name` matching the account where you added the signing key.

**Note:** If both `ssh_signing_key` and `use_commit_signing` are provided, `ssh_signing_key` takes precedence.

## ⚠️ Authentication Protection

**Never hardcode your OpenAI API key or GitHub token in workflow files.**

Your authentication credentials must always be stored in GitHub secrets to prevent unauthorized access:

```yaml
# CORRECT ✅
openai_api_key: ${{ secrets.OPENAI_API_KEY }}
github_token: ${{ secrets.GITHUB_TOKEN }}
# OR
# Anthropic OAuth tokens are not supported.

# NEVER DO THIS ❌
openai_api_key: "sk-example-..." # Exposed and vulnerable!
# Anthropic OAuth tokens are not supported.
```

## ⚠️ Full Output Security Warning

The `show_full_output` option is **disabled by default** for security reasons. When enabled, it outputs ALL Codex messages including:

- Full outputs from tool executions (e.g., `ps`, `env`, file reads)
- API responses that may contain tokens or credentials
- File contents that may include secrets
- Command outputs that may expose sensitive system information

**These logs are publicly visible in GitHub Actions for public repositories!**

### Automatic Enabling in Debug Mode

Full output is **automatically enabled** when GitHub Actions debug mode is active (when `ACTIONS_STEP_DEBUG` secret is set to `true`). This helps with debugging but carries the same security risks.

### When to Enable Full Output

Only enable `show_full_output: true` or GitHub Actions debug mode when:

- Working in a private repository with controlled access
- Debugging issues in a non-production environment
- You have verified no secrets will be exposed in the output
- You understand the security implications

### Recommended Practice

For debugging, prefer using `show_full_output: false` (the default) and rely on Codex's sanitized output, which shows only essential information like errors and completion status without exposing sensitive data.
