# Native reviews with individual inline findings

Set `review_mode: "true"` to use GitHub's normal review hierarchy:

```text
One native review summary
├─ Coloured inline comment for issue A at its code location
├─ Coloured inline comment for issue B at its code location
└─ Coloured inline comment for issue C at its code location
```

Each finding is its own inline comment, marked red for a bug, yellow for an
optional suggestion or purple for a pre-existing defect. The title and impact
are visible; supporting evidence and verification expand inside that comment.
The main summary contains the review conclusion, coverage and review details.
There is no combined findings comment and no separate review per severity.

One API call submits the summary and all individual inline comments together.
Every finding's path, line and diff side are validated against the PR's actual
patch, including renamed files and deleted lines. The publisher never moves an
issue to unrelated code. A finding without a commentable location fails before
submission with an explicit diagnostic; it does not become an aggregate list or
silently disappear. Binary-only diffs cannot support line comments. A review
with no findings submits just the summary.

Same-head reruns return the completed review URL. New reviewed heads get a new
commit-specific review. Follow-ups receive the full latest bot-owned summary
and its individual finding comments as untrusted reference data, rechecking
findings that still apply. Duplicate IDs within one result are removed.

The OpenAI runtime returns validated data using read/search tools. The trusted
publisher checks the current PR head and open state before publication. Ambiguous
mutations are not blindly retried; a rerun locates a saved completed review.
The 60,000 UTF-8 byte limit applies to each comment individually, so multiple
findings may collectively exceed it without requiring a combined comment.

Review mode retains model, effort, turn and budget controls and excludes inherited
MCP, hooks, plugins and session resumption. It only submits COMMENT reviews, with
no approval, request-changes or merge capability. Use the action conclusion and
`review_url` output to verify delivery.

```yaml
- uses: coryparrry/claude-code-action@ab11fd1f14fc26ed6defba4d2a373309559d8c85
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    review_mode: "true"
    codex_sandbox: read-only
    prompt: Review the prepared patch in .git/codex-review.diff.
```

Use same-repository `pull_request` events and prepare the base-to-head patch as in
the generated workflow. `review_mode` is incompatible with `track_progress`.
Existing installations need the updated source pin.

## Other comments and progress

Task progress, finding sections, review details and error diagnostics share the
same GitHub-supported disclosure renderer. Task comments use checkboxes and an
expanded current step; error details and completed evidence stay collapsed.
Finalization removes the initial loading state, including edited checklists and
failures, while preserving model-authored task state and evidence.

The [rendering test](https://github.com/coryparrry/claude-code-action/pull/6#issuecomment-6546724109)
verified native checkboxes, a spinner and disclosures. GitHub strips HTML progress
elements, and open-page refresh remains inconsistent. The API saves edits but cannot
force viewers' PR pages to re-render immediately.

Reviews publish after inference; interactive progress uses existing tag-mode tools.
This reproduces presentation, not the managed Claude service's review engine,
check runs or automatic thread resolution.

## Bot identity

GitHub determines the review author from the token. The default workflow token
posts as `github-actions[bot]`. For a named bot with its own avatar, use your own
GitHub App through `github_app_id` and `github_app_private_key` (and
`github_app_installation_id` when needed), or pass its installation token in
`github_token`. Set `bot_name` to that App's exact bot login, including `[bot]`,
so follow-up review lookup uses the same author. An explicit installation token can use contents read and pull requests write
access. The built-in App token minting currently requests contents, issues and
pull requests write access by default, so the installation must allow those. Setting `bot_name` alone
does not change GitHub's author. The hosted Codex integration is a separate bot
and its comments are independent of this action.
