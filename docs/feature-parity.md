# Original action feature comparison

## Headline workflow features

The ten headline features are supported by the OpenAI action and its generated
installation workflow. The checks below cover source behavior and offline
fixtures; a complete installed, model-driven GitHub task remains unverified.

| Original headline feature   | OpenAI equivalent                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Intelligent mode detection  | Context selects interactive or agent execution; progress-enabled PR reviews use the GitHub tracking flow. |
| Interactive code assistant  | `/codex` questions use repository, issue and PR context.                                                  |
| Code review                 | Automatic reviews on PR open/update/reopen/ready events, with inline feedback and a summary.              |
| Code implementation         | `/codex` requests can edit files, implement features and push commits using the existing branch handling. |
| PR/issue integration        | Issue titles/bodies, issue and PR comments, inline review comments and submitted review text.             |
| Flexible tool access        | Local file and shell tools plus GitHub MCP; configuration enables additional supported tools and servers. |
| Progress tracking           | Both installed jobs enable tracking comments and instruct the model to update task checkboxes.            |
| Structured outputs          | A supplied JSON schema validates the result exposed as the `structured_output` Action output.             |
| Runs on your infrastructure | The SDK executes on the selected GitHub runner and makes provider API calls.                              |
| Simplified configuration    | Unified `prompt` and `codex_args`, with `claude_args` retained as a compatibility alias.                  |

The default installer restricts both jobs to selected trusted users. Automatic
reviews skip drafts and fork PRs, use read-only code access, and cancel an older
review when a new run starts for the same PR. Interactive requests retain write
access for requested implementation work. Custom prompts and schema outputs are
configured when an automation needs them; they do not require a separate runtime.

## Runtime and provider comparison

Full parity is **not established**. This comparison uses upstream commit
`12dd8d74c712f5f3669365b2369b558c495b1104` and the current local OpenAI port.
Implemented means source and offline test coverage, unless stated otherwise.

| Original capability                                                     | OpenAI adaptation                                                                     | Status                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Mentions, labels, assignees, prompts, automated events                  | Retained GitHub triggers with Codex defaults                                          | Implemented                                                     |
| Context, progress comments, branches, commits, signing, inline feedback | Retained GitHub orchestration and registered tools                                    | Implemented; complete live GitHub task unverified               |
| API key                                                                 | OpenAI Responses API                                                                  | Implemented; earlier live Luna tool-loop test passed            |
| Workload identity federation                                            | GitHub OIDC exchanged for renewable OpenAI service-account credentials                | Implemented; live setup unverified                              |
| Custom GitHub App and extra permissions                                 | Repository-scoped installation tokens and final cleanup                               | Implemented; live setup unverified                              |
| Bedrock                                                                 | OpenAI SDK regional adapter with bearer credentials                                   | Partial; role/OIDC/SigV4 route missing                          |
| Foundry                                                                 | Azure OpenAI SDK with API key or supplied Entra token                                 | Partial; no Entra token acquisition/refresh                     |
| Subscription/OAuth credentials                                          | Requires a ChatGPT/Codex subscription backend                                         | Missing; WIF is a separate mechanism                            |
| Vertex AI                                                               | No corresponding provider adapter                                                     | Missing                                                         |
| Model tiers, reasoning effort                                           | Haiku → Luna; Sonnet → Sol; Opus → Astra; explicit OpenAI IDs                         | Implemented                                                     |
| Turns, fallback, schema, costs                                          | SDK turn limits, eligible fallback, validated JSON, estimated costs                   | Implemented; cost limit stops after responses                   |
| File, shell, web, notebook, LSP, Task, Skill, workflow tools            | Registered SDK tools                                                                  | Implemented supported schemas                                   |
| Permissions and hooks                                                   | Tool/file/domain/command rules, permission modes, hook decisions and output rewriting | Implemented tool policy                                         |
| Native settings                                                         | Reasoning summary, verbosity, shell/edit and web-search controls                      | Implemented supported controls                                  |
| Instructions, imports, path rules                                       | AGENTS/CLAUDE files, imports, nested discovery and scoped rules                       | Implemented                                                     |
| Commands, skills, agents, plugins, marketplaces                         | Supported manifests interpreted by this action                                        | Implemented formats; ecosystems differ                          |
| Subagent inheritance, resume, memory, worktrees                         | Scoped checkpoints/notes, inherited policy/model, Git worktrees                       | Implemented                                                     |
| Session resume and compaction                                           | Workspace-scoped storage and OpenAI compaction                                        | Implemented; cross-job persistence needs configuration          |
| MCP stdio, HTTP, SSE and output limits                                  | SDK transports, conservative output bounds, isolated credentials                      | Implemented; output bound approximates tokens using UTF-8 bytes |
| Lazy MCP tool search                                                    | Tools registered up front                                                             | Missing ToolSearch/deferred discovery                           |
| Human questions and plan approval                                       | Trusted hook answers in headless execution                                            | Partial; no live human question UI                              |
| Fork PR execution                                                       | Currently skipped before model work                                                   | Missing by current policy                                       |
| Guided installation                                                     | Standalone repository/key/runner/workflow-PR wizard                                   | Implemented; native slash command and hosted App absent         |
| Custom runtime executable                                               | Pinned Agents SDK; custom Bun path supported                                          | Custom Codex CLI execution missing                              |
| OS filesystem/network sandbox                                           | File-tool and permission policy only                                                  | Missing; worktrees do not provide an OS sandbox                 |

## Delivery and verification limits

The installer pins the reviewed action source revision in its generated workflows.
An existing installation needs a workflow update; rerunning the installer proposes
one for a managed workflow. The pinned revision includes the runtime changes in
this comparison. No consumer repository was installed or updated during this audit.
Cloud authentication tests use offline fixtures; they do not prove live provider
accounts, deployments, billing or permissions are configured correctly.

Use the [setup guide](./setup.md) for actual authentication contracts. Primary
references: [OpenAI GitHub WIF](https://developers.openai.com/api/docs/guides/workload-identity-federation/github-actions),
[OpenAI Bedrock](https://developers.openai.com/api/docs/guides/amazon-bedrock),
and [OpenAI pricing](https://developers.openai.com/api/docs/pricing).

Vendor-specific account, hosted-service and CLI capabilities require a separate
implementation. Accepting a similar input name does not establish parity.
