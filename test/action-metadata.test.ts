import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

describe("action metadata", () => {
  test("should expose the conclusion output from the run step", () => {
    const metadata = readFileSync(
      new URL("../action.yml", import.meta.url),
      "utf8",
    );

    expect(metadata).toMatch(
      /^  conclusion:\n    description: .+\n    value: \$\{\{ steps\.run\.outputs\.conclusion \}\}$/m,
    );
  });
});

const parseYaml = (
  Bun as unknown as {
    YAML: {
      parse: (source: string) => {
        inputs: Record<string, unknown>;
        outputs: Record<string, unknown>;
        runs: {
          steps: {
            name?: string;
            run?: string;
            env?: Record<string, string>;
          }[];
        };
      };
    };
  }
).YAML.parse;

describe("Codex-only runtime contract", () => {
  for (const path of ["../action.yml", "../base-action/action.yml"]) {
    test(`${path} exposes only Codex model authentication`, () => {
      const metadata = parseYaml(
        readFileSync(new URL(path, import.meta.url), "utf8"),
      );
      expect(metadata.inputs.openai_api_key).toBeDefined();
      for (const legacy of [
        "engine",
        "anthropic_api_key",
        "claude_code_oauth_token",
        "use_bedrock",
        "use_vertex",
        "use_foundry",
      ]) {
        expect(metadata.inputs[legacy]).toBeUndefined();
      }
      expect(metadata.outputs.structured_output).toBeDefined();
      expect(
        readFileSync(
          new URL(path.replace("action.yml", "bunfig.toml"), import.meta.url),
          "utf8",
        ),
      ).toContain("Intentionally minimal");
      for (const step of metadata.runs.steps) {
        expect(step.run ?? "").not.toMatch(
          /claude\.ai|api\.anthropic\.com|run-claude/,
        );
        expect(Object.keys(step.env ?? {}).join("\n")).not.toMatch(
          /ANTHROPIC|CLAUDE_CODE_OAUTH|BEDROCK|VERTEX|FOUNDRY/,
        );
      }
    });
  }
  for (const path of ["../package.json", "../base-action/package.json"]) {
    test(`${path} has no model-agent SDK dependency`, () => {
      const manifest = JSON.parse(
        readFileSync(new URL(path, import.meta.url), "utf8"),
      );
      expect(Object.keys(manifest.dependencies)).not.toContain(
        "@anthropic-ai/claude-agent-sdk",
      );
      expect(Object.keys(manifest.dependencies)).not.toContain(
        "@openai/agents",
      );
    });
  }
  test("the orchestrator and buffered-comment post-step cannot select or call Claude", () => {
    const orchestrator = readFileSync(
      new URL("../src/entrypoints/run.ts", import.meta.url),
      "utf8",
    );
    expect(orchestrator).toContain("await runCodex(");
    expect(orchestrator).not.toMatch(
      /runClaude|installClaude|setupWorkloadIdentity|setupClaudeCodeSettings|installPlugins/,
    );
    const postStep = readFileSync(
      new URL(
        "../src/entrypoints/post-buffered-inline-comments.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(postStep).toContain("classifyComments");
    expect(postStep).not.toMatch(/ANTHROPIC|api\.anthropic/);
  });
});

test("preserves the workflow capability inputs around the Codex backend", () => {
  const metadata = parseYaml(
    readFileSync(new URL("../action.yml", import.meta.url), "utf8"),
  );
  for (const input of [
    "prompt",
    "claude_args",
    "codex_args",
    "settings",
    "plugins",
    "plugin_marketplaces",
    "allowed_non_write_users",
    "additional_permissions",
    "use_commit_signing",
    "classify_inline_comments",
    "include_fix_links",
    "use_sticky_comment",
    "track_progress",
  ])
    expect(metadata.inputs[input]).toBeDefined();
  const postStep = metadata.runs.steps.find(
    (step) => step.name === "Post buffered inline comments",
  );
  expect(postStep?.env?.OPENAI_API_KEY).toContain("inputs.openai_api_key");
});
