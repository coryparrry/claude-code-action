/** Prefer a validated prepared commit when creating a replacement PR branch. */
export async function resolveBranchSourceSha(
  preparedSha: string | undefined,
  resolveBase: () => Promise<string>,
): Promise<string> {
  if (!preparedSha) return resolveBase();
  if (!/^[a-f0-9]{40}$/i.test(preparedSha))
    throw new Error("Invalid prepared branch source SHA");
  return preparedSha;
}
