# Security

Fork PR execution is disabled. PR identity lookup failures fail closed, and entity
and upstream workflow actors must have repository write or admin permission.
The action runs Codex with an isolated temporary configuration and restricted
shell environment. Its scoped GitHub MCP servers receive only their GitHub token.
PR-authored instructions and configuration are restored from the trusted base.

Use repository-scoped workflow permissions and trusted workflow authors. Model
output may still be incorrect; inspect changes before merging. See the runtime
and fork-policy tests for enforced behavior. Report issues to this fork's
maintainer through GitHub; upstream Anthropic support does not maintain this fork.
