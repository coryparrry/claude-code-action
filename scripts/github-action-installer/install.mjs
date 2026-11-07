import { randomBytes } from "node:crypto";
import {
  createSetupBranch,
  createSetupPullRequest,
  rollbackSetup,
  uploadSetupSecret,
  writeSetupWorkflow,
} from "./reconcile.mjs";
import {
  assertNoRemovedChecks,
  needsValidationMigration,
  selectInstallationSettings,
} from "./settings.mjs";
import {
  MANAGED_MARKER,
  WORKFLOW_PATH,
  COMMAND_WORKFLOW_PATH,
  MEMORY_WORKFLOW_PATH,
  VALIDATION_ACTION_DIR,
  renderMemoryWorkflow,
  renderWorkflow,
  renderReviewWorkflow,
  renderCommandWorkflow,
  validateRepository,
} from "./workflow.mjs";

/** Validate and resolve canonical repository identity before rendering bound workflows. */
async function installationRepository(client, repository) {
  validateRepository(repository);
  const metadata = await client.repository(repository);
  repository = validateRepository(metadata.nameWithOwner ?? repository);
  if (metadata.isArchived)
    throw new Error("Archived repositories cannot be configured.");
  if (!["ADMIN", "MAINTAIN", "WRITE"].includes(metadata.viewerPermission))
    throw new Error("Repository write access is required for installation.");
  const defaultBranch = metadata.defaultBranchRef?.name;
  if (!defaultBranch)
    throw new Error(
      "Create the repository's default branch before installing.",
    );
  return { repository, defaultBranch, repositoryId: metadata.id };
}

/** Reuse only matching installer PRs containing the three managed workflow paths. */
async function pendingInstallation(client, plan) {
  const {
    repository,
    defaultBranch,
    memoryWorkflow,
    commandWorkflow,
    reviewWorkflow,
  } = plan;
  for (const pull of await client.pullRequests(repository, defaultBranch)) {
    if (pull.isCrossRepository !== false) continue;
    if (!pull.headRefName.startsWith("codex/install-github-action-")) continue;
    const pending = await client.workflow(repository, pull.headRefName);
    if (!pending?.content.startsWith(MANAGED_MARKER)) continue;
    const comparison = await client.compare(
      repository,
      defaultBranch,
      pull.headRefName,
    );
    if (
      !comparison.files?.length ||
      comparison.files.length > 3 ||
      comparison.files.some(
        (file) =>
          ![
            WORKFLOW_PATH,
            MEMORY_WORKFLOW_PATH,
            COMMAND_WORKFLOW_PATH,
          ].includes(file.filename),
      )
    )
      throw new Error(
        "A pending installer PR contains other changes. Review it before installing again.",
      );
    const pendingMemory = await client.workflow(
      repository,
      pull.headRefName,
      MEMORY_WORKFLOW_PATH,
    );
    const pendingCommand = await client.workflow(
      repository,
      pull.headRefName,
      COMMAND_WORKFLOW_PATH,
    );
    if (
      pendingCommand?.content !== commandWorkflow ||
      pending.content !== reviewWorkflow ||
      pendingMemory?.content !== memoryWorkflow
    )
      throw new Error(
        "An installer PR with different settings is already open. Merge or close it before changing settings.",
      );
    return { ...plan, status: "pending", pullRequestUrl: pull.url };
  }
  return undefined;
}

/** Require the installer marker before replacing an existing workflow. */
function assertManagedWorkflow(current, path) {
  if (current && !current.content.startsWith(MANAGED_MARKER))
    throw new Error(
      `An existing ${path} is not managed by this installer. It will not be overwritten.`,
    );
}

/** Bind an update to a base that contains any required validation migration. */
async function setupBase(client, plan, existing, commands) {
  const baseSha = await client.head(plan.repository, plan.defaultBranch);
  if (!/^[a-f0-9]{40}$/i.test(baseSha))
    throw new Error("GitHub did not return a valid default-branch commit.");
  const validationMigration =
    needsValidationMigration(existing, plan.fullWorkflow) ||
    needsValidationMigration(commands, plan.commandWorkflow);
  if (
    validationMigration &&
    !(await client.hasValidationRecipe(plan.repository, baseSha))
  ) {
    throw new Error(
      `This upgrade would replace existing inline validation. Move its checks to ${VALIDATION_ACTION_DIR}/action.yml on ${plan.defaultBranch}, then rerun the installer.`,
    );
  }
  return { baseSha, validationMigration };
}

/** Plan the managed workflows without overwriting user-owned files. */
export async function planInstallation(client, options) {
  const { repository, defaultBranch, repositoryId } =
    await installationRepository(client, options.repository);
  const { replaceSecret = false } = options;
  const existing = await client.workflow(repository, defaultBranch);
  const memoryExisting = await client.workflow(
    repository,
    defaultBranch,
    MEMORY_WORKFLOW_PATH,
  );
  const commandExisting = await client.workflow(
    repository,
    defaultBranch,
    COMMAND_WORKFLOW_PATH,
  );
  assertManagedWorkflow(commandExisting, COMMAND_WORKFLOW_PATH);
  assertManagedWorkflow(existing, WORKFLOW_PATH);
  assertManagedWorkflow(memoryExisting, MEMORY_WORKFLOW_PATH);
  const existingContent = existing?.content;
  const memoryContent = memoryExisting?.content;
  const settings = await selectInstallationSettings(
    existingContent,
    memoryContent,
    options,
    commandExisting?.content,
  );
  const fullWorkflow = renderWorkflow({ repository, ...settings });
  const workflow = fullWorkflow;
  const reviewWorkflow = renderReviewWorkflow({ repository, ...settings });
  const commandWorkflow = renderCommandWorkflow({ repository, ...settings });
  const memoryWorkflow = renderMemoryWorkflow({
    repository,
    actors: settings.actors,
  });
  assertNoRemovedChecks(existingContent, fullWorkflow, WORKFLOW_PATH);
  assertNoRemovedChecks(
    commandExisting?.content,
    commandWorkflow,
    COMMAND_WORKFLOW_PATH,
  );
  assertNoRemovedChecks(memoryContent, memoryWorkflow, MEMORY_WORKFLOW_PATH);
  const installed = [
    { current: existing, content: reviewWorkflow },
    { current: commandExisting, content: commandWorkflow },
    { current: memoryExisting, content: memoryWorkflow },
  ];
  await client.verifyActionRevision();
  const secrets = await client.secrets(repository);
  const needsSecret =
    replaceSecret ||
    !secrets.some((secret) => secret.name === "OPENAI_API_KEY");
  const plan = {
    repository,
    defaultBranch,
    repositoryId,
    ...settings,
    workflow,
    fullWorkflow,
    reviewWorkflow,
    commandWorkflow,
    commandWorkflowSha: commandExisting?.sha,
    workflowSha: existing?.sha,
    memoryWorkflow,
    memoryWorkflowSha: memoryExisting?.sha,
    needsSecret,
    replaceSecret,
    status: installed.every(
      ({ current, content }) => current?.content === content,
    )
      ? "configured"
      : installed.some(({ current }) => current)
        ? "update"
        : "new",
  };
  if (plan.status === "configured") return plan;

  const pending = await pendingInstallation(client, plan);
  const base = await setupBase(
    client,
    plan,
    existingContent,
    commandExisting?.content,
  );
  return { ...(pending ?? plan), ...base };
}

/** Reuse a secret another installer or admin configured during setup. */
async function needsSecretWrite(client, plan) {
  return (
    plan.needsSecret &&
    (plan.replaceSecret ||
      !(await client.secrets(plan.repository)).some(
        (secret) => secret.name === "OPENAI_API_KEY",
      ))
  );
}

/** Validate key availability before creating any setup state. */
function assertKey(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new Error("An OpenAI API key is required for this repository.");
}

/** Apply the reviewed workflow set and existing API-key setup in each repository. */
export async function applyInstallation(
  client,
  plan,
  { apiKey, branchName } = {},
) {
  const branch =
    branchName ??
    `codex/install-github-action-${randomBytes(16).toString("hex")}`;
  if (!/^codex\/install-github-action-[A-Za-z0-9-]+$/.test(branch))
    throw new Error(
      "Use an installer branch with the codex/install-github-action- prefix.",
    );
  const writeSecret = await needsSecretWrite(client, plan);
  if (writeSecret) assertKey(apiKey);
  if (["configured", "pending"].includes(plan.status)) {
    if (writeSecret) await uploadSetupSecret(client, plan, apiKey);
    return {
      repository: plan.repository,
      status: plan.status,
      pullRequestUrl: plan.pullRequestUrl,
    };
  }

  let step = "creating the setup branch";
  let branchHead;
  let pullRequestUrl;
  try {
    branchHead = await createSetupBranch(client, plan, branch);
    step = "writing the command workflow";
    branchHead = await writeSetupWorkflow(
      client,
      plan.repository,
      branch,
      branchHead,
      {
        path: COMMAND_WORKFLOW_PATH,
        content: plan.commandWorkflow,
        sha: plan.commandWorkflowSha,
      },
    );
    step = "writing the workflow";
    branchHead = await writeSetupWorkflow(
      client,
      plan.repository,
      branch,
      branchHead,
      {
        path: WORKFLOW_PATH,
        content: plan.reviewWorkflow,
        sha: plan.workflowSha,
      },
    );
    step = "writing the memory maintenance workflow";
    branchHead = await writeSetupWorkflow(
      client,
      plan.repository,
      branch,
      branchHead,
      {
        path: MEMORY_WORKFLOW_PATH,
        content: plan.memoryWorkflow,
        sha: plan.memoryWorkflowSha,
      },
    );
    step = "opening the setup PR";
    pullRequestUrl = await createSetupPullRequest(
      client,
      plan,
      branch,
      branchHead,
    );
    step = "uploading the repository secret";
    if (writeSecret) await uploadSetupSecret(client, plan, apiKey);
    return { repository: plan.repository, status: "created", pullRequestUrl };
  } catch (error) {
    const failure = `Installation stopped while ${step}.`;
    if (error.unconfirmed)
      throw new Error(
        `${failure} GitHub could not confirm the write. Check branch ${branch} in ${plan.repository} and retry after GitHub is reachable.`,
      );
    if (!branchHead)
      throw new Error(
        `${failure} Check whether ${branch} already exists and try again.`,
      );
    try {
      await rollbackSetup(client, plan, branch, branchHead, pullRequestUrl);
    } catch {
      throw new Error(
        `${failure} Cleanup could not be confirmed. Check branch ${branch} in ${plan.repository}.`,
      );
    }
    throw new Error(`${failure} The setup branch was removed.`);
  }
}
