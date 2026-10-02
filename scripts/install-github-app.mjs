#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GitHubClient } from "./github-action-installer/github.mjs";
import {
  applyInstallation,
  planInstallation,
} from "./github-action-installer/install.mjs";
import {
  readKeyFile,
  validateApiKey,
} from "./github-action-installer/keys.mjs";
import { Terminal } from "./github-action-installer/terminal.mjs";
import {
  DEFAULT_MODEL,
  DEFAULT_TRIGGER_PHRASE,
  validateActor,
  validateRepository,
} from "./github-action-installer/workflow.mjs";

const HELP = `Codex GitHub Action installer

Usage: codex-action [install|doctor|repos] [options]
       npm run install-github-app -- [options]

install (default)  Guided repository, secret and workflow setup; opens draft PRs.
doctor            Check GitHub login and report setup requirements.
repos             List up to 100 owned repositories accessible for setup.

Options:
  --repo OWNER/REPO    Repository to configure; repeat for multiple repositories.
  --key-file PATH     Read OPENAI_API_KEY from an env file or a plain key file.
  --use-env-key       Explicitly use OPENAI_API_KEY from the environment.
  --replace-secret    Replace an existing repository API-key secret.
  --runner RUNNER     ubuntu-latest (default) or macos-latest for Xcode tasks.
  --model MODEL       OpenAI model (default: ${DEFAULT_MODEL}).
  --actor USER        Trusted trigger user; repeat (default: signed-in user).
  --yes               Approve the reviewed setup without a terminal prompt.
  --dry-run           Read and display the plan; never read keys or make writes.
  --json              Emit a JSON success/error envelope for automation.
  --help              Show this help without network access.

Requires Node.js and GitHub CLI (gh). Secrets are sent through stdin, not arguments.
The installer uses the built-in GitHub workflow token and creates no hosted App.
Merge the setup PR onto the default branch to enable automatic PR reviews.
Use ${DEFAULT_TRIGGER_PHRASE} in issues, PR comments or reviews to ask questions or request changes.
`;

function argumentsFor(argv) {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        repo: { type: "string", multiple: true },
        "key-file": { type: "string" },
        "use-env-key": { type: "boolean" },
        "replace-secret": { type: "boolean" },
        runner: { type: "string" },
        model: { type: "string" },
        actor: { type: "string", multiple: true },
        yes: { type: "boolean" },
        "dry-run": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    const command = parsed.positionals[0] ?? "install";
    if (
      parsed.positionals.length > 1 ||
      !["install", "doctor", "repos"].includes(command)
    )
      throw new Error();
    return { ...parsed.values, command };
  } catch {
    throw new Error("Invalid arguments. Run codex-action --help for usage.");
  }
}

async function chooseRepositories(client, user, terminal) {
  const repositories = (await client.repositories(user.login)).filter(
    (repo) =>
      !repo.isArchived &&
      ["ADMIN", "MAINTAIN", "WRITE"].includes(repo.viewerPermission),
  );
  terminal.write("\nChoose repositories to enable:");
  repositories.forEach((repo, index) =>
    terminal.write(`  ${index + 1}. ${repo.nameWithOwner}`),
  );
  const answer = await terminal.ask(
    "Repository numbers or owner/repo names, separated by commas: ",
  );
  if (!answer) throw new Error("Select at least one repository.");
  return answer.split(",").map((value) => {
    const entry = value.trim();
    if (/^\d+$/.test(entry)) {
      const repo = repositories[Number(entry) - 1];
      if (!repo)
        throw new Error(
          "Select a listed repository number or owner/repo name.",
        );
      return repo.nameWithOwner;
    }
    return validateRepository(entry);
  });
}

async function chooseKey(options, terminal) {
  if (options["key-file"]) return readKeyFile(resolve(options["key-file"]));
  if (options["use-env-key"]) return validateApiKey(process.env.OPENAI_API_KEY);
  if (!terminal.interactive || options.json)
    throw new Error(
      "A key is needed. Supply --key-file or --use-env-key explicitly.",
    );
  if (
    process.env.OPENAI_API_KEY &&
    (await terminal.confirm(
      "Use the existing OPENAI_API_KEY environment variable?",
    ))
  )
    return validateApiKey(process.env.OPENAI_API_KEY);
  const candidates = [
    ...new Set([
      resolve(".env.local"),
      resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"),
    ]),
  ];
  for (const filename of candidates) {
    if (
      existsSync(filename) &&
      (await terminal.confirm(`Use the existing key from ${filename}?`))
    )
      return readKeyFile(filename);
  }
  terminal.write(
    "Use an existing OpenAI API key. New keys can be created at https://platform.openai.com/api-keys.",
  );
  return validateApiKey(await terminal.secret("OpenAI API key (hidden): "));
}

export async function runCli(
  argv,
  { client = new GitHubClient(), terminal = new Terminal() } = {},
) {
  const options = argumentsFor(argv);
  const emit = (result) => {
    if (options.json) terminal.write(JSON.stringify({ ok: true, ...result }));
    return result;
  };
  if (options.help) {
    terminal.write(HELP);
    return;
  }
  if (options["key-file"] && options["use-env-key"])
    throw new Error("Choose --key-file or --use-env-key, not both.");
  if (
    options.json &&
    terminal.interactive &&
    !options.yes &&
    !options["dry-run"] &&
    options.command === "install"
  )
    throw new Error("JSON installation requires --yes or --dry-run.");

  const authenticated = await client.authenticated();
  if (options.command === "doctor") {
    const user = authenticated ? await client.user() : undefined;
    const result = {
      ready: authenticated,
      login: user?.login,
      model: DEFAULT_MODEL,
      authentication: authenticated ? "GitHub CLI" : "missing",
      nextStep: authenticated
        ? "Run install to choose repositories."
        : "Run gh auth login --web --scopes repo,workflow.",
    };
    if (!options.json) terminal.write(result.nextStep);
    return emit(result);
  }
  if (!authenticated) {
    if (!terminal.interactive || options.json || options["dry-run"])
      throw new Error(
        "Sign in first: gh auth login --web --scopes repo,workflow",
      );
    if (
      !(await terminal.confirm("Sign in to GitHub through your browser?", true))
    )
      return emit({ cancelled: true });
    await client.login();
  }
  const user = await client.user();
  validateActor(user.login);
  if (options.command === "repos") {
    const repositories = await client.repositories(user.login);
    if (!options.json)
      repositories.forEach((repo) => terminal.write(repo.nameWithOwner));
    return emit({ repositories });
  }
  if (!terminal.interactive && !options["dry-run"] && !options.yes)
    throw new Error("Noninteractive installation requires --repo and --yes.");
  if (
    !options.repo?.length &&
    (!terminal.interactive || options.yes || options.json)
  )
    throw new Error("Specify --repo for noninteractive installation.");
  const repositories = [
    ...new Set(
      options.repo?.flatMap((value) =>
        value.split(",").map(validateRepository),
      ) ?? (await chooseRepositories(client, user, terminal)),
    ),
  ];
  let runner = options.runner ?? "ubuntu-latest";
  if (
    terminal.interactive &&
    !options.yes &&
    !options["dry-run"] &&
    !options.runner
  ) {
    const choice = await terminal.ask(
      "Runner: 1 Linux, 2 macOS for Xcode [1]: ",
    );
    if (choice && !["1", "2"].includes(choice))
      throw new Error("Choose runner 1 or 2.");
    runner = choice === "2" ? "macos-latest" : "ubuntu-latest";
  }
  const actors = options.actor ?? [user.login];
  const model = options.model ?? DEFAULT_MODEL;
  const plans = [];
  for (const repository of repositories)
    plans.push(
      await planInstallation(client, {
        repository,
        actors,
        runner,
        model,
        replaceSecret: !!options["replace-secret"],
      }),
    );
  if (!options.json) {
    terminal.write(
      `\nModel: ${model}; runner: ${runner}; trusted users: ${actors.join(", ")}`,
    );
    terminal.write(
      `Automatic reviews: trusted users' same-repository, non-draft PRs when opened or updated. Reviews use read-only code access; ${DEFAULT_TRIGGER_PHRASE} requests can implement changes. Both show progress.`,
    );
    for (const plan of plans)
      terminal.write(
        `${plan.repository}: ${plan.status} workflow on ${plan.defaultBranch}; OPENAI_API_KEY: ${plan.needsSecret ? (plan.replaceSecret ? "replace" : "create") : "reuse"}`,
      );
    terminal.write(
      "Workflow changes are proposed in draft PRs. Existing workflows are preserved.",
    );
  }
  if (options["dry-run"]) return emit({ dryRun: true, plans });
  if (
    !options.yes &&
    !(await terminal.confirm("Apply this setup to the selected repositories?"))
  )
    return emit({ cancelled: true });
  const apiKey = plans.some((plan) => plan.needsSecret)
    ? await chooseKey(options, terminal)
    : undefined;
  const results = [];
  for (const plan of plans) {
    try {
      const result = await applyInstallation(client, plan, { apiKey });
      results.push(result);
      if (!options.json)
        terminal.write(
          `${result.repository}: ${result.pullRequestUrl ?? "already configured"}`,
        );
    } catch (error) {
      if (options.json)
        terminal.write(
          JSON.stringify({
            ok: false,
            results,
            error: { message: error.message },
          }),
        );
      else terminal.write(`${plan.repository}: ${error.message}`);
      process.exitCode = 1;
      return { results, failed: true };
    }
  }
  if (!options.json)
    terminal.write(
      `\nMerge each setup PR to enable automatic PR reviews. Use ${DEFAULT_TRIGGER_PHRASE} in issues, comments or reviews for questions and changes. Check the Actions tab for runs.`,
    );
  return emit({ results });
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli(process.argv.slice(2)).catch((error) => {
    const message =
      error instanceof Error ? error.message : "Installation failed.";
    if (process.argv.includes("--json"))
      console.error(JSON.stringify({ ok: false, error: { message } }));
    else console.error(message);
    process.exitCode = error.cancelled ? 130 : 1;
  });
}
