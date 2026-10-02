import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parse } from "yaml";

const MAX_IMPORT_DEPTH = 10;
const MAX_RULE_FILES = 200;
const MAX_RULE_DIRECTORIES = 1000;
const MAX_RULE_DIRECTORY_DEPTH = 12;
const MAX_ANCESTOR_DIRECTORIES = 64;
const IMPORT_PATTERN =
  /(?<![A-Za-z0-9._%+-])@((?:\.{1,2}\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.md)\b/g;

export type AgentInstruction = {
  source: string;
  content: string;
};

export type AgentInstructionOptions = {
  workspace: string;
  home: string;
  /** User/global root files are loaded only when the user setting source is selected. */
  includeUserInstructions: boolean;
  /** Path-scoped rules remain deferred until the caller has concrete file context. */
  touchedFilePaths?: string[];
  /** Load only instructions below the workspace root for newly touched files. */
  nestedOnly?: boolean;
};

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))
  );
}

function isCredentialPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized
    .split("/")
    .map((segment) => segment.toLowerCase());
  const name = basename(normalized).toLowerCase();
  if (
    segments.some(
      (segment) =>
        segment === ".git" ||
        segment === ".ssh" ||
        segment === ".env" ||
        segment.startsWith(".env."),
    )
  ) {
    return true;
  }
  if (
    /^auth\.json(?:\.md)?$/.test(name) ||
    name === ".netrc" ||
    name === ".npmrc" ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/.test(name) ||
    /\.(?:pem|key|p12|pfx|ppk|kdbx)(?:\.md)?$/i.test(name)
  ) {
    return true;
  }
  return (
    normalized.toLowerCase().includes("/.aws/credentials") ||
    normalized
      .toLowerCase()
      .includes("/.config/gcloud/application_default_credentials.json")
  );
}

function assertNotCredentialPath(path: string): void {
  if (isCredentialPath(path)) {
    throw new Error(
      `Refusing to load credential-bearing instruction path: ${path}`,
    );
  }
}

function parseRuleFrontmatter(
  content: string,
  source: string,
): {
  content: string;
  paths?: string[];
} {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { content };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { content };
  let metadata: unknown;
  try {
    metadata = parse(match[1] ?? "");
  } catch {
    throw new Error(`Invalid instruction rule frontmatter in ${source}`);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`Invalid instruction rule frontmatter in ${source}`);
  }
  const paths = (metadata as Record<string, unknown>).paths;
  if (paths === undefined) {
    return { content: content.slice(match[0].length) };
  }
  if (typeof paths === "string") {
    return { content: content.slice(match[0].length), paths: [paths] };
  }
  if (Array.isArray(paths) && paths.every((path) => typeof path === "string")) {
    return { content: content.slice(match[0].length), paths };
  }
  throw new Error(
    `Instruction rule paths must be a string or string array in ${source}`,
  );
}

function globRegex(glob: string): RegExp {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  let pattern = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        index += 1;
        if (normalized[index + 1] === "/") {
          index += 1;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
}

function ruleApplies(
  patterns: string[] | undefined,
  declaringDirectory: string,
  workspace: string,
  touchedFilePaths: string[] | undefined,
): boolean {
  if (!patterns) return true;
  if (!touchedFilePaths?.length) return false;
  const globs = patterns.map(globRegex);
  return touchedFilePaths.some((filePath) => {
    const absolute = resolve(workspace, filePath);
    if (!within(workspace, absolute)) return false;
    if (!within(declaringDirectory, absolute)) return false;
    const normalized = relative(declaringDirectory, absolute).replaceAll(
      "\\",
      "/",
    );
    return globs.some((glob) => glob.test(normalized));
  });
}

function ruleBase(source: string): string {
  let directory = dirname(source);
  while (true) {
    if (
      basename(directory) === "rules" &&
      [".claude", ".agents"].includes(basename(dirname(directory)))
    ) {
      return dirname(dirname(directory));
    }
    const parent = dirname(directory);
    if (parent === directory) return dirname(source);
    directory = parent;
  }
}

async function listRuleFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  let visitedDirectories = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_RULE_DIRECTORY_DEPTH) {
      throw new Error(
        `Instruction rules directory nesting exceeds ${MAX_RULE_DIRECTORY_DEPTH}: ${root}`,
      );
    }
    const metadata = await lstat(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw new Error(`Unable to inspect instruction rules in ${directory}`);
      },
    );
    if (!metadata?.isDirectory()) return;
    visitedDirectories += 1;
    if (visitedDirectories > MAX_RULE_DIRECTORIES) {
      throw new Error(
        `Instruction rules exceed the ${MAX_RULE_DIRECTORIES}-directory limit: ${root}`,
      );
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`Unable to list instruction rules in ${directory}`);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        assertNotCredentialPath(path);
        found.push(path);
        if (found.length > MAX_RULE_FILES) {
          throw new Error(
            `Instruction rules exceed the ${MAX_RULE_FILES}-file limit: ${root}`,
          );
        }
      }
    }
  };
  await visit(root, 0);
  return found;
}

type ExpandContext = {
  allowedRoots: string[];
  workspace: string;
  touchedFilePaths?: string[];
  active: Set<string>;
  loaded: Set<string>;
};

async function resolveImportPath(
  sourcePath: string,
  importPath: string,
  context: ExpandContext,
): Promise<string> {
  const candidate = resolve(dirname(sourcePath), importPath);
  assertNotCredentialPath(candidate);
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new Error(
      `Instruction import from ${sourcePath} does not exist: ${importPath}`,
    );
  }
  assertNotCredentialPath(target);
  if (!context.allowedRoots.some((root) => within(root, target))) {
    throw new Error(
      `Instruction import from ${sourcePath} escapes configured instruction roots: ${importPath}`,
    );
  }
  const metadata = await lstat(target).catch(() => undefined);
  if (!metadata?.isFile()) {
    throw new Error(
      `Instruction import from ${sourcePath} is not a file: ${importPath}`,
    );
  }
  return target;
}

async function expandInstructions(
  sourcePath: string,
  context: ExpandContext,
  depth: number,
): Promise<string> {
  if (depth > MAX_IMPORT_DEPTH) {
    throw new Error(
      `Instruction imports exceed the ${MAX_IMPORT_DEPTH}-level limit at ${sourcePath}`,
    );
  }
  const path = await realpath(sourcePath).catch(() => sourcePath);
  assertNotCredentialPath(path);
  if (context.active.has(path)) {
    throw new Error(`Instruction import cycle detected at ${path}`);
  }
  if (context.loaded.has(path)) return "";
  context.active.add(path);
  context.loaded.add(path);

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    context.active.delete(path);
    throw new Error(`Unable to read instruction file: ${path}`);
  }
  const parsed = parseRuleFrontmatter(content, path);
  if (
    !ruleApplies(
      parsed.paths,
      ruleBase(path),
      context.workspace,
      context.touchedFilePaths,
    )
  ) {
    context.active.delete(path);
    return "";
  }
  const output: string[] = [];
  let lastIndex = 0;
  IMPORT_PATTERN.lastIndex = 0;
  content = parsed.content;
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const importPath = match[1]!;
    const index = match.index!;
    output.push(content.slice(lastIndex, index));
    const target = await resolveImportPath(path, importPath, context);
    const imported = await expandInstructions(target, context, depth + 1);
    output.push(`\n\nInstructions imported from ${target}:\n${imported}\n\n`);
    lastIndex = index + match[0].length;
  }
  output.push(content.slice(lastIndex));
  context.active.delete(path);
  return output.join("");
}

export async function loadAgentInstructions(
  options: AgentInstructionOptions,
): Promise<AgentInstruction[]> {
  const workspace = await realpath(resolve(options.workspace)).catch(() =>
    resolve(options.workspace),
  );
  const home = await realpath(resolve(options.home)).catch(() =>
    resolve(options.home),
  );
  const allowedRoots = [...new Set([workspace, home])];
  const candidates: Array<{
    path: string;
    rule?: boolean;
    rootRule?: boolean;
  }> = [];
  const add = (path: string, rule = false, rootRule = false) => {
    if (
      !candidates.some((candidate) => resolve(candidate.path) === resolve(path))
    ) {
      candidates.push({ path, rule, rootRule });
    }
  };

  if (options.includeUserInstructions && !options.nestedOnly) {
    for (const name of [
      "AGENTS.md",
      "CLAUDE.md",
      ".codex/AGENTS.md",
      ".claude/CLAUDE.md",
    ]) {
      add(join(home, name));
    }
    for (const directory of [".claude/rules", ".agents/rules"]) {
      for (const file of await listRuleFiles(join(home, directory)))
        add(file, true);
    }
  }

  if (options.nestedOnly) {
    for (const directoryName of [".claude/rules", ".agents/rules"]) {
      for (const file of await listRuleFiles(join(workspace, directoryName)))
        add(file, true, true);
    }
    for (const filePath of options.touchedFilePaths ?? []) {
      const target = resolve(workspace, filePath);
      if (!within(workspace, target)) continue;
      let nested = dirname(target);
      while (nested !== workspace && within(workspace, nested)) {
        for (const name of ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"]) {
          add(join(nested, name));
        }
        for (const directoryName of [".claude/rules", ".agents/rules"]) {
          for (const file of await listRuleFiles(join(nested, directoryName)))
            add(file, true);
        }
        const parent = dirname(nested);
        if (parent === nested) break;
        nested = parent;
      }
    }
  }

  const ancestors: string[] = [];
  let directory = workspace;
  while (true) {
    ancestors.push(directory);
    if (ancestors.length > MAX_ANCESTOR_DIRECTORIES) {
      throw new Error(
        `Workspace instruction ancestry exceeds ${MAX_ANCESTOR_DIRECTORIES} directories: ${workspace}`,
      );
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const root of options.nestedOnly ? [] : ancestors.reverse()) {
    if (
      root === home &&
      root !== workspace &&
      !options.includeUserInstructions
    ) {
      continue;
    }
    for (const name of root === workspace
      ? [
          "AGENTS.md",
          "CLAUDE.md",
          "CLAUDE.local.md",
          ".codex/AGENTS.md",
          ".claude/CLAUDE.md",
        ]
      : ["AGENTS.md", "CLAUDE.md"]) {
      add(join(root, name));
    }
  }
  for (const directoryName of options.nestedOnly
    ? []
    : [".claude/rules", ".agents/rules"]) {
    for (const file of await listRuleFiles(join(workspace, directoryName)))
      add(file, true);
  }

  const result: AgentInstruction[] = [];
  const loadedFiles = new Set<string>();
  for (const candidate of candidates) {
    const metadata = await lstat(candidate.path).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw new Error(
          `Unable to inspect instruction file: ${candidate.path}`,
        );
      },
    );
    if (!metadata?.isFile()) continue;
    let source: string;
    try {
      source = await realpath(candidate.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`Unable to resolve instruction file: ${candidate.path}`);
    }
    assertNotCredentialPath(candidate.path);
    assertNotCredentialPath(source);
    if (loadedFiles.has(source)) continue;

    let original: string;
    try {
      original = await readFile(source, "utf8");
    } catch {
      throw new Error(`Unable to read instruction file: ${source}`);
    }
    let content = original;
    if (candidate.rule) {
      const parsed = parseRuleFrontmatter(original, source);
      if (options.nestedOnly && candidate.rootRule && !parsed.paths) continue;
      const ruleRoot = candidate.rule ? ruleBase(source) : dirname(source);
      if (
        !ruleApplies(
          parsed.paths,
          ruleRoot,
          workspace,
          options.touchedFilePaths,
        )
      )
        continue;
      content = parsed.content;
    }

    const context: ExpandContext = {
      allowedRoots: [...allowedRoots, dirname(source)],
      workspace,
      touchedFilePaths: options.touchedFilePaths,
      active: new Set(),
      loaded: loadedFiles,
    };
    // Expand from a temporary resolved source while preserving the frontmatter-free rule body.
    let expanded: string;
    if (candidate.rule && content !== original) {
      expanded = await expandContent(content, source, context, 0);
    } else {
      expanded = await expandInstructions(source, context, 0);
    }
    result.push({ source, content: expanded.trim() });
  }
  return result;
}

async function expandContent(
  content: string,
  sourcePath: string,
  context: ExpandContext,
  depth: number,
): Promise<string> {
  if (depth > MAX_IMPORT_DEPTH) {
    throw new Error(
      `Instruction imports exceed the ${MAX_IMPORT_DEPTH}-level limit at ${sourcePath}`,
    );
  }
  const source = await realpath(sourcePath).catch(() => sourcePath);
  if (context.active.has(source)) {
    throw new Error(`Instruction import cycle detected at ${source}`);
  }
  context.active.add(source);
  context.loaded.add(source);
  const parsed = parseRuleFrontmatter(content, source);
  if (
    !ruleApplies(
      parsed.paths,
      ruleBase(source),
      context.workspace,
      context.touchedFilePaths,
    )
  ) {
    context.active.delete(source);
    return "";
  }
  content = parsed.content;
  const output: string[] = [];
  let lastIndex = 0;
  IMPORT_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const importPath = match[1]!;
    const index = match.index!;
    output.push(content.slice(lastIndex, index));
    const target = await resolveImportPath(source, importPath, context);
    const imported = await expandInstructions(target, context, depth + 1);
    output.push(`\n\nInstructions imported from ${target}:\n${imported}\n\n`);
    lastIndex = index + match[0].length;
  }
  output.push(content.slice(lastIndex));
  context.active.delete(source);
  return output.join("");
}
