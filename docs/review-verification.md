# Review verification and memory

Native reviews have two separate read-only model passes. The reviewer proposes
candidates. A fresh verifier tries to disprove each claim by checking its trigger,
causal path, caller guards, supported configuration, existing tests and whether
the patch introduced the defect. Both passes use the configured model and effort;
the verifier has no reviewer conversation, GitHub tools, shell or write access.

Only a **confirmed, high-confidence defect introduced by the patch** can produce
a new inline comment. That comment displays “Confidence: high · independent static
inspection” and includes the trigger, source evidence and counterargument checked.
Confidence is a qualitative inspection judgment, not a calibrated probability.
The gate requires successful recorded Read calls for the prepared patch, cited source lines and each confirmed current-code location. A model’s assertion that it inspected code is insufficient. Neither pass executes tests. This gate reduces unsupported publication; it does
not establish a measured false-positive rate or guarantee every bug is found.

Medium/low-confidence, uncertain, rejected, pre-existing and preference-only claims
stay out of the PR thread. The verifier report retains actual read ranges and every candidate disposition
for inspection. The overview's outcome and merge-risk assessment come from the
verified evidence, rather than repeating the first pass's rejected claims.
Missing, duplicate, malformed or stale verifier decisions fail the review before
publication. There is no fallback that publishes unverified candidates.

## Durable PR memory

Every run reads all pages of the PR's prior bot finding threads, including resolved
threads. The repository, PR number and bot identity scope this memory; there is no
shared personal or cross-repository memory store. Human-authored markers cannot
suppress bot findings. GitHub's stored threads survive runner/session restarts. Legacy grouped comments and findings in native review bodies are included; compact finding evidence is retained when their overviews are retired.

The first pass sees that history. The verifier matches equivalent claims by their
trigger and cause, even when the title or line changed. The trusted publisher also
checks stable finding IDs against prior bot comments immediately before posting.
A known finding stays in its original thread. The action does not reopen resolved
threads or post another inline copy of the same claim. A distinct new defect can
still be reported. If history cannot be read completely, publication fails closed.

Only one full current overview remains visible. Earlier overviews link to it and
retain their original inline discussions. The overview no longer repeats detailed
finding text.

## Limits and evidence

The installed native-review workflow allows 60 total turns; command jobs retain 30.
`max_turns` and `max_budget_usd` apply across both phases. The reviewer receives two
thirds of configured turns/cost, reserving the rest for verification. Unused
allowance remains available to the verifier. Native reviews require at least two
configured turns. Missing usage accounting or exhausted limits prevent publication.
The USD guard remains an estimate checked after responses, not an account billing cap.

`execution_file` retains the reviewer report. `verification_file` retains the
separate verifier report, including withheld candidates. Generated workflows upload
both. A successful model pass is not a passing CI run or merge approval.
