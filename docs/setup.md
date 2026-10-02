# Setup guide

This action runs OpenAI models through the OpenAI Agents SDK. Start with the
complete [GitHub workflow in the README](../README.md#quickstart); no local CLI
installation is required.

## Add the action to a repository

1. Add an OpenAI API key as the repository Actions secret `OPENAI_API_KEY`.
2. Save the README workflow as `.github/workflows/codex.yml`, replace
   `your-github-username` with a trusted collaborator, and commit it to the
   default branch. GitHub requires the workflow on that branch for
   `issue_comment` events.
3. Keep the workflow's `/codex` conditions and the action's `trigger_phrase`
   input in agreement. Configure `contents`, `issues`, and `pull-requests`
   permissions for the operations you allow.

The example enables `/codex` requests and automatic reviews of trusted users'
non-draft, same-repository PRs. Reviews use read-only repository tools;
interactive requests can implement changes. The main action separately checks
repository access and rejects fork PRs. The base action does not perform these
GitHub checks.

Examples pin the existing baseline commit
`0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71`. Current audit changes are local until
published. Update consumer workflows to the reviewed, published SHA containing
those changes; editing this checkout does not update an installed workflow.

The [optional installer](./installer.md) can propose workflow PRs. It is not
required for GitHub Actions setup or publication.

## GitHub authentication

By default, the action uses the workflow's `GITHUB_TOKEN`. Set job permissions
explicitly. The automatic review example needs `contents: read`, `issues: write`,
and `pull-requests: write`; implementation tasks need `contents: write`.
A token supplied through `github_token` must have the permissions needed by the
task. `additional_permissions` cannot elevate a workflow token or an existing
token.

Changes pushed with `GITHUB_TOKEN` follow GitHub's restrictions on triggering
other workflows. Use an installed GitHub App if your workflow needs a separate
bot identity or separately managed repository permissions.

### Use a custom GitHub App

Create a GitHub App, grant the repository permissions required by your tasks,
install it on the target repository, and store its private key in Actions
secrets. See [GitHub's App creation guide](https://docs.github.com/en/apps/creating-github-apps).

The action can mint its own repository-scoped installation token and attempts
to revoke it during final cleanup:

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    github_app_id: ${{ vars.APP_ID }}
    github_app_private_key: ${{ secrets.APP_PRIVATE_KEY }}
    bot_name: your-app-slug[bot]
    # github_app_installation_id is optional; otherwise resolved for this repository.
```

Do not also supply `github_token` with these App credentials. The App must
already be installed with the requested permissions. `additional_permissions`
can request a subset of those permissions when the action creates the token.
Set `bot_name` to the token's actual comment-author login when using sticky
comments. If your workflow generates a token in a separate step instead, pass
that token as `github_token` and let that step own token cleanup.

## Model authentication

Use exactly one provider authentication method. Store API keys and access
tokens in GitHub Actions secrets. See the [cloud provider guide](./cloud-providers.md)
for step examples and required environment variables.

| Provider                            | Credentials and required configuration                                                                               | Limit                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| OpenAI API                          | `openai_api_key`                                                                                                     | Uses the OpenAI Responses API.                                                                            |
| OpenAI workload identity federation | `openai_identity_provider_id`, `openai_service_account_id`, job `id-token: write`                                    | Requires an API Platform identity provider and mapped service account; refreshes short-lived credentials. |
| Amazon Bedrock                      | `openai_provider: bedrock`, region, and bearer token or AWS environment credentials                                  | Supports bearer or SigV4; a preceding credentials step handles role/OIDC exchange.                        |
| Azure OpenAI                        | `openai_provider: azure`, endpoint, API version, deployment name in `codex_model`, and API key or Entra access token | The caller acquires and refreshes Entra credentials.                                                      |

Anthropic API keys, Claude subscription tokens, ChatGPT subscription login,
Google Vertex AI, and Anthropic Foundry credentials are not authentication
methods for this runtime. OpenAI WIF is API Platform authentication; it is not a
ChatGPT/Codex subscription login.

Provider tests use offline fixtures. Live account access, deployments, trust
policies, and a complete model-driven GitHub task still need qualification
before a release is described as verified end to end.
