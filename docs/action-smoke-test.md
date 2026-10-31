# GitHub Actions smoke test

Use a small pull request to verify the installed Codex workflow before relying on
it for larger changes.

1. Open a pull request from a branch in the same repository using an account
   allowed by the workflow. Mark it ready for review.
2. Confirm the **Codex** workflow starts and the `codex_review` job runs.
3. Confirm the job completes successfully and Codex posts a review summary to the
   pull request. Inline feedback is expected only when it finds an actionable
   defect.
4. Inspect the workflow logs and pull request feedback if the run fails.

Record the pull request and workflow run links with the result so the live test
can be checked later.
