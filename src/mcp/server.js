import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  createVaultTokenEntry,
  getVaultTokenIndexPath,
  mergeVaultTokenIndex,
  normalizeAppName,
  normalizeUserIdForPath,
  sha256Hex
} from "../config/vaultAuthTokenIndex.js";
import { redactObject } from "../services/security.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalizeMethod(method) {
  return String(method ?? "GET").trim().toUpperCase();
}

function normalizePath(path) {
  const raw = String(path ?? "").trim();
  if (!raw) {
    return "/";
  }

  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizeTokenPathPrefix(value) {
  return String(value ?? "openshift/tokens/users").trim().replace(/^\/+|\/+$/g, "") || "openshift/tokens/users";
}

export function createMcpServer({
  name,
  version,
  serviceClient,
  configStore,
  vaultService,
  appName,
  defaultUserId = "default",
  allowSensitiveOutput = false,
  tokenSecretPathPrefix = "openshift/tokens/users",
  tokenIndexPath,
  tokenMetadataConfigKeyPrefix = "openshift.token.metadata"
}) {
  const server = new McpServer({
    name,
    version
  });

  const adminAuthKey = process.env.MCP_ADMIN_AUTH_KEY;
  const normalizedAppName = normalizeAppName(appName ?? process.env.APP_NAME ?? "openshift");
  const resolvedDefaultUserId = String(defaultUserId ?? "default").trim() || "default";
  const normalizedTokenPathPrefix = normalizeTokenPathPrefix(tokenSecretPathPrefix);
  const resolvedTokenIndexPath = String(tokenIndexPath ?? getVaultTokenIndexPath(normalizedAppName)).trim();

  function asText(value) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(value, null, 2)
        }
      ]
    };
  }

  function classifyToolError(error) {
    const status = Number(error?.status ?? error?.statusCode ?? 500);
    const message = error instanceof Error ? error.message : String(error);

    return {
      ok: false,
      status: Number.isFinite(status) ? status : 500,
      error: message,
      details: error?.response ? redactObject(error.response, allowSensitiveOutput) : undefined
    };
  }

  function withErrorHandling(handler) {
    return async (args) => {
      try {
        return asText(await handler(args));
      } catch (error) {
        return {
          ...asText(classifyToolError(error)),
          isError: true
        };
      }
    };
  }

  function assertAuthorized(authorizationKey) {
    if (!adminAuthKey) {
      return;
    }

    if (!authorizationKey || authorizationKey !== adminAuthKey) {
      const unauthorized = new Error("Unauthorized: invalid authorizationKey for mutating operation");
      unauthorized.status = 401;
      throw unauthorized;
    }
  }

  function resolveUserId(userId) {
    return String(userId ?? resolvedDefaultUserId).trim() || resolvedDefaultUserId;
  }

  function getTokenSecretPath(userId) {
    return `${normalizedTokenPathPrefix}/${normalizeUserIdForPath(resolveUserId(userId))}`;
  }

  function getTokenMetadataConfigKey(userId) {
    return `${tokenMetadataConfigKeyPrefix}.${resolveUserId(userId)}`;
  }

  function getScopeModel(userId = resolvedDefaultUserId) {
    const resolvedUserId = resolveUserId(userId);
    return {
      appName: normalizedAppName,
      userId: resolvedUserId,
      userIdPathSegment: normalizeUserIdForPath(resolvedUserId),
      postgres: {
        tableName: `${normalizedAppName}_config`,
        primaryKey: ["user_id", "key"],
        scope: "app_and_user"
      },
      vault: {
        tokenSecretPath: getTokenSecretPath(resolvedUserId),
        tokenIndexPath: resolvedTokenIndexPath,
        scope: "app_and_user"
      }
    };
  }

  async function readUserTokenPayload(userId) {
    const payload = await vaultService.getSecret(getTokenSecretPath(userId));
    return payload && typeof payload === "object" ? payload : {};
  }

  async function readIndexPayload() {
    const payload = await vaultService.getSecret(resolvedTokenIndexPath);
    return payload && typeof payload === "object" ? payload : {};
  }

  async function persistTokenMetadata(userId, metadata) {
    const key = getTokenMetadataConfigKey(userId);
    return configStore.setConfig(key, metadata, resolveUserId(userId));
  }

  server.tool(
    "openshift_connection_info",
    "Return OpenShift MCP server, persistence, and scope model details.",
    {
      userId: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId }) => {
      const scope = getScopeModel(userId);
      const [postgresHealth, vaultHealth] = await Promise.all([configStore.healthcheck(), vaultService.healthcheck()]);

      return {
        ok: true,
        status: 200,
        data: {
          server: {
            name,
            version,
            adminAuthConfigured: Boolean(adminAuthKey),
            allowSensitiveOutput,
            scopeModel: scope
          },
          openshift: serviceClient.getConnectionInfo(),
          persistence: {
            postgres: postgresHealth,
            vault: vaultHealth
          }
        }
      };
    })
  );

  server.tool(
    "openshift_health_check",
    "Call OpenShift API server health endpoint.",
    {
      userId: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId }) => {
      const tokenPayload = await readUserTokenPayload(userId);
      const bearerToken = String(tokenPayload.token ?? "").trim();

      return {
        ok: true,
        status: 200,
        data: await serviceClient.healthCheck({ bearerToken })
      };
    })
  );

  server.tool(
    "openshift_list_endpoints",
    "List OpenShift endpoints exposed by this MCP server.",
    {},
    withErrorHandling(async () => ({
      ok: true,
      status: 200,
      data: {
        endpoints: serviceClient.listKnownEndpoints()
      }
    }))
  );

  server.tool(
    "openshift_list_projects",
    "List OpenShift projects using the user's Vault-managed token.",
    {
      userId: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId }) => {
      const tokenPayload = await readUserTokenPayload(userId);
      const bearerToken = String(tokenPayload.token ?? "").trim();

      return {
        ok: true,
        status: 200,
        data: await serviceClient.listProjects({ bearerToken })
      };
    })
  );

  server.tool(
    "openshift_get_project",
    "Get details for one OpenShift project.",
    {
      projectName: z.string().min(1),
      userId: z.string().min(1).optional()
    },
    withErrorHandling(async ({ projectName, userId }) => {
      const tokenPayload = await readUserTokenPayload(userId);
      const bearerToken = String(tokenPayload.token ?? "").trim();

      return {
        ok: true,
        status: 200,
        data: await serviceClient.getProject(projectName, { bearerToken })
      };
    })
  );

  server.tool(
    "openshift_list_pods",
    "List pods for an OpenShift namespace.",
    {
      namespace: z.string().min(1),
      labelSelector: z.string().min(1).optional(),
      fieldSelector: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    withErrorHandling(async ({ namespace, labelSelector, fieldSelector, userId }) => {
      const tokenPayload = await readUserTokenPayload(userId);
      const bearerToken = String(tokenPayload.token ?? "").trim();

      return {
        ok: true,
        status: 200,
        data: await serviceClient.listPods(namespace, {
          labelSelector,
          fieldSelector,
          bearerToken
        })
      };
    })
  );

  server.tool(
    "openshift_api_request",
    "Generic OpenShift API request with user-scoped token resolution and mutating auth guard.",
    {
      method: z.string().min(1),
      path: z.string().min(1),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.unknown().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      userId: z.string().min(1).optional(),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({ method, path, query, body, headers, userId, authorizationKey }) => {
      const normalizedMethod = normalizeMethod(method);
      const normalizedPath = normalizePath(path);
      if (MUTATING_METHODS.has(normalizedMethod)) {
        assertAuthorized(authorizationKey);
      }

      const tokenPayload = await readUserTokenPayload(userId);
      const bearerToken = String(tokenPayload.token ?? "").trim();

      return {
        ok: true,
        status: 200,
        data: await serviceClient.request({
          method: normalizedMethod,
          path: normalizedPath,
          query,
          body,
          headers,
          bearerToken
        })
      };
    })
  );

  server.tool(
    "openshift_set_user_token",
    "Set or rotate a user-scoped OpenShift bearer token. Token is stored in Vault, metadata in Postgres, and index entry in Vault.",
    {
      userId: z.string().min(1),
      token: z.string().min(1),
      tokenId: z.string().min(1).optional(),
      expiresAt: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).optional(),
      audience: z.array(z.string().min(1)).optional(),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId, token, tokenId, expiresAt, scopes, audience, authorizationKey }) => {
      assertAuthorized(authorizationKey);
      const resolvedUserId = resolveUserId(userId);

      const { tokenHash, entry } = createVaultTokenEntry({
        userId: resolvedUserId,
        token,
        tokenId,
        expiresAt,
        scopes,
        audience,
        tokenType: "openshift-bearer"
      });

      await vaultService.setSecret(getTokenSecretPath(resolvedUserId), {
        token,
        tokenId: entry.tokenId,
        updatedAt: new Date().toISOString(),
        tokenHash
      });

      const existingIndex = await readIndexPayload();
      const mergedIndex = mergeVaultTokenIndex(existingIndex, {
        userId: resolvedUserId,
        tokenHash,
        entry
      });
      await vaultService.setSecret(resolvedTokenIndexPath, mergedIndex);

      const metadata = {
        userId: resolvedUserId,
        tokenId: entry.tokenId,
        tokenHash,
        active: true,
        scopes: entry.scopes,
        audience: entry.audience,
        expiresAt: entry.expiresAt ?? null,
        updatedAt: new Date().toISOString()
      };
      await persistTokenMetadata(resolvedUserId, metadata);

      return {
        ok: true,
        status: 200,
        data: redactObject(
          {
            userId: resolvedUserId,
            tokenSecretPath: getTokenSecretPath(resolvedUserId),
            tokenIndexPath: resolvedTokenIndexPath,
            metadata
          },
          allowSensitiveOutput
        )
      };
    })
  );

  server.tool(
    "openshift_get_user_token_metadata",
    "Get user token metadata from Postgres and current Vault token index state.",
    {
      userId: z.string().min(1)
    },
    withErrorHandling(async ({ userId }) => {
      const resolvedUserId = resolveUserId(userId);
      const metadataKey = getTokenMetadataConfigKey(resolvedUserId);
      const metadataRecord = await configStore.getConfig(metadataKey, resolvedUserId);

      const tokenPayload = await readUserTokenPayload(resolvedUserId);
      const tokenHash = String(tokenPayload.tokenHash ?? "").trim() || sha256Hex(String(tokenPayload.token ?? ""));
      const indexPayload = await readIndexPayload();
      const indexEntry =
        indexPayload?.tokens && typeof indexPayload.tokens === "object" ? indexPayload.tokens[tokenHash] : null;

      return {
        ok: true,
        status: 200,
        data: redactObject(
          {
            userId: resolvedUserId,
            tokenSecretPath: getTokenSecretPath(resolvedUserId),
            tokenConfigured: Boolean(tokenPayload?.token),
            metadata: metadataRecord?.value ?? null,
            indexEntry: indexEntry ?? null
          },
          allowSensitiveOutput
        )
      };
    })
  );

  server.tool(
    "openshift_deactivate_user_token",
    "Deactivate a user token in Vault index and remove the direct user token secret.",
    {
      userId: z.string().min(1),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId, authorizationKey }) => {
      assertAuthorized(authorizationKey);
      const resolvedUserId = resolveUserId(userId);
      const tokenPayload = await readUserTokenPayload(resolvedUserId);
      const tokenHash = String(tokenPayload.tokenHash ?? "").trim() || sha256Hex(String(tokenPayload.token ?? ""));

      const existingIndex = await readIndexPayload();
      const tokenMap =
        existingIndex && typeof existingIndex === "object" && existingIndex.tokens && typeof existingIndex.tokens === "object"
          ? existingIndex.tokens
          : {};
      const currentEntry = tokenMap[tokenHash] && typeof tokenMap[tokenHash] === "object" ? tokenMap[tokenHash] : null;
      const updatedEntry = {
        ...(currentEntry ?? {}),
        userId: resolvedUserId,
        active: false,
        revokedAt: new Date().toISOString()
      };

      const mergedIndex = mergeVaultTokenIndex(existingIndex, {
        userId: resolvedUserId,
        tokenHash,
        entry: updatedEntry
      });
      await vaultService.setSecret(resolvedTokenIndexPath, mergedIndex);
      await vaultService.deleteSecret(getTokenSecretPath(resolvedUserId));

      const metadata = {
        userId: resolvedUserId,
        tokenHash,
        active: false,
        revokedAt: updatedEntry.revokedAt,
        updatedAt: new Date().toISOString()
      };
      await persistTokenMetadata(resolvedUserId, metadata);

      return {
        ok: true,
        status: 200,
        data: {
          userId: resolvedUserId,
          tokenSecretPath: getTokenSecretPath(resolvedUserId),
          tokenIndexPath: resolvedTokenIndexPath,
          active: false
        }
      };
    })
  );

  server.tool(
    "config_get",
    "Read user-scoped configuration from Postgres.",
    {
      key: z.string().min(1),
      userId: z.string().min(1).optional()
    },
    withErrorHandling(async ({ key, userId }) => {
      const resolvedUserId = resolveUserId(userId);
      const record = await configStore.getConfig(key, resolvedUserId);
      return {
        ok: true,
        status: 200,
        data: {
          userId: resolvedUserId,
          key,
          value: record?.value ?? null,
          updatedAt: record?.updated_at ?? null
        }
      };
    })
  );

  server.tool(
    "config_set",
    "Write user-scoped configuration to Postgres.",
    {
      key: z.string().min(1),
      value: z.unknown(),
      userId: z.string().min(1).optional(),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({ key, value, userId, authorizationKey }) => {
      assertAuthorized(authorizationKey);
      const resolvedUserId = resolveUserId(userId);
      const record = await configStore.setConfig(key, value, resolvedUserId);
      return {
        ok: true,
        status: 200,
        data: {
          userId: resolvedUserId,
          key,
          value: record?.value ?? null,
          updatedAt: record?.updated_at ?? null
        }
      };
    })
  );

  return server;
}
