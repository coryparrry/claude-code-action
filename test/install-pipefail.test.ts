import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";

for (const path of ["../action.yml", "../base-action/action.yml"]) {
  test(`${path} stops when SDK dependency installation fails`, async () => {
    const metadata = parse(
      await readFile(new URL(path, import.meta.url), "utf8"),
    );
    const install = metadata.runs.steps.find(
      (step: { name?: string }) =>
        step.name?.toLowerCase() === "install dependencies",
    );
    const directory = await mkdtemp(
      join(tmpdir(), "codex-sdk-install-failure-"),
    );
    try {
      const executable = join(directory, "bun");
      await writeFile(
        executable,
        "#!/bin/sh\nprintf 'SDK dependency installation failed\\n' >&2\nexit 17\n",
      );
      await chmod(executable, 0o700);
      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-e",
          "-o",
          "pipefail",
          "-c",
          `${install.run}\necho RUNTIME_STARTED`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            GITHUB_ACTION_PATH: directory,
          },
        },
      );
      expect(install.shell).toBe("bash");
      expect(result.status).toBe(17);
      expect(result.stderr).toContain("SDK dependency installation failed");
      expect(result.stdout).not.toContain("RUNTIME_STARTED");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
