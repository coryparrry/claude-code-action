# Claude Action feature comparison

This compares the Codex action source with
[Claude Code Action at `97c53473391bff1901034d4b454b5bac7ab7a029`](https://github.com/anthropics/claude-code-action/tree/97c53473391bff1901034d4b454b5bac7ab7a029)
(2026-10-01). The scope is the published GitHub Action experience. Local
installer tooling and exact Claude/Codex CLI command parity are outside this
audit.

The action preserves the main GitHub workflows while replacing the Claude
runtime with an OpenAI Agents SDK loop. **Full parity and live end-to-end
qualification are not established.** “Implemented” below describes source
behavior covered by offline tests, not successful execution against every
provider or a consumer repository.

## GitHub Action features

| Upstream feature                     | Codex action behavior                                                                                                                | Status                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Mode detection and automated prompts | Selects interactive or agent execution from the event and `prompt`; progress-enabled PR reviews use tracking comments.               | Implemented                                |
| Mentions, labels, and assignees      | Supports `/codex` requests, configurable trigger text, label and assignee triggers.                                                  | Implemented                                |
| Issue and PR context                 | Reads issue/PR bodies, comments, inline review comments, and submitted reviews.                                                      | Implemented                                |
| Code review                          | Reviews changes and can post inline comments and a summary; supports buffering and classifying inline feedback.                      | Implemented; live task unverified          |
| Code implementation                  | Can edit files, use branch handling, commit, and push within granted permissions; supports commit signing.                           | Implemented; live task unverified          |
| Progress and sticky comments         | Tracking comments, task checkboxes, sticky replies, execution reports, and cleanup.                                                  | Implemented                                |
| Structured outputs                   | Validates a supplied JSON schema and exposes `structured_output`; also exposes conclusion, execution-file, and session outputs.      | Implemented                                |
| Runner execution                     | Runs on the calling GitHub runner and uses provider APIs for inference.                                                              | Implemented                                |
| Configuration                        | `prompt`, `codex_args`, action inputs, and supported settings; `claude_args` remains a compatibility alias.                          | Adapted                                    |
| Custom GitHub App                    | Mints repository-scoped installation tokens, requests available App permissions, and attempts final revocation.                      | Implemented; live App setup unverified     |
| Fork PRs                             | Rejects fork PR execution before model work, including comments and associated workflow events. Upstream supports fork PR workflows. | Intentional policy difference              |
| Fix links                            | `include_fix_links` links to the PR's changes; default is `false`. It does not launch the upstream hosted Claude coding UI.          | Adapted; hosted vendor service unavailable |

The [README workflow](../README.md#quickstart) limits triggers to a trusted
actor, skips drafts and fork PRs, and cancels an older automatic review when a
new run starts for the same PR. It grants read-only repository access for
reviews and write access for requested implementations. These are workflow
choices; other events and trusted actors must be configured in the calling
workflow.

## Model runtime and tools

| Capability                           | Codex adaptation                                                                                                             | Limit                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Model selection and reasoning effort | Explicit OpenAI model IDs and supported effort values; legacy model tiers map to OpenAI tiers.                               | Model availability depends on the provider/account.                                                                  |
| Turns, fallback, schema, and costs   | SDK turn limits, eligible model-request fallback, validated JSON, and estimated token costs.                                 | Cost checks happen after responses; they are not a provider spending cap.                                            |
| Repository tools                     | File, shell, web, notebook, LSP, Task, Skill, and Workflow tools registered with the SDK.                                    | Supported schemas and behavior are action implementations, not the Claude runtime.                                   |
| Permissions and hooks                | Tool, file, domain, and command rules; unattended permission decisions; supported hook decisions and output rewriting.       | These are tool policies, not an OS filesystem/network sandbox.                                                       |
| Instructions and components          | AGENTS/CLAUDE instructions, imports, path rules, supported command/skill/agent/plugin manifests.                             | Vendor ecosystems and available components differ.                                                                   |
| Subagents and worktrees              | Inherited policy/model, scoped checkpoints and notes, isolated Git worktrees.                                                | A worktree is not process isolation.                                                                                 |
| Resume and compaction                | Workspace-scoped history and OpenAI compaction.                                                                              | Cross-job history requires explicitly configured persistent storage.                                                 |
| MCP                                  | stdio, HTTP, and SSE transports, credential scoping, bounded output, and tool selection.                                     | Tools are registered up front; deferred discovery is absent.                                                         |
| MCP images and other rich media      | Native image parts for PNG/JPEG/WebP/GIF and native file parts for embedded PDFs; text and resource metadata remain bounded. | Unsupported audio/SVG/binary content is omitted with a textual notice. Resource links are not fetched automatically. |
| Human questions and planning         | Trusted hook answers support headless execution.                                                                             | No live human-question or plan-approval UI.                                                                          |

## Authentication and cloud providers

| Provider capability          | Codex action behavior                                                                           | Status                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Direct API key               | OpenAI Responses API with an OpenAI API key.                                                    | Implemented                                                                                  |
| Workload identity federation | GitHub OIDC exchanged for renewable API Platform service-account credentials.                   | Implemented; live trust policy unverified                                                    |
| Amazon Bedrock               | OpenAI SDK regional provider with bearer tokens or SigV4 using AWS environment credentials.     | Implemented; role acquisition/refresh belongs to the calling workflow, live setup unverified |
| Azure / Microsoft Foundry    | Azure OpenAI with API key or a supplied Entra access token; model input is the deployment name. | Adapted; no Entra token acquisition/refresh or Anthropic Foundry backend                     |
| Google Vertex AI             | No corresponding OpenAI provider adapter.                                                       | Unsupported                                                                                  |
| Subscription/OAuth login     | No Claude or ChatGPT subscription login backend. OpenAI WIF is separate API authentication.     | Unsupported                                                                                  |

The [cloud provider guide](./cloud-providers.md) describes the credential and
model-name contracts. Accepting an input with a similar name does not establish
provider parity.

## Delivery and verification

The example workflows retain the existing immutable baseline
`0129d1e1fe31c282af7ebfa2bbe7ac1e1d080c71`. That pin does not include the
changes from this audit. Release the reviewed
source and update consumer workflow refs before treating those changes as
delivered. No new release tag or consumer-repository installation is claimed.

Offline regression and transport fixtures establish local behavior, including
failure paths. They do not verify live model access, cloud account policy,
billing, deployment availability, or a complete model-driven GitHub task.
Recorded verification belongs in the [port worklog](./CODEX_PORT_WORKLOG.md).
