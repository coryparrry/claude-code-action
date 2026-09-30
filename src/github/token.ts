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

const DEFAULT_PERMISSIONS: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
};

export function parseAdditionalPermissions():
  | Record<string, string>
  | undefined {
  const raw = process.env.ADDITIONAL_PERMISSIONS;
  if (!raw || !raw.trim()) {
    return undefined;
  }

  const additional: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (key && value) {
      additional[key] = value;
    }
  }

  if (Object.keys(additional).length === 0) {
    return undefined;
  }

  return { ...DEFAULT_PERMISSIONS, ...additional };
}
