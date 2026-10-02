import {
  resolvePluginOptions,
  substitutePluginConfiguration,
} from "./agent-plugin-options";
import { materializePluginCommands } from "./agent-plugin-commands";
import { loadAgentInstructions } from "./agent-instructions";
export { substitutePluginConfiguration } from "./agent-plugin-options";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  hookEnvironment,
  parseHooks,
  runConfigurationCommand,
  type HookMap,
} from "./agent-hooks";

type ObjectValue = Record<string, unknown>;
export type AgentComponentLocation = {
  /** May be a directory or a single Markdown file when declared by a manifest. */
  directory: string;
  namespace?: string;
  pluginRoot?: string;
  /** Private generated components retain their original plugin root for substitutions. */
  materializedRoot?: string;
};
export type AgentPlugin = {
  name: string;
  root: string;
  dataDirectory: string;
  manifest: ObjectValue;
  userConfigValues?: ObjectValue;
  sensitiveConfigKeys?: string[];
};
export type AgentConfiguration = {
  instructionHome?: string;
  includeUserInstructions?: boolean;
  strictMcpConfig?: boolean;
  settings: ObjectValue;
  sources: string[];
  plugins: AgentPlugin[];
  mcpServers: ObjectValue;
  commandDirectories: AgentComponentLocation[];
  skillDirectories: AgentComponentLocation[];
  agentDirectories: AgentComponentLocation[];
  lspServers: ObjectValue;
  workflowDirectories: AgentComponentLocation[];
  outputStyleDirectories: AgentComponentLocation[];
  hooks: HookMap;
  projectInstructions: string;
};
export type AgentConfigurationOptions = {
  workspace: string;
  home?: string;
  settings?: ObjectValue | string;
  settingSources?: string | string[];
  plugins?: string | string[];
  pluginMarketplaces?: string | string[];
  /** Installed/downloaded roots supplied by the action's plugin installer. */
  pluginRoots?: string[];
  cacheDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  deadline?: number;
  signal?: AbortSignal;
  dataDirectoryRoot?: string;
  strictMcpConfig?: boolean;
};

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must contain an object`);
  for (const key of Object.keys(value))
    if (["__proto__", "constructor", "prototype"].includes(key))
      throw new Error(`${label} contains a reserved property: ${key}`);
  return value as ObjectValue;
}

/** Non-managed settings use recursive objects, unique arrays, and last scalar wins. */
function merge(left: ObjectValue, right: ObjectValue): ObjectValue {
  const result = { ...left };
  for (const [key, value] of Object.entries(object(right, "Settings"))) {
    const previous = result[key];
    if (Array.isArray(previous) && Array.isArray(value)) {
      const seen = new Set<string>();
      result[key] = [...previous, ...value].filter((entry) => {
        const identity = JSON.stringify(entry);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = merge(
        previous && typeof previous === "object" && !Array.isArray(previous)
          ? object(previous, "Settings")
          : {},
        object(value, "Settings"),
      );
    } else result[key] = value;
  }
  return result;
}

async function readObject(
  path: string,
  optional = false,
): Promise<ObjectValue | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return object(
      path.endsWith(".toml") ? Bun.TOML.parse(content) : JSON.parse(content),
      path,
    );
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(
      `Cannot load configuration ${path}: ${(error as Error).message}`,
      { cause: error },
    );
  }
}

function entries(value?: string | string[]): string[] {
  return (Array.isArray(value) ? value : (value || "").split(/\r?\n/))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function contained(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(resolve(root, path));
  const location = relative(canonicalRoot, canonical);
  if (
    location === ".." ||
    location.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(location)
  )
    throw new Error(`Plugin component escapes plugin root: ${path}`);
  return canonical;
}

async function manifestPath(root: string): Promise<string | undefined> {
  for (const path of [
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    "plugin.json",
  ])
    if (await exists(join(root, path))) return contained(root, path);
  return undefined;
}

async function addPlugin(
  config: AgentConfiguration,
  root: string,
  home: string,
  expectedName?: string,
  dataDirectoryRoot?: string,
  selector?: string,
  marketplaceEntry?: ObjectValue,
  componentOptions?: Pick<
    AgentConfigurationOptions,
    "cacheDirectory" | "signal" | "deadline"
  >,
) {
  root = await realpath(root);
  if (config.plugins.some((plugin) => plugin.root === root)) return;
  const path = await manifestPath(root);
  const loaded = path
    ? (await readObject(path))!
    : { name: expectedName ?? basename(root) };
  const manifest =
    marketplaceEntry?.strict === false
      ? merge(loaded, marketplaceEntry)
      : loaded;
  if (
    typeof manifest.name !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(manifest.name)
  )
    throw new Error(`Plugin manifest requires a valid name: ${root}`);
  if (expectedName && manifest.name !== expectedName)
    throw new Error(
      `Marketplace plugin ${expectedName} has mismatched manifest name ${manifest.name}`,
    );
  if (config.plugins.some((plugin) => plugin.name === manifest.name))
    throw new Error(`Duplicate plugin name: ${manifest.name}`);
  const plugin: AgentPlugin = {
    name: manifest.name,
    root,
    dataDirectory: join(
      dataDirectoryRoot ?? join(home, ".codex", "plugin-data"),
      manifest.name,
    ),
    manifest,
  };
  const saved = object(config.settings.pluginConfigs ?? {}, "pluginConfigs");
  const savedEntry = object(
    saved[selector ?? manifest.name] ?? saved[manifest.name] ?? {},
    "Plugin saved configuration",
  );
  const configured = resolvePluginOptions(
    manifest,
    object(savedEntry.userConfig ?? savedEntry, "Plugin option values"),
  );
  plugin.userConfigValues = configured.values;
  plugin.sensitiveConfigKeys = configured.sensitiveKeys;
  await mkdir(plugin.dataDirectory, { recursive: true });
  config.plugins.push(plugin);
  const components = async (
    key: "commands" | "skills" | "agents" | "workflows" | "outputStyles",
    defaults: boolean,
  ) => {
    const declared = manifest[key];
    if (
      key === "commands" &&
      declared &&
      typeof declared === "object" &&
      !Array.isArray(declared)
    ) {
      config.commandDirectories.push(
        await materializePluginCommands(declared, plugin, componentOptions),
      );
      return;
    }
    const paths =
      declared === undefined
        ? []
        : Array.isArray(declared)
          ? declared
          : [declared];
    if (defaults && (await exists(join(root, key)))) paths.unshift(`./${key}`);
    for (const path of [...new Set(paths)]) {
      if (typeof path !== "string")
        throw new Error(`Plugin ${key} must contain paths`);
      const directory = await contained(root, path);
      const target =
        key === "commands"
          ? config.commandDirectories
          : key === "skills"
            ? config.skillDirectories
            : key === "agents"
              ? config.agentDirectories
              : key === "workflows"
                ? config.workflowDirectories
                : config.outputStyleDirectories;
      target.push({ directory, namespace: plugin.name, pluginRoot: root });
    }
  };
  await components("commands", manifest.commands === undefined);
  await components("skills", true);
  await components("agents", manifest.agents === undefined);
  await components("workflows", manifest.workflows === undefined);
  const styles = manifest.outputStyles;
  if (styles === undefined && (await exists(join(root, "output-styles"))))
    config.outputStyleDirectories.push({
      directory: await contained(root, "output-styles"),
      namespace: plugin.name,
      pluginRoot: root,
    });
  else if (styles !== undefined) await components("outputStyles", false);
  for (const [key, defaultPath] of [
    ["hooks", "hooks/hooks.json"],
    ["mcpServers", ".mcp.json"],
    ["lspServers", ".lsp.json"],
  ] as const) {
    if (key === "mcpServers" && config.strictMcpConfig) continue;
    const sources: unknown[] = [];
    if (await exists(join(root, defaultPath))) sources.push(defaultPath);
    const declared = manifest[key];
    if (declared !== undefined)
      sources.push(...(Array.isArray(declared) ? declared : [declared]));
    const seen = new Set<string>();
    for (let source of sources) {
      if (typeof source === "string") {
        const path = await contained(root, source);
        if (seen.has(path)) continue;
        seen.add(path);
        source = await readObject(path);
      }
      const data = object(
        substitutePluginConfiguration(source, plugin, true),
        `Plugin ${key}`,
      );
      if (key === "hooks") {
        for (const groups of Object.values(
          object((source as ObjectValue).hooks ?? source, "Plugin hooks"),
        ))
          for (const group of groups as Array<{
            hooks: Array<{ command?: string; args?: unknown }>;
          }>)
            for (const handler of group.hooks)
              if (!handler.args && handler.command?.includes("${user_config."))
                throw new Error(
                  "Shell-form hooks must read CLAUDE_PLUGIN_OPTION variables rather than user_config interpolation",
                );
        const hooks = parseHooks(data.hooks ?? data, {
          pluginRoot: plugin.root,
          pluginDataDirectory: plugin.dataDirectory,
          pluginOptions: plugin.userConfigValues,
        });
        for (const groups of Object.values(hooks))
          for (const group of groups)
            for (const handler of group.hooks)
              if (
                handler.type === "mcp_tool" &&
                handler.server &&
                !handler.server.startsWith("plugin:")
              )
                handler.server = `plugin:${plugin.name}:${handler.server}`;
        addHooks(config.hooks, hooks);
      } else {
        const servers = object(data[key] ?? data, `Plugin ${key}`);
        for (const [name, server] of Object.entries(servers))
          (key === "mcpServers" ? config.mcpServers : config.lspServers)[
            `plugin:${plugin.name}:${name}`
          ] = server;
      }
    }
  }
}

function addHooks(target: HookMap, source: HookMap) {
  for (const [event, groups] of Object.entries(source))
    target[event] = [...(target[event] || []), ...groups];
}

async function materialize(
  source: string | ObjectValue,
  options: AgentConfigurationOptions,
  kind: string,
): Promise<string> {
  let url: string;
  let ref: string | undefined;
  let sha: string | undefined;
  let subdirectory: string | undefined;
  if (typeof source === "string") {
    const local = resolve(options.workspace, source);
    if (await exists(local)) return local;
    url = source;
  } else {
    if (source.source === "directory" && typeof source.path === "string")
      return resolve(options.workspace, source.path);
    if (source.source === "github" && typeof source.repo === "string")
      url = `https://github.com/${source.repo}.git`;
    else if (
      ["git", "url", "git-subdir"].includes(String(source.source)) &&
      typeof source.url === "string"
    )
      url = source.url;
    else
      throw new Error(
        `Unsupported ${kind} source; use directory, github, url, git, or git-subdir`,
      );
    if (source.ref !== undefined) {
      if (
        typeof source.ref !== "string" ||
        !source.ref ||
        source.ref.startsWith("-")
      )
        throw new Error("Invalid plugin git ref");
      ref = source.ref;
    }
    if (source.sha !== undefined) {
      if (
        typeof source.sha !== "string" ||
        !/^[a-fA-F0-9]{40}$/.test(source.sha)
      )
        throw new Error("Plugin sha must be a full 40-character commit hash");
      sha = source.sha.toLowerCase();
    }
    if (source.source === "git-subdir") {
      if (
        typeof source.path !== "string" ||
        !source.path ||
        isAbsolute(source.path)
      )
        throw new Error("git-subdir source requires a relative path");
      subdirectory = source.path;
    }
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url))
    url = `https://github.com/${url}.git`;
  if (
    !/^(?:https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(url) ||
    /[\x00-\x1f\x7f]/.test(url)
  )
    throw new Error(`Invalid ${kind} source: ${url}`);
  if (/^https?:\/\/[^/]*@/.test(url))
    throw new Error("Plugin sources must not embed credentials");
  if (!options.cacheDirectory)
    throw new Error(
      "Remote plugin sources require a disposable cacheDirectory",
    );
  await mkdir(options.cacheDirectory, { recursive: true });
  const cache = await mkdtemp(join(options.cacheDirectory, `${kind}-`));
  const deadline = options.deadline ?? Date.now() + 120_000;
  if (/^https?:\/\/.*\.json(?:\?.*)?$/.test(url)) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
    try {
      if (options.signal?.aborted || deadline <= Date.now())
        throw new Error("Marketplace download cancelled or timed out");
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok)
        throw new Error(
          `Marketplace download failed with HTTP ${response.status}`,
        );
      // Bound the streamed body; content-length alone is untrusted.
      if (!response.body)
        throw new Error("Marketplace download returned no body");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 1024 * 1024) {
          await reader.cancel();
          throw new Error("Marketplace manifest exceeds 1 MiB");
        }
        chunks.push(chunk.value);
      }
      const path = join(cache, "marketplace.json");
      await writeFile(path, Buffer.concat(chunks));
      return path;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
  const root = join(cache, "repository");
  const environment = hookEnvironment(options.environment ?? {}, cache);
  environment.HOME = cache;
  environment.GIT_TERMINAL_PROMPT = "0";
  const response = await runConfigurationCommand(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "clone",
      "--depth",
      "1",
      "--",
      url,
      root,
    ],
    {
      workspace: options.workspace,
      environment,
      deadline,
      signal: options.signal,
    },
  );
  if (response.code !== 0)
    throw new Error(`Failed to install ${kind}: ${response.stderr.trim()}`);
  if (sha || ref) {
    const revision = sha ?? ref!;
    const git = async (args: string[]) => {
      const result = await runConfigurationCommand("git", args, {
        workspace: root,
        environment,
        deadline,
        signal: options.signal,
      });
      if (result.code !== 0)
        throw new Error(
          `Failed to resolve pinned ${kind} revision: ${result.stderr.trim()}`,
        );
      return result.stdout.trim();
    };
    await git([
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "fetch",
      "--depth",
      "1",
      "origin",
      revision,
    ]);
    await git(["checkout", "--detach", "FETCH_HEAD"]);
    if (sha && (await git(["rev-parse", "HEAD"])) !== sha)
      throw new Error("Installed plugin commit does not match sha");
  }
  return subdirectory ? contained(root, subdirectory) : root;
}

async function selectOutputStyle(config: AgentConfiguration) {
  const selected = config.settings.outputStyle ?? config.settings.output_style;
  if (selected === undefined || selected === "default") return;
  if (typeof selected !== "string")
    throw new Error("outputStyle must be a style name");
  if (["Explanatory", "Learning"].includes(selected)) {
    config.projectInstructions +=
      selected === "Explanatory"
        ? "\n\nExplain implementation choices and useful codebase insights while completing the task."
        : "\n\nUse a teaching style: explain decisions and guide the user through the work while completing authorized tasks.";
    return;
  }
  const files = async (path: string): Promise<string[]> => {
    if ((await stat(path)).isFile()) return [path];
    const children = await readdir(path, { withFileTypes: true });
    return (
      await Promise.all(
        children
          .filter((child) => !child.isSymbolicLink())
          .map((child) =>
            child.isDirectory()
              ? files(join(path, child.name))
              : Promise.resolve(
                  child.name.endsWith(".md") ? [join(path, child.name)] : [],
                ),
          ),
      )
    ).flat();
  };
  for (const location of config.outputStyleDirectories)
    for (const path of await files(location.directory)) {
      const source = await readFile(path, "utf8");
      const declared = /^---\r?\n[^]*?\bname:\s*["']?([^\r\n"']+)/
        .exec(source)?.[1]
        ?.trim();
      const name = basename(path, ".md");
      if (
        ![
          name,
          declared,
          location.namespace ? `${location.namespace}:${name}` : "",
          location.namespace && declared
            ? `${location.namespace}:${declared}`
            : "",
        ].includes(selected)
      )
        continue;
      const plugin = config.plugins.find(
        (plugin) => plugin.root === location.pluginRoot,
      );
      const body = source.replace(/^---\r?\n[^]*?\r?\n---(?:\r?\n|$)/, "");
      config.projectInstructions += `\n\nSelected output style ${selected}:\n${plugin ? substitutePluginConfiguration(body, plugin) : body}`;
      return;
    }
  throw new Error(`Selected output style not found: ${selected}`);
}

/** Load layered configuration and materialize remote plugins in the caller-owned cache. */
export async function loadAgentConfiguration(
  options: AgentConfigurationOptions,
): Promise<AgentConfiguration> {
  const workspace = resolve(options.workspace);
  const home = resolve(options.home ?? homedir());
  const selected =
    options.settingSources === undefined
      ? ["user", "project", "local"]
      : (Array.isArray(options.settingSources)
          ? options.settingSources
          : options.settingSources.split(",")
        ).filter(Boolean);
  if (selected.some((scope) => !["user", "project", "local"].includes(scope)))
    throw new Error("setting-sources must contain only user,project,local");
  const config: AgentConfiguration = {
    instructionHome: home,
    includeUserInstructions: selected.includes("user"),
    strictMcpConfig: options.strictMcpConfig,
    settings: {},
    sources: [],
    plugins: [],
    mcpServers: {},
    lspServers: {},
    commandDirectories: [],
    skillDirectories: [],
    agentDirectories: [],
    workflowDirectories: [],
    outputStyleDirectories: [],
    hooks: {},
    projectInstructions: "",
  };
  // Explicit sources choose scopes; precedence remains user < project < local.
  for (const scope of ["user", "project", "local"]) {
    if (!selected.includes(scope)) continue;
    const root = scope === "user" ? home : workspace;
    for (const engine of [".claude", ".codex"]) {
      const path = join(
        root,
        engine,
        scope === "local" ? "settings.local.json" : "settings.json",
      );
      const settings = await readObject(path, true);
      if (settings) {
        config.settings = merge(
          config.settings,
          options.strictMcpConfig
            ? Object.fromEntries(
                Object.entries(settings).filter(
                  ([key]) => !["mcpServers", "mcp_servers"].includes(key),
                ),
              )
            : settings,
        );
        config.sources.push(path);
      }
      if (engine === ".codex" && scope !== "local") {
        const path = join(root, engine, "config.toml");
        const settings = await readObject(path, true);
        if (settings) {
          config.settings = merge(
            config.settings,
            options.strictMcpConfig
              ? Object.fromEntries(
                  Object.entries(settings).filter(
                    ([key]) => !["mcpServers", "mcp_servers"].includes(key),
                  ),
                )
              : settings,
          );
          config.sources.push(path);
        }
      }
      if (scope !== "local")
        for (const key of [
          "commands",
          "skills",
          "agents",
          "workflows",
          "output-styles",
        ] as const) {
          const directory = join(root, engine, key);
          if (await exists(directory))
            (key === "commands"
              ? config.commandDirectories
              : key === "skills"
                ? config.skillDirectories
                : key === "agents"
                  ? config.agentDirectories
                  : key === "workflows"
                    ? config.workflowDirectories
                    : config.outputStyleDirectories
            ).unshift({ directory });
        }
    }
    if (scope !== "local" && !options.strictMcpConfig)
      for (const path of [
        join(root, ".mcp.json"),
        join(root, ".codex", "mcp.json"),
      ]) {
        const mcp = await readObject(path, true);
        if (mcp) {
          config.mcpServers = merge(
            config.mcpServers,
            object(mcp.mcpServers ?? mcp, path),
          );
          config.sources.push(path);
        }
      }
  }
  if (options.settings) {
    const raw = options.settings;
    const settings =
      typeof raw !== "string"
        ? raw
        : raw.trim().startsWith("{")
          ? object(JSON.parse(raw), "Explicit settings")
          : raw.includes("=") || raw.includes("\n")
            ? object(Bun.TOML.parse(raw), "Explicit settings")
            : await readObject(resolve(workspace, raw));
    config.settings = merge(config.settings, settings!);
  }
  if (config.settings.mcpServers)
    config.mcpServers = merge(
      config.mcpServers,
      object(config.settings.mcpServers, "Settings MCP servers"),
    );
  if (config.settings.mcp_servers)
    config.mcpServers = merge(
      config.mcpServers,
      object(config.settings.mcp_servers, "Settings MCP servers"),
    );
  if (config.settings.lspServers)
    config.lspServers = merge(
      config.lspServers,
      object(config.settings.lspServers, "Settings LSP servers"),
    );
  addHooks(config.hooks, parseHooks(config.settings.hooks ?? {}));

  const marketplaces = new Map<
    string,
    { root: string; manifest: ObjectValue }
  >();
  const marketplaceSources: Array<string | ObjectValue> = entries(
    options.pluginMarketplaces,
  );
  const known = config.settings.extraKnownMarketplaces;
  if (known !== undefined)
    for (const value of Object.values(
      object(known, "extraKnownMarketplaces"),
    )) {
      const source = object(
        object(value, "Marketplace").source,
        "Marketplace source",
      );
      marketplaceSources.push(source);
    }
  for (const source of marketplaceSources) {
    const path = await materialize(source, options, "marketplace");
    const root = (await stat(path)).isDirectory() ? path : dirname(path);
    let manifest: ObjectValue | undefined;
    for (const candidate of [
      (await stat(path)).isFile() ? path : "",
      join(root, ".claude-plugin/marketplace.json"),
      join(root, ".codex-plugin/marketplace.json"),
      join(root, "marketplace.json"),
    ].filter(Boolean)) {
      manifest = await readObject(candidate, true);
      if (manifest) break;
    }
    if (
      !manifest ||
      typeof manifest.name !== "string" ||
      !Array.isArray(manifest.plugins)
    )
      throw new Error(`Invalid plugin marketplace: ${source}`);
    if (marketplaces.has(manifest.name))
      throw new Error(`Duplicate marketplace: ${manifest.name}`);
    marketplaces.set(manifest.name, { root, manifest });
  }
  for (const root of options.pluginRoots ?? [])
    await addPlugin(
      config,
      resolve(workspace, root),
      home,
      undefined,
      options.dataDirectoryRoot,
      undefined,
      undefined,
      options,
    );
  const enabled =
    config.settings.enabledPlugins === undefined
      ? {}
      : object(config.settings.enabledPlugins, "enabledPlugins");
  const selectors = [
    ...Object.entries(enabled)
      .filter(([, value]) => value === true)
      .map(([name]) => name),
    ...entries(options.plugins),
  ];
  for (const selector of [...new Set(selectors)]) {
    if (!selector.includes("@")) {
      await addPlugin(
        config,
        resolve(workspace, selector),
        home,
        undefined,
        options.dataDirectoryRoot,
        undefined,
        undefined,
        options,
      );
      continue;
    }
    const match = /^([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)$/.exec(selector);
    if (!match) throw new Error(`Invalid plugin selector: ${selector}`);
    const [, name, marketName] = match;
    const market = marketplaces.get(marketName!);
    if (!market) {
      if (config.plugins.some((plugin) => plugin.name === name)) continue;
      throw new Error(
        `Plugin marketplace ${marketName} is not loaded; install it or provide a local marketplace`,
      );
    }
    const entry = (market.manifest.plugins as unknown[]).find(
      (candidate) => object(candidate, "Marketplace entry").name === name,
    );
    if (!entry)
      throw new Error(
        `Plugin ${name} is absent from marketplace ${marketName}`,
      );
    const source = object(entry, "Marketplace entry").source;
    const root =
      typeof source === "string"
        ? await contained(market.root, source)
        : await materialize(object(source, "Plugin source"), options, "plugin");
    await addPlugin(
      config,
      root,
      home,
      name,
      options.dataDirectoryRoot,
      selector,
      object(entry, "Marketplace entry"),
      options,
    );
  }
  if (config.settings.disableAllHooks === true) config.hooks = {};
  const instructions = await loadAgentInstructions({
    workspace,
    home,
    includeUserInstructions: selected.includes("user"),
  });
  for (const instruction of instructions) {
    config.projectInstructions += `\n\nInstructions from ${instruction.source}:\n${instruction.content}`;
  }
  await selectOutputStyle(config);
  return config;
}
