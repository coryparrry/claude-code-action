#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "$script_dir/.." && pwd)"
bun_binary="${BUN_EXECUTABLE:-bun}"

if [[ "${CODEX_TEST_LIVE:-0}" == "1" ]]; then
  # Same explicit workflow/key opt-in as the general local test entrypoint.
  exec "$script_dir/test-local.sh"
fi

cd "$project_root"
# Tests cover fake CLI execution, MCP translation, tool filters and environment.
"$bun_binary" test base-action/test/codex-compat.test.ts base-action/test/run-codex.test.ts base-action/test/codex-tool-environment.test.ts

# Exercise the restored stdio fixture through the actual MCP client protocol.
# Dependencies must already be installed; do not install software or call models.
"$bun_binary" -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "offline-harness", version: "1.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: ["base-action/test/mcp-test/simple-mcp-server.ts"] });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some(tool => tool.name === "test_tool")) throw new Error("Missing fixture tool");
  const result = await client.callTool({ name: "test_tool", arguments: {} });
  if (result.isError || !JSON.stringify(result.content).includes("Test tool response")) throw new Error("Unexpected fixture response");
  console.log("Offline MCP handshake, tool listing and tool call passed.");
} finally {
  await client.close();
}
'
