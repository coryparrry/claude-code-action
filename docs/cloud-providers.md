# Cloud providers

The action uses the OpenAI Responses API through the OpenAI Agents SDK. Choose
one provider and credential method. The examples below are action steps to add
to the trusted workflow in the [setup guide](./setup.md).

Examples retain the existing baseline SHA. Current audit changes are local
until published; replace the action ref with the reviewed, published SHA that
contains the behavior you intend to use. The provider contracts below describe
the current source, not a live qualification of an account or deployment.

## OpenAI API key

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    codex_model: gpt-6-luna
```

The selected OpenAI model must be available to the API project. Do not supply
WIF IDs or another provider's credentials alongside an API key.

## OpenAI workload identity federation

Configure a GitHub Actions identity provider and service-account mapping in the
OpenAI API Platform. Restrict the trust policy to the intended repository and
workflow. Give the job `id-token: write` in addition to its GitHub repository
permissions, then configure:

```yaml
permissions:
  contents: write
  issues: write
  pull-requests: write
  id-token: write
# Within the job's steps:
# - uses: actions/checkout@v6
# - ...
```

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_identity_provider_id: ${{ vars.OPENAI_IDENTITY_PROVIDER_ID }}
    openai_service_account_id: ${{ vars.OPENAI_SERVICE_ACCOUNT_ID }}
    # Set only if your identity provider requires a different audience:
    # openai_oidc_audience: https://api.openai.com/v1
    codex_model: gpt-6-luna
```

Do not also supply `openai_api_key`. The default OIDC audience is
`https://api.openai.com/v1`. The action exchanges the GitHub OIDC token for
short-lived OpenAI credentials and refreshes them for later requests as needed.
This authenticates an API Platform service account, not a ChatGPT subscription
or managed Codex workspace. See [OpenAI's WIF guide](https://developers.openai.com/api/docs/guides/workload-identity-federation)
and [API reference](https://developers.openai.com/api/reference/workload-identity-federation).

## Amazon Bedrock

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_provider: bedrock
    bedrock_api_key: ${{ secrets.AWS_BEARER_TOKEN_BEDROCK }}
    codex_model: ${{ vars.BEDROCK_MODEL_ID }}
  env:
    AWS_REGION: ${{ vars.AWS_REGION }}
```

Set `BEDROCK_MODEL_ID` to the OpenAI model ID available through Bedrock Responses
in your region. The adapter uses the OpenAI SDK's Bedrock provider with bearer
authentication. `AWS_DEFAULT_REGION` is accepted when `AWS_REGION` is unset, and
`AWS_BEARER_TOKEN_BEDROCK` can be supplied through the step environment instead
of the input. Do not also supply `openai_api_key`.

The default Responses endpoint is
`https://bedrock-mantle.<region>.api.aws/v1`. If needed, set
`AWS_BEDROCK_BASE_URL` to the supported Bedrock Runtime or Mantle endpoint;
`OPENAI_BASE_URL` is not accepted for this provider. See
[AWS's Mantle endpoint guide](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html).

Alternatively, provide AWS signing credentials through the step environment.
For GitHub OIDC, grant the job `id-token: write`, configure your AWS role's trust
policy, and use a credentials step before the action:

```yaml
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ vars.AWS_ROLE_TO_ASSUME }}
    aws-region: ${{ vars.AWS_REGION }}

- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_provider: bedrock
    codex_model: ${{ vars.BEDROCK_MODEL_ID }}
```

The adapter signs requests with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
and optional `AWS_SESSION_TOKEN` from the environment. The credentials step
acquires the role credentials; the action does not perform that exchange or
refresh them. Ensure they remain valid for the run. Local AWS profiles and the
AWS default credential provider chain are not loaded. Bearer credentials and
AWS signing credentials are mutually exclusive.
See [OpenAI's Bedrock guide](https://developers.openai.com/api/docs/guides/amazon-bedrock).

## Azure OpenAI

```yaml
- uses: coryparrry/claude-code-action@0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71
  with:
    openai_provider: azure
    azure_openai_endpoint: ${{ vars.AZURE_OPENAI_ENDPOINT }}
    azure_openai_api_key: ${{ secrets.AZURE_OPENAI_API_KEY }}
    codex_model: ${{ vars.AZURE_OPENAI_DEPLOYMENT }}
  env:
    OPENAI_API_VERSION: ${{ vars.AZURE_OPENAI_API_VERSION }}
```

Configure an Azure OpenAI resource endpoint and an API version that supports
Responses. Use `azure_openai_endpoint` / `AZURE_OPENAI_ENDPOINT` rather than
`OPENAI_BASE_URL`. Set `codex_model` to the **deployment name**, even when it differs
from the underlying OpenAI model ID. Setting `AZURE_OPENAI_DEPLOYMENT` alone
does not replace the model sent in a Responses request.

For Entra authentication, replace `azure_openai_api_key` with
`azure_openai_ad_token` containing an access token acquired by your workflow.
Supply exactly one credential type. The action does not acquire or refresh
Entra tokens; the supplied token must remain valid for the run. An Azure login
step alone does not pass a token into this action. This is an Azure OpenAI
adapter, not the upstream Anthropic Foundry backend.

## Compatibility limits

Google Vertex AI, Anthropic API keys, Claude OAuth/subscription credentials,
and ChatGPT subscription login are not supported. Provider aliases do not
translate vendor model catalogs or implement every upstream authentication
flow. See the [feature comparison](./feature-parity.md) for action-level gaps.
