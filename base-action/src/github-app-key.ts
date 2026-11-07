/** Accept GitHub App PEM credentials stored with literal escaped newlines. */
export function normalizeGitHubAppPrivateKey(key: string): string {
  return key.replace(/\\n/g, "\n");
}
