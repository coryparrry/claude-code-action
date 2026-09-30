/** Validates the API key required by the Codex CLI runtime. */
export function validateEnvironmentVariables(): void {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required to run Codex");
  }
}
