# Requested changes and CI diagnosis

The action supports three connected workflows: fixing requested PR findings,
implementing issues, and diagnosing CI failures. Use an action revision that
contains these refinements; an existing release pin does not update itself.

## Fix a PR finding

Reply to an inline finding with `/codex fix this`, or request a specific change
in a general PR comment. For inline replies, the action preserves the webhook's
file, original/current line, commit and diff, then retrieves the parent finding
directly. This works even when the parent is outside the fetched page of reviews.
Parent context is subject to actor filters and must predate the triggering reply,
including its last edit. Minimized parents are withheld. Visible fenced and inline code is preserved as reference data. Prepared attachments, including out-of-page parent images, are viewed through opaque image IDs. If the parent is unavailable and the request remains
ambiguous, the agent is instructed to report the missing context instead of guessing.

The agent is instructed to verify the finding against the current code, implement
only the requested change, add relevant regression coverage, run permitted checks,
and push to the prepared PR branch. An open PR uses its existing branch; a closed
or merged PR uses a replacement branch and a PR creation handoff.

Review and question requests remain read-only unless the request also asks for
changes. The automatic PR review workflow keeps its existing review instructions.

## Implement an issue

Put `/codex` and an implementation request in the issue title, body, or a comment.
Label and assignment triggers also work when configured in the calling workflow.
The agent is instructed to establish acceptance criteria, use the prepared issue
branch, implement and validate the change, and push it.

The final tracking comment should report what changed, the acceptance criteria
met, exact verification results, remaining blockers and the branch/commit link.
Scoped Git tools accept explicit file paths and literal commit messages, preserve unrelated staging, work in linked worktrees and push only to the prepared branch. Raw Git shell commands are not granted by default.

It should include a **Create a PR** link targeting the prepared base branch, with
a concrete title, behavior summary, verification results and issue reference.
That link opens GitHub's PR creation form; it is not an already-created PR.
Unfinished or blocked work should remain unchecked.

## Diagnose or fix CI

Ask `/codex why is CI failing?` for diagnosis, or `/codex diagnose and fix the
failing tests` to authorize implementation too. The calling job's token needs
`actions: read`, alongside the permissions required for comments and any writes:

```yaml
permissions:
  contents: write
  issues: write
  pull-requests: write
  actions: read
```

CI status reports the current PR head SHA and the independent workflow runs
for that revision. PR-event runs must also be associated with the requested PR; a shared SHA alone does not establish that association. Only duplicate attempts of the same run are collapsed before
applying an optional status filter. Timed-out, startup and action-required failures count
as failures; cancelled, skipped, neutral and unknown outcomes remain separate.
Workflow details include job/step outcomes, the run's SHA and whether it still
matches the current PR revision. Failed-job downloads return bounded, redacted excerpts directly to the agent, with offsets for additional pages. Temporary paths do not require broader file access.

The agent is instructed to cite the relevant run/job and error, distinguish code
failures from suspected flakes or infrastructure problems, and report uncertainty.
After a fix, local test success and hosted CI status are reported separately.
Pending or absent checks do not establish a passing result.

## Isolate repository validation

Repository package installation and tests execute repository-controlled code. Run them
in a separate job with `contents: read`, checkout `persist-credentials: false`, and no
model key or write token. Do not grant these commands to the write-capable agent.
The repository's Codex workflow implements this separation and appends the actual
validation result to the existing tracking comment.

The action exposes `head_sha`, recorded by this invocation’s successful push and confirmed against the remote branch through
GitHub, and `comment_id` for reporting. Validate that
exact immutable SHA. A successful agent run establishes neither a push nor passing
tests by itself; an absent `head_sha` means no downstream validation can be claimed. No-op runs and branches advanced by another writer do not produce a delivery SHA.
Custom shell grants remain supported for workflows that deliberately need them.

Automatic reviews retain one full current overview. Earlier bot overviews link to
the current review; historical inline findings remain attached to their reviews.
Same-commit reruns repair incomplete overview cleanup without creating another review.

Prompt instructions guide model behavior; offline regression tests do not prove
successful live implementation or diagnosis in every consumer repository.
