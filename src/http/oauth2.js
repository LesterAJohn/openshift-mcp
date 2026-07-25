function parseScopes(scopeValue) {
  return String(scopeValue ?? "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function parseAudience(audValue) {
  if (Array.isArray(audValue)) {
    return audValue.map((item) => String(item));
  }

  if (typeof audValue === "string") {
    return [audValue];
  }

  return [];
}

export function createOAuth2IntrospectionVerifier({
  introspectionUrl,
  clientId,
  clientSecret,
  requiredScopes,
  requiredAudience,
  timeoutMs,
  cacheTtlMs,
  logger = console
}) {
  if (!introspectionUrl) {
    throw new Error("OAuth2 introspection URL is required when OAuth2 auth mode is enabled");
  }

  const cache = new Map();

  async function introspectToken(token) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const body = new URLSearchParams({ token });
      if (clientId && !clientSecret) {
        body.set("client_id", clientId);
      }

      const headers = {
        "content-type": "application/x-www-form-urlencoded"
      };

      if (clientId && clientSecret) {
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
        headers.authorization = `Basic ${credentials}`;
      }

      const response = await fetch(introspectionUrl, {
        method: "POST",
        headers,
        body: body.toString(),
        signal: controller.signal
      });

      if (!response.ok) {
        logger.warn(`OAuth2 introspection failed with status ${response.status}`);
        return { ok: false, reason: "introspection_failed" };
      }

      const payload = await response.json();
      if (!payload || payload.active !== true) {
        return { ok: false, reason: "inactive_token" };
      }

      if (payload.exp && Number(payload.exp) * 1000 <= Date.now()) {
        return { ok: false, reason: "expired_token" };
      }

      const tokenScopes = new Set(parseScopes(payload.scope));
      for (const scope of requiredScopes) {
        if (!tokenScopes.has(scope)) {
          return { ok: false, reason: `missing_scope:${scope}` };
        }
      }

      const tokenAudience = parseAudience(payload.aud);
      if (requiredAudience && !tokenAudience.includes(requiredAudience)) {
        return { ok: false, reason: "invalid_audience" };
      }

      return {
        ok: true,
        metadata: {
          clientId: payload.client_id ?? null,
          subject: payload.sub ?? null,
          scopes: Array.from(tokenScopes),
          audience: tokenAudience
        }
      };
    } catch (error) {
      logger.warn("OAuth2 introspection request failed", error);
      return { ok: false, reason: "introspection_error" };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async verify(token) {
      if (!token) {
        return { ok: false, reason: "missing_token" };
      }

      const cached = cache.get(token);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.result;
      }

      const result = await introspectToken(token);
      cache.set(token, {
        result,
        expiresAt: Date.now() + cacheTtlMs
      });
      return result;
    }
  };
}
