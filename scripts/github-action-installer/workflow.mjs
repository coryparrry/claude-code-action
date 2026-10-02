export const WORKFLOW_PATH = ".github/workflows/codex.yml";
export const MANAGED_MARKER = "# Managed by the Codex GitHub Action installer.";
export const DEFAULT_ACTION_REF =
  "coryparrry/claude-code-action@43a2ba1c9a47672152dbaa447bef74f74939ee27";
export const DEFAULT_MODEL = "gpt-6-luna";
export const DEFAULT_TRIGGER_PHRASE = "/codex";
export const REVIEW_DIFF_PATH = ".git/codex-review.diff";
export const AUTOMATIC_REVIEW_PROMPT = `Review this pull request for code quality, bugs, security and performance issues.
Read the prepared patch in ${REVIEW_DIFF_PATH} first; it includes removed lines as well as additions.
Use the repository and PR context. Provide actionable inline feedback and a summary.
For final inline findings, call mcp__github_inline_comment__create_inline_comment with confirmed: true, using verified paths, line numbers and sides from the patch.
If GitHub rejects a comment, correct its location and retry, or explain the finding in the summary. Claim an inline comment was posted only after the tool returns its GitHub URL.
Do not edit files, commit changes or implement fixes during this review.
The author can request an implementation in a comment with ${DEFAULT_TRIGGER_PHRASE}.`;

export function validateRepository(value) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value ?? "") ||
    [".", ".."].includes(value.split("/")[1])
  )
    throw new Error("Use a repository name in owner/repository format.");
  return value;
}

export function validateActor(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value ?? ""))
    throw new Error("Use a GitHub username for each trusted actor.");
  return value;
}

export function renderWorkflow({
  actors,
  runner = "ubuntu-latest",
  model = DEFAULT_MODEL,
}) {
  if (!actors?.length) throw new Error("Select at least one trusted actor.");
  actors.forEach(validateActor);
  if (!["ubuntu-latest", "macos-latest"].includes(runner))
    throw new Error("Choose ubuntu-latest or macos-latest for the runner.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(model))
    throw new Error("Use a valid OpenAI model name.");
  const actorCheck =
    actors.length === 1
      ? `github.actor == '${actors[0]}'`
      : `contains(fromJSON('${JSON.stringify(actors)}'), github.actor)`;
  return `${MANAGED_MARKER}
name: Codex

on:
  issue_comment:
    types: [created]
  issues:
    types: [opened]
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  codex:
    if: >-
      (${actorCheck}) &&
      (
        ((github.event_name == 'issue_comment' || github.event_name == 'pull_request_review_comment') &&
          contains(github.event.comment.body, '${DEFAULT_TRIGGER_PHRASE}')) ||
        (github.event_name == 'pull_request_review' &&
          contains(github.event.review.body, '${DEFAULT_TRIGGER_PHRASE}')) ||
        (github.event_name == 'issues' &&
          (contains(github.event.issue.body, '${DEFAULT_TRIGGER_PHRASE}') ||
           contains(github.event.issue.title, '${DEFAULT_TRIGGER_PHRASE}')))
      )
    runs-on: ${runner}
    timeout-minutes: 35
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - id: agent
        uses: ${DEFAULT_ACTION_REF}
        with:
          trigger_phrase: ${JSON.stringify(DEFAULT_TRIGGER_PHRASE)}
          openai_api_key: \${{ secrets.OPENAI_API_KEY }}
          codex_model: ${JSON.stringify(model)}
          codex_effort: low
          max_turns: "30"
          track_progress: "true"
      - name: Save execution report
        if: \${{ always() && steps.agent.outputs.execution_file != '' }}
        uses: actions/upload-artifact@v4
        with:
          name: codex-command-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ steps.agent.outputs.execution_file }}
          if-no-files-found: error
          retention-days: 7

  codex_review:
    if: >-
      github.event_name == 'pull_request' &&
      (${actorCheck}) &&
      !github.event.pull_request.draft &&
      github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: read
      issues: write
      pull-requests: write
    concurrency:
      group: codex-review-\${{ github.repository }}-\${{ github.event.pull_request.number }}
      cancel-in-progress: true
    runs-on: ${runner}
    timeout-minutes: 35
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha }}
      - name: Prepare PR diff
        env:
          CODEX_PR_BASE_SHA: \${{ github.event.pull_request.base.sha }}
          CODEX_PR_HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: >-
          git diff --no-ext-diff --no-textconv "$CODEX_PR_BASE_SHA...$CODEX_PR_HEAD_SHA" -- > ${REVIEW_DIFF_PATH}
      - id: agent
        uses: ${DEFAULT_ACTION_REF}
        with:
          trigger_phrase: ${JSON.stringify(DEFAULT_TRIGGER_PHRASE)}
          openai_api_key: \${{ secrets.OPENAI_API_KEY }}
          codex_model: ${JSON.stringify(model)}
          codex_effort: low
          max_turns: "30"
          track_progress: "true"
          codex_sandbox: read-only
          codex_args: >-
            --allowedTools "mcp__github_inline_comment__create_inline_comment"
          prompt: |
            ${AUTOMATIC_REVIEW_PROMPT.replaceAll("\n", "\n            ")}
      - name: Save execution report
        if: \${{ always() && steps.agent.outputs.execution_file != '' }}
        uses: actions/upload-artifact@v4
        with:
          name: codex-review-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ steps.agent.outputs.execution_file }}
          if-no-files-found: error
          retention-days: 7
`;
}
