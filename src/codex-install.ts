import { validateOpenAIAuthentication } from "../base-action/src/openai-auth";

export function validateCodexInputs(): void {
  if (process.env.ACTION_ENGINE && process.env.ACTION_ENGINE !== "codex") {
    throw new Error(
      "This action supports Codex only; remove the engine setting",
    );
  }
  validateOpenAIAuthentication(process.env);
}
