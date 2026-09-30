import * as core from "@actions/core";
import { isWorkflowRunEvent, type GitHubContext } from "../context";
import type { Octokit } from "@octokit/rest";

/**
 * Collect the actors whose repository access should be checked. This is
 * normally just the workflow actor (GITHUB_ACTOR). For workflow_run events
 * the actor that started the upstream run is checked as well when it
 * differs, since that is the account the run originates from.
 */
function getActorsToCheck(context: GitHubContext): string[] {
  const actors = [context.actor];

  if (isWorkflowRunEvent(context)) {
    const runActor = context.payload.workflow_run?.actor?.login;
    if (runActor && !actors.includes(runActor)) {
      core.info(
        `workflow_run was started by ${runActor}; checking permissions for that actor as well`,
      );
      actors.push(runActor);
    }
  }

  return actors;
}

/**
 * Check if the actor has write permissions to the repository
 * @param octokit - The Octokit REST client
 * @param context - The GitHub context
 * @returns true if the actor has write permissions, false otherwise
 */
export async function checkWritePermissions(
  octokit: Octokit,
  context: GitHubContext,
): Promise<boolean> {
  for (const actor of getActorsToCheck(context)) {
    const allowed = await checkActorWritePermissions(octokit, context, actor);
    if (!allowed) return false;
  }
  return true;
}

async function checkActorWritePermissions(
  octokit: Octokit,
  context: GitHubContext,
  actor: string,
): Promise<boolean> {
  const { repository } = context;

  try {
    core.info(`Checking permissions for actor: ${actor}`);

    const response = await octokit.repos.getCollaboratorPermissionLevel({
      owner: repository.owner,
      repo: repository.repo,
      username: actor,
    });

    const permissionLevel = response.data.permission;
    core.info(`Permission level retrieved: ${permissionLevel}`);

    if (permissionLevel === "admin" || permissionLevel === "write") {
      core.info(`Actor has write access: ${permissionLevel}`);
      return true;
    } else {
      core.warning(`Actor has insufficient permissions: ${permissionLevel}`);
      return false;
    }
  } catch (error) {
    core.error(`Failed to check permissions: ${error}`);
    throw new Error(`Failed to check permissions for ${actor}: ${error}`);
  }
}
