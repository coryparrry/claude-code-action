# Install the Codex GitHub Action

The guided installer handles repository selection, the API-key secret and the
workflow-pair PR. It runs locally using Node.js and GitHub CLI, without Bun or extra
Node dependencies. The generated workflow uses Terra 6.1 (`gpt-6.1-terra`) at Max effort, the reviewed
action commit and the repository's built-in workflow token. A custom `--model`
selection leaves reasoning effort unset so the provider can use a compatible default.

The reviewed runtime changes are included in that source pin. See the
[feature comparison](./feature-parity.md) for coverage and remaining differences.

## Guided installation

When the latest stable release includes `codex-action.tgz`, run this command
from the GitHub repository you want to connect. Use Node.js 20 or later and
GitHub CLI.

```bash
npx --yes --allow-remote=all https://github.com/coryparrry/claude-code-action/releases/latest/download/codex-action.tgz install
```

The wizard offers GitHub browser login when needed and uses GitHub CLI's selected
repository for the current checkout. It shows the target before applying the
setup. Outside a checkout, the wizard offers a repository picker. Use
`--repo owner/repository` to select a different target or repeat it for multiple
repositories. Choose Linux or macOS for Xcode tasks.

The `--allow-remote=all` flag lets npm 12 fetch the GitHub release tarball for
this command. The tarball contains the installer and has no npm dependencies.

To try a build before release, download and unzip the `codex-action-installer`
artifact from its CI run. From the repository you want to connect, run
`npx --yes --package=/path/to/codex-action.tgz codex-action install`.

Existing `OPENAI_API_KEY` repository secrets are reused. For missing secrets, the
wizard asks whether to use an existing environment variable or `.env.local` key,
or lets you enter a key with masked input. It does not create an OpenAI key or
make paid model requests. Secrets go to GitHub through stdin and never appear in
command arguments, workflow files or installer output.

The installer verifies its pinned publisher action, then opens draft setup PRs containing both the review and memory-maintenance workflows. Review and merge them onto each repository's
default branch. The generated workflow then automatically reviews same-repository,
non-draft PRs opened, updated, reopened or marked ready by a selected trusted user.
Each reviewed head gets one native GitHub review summary with a separate coloured inline comment for each finding at its actual diff location. Each issue has its own discussion and expandable evidence; there is no combined findings comment. Same-head reruns reuse the submitted review. They run with read/search tools and do not produce a task-completion tracking comment. The action publishes only validated output against the reviewed head; invalid output, a changed PR or rejected delivery fails the action. See [review presentation](./review-presentation.md) for details and named-bot authentication.
A preparation step saves the PR's base-to-head patch inside `.git/` so reviews
can inspect additions and deleted lines without granting the agent shell access.
A newer review run cancels an older review for the same PR.

Repository learning is provisioned automatically in each installed repository on
`codex/review-memory`. No memory issue, repository variable, branch creation or
storage secret is required. The review agent remains read-only; a separate trusted
workflow validates candidates and publishes exact merged revisions without a model
call. See [repository memory](./repository-memory.md) for limits and verification.

Ask questions or request implementations with `/codex` in issue titles/bodies,
issue or PR comments, inline review comments, or submitted review text. These
requests also show progress and retain write access for requested changes. Test
with an issue or PR comment:

```text
/codex Summarise this issue. Do not change any files.
```

Check the Actions tab for the run. The workflow allows only the selected trusted
users to trigger either job. Fork PRs remain disabled by the action. Automatic
reviews call the selected model on each qualifying PR event; `/codex` requests
call it when explicitly requested.

Command and review jobs save execution reports in the run's Actions artifacts
for seven days, including failed runs that produced a report. Reports can contain
private prompts, repository content and tool output; access follows the
repository's GitHub permissions.

## Validate changes delivered by `/codex`

Fresh installs and managed workflow upgrades include separate validation and
reporting jobs. When `/codex` pushes a change, the validation job checks out the
exact pushed commit with a read-only token, no persisted Git credentials and no
OpenAI key. It runs on the selected Linux or macOS runner. In the managed command
job, Codex uses its file-edit and scoped Git tools for delivery. Shell execution
is reserved for validation.

Add a composite action at `.github/actions/codex-validate/action.yml` in the
target repository. Define the setup and checks for that project in the action.
For a project with an npm lockfile, for example:

```yaml
name: Validate Codex change
description: Install locked dependencies and run project tests.
runs:
  using: composite
  steps:
    - shell: bash
      run: |
        npm ci
        npm test
```

The reporting job adds the result, the exact commit SHA and a link to the
Actions run to the existing GitHub tracking comment. Without a project action,
the workflow checks the checkout SHA and reports that project checks were
skipped. A request that pushes no commit has no validation result.

## Run from a source checkout

Link the command once from this checkout:

```bash
npm link --ignore-scripts
```

Then run `codex-action install` in any directory. Without linking, use
`node /path/to/claude-code-action/scripts/install-github-app.mjs`.

## Package the installer for a release

From the release commit, run `npm run pack:installer -- VERSION OUTPUT_DIRECTORY`
with the release version without its `v` prefix. Attach the resulting
`codex-action.tgz` to the GitHub release before publishing. The quickstart URL
downloads that asset from the latest stable release. For a pinned installer,
replace `latest/download` with `download/vVERSION` in the command.

## Preview and automation

```bash
codex-action doctor --json
codex-action repos --json
codex-action install --repo owner/repo --dry-run --json
codex-action install --repo owner/repo --repo owner/another \
  --key-file /path/to/.env.local --runner macos-latest --yes
```

`--key-file` accepts an env file containing `OPENAI_API_KEY` or a file containing
just the key. Relative paths resolve from the calling directory. `--use-env-key`
explicitly selects the current `OPENAI_API_KEY`; no key is silently selected in
noninteractive mode. `--yes` approves writes to explicitly named repositories.
`--dry-run` never reads key files or makes writes.

Use `--actor username` repeatedly to allow several trusted users, `--model` to
select another supported OpenAI model, and `--replace-secret` only when you intend
to rotate an existing repository secret. Run `codex-action --help` for all options.

JSON output uses `{ "ok": true, ... }` for successful reads/plans/results and
`{ "ok": false, "error": { "message": "..." } }` for failures. `doctor` includes
`ready` and a `nextStep`; it does not require an OpenAI key. Successful installs
return a `results` array with repository, status and setup PR URL. Partial failures
include completed `results`, so an earlier repository's setup is still visible.

## Existing setups and failures

- Identical installed workflows and existing secrets are reused.
- Rerun the installer and merge its update PR to add validation and reporting
  to an existing managed workflow. Move any custom checks embedded in an older
  workflow to the repository's composite action before merging the update.
- Matching open setup PRs are reused after checking that they contain only the
  installer workflow. PRs with different settings or extra changes are rejected.
- Only workflows bearing the installer marker can be updated. An existing
  unmarked `.github/workflows/codex.yml` is preserved and installation stops.
- The account needs repository write access and access to manage Actions secrets
  and workflow files. New browser logins request the `repo` and `workflow` scopes.
  For an existing GitHub CLI login missing workflow access, run
  `gh auth refresh --scopes workflow`.
- If setup fails after uploading a secret or creating a branch, those completed
  steps remain. Inspect the named branch before retrying. Rerunning reuses existing
  secrets and matching open PRs; it never removes another branch or PR.
- Repository or organization Actions policies must permit this action and its
  requested workflow permissions. The installer does not change those policies.

The installer uses `github-actions[bot]` through the workflow token. A separate
GitHub App identity remains an advanced setup described in the setup guide.

## Fork protection

Generated AI jobs are bound to the selected repository name. A copied workflow
in a fork skips both commands and automatic reviews, even for a trusted actor.
An intentionally selected fork can still be installed as its own repository.

Reviews and review comments from external PR heads are skipped before checkout.
For `/codex` issue comments on PRs, the action resolves the head repository through
GitHub and skips fork PRs before invoking the model. Unresolved origins fail closed.
Rerun the installer and merge its update PR to apply these guards to an older setup.
