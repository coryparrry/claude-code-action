import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfiguration } from "./agent-configuration";
import { agentDefinitions, catalog, stringList } from "./agent-markdown";
import { parseHooks } from "./agent-hooks";

export async function selectConfiguredAgent(
  configuration: AgentConfiguration,
  name: string | undefined,
  definitions: Record<string, unknown> | undefined,
  directory: string,
) {
  if (definitions) {
    const root = join(directory, "agents");
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const [agentName, definition] of Object.entries(definitions)) {
      if (
        !/^[\w.-]+$/.test(agentName) ||
        !definition ||
        typeof definition !== "object" ||
        Array.isArray(definition)
      )
        throw new Error("Invalid configured agent definition");
      const { prompt, ...metadata } = definition as Record<string, unknown>;
      if (typeof prompt !== "string")
        throw new Error("Configured agent requires a string prompt");
      await writeFile(
        join(root, `${agentName}.md`),
        `---\n${JSON.stringify(metadata)}\n---\n${prompt}`,
        { mode: 0o600 },
      );
    }
    configuration.agentDirectories.push({ directory: root });
  }
  if (!name) return;
  const selected = (await agentDefinitions(configuration)).find(
    (agent) => agent.name === name,
  );
  if (!selected) throw new Error(`Unknown configured agent: ${name}`);
  const hooks = parseHooks(selected.metadata.hooks ?? {}, {
    pluginRoot: selected.pluginRoot,
  });
  const permissionMode = selected.metadata.permissionMode;
  if (
    permissionMode !== undefined &&
    ![
      "default",
      "acceptEdits",
      "dontAsk",
      "bypassPermissions",
      "plan",
    ].includes(String(permissionMode))
  )
    throw new Error("Unsupported configured agent permissionMode");
  const memory = selected.metadata.memory;
  if (
    memory !== undefined &&
    !["user", "project", "local"].includes(String(memory))
  )
    throw new Error("Unsupported configured agent memory scope");
  const isolation = selected.metadata.isolation;
  if (isolation !== undefined && isolation !== "worktree")
    throw new Error("Unsupported configured agent isolation mode");
  for (const [event, groups] of Object.entries(hooks))
    configuration.hooks[event] = [
      ...(configuration.hooks[event] ?? []),
      ...groups,
    ];
  let instructions = selected.instructions;
  const skills = stringList(selected.metadata.skills, "Agent skills");
  if (skills?.length) {
    const entries = await catalog(
      configuration.skillDirectories,
      "skill",
      () => {},
      configuration,
    );
    for (const name of skills) {
      const skill = entries.find((entry) => entry.name === name);
      if (!skill) throw new Error(`Unknown preloaded skill: ${name}`);
      instructions += `\n\nPreloaded skill ${name}:\n${skill.instructions}`;
    }
  }
  return {
    instructions,
    model:
      typeof selected.metadata.model === "string" &&
      selected.metadata.model !== "inherit"
        ? selected.metadata.model
        : undefined,
    tools: stringList(selected.metadata.tools, "Agent tools"),
    denied: stringList(
      selected.metadata.disallowedTools,
      "Agent disallowedTools",
    ),
    permissionMode:
      typeof permissionMode === "string" && permissionMode !== "default"
        ? permissionMode
        : undefined,
    memory: typeof memory === "string" ? memory : undefined,
    isolation: typeof isolation === "string" ? isolation : undefined,
    readonly: permissionMode === "plan",
    maxTurns:
      typeof selected.metadata.maxTurns === "number"
        ? selected.metadata.maxTurns
        : undefined,
    mcpServers: configuration.strictMcpConfig
      ? undefined
      : selected.metadata.mcpServers,
  };
}

export function childMcpConfig(parent: string, requested: unknown): string {
  if (requested === undefined) return parent;
  const available = JSON.parse(parent).mcpServers as Record<string, unknown>;
  const servers: Record<string, unknown> = {};
  const add = (value: unknown) => {
    if (typeof value === "string") {
      if (!Object.hasOwn(available, value))
        throw new Error(`Unknown agent MCP server: ${value}`);
      servers[value] = available[value];
    } else if (value && typeof value === "object" && !Array.isArray(value))
      Object.assign(servers, value);
    else
      throw new Error(
        "Agent MCP servers must contain references or server configuration objects",
      );
  };
  if (Array.isArray(requested)) requested.forEach(add);
  else add(requested);
  return JSON.stringify({ mcpServers: servers });
}
