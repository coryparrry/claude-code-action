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
including its last edit. If the parent is unavailable and the request remains
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
for that revision. Only duplicate attempts of the same run are collapsed before
applying an optional status filter. Timed-out, startup and action-required failures count
as failures; cancelled, skipped, neutral and unknown outcomes remain separate.
Workflow details include job/step outcomes, the run's SHA and whether it still
matches the current PR revision.

The agent is instructed to cite the relevant run/job and error, distinguish code
failures from suspected flakes or infrastructure problems, and report uncertainty.
After a fix, local test success and hosted CI status are reported separately.
Pending or absent checks do not establish a passing result.

## Permit repository validation commands

Implementation prompts do not grant new shell permissions. Configure the
commands appropriate to your project using the action's `allowed_tools` input.
For example, a Bun project might add:

```yaml
with:
  allowed_tools: "Bash(bun test:*),Bash(bun run typecheck:*)"
```

These rules permit the listed command prefixes and their arguments. Include any
required setup or additional checks deliberately. If a required check is denied,
the agent should report the command and blocker rather than claim validation.
Prompt instructions guide model behavior; offline regression tests do not prove
successful live implementation or diagnosis in every consumer repository.
