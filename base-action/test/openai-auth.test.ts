import { afterEach, describe, expect, test } from "bun:test";
import { AzureOpenAI, OpenAI } from "openai";
import {
  createOpenAIAuthentication,
  validateOpenAIAuthentication,
} from "../src/openai-auth";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function captureClientCredential(client: OpenAI): Promise<string | null> {
  let credential: string | null = null;
  return client
    ._callApiKey((value) => {
      credential = value;
    })
    .then(() => credential);
}

describe("OpenAI provider authentication", () => {
  test("uses and registers a standard OpenAI API key", async () => {
    const registered: string[] = [];
    const result = await createOpenAIAuthentication(
      { OPENAI_API_KEY: "offline-api-key" },
      { register: (secret) => registered.push(secret) },
    );

    expect(result.provider).toBe("openai");
    expect(result.client).toBeInstanceOf(OpenAI);
    expect(result.credential).toBe("offline-api-key");
    expect(registered).toEqual(["offline-api-key"]);
    expect(await captureClientCredential(result.client)).toBe(
      "offline-api-key",
    );
  });

  test("exchanges GitHub OIDC identity and refreshes before expiry", async () => {
    let now = 10_000;
    let exchanges = 0;
    const registered: string[] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const result = await createOpenAIAuthentication(
      {
        OPENAI_IDENTITY_PROVIDER_ID: "idp-offline",
        OPENAI_SERVICE_ACCOUNT_ID: "sa-offline",
      },
      {
        now: () => now,
        register: (secret) => registered.push(secret),
        getIDToken: async (audience) => {
          expect(audience).toBe("https://api.openai.com/v1");
          return `oidc-${exchanges + 1}`;
        },
        fetch: async (input, init) => {
          requests.push({ url: String(input), init });
          exchanges += 1;
          return Response.json({
            access_token: `access-${exchanges}`,
            expires_in: 600,
          });
        },
      },
    );

    expect(result.provider).toBe("openai");
    expect(result.credential).toBe("access-1");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://auth.openai.com/oauth/token");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "oidc-1",
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      identity_provider_id: "idp-offline",
      service_account_id: "sa-offline",
    });
    expect(registered).toEqual(["oidc-1", "access-1"]);
    expect(await captureClientCredential(result.client)).toBe("access-1");
    expect(exchanges).toBe(1);

    now += 481_000;
    expect(await captureClientCredential(result.client)).toBe("access-2");
    expect(exchanges).toBe(2);
    expect(registered).toEqual(["oidc-1", "access-1", "oidc-2", "access-2"]);
  });

  test("does not leak OIDC or server error content on exchange failure", async () => {
    const error = await createOpenAIAuthentication(
      {
        OPENAI_IDENTITY_PROVIDER_ID: "idp-offline",
        OPENAI_SERVICE_ACCOUNT_ID: "sa-offline",
      },
      {
        register: () => undefined,
        getIDToken: async () => "private-subject-token",
        fetch: async () =>
          new Response("private-access-token internal details", {
            status: 403,
          }),
      },
    ).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    const errorMessage = error instanceof Error ? error.message : "";
    expect(errorMessage).toBe(
      "OpenAI workload identity token exchange failed (HTTP 403)",
    );
    expect(errorMessage).not.toContain("private-subject-token");
    expect(errorMessage).not.toContain("private-access-token");
    expect(errorMessage).not.toContain("internal details");

    await expect(
      createOpenAIAuthentication(
        {
          OPENAI_IDENTITY_PROVIDER_ID: "idp-offline",
          OPENAI_SERVICE_ACCOUNT_ID: "sa-offline",
        },
        {
          register: () => undefined,
          getIDToken: async () => "private-subject-token",
          fetch: async () => {
            throw new Error("private-subject-token private-access-token");
          },
        },
      ),
    ).rejects.toThrow("OpenAI workload identity token exchange failed");
  });

  test("uses the SDK Bedrock bearer provider", async () => {
    const registered: string[] = [];
    const result = await createOpenAIAuthentication(
      {
        OPENAI_PROVIDER: "bedrock",
        AWS_BEARER_TOKEN_BEDROCK: "offline-bedrock-token",
        AWS_REGION: "us-east-1",
      },
      { register: (secret) => registered.push(secret) },
    );

    expect(result.provider).toBe("bedrock");
    expect(result.client).toBeInstanceOf(OpenAI);
    expect(result.baseURL).toContain("bedrock");
    expect(result.credential).toBe("offline-bedrock-token");
    expect(registered).toEqual(["offline-bedrock-token"]);
  });

  test("routes Azure API-key and Entra-token credentials to AzureOpenAI", async () => {
    const apiKeyClient = await createOpenAIAuthentication(
      {
        OPENAI_PROVIDER: "azure",
        AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
        AZURE_OPENAI_API_KEY: "offline-azure-key",
        OPENAI_API_VERSION: "2025-01-01-preview",
        AZURE_OPENAI_DEPLOYMENT: "offline-deployment",
      },
      { register: () => undefined },
    );
    expect(apiKeyClient.provider).toBe("azure");
    expect(apiKeyClient.client).toBeInstanceOf(AzureOpenAI);
    expect((apiKeyClient.client as AzureOpenAI).deploymentName).toBe(
      "offline-deployment",
    );
    expect(apiKeyClient.baseURL).toBe(
      "https://example.openai.azure.com/openai",
    );

    const tokenClient = await createOpenAIAuthentication(
      {
        OPENAI_PROVIDER: "azure",
        AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
        AZURE_OPENAI_AD_TOKEN: "offline-entra-token",
        OPENAI_API_VERSION: "2025-01-01-preview",
      },
      { register: () => undefined },
    );
    expect(await captureClientCredential(tokenClient.client)).toBe(
      "offline-entra-token",
    );
  });

  test.each([
    [{}, "OPENAI_API_KEY or complete OpenAI workload identity"],
    [
      { OPENAI_IDENTITY_PROVIDER_ID: "idp-only" },
      "requires OPENAI_IDENTITY_PROVIDER_ID and OPENAI_SERVICE_ACCOUNT_ID",
    ],
    [
      {
        OPENAI_API_KEY: "offline-key",
        OPENAI_IDENTITY_PROVIDER_ID: "idp",
        OPENAI_SERVICE_ACCOUNT_ID: "sa",
      },
      "mutually exclusive",
    ],
    [
      { OPENAI_PROVIDER: "unknown", OPENAI_API_KEY: "offline-key" },
      "OPENAI_PROVIDER must be",
    ],
    [
      {
        OPENAI_PROVIDER: "bedrock",
        AWS_BEARER_TOKEN_BEDROCK: "offline-token",
      },
      "Bedrock requires AWS_REGION or AWS_DEFAULT_REGION",
    ],
    [
      {
        OPENAI_PROVIDER: "bedrock",
        AWS_BEARER_TOKEN_BEDROCK: "offline-token",
        AWS_REGION: "us-east-1",
        AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
      },
      "Credentials for multiple OpenAI providers are configured",
    ],
    [
      {
        OPENAI_PROVIDER: "bedrock",
        AWS_BEDROCK_ENDPOINT: "invalid",
      },
      "AWS_BEDROCK_ENDPOINT must be mantle or runtime",
    ],
    [
      {
        OPENAI_PROVIDER: "bedrock",
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "access-without-secret",
      },
      "both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
    ],
    [
      {
        OPENAI_PROVIDER: "bedrock",
        AWS_REGION: "us-east-1",
        AWS_BEARER_TOKEN_BEDROCK: "bearer-token",
        AWS_SESSION_TOKEN: "session-without-keys",
      },
      "mutually exclusive",
    ],
    [
      {
        OPENAI_PROVIDER: "azure",
        OPENAI_BASE_URL: "https://example.com/v1",
      },
      "OPENAI_BASE_URL is only supported with OPENAI_PROVIDER=openai",
    ],
    [
      {
        OPENAI_PROVIDER: "azure",
        AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
        AZURE_OPENAI_API_KEY: "key",
        AZURE_OPENAI_AD_TOKEN: "token",
        OPENAI_API_VERSION: "2025-01-01-preview",
      },
      "mutually exclusive",
    ],
  ] as Array<[NodeJS.ProcessEnv, string]>)(
    "rejects incomplete or ambiguous configuration",
    (environment, expected) => {
      expect(() => validateOpenAIAuthentication(environment)).toThrow(expected);
    },
  );
});
