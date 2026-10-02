import * as core from "@actions/core";
import { AzureOpenAI, OpenAI, type ClientOptions } from "openai";
import { bedrock } from "openai/providers/bedrock";
import { bedrock as bedrockAws } from "openai/providers/bedrock/aws";

export type OpenAIProvider = "openai" | "bedrock" | "azure";

export type OpenAIAuthenticationEnvironment = NodeJS.ProcessEnv;

export type OpenAIAuthentication = {
  client: OpenAI;
  credential: string;
  provider: OpenAIProvider;
  baseURL?: string;
};

export type OpenAIAuthenticationDependencies = {
  register?: (secret: string) => void;
  getIDToken?: (audience?: string) => Promise<string>;
  fetch?: NonNullable<ClientOptions["fetch"]>;
  /** Clock injection keeps token refresh behavior deterministic in tests. */
  now?: () => number;
};

const OPENAI_TOKEN_EXCHANGE_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_OIDC_AUDIENCE = "https://api.openai.com/v1";
const DEFAULT_REFRESH_BUFFER_SECONDS = 120;

function value(environment: OpenAIAuthenticationEnvironment, key: string) {
  return environment[key]?.trim() ?? "";
}

function hasAny(environment: OpenAIAuthenticationEnvironment, keys: string[]) {
  return keys.some((key) => value(environment, key) !== "");
}

function providerFor(
  environment: OpenAIAuthenticationEnvironment,
): OpenAIProvider {
  const configured = value(environment, "OPENAI_PROVIDER").toLowerCase();
  if (!configured || configured === "openai") return "openai";
  if (configured === "bedrock" || configured === "azure") return configured;
  throw new Error("OPENAI_PROVIDER must be openai, bedrock, or azure");
}

function bedrockEndpointFor(
  environment: OpenAIAuthenticationEnvironment,
): "mantle" | "runtime" | undefined {
  const endpoint = value(environment, "AWS_BEDROCK_ENDPOINT");
  if (!endpoint) return undefined;
  if (endpoint === "mantle" || endpoint === "runtime") return endpoint;
  throw new Error("AWS_BEDROCK_ENDPOINT must be mantle or runtime");
}

const FEDERATION_FIELDS = [
  "OPENAI_IDENTITY_PROVIDER_ID",
  "OPENAI_SERVICE_ACCOUNT_ID",
  "OPENAI_OIDC_AUDIENCE",
];
const AZURE_FIELDS = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_AD_TOKEN",
  "OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT",
];

/** Validate provider credentials without making a network request. */
export function validateOpenAIAuthentication(
  environment: OpenAIAuthenticationEnvironment,
): OpenAIProvider {
  const provider = providerFor(environment);
  const apiKey = value(environment, "OPENAI_API_KEY");
  const federationValues = FEDERATION_FIELDS.map((key) =>
    value(environment, key),
  );
  const hasFederation = federationValues.some(Boolean);
  const bedrockToken = value(environment, "AWS_BEARER_TOKEN_BEDROCK");
  const awsRegion =
    value(environment, "AWS_REGION") ||
    value(environment, "AWS_DEFAULT_REGION");
  const azureKey = value(environment, "AZURE_OPENAI_API_KEY");
  const azureToken = value(environment, "AZURE_OPENAI_AD_TOKEN");

  if (provider !== "openai" && value(environment, "OPENAI_BASE_URL")) {
    throw new Error(
      "OPENAI_BASE_URL is only supported with OPENAI_PROVIDER=openai; use the selected provider's endpoint setting",
    );
  }

  if (provider === "openai") {
    if (bedrockToken || hasAny(environment, AZURE_FIELDS)) {
      throw new Error(
        "Credentials for multiple OpenAI providers are configured",
      );
    }
    if (apiKey && hasFederation) {
      throw new Error(
        "OPENAI_API_KEY and OpenAI workload identity are mutually exclusive",
      );
    }
    if (hasFederation) {
      if (
        !value(environment, "OPENAI_IDENTITY_PROVIDER_ID") ||
        !value(environment, "OPENAI_SERVICE_ACCOUNT_ID")
      ) {
        throw new Error(
          "OpenAI workload identity requires OPENAI_IDENTITY_PROVIDER_ID and OPENAI_SERVICE_ACCOUNT_ID",
        );
      }
    } else if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY or complete OpenAI workload identity credentials are required",
      );
    }
    return provider;
  }

  if (provider === "bedrock") {
    bedrockEndpointFor(environment);
    if (apiKey || hasFederation || hasAny(environment, AZURE_FIELDS)) {
      throw new Error(
        "Credentials for multiple OpenAI providers are configured",
      );
    }
    const accessKeyId = value(environment, "AWS_ACCESS_KEY_ID");
    const secretAccessKey = value(environment, "AWS_SECRET_ACCESS_KEY");
    const sessionToken = value(environment, "AWS_SESSION_TOKEN");
    if (bedrockToken && (accessKeyId || secretAccessKey || sessionToken)) {
      throw new Error(
        "Bedrock bearer tokens and AWS signing credentials are mutually exclusive",
      );
    }
    if (!awsRegion) {
      throw new Error("Bedrock requires AWS_REGION or AWS_DEFAULT_REGION");
    }
    if (!bedrockToken && (!accessKeyId || !secretAccessKey)) {
      throw new Error(
        "Bedrock requires AWS_BEARER_TOKEN_BEDROCK or both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY",
      );
    }
    return provider;
  }

  if (apiKey || hasFederation || bedrockToken) {
    throw new Error("Credentials for multiple OpenAI providers are configured");
  }
  if (!value(environment, "AZURE_OPENAI_ENDPOINT")) {
    throw new Error("Azure OpenAI requires AZURE_OPENAI_ENDPOINT");
  }
  if (!value(environment, "OPENAI_API_VERSION")) {
    throw new Error("Azure OpenAI requires OPENAI_API_VERSION");
  }
  if (azureKey && azureToken) {
    throw new Error(
      "AZURE_OPENAI_API_KEY and AZURE_OPENAI_AD_TOKEN are mutually exclusive",
    );
  }
  if (!azureKey && !azureToken) {
    throw new Error(
      "Azure OpenAI requires AZURE_OPENAI_API_KEY or AZURE_OPENAI_AD_TOKEN",
    );
  }
  return provider;
}

type ExchangeResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
};

function safeExchangeError(status?: number): Error {
  return new Error(
    status === undefined
      ? "OpenAI workload identity token exchange failed"
      : `OpenAI workload identity token exchange failed (HTTP ${status})`,
  );
}

async function createFederatedAuthentication(
  environment: OpenAIAuthenticationEnvironment,
  dependencies: OpenAIAuthenticationDependencies,
): Promise<OpenAIAuthentication> {
  const fetchImpl =
    dependencies.fetch ??
    (globalThis.fetch as NonNullable<ClientOptions["fetch"]>);
  const register = dependencies.register ?? core.setSecret;
  const identityProviderId = value(environment, "OPENAI_IDENTITY_PROVIDER_ID");
  const serviceAccountId = value(environment, "OPENAI_SERVICE_ACCOUNT_ID");
  const audience =
    value(environment, "OPENAI_OIDC_AUDIENCE") || DEFAULT_OIDC_AUDIENCE;
  const getIDToken =
    dependencies.getIDToken ??
    ((requestedAudience) => core.getIDToken(requestedAudience));
  const now = dependencies.now ?? Date.now;
  let cached: { token: string; refreshAt: number } | undefined;
  let refreshInFlight: Promise<string> | undefined;

  const exchange = async (): Promise<string> => {
    let subjectToken: string;
    try {
      subjectToken = await getIDToken(audience);
    } catch {
      throw new Error(
        "Could not obtain the OpenAI workload identity OIDC token",
      );
    }
    if (!subjectToken?.trim()) {
      throw new Error("OpenAI workload identity returned an empty OIDC token");
    }
    register(subjectToken);

    const exchangeStartedAt = now();
    let response: Response;
    try {
      response = await fetchImpl(OPENAI_TOKEN_EXCHANGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: subjectToken,
          subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
          identity_provider_id: identityProviderId,
          service_account_id: serviceAccountId,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw safeExchangeError();
    }
    if (!response.ok) throw safeExchangeError(response.status);

    let payload: ExchangeResponse;
    try {
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Invalid token response");
      }
      payload = body as ExchangeResponse;
    } catch {
      throw new Error(
        "OpenAI workload identity returned an invalid token response",
      );
    }
    if (
      typeof payload.access_token !== "string" ||
      !payload.access_token.trim() ||
      typeof payload.expires_in !== "number" ||
      !Number.isFinite(payload.expires_in) ||
      payload.expires_in <= 0 ||
      (payload.expires_at !== undefined &&
        (typeof payload.expires_at !== "number" ||
          !Number.isFinite(payload.expires_at) ||
          payload.expires_at <= 0))
    ) {
      throw new Error(
        "OpenAI workload identity returned an invalid token response",
      );
    }

    register(payload.access_token);
    // Delivery time consumes token lifetime. Prefer the earlier deadline if the
    // service supplies absolute expiry, while allowing for local clock skew.
    const expiresAt = Math.min(
      exchangeStartedAt + payload.expires_in * 1000,
      typeof payload.expires_at === "number"
        ? payload.expires_at * 1000
        : Infinity,
    );
    const remainingLifetime = (expiresAt - now()) / 1000;
    if (!Number.isFinite(expiresAt) || remainingLifetime <= 0) {
      throw new Error("OpenAI workload identity returned an expired token");
    }
    const refreshBuffer = Math.min(
      DEFAULT_REFRESH_BUFFER_SECONDS,
      remainingLifetime / 2,
    );
    cached = {
      token: payload.access_token,
      refreshAt: expiresAt - refreshBuffer * 1000,
    };
    return cached.token;
  };

  const getCredential = async (): Promise<string> => {
    if (cached && now() < cached.refreshAt) return cached.token;
    if (!refreshInFlight) {
      const operation = exchange().finally(() => {
        if (refreshInFlight === operation) refreshInFlight = undefined;
      });
      refreshInFlight = operation;
    }
    return refreshInFlight;
  };

  const credential = await getCredential();
  const client = new OpenAI({
    apiKey: getCredential,
    baseURL: value(environment, "OPENAI_BASE_URL") || DEFAULT_OIDC_AUDIENCE,
    ...(dependencies.fetch ? { fetch: fetchImpl } : {}),
  });
  return { client, credential, provider: "openai", baseURL: client.baseURL };
}

/** Build the OpenAI-compatible client and its selected provider credential. */
export async function createOpenAIAuthentication(
  environment: OpenAIAuthenticationEnvironment,
  dependencies: OpenAIAuthenticationDependencies = {},
): Promise<OpenAIAuthentication> {
  const provider = validateOpenAIAuthentication(environment);
  const fetchImpl =
    dependencies.fetch ??
    (globalThis.fetch as NonNullable<ClientOptions["fetch"]>);

  if (provider === "openai") {
    if (value(environment, "OPENAI_IDENTITY_PROVIDER_ID")) {
      return createFederatedAuthentication(environment, dependencies);
    }
    const credential = value(environment, "OPENAI_API_KEY");
    (dependencies.register ?? core.setSecret)(credential);
    const client = new OpenAI({
      apiKey: credential,
      baseURL: value(environment, "OPENAI_BASE_URL") || DEFAULT_OIDC_AUDIENCE,
      ...(dependencies.fetch ? { fetch: fetchImpl } : {}),
    });
    return { client, credential, provider, baseURL: client.baseURL };
  }

  if (provider === "bedrock") {
    const bearerToken = value(environment, "AWS_BEARER_TOKEN_BEDROCK");
    const accessKeyId = value(environment, "AWS_ACCESS_KEY_ID");
    const secretAccessKey = value(environment, "AWS_SECRET_ACCESS_KEY");
    const sessionToken = value(environment, "AWS_SESSION_TOKEN");
    const credential = bearerToken || secretAccessKey;
    const register = dependencies.register ?? core.setSecret;
    for (const secret of [
      bearerToken,
      accessKeyId,
      secretAccessKey,
      sessionToken,
    ]) {
      if (secret) register(secret);
    }
    const region =
      value(environment, "AWS_REGION") ||
      value(environment, "AWS_DEFAULT_REGION");
    const endpointType = bedrockEndpointFor(environment);
    const endpoint = {
      endpoint: endpointType,
      region,
      baseURL:
        value(environment, "AWS_BEDROCK_BASE_URL") ||
        (endpointType === "runtime"
          ? null
          : `https://bedrock-mantle.${region}.api.aws/v1`),
    };
    const client = new OpenAI({
      provider: bearerToken
        ? bedrock({ ...endpoint, apiKey: bearerToken })
        : bedrockAws({
            ...endpoint,
            accessKeyId,
            secretAccessKey,
            sessionToken: sessionToken || undefined,
          }),
      ...(dependencies.fetch ? { fetch: fetchImpl } : {}),
    });
    return { client, credential, provider, baseURL: client.baseURL };
  }

  const apiKey = value(environment, "AZURE_OPENAI_API_KEY");
  const adToken = value(environment, "AZURE_OPENAI_AD_TOKEN");
  const credential = apiKey || adToken;
  (dependencies.register ?? core.setSecret)(credential);
  const client = new AzureOpenAI({
    baseURL: `${value(environment, "AZURE_OPENAI_ENDPOINT").replace(/\/+$/, "")}/openai`,
    apiVersion: value(environment, "OPENAI_API_VERSION"),
    deployment: value(environment, "AZURE_OPENAI_DEPLOYMENT") || undefined,
    apiKey,
    ...(adToken ? { azureADTokenProvider: async () => adToken } : {}),
    ...(dependencies.fetch ? { fetch: fetchImpl } : {}),
  });
  return { client, credential, provider, baseURL: client.baseURL };
}
