import * as core from "@actions/core";
import { revokeGitHubAppToken } from "../github/token";

if (
  process.env.GITHUB_APP_TOKEN_CREATED === "true" &&
  process.env.MINTED_GITHUB_APP_TOKEN
) {
  core.setSecret(process.env.MINTED_GITHUB_APP_TOKEN);
  await revokeGitHubAppToken(process.env.MINTED_GITHUB_APP_TOKEN);
}
