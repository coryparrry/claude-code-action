# Install the Codex GitHub Action

The guided installer handles repository selection, the API-key secret and the
workflow PR. It runs locally using Node.js and GitHub CLI, without Bun or extra
Node dependencies. The generated workflow uses Luna 6 (`gpt-6-luna`), the reviewed
action commit and the repository's built-in workflow token.

New local parity changes are not included in that published pin. See the
[feature comparison](./feature-parity.md) before installing; publishing a reviewed
revision and updating the pin are required to deliver those additions.

## Guided installation

From the cloned action repository:

```bash
npm run install-github-app
```

The wizard offers GitHub browser login when needed, lists up to 100 owned
repositories and also accepts organization or collaborator repositories by
`owner/repository` name. Select one or several repositories, choose Linux or
macOS for Xcode tasks, then review the proposed setup before applying it.

Existing `OPENAI_API_KEY` repository secrets are reused. For missing secrets, the
wizard asks whether to use an existing environment variable or `.env.local` key,
or lets you enter a key with masked input. It does not create an OpenAI key or
make paid model requests. Secrets go to GitHub through stdin and never appear in
command arguments, workflow files or installer output.

The installer opens draft setup PRs. Review and merge them onto each repository's
default branch. The generated workflow then automatically reviews same-repository,
non-draft PRs opened, updated, reopened or marked ready by a selected trusted user.
Reviews post feedback with progress tracking and use read-only code access.
A preparation step saves the PR's base-to-head patch inside `.git/` so reviews
can inspect additions and deleted lines without granting the agent shell access.
A newer review run cancels an older review for the same PR.

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

## Run from any directory

Link the command once from this checkout:

```bash
npm link --ignore-scripts
```

Then run `codex-action install` in any directory. Without linking, use
`node /path/to/claude-code-action/scripts/install-github-app.mjs`.

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
- Rerun this installer to propose an update for an older managed workflow that
  only enables commands. Merge the update PR to enable automatic reviews; local
  installer changes do not alter an already installed workflow.
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
