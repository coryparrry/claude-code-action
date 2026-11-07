/** Map MCP server names to the namespace exposed as a model function name. */
export function mcpServerNamespace(name: string): string {
  return name.replaceAll(":", "_");
}

/** Reserve the issue namespace and aliases that would expose the same tools. */
export function isIssueMcpServerName(name: string): boolean {
  return mcpServerNamespace(name) === "github_issues";
}

/** Refuse a user-defined server that could claim the action's issue namespace. */
export function assertNoIssueMcpServer(servers: object): void {
  if (Object.keys(servers).some(isIssueMcpServerName))
    throw new Error(
      "github_issues is reserved for the repository-scoped action server",
    );
}
