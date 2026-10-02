import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentInstructions } from "../src/agent-instructions";
import { AgentPermissions } from "../src/agent-permissions";
import { createCodexAgentRuntime } from "../src/codex-agent-runtime";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-instructions-"));
  temporaryRoots.push(root);
  const home = join(root, "home");
  const workspace = join(home, "projects", "repo");
  await mkdir(workspace, { recursive: true });
  return { root, home, workspace };
}

function contents(entries: Awaited<ReturnType<typeof loadAgentInstructions>>) {
  return entries.map((entry) => entry.content).join("\n");
}

describe("native agent instruction loading", () => {
  test("loads home, ancestor, workspace, and unscoped rule instructions deterministically", async () => {
    const { home, workspace } = await fixture();
    await writeFile(join(home, "AGENTS.md"), "home instructions");
    await writeFile(
      join(home, "projects", "AGENTS.md"),
      "ancestor instructions",
    );
    await writeFile(join(workspace, "AGENTS.md"), "workspace AGENTS");
    await writeFile(join(workspace, "CLAUDE.md"), "workspace Claude");
    await writeFile(join(workspace, "CLAUDE.local.md"), "workspace local");
    await mkdir(join(workspace, ".claude"), { recursive: true });
    await writeFile(
      join(workspace, ".claude", "CLAUDE.md"),
      "Claude directory",
    );
    await mkdir(join(workspace, ".claude", "rules", "nested"), {
      recursive: true,
    });
    await writeFile(
      join(workspace, ".claude", "rules", "nested", "review.md"),
      "review rule",
    );
    await mkdir(join(workspace, ".agents", "rules"), { recursive: true });
    await writeFile(
      join(workspace, ".agents", "rules", "safety.md"),
      "safety rule",
    );

    const loaded = await loadAgentInstructions({
      workspace,
      home,
      includeUserInstructions: true,
    });
    expect(contents(loaded)).toContain("home instructions");
    expect(contents(loaded)).toContain("ancestor instructions");
    expect(contents(loaded)).toContain("workspace AGENTS");
    expect(contents(loaded)).toContain("workspace Claude");
    expect(contents(loaded)).toContain("workspace local");
    expect(contents(loaded)).toContain("Claude directory");
    expect(contents(loaded)).toContain("review rule");
    expect(contents(loaded)).toContain("safety rule");
    const text = contents(loaded);
    const orderedMarkers = [
      "home instructions",
      "ancestor instructions",
      "workspace AGENTS",
      "workspace Claude",
      "workspace local",
      "Claude directory",
      "review rule",
      "safety rule",
    ];
    const positions = orderedMarkers.map((marker) => text.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    expect(new Set(loaded.map((entry) => entry.source)).size).toBe(
      loaded.length,
    );
  });

  test("honors the user setting source while retaining workspace instructions", async () => {
    const { home, workspace } = await fixture();
    await writeFile(join(home, "AGENTS.md"), "private home instructions");
    await writeFile(join(workspace, "AGENTS.md"), "workspace instructions");

    const loaded = await loadAgentInstructions({
      workspace,
      home,
      includeUserInstructions: false,
    });
    expect(contents(loaded)).toContain("workspace instructions");
    expect(contents(loaded)).not.toContain("private home instructions");
  });

  test("expands relative Markdown imports recursively and ignores mentions and email", async () => {
    const { home, workspace } = await fixture();
    await mkdir(join(workspace, "docs", "nested"), { recursive: true });
    await writeFile(
      join(workspace, "AGENTS.md"),
      "Follow @codex, contact dev@example.com, read @docs/guide.md.",
    );
    await writeFile(
      join(workspace, "docs", "guide.md"),
      "Guide imports @./nested/details.md.",
    );
    await writeFile(
      join(workspace, "docs", "nested", "details.md"),
      "Nested details.",
    );

    const loaded = await loadAgentInstructions({
      workspace,
      home,
      includeUserInstructions: false,
    });
    const text = contents(loaded);
    expect(text).toContain("Nested details.");
    expect(text).toContain("Follow @codex");
    expect(text).toContain("dev@example.com");
    expect(loaded).toHaveLength(1);
  });

  test("reports import cycles, missing files, and depth errors without file contents", async () => {
    const { home, workspace } = await fixture();
    await writeFile(join(workspace, "AGENTS.md"), "SECRET BODY @cycle.md");
    await writeFile(join(workspace, "cycle.md"), "@AGENTS.md");
    await expect(
      loadAgentInstructions({
        workspace,
        home,
        includeUserInstructions: false,
      }),
    ).rejects.toThrow("Instruction import cycle detected at");

    await writeFile(join(workspace, "AGENTS.md"), "PRIVATE BODY @missing.md");
    const missing = await loadAgentInstructions({
      workspace,
      home,
      includeUserInstructions: false,
    })
      .then(() => "")
      .catch((error: Error) => error.message);
    expect(missing).toContain("does not exist");
    expect(missing).not.toContain("PRIVATE BODY");

    for (let index = 0; index <= 10; index += 1) {
      const next = `depth-${index + 1}.md`;
      await writeFile(join(workspace, `depth-${index}.md`), `@${next}`);
    }
    await writeFile(join(workspace, "AGENTS.md"), "@depth-0.md");
    await expect(
      loadAgentInstructions({
        workspace,
        home,
        includeUserInstructions: false,
      }),
    ).rejects.toThrow("Instruction imports exceed the 10-level limit");
  });

  test.each([
    ".env.local/credentials.md",
    ".git/config.md",
    ".ssh/id_ed25519.md",
    "keys/signing.key.md",
    "keys/signing.pem.md",
    "auth.json.md",
  ])(
    "rejects credential-bearing import %s without echoing file data",
    async (path) => {
      const { home, workspace } = await fixture();
      const target = join(workspace, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        join(workspace, "AGENTS.md"),
        `DO NOT EXPOSE THIS @${path}`,
      );
      await writeFile(target, "live-secret-value");
      const error = await loadAgentInstructions({
        workspace,
        home,
        includeUserInstructions: false,
      })
        .then(() => "")
        .catch((caught: Error) => caught.message);
      expect(error).toContain("credential-bearing");
      expect(error).not.toContain("live-secret-value");
      expect(error).not.toContain("DO NOT EXPOSE THIS");
    },
  );

  test("applies path-scoped rules only when a touched file matches", async () => {
    const { home, workspace } = await fixture();
    await writeFile(
      join(workspace, "AGENTS.md"),
      "Also apply @.claude/rules/typescript.md.",
    );
    const rules = join(workspace, ".claude", "rules");
    await mkdir(rules, { recursive: true });
    await writeFile(
      join(rules, "typescript.md"),
      "---\npaths:\n  - 'src/**/*.ts'\n---\nTypeScript-only rule.",
    );
    await writeFile(join(rules, "global.md"), "Global project rule.");

    const withoutFileContext = await loadAgentInstructions({
      workspace,
      home,
      includeUserInstructions: false,
    });
    expect(contents(withoutFileContext)).toContain("Global project rule.");
    expect(contents(withoutFileContext)).not.toContain("TypeScript-only rule.");

    const withMatchingFile = await loadAgentInstructions({
      workspace,
      home,
      includeUserInstructions: false,
      touchedFilePaths: ["src/app/main.ts"],
    });
    expect(contents(withMatchingFile)).toContain("TypeScript-only rule.");

    const withNonMatchingFile = await loadAgentInstructions({
      workspace,
      home,
      includeUserInstructions: false,
      touchedFilePaths: ["docs/readme.md"],
    });
    expect(contents(withNonMatchingFile)).not.toContain(
      "TypeScript-only rule.",
    );
  });

  test("uses the owning project root for path-scoped rules nested under rules folders", async () => {
    const { home, workspace } = await fixture();
    const rootNestedRules = join(
      workspace,
      ".claude",
      "rules",
      "frontend",
      "style.md",
    );
    await mkdir(dirname(rootNestedRules), { recursive: true });
    await writeFile(
      rootNestedRules,
      "---\npaths: ['src/**/*.tsx']\n---\nNested frontend rule.",
    );

    const projectNestedRules = join(
      workspace,
      "packages",
      "app",
      ".agents",
      "rules",
      "lint",
      "typescript.md",
    );
    await mkdir(dirname(projectNestedRules), { recursive: true });
    await writeFile(
      projectNestedRules,
      "---\npaths: ['src/**/*.ts']\n---\nNested app rule.",
    );

    const frontend = await loadAgentInstructions({
      workspace,
      home,
      includeUserInstructions: false,
      touchedFilePaths: ["src/components/card.tsx"],
      nestedOnly: true,
    });
    expect(contents(frontend)).toContain("Nested frontend rule.");
    expect(contents(frontend)).not.toContain("Nested app rule.");

    const appSource = await loadAgentInstructions({
      workspace,
      home,
      includeUserInstructions: false,
      touchedFilePaths: ["packages/app/src/server.ts"],
      nestedOnly: true,
    });
    expect(contents(appSource)).toContain("Nested app rule.");
    expect(contents(appSource)).not.toContain("Nested frontend rule.");
  });

  test("ignores symbolic links while enumerating rule directories", async () => {
    const { root, home, workspace } = await fixture();
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.md"), "must not be followed");
    await mkdir(join(workspace, ".agents"), { recursive: true });
    await symlink(outside, join(workspace, ".agents", "rules"));

    const loaded = await loadAgentInstructions({
      workspace,
      home,
      includeUserInstructions: false,
    });
    expect(contents(loaded)).not.toContain("must not be followed");
  });

  test("injects newly relevant nested instructions after a runtime Read", async () => {
    const { home, workspace } = await fixture();
    const target = join(workspace, "src", "private", "task.ts");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "export const value = 1;\n");
    await writeFile(
      join(workspace, "src", "AGENTS.md"),
      "Source subtree guidance.",
    );
    const rules = join(workspace, "src", ".claude", "rules");
    await mkdir(rules, { recursive: true });
    await writeFile(
      join(rules, "typescript.md"),
      "---\npaths: ['**/*.ts']\n---\nTypeScript file guidance.",
    );
    const rootRules = join(workspace, ".claude", "rules");
    await mkdir(rootRules, { recursive: true });
    await writeFile(
      join(rootRules, "source.md"),
      "---\npaths: ['src/**/*.ts']\n---\nRoot scoped source guidance.",
    );
    const unrelated = join(workspace, "docs", ".claude", "rules");
    await mkdir(unrelated, { recursive: true });
    await writeFile(join(unrelated, "docs.md"), "Documentation-only guidance.");

    const physicalWorkspace = await realpath(workspace);
    const physicalTarget = await realpath(target);
    const permissions = new AgentPermissions({
      cwd: physicalWorkspace,
      allowedTools: ["Read"],
    });
    expect(await permissions.resolvePath("Read", physicalTarget)).toBe(
      physicalTarget,
    );
    const runtime = await createCodexAgentRuntime({
      apiKey: "test-key",
      getModel: () => "gpt-6-luna",
      setModel: () => undefined,
      assertModel: () => undefined,
      resolveModel: (model) => model ?? "gpt-6-luna",
      inheritedInstructions: "",
      configuration: {
        instructionHome: home,
        includeUserInstructions: false,
        settings: {},
        sources: [],
        plugins: [],
        mcpServers: {},
        commandDirectories: [],
        skillDirectories: [],
        agentDirectories: [],
        lspServers: {},
        workflowDirectories: [],
        outputStyleDirectories: [],
        hooks: {},
        projectInstructions: "",
      },
      permissions,
      sessionId: "test-session",
      deadline: Date.now() + 60_000,
      signal: new AbortController().signal,
      mcpConfig: '{"mcpServers":{}}',
      mcpEnvironment: {},
      toolEnvironment: {},
      trustedEnvironmentKeys: [],
      backgroundTasks: new Map(),
      register: () => undefined,
      redact: (value) => value,
      removeSecretAliases: () => undefined,
      emit: () => undefined,
    });
    try {
      const readTool = runtime.tools.find((tool) => tool.name === "Read");
      expect(readTool).toBeDefined();
      const scoped = await loadAgentInstructions({
        workspace,
        home,
        includeUserInstructions: false,
        touchedFilePaths: ["src/private/task.ts"],
        nestedOnly: true,
      });
      expect(contents(scoped)).toContain("Source subtree guidance.");
      const beforeToolResult = await runtime.toolOptions.beforeTool?.({
        name: "Read",
        input: { file_path: physicalTarget },
      });
      expect(beforeToolResult).toBeDefined();
      await readFile(physicalTarget, "utf8");
      const nextModelContext = JSON.stringify(runtime.beforeModel());
      expect(nextModelContext.includes("Source subtree guidance.")).toBe(true);
      expect(nextModelContext.includes("TypeScript file guidance.")).toBe(true);
      expect(nextModelContext.includes("Root scoped source guidance.")).toBe(
        true,
      );
      expect(nextModelContext.includes("Documentation-only guidance.")).toBe(
        false,
      );
      expect(runtime.beforeModel()).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});
