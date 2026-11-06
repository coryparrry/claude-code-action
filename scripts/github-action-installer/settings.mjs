import { DEFAULT_MODEL } from "./workflow.mjs";

/** Read a top-level job from the installer-generated workflow format. */
function managedJob(content, job) {
  return content
    .split(
      new RegExp(
        `^  (?:${job}|"${job}"|'${job}'):[ \\t]*(?:#[^\\r\\n]*)?\\r?$`,
        "m",
      ),
    )[1]
    ?.split(/^  (?:[\w-]+|"[\w-]+"|'[\w-]+'):[ \t]*(?:#[^\r\n]*)?\r?$/m, 1)[0];
}

/** Ignore runner overrides when comparing the installed and proposed validation jobs. */
function validationJob(content) {
  return managedJob(content, "validate_change")
    ?.replace(/\r\n/g, "\n")
    .replace(/^    runs-on: .*\n/m, "")
    .trim();
}

/** Detect old or customized validation that the generated job would replace. */
export function needsValidationMigration(content = "", proposed) {
  const installed = validationJob(content);
  return !!installed && installed !== validationJob(proposed);
}

/** Read job IDs in the managed mapping, refusing layouts the installer cannot compare. */
function managedJobNames(content, path) {
  const header = /^jobs:[ \t]*(?:#[^\r\n]*)?\r?$/m.exec(content);
  const section =
    header &&
    content.slice(header.index + header[0].length).split(/^[^\s#]/m, 1)[0];
  const entries = section?.match(/^ {2}[^\s#].*$/gm) ?? [];
  const names = entries.map((line) => {
    const key =
      /^ {2}(?:([\w-]+)|"([\w-]+)"|'([\w-]+)'):[ \t]*(?:#[^\r\n]*)?\r?$/.exec(
        line,
      );
    return key?.slice(1).find(Boolean);
  });
  if (!names.length || names.some((name) => !name))
    throw new Error(
      `Could not safely read the job list in ${path}. Move custom jobs to a separate workflow before upgrading.`,
    );
  return names;
}

/** Protect jobs in either managed workflow that the installer would remove. */
export function assertNoRemovedJobs(existing, proposed, path) {
  if (!existing) return;
  const proposedJobs = new Set(managedJobNames(proposed, path));
  const removed = managedJobNames(existing, path).filter(
    (name) => !proposedJobs.has(name),
  );
  if (removed.length)
    throw new Error(
      `This upgrade would remove jobs from ${path}: ${removed.join(", ")}. Move them to a separate workflow or the trusted validation action before upgrading.`,
    );
}

/** Read only the generated options in one managed job. */
function jobSettings(content, job) {
  const command = managedJob(content, job);
  if (!command) return;
  const actor = command.match(
    /^ {6}\(github\.actor == '([\w-]+)'\) &&\r?$/m,
  )?.[1];
  const actorsJson = command.match(
    /^ {6}\(contains\(fromJSON\('(\[[^'\r\n]*\])'\), github\.actor\)\) &&\r?$/m,
  )?.[1];
  let actors = actor ? [actor] : undefined;
  if (actorsJson) {
    try {
      actors = JSON.parse(actorsJson);
    } catch {
      actors = undefined;
    }
  }
  return {
    actors:
      command.match(/\bgithub\.actor\b/g)?.length === 1 &&
      Array.isArray(actors) &&
      actors.length &&
      actors.every((value) => typeof value === "string")
        ? actors
        : undefined,
    runner: command.match(
      /^    runs-on: (ubuntu-latest|macos-latest)\r?$/m,
    )?.[1],
    model: command.match(
      /^          codex_model: ["']?([\w.-]+)["']?\r?$/m,
    )?.[1],
  };
}

/** Recover consistent settings across earlier command and review jobs. */
function installedSettings(content) {
  const command = jobSettings(content, "codex") ?? {};
  const review = jobSettings(content, "codex_review");
  if (!review) return command;
  return Object.fromEntries(
    Object.entries(command).filter(
      ([key, value]) => JSON.stringify(value) === JSON.stringify(review[key]),
    ),
  );
}

/** Read the publisher allowlist only when its input and event filter agree. */
function memoryActors(content) {
  const configured = content.match(
    /^ {10}trusted_actors: "([\w-]+(?:,[\w-]+)*)"\r?$/m,
  )?.[1];
  const filter = content.match(
    /^ {8}contains\(fromJSON\('(\[[^'\r\n]*\])'\), github\.event\.workflow_run\.actor\.login\)\) \|\|\r?$/m,
  )?.[1];
  const actors = configured?.split(",");
  if (actors && JSON.stringify(actors) === filter) return actors;
}

/** Preserve installed values unless the caller explicitly supplies an override. */
export async function selectInstallationSettings(existing, memory, options) {
  const publisherActors = memory ? memoryActors(memory) : undefined;
  const installed = existing
    ? installedSettings(existing)
    : {
        actors: memory ? publisherActors : [options.defaultActor],
        runner:
          options.runner ?? (await options.selectRunner?.()) ?? "ubuntu-latest",
        model: DEFAULT_MODEL,
      };
  if (
    existing &&
    memory &&
    JSON.stringify(installed.actors) !== JSON.stringify(publisherActors)
  ) {
    installed.actors = undefined;
  }
  const settings = {
    actors: options.actors ?? installed.actors,
    runner: options.runner ?? installed.runner,
    model: options.model ?? installed.model,
  };
  const missing = Object.entries({
    actors: "--actor",
    runner: "--runner",
    model: "--model",
  }).filter(([key]) => settings[key] === undefined);
  if (missing.length) {
    throw new Error(
      `Could not recover settings from the managed workflow. Specify ${missing.map(([, flag]) => flag).join(", ")} to replace them explicitly.`,
    );
  }
  return settings;
}
