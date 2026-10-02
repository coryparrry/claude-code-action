import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "codex-action-package-"));
const bun = process.env.BUN_EXECUTABLE || "bun";
// Package checks use a deterministic offline model and never inherit model or
// GitHub credentials. Dependency installation is the only network operation.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|SystemRoot|TMPDIR|TEMP|TMP|HTTPS?_PROXY|NO_PROXY|BUN_INSTALL_CACHE_DIR)$/i.test(
      key,
    ),
  ),
);
environment.BUN_INSTALL_CACHE_DIR = join(temporary, "package-cache");
environment.BUN_RUNTIME_TRANSPILER_CACHE_PATH = join(
  temporary,
  "runtime-cache",
);

function run(args, cwd) {
  const result = spawnSync(bun, args, {
    cwd,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Package verification failed (${result.status})`);
  }
}

try {
  for (const base of [false, true]) {
    const checkout = join(temporary, base ? "base-checkout" : "root-checkout");
    const target = base ? join(checkout, "base-action") : checkout;
    const source = base ? join(repository, "base-action") : repository;
    await mkdir(target, { recursive: true });
    for (const name of [
      "package.json",
      "bun.lock",
      "bunfig.toml",
      "tsconfig.json",
      "src",
    ]) {
      await cp(join(source, name), join(target, name), { recursive: true });
    }
    if (!base) {
      await cp(
        join(repository, "base-action/src"),
        join(target, "base-action/src"),
        {
          recursive: true,
        },
      );
    } else {
      // GitHub downloads the whole repository for a subdirectory action. Keep
      // that source layout without a parent node_modules hiding missing deps.
      await cp(join(repository, "src"), join(checkout, "src"), {
        recursive: true,
      });
    }
    run(
      ["--no-env-file", "install", "--production", "--frozen-lockfile"],
      target,
    );
    const runtime = base ? "./src/run-codex" : "./base-action/src/run-codex";
    const entrypoint = base ? "./src/index" : "./src/entrypoints/run";
    await writeFile(
      join(target, "smoke.ts"),
      `import { Usage } from "@openai/agents";
import { runCodex } from ${JSON.stringify(runtime)};
await import(${JSON.stringify(entrypoint)});
const workspace = process.cwd();
process.env.OPENAI_API_KEY = "offline-package-smoke";
process.env.RUNNER_TEMP = workspace;
await Bun.write("prompt.txt", "Return the package smoke result.");
const result = await runCodex("prompt.txt", {
  workspace,
  configurationHome: workspace,
  settingSources: [],
  mcpConfig: '{"mcpServers":{}}',
  timeoutMs: 10000,
  model: {
    async getResponse() {
      return {
        usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1 }),
        output: [{ type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: "package-smoke-ok" }] }],
      };
    },
    async *getStreamedResponse() { throw new Error("Unexpected stream"); },
  },
});
const report = await Bun.file(result.executionFile).json();
if (result.conclusion !== "success" || report.at(-1)?.result !== "package-smoke-ok") {
  throw new Error("Unexpected agent result");
}
console.log("Production package SDK run passed");
`,
    );
    run(["--no-env-file", "--config=./bunfig.toml", "run", "smoke.ts"], target);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
