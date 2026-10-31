import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

type Step = {
  name: string;
  run?: string;
  env?: Record<string, string>;
};

for (const action of ["../action.yml", "../base-action/action.yml"]) {
  for (const customRuntime of [false, true]) {
    test(`${action} runs every runtime step with ${customRuntime ? "the exact custom executable" : "Bun from PATH"} and spaced paths`, async () => {
      const metadata = parse(
        await readFile(new URL(action, import.meta.url), "utf8"),
      );
      const directory = await mkdtemp(join(tmpdir(), "action execution "));
      try {
        const actionPath = join(directory, "action source");
        await mkdir(actionPath);
        const executable = join(
          directory,
          customRuntime ? "custom runtime.exe" : "bun",
        );
        const capture = join(directory, "arguments");
        await writeFile(
          executable,
          '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\n',
        );
        await chmod(executable, 0o700);
        const runtimeSteps = (metadata.runs.steps as Step[]).filter((step) =>
          step.run?.includes("--no-env-file"),
        );
        expect(runtimeSteps.length).toBe(
          action.includes("base-action") ? 2 : 4,
        );
        for (const step of runtimeSteps) {
          expect(step.env?.BUN_EXECUTABLE).toBe(
            "${{ inputs.path_to_bun_executable || 'bun' }}",
          );
          const result = spawnSync(
            "bash",
            ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run!],
            {
              encoding: "utf8",
              env: {
                PATH: `${directory}:/usr/bin:/bin`,
                BUN_EXECUTABLE: customRuntime ? executable : "bun",
                GITHUB_ACTION_PATH: actionPath,
                CAPTURE_ARGS: capture,
              },
            },
          );
          expect(result.stderr).toBe("");
          expect(result.status).toBe(0);
          const args = (await readFile(capture, "utf8")).trim().split("\n");
          expect(args[0]).toBe("--no-env-file");
          if (step.name.toLowerCase() === "install dependencies") {
            expect(args).toEqual([
              "--no-env-file",
              "install",
              "--production",
              "--frozen-lockfile",
            ]);
          } else {
            expect(args).toHaveLength(4);
            expect(args[1]).toBe(`--config=${actionPath}/bunfig.toml`);
            expect(args[2]).toBe("run");
            expect(args[3]).toStartWith(`${actionPath}/src/`);
            expect(args[3]).toEndWith(".ts");
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
