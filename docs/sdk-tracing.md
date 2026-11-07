# Agents SDK tracing

Direct OpenAI runs automatically upload SDK traces. Both action variants default
`enable_tracing` to `true`; there is no extra tracing key or model call required.
The exporter uses the same per-run OpenAI credential as inference, so view the
project associated with that credential in [Agents SDK logs](https://platform.openai.com/logs?api=traces).

Tracing covers tasks, candidate reviews, independent verification and auxiliary
agent/tool execution. Root traces are named `Codex task`, `Codex review` or
`Codex verification`; nested agents reuse their caller's trace. GitHub traces
carry bounded repository, run ID/attempt, event and (when present in the PR ref)
PR-number metadata. Reviewer/verifier traces in the same GitHub run share a
group. The action prints each root trace ID in its log.

Prompts, model outputs, tool arguments/results and raw error messages are not
uploaded. Traces retain structure, model/tool names, timing, usage where the SDK
supplies it, and whether operations failed. Error details stay in the normal
redacted execution report. The action keeps Responses `store: false`; tracing
does not enable full Responses storage.

The action owns a batch trace processor and flushes after the root run, including
failed inference. Export HTTP requests have a five-second abort deadline with no
retries; final flushing also aborts after five seconds. Export failure does not
change the action's success/failure result. Hard termination, project settings,
authorization restrictions or network outages can still prevent delivery.

To opt out:

```yaml
with:
  enable_tracing: "false"
```

The SDK-wide `OPENAI_AGENTS_DISABLE_TRACING=1` kill switch is also respected.
Automatic exports are restricted to the direct `https://api.openai.com` endpoint.
Azure, Bedrock and custom gateways do not send their credentials to OpenAI's trace
ingestion endpoint. Injected test/custom inference boundaries remain offline by
default. No prompts or tool payloads are enabled by this input.

The updated action revision must be selected by a workflow before this default
changes its behavior. Existing disabled runs are not backfilled. Other
repositories pinned to older action commits remain on their existing behavior.

## Verification on 7 November 2026

Two live Luna requests exercised the reviewer and verifier trace phases. OpenAI
accepted both exports with HTTP 204, and both traces were observed in the Agents
SDK dashboard. The upload probe found neither the credential nor private prompt
markers in the payload. See [recorded evidence](verification/agent-tracing-2026-11-07.json).

Deterministic real-SDK tests cover function/model spans without payload content,
explicit opt-out, failed inference, failed export and a hung exporter. Provider
error messages are scrubbed because the SDK can otherwise retain request text in
those messages even when ordinary sensitive-data capture is disabled.
