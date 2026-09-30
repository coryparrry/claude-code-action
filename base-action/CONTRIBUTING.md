# Contributing

Install Bun, run `bun install` in base-action, then use `bun test` and `bun run typecheck`. The tests exercise an offline fake Codex CLI; they do not need a live API key.

Keep changes focused, add regression coverage for changed behavior, and run `bun run format:check` before proposing a change to the fork.

Use the main action for GitHub trigger and comment workflows. The base action accepts a prompt directly and runs only Codex.
