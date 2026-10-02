#!/usr/bin/env bun
import { createPrivateKey, sign as signBytes } from "node:crypto";
import * as core from "@actions/core";

const DEFAULT_PERMISSIONS: Record<string, string> = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
};

interface MintedAppToken {
  token: string;
  apiUrl: string;
}

let mintedAppToken: MintedAppToken | undefined;

function appCredentials() {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();
  const anyPresent = !!appId || !!privateKey?.trim() || !!installationId;
  if (!anyPresent) return undefined;
  if (!appId || !privateKey?.trim()) {
    throw new Error(
      "GitHub App authentication requires both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.",
    );
  }
  if (!/^\d+$/.test(appId)) {
    throw new Error("GITHUB_APP_ID must contain only digits.");
  }
  if (installationId && !/^\d+$/.test(installationId)) {
    throw new Error("GITHUB_APP_INSTALLATION_ID must contain only digits.");
  }
  return { appId, privateKey, installationId };
}

function createAppJwt(appId: string, privateKey: string): string {
  const normalizedKey = privateKey.replace(/\\n/g, "\n");
  core.setSecret(privateKey);
  if (normalizedKey !== privateKey) core.setSecret(normalizedKey);
  try {
    const key = createPrivateKey(normalizedKey);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iss: appId, iat: now - 60, exp: now + 9 * 60 }),
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = signBytes(
      "RSA-SHA256",
      Buffer.from(signingInput),
      key,
    ).toString("base64url");
    const jwt = `${signingInput}.${signature}`;
    core.setSecret(jwt);
    return jwt;
  } catch {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is invalid or cannot sign GitHub App tokens.",
    );
  }
}

function currentRepository(): { owner: string; repo: string } {
  const value = process.env.GITHUB_REPOSITORY ?? "";
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match) {
    throw new Error(
      "GITHUB_REPOSITORY must identify the owner and repository for GitHub App authentication.",
    );
  }
  return { owner: match[1]!, repo: match[2]! };
}

async function appRequest(
  apiUrl: string,
  endpoint: string,
  jwt: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${endpoint}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error(
      "GitHub App authentication could not reach the GitHub API.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `GitHub App authentication failed with HTTP ${response.status}. Check the app installation and requested permissions.`,
    );
  }
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error(
      "GitHub returned an invalid GitHub App authentication response.",
    );
  }
}

async function setupGitHubAppToken(
  credentials: NonNullable<ReturnType<typeof appCredentials>>,
): Promise<string> {
  const { owner, repo } = currentRepository();
  const apiUrl = (
    process.env.GITHUB_API_URL || "https://api.github.com"
  ).replace(/\/+$/, "");
  const jwt = createAppJwt(credentials.appId, credentials.privateKey);
  let installationId = credentials.installationId;
  if (!installationId) {
    const installation = await appRequest(
      apiUrl,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      jwt,
    );
    if (
      typeof installation.id !== "number" &&
      typeof installation.id !== "string"
    ) {
      throw new Error(
        "GitHub App is not installed for the current repository.",
      );
    }
    installationId = String(installation.id);
  }

  const permissions = parseAdditionalPermissions() ?? DEFAULT_PERMISSIONS;
  const tokenResponse = await appRequest(
    apiUrl,
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    jwt,
    { repositories: [repo], permissions },
  );
  if (typeof tokenResponse.token !== "string" || !tokenResponse.token.trim()) {
    throw new Error("GitHub did not return an installation access token.");
  }
  const token = tokenResponse.token;
  core.setSecret(token);
  mintedAppToken = { token, apiUrl };
  return token;
}

/** Return a token and track only GitHub App tokens minted during this run. */
export async function setupGitHubToken(): Promise<string> {
  const app = appCredentials();
  const overrideToken = process.env.OVERRIDE_GITHUB_TOKEN;
  if (app && overrideToken?.trim()) {
    throw new Error(
      "Choose GitHub App credentials or github_token; both were provided explicitly.",
    );
  }
  if (app) return setupGitHubAppToken(app);

  const token = overrideToken || process.env.GITHUB_TOKEN;
  if (!token?.trim()) {
    throw new Error(
      "A GitHub token is required. Pass github_token or provide GITHUB_TOKEN with repository write permissions.",
    );
  }
  if (process.env.ADDITIONAL_PERMISSIONS?.trim()) {
    throw new Error(
      "additional_permissions requires GitHub App credentials; supplied GitHub tokens cannot be expanded.",
    );
  }
  core.setSecret(token);
  console.log("Using provided GitHub token for authentication");
  return token;
}

/** Revoke the installation token minted by this run. Supplied tokens are untouched. */
export function hasMintedGitHubAppToken(): boolean {
  return mintedAppToken !== undefined;
}

export async function revokeGitHubAppToken(token?: string): Promise<void> {
  const current = token
    ? {
        token,
        apiUrl: (
          process.env.GITHUB_API_URL || "https://api.github.com"
        ).replace(/\/+$/, ""),
      }
    : mintedAppToken;
  mintedAppToken = undefined;
  if (!current) return;
  try {
    await fetch(`${current.apiUrl}/installation/token`, {
      method: "DELETE",
      redirect: "manual",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${current.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Cleanup must not mask the action's primary result or failure.
  }
}

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
