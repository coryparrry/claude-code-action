# Setup Guide

> This fork runs OpenAI models through the OpenAI Agents SDK. It preserves the upstream GitHub workflow and adapts runtime controls. See the [feature comparison](./feature-parity.md) for verified coverage and remaining differences.

## Guided setup

Run `npm run install-github-app` from the cloned action repository. The installer
uses GitHub CLI to sign in, lets you select repositories and a Linux or macOS
runner, configures `OPENAI_API_KEY` securely and proposes the workflow in draft
PRs. It defaults to Luna 6 and the signed-in GitHub user as the trusted trigger
actor. Review and merge the setup PRs to activate automatic PR reviews and
`/codex` requests with progress tracking.

This provides the guided setup flow for this fork using the built-in workflow
token and `github-actions[bot]`. It does not install the Anthropic-hosted GitHub
App. Node.js and GitHub CLI are required; Bun is not required for installation.
See [the installer guide](./installer.md) for running from other directories,
multiple repositories, previews and automation.

## Manual Setup (Direct API)

**Requirements**: You must be a repository admin to complete these steps.

1. Add `OPENAI_API_KEY` to repository Actions secrets.
2. Copy [`examples/claude.yml`](../examples/claude.yml) into `.github/workflows/codex.yml` and replace `your-github-username` with the trusted user's login. The example filename is retained for compatibility; the workflow runs Codex with automatic reviews and `/codex` requests.
3. Grant the workflow token the repository permissions it needs. The action uses `github_token: ${{ secrets.GITHUB_TOKEN }}` and does not require installing the Anthropic GitHub app or granting `id-token: write`.

## Using a Custom GitHub App

The action can mint and revoke its own installation token. Supply `github_app_id`
and `github_app_private_key` (and optionally `github_app_installation_id`). Do not
also supply `github_token`. `additional_permissions` requests permissions from
the installed App; it cannot elevate a workflow token. The App must already be
installed on the target repository with those permissions.

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
         - uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
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

1. ✅ Keep API credentials in Actions secrets, or use OpenAI workload identity federation.
2. ✅ Never commit API keys or tokens to version control
3. ✅ Regularly rotate your API keys and tokens
4. ✅ Use environment secrets for organization-wide access
5. ❌ Never share API keys or tokens in pull requests or issues
6. ❌ Avoid logging workflow variables that might contain keys

## OpenAI workload identity federation

Register a GitHub Actions identity provider and service account in your OpenAI
organization. Restrict the trust policy to the intended repository and workflow.
Then grant the job `id-token: write` and configure:

```yaml
permissions:
  contents: write
  issues: write
  pull-requests: write
  id-token: write
steps:
  - uses: actions/checkout@v4
  - uses: your-owner/your-fork@your-reviewed-ref
    with:
      openai_identity_provider_id: ${{ vars.OPENAI_IDENTITY_PROVIDER_ID }}
      openai_service_account_id: ${{ vars.OPENAI_SERVICE_ACCOUNT_ID }}
```

Do not also supply `openai_api_key`. The action exchanges GitHub OIDC credentials
for short-lived OpenAI credentials and refreshes them during longer runs.
See [OpenAI's GitHub Actions WIF guide](https://developers.openai.com/api/docs/guides/workload-identity-federation/github-actions).

## OpenAI models on cloud providers

For Amazon Bedrock, set `openai_provider: bedrock`, provide `bedrock_api_key` from
an Actions secret, and set `AWS_REGION` on the step. Use the Bedrock model ID
available in that region. This adapter uses bearer credentials; it does not
perform AWS OIDC-to-SigV4 authentication.
See [OpenAI's Bedrock guide](https://developers.openai.com/api/docs/guides/amazon-bedrock).

For Azure, set `openai_provider: azure`, `azure_openai_endpoint`, and either
`azure_openai_api_key` or `azure_openai_ad_token`. Set `OPENAI_API_VERSION` in the
step environment and, if needed, `AZURE_OPENAI_DEPLOYMENT`. Entra tokens are
provided by the calling workflow; this adapter does not acquire or refresh them.
Google Vertex AI and Claude subscription credentials are not accepted by this
OpenAI API runtime.
