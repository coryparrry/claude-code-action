import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument, stringify } from "yaml";
import type {
  AgentComponentLocation,
  AgentPlugin,
} from "./agent-configuration";

const MAX_COMMAND_BYTES = 1024 * 1024;
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function checkStructure(value: unknown, depth = 0, state = { count: 0 }) {
  if (++state.count > 2000 || depth > 20)
    throw new Error("Command frontmatter exceeds structural limits");
  if (Array.isArray(value))
    for (const item of value) checkStructure(item, depth + 1, state);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw new Error("Reserved command frontmatter key");
      checkStructure(item, depth + 1, state);
    }
}
function parseSource(source: string) {
  source = source.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(source)) return { metadata: {}, body: source };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) throw new Error("Unterminated plugin command frontmatter");
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(
      `Invalid plugin command frontmatter: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  const metadata = object(
    document.toJS({ maxAliasCount: 50 }),
    "Plugin command frontmatter",
  );
  checkStructure(metadata);
  return { metadata, body: source.slice(match[0].length) };
}

/** Object-map definitions become bounded private files; plugin source files remain unchanged. */
export async function materializePluginCommands(
  value: unknown,
  plugin: AgentPlugin,
  options: {
    cacheDirectory?: string;
    signal?: AbortSignal;
    deadline?: number;
  } = {},
): Promise<AgentComponentLocation> {
  const definitions = object(value, "Plugin command definitions");
  if (Object.keys(definitions).length > 2000)
    throw new Error("Plugin commands exceed 2000 definitions");
  const check = () => {
    if (options.signal?.aborted)
      throw new Error("Plugin command loading cancelled");
    if (options.deadline !== undefined && options.deadline <= Date.now())
      throw new Error("Plugin command loading timed out");
  };
  check();
  const base = resolve(options.cacheDirectory ?? plugin.dataDirectory);
  await mkdir(base, { recursive: true });
  const directory = await realpath(
    await mkdtemp(join(base, "command-definitions-")),
  );
  for (const [name, value] of Object.entries(definitions)) {
    check();
    if (!/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/.test(name))
      throw new Error(`Invalid plugin command name: ${name}`);
    const definition = object(value, `Plugin command ${name}`);
    for (const key of Object.keys(definition))
      if (
        ![
          "source",
          "content",
          "allowedTools",
          "model",
          "description",
          "argumentHint",
        ].includes(key)
      )
        throw new Error(`Unsupported plugin command field: ${key}`);
    if (
      (definition.source !== undefined) ===
      (definition.content !== undefined)
    )
      throw new Error(
        `Plugin command ${name} requires exactly one of source or content`,
      );
    for (const key of [
      "source",
      "content",
      "model",
      "description",
      "argumentHint",
    ])
      if (definition[key] !== undefined && typeof definition[key] !== "string")
        throw new Error(`Plugin command ${key} must be a string`);
    if (
      definition.allowedTools !== undefined &&
      (!Array.isArray(definition.allowedTools) ||
        definition.allowedTools.some((item) => typeof item !== "string"))
    )
      throw new Error("Plugin command allowedTools must be a string array");
    let content: string;
    if (typeof definition.source === "string") {
      const root = await realpath(plugin.root),
        path = await realpath(resolve(root, definition.source));
      const location = relative(root, path);
      if (
        location === ".." ||
        location.startsWith(`..${sep}`) ||
        isAbsolute(location)
      )
        throw new Error("Plugin command source escapes plugin root");
      if (
        !(await stat(path)).isFile() ||
        (await stat(path)).size > MAX_COMMAND_BYTES
      )
        throw new Error(
          "Plugin command source must be a file no larger than 1 MiB",
        );
      content = await readFile(path, "utf8");
    } else content = definition.content as string;
    if (Buffer.byteLength(content) > MAX_COMMAND_BYTES)
      throw new Error("Plugin command content exceeds 1 MiB");
    const parsed = parseSource(content);
    const metadata: Record<string, unknown> = { ...parsed.metadata, name };
    for (const [field, key] of [
      ["allowedTools", "allowed-tools"],
      ["model", "model"],
      ["description", "description"],
      ["argumentHint", "argument-hint"],
    ] as const)
      if (definition[field] !== undefined) metadata[key] = definition[field];
    const source = `---\n${stringify(metadata, { aliasDuplicateObjects: false })}---\n${parsed.body}`;
    if (Buffer.byteLength(source) > MAX_COMMAND_BYTES)
      throw new Error("Plugin command definition exceeds 1 MiB");
    await writeFile(
      join(directory, `command-${encodeURIComponent(name)}.md`),
      source,
      { mode: 0o600 },
    );
  }
  return {
    directory,
    materializedRoot: directory,
    namespace: plugin.name,
    pluginRoot: plugin.root,
  };
}
