import { describe, expect, test } from "bun:test";
import { type OpenAI } from "openai";
import { createOpenAIAuthentication } from "../src/openai-auth";

const environment = {
  OPENAI_IDENTITY_PROVIDER_ID: "idp-offline",
  OPENAI_SERVICE_ACCOUNT_ID: "sa-offline",
};

async function credential(client: OpenAI): Promise<string | null> {
  let result: string | null = null;
  await client._callApiKey((value) => {
    result = value;
  });
  return result;
}

describe("workload identity token lifetime", () => {
  test("honors absolute expiration and shares concurrent refreshes", async () => {
    let now = 10_000;
    let exchanges = 0;
    const authentication = await createOpenAIAuthentication(environment, {
      now: () => now,
      register: () => undefined,
      getIDToken: async () => "offline-subject",
      fetch: async () => {
        exchanges += 1;
        return Response.json({
          access_token: `offline-access-${exchanges}`,
          expires_in: 600,
          expires_at: (now + 30_000) / 1000,
        });
      },
    });
    now = 26_000;
    expect(
      await Promise.all([
        credential(authentication.client),
        credential(authentication.client),
        credential(authentication.client),
      ]),
    ).toEqual(["offline-access-2", "offline-access-2", "offline-access-2"]);
    expect(exchanges).toBe(2);
  });

  test("delivery latency consumes the issued token lifetime", async () => {
    let now = 0;
    let exchanges = 0;
    const authentication = await createOpenAIAuthentication(environment, {
      now: () => now,
      register: () => undefined,
      getIDToken: async () => "offline-subject",
      fetch: async () => {
        exchanges += 1;
        now += 4_000;
        return Response.json({
          access_token: `offline-access-${exchanges}`,
          expires_in: 10,
        });
      },
    });
    expect(await credential(authentication.client)).toBe("offline-access-1");
    now = 7_500;
    expect(await credential(authentication.client)).toBe("offline-access-2");
    expect(exchanges).toBe(2);
  });

  test.each(
    [
      null,
      [],
      "private-server-message",
      {
        access_token: "offline-access",
        expires_in: 600,
        expires_at: "invalid",
      },
      { access_token: "offline-access", expires_in: 0 },
    ].map((payload) => ({ payload })),
  )("rejects malformed exchanges with a safe error", async ({ payload }) => {
    await expect(
      createOpenAIAuthentication(environment, {
        register: () => undefined,
        getIDToken: async () => "offline-subject",
        fetch: async () => Response.json(payload),
      }),
    ).rejects.toThrow(
      "OpenAI workload identity returned an invalid token response",
    );
  });

  test.each([
    { access_token: "offline-access", expires_in: 60, expires_at: 1 },
    { access_token: "offline-access", expires_in: 0.001 },
  ])("refuses credentials that expired before delivery", async (payload) => {
    let now = 10_000;
    await expect(
      createOpenAIAuthentication(environment, {
        now: () => now,
        register: () => undefined,
        getIDToken: async () => "offline-subject",
        fetch: async () => {
          now += 10;
          return Response.json(payload);
        },
      }),
    ).rejects.toThrow("OpenAI workload identity returned an expired token");
  });

  test("uses the same injected transport for exchange and authenticated model requests", async () => {
    const requests: Request[] = [];
    const authentication = await createOpenAIAuthentication(environment, {
      register: () => undefined,
      getIDToken: async () => "offline-subject",
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(String(input), init);
        requests.push(request);
        return request.url === "https://auth.openai.com/oauth/token"
          ? Response.json({ access_token: "offline-access", expires_in: 600 })
          : Response.json({ id: "resp_offline", output: [] });
      },
    });
    await authentication.client.responses.create({
      model: "gpt-6-luna",
      input: "Offline",
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/oauth/token",
      "https://api.openai.com/v1/responses",
    ]);
    expect(requests[1]!.headers.get("authorization")).toBe(
      "Bearer offline-access",
    );
    expect(requests[1]!.headers.has("api-key")).toBe(false);
  });
});
