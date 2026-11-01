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

## Cache and call reuse

A review with no candidate findings skips the verifier and produces no verifier
report. Its overview states that no independent verification was needed; this is
not proof that the patch is defect-free. Existing findings stay in their original
threads. Verified reviews on the same head are reused without another model run.

SDK calls use a stable, hashed repository-and-phase cache key across commits and
reruns. The runtime keeps provider-default retention for frequent tool loops rather than
opting into more expensive 12-hour writes, and does not send model-specific
retention settings to older fallback models.
The provider still requires an identical prompt prefix; a cache key does not force
a hit. Reviewer and verifier contexts remain independent. Reports expose cache
read and write token counts, so reuse can be measured.

Scoped Git keeps repository hooks disabled. It refuses to push newly introduced
Git LFS pointers because it cannot safely run the repository's pre-push upload
hook. A trusted LFS upload step is required for that unsupported delivery path.

Plan/read-only mode blocks scoped Git, file-operation and standard GitHub MCP
repository mutations even when explicitly allowed. The dedicated tracking-comment
update tool remains available to report progress; read-only does not suppress
that reporting channel.

## Follow-up review efficiency and delivery edges

Retired overviews keep their original replacement link instead of being rewritten
on every later commit. Only the previous full overview is retired, keeping update
work linear across a PR's history. Finding memory retains the claim and cause
before clipping long verification appendices.

Symlink targets are preserved as regular text directly from HEAD objects, never
by following their destinations, so target-line findings can satisfy the read gate.
Scoped Git diffs check both Read and Grep denials for every changed path before
returning content. Agent-mode PR writes prepare a clean actual-head checkout in
place of GitHub's synthetic merge ref and refuse to overwrite existing work.

A remotely confirmed push remains eligible for isolated validation even if a
later model call fails. The model failure stays visible separately from the
validation result.
