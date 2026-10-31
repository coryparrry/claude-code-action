# Native reviews with one grouped findings discussion

Set `review_mode: "true"` to retain GitHub's normal review hierarchy:

```text
Native review summary
└─ One inline discussion
   ├─ Bug findings
   ├─ Optional suggestions
   └─ Pre-existing findings
```

All findings expand inside that single discussion, rather than creating a separate
comment and inline thread for every severity or code location. The main review
contains the concise conclusion, coverage and supporting review details.

- The grouped discussion attaches to a real line in the current PR diff, preferring
  the highest-priority finding with an eligible location. If its location is outside
  the diff, another actual changed line anchors the group.
- Every finding includes a code-location link, evidence, verification and a stable
  ID. Current-code links are pinned to the reviewed commit; removed lines link to
  the frozen comparison, including renamed paths.
- One API call submits the native summary and its single grouped inline comment.
  The publisher never posts a standalone issue comment or severity-specific reviews.
- No-findings reviews have no inline discussion. For a binary-only or otherwise
  non-commentable diff, findings stay inside the native main review because GitHub
  has no valid inline text line to attach them to.
- Same-head reruns reuse the existing native review. New reviewed heads get a new
  commit-specific review, preserving GitHub's reviewed-changes metadata.
- Follow-ups receive the complete latest marked review and its bot-authored finding
  discussion as untrusted reference data. They recheck and return findings that still
  apply. Duplicate IDs within one result are removed; existing findings are not hidden
  simply because they appeared before.

The existing OpenAI runtime returns validated data with read/search tools. The
trusted publisher checks the current PR head before selecting an anchor and again
before submission. Ambiguous mutations are not blindly retried; a rerun locates a
saved completed review by its marker. Each comment has a 60,000 UTF-8 byte limit;
oversized output fails instead of splitting into more threads.

Review mode retains model, effort, turn and budget controls and excludes inherited
MCP, hooks, plugins and session resumption. It only submits COMMENT reviews, with
no approval, request-changes or merge capability. Use the action conclusion and
`review_url` output to verify delivery.

```yaml
- uses: coryparrry/claude-code-action@a33556552f78f552fe4470275050ce7e57dc98e8
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
