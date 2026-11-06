import { randomBytes } from "node:crypto";
import {
  needsValidationMigration,
  selectInstallationSettings,
} from "./settings.mjs";
import {
  MANAGED_MARKER,
  WORKFLOW_PATH,
  MEMORY_WORKFLOW_PATH,
  VALIDATION_ACTION_DIR,
  renderMemoryWorkflow,
  renderWorkflow,
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

/** Reuse only matching installer PRs containing the two managed workflow paths. */
async function pendingInstallation(client, plan) {
  const { repository, defaultBranch, workflow, memoryWorkflow } = plan;
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
      comparison.files.length > 2 ||
      comparison.files.some(
        (file) =>
          ![WORKFLOW_PATH, MEMORY_WORKFLOW_PATH].includes(file.filename),
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
    if (
      pending.content !== workflow ||
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
async function setupBase(client, plan, existing) {
  const baseSha = await client.head(plan.repository, plan.defaultBranch);
  if (!/^[a-f0-9]{40}$/i.test(baseSha))
    throw new Error("GitHub did not return a valid default-branch commit.");
  const validationMigration = needsValidationMigration(existing, plan.workflow);
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

/** Plan both managed workflows without overwriting user-owned files. */
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
  assertManagedWorkflow(existing, WORKFLOW_PATH);
  assertManagedWorkflow(memoryExisting, MEMORY_WORKFLOW_PATH);
  const settings = await selectInstallationSettings(
    existing?.content,
    memoryExisting?.content,
    options,
  );
  const workflow = renderWorkflow({ repository, ...settings });
  const memoryWorkflow = renderMemoryWorkflow({
    repository,
    actors: settings.actors,
  });
  const installed = [
    { current: existing, content: workflow },
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
  const base = await setupBase(client, plan, existing?.content);
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

/** Remove only the draft and branch created by this attempt at their expected head. */
async function rollbackSetup(
  client,
  plan,
  branch,
  expectedHead,
  pullRequestUrl,
) {
  let current;
  try {
    current = await client.head(plan.repository, branch);
  } catch (error) {
    if (error.notFound) return;
    throw error;
  }
  if (current !== expectedHead)
    throw new Error("The setup branch changed during installation.");
  if (pullRequestUrl) await client.closePullRequest(pullRequestUrl);
  await client.deleteBranch(plan.repositoryId, branch, expectedHead);
}

/** Apply the reviewed workflow pair and existing API-key setup in each repository. */
export async function applyInstallation(
  client,
  plan,
  { apiKey, branchName } = {},
) {
  const branch =
    branchName ??
    `codex/install-github-action-${randomBytes(4).toString("hex")}`;
  if (!/^codex\/install-github-action-[A-Za-z0-9-]+$/.test(branch))
    throw new Error(
      "Use an installer branch with the codex/install-github-action- prefix.",
    );
  const writeSecret = await needsSecretWrite(client, plan);
  if (writeSecret) assertKey(apiKey);
  if (["configured", "pending"].includes(plan.status)) {
    if (writeSecret) await client.setSecret(plan.repository, apiKey);
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
    await client.createBranch(plan.repository, branch, plan.baseSha);
    branchHead = plan.baseSha;
    step = "writing the workflow";
    const workflow = await client.writeWorkflow(
      plan.repository,
      branch,
      plan.workflow,
      plan.workflowSha,
    );
    branchHead = workflow.commit.sha;
    step = "writing the memory maintenance workflow";
    const memory = await client.writeWorkflow(
      plan.repository,
      branch,
      plan.memoryWorkflow,
      plan.memoryWorkflowSha,
      MEMORY_WORKFLOW_PATH,
    );
    branchHead = memory.commit.sha;
    step = "opening the setup PR";
    pullRequestUrl = await client.createPullRequest(
      plan.repository,
      branch,
      plan.defaultBranch,
    );
    step = "uploading the repository secret";
    if (writeSecret && (await needsSecretWrite(client, plan)))
      await client.setSecret(plan.repository, apiKey);
    return { repository: plan.repository, status: "created", pullRequestUrl };
  } catch {
    const failure = `Installation stopped while ${step}.`;
    if (!branchHead) throw new Error(failure);
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
