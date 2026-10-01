import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentPermissions,
  canonicalToolName,
  globPattern,
} from "../src/agent-permissions";

const directories: string[] = [];
async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agent-permissions-")),
  );
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("AgentPermissions", () => {
  test("persistent updates atomically merge settings without dropping unrelated fields", async () => {
    const cwd = await fixture(),
      additional = await fixture();
    const projectSettings = join(cwd, ".claude", "settings.json");
    await mkdir(join(cwd, ".claude"));
    await writeFile(
      projectSettings,
      JSON.stringify({
        hooks: { PreToolUse: [] },
        model: "preserved",
        permissions: {
          allow: ["Read"],
          deny: ["Bash(rm:*)"],
          retained: "value",
        },
      }),
    );
    const permissions = new AgentPermissions({
      cwd,
      permissionSettingsPaths: { projectSettings },
    });
    permissions.applyUpdates([
      {
        type: "addRules",
        behavior: "allow",
        rules: [{ toolName: "Edit", ruleContent: "src/**" }],
        destination: "projectSettings",
      },
      { type: "setMode", mode: "acceptEdits", destination: "projectSettings" },
      {
        type: "addDirectories",
        directories: [additional],
        destination: "projectSettings",
      },
    ]);
    const saved = JSON.parse(await readFile(projectSettings, "utf8"));
    expect(saved.model).toBe("preserved");
    expect(saved.hooks).toEqual({ PreToolUse: [] });
    expect(saved.permissions.retained).toBe("value");
    expect(saved.permissions.allow).toEqual(["Read", "Edit(src/**)"]);
    expect(saved.permissions.deny).toEqual(["Bash(rm:*)"]);
    const reloaded = new AgentPermissions({
      cwd,
      allowedTools: saved.permissions.allow,
      disallowedTools: saved.permissions.deny,
      permissionMode: saved.permissions.defaultMode,
      additionalDirectories: saved.permissions.additionalDirectories,
    });
    expect(reloaded.needsApproval("Edit", "src/file")).toBe(false);
    await expect(
      reloaded.resolvePath("Write", join(additional, "file")),
    ).resolves.toBe(join(additional, "file"));
    expect(() =>
      permissions.applyUpdates([
        {
          type: "addRules",
          behavior: "allow",
          rules: [{ toolName: "Write" }],
          destination: "userSettings",
        },
      ]),
    ).toThrow("No trusted settings path");
    await symlink(projectSettings, join(cwd, "linked.json"));
    expect(() =>
      new AgentPermissions({
        cwd,
        permissionSettingsPaths: { localSettings: join(cwd, "linked.json") },
      }).applyUpdates([
        { type: "setMode", mode: "default", destination: "localSettings" },
      ]),
    ).toThrow("symlink");
  });

  test("shared updates preserve allow, deny, ask, modes, and directory boundaries", async () => {
    const cwd = await fixture(),
      additional = await fixture();
    const permissions = new AgentPermissions({ cwd, allowedTools: ["Read"] });
    permissions.applyUpdates([
      {
        type: "addRules",
        behavior: "allow",
        rules: [{ toolName: "Edit", ruleContent: "src/**" }],
      },
    ]);
    expect(permissions.needsApproval("Edit", "src/a")).toBe(false);
    expect(permissions.needsApproval("Edit", "other/a")).toBe(true);
    permissions.applyUpdates([
      { type: "setMode", mode: "bypassPermissions" },
      {
        type: "addRules",
        behavior: "ask",
        rules: [{ toolName: "Edit", ruleContent: "src/private/**" }],
      },
      { type: "addDirectories", directories: [additional] },
    ]);
    expect(() =>
      permissions.authorize("Edit", "src/private/a", "allow"),
    ).toThrow("ask rule");
    await expect(
      permissions.resolvePath("Write", join(additional, "new")),
    ).resolves.toBe(join(additional, "new"));
    permissions.applyUpdates([
      { type: "removeDirectories", directories: [additional] },
      {
        type: "removeRules",
        behavior: "ask",
        rules: [{ toolName: "Edit", ruleContent: "src/private/**" }],
      },
      {
        type: "replaceRules",
        behavior: "deny",
        rules: [{ toolName: "Write" }],
      },
    ]);
    expect(() =>
      permissions.authorize("Edit", "src/private/a", "allow"),
    ).not.toThrow();
    expect(() => permissions.authorize("Write", "new", "allow")).toThrow(
      "denied",
    );
    await expect(
      permissions.resolveBoundary(join(additional, "new")),
    ).rejects.toThrow("outside");
  });

  test("hosted domains and named advanced tools retain scoped approvals", async () => {
    const cwd = await fixture();
    const permissions = new AgentPermissions({
      cwd,
      allowedTools: [
        "WebFetch(domain:example.com)",
        "Task(build)",
        "Skill(review)",
        "Workflow(release)",
        "mcp__github",
      ],
    });
    expect(
      permissions.needsApproval("WebFetch", "https://example.com/docs"),
    ).toBe(false);
    expect(
      permissions.needsApproval(
        "WebFetch",
        "https://example.com.evil.test/docs",
      ),
    ).toBe(true);
    for (const [tool, target] of [
      ["Task", "build"],
      ["Skill", "review"],
      ["Workflow", "release"],
      ["mcp__github__issue", ""],
    ])
      expect(permissions.needsApproval(tool!, target)).toBe(false);
    expect(permissions.needsApproval("Task", "other")).toBe(true);
  });

  test("keeps shell and file grants independent and denies win", async () => {
    const cwd = await fixture();
    const permissions = new AgentPermissions({
      cwd,
      allowedTools: ["Read", "Bash"],
      disallowedTools: ["Read(secret.txt)"],
    });
    expect(() =>
      permissions.assertTool("Bash", "touch output.txt"),
    ).not.toThrow();
    expect(() => permissions.assertTool("Read", "secret.txt")).toThrow(
      "denied",
    );
    expect(() => permissions.assertTool("Write", "output.txt")).toThrow(
      "not allowed",
    );
    expect(() =>
      new AgentPermissions({ cwd, allowedTools: ["Write"] }).assertTool(
        "Bash",
        "touch a",
      ),
    ).toThrow("not allowed");
  });

  test("scoped shell grants allow a literal executable prefix, never composition", async () => {
    const cwd = await fixture();
    const permissions = new AgentPermissions({
      cwd,
      allowedTools: ["Bash(gh:*)", "Bash(npm run test:*)"],
    });
    for (const command of [
      "gh",
      "gh issue view 3",
      "gh issue view 'three words'",
      "npm run test -- --filter tools",
    ])
      expect(() => permissions.assertTool("Bash", command)).not.toThrow();
    for (const command of [
      "github issue",
      "gh; touch bad",
      "gh && touch bad",
      "gh | cat",
      "gh $(touch bad)",
      "gh `touch bad`",
      "gh > bad",
      "gh\ntouch bad",
      "gh ${SECRET}",
      "env gh issue view",
      "gh # hidden",
    ])
      expect(() => permissions.assertTool("Bash", command)).toThrow();
  });

  test("scoped denials cannot be hidden inside unrestricted composed Bash", async () => {
    const cwd = await fixture();
    const permissions = new AgentPermissions({
      cwd,
      allowedTools: ["Bash"],
      disallowedTools: ["Bash(rm:*)"],
    });
    expect(() => permissions.assertTool("Bash", "rm file")).toThrow("denied");
    expect(() => permissions.assertTool("Bash", "'rm' file")).toThrow("denied");
    expect(() => permissions.assertTool("Bash", 'r"m" file')).toThrow("denied");
    expect(() => permissions.assertTool("Bash", "echo safe; rm file")).toThrow(
      "composition",
    );
    expect(() => permissions.assertTool("Bash", "echo safe")).not.toThrow();
    expect(() =>
      new AgentPermissions({
        cwd,
        permissionMode: "bypassPermissions",
      }).assertTool("Bash", "echo ok && echo unrestricted"),
    ).not.toThrow();
  });

  test("path scopes, aliases, and glob matching", async () => {
    const cwd = await fixture();
    await mkdir(join(cwd, "src"));
    const permissions = new AgentPermissions({
      cwd,
      allowedTools: ["read_file(src/**)", "Edit(src/**)"],
      disallowedTools: ["Read(src/private/**)"],
    });
    await expect(permissions.resolvePath("Read", "src/a.txt")).resolves.toBe(
      join(cwd, "src/a.txt"),
    );
    await expect(
      permissions.resolvePath("MultiEdit", "src/a.txt"),
    ).resolves.toBe(join(cwd, "src/a.txt"));
    await expect(
      permissions.resolvePath("Read", "src/private/a.txt"),
    ).rejects.toThrow("denied");
    await expect(
      permissions.resolvePath("Read", "elsewhere/a.txt"),
    ).resolves.toBe(join(cwd, "elsewhere/a.txt"));
    expect(canonicalToolName("exec_command")).toBe("Bash");
    expect(() =>
      new AgentPermissions({
        cwd,
        allowedTools: ["MultiEdit"],
        disallowedTools: ["Edit"],
      }).assertTool("MultiEdit", "src/a.txt"),
    ).toThrow("denied");
    expect(globPattern("**/*.ts").test("index.ts")).toBe(true);
    expect(globPattern("src/*.ts").test("src/nested/index.ts")).toBe(false);
    expect(globPattern("src/?.ts").test("src/a.ts")).toBe(true);
  });

  test("rejects traversal and symlink escapes including nonexistent destinations", async () => {
    const cwd = await fixture();
    const outside = await fixture();
    await writeFile(join(outside, "secret"), "secret");
    await symlink(outside, join(cwd, "outside"));
    await mkdir(join(cwd, "inside"));
    await symlink(join(cwd, "inside"), join(cwd, "alias"));
    const permissions = new AgentPermissions({
      cwd,
      permissionMode: "acceptEdits",
    });
    for (const path of [
      join(outside, "secret"),
      "../secret",
      "outside/secret",
      "outside/new/file",
      "alias/new/file",
    ])
      await expect(permissions.resolvePath("Write", path)).rejects.toThrow();
    await expect(
      permissions.resolvePath("Write", "inside/new/file"),
    ).resolves.toBe(join(cwd, "inside/new/file"));
    await expect(
      new AgentPermissions({
        cwd,
        additionalDirectories: [outside],
      }).resolvePath("Read", join(outside, "secret")),
    ).resolves.toBe(join(outside, "secret"));
  });

  test("read-only and plan reject mutations and unrestricted shells", async () => {
    const cwd = await fixture();
    for (const options of [
      { permissionMode: "plan" },
      { permissionMode: "readonly" },
      { sandboxMode: "read-only" },
    ]) {
      const permissions = new AgentPermissions({ cwd, ...options });
      for (const name of ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"])
        expect(() =>
          permissions.assertTool(name, name === "Bash" ? "cat a" : "a"),
        ).toThrow("read-only/plan");
      expect(() => permissions.assertTool("Read", "a")).not.toThrow();
      expect(() => permissions.assertTool("TodoWrite")).not.toThrow();
    }
  });

  test("acceptEdits preserves original tag mode edits without broadening shell grants", async () => {
    const cwd = await fixture();
    const tagTools = ["Glob", "Grep", "LS", "Read", "Bash(git:*)"];
    const permissions = new AgentPermissions({
      cwd,
      permissionMode: "acceptEdits",
      allowedTools: tagTools,
    });
    for (const name of ["Write", "Edit", "MultiEdit", "NotebookEdit"])
      await expect(permissions.resolvePath(name, "new/file.txt")).resolves.toBe(
        join(cwd, "new/file.txt"),
      );
    await expect(
      permissions.resolvePath("Write", "../outside.txt"),
    ).rejects.toThrow("outside");
    expect(() => permissions.assertTool("Bash", "touch ../outside")).toThrow(
      "not allowed",
    );
    expect(() =>
      permissions.assertTool("Bash", "git status && touch outside"),
    ).toThrow("not allowed");
    await expect(
      new AgentPermissions({
        cwd,
        permissionMode: "acceptEdits",
        allowedTools: tagTools,
        disallowedTools: ["Edit"],
      }).resolvePath("MultiEdit", "new/file.txt"),
    ).rejects.toThrow("denied");
  });

  test("explicit bypassPermissions bypasses approval allowlists but retains hard restrictions", async () => {
    const cwd = await fixture();
    const permissions = new AgentPermissions({
      cwd,
      permissionMode: "bypassPermissions",
      allowedTools: ["Read"],
      disallowedTools: ["Edit(private/**)", "Bash(rm:*)"],
    });
    await expect(permissions.resolvePath("Write", "a.txt")).resolves.toBe(
      join(cwd, "a.txt"),
    );
    expect(() =>
      permissions.assertTool("Bash", "echo permitted"),
    ).not.toThrow();
    expect(() => permissions.assertTool("Bash", "rm file")).toThrow("denied");
    await expect(
      permissions.resolvePath("Edit", "private/file"),
    ).rejects.toThrow("denied");
    await expect(
      permissions.resolvePath("Write", "../outside"),
    ).rejects.toThrow("outside");
    expect(() =>
      new AgentPermissions({
        cwd,
        permissionMode: "bypassPermissions",
        sandboxMode: "read-only",
      }).assertTool("Bash", "echo harmless"),
    ).toThrow("read-only/plan");
    expect(() =>
      new AgentPermissions({ cwd, allowedTools: ["Read"] }).assertTool(
        "Bash",
        "touch harmless",
      ),
    ).toThrow("not allowed");
  });
});
