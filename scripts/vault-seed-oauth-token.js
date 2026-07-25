#!/usr/bin/env node

import { VaultService } from "../src/services/vault.js";
import {
  createVaultTokenEntry,
  getVaultUserTokenIndexPath,
  mergeVaultTokenIndex,
  normalizeAppName
} from "../src/config/vaultAuthTokenIndex.js";

function usage() {
  process.stdout.write(`Usage:\n  node scripts/vault-seed-oauth-token.js [options]\n\nOptions:\n  --token <value>         OAuth token value to seed (required)\n  --user-id <id>          Vault user id to seed (default: default)\n  --token-id <id>         Token id to store with the entry\n  --scopes <list>         Scopes as comma/space-separated list (default: mcp:invoke,mcp:read)\n  --audience <list>       Audience as comma/space-separated list (default: codex)\n  --expires-at <value>    Optional ISO timestamp or unix seconds\n  --path <vault-path>     Override Vault token index path\n  --json                  Print JSON output\n  -h, --help              Show help\n`);
}

function fail(message) {
  process.stderr.write(`[vault-seed-oauth-token][error] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    token: "",
    userId: "default",
    tokenId: "",
    scopes: "mcp:invoke,mcp:read",
    audience: "codex",
    expiresAt: "",
    path: "",
    json: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--token") {
      args.token = argv[i + 1] ?? "";
      i += 1;
      continue;
    }

    if (arg === "--user-id") {
      args.userId = argv[i + 1] ?? "";
      i += 1;
      continue;
    }

    if (arg === "--token-id") {
      args.tokenId = argv[i + 1] ?? "";
      i += 1;
      continue;
    }

    if (arg === "--scopes") {
      args.scopes = argv[i + 1] ?? "";
      i += 1;
      continue;
    }

    if (arg === "--audience") {
      args.audience = argv[i + 1] ?? "";
      i += 1;
      continue;
    }

    if (arg === "--expires-at") {
      args.expiresAt = argv[i + 1] ?? "";
      i += 1;
      continue;
    }

    if (arg === "--path") {
      args.path = argv[i + 1] ?? "";
      i += 1;
      continue;
    }

    if (arg === "--json") {
      args.json = true;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }

    fail(`Unknown argument: ${arg}`);
  }

  args.token = String(args.token).trim();
  args.userId = String(args.userId).trim() || "default";
  args.scopes = String(args.scopes).trim() || "mcp:invoke,mcp:read";
  args.audience = String(args.audience).trim() || "codex";
  args.path = String(args.path).trim();

  if (!args.token) {
    fail("--token is required");
  }

  return args;
}

function parseOptionalExpiresAt(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid expires-at value: ${raw}`);
    }
    return new Date(parsed * 1000).toISOString();
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid expires-at value: ${raw}`);
  }

  return new Date(parsed).toISOString();
}

function parseBooleanEnv(value, fallback = false) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const normalized = String(value).toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new Error(`Environment variable must be either true or false: ${value}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appName = normalizeAppName(process.env.APP_NAME ?? "skeleton");
  const indexPath =
    args.path || process.env.MCP_HTTP_VAULT_TOKEN_INDEX_PATH || getVaultUserTokenIndexPath(appName, args.userId);
  const expiresAt = parseOptionalExpiresAt(args.expiresAt);

  const vaultService = new VaultService({
    endpoint: process.env.VAULT_ADDR ?? "http://127.0.0.1:8200",
    token: process.env.VAULT_TOKEN ?? "",
    agentEnabled: parseBooleanEnv(process.env.VAULT_AGENT_ENABLED, false),
    agentAuthMode: process.env.VAULT_AGENT_AUTH_MODE ?? "file",
    agentTokenFilePath: process.env.VAULT_AGENT_TOKEN_FILE_PATH ?? "",
    agentListenerEnabled: parseBooleanEnv(process.env.VAULT_AGENT_LISTENER_ENABLED, false),
    agentListenerAddr: process.env.VAULT_AGENT_LISTENER_ADDR ?? "http://127.0.0.1:8100",
    kvMount: process.env.VAULT_KV_MOUNT ?? "secret",
    writeRetryAttempts: Number(process.env.VAULT_WRITE_RETRY_ATTEMPTS ?? "3"),
    writeRetryBaseDelayMs: Number(process.env.VAULT_WRITE_RETRY_BASE_DELAY_MS ?? "200"),
    writeRetryMaxDelayMs: Number(process.env.VAULT_WRITE_RETRY_MAX_DELAY_MS ?? "2000")
  });

  const existingPayload = await vaultService.getSecret(indexPath).catch((error) => {
    if (String(error?.message ?? "").includes("404")) {
      return null;
    }
    throw error;
  });

  const { tokenHash, entry } = createVaultTokenEntry({
    userId: args.userId,
    tokenId: args.tokenId || undefined,
    token: args.token,
    scopes: args.scopes,
    audience: args.audience,
    expiresAt: expiresAt || undefined,
    tokenType: "oauth2"
  });

  const payload = mergeVaultTokenIndex(existingPayload, {
    userId: args.userId,
    tokenHash,
    entry
  });

  await vaultService.setSecret(indexPath, payload);

  const output = {
    tokenHash,
    indexPath,
    userId: args.userId,
    tokenId: entry.tokenId,
    tokenType: entry.tokenType,
    scopes: entry.scopes,
    audience: entry.audience,
    expiresAt: entry.expiresAt ?? null
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[vault-seed-oauth-token][error] ${error?.stack ?? error?.message ?? String(error)}\n`);
  process.exit(1);
});