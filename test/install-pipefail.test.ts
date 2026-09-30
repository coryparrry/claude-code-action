import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Codex installation preserves an installer failure instead of continuing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-install-failure-"));
  const npm = join(directory, "npm");
  await writeFile(npm, "#!/bin/sh\nexit 17\n");
  await chmod(npm, 0o700);
  try {
    const source = new URL("../src/codex-install.ts", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--eval",
        `import { installCodex } from ${JSON.stringify(source)}; try { await installCodex(); } catch (error) { console.error(error.message); process.exit(1); }`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: directory,
          RUNNER_TEMP: directory,
          CODEX_VERSION: "0.159.2",
          PATH_TO_CODEX_EXECUTABLE: "",
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exit code 17");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
