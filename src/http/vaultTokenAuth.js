import { createHash } from "node:crypto";

function parseScopes(value) {
  if (Array.isArray(value)) {
    return value.map((scope) => String(scope)).filter(Boolean);
  }

  return String(value ?? "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function parseAudience(value) {
  if (Array.isArray(value)) {
    return value.map((audience) => String(audience)).filter(Boolean);
  }

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return [];
}

function parseUserTokenEntry(userEntry, tokenHashHex) {
  if (!userEntry || typeof userEntry !== "object") {
    return null;
  }

  if (userEntry[tokenHashHex] && typeof userEntry[tokenHashHex] === "object") {
    return userEntry[tokenHashHex];
  }

  if (userEntry.tokens && typeof userEntry.tokens === "object") {
    const tokenEntry = userEntry.tokens[tokenHashHex];
    if (tokenEntry && typeof tokenEntry === "object") {
      return tokenEntry;
    }
  }

  return null;
}

function resolveTokenEntry(indexPayload, tokenHashHex, defaultUserId) {
  if (!indexPayload || typeof indexPayload !== "object") {
    return null;
  }

  if (indexPayload[tokenHashHex] && typeof indexPayload[tokenHashHex] === "object") {
    return {
      tokenEntry: indexPayload[tokenHashHex],
      resolvedUserId: indexPayload[tokenHashHex].userId ?? null
    };
  }

  if (indexPayload.tokens && typeof indexPayload.tokens === "object") {
    const tokenEntry = indexPayload.tokens[tokenHashHex];
    if (tokenEntry && typeof tokenEntry === "object") {
      return {
        tokenEntry,
        resolvedUserId: tokenEntry.userId ?? null
      };
    }
  }

  if (indexPayload.users && typeof indexPayload.users === "object") {
    const users = indexPayload.users;
    const candidateDefaultUserId =
      String(indexPayload.defaultUserId ?? "").trim() || String(defaultUserId ?? "").trim() || "default";

    // First, honor explicit non-default user mappings.
    for (const [userId, userEntry] of Object.entries(users)) {
      if (userId === candidateDefaultUserId) {
        continue;
      }

      const tokenEntry = parseUserTokenEntry(userEntry, tokenHashHex);
      if (tokenEntry) {
        return {
          tokenEntry,
          resolvedUserId: tokenEntry.userId ?? userId
        };
      }
    }

    // Then check default user.
    const defaultUserEntry = users[candidateDefaultUserId];
    const defaultTokenEntry = parseUserTokenEntry(defaultUserEntry, tokenHashHex);
    if (defaultTokenEntry) {
      return {
        tokenEntry: defaultTokenEntry,
        resolvedUserId: defaultTokenEntry.userId ?? candidateDefaultUserId
      };
    }

    // If no non-default users exist, default user is always the fallback.
    const nonDefaultUserIds = Object.keys(users).filter((userId) => userId !== candidateDefaultUserId);
    if (nonDefaultUserIds.length === 0 && defaultUserEntry && typeof defaultUserEntry === "object") {
      const nestedFallback = parseUserTokenEntry(defaultUserEntry, tokenHashHex);
      if (nestedFallback) {
        return {
          tokenEntry: nestedFallback,
          resolvedUserId: nestedFallback.userId ?? candidateDefaultUserId
        };
      }

      const directFallback =
        defaultUserEntry[tokenHashHex] && typeof defaultUserEntry[tokenHashHex] === "object"
          ? defaultUserEntry[tokenHashHex]
          : null;
      if (directFallback) {
        return {
          tokenEntry: directFallback,
          resolvedUserId: directFallback.userId ?? candidateDefaultUserId
        };
      }
    }
  }

  return null;
}

function isExpired(expiresAtValue) {
  if (!expiresAtValue) {
    return false;
  }

  if (typeof expiresAtValue === "number") {
    return expiresAtValue * 1000 <= Date.now();
  }

  const parsed = Date.parse(String(expiresAtValue));
  return Number.isFinite(parsed) ? parsed <= Date.now() : false;
}

export function createVaultTokenVerifier({
  vaultService,
  indexPath,
  defaultUserId = "default",
  requiredScopes,
  requiredAudience,
  cacheTtlMs,
  logger = console
}) {
  if (!vaultService) {
    throw new Error("vaultService is required for Vault token verification");
  }

  if (!indexPath) {
    throw new Error("Vault token index path is required");
  }

  const cache = {
    expiresAt: 0,
    payload: null
  };

  async function getIndexPayload() {
    if (cache.payload && cache.expiresAt > Date.now()) {
      return cache.payload;
    }

    try {
      const payload = await vaultService.getSecret(indexPath);
      cache.payload = payload ?? {};
      cache.expiresAt = Date.now() + Math.max(cacheTtlMs, 1);
      return cache.payload;
    } catch (error) {
      logger.warn("Failed to read Vault token index", error);
      return null;
    }
  }

  return {
    async verify(token) {
      if (!token) {
        return { ok: false, reason: "missing_token" };
      }

      const indexPayload = await getIndexPayload();
      if (!indexPayload) {
        return { ok: false, reason: "index_unavailable" };
      }

      const tokenHashHex = createHash("sha256").update(token).digest("hex");
      const resolved = resolveTokenEntry(indexPayload, tokenHashHex, defaultUserId);
      if (!resolved) {
        return { ok: false, reason: "token_not_found" };
      }

      const { tokenEntry, resolvedUserId } = resolved;

      if (tokenEntry.active === false) {
        return { ok: false, reason: "token_inactive" };
      }

      if (isExpired(tokenEntry.expiresAt)) {
        return { ok: false, reason: "token_expired" };
      }

      const tokenScopes = new Set(parseScopes(tokenEntry.scopes));
      for (const requiredScope of requiredScopes) {
        if (!tokenScopes.has(requiredScope)) {
          return { ok: false, reason: `missing_scope:${requiredScope}` };
        }
      }

      const tokenAudience = parseAudience(tokenEntry.audience);
      if (requiredAudience && !tokenAudience.includes(requiredAudience)) {
        return { ok: false, reason: "invalid_audience" };
      }

      return {
        ok: true,
        metadata: {
          userId: tokenEntry.userId ?? resolvedUserId ?? defaultUserId,
          tokenId: tokenEntry.tokenId ?? null,
          scopes: Array.from(tokenScopes),
          audience: tokenAudience
        }
      };
    }
  };
}
