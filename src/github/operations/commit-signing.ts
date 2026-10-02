import type { GitHubContext } from "../context";

/** SSH signing uses local git commits and takes precedence over API signing. */
export function usesApiCommitSigning(
  inputs: Pick<GitHubContext["inputs"], "useCommitSigning" | "sshSigningKey">,
): boolean {
  return inputs.useCommitSigning && !inputs.sshSigningKey;
}
