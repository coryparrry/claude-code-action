import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const installerFiles = [
  "LICENSE",
  "scripts/install-github-app.mjs",
  "scripts/github-action-installer/github.mjs",
  "scripts/github-action-installer/install.mjs",
  "scripts/github-action-installer/reconcile.mjs",
  "scripts/github-action-installer/keys.mjs",
  "scripts/github-action-installer/settings.mjs",
  "scripts/github-action-installer/terminal.mjs",
  "scripts/github-action-installer/workflow.mjs",
];

/** Build the standalone npm archive from only the CLI, its modules, and the license. */
function packInstaller(version, destination) {
  if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(version)) {
    throw new Error(
      "Usage: npm run pack:installer -- VERSION OUTPUT_DIRECTORY",
    );
  }

  const staging = mkdtempSync(join(tmpdir(), "codex-action-package-"));
  try {
    mkdirSync(join(staging, "scripts/github-action-installer"), {
      recursive: true,
    });
    for (const file of installerFiles) {
      copyFileSync(new URL(`../${file}`, import.meta.url), join(staging, file));
    }
    writeFileSync(
      join(staging, "package.json"),
      JSON.stringify({
        name: "@codex-action/installer",
        version,
        description: "Installer for the Codex GitHub Action",
        license: "MIT",
        repository: "https://github.com/coryparrry/claude-code-action",
        engines: { node: ">=20" },
        bin: { "codex-action": "scripts/install-github-app.mjs" },
      }),
    );
    execFileSync("npm", ["pack", "--quiet", "--ignore-scripts"], {
      cwd: staging,
    });
    const filename = readdirSync(staging).find((file) => file.endsWith(".tgz"));
    if (!filename)
      throw new Error("npm pack did not produce an installer archive.");
    mkdirSync(destination, { recursive: true });
    const asset = join(destination, "codex-action.tgz");
    copyFileSync(join(staging, filename), asset);
    return asset;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const [version, destination] = process.argv.slice(2);
if (!version || !destination) {
  throw new Error("Usage: npm run pack:installer -- VERSION OUTPUT_DIRECTORY");
}
console.log(packInstaller(version, resolve(destination)));
