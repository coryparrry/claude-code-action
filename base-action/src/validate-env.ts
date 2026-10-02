import { validateOpenAIAuthentication } from "./openai-auth";
/** Validate native OpenAI provider authentication before preparing a prompt. */
export function validateEnvironmentVariables(): void {
  validateOpenAIAuthentication(process.env);
}
