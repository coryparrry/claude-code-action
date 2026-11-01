import { retryWithBackoff } from "../../utils/retry";

/** Retry transient GitHub reads without retrying authorization or missing-object failures. */
export function retryGitHubRead<T>(operation: () => Promise<T>): Promise<T> {
  return retryWithBackoff(operation, {
    initialDelayMs: 250,
    maxDelayMs: 1000,
    shouldRetry: (error) => {
      const status = (error as Error & { status?: number }).status;
      return status === undefined || status === 429 || status >= 500;
    },
  });
}
