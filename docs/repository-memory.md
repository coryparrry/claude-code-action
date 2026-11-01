# Automatic repository memory

Run the guided installer for one or several repositories. It installs the review
workflow and the trusted memory-maintenance workflow. Each repository gets its own
`codex/review-memory` branch when the first validated learning is saved. There is
no memory issue, database, repository variable or additional storage secret to set up.
The existing OpenAI key setup is unchanged.

## Small runtime surface

Memory reuses the existing native review response: one nullable `repository_learning`
field contains a concise reusable invariant, architectural constraint or test location.
There is no memory-specific MCP tool, model call, review engine or prompt-cache
implementation. Current-PR findings remain in their existing review threads.

The read-only review job writes a small candidate artifact. A separate workflow runs
only pinned action code, never consumer PR code. It checks the successful source run,
trusted actor, repository, exact reviewed head and changed paths before storing a note.
Unmerged notes stay pending. PR closure publishes only the exact merged head and
retires superseded pending notes only once the merged head is immutable. Other pending notes remain hidden and age out under the bounded retention limit. Fresh reconciliation handles a merge
that races with review completion.

The store is one schema-validated `index.json` file. Git provides atomic snapshots,
history and fast-forward-only updates with three bounded conflict attempts. No
separate record files, content IDs or dual-write synchronization are needed.
Repository names come from GitHub event context, keeping installations isolated.

## Bounded cost and context

- One optional learning per review; notes are at most 700 UTF-8 bytes and five literal paths.
- At most three relevant published notes, totaling 2,000 bytes, enter the prompt.
- Read at most 500 entries / 256 KiB; retain newest entries and preserve old versions in Git history.
- Match exact files or directory prefixes; omit unrelated, pending and same-PR notes.
- Paginate changed files with a 3,000-file API budget and report unfinished coverage.
- Treat every note as untrusted reference data; recheck current code. Explicit policy belongs in AGENTS.md or optional .codex/review.md.

Maintenance uses the built-in GitHub token with contents-write, actions-read and
pull-requests-read permissions. It makes no model calls, but its runs consume GitHub
Actions time according to the repository's plan. Repository rules may reject branch
writes; such failures remain visible in the maintenance run.

## Complexity contract

`bun --no-env-file run check:review-complexity` checks the memory and installer
modules using the existing Babel parser. Functions have a cyclomatic complexity
budget of 15; files have a 500-line budget. Decisions include branches, logical
operators, default parameters and optional access. Nested functions are measured
independently. CI enforces this contract alongside tests and type checking.

## Release qualification

The release must pass unit/integration tests, both typechecks, formatting,
production-package checks, the complexity gate and hosted CI. Live qualification
must install into two repositories and demonstrate pending storage, exact-head merge
publication and retrieval from a later PR. Source and installed-action commit pins
are recorded with the final release evidence; local tests alone are not hosted proof.
