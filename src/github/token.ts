#!/usr/bin/env bun
import * as core from "@actions/core";

export async function setupGitHubToken(): Promise<string> {
  const token = process.env.OVERRIDE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token?.trim()) {
    throw new Error(
      "A GitHub token is required. Pass github_token or provide GITHUB_TOKEN with repository write permissions.",
    );
  }
  core.setSecret(token);
  console.log("Using provided GitHub token for authentication");
  return token;
}
