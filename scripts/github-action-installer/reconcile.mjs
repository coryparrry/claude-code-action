import { setTimeout as delay } from "node:timers/promises";
import { SETUP_TITLE, setupCommitMessage } from "./workflow.mjs";

/** Report an uncertain write without exposing GitHub diagnostics or request input. */
function unconfirmedWrite() {
  return Object.assign(new Error("GitHub write could not be confirmed."), {
    unconfirmed: true,
  });
}

/** Read back a mutation that GitHub might have applied before the response failed. */
async function confirmedWrite(write, read) {
  try {
    return await write();
  } catch (error) {
    if (!error.uncertain) throw error;
    let result;
    try {
      result = await read();
      if (result === undefined) {
        await delay(500);
        result = await read();
      }
    } catch {
      throw unconfirmedWrite();
    }
    if (result === undefined) throw error;
    return result;
  }
}

/** Distinguish a missing setup ref from an unavailable ref lookup. */
async function setupHead(client, repository, branch) {
  try {
    return await client.head(repository, branch);
  } catch (error) {
    if (error.notFound) return undefined;
    throw error;
  }
}

/** Require a usable mutation receipt before advancing the setup state. */
function receipt(value) {
  if (value) return value;
  throw Object.assign(
    new Error("GitHub returned an incomplete write receipt."),
    {
      uncertain: true,
    },
  );
}

/** Create the unique setup ref, or confirm it points to the chosen base. */
export async function createSetupBranch(client, plan, branch) {
  const { repository, baseSha } = plan;
  if (await setupHead(client, repository, branch))
    throw new Error("The setup branch already exists.");
  return confirmedWrite(
    async () => {
      await client.createBranch(repository, branch, baseSha);
      return baseSha;
    },
    async () =>
      (await setupHead(client, repository, branch)) === baseSha
        ? baseSha
        : undefined,
  );
}

/** Accept a lost workflow receipt only for the same content and setup commit. */
async function workflowHead(
  client,
  repository,
  branch,
  previousHead,
  path,
  content,
) {
  const head = await setupHead(client, repository, branch);
  if (
    !head ||
    (await client.workflow(repository, head, path))?.content !== content
  )
    return undefined;
  if (head === previousHead) return head;
  const commit = await client.commit(repository, head);
  if (
    commit.parents?.length === 1 &&
    commit.parents[0].sha === previousHead &&
    commit.commit?.message === setupCommitMessage(branch, path) &&
    (commit.files?.length === 0 ||
      (commit.files?.length === 1 && commit.files[0].filename === path))
  )
    return head;
  return undefined;
}

/** Write one managed file and return the commit to use for setup and rollback. */
export function writeSetupWorkflow(
  client,
  repository,
  branch,
  previousHead,
  { path, content, sha },
) {
  return confirmedWrite(
    async () => {
      const result = await client.writeWorkflow(
        repository,
        branch,
        content,
        sha,
        path,
      );
      const commit = result?.commit;
      const head = receipt(/^[a-f0-9]{40}$/i.test(commit?.sha) && commit.sha);
      const parents = receipt(Array.isArray(commit.parents) && commit.parents);
      if (parents.length !== 1 || parents[0].sha !== previousHead)
        throw new Error("The setup branch changed during installation.");
      return head;
    },
    () => workflowHead(client, repository, branch, previousHead, path, content),
  );
}

/** Accept only a draft on the planned refs and exact setup commit. */
function setupDraftUrl(pull, plan, branch, head) {
  receipt(pull?.html_url);
  if (
    pull.title !== SETUP_TITLE ||
    pull.draft !== true ||
    pull.head?.repo?.full_name !== plan.repository ||
    pull.head.ref !== branch ||
    pull.head.sha !== head ||
    pull.base?.ref !== plan.defaultBranch
  )
    throw unconfirmedWrite();
  return pull.html_url;
}

/** Open a draft at the reviewed commit and reconcile a lost response. */
export function createSetupPullRequest(client, plan, branch, head) {
  const { repository, defaultBranch } = plan;
  return confirmedWrite(
    async () =>
      setupDraftUrl(
        await client.createPullRequest(repository, branch, defaultBranch),
        plan,
        branch,
        head,
      ),
    async () => {
      const pull = await client.setupPullRequest(
        repository,
        defaultBranch,
        branch,
      );
      return pull ? setupDraftUrl(pull, plan, branch, head) : undefined;
    },
  );
}

/** Find the credential's metadata without requesting its value. */
async function openAISecret(client, repository) {
  return (await client.secrets(repository)).find(
    ({ name }) => name === "OPENAI_API_KEY",
  );
}

/** Reuse existing credentials and read back first-time uploads after a lost response. */
export async function uploadSetupSecret(client, plan, apiKey) {
  const { repository, replaceSecret } = plan;
  const before = await openAISecret(client, repository);
  if (before && !replaceSecret) return;
  try {
    await confirmedWrite(
      async () => {
        await client.setSecret(repository, apiKey);
        return true;
      },
      async () => {
        if (before) throw unconfirmedWrite();
        return (await openAISecret(client, repository)) ? true : undefined;
      },
    );
  } catch (error) {
    // An upload may still complete after a timeout. Keep the draft available to resume.
    if (error.uncertain) throw unconfirmedWrite();
    throw error;
  }
}

/** Close only the recorded setup draft, and check that exact PR after a lost response. */
async function closeSetupPullRequest(client, plan, url, branch, expectedHead) {
  const pull = await client.pullRequest(url);
  if (pull.state === "CLOSED") return;
  if (
    pull.state !== "OPEN" ||
    !pull.isDraft ||
    pull.isCrossRepository !== false ||
    pull.headRefName !== branch ||
    pull.headRefOid !== expectedHead ||
    pull.baseRefName !== plan.defaultBranch
  )
    throw new Error("The setup PR changed during installation.");
  await confirmedWrite(
    async () => {
      await client.closePullRequest(url);
      return true;
    },
    async () =>
      (await client.pullRequest(url)).state === "CLOSED" ? true : undefined,
  );
}

/** Close the attempt's draft and remove its ref only at the expected commit. */
export async function rollbackSetup(
  client,
  plan,
  branch,
  expectedHead,
  pullRequestUrl,
) {
  const { repository, repositoryId } = plan;
  const current = await setupHead(client, repository, branch);
  if (current && current !== expectedHead)
    throw new Error("The setup branch changed during installation.");
  if (pullRequestUrl)
    await closeSetupPullRequest(
      client,
      plan,
      pullRequestUrl,
      branch,
      expectedHead,
    );
  if (current) {
    await confirmedWrite(
      async () => {
        await client.deleteBranch(repositoryId, branch, expectedHead);
        return true;
      },
      async () =>
        (await setupHead(client, repository, branch)) === undefined
          ? true
          : undefined,
    );
  }
}
