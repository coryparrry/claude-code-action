export function validateCodexInputs(): void {
  if (process.env.ACTION_ENGINE && process.env.ACTION_ENGINE !== "codex") {
    throw new Error(
      "This action supports Codex only; remove the engine setting",
    );
  }
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("Codex requires openai_api_key or OPENAI_API_KEY");
  }
}
