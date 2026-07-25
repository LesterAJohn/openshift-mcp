import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_VAULT_UNSEAL_KEY_PATH = path.resolve(
  process.cwd(),
  "src/config/vault.unseal.key.json"
);

const UNSEAL_KEY_LENGTH = 24;

function isValidKey(value) {
  return typeof value === "string" && value.trim().length === UNSEAL_KEY_LENGTH;
}

function generateKey() {
  return crypto.randomBytes(32).toString("base64url").slice(0, UNSEAL_KEY_LENGTH);
}

function readKeyFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return "";
  }

  const parsed = JSON.parse(raw);
  const candidate = parsed.unsealKey ?? parsed.key ?? "";
  return typeof candidate === "string" ? candidate.trim() : "";
}

export function persistVaultUnsealKey(key, filePath = DEFAULT_VAULT_UNSEAL_KEY_PATH) {
  if (!isValidKey(key)) {
    throw new Error(`Vault unseal key must be exactly ${UNSEAL_KEY_LENGTH} characters`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ unsealKey: key, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 }
  );

  // Ensure restrictive permissions even when file already existed.
  fs.chmodSync(filePath, 0o600);
}

export function resolveVaultUnsealKey({
  env = process.env,
  filePath = DEFAULT_VAULT_UNSEAL_KEY_PATH,
  createIfMissing = true
} = {}) {
  const fromEnv = String(env.VAULT_UNSEAL_KEY ?? "").trim();
  if (isValidKey(fromEnv)) {
    return {
      key: fromEnv,
      source: "env",
      filePath
    };
  }

  const fromFile = readKeyFromFile(filePath);
  if (isValidKey(fromFile)) {
    return {
      key: fromFile,
      source: "file",
      filePath
    };
  }

  if (!createIfMissing) {
    return {
      key: "",
      source: "none",
      filePath
    };
  }

  const generated = generateKey();
  persistVaultUnsealKey(generated, filePath);

  return {
    key: generated,
    source: "generated",
    filePath
  };
}
