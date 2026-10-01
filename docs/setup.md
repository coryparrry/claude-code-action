# Setup Guide

> This fork runs Codex with `OPENAI_API_KEY`. GitHub triggers, tracking comments, branch handling, signing, and MCP integrations retain the upstream workflow shape. `claude_args` is a compatibility alias; use the preferred `codex_args` name for the same supported argument subset. Legacy `--allowedTools` / `--disallowedTools` support MCP names and simple Bash rules, not the full Claude permission language. Use a supported OpenAI model; there is no native `--max-turns`, Anthropic OAuth, WIF, Bedrock, or Vertex backend. Fork pull requests are rejected. See [configuration](./configuration.md) and [the action inputs](../action.yml).

## Manual Setup (Direct API)

**Requirements**: You must be a repository admin to complete these steps.

1. Add `OPENAI_API_KEY` to repository Actions secrets.
2. Copy [`examples/claude.yml`](../examples/claude.yml) into `.github/workflows/`. The filename is retained for compatibility; the workflow runs Codex.
3. Grant the workflow token the repository permissions it needs. The action uses `github_token: ${{ secrets.GITHUB_TOKEN }}` and does not require installing the Anthropic GitHub app or granting `id-token: write`.

<details>
<summary>Historical upstream reference — not supported by the Codex runtime</summary>

## Workload Identity Federation

Workload Identity Federation (WIF) lets the action authenticate to the Claude API by exchanging the workflow's GitHub Actions OIDC token for a short-lived Anthropic access token — no `ANTHROPIC_API_KEY` secret to create, store, or rotate.

### One-time setup in the Claude Console

You need admin access to your Anthropic organization (Console → **Settings → Workload identity**):

1. **Register an issuer** for GitHub Actions with issuer URL `https://token.actions.githubusercontent.com` (JWKS source: `discovery`).
2. **Create a service account** (Settings → Service accounts) and add it to the workspace it should act in. Note the `svac_...` ID.
3. **Create a federation rule** targeting that service account, matched to your repository's OIDC claims (for example a subject prefix of `repo:your-org/your-repo:`). Note the `fdrl_...` rule ID.

See the [Workload Identity Federation documentation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation) for full details.

### Workflow configuration

```yaml
jobs:
  claude-response:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write # required: used to fetch the GitHub OIDC token
    steps:
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_federation_rule_id: fdrl_xxxxxxxxxxxx
          anthropic_organization_id: 00000000-0000-0000-0000-000000000000
          anthropic_service_account_id: svac_xxxxxxxxxxxx
          # Optional when the federation rule targets a single workspace:
          anthropic_workspace_id: wrkspc_xxxxxxxxxxxx
```

These values are identifiers, not credentials, so they can live directly in the workflow file (or in repository variables).

Notes:

- The workflow must grant `id-token: write` permission so the action can fetch a GitHub OIDC token. The default GitHub App authentication path already requires this permission.
- Do not set `anthropic_api_key` or `claude_code_oauth_token` alongside the federation inputs — a static credential takes precedence and federation will not be used.
- The GitHub OIDC token is requested with audience `https://api.anthropic.com` by default, so set the federation rule's expected audience to that value (or leave the rule's audience unmatched). Use `anthropic_oidc_audience` only if your rule expects a different audience.
- Inline comment classification (`classify_inline_comments`) currently requires `anthropic_api_key`; with federation it is skipped and unconfirmed inline comments are posted directly.

</details>

## Using a Custom GitHub App

If you need a separate GitHub bot identity, you can create your own GitHub App to use with this action. This gives you complete control over permissions and access.

**When you may want to use a custom GitHub App:**

- You need more restrictive permissions than the workflow token
- Organization policies prevent installing third-party apps
- You need a GitHub token with separately managed installation permissions

### Option 1: Quick Setup with App Manifest (Recommended)

The fastest way to create a custom GitHub App is using our pre-configured manifest. This ensures all permissions are correctly set up with a single click.

**Steps:**

1. **Create the app:**

   **🚀 [Download the Quick Setup Tool](./create-app.html)** (Right-click → "Save Link As" or "Download Linked File")

   After downloading, open `create-app.html` in your web browser:

   - **For Personal Accounts:** Click the "Create App for Personal Account" button
   - **For Organizations:** Enter your organization name and click "Create App for Organization"

   The tool will automatically configure all required permissions and submit the manifest.

   Alternatively, you can use the manifest file directly:

   - Use the [`github-app-manifest.json`](../github-app-manifest.json) file from this repository
   - Visit https://github.com/settings/apps/new (for personal) or your organization's app settings
   - Look for the "Create from manifest" option and paste the JSON content

2. **Complete the creation flow:**

   - GitHub will show you a preview of the app configuration
   - Confirm the app name (you can customize it)
   - Click "Create GitHub App"
   - The app will be created with all required permissions automatically configured

3. **Generate and download a private key:**

   - After creating the app, you'll be redirected to the app settings
   - Scroll down to "Private keys"
   - Click "Generate a private key"
   - Download the `.pem` file (keep this secure!)

4. **Continue with installation** - Skip to step 3 in the manual setup below to install the app and configure your workflow.

### Option 2: Manual Setup

If you prefer to configure the app manually or need custom permissions:

1. **Create a new GitHub App:**

   - Go to https://github.com/settings/apps (for personal apps) or your organization's settings
   - Click "New GitHub App"
   - Configure the app with these minimum permissions:
     - **Repository permissions:**
       - Contents: Read & Write
       - Issues: Read & Write
       - Pull requests: Read & Write
     - **Account permissions:** None required
   - Set "Where can this GitHub App be installed?" to your preference
   - Create the app

2. **Generate and download a private key:**

   - After creating the app, scroll down to "Private keys"
   - Click "Generate a private key"
   - Download the `.pem` file (keep this secure!)

3. **Install the app on your repository:**

   - Go to the app's settings page
   - Click "Install App"
   - Select the repositories where you want to use Codex

4. **Add the app credentials to your repository secrets:**

   - Go to your repository's Settings → Secrets and variables → Actions
   - Add these secrets:
     - `APP_ID`: Your GitHub App's ID (found in the app settings)
     - `APP_PRIVATE_KEY`: The contents of the downloaded `.pem` file

5. **Update your workflow to use the custom app:**

   ```yaml
   name: Codex with Custom App
   on:
     issue_comment:
       types: [created]
     # ... other triggers

   jobs:
     codex-response:
       runs-on: ubuntu-latest
       steps:
         # Generate a token from your custom app
         - name: Generate GitHub App token
           id: app-token
           uses: actions/create-github-app-token@v1
           with:
             app-id: ${{ secrets.APP_ID }}
             private-key: ${{ secrets.APP_PRIVATE_KEY }}

         # Use Codex with your custom app's token
         - uses: coryparrry/claude-code-action@codex/openai-runtime
           with:
             openai_api_key: ${{ secrets.OPENAI_API_KEY }}
             github_token: ${{ steps.app-token.outputs.token }}
             # ... other configuration
   ```

**Important notes:**

- The custom app must have read/write permissions for Issues, Pull Requests, and Contents
- Your app's token will have the exact permissions you configured, nothing more

For more information on creating GitHub Apps, see the [GitHub documentation](https://docs.github.com/en/apps/creating-github-apps).

## Security Best Practices

**⚠️ IMPORTANT: Never commit API keys directly to your repository! Always use GitHub Actions secrets.**

To securely use your OpenAI API key:

1. Add your API key as a repository secret:

   - Go to your repository's Settings
   - Navigate to "Secrets and variables" → "Actions"
   - Click "New repository secret"
   - Name it `OPENAI_API_KEY`
   - Paste your API key as the value

2. Reference the secret in your workflow:
   ```yaml
   openai_api_key: ${{ secrets.OPENAI_API_KEY }}
   github_token: ${{ secrets.GITHUB_TOKEN }}
   ```

**Never do this:**

```yaml
# ❌ WRONG - Exposes your API key
openai_api_key: "sk-example-..."
```

**Always do this:**

```yaml
# ✅ CORRECT - Uses GitHub secrets
openai_api_key: ${{ secrets.OPENAI_API_KEY }}
github_token: ${{ secrets.GITHUB_TOKEN }}
```

This applies to all sensitive values including API keys, access tokens, and credentials.
We also recommend that you always use short-lived tokens when possible

## Setting Up GitHub Secrets

1. Go to your repository's Settings
2. Click on "Secrets and variables" → "Actions"
3. Click "New repository secret"
4. For authentication, choose one:
   - API Key: Name: `OPENAI_API_KEY`, Value: Your OpenAI API key
   - Anthropic OAuth tokens are not accepted by this fork.
5. Click "Add secret"

### Best Practices for Authentication

1. ✅ Always use `${{ secrets.OPENAI_API_KEY }}` or `${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` in workflows
2. ✅ Never commit API keys or tokens to version control
3. ✅ Regularly rotate your API keys and tokens
4. ✅ Use environment secrets for organization-wide access
5. ❌ Never share API keys or tokens in pull requests or issues
6. ❌ Avoid logging workflow variables that might contain keys
