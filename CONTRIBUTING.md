# Contributing

This independent MIT-licensed fork runs Codex CLI with OpenAI API authentication.
Keep runtime, metadata, and examples Codex-only. Preserve upstream license notices.

Install Bun 1.4.2, then run:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run format:check
```

Use fake CLI processes for runtime tests. Never include real API keys in fixtures
or logs. Live model checks require an existing key and explicit authorization.
