import { createHash, randomBytes, randomUUID } from "node:crypto";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeList(value, fallback = []) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [...fallback];
}

export function normalizeAppName(appName) {
  return String(appName ?? "openshift").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "openshift";
}

export function normalizeUserIdForPath(userId) {
  return String(userId ?? "default").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "default";
}

export function getVaultTokenIndexPath(appName) {
  return `${normalizeAppName(appName)}/http/auth/token-index`;
}

export function getVaultUserTokenIndexPath(appName, userId) {
  return `${normalizeAppName(appName)}/users/${normalizeUserIdForPath(userId)}/http/auth/token-index`;
}

export function createBearerToken({ byteLength = 32 } = {}) {
  return randomBytes(byteLength).toString("base64url");
}

export function createTokenId() {
  return `tok-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function createVaultTokenEntry({
  userId,
  tokenId,
  token,
  scopes,
  audience,
  expiresAt,
  tokenType = "bearer"
}) {
  const resolvedUserId = String(userId ?? "default").trim() || "default";
  const resolvedTokenId = String(tokenId ?? "").trim() || createTokenId();
  const resolvedScopes = normalizeList(scopes, ["mcp:invoke", "mcp:read"]);
  const resolvedAudience = normalizeList(audience, ["codex"]);
  const tokenValue = String(token ?? "").trim();
  const resolvedTokenType = String(tokenType ?? "bearer").trim().toLowerCase() || "bearer";

  if (!tokenValue) {
    throw new Error("Token value is required");
  }

  const entry = {
    userId: resolvedUserId,
    tokenId: resolvedTokenId,
    active: true,
    scopes: resolvedScopes,
    audience: resolvedAudience,
    tokenType: resolvedTokenType,
    createdAt: new Date().toISOString()
  };

  if (expiresAt) {
    entry.expiresAt = String(expiresAt);
  }

  return {
    token: tokenValue,
    tokenHash: sha256Hex(tokenValue),
    entry
  };
}

function mergeTokenMaps(existingMap, tokenHash, entry) {
  const currentMap = isPlainObject(existingMap) ? existingMap : {};
  return {
    ...currentMap,
    [tokenHash]: entry
  };
}

function mergeUserTokenEntry(existingUserEntry, tokenHash, entry) {
  const currentUserEntry = isPlainObject(existingUserEntry) ? existingUserEntry : {};
  return {
    ...currentUserEntry,
    tokens: mergeTokenMaps(currentUserEntry.tokens, tokenHash, entry)
  };
}

export function mergeVaultTokenIndex(existingPayload, { userId, tokenHash, entry }) {
  const resolvedUserId = String(userId ?? entry.userId ?? "default").trim() || "default";
  const currentPayload = isPlainObject(existingPayload) ? existingPayload : {};
  const users = isPlainObject(currentPayload.users) ? currentPayload.users : {};
  const tokens = isPlainObject(currentPayload.tokens) ? currentPayload.tokens : {};

  return {
    ...currentPayload,
    defaultUserId: String(currentPayload.defaultUserId ?? resolvedUserId).trim() || resolvedUserId,
    tokens: mergeTokenMaps(tokens, tokenHash, entry),
    users: {
      ...users,
      [resolvedUserId]: mergeUserTokenEntry(users[resolvedUserId], tokenHash, entry)
    }
  };
}
