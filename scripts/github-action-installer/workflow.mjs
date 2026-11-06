export const WORKFLOW_PATH = ".github/workflows/codex.yml";
export const MEMORY_WORKFLOW_PATH = ".github/workflows/codex-memory.yml";
export const VALIDATION_ACTION_DIR = ".github/actions/codex-validate";
export const TRUSTED_VALIDATION_ACTION = `./.git/codex-validation/${VALIDATION_ACTION_DIR}`;
export const SETUP_TITLE = "chore(ci): install Codex GitHub Action";

/** Identify setup commits by attempt and workflow path for write reconciliation. */
export function setupCommitMessage(branch, path) {
  return `${SETUP_TITLE}\n\nSetup branch: ${branch}\nWorkflow: ${path}`;
}
export const MANAGED_MARKER = "# Managed by the Codex GitHub Action installer.";
export const DEFAULT_ACTION_REF =
  "coryparrry/claude-code-action@cc1c2eaeec6d0e018f6add3bc28deacbeeaff862";
export const DEFAULT_MODEL = "gpt-6.1-terra";
export const DEFAULT_TRIGGER_PHRASE = "/codex";
export const REVIEW_DIFF_PATH = ".git/codex-review.diff";
export const COMMAND_DELIVERY_POLICY = `          disallowed_tools: Bash,PowerShell
          append_system_prompt: |
            For requested changes, inspect the diff, commit and push using the scoped Git tools.
            Leave test execution to the separate read-only validation job and report validation as pending after delivery.`;
export const AUTOMATIC_REVIEW_PROMPT = `Review this pull request for code quality, bugs, security and performance issues.
Read the prepared patch in ${REVIEW_DIFF_PATH} first; it includes removed lines as well as additions.
Use the repository and PR context. Return actionable findings and a concise summary together.
Propose candidate findings using the native review schema. A separate verifier checks them before publication. Only new, high-confidence patch defects receive inline comments; remembered findings stay in their existing threads. Do not create severity-specific reviews or a combined findings comment.
Do not edit files, commit changes or implement fixes during this review.
The author can request an implementation in a comment with ${DEFAULT_TRIGGER_PHRASE}.`;

/** Reject repository names that could escape a workflow expression or GitHub path. */
export function validateRepository(value) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value ?? "") ||
    [".", ".."].includes(value.split("/")[1])
  )
    throw new Error("Use a repository name in owner/repository format.");
  return value;
}

/** Validate a trusted GitHub login before embedding it in a job condition. */
export function validateActor(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value ?? ""))
    throw new Error("Use a GitHub username for each trusted actor.");
  return value;
}

/** Render repository-bound jobs, using Max effort only for the default Terra model. */
export function renderWorkflow({
  repository,
  actors,
  runner = "ubuntu-latest",
  model = DEFAULT_MODEL,
}) {
  if (!actors?.length) throw new Error("Select at least one trusted actor.");
  validateRepository(repository);
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

permissions: {}

jobs:
  codex:
    permissions:
      contents: write
      issues: write
      pull-requests: write
      actions: read
    outputs:
      head_sha: \${{ steps.agent.outputs.head_sha }}
      comment_id: \${{ steps.agent.outputs.comment_id }}
      comment_type: \${{ steps.agent.outputs.comment_type }}
    if: >-
      github.repository == '${repository}' &&
      (!github.event.pull_request ||
        github.event.pull_request.head.repo.full_name == github.repository) &&
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
${model === DEFAULT_MODEL ? "          codex_effort: max\n" : ""}          max_turns: "30"
          track_progress: "true"
${COMMAND_DELIVERY_POLICY}
      - name: Save execution report
        if: \${{ always() && steps.agent.outputs.execution_file != '' }}
        uses: actions/upload-artifact@v4
        with:
          name: codex-command-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: |
            \${{ steps.agent.outputs.execution_file }}
            \${{ steps.agent.outputs.verification_file }}
          if-no-files-found: error
          retention-days: 7

  validate_change:
    needs: codex
    if: always() && needs.codex.outputs.head_sha != ''
    permissions:
      contents: read
    runs-on: ${runner}
    timeout-minutes: 15
    outputs:
      configured: \${{ steps.verify.outputs.configured }}
    steps:
      - name: Check out delivered commit
        uses: actions/checkout@v6
        with:
          ref: \${{ needs.codex.outputs.head_sha }}
          persist-credentials: false
      - name: Check out trusted validation recipe
        uses: actions/checkout@v6
        with:
          ref: \${{ github.event.pull_request.base.sha || github.workflow_sha }}
          path: .git/codex-validation
          sparse-checkout: ${VALIDATION_ACTION_DIR}
          sparse-checkout-cone-mode: false
          persist-credentials: false
      - name: Verify delivered commit
        id: verify
        shell: bash
        env:
          HEAD_SHA: \${{ needs.codex.outputs.head_sha }}
        run: |
          test "$(git rev-parse HEAD)" = "$HEAD_SHA"
          echo "Checked out delivered commit $HEAD_SHA"
          recipe=${VALIDATION_ACTION_DIR}/action.yml
          entry=$(git -C .git/codex-validation ls-tree HEAD -- "$recipe")
          case "\${entry%% *}" in
            100644|100755)
              test -f ".git/codex-validation/$recipe"
              echo "configured=true" >> "$GITHUB_OUTPUT"
              ;;
            '')
              echo "configured=false" >> "$GITHUB_OUTPUT"
              echo "Project validation skipped. Add $recipe to the trusted base to configure it."
              ;;
            *)
              echo "The trusted validation action.yml must be a regular file."
              exit 1
              ;;
          esac
      - name: Run project validation
        if: steps.verify.outputs.configured == 'true'
        uses: ${TRUSTED_VALIDATION_ACTION}

  report_validation:
    needs: [codex, validate_change]
    if: always() && needs.codex.outputs.head_sha != '' && needs.codex.outputs.comment_id != ''
    permissions:
      issues: write
      pull-requests: write
    runs-on: ubuntu-latest
    steps:
      - name: Append validation to the existing tracking comment
        env:
          GH_TOKEN: \${{ github.token }}
          API_URL: \${{ github.api_url }}
          REPOSITORY: \${{ github.repository }}
          COMMENT_ID: \${{ needs.codex.outputs.comment_id }}
          COMMENT_TYPE: \${{ needs.codex.outputs.comment_type }}
          HEAD_SHA: \${{ needs.codex.outputs.head_sha }}
          VALIDATION_RESULT: \${{ needs.validate_change.result }}
          VALIDATION_CONFIGURED: \${{ needs.validate_change.outputs.configured }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}/attempts/\${{ github.run_attempt }}
        run: |
          node --input-type=module <<'NODE'
          const { API_URL, REPOSITORY, COMMENT_ID, COMMENT_TYPE, HEAD_SHA, VALIDATION_RESULT, VALIDATION_CONFIGURED, RUN_URL, GH_TOKEN } = process.env;
          if (!/^\\d+$/.test(COMMENT_ID) || !/^[a-f0-9]{40}$/.test(HEAD_SHA)) throw new Error('Invalid delivery metadata');
          if (!['issue', 'review'].includes(COMMENT_TYPE)) throw new Error('Invalid tracking comment type');
          const resource = COMMENT_TYPE === 'review' ? 'pulls/comments' : 'issues/comments';
          const url = \`\${API_URL}/repos/\${REPOSITORY}/\${resource}/\${COMMENT_ID}\`;
          const headers = { Authorization: \`Bearer \${GH_TOKEN}\`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
          const response = await fetch(url, { headers });
          if (!response.ok) throw new Error(\`Comment read failed: \${response.status}\`);
          const comment = await response.json();
          const marker = \`<!-- codex-validation:\${HEAD_SHA} -->\`;
          const endMarker = '<!-- /codex-validation -->';
          const status = VALIDATION_RESULT === 'success' && VALIDATION_CONFIGURED !== 'true'
            ? 'skipped (project checks are not configured)'
            : VALIDATION_RESULT;
          const section = \`\${marker}\\nValidation for \\\`\${HEAD_SHA}\\\`: **\${status}**. [View checks](\${RUN_URL}).\\n\${endMarker}\`;
          const start = comment.body.indexOf(marker);
          const end = start < 0 ? -1 : comment.body.indexOf(endMarker, start);
          const body = start >= 0 && end >= 0 ? comment.body.slice(0, start) + section + comment.body.slice(end + endMarker.length) : \`\${comment.body}\\n\\n\${section}\`;
          if (body !== comment.body) {
            const update = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ body }) });
            if (!update.ok) throw new Error(\`Comment update failed: \${update.status}\`);
          }
          NODE

  codex_review:
    if: >-
      github.repository == '${repository}' &&
      github.event_name == 'pull_request' &&
      (${actorCheck}) &&
      !github.event.pull_request.draft &&
      github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: read
      id-token: write
      issues: write
      pull-requests: write
    concurrency:
      group: codex-review-\${{ github.repository }}-\${{ github.event.pull_request.number }}
      cancel-in-progress: true
    runs-on: ${runner}
    timeout-minutes: 35
    env:
      CODEX_REVIEW_REPOSITORY_MEMORY: "true"
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
${model === DEFAULT_MODEL ? "          codex_effort: max\n" : ""}          max_turns: "60"
          review_mode: "true"
          codex_sandbox: read-only
          prompt: |
            ${AUTOMATIC_REVIEW_PROMPT.replaceAll("\n", "\n            ")}
      - name: Save execution report
        if: \${{ always() && steps.agent.outputs.execution_file != '' }}
        uses: actions/upload-artifact@v4
        with:
          name: codex-review-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: |
            \${{ steps.agent.outputs.execution_file }}
            \${{ steps.agent.outputs.verification_file }}
          if-no-files-found: error
          retention-days: 7
      - name: Save repository learning
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
        with:
          name: codex-review-memory-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ runner.temp }}/codex-review-memory/\${{ github.run_id }}-\${{ github.run_attempt }}/candidate.json
          if-no-files-found: ignore
`;
}

/** Install the trusted publisher beside the review workflow, with no per-repo configuration. */
export function renderMemoryWorkflow({ repository, actors }) {
  if (!actors?.length) throw new Error("Select at least one trusted actor.");
  validateRepository(repository);
  actors.forEach(validateActor);
  const action = DEFAULT_ACTION_REF.replace("@", "/review-memory@");
  return `${MANAGED_MARKER}
name: Codex memory

on:
  workflow_run:
    workflows: [Codex]
    types: [completed]
  pull_request_target:
    types: [closed]

permissions: {}

jobs:
  memory:
    if: >-
      github.repository == '${repository}' && (
      (github.event_name == 'workflow_run' &&
        github.event.workflow_run.event == 'pull_request' &&
        github.event.workflow_run.conclusion == 'success' &&
        github.event.workflow_run.head_repository.full_name == github.repository &&
        contains(fromJSON('${JSON.stringify(actors)}'), github.event.workflow_run.actor.login)) ||
      (github.event_name == 'pull_request_target' &&
        github.event.action == 'closed' &&
        github.event.pull_request.head.repo.full_name == github.repository))
    permissions:
      contents: write
      actions: read
      pull-requests: read
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: ${action}
        with:
          github_token: \${{ github.token }}
          trusted_actors: ${JSON.stringify(actors.join(","))}
`;
}
