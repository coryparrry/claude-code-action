# Native pull request reviews

This reproduces the presentation of Anthropic's [managed Code Review service](https://code.claude.com/docs/en/code-review), which is separate from the open-source Claude Code Action. It reuses this action's existing OpenAI runtime, authentication, read tools and lifecycle. It does not establish parity with the managed service's review engine, check runs or automatic thread resolution.

Set `review_mode: "true"` to publish a GitHub **COMMENT** review instead of a
task-completion comment. The presentation follows the [Claude bot reference](https://github.com/anthropics/claude-code-action/pull/1915):

- 🔴 findings describe introduced bugs; 🟡 findings are optional suggestions;
  🟣 findings identify pre-existing bugs.
- Findings appear on the affected diff lines. Each has expandable **Why this
  was flagged** evidence, verification, and a stable finding ID.
- The review summary lists what was reviewed, with an **Extended reasoning...**
  disclosure for scope, evidence and verification limitations. This is a concise
  explanation, not private model reasoning.
- Follow-up runs receive the bot's earlier reviews and findings as reference.
  Exact finding IDs are deduplicated even when their line changes. Reworded
  findings still depend on the model recognizing the earlier report. Existing
  threads are preserved; the action does not auto-resolve them or claim a fix.
- One marked review per bot and head SHA prevents duplicates on workflow reruns.
  Publishing rejects a changed/closed PR and reports GitHub delivery failures.

The model returns validated data and receives only read/search tools. The action
publishes the summary and findings together, pinned to the reviewed head.
Review mode retains model, effort, turn-limit and budget controls. It excludes
custom MCP servers, hooks, plugins, session resumption and execution settings. It
cannot approve, request changes, or merge through this publisher. A successful
model report alone does not prove review delivery; use the action conclusion
and `review_url` output.

```yaml
- uses: coryparrry/claude-code-action@<reviewed-commit>
  with:
    openai_api_key: ${{ secrets.OPENAI_API_KEY }}
    review_mode: "true"
    codex_sandbox: read-only
    prompt: Review the prepared patch in .git/codex-review.diff.
```

Use `pull_request` events for same-repository PRs and prepare the base-to-head
patch as in the generated workflow. `review_mode` is incompatible with
`track_progress`; interactive `/codex` tasks retain their existing progress
comments. Existing installed workflows need an updated action revision and
`review_mode: "true"` to use this presentation.

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
