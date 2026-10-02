import { describe, expect, test } from "bun:test";
import { createOpenAIAuthentication } from "../src/openai-auth";

describe("provider request authentication", () => {
  test.each([
    ["mantle", "bedrock-mantle"],
    ["runtime", "bedrock"],
  ])(
    "signs custom %s proxies with the correct AWS service",
    async (endpoint, service) => {
      let request: Request | undefined;
      const authentication = await createOpenAIAuthentication(
        {
          OPENAI_PROVIDER: "bedrock",
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "offline-access-key",
          AWS_SECRET_ACCESS_KEY: "offline-secret-key",
          AWS_BEDROCK_ENDPOINT: endpoint,
          AWS_BEDROCK_BASE_URL: "https://proxy.example/v1",
        },
        {
          register: () => undefined,
          fetch: async (input, init) => {
            request =
              input instanceof Request
                ? new Request(input, init)
                : new Request(String(input), init);
            return Response.json({ id: "resp_offline", output: [] });
          },
        },
      );
      await authentication.client.responses.create({
        model: "bedrock-model-id",
        input: "Offline",
      });
      expect(request!.url).toBe("https://proxy.example/v1/responses");
      expect(request!.headers.get("authorization")).toContain(
        `/us-east-1/${service}/aws4_request`,
      );
    },
  );

  test.each([
    ["AZURE_OPENAI_API_KEY", "api-key", "offline-azure-key"],
    ["AZURE_OPENAI_AD_TOKEN", "authorization", "Bearer offline-azure-key"],
  ])(
    "sends Azure Responses requests using %s",
    async (key, header, expected) => {
      let request: Request | undefined;
      const authentication = await createOpenAIAuthentication(
        {
          OPENAI_PROVIDER: "azure",
          AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/",
          OPENAI_API_VERSION: "2025-04-01-preview",
          [key!]: "offline-azure-key",
        },
        {
          register: () => undefined,
          fetch: async (input, init) => {
            request =
              input instanceof Request
                ? new Request(input, init)
                : new Request(String(input), init);
            return Response.json({ id: "resp_offline", output: [] });
          },
        },
      );
      await authentication.client.responses.create({
        model: "my-azure-deployment",
        input: "Offline authentication test",
        store: false,
      });
      expect(request).toBeDefined();
      expect(request!.url).toBe(
        "https://example.openai.azure.com/openai/responses?api-version=2025-04-01-preview",
      );
      expect(request!.headers.get(header!)).toBe(expected!);
      expect(
        request!.headers.has(
          header === "api-key" ? "authorization" : "api-key",
        ),
      ).toBe(false);
      expect(await request!.json()).toMatchObject({
        model: "my-azure-deployment",
      });
    },
  );

  test.each([false, true])(
    "signs Bedrock Responses using AWS credentials (session token: %s)",
    async (temporary) => {
      const requests: Request[] = [];
      const registered: string[] = [];
      const authentication = await createOpenAIAuthentication(
        {
          OPENAI_PROVIDER: "bedrock",
          AWS_DEFAULT_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "offline-access-key",
          AWS_SECRET_ACCESS_KEY: "offline-secret-key",
          ...(temporary ? { AWS_SESSION_TOKEN: "offline-session-token" } : {}),
        },
        {
          register: (secret) => registered.push(secret),
          fetch: async (input, init) => {
            requests.push(
              input instanceof Request
                ? new Request(input, init)
                : new Request(String(input), init),
            );
            return Response.json({ id: "resp_offline", output: [] });
          },
        },
      );
      expect(authentication.credential).toBe("offline-secret-key");
      expect(registered).toEqual([
        "offline-access-key",
        "offline-secret-key",
        ...(temporary ? ["offline-session-token"] : []),
      ]);
      for (const input of ["First signed body", "Second signed body"]) {
        await authentication.client.responses.create({
          model: "bedrock-model-id",
          input,
          store: false,
        });
      }
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe(
          "https://bedrock-mantle.us-east-1.api.aws/v1/responses",
        );
        expect(request.headers.get("authorization")).toMatch(
          /^AWS4-HMAC-SHA256 Credential=offline-access-key\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request, SignedHeaders=.+, Signature=[0-9a-f]{64}$/,
        );
        expect(request.headers.get("x-amz-security-token")).toBe(
          temporary ? "offline-session-token" : null,
        );
        expect(request.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
        expect(request.headers.has("api-key")).toBe(false);
        expect(JSON.stringify([...request.headers])).not.toContain(
          "offline-secret-key",
        );
      }
      expect(requests[0]!.headers.get("authorization")).not.toBe(
        requests[1]!.headers.get("authorization"),
      );
    },
  );

  test("routes Bedrock bearer credentials to its selected regional endpoint", async () => {
    let request: Request | undefined;
    const authentication = await createOpenAIAuthentication(
      {
        OPENAI_PROVIDER: "bedrock",
        AWS_BEARER_TOKEN_BEDROCK: "offline-bedrock-token",
        AWS_REGION: "us-east-1",
        AWS_BEDROCK_BASE_URL:
          "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
      },
      {
        register: () => undefined,
        fetch: async (input, init) => {
          request =
            input instanceof Request
              ? new Request(input, init)
              : new Request(String(input), init);
          return Response.json({ id: "resp_offline", output: [] });
        },
      },
    );
    await authentication.client.responses.create({
      model: "bedrock-model-id",
      input: "Offline",
    });
    expect(request!.url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1/responses",
    );
    expect(request!.headers.get("authorization")).toBe(
      "Bearer offline-bedrock-token",
    );
    expect(request!.headers.has("x-amz-date")).toBe(false);
  });
});
