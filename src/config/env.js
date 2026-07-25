import dotenv from "dotenv";

dotenv.config();

const TRANSPORT_MODES = new Set(["stdio", "http", "both"]);
const HTTP_AUTH_MODES = new Set(["token"]);
const TARGET_AUTH_MODES = new Set(["none", "bearer"]);
const VAULT_AGENT_AUTH_MODES = new Set(["none", "file", "listener", "both"]);

function enumValue(name, fallback, allowedValues) {
  const value = String(process.env[name] ?? fallback).toLowerCase();
  if (!allowedValues.has(value)) {
    throw new Error(
      `Environment variable ${name} must be one of: ${Array.from(allowedValues).join(", ")}`
    );
  }
  return value;
}

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative number`);
  }
  return value;
}

function portNumber(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Environment variable ${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function parseCsv(name, fallback = "") {
  return String(process.env[name] ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanValue(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = String(raw).toLowerCase();
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`Environment variable ${name} must be either true or false`);
}

function normalizeAppName(value, fallback = "skeleton") {
  return String(value ?? fallback).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-") || fallback;
}

function optionalString(name, fallback = "") {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }

  return String(value).trim();
}

const transportMode = enumValue("MCP_TRANSPORT_MODE", "stdio", TRANSPORT_MODES);
const httpAuthMode = enumValue("MCP_HTTP_AUTH_MODE", "token", HTTP_AUTH_MODES);
const targetAuthMode = enumValue("OPENSHIFT_AUTH_MODE", "bearer", TARGET_AUTH_MODES);
const vaultAgentAuthMode = enumValue("VAULT_AGENT_AUTH_MODE", "file", VAULT_AGENT_AUTH_MODES);
const defaultUserId = optionalString("MCP_CONFIG_DEFAULT_USER_ID", "default") || "default";

export const env = {
  appName: normalizeAppName(process.env.APP_NAME, "openshift"),
  mcpServerName: process.env.MCP_SERVER_NAME ?? "openshift-mcp",
  mcpServerVersion: process.env.MCP_SERVER_VERSION ?? "0.1.0",
  allowSensitiveOutput: booleanValue("MCP_ALLOW_SENSITIVE_OUTPUT", false),
  adminAuthKey: process.env.MCP_ADMIN_AUTH_KEY ?? "",
  config: {
    defaultUserId,
    vaultAgent: {
      authModeConfigKey: optionalString("MCP_VAULT_AGENT_AUTH_MODE_CONFIG_KEY", "vault.agent.auth.mode"),
      tokenFilePathConfigKey: optionalString(
        "MCP_VAULT_AGENT_TOKEN_FILE_PATH_CONFIG_KEY",
        "vault.agent.tokenFilePath"
      ),
      listenerAddrConfigKey: optionalString("MCP_VAULT_AGENT_LISTENER_ADDR_CONFIG_KEY", "vault.agent.listener.addr")
    }
  },
  openshift: {
    apiBaseUrl: required("OPENSHIFT_API_BASE_URL", "https://api.example.openshift.local:6443"),
    timeoutMs: positiveNumber("OPENSHIFT_TIMEOUT_MS", "15000"),
    authMode: targetAuthMode,
    defaultBearerToken: optionalString("OPENSHIFT_BEARER_TOKEN", ""),
    tokenSecretPathPrefix: optionalString("OPENSHIFT_USER_TOKEN_SECRET_PATH_PREFIX", "openshift/tokens/users"),
    tokenIndexPath: optionalString("OPENSHIFT_TOKEN_INDEX_PATH", "openshift/token-index"),
    tokenMetadataConfigKeyPrefix: optionalString(
      "OPENSHIFT_TOKEN_METADATA_CONFIG_KEY_PREFIX",
      "openshift.token.metadata"
    )
  },
  postgres: {
    host: required("POSTGRES_HOST", "127.0.0.1"),
    port: portNumber("POSTGRES_PORT", "5432"),
    database: required("POSTGRES_DB", "mcp_config"),
    user: required("POSTGRES_USER", "mcp_user"),
    password: required("POSTGRES_PASSWORD", "mcp_password")
  },
  vault: {
    addr: required("VAULT_ADDR", "http://127.0.0.1:8200"),
    token: optionalString("VAULT_TOKEN", ""),
    agentEnabled: booleanValue("VAULT_AGENT_ENABLED", false),
    agentAuthMode: vaultAgentAuthMode,
    agentTokenFilePath: optionalString("VAULT_AGENT_TOKEN_FILE_PATH", "/tmp/vault-agent-token"),
    agentListenerEnabled: booleanValue("VAULT_AGENT_LISTENER_ENABLED", false),
    agentListenerAddr: optionalString("VAULT_AGENT_LISTENER_ADDR", "http://127.0.0.1:8100"),
    kvMount: required("VAULT_KV_MOUNT", "secret"),
    writeRetryAttempts: positiveNumber("VAULT_WRITE_RETRY_ATTEMPTS", "3"),
    writeRetryBaseDelayMs: positiveNumber("VAULT_WRITE_RETRY_BASE_DELAY_MS", "200"),
    writeRetryMaxDelayMs: positiveNumber("VAULT_WRITE_RETRY_MAX_DELAY_MS", "2000")
  },
  transport: {
    mode: transportMode,
    http: {
      host: required("MCP_HTTP_HOST", "127.0.0.1"),
      port: portNumber("MCP_HTTP_PORT", "3000"),
      mcpPath: required("MCP_HTTP_PATH", "/mcp"),
      healthPath: required("MCP_HTTP_HEALTH_PATH", "/healthz"),
      authMode: httpAuthMode,
      authTokens: parseCsv("MCP_HTTP_AUTH_TOKENS", "replace-me-token"),
      trustedProxy: booleanValue("MCP_HTTP_TRUST_PROXY", false),
      allowedOrigins: parseCsv("MCP_HTTP_ALLOWED_ORIGINS", ""),
      allowedIps: parseCsv("MCP_HTTP_ALLOWED_IPS", ""),
      maxBodyBytes: positiveNumber("MCP_HTTP_MAX_BODY_BYTES", "1048576"),
      rateLimitWindowMs: positiveNumber("MCP_HTTP_RATE_LIMIT_WINDOW_MS", "60000"),
      rateLimitMaxRequests: positiveNumber("MCP_HTTP_RATE_LIMIT_MAX_REQUESTS", "60"),
      tls: {
        enabled: booleanValue("MCP_HTTP_TLS_ENABLED", false),
        certPath: process.env.MCP_HTTP_TLS_CERT_PATH ?? "",
        keyPath: process.env.MCP_HTTP_TLS_KEY_PATH ?? ""
      }
    }
  }
};
