import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import * as core from "@actions/core";
import { revokeGitHubAppToken, setupGitHubToken } from "../src/github/token";

const ENV_KEYS = [
  "GITHUB_TOKEN",
  "OVERRIDE_GITHUB_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_REPOSITORY",
  "GITHUB_API_URL",
  "ADDITIONAL_PERMISSIONS",
];
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("GitHub token authentication", () => {
  let originalEnv: Record<string, string | undefined>;
  let secretSpy: ReturnType<typeof spyOn>;
  let oidcSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    for (const key of ENV_KEYS) delete process.env[key];
    secretSpy = spyOn(core, "setSecret").mockImplementation(() => {});
    oidcSpy = spyOn(core, "getIDToken").mockRejectedValue(
      new Error("OIDC must not be called"),
    );
    fetchSpy = spyOn(global, "fetch").mockRejectedValue(
      new Error("No external token exchange"),
    );
  });

  afterEach(async () => {
    await revokeGitHubAppToken();
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    expect(oidcSpy).not.toHaveBeenCalled();
    secretSpy.mockRestore();
    oidcSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  test("uses the workflow token and masks it without network access", async () => {
    process.env.GITHUB_TOKEN = "workflow-token";
    expect(await setupGitHubToken()).toBe("workflow-token");
    expect(secretSpy).toHaveBeenCalledWith("workflow-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("prefers the explicitly supplied GitHub token", async () => {
    process.env.GITHUB_TOKEN = "workflow-token";
    process.env.OVERRIDE_GITHUB_TOKEN = "custom-token";
    expect(await setupGitHubToken()).toBe("custom-token");
    expect(secretSpy).toHaveBeenCalledWith("custom-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  for (const value of [undefined, "", "   "]) {
    test(`rejects a missing or blank GitHub token (${JSON.stringify(value)})`, async () => {
      if (value !== undefined) process.env.GITHUB_TOKEN = value;
      await expect(setupGitHubToken()).rejects.toThrow(
        "A GitHub token is required",
      );
      expect(secretSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  test("rejects additional permissions when only a supplied token is available", async () => {
    process.env.GITHUB_TOKEN = "workflow-token";
    process.env.ADDITIONAL_PERMISSIONS = "actions: read";
    await expect(setupGitHubToken()).rejects.toThrow(
      "additional_permissions requires GitHub App credentials",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(secretSpy).not.toHaveBeenCalled();
  });

  test("requires both App ID and private key instead of silently falling back", async () => {
    process.env.GITHUB_TOKEN = "workflow-token";
    process.env.GITHUB_APP_ID = "12345";
    await expect(setupGitHubToken()).rejects.toThrow(
      "requires both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects simultaneous explicit token and App credentials", async () => {
    process.env.OVERRIDE_GITHUB_TOKEN = "custom-token";
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    await expect(setupGitHubToken()).rejects.toThrow(
      "Choose GitHub App credentials or github_token",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(secretSpy).not.toHaveBeenCalled();
  });

  test("mints a repository-scoped App token with requested permissions and a valid JWT", async () => {
    process.env.GITHUB_TOKEN = "runner-default-token";
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    process.env.GITHUB_REPOSITORY = "octo/demo";
    process.env.GITHUB_API_URL = "https://api.example.test/";
    process.env.ADDITIONAL_PERMISSIONS = "actions: read\nworkflows: write";
    const requests: { url: string; init?: RequestInit }[] = [];
    fetchSpy.mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/repos/octo/demo/installation")) {
        return new Response(JSON.stringify({ id: 991 }), { status: 200 });
      }
      return new Response(JSON.stringify({ token: "ghs-installation-token" }), {
        status: 201,
      });
    });

    const token = await setupGitHubToken();
    expect(token).toBe("ghs-installation-token");
    expect(requests).toHaveLength(2);
    const installationRequest = requests[0]!;
    expect(installationRequest.url).toBe(
      "https://api.example.test/repos/octo/demo/installation",
    );
    const jwt = (installationRequest.init?.headers as Record<string, string>)[
      "Authorization"
    ]!.replace("Bearer ", "");
    const [header, payload, signature] = jwt.split(".") as [
      string,
      string,
      string,
    ];
    expect(
      JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
    ).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    expect(claims.iss).toBe("12345");
    expect(claims.exp - claims.iat).toBe(10 * 60);
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);

    const tokenRequest = requests[1]!;
    expect(tokenRequest.url).toBe(
      "https://api.example.test/app/installations/991/access_tokens",
    );
    expect(tokenRequest.init?.method).toBe("POST");
    expect(
      (tokenRequest.init?.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${jwt}`);
    expect(JSON.parse(String(tokenRequest.init?.body))).toEqual({
      repositories: ["demo"],
      permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        actions: "read",
        workflows: "write",
      },
    });
    expect(secretSpy).toHaveBeenCalledWith(privateKey);
    expect(secretSpy).toHaveBeenCalledWith(jwt);
    expect(secretSpy).toHaveBeenCalledWith("ghs-installation-token");
  });

  test("uses an explicit installation ID without resolving a repository installation", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    process.env.GITHUB_APP_INSTALLATION_ID = "991";
    process.env.GITHUB_REPOSITORY = "octo/demo";
    const requests: { url: string; init?: RequestInit }[] = [];
    fetchSpy.mockImplementation(async (input: any, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ token: "ghs-scoped-token" }), {
        status: 201,
      });
    });

    expect(await setupGitHubToken()).toBe("ghs-scoped-token");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      "https://api.github.com/app/installations/991/access_tokens",
    );
    expect(JSON.parse(String(requests[0]!.init?.body)).repositories).toEqual([
      "demo",
    ]);
  });

  test("rejects malformed repository scope and invalid App credentials without network access", async () => {
    process.env.GITHUB_APP_ID = "not-an-id";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    process.env.GITHUB_REPOSITORY = "octo/demo";
    await expect(setupGitHubToken()).rejects.toThrow(
      "GITHUB_APP_ID must contain only digits",
    );
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_REPOSITORY = "octo/demo/extra";
    await expect(setupGitHubToken()).rejects.toThrow("GITHUB_REPOSITORY");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("does not expose API error bodies or key material", async () => {
    const privateKeyValue = privateKey;
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKeyValue;
    process.env.GITHUB_REPOSITORY = "octo/demo";
    fetchSpy.mockResolvedValue(
      new Response(`secret response ${privateKeyValue}`, { status: 403 }),
    );
    let errorMessage = "";
    try {
      await setupGitHubToken();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(errorMessage).toContain("HTTP 403");
    expect(errorMessage).not.toContain("secret response");
    expect(errorMessage).not.toContain(privateKeyValue);
  });

  test("revokes only the installation token minted by this run", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
    process.env.GITHUB_APP_INSTALLATION_ID = "991";
    process.env.GITHUB_REPOSITORY = "octo/demo";
    const requests: { url: string; init?: RequestInit }[] = [];
    fetchSpy.mockImplementation(async (input: any, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ token: "ghs-revoke-me" }), {
        status: 201,
      });
    });

    await setupGitHubToken();
    await revokeGitHubAppToken();
    await revokeGitHubAppToken();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe("https://api.github.com/installation/token");
    expect(requests[1]!.init?.method).toBe("DELETE");
    expect(
      (requests[1]!.init?.headers as Record<string, string>).Authorization,
    ).toBe("Bearer ghs-revoke-me");
  });

  test("does not revoke tokens supplied by the workflow", async () => {
    process.env.GITHUB_TOKEN = "workflow-token";
    await setupGitHubToken();
    await revokeGitHubAppToken();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
