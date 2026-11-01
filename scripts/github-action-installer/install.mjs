import { randomBytes } from "node:crypto";
import {
  MANAGED_MARKER,
  WORKFLOW_PATH,
  MEMORY_WORKFLOW_PATH,
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
  return { repository, defaultBranch };
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

/** Plan both managed workflows without overwriting user-owned files. */
export async function planInstallation(
  client,
  { repository, actors, runner, model, replaceSecret = false },
) {
  const resolved = await installationRepository(client, repository);
  repository = resolved.repository;
  const defaultBranch = resolved.defaultBranch;
  const workflow = renderWorkflow({ repository, actors, runner, model });
  const memoryWorkflow = renderMemoryWorkflow({ repository, actors });
  const existing = await client.workflow(repository, defaultBranch);
  const memoryExisting = await client.workflow(
    repository,
    defaultBranch,
    MEMORY_WORKFLOW_PATH,
  );
  const installed = [
    { path: WORKFLOW_PATH, current: existing, content: workflow },
    {
      path: MEMORY_WORKFLOW_PATH,
      current: memoryExisting,
      content: memoryWorkflow,
    },
  ];
  for (const { path, current } of installed) {
    if (current && !current.content.startsWith(MANAGED_MARKER))
      throw new Error(
        `An existing ${path} is not managed by this installer. It will not be overwritten.`,
      );
  }
  await client.verifyActionRevision();
  const secrets = await client.secrets(repository);
  const needsSecret =
    replaceSecret ||
    !secrets.some((secret) => secret.name === "OPENAI_API_KEY");
  const plan = {
    repository,
    defaultBranch,
    actors,
    runner,
    model,
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
  if (pending) return pending;
  const baseSha = await client.head(repository, defaultBranch);
  if (!/^[a-f0-9]{40}$/i.test(baseSha))
    throw new Error("GitHub did not return a valid default-branch commit.");
  return { ...plan, baseSha };
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
  if (plan.needsSecret) {
    // The review/key prompts may stay open while another admin configures a key.
    const existing =
      !plan.replaceSecret &&
      (await client.secrets(plan.repository)).some(
        (secret) => secret.name === "OPENAI_API_KEY",
      );
    if (!existing) {
      if (typeof apiKey !== "string" || !apiKey.trim())
        throw new Error("An OpenAI API key is required for this repository.");
      await client.setSecret(plan.repository, apiKey);
    }
  }
  if (["configured", "pending"].includes(plan.status))
    return {
      repository: plan.repository,
      status: plan.status,
      pullRequestUrl: plan.pullRequestUrl,
    };

  let step = "creating the setup branch";
  try {
    await client.createBranch(plan.repository, branch, plan.baseSha);
    step = "writing the workflow";
    await client.writeWorkflow(
      plan.repository,
      branch,
      plan.workflow,
      plan.workflowSha,
    );
    step = "writing the memory maintenance workflow";
    await client.writeWorkflow(
      plan.repository,
      branch,
      plan.memoryWorkflow,
      plan.memoryWorkflowSha,
      MEMORY_WORKFLOW_PATH,
    );
    step = "opening the setup PR";
    const pullRequestUrl = await client.createPullRequest(
      plan.repository,
      branch,
      plan.defaultBranch,
    );
    return { repository: plan.repository, status: "created", pullRequestUrl };
  } catch {
    throw new Error(
      `Installation stopped while ${step}. Check branch ${branch} in ${plan.repository}; rerunning reuses matching open setup PRs and existing secrets.`,
    );
  }
}
