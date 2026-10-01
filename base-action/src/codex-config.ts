/** JSON strings are also TOML basic strings, except DEL and lone surrogates. */
export function tomlString(value: string): string {
  if (/[\uD800-\uDFFF]/u.test(value)) {
    throw new Error("Codex configuration contains invalid Unicode");
  }
  return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function serializeMcpConfig(raw: string): {
  toml: string;
  secrets: string[];
  clientEnvironment: Record<string, string>;
} {
  let config: unknown;
  try {
    config = JSON.parse(raw || '{"mcpServers":{}}');
  } catch {
    throw new Error("Codex MCP configuration must be valid JSON");
  }
  if (!record(config) || !record(config.mcpServers)) {
    throw new Error(
      "Codex MCP configuration must contain an mcpServers object",
    );
  }
  const lines: string[] = [];
  const secrets: string[] = [];
  const clientEnvironment: Record<string, string> = {};
  for (const [name, server] of Object.entries(config.mcpServers)) {
    const section = `mcp_servers.${tomlString(name)}`;
    if (record(server) && typeof server.url === "string") {
      if (
        (server.type !== undefined &&
          !["http", "streamable-http"].includes(String(server.type))) ||
        Object.keys(server).some(
          (key) =>
            ![
              "type",
              "url",
              "headers",
              "http_headers",
              "bearer_token_env_var",
            ].includes(key),
        )
      )
        throw new Error(
          "Unsupported HTTP MCP fields or transport; use streamable HTTP",
        );
      let endpoint: URL;
      try {
        endpoint = new URL(server.url);
      } catch {
        throw new Error("HTTP MCP url must be an HTTP or HTTPS URL");
      }
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password
      )
        throw new Error(
          "HTTP MCP url must use HTTP/HTTPS without embedded credentials",
        );
      if (server.headers !== undefined && server.http_headers !== undefined)
        throw new Error("Supply either headers or http_headers, not both");
      const headers = server.headers ?? server.http_headers;
      if (
        headers !== undefined &&
        (!record(headers) ||
          Object.values(headers).some(
            (value) => typeof value !== "string" || /[\r\n]/.test(value),
          ))
      )
        throw new Error(
          "HTTP MCP headers must be string values without newlines",
        );
      lines.push(
        `[${section}]`,
        `url = ${tomlString(server.url)}`,
        "required = true",
      );
      if (server.bearer_token_env_var !== undefined) {
        const variable = server.bearer_token_env_var;
        if (
          typeof variable !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) ||
          /^(?:CODEX_|OPENAI_|INPUT_|ACTIONS_|NODE_OPTIONS|BUN_OPTIONS|LD_|DYLD_)/i.test(
            variable,
          )
        )
          throw new Error("Invalid or reserved HTTP MCP bearer token variable");
        const token = process.env[variable];
        if (!token)
          throw new Error("HTTP MCP bearer token variable is not set");
        clientEnvironment[variable] = token;
        secrets.push(token);
        lines.push(`bearer_token_env_var = ${tomlString(variable)}`);
      }
      if (record(headers)) {
        lines.push(`[${section}.http_headers]`);
        for (const [key, value] of Object.entries(headers)) {
          lines.push(`${tomlString(key)} = ${tomlString(value as string)}`);
          if (
            /auth|key|token|secret|credential|cookie|password/i.test(key) &&
            value
          ) {
            secrets.push(value as string);
            if (/^Bearer\s+/i.test(value as string))
              secrets.push((value as string).replace(/^Bearer\s+/i, ""));
            if (/cookie/i.test(key)) {
              for (const part of (value as string).split(";")) {
                const separator = part.indexOf("=");
                if (separator >= 0 && part.slice(separator + 1).trim())
                  secrets.push(part.slice(separator + 1).trim());
              }
            }
          }
        }
      }
      lines.push("");
      continue;
    }
    // Fail closed rather than silently dropping HTTP authentication or options.
    if (
      !record(server) ||
      (server.type !== undefined && server.type !== "stdio") ||
      Object.keys(server).some(
        (key) => !["type", "command", "args", "env"].includes(key),
      ) ||
      typeof server.command !== "string" ||
      !server.command.trim() ||
      (server.args !== undefined &&
        (!Array.isArray(server.args) ||
          server.args.some((arg) => typeof arg !== "string"))) ||
      (server.env !== undefined &&
        (!record(server.env) ||
          Object.values(server.env).some((value) => typeof value !== "string")))
    ) {
      throw new Error(
        "Codex supports MCP stdio servers with command, string args, and string env only",
      );
    }
    lines.push(`[${section}]`, `command = ${tomlString(server.command)}`);
    lines.push(
      `args = [${((server.args ?? []) as string[]).map(tomlString).join(", ")}]`,
    );
    lines.push("required = true", "env_vars = []");
    if (server.env) {
      lines.push(`[${section}.env]`);
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`${tomlString(key)} = ${tomlString(value as string)}`);
        if (
          /key|token|secret|password|credential|authorization/i.test(key) &&
          value
        ) {
          secrets.push(value as string);
        }
      }
    }
    lines.push("");
  }
  return { toml: lines.join("\n"), secrets, clientEnvironment };
}

/** Only infrastructure needed to launch Codex/MCP is inherited by the CLI. */
export function codexEnvironment(
  home: string,
  apiKey: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.CODEX_HOME = home;
  env.CODEX_API_KEY = apiKey;
  return env;
}

// CLI overrides outrank project config. The shell sees no Actions/auth variables.
export const SECURITY_OVERRIDES = [
  'forced_login_method="api"',
  'cli_auth_credentials_store="ephemeral"',
  'model_provider="openai"',
  'approval_policy="never"',
  'shell_environment_policy.inherit="core"',
  "shell_environment_policy.ignore_default_excludes=false",
  "shell_environment_policy.experimental_use_profile=false",
  'shell_environment_policy.exclude=["OPENAI_API_KEY","CODEX_API_KEY","CODEX_HOME","*TOKEN*","*SECRET*","*KEY*","*PASSWORD*","*CREDENTIAL*","ACTIONS_*","GITHUB_*","GH_*"]',
  "shell_environment_policy.include_only=[]",
  "shell_environment_policy.set={}",
  'history.persistence="none"',
];
