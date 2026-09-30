#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/.." && pwd)"
bun_binary="${BUN_EXECUTABLE:-bun}"

# Default: deterministic local tests with fake Codex; no model credentials/calls.
if [[ "${CODEX_TEST_LIVE:-0}" != "1" ]]; then
  cd "$project_root"
  "$bun_binary" test base-action/test
  exit
fi

# Paid/live runs require an explicit opt-in AND an explicitly supplied workflow.
# No package manager or act installation is performed by this script.
: "${OPENAI_API_KEY:?Live testing requires OPENAI_API_KEY}"
: "${CODEX_TEST_LIVE_WORKFLOW:?Set a Codex workflow file to run with act}"
command -v act >/dev/null || { echo "Install act separately before opting into live testing." >&2; exit 1; }
cd "$project_root"
act push --secret OPENAI_API_KEY -W "$CODEX_TEST_LIVE_WORKFLOW" --container-architecture linux/amd64
