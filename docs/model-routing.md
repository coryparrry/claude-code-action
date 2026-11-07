# Configurable model routing

`model_routing` opts either action into a bounded cheap phase followed by one-way
escalation. Both model IDs and reasoning efforts come from your workflow. Blank
or omitted routing preserves the existing model selection. The published
repository workflow uses Terra with high effort; this feature does not change
installed workflows or their action pins automatically.

```yaml
with:
  openai_api_key: ${{ secrets.OPENAI_API_KEY }}
  codex_model: gpt-6.1-terra
  codex_effort: high
  model_routing: |
    {
      "cheap_model": "gpt-6-luna",
      "strong_model": "gpt-6.1-terra",
      "cheap_effort": "low",
      "strong_effort": "high",
      "max_cheap_turns": 3,
      "max_cheap_input_bytes": 80000
    }
```

Replace either model with a model supported by your configured provider, or use
repository variables in the JSON. Models are not selected by name inside the
routing policy. Both IDs are required; efforts default to low/high. The shared
cheap-turn allowance accepts 1–10; the input-byte limit accepts 1,024–1,000,000.
These limits are configurable policy thresholds, not token measurements.

No model call is made solely to classify a task. Large input, sensitive paths
and boundary-sensitive or complex failure-mode terms start on the strong model. The byte limit counts
the request input, system instructions and tool definitions. Subsequent tool
results can also trigger escalation. Otherwise the cheap model starts work.
Every inference attempt consumes its shared cheap-turn allowance, including
auxiliary agents. When it is exhausted the next request uses the strong model.
The cheap model can also call `request_stronger_model` before guessing. The SDK
conversation, tool results, workspace changes, deadline and overall turn limits
are retained. Completed tools are not replayed.

Routing governs normal and inherited agent inference. An explicit strong-model
selection in a skill, command, agent definition, child agent or prompt hook
escalates immediately. Explicit overrides must name one of the configured
models; a third role is rejected rather than silently replaced. Once strong,
requesting the cheap role does not downgrade the run. Main-agent compaction uses the configured strong model; auxiliary compaction
follows that agent's selected model. Every compaction response is charged to the
same aggregate budget.

API-error `fallback_model` remains separate. An eligible API fallback ends the
cheap phase. All fallback models must have configured prices and a string model
ID before inference. Unknown models require the existing `settings.modelPrices`
configuration, even without a USD budget; otherwise routing fails before
inference. The cheap role's ordinary input/output/cache-read rates must not
exceed the strong role's. That rate check alone does not establish savings.

The final execution report includes `model_routing`, routing decisions, attempted
cheap calls and `cost_by_model_usd`. Total usage and `max_budget_usd` continue to
include auxiliary agents, compaction and successful fallback responses. USD
limits are checked after responses and can overshoot by in-flight response
costs. Usage-based costs are estimates at configured token rates; they are not
an invoice reconciliation. A run that escalates can cost more than strong-only.

## Paired live benchmark

The paid benchmark runs the actual `runCodex` runtime in isolated workspaces.
Twelve fixed tasks cover source edits, numeric and boundary cases, retries,
access control, positive reviews and clean reviews. Fixes are checked with
private behavioral assertions. Review findings must match the expected category
and source location, including separate end-of-array and noninteger-index defects; clean files must produce no findings. Both arms receive
identical task/source inputs and execution order is counterbalanced. Each task
runs twice by default. Baseline inference is Terra high, not a token-count
counterfactual. The routed arm includes every observed model response, including
escalations and compaction, in its reported cost.

With `OPENAI_API_KEY` already exported, run:

```bash
bun --no-env-file scripts/model-routing/benchmark.ts
```

`ROUTER_CHEAP_MODEL`, `ROUTER_STRONG_MODEL` and `ROUTER_STRONG_EFFORT` customize the
comparison. `ROUTER_BENCH_OUTPUT` selects the evidence directory (default
`/tmp/model-router-benchmark`), `ROUTER_BENCH_REPEATS` selects 1–10 repetitions,
and `ROUTER_BENCH_CASE` selects one task for diagnosis. The cumulative default
spending limit is $5 (`ROUTER_BENCH_MAX_USD`); each run is also limited to $0.30,
12 turns and three minutes. Cost caps share the after-response limitation above.
Reports are redacted; credentials are never copied into the fixture workspace.

The acceptance gate requires complete pairs, all baseline and routed checks to
pass, and at least **20% lower aggregate estimated API cost**. Failed, partial,
unpriced or quality-regressing comparisons do not qualify. Reports retain
source hashes, the fixture hash, prices, per-case costs and outcomes.

This is a small synthetic suite, not proof of unchanged quality across arbitrary
repositories, large changes, long contexts or GitHub publication. Keep routing
opt-in and qualify additional workloads before enabling it broadly.

## Observed comparison — 7 November 2026

The corrected suite passed its unchanged acceptance gate:

| Measure            | Terra high | Routed Luna low / Terra high |
| ------------------ | ---------: | ---------------------------: |
| Task passes        |      24/24 |                        24/24 |
| Estimated API cost |  $0.103275 |                  $0.05534715 |

Routed execution used **46.4% less estimated API cost**, including observed
escalation calls. There were no paired quality regressions on these tasks.
All 48 saved outputs were also regraded without credentials in grading child
processes. See the [complete evidence](verification/model-routing-2026-11-07.json)
for prices, hashes, per-case outcomes, costs and qualification phases.

Qualification exposed two fixture problems. The initial expected answer omitted
a valid noninteger-index bug; the grader now checks both boundary defects and
boundary-sensitive work starts strong. A supposedly clean sorting fixture did
not state its intended finite-number contract, so Terra reasonably raised a NaN
case. The contract now explicitly guarantees finite inputs; NaN sorting quality
is outside this fixture's coverage. Both arms of that task were rerun. Twenty-two
unchanged task pairs were reused only after exact input and runtime hash checks.
Earlier unsuccessful reports are retained alongside the final evidence.

These measurements cover twelve small synthetic tasks repeated twice. They do
not establish quality parity for arbitrary PRs, long contexts, model/provider
changes or hosted GitHub publication. Routing remains opt-in; the repository's
installed Terra-high workflow and action pins have not been changed.
