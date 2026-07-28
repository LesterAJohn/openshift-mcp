import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { timingSafeEqual } from "node:crypto";
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

const HIGH_RISK_TOOLS = new Set([
  "openshift_resource_request",
  "openshift_api_request",
  "openshift_set_user_token",
  "openshift_deactivate_user_token",
  "mcp_admin_auth_rotate",
  "redshift_set_cluster",
  "redshift_remove_cluster",
  "redshift_query"
]);

const MUTATING_TOOLS = new Set([
  "openshift_scale_deployment",
  "openshift_rollout_restart",
  "config_set"
]);

function inferToolRisk(toolName) {
  if (HIGH_RISK_TOOLS.has(toolName)) {
    return "high-risk";
  }
  if (MUTATING_TOOLS.has(toolName)) {
    return "mutating";
  }
  return "read-only";
}

function inferToolCategory(toolName) {
  if (toolName.startsWith("openshift_")) {
    return "openshift";
  }
  if (toolName.startsWith("redshift_")) {
    return "redshift";
  }
  if (toolName.startsWith("mcp_admin_auth_")) {
    return "admin-auth";
  }
  if (toolName.startsWith("config_")) {
    return "config";
  }
  if (toolName.startsWith("mcp_")) {
    return "meta";
  }
  return "other";
}

function splitWords(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function getZodShape(schema) {
  const shapeSource = schema?._def?.shape;
  if (!shapeSource) {
    return {};
  }
  return typeof shapeSource === "function" ? shapeSource() : shapeSource;
}

function unwrapZodType(schema) {
  let current = schema;
  let required = true;
  let hasDefault = false;
  let nullable = false;

  while (current?._def?.typeName) {
    const typeName = current._def.typeName;
    if (typeName === "ZodOptional") {
      required = false;
      current = current._def.innerType;
      continue;
    }
    if (typeName === "ZodDefault") {
      required = false;
      hasDefault = true;
      current = current._def.innerType;
      continue;
    }
    if (typeName === "ZodNullable") {
      nullable = true;
      current = current._def.innerType;
      continue;
    }
    break;
  }

  return {
    baseSchema: current,
    required,
    hasDefault,
    nullable
  };
}

function describeZodType(schema) {
  const typeName = schema?._def?.typeName;
  switch (typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodArray":
      return `array<${describeZodType(schema._def.type)}>`;
    case "ZodEnum": {
      const values = Array.isArray(schema?._def?.values) ? schema._def.values : [];
      return values.length ? `enum(${values.join("|")})` : "enum";
    }
    case "ZodObject":
      return "object";
    case "ZodRecord":
      return "record";
    case "ZodUnknown":
      return "unknown";
    case "ZodAny":
      return "any";
    default:
      return "value";
  }
}

function getParameterExample(name, schema) {
  const { baseSchema } = unwrapZodType(schema);
  const typeName = baseSchema?._def?.typeName;
  const key = String(name ?? "");

  if (key === "userId") return "default";
  if (key === "authorizationKey") return "<admin-authorization-key>";
  if (key === "namespace") return "default";
  if (key === "projectName") return "my-project";
  if (key === "clusterId") return "analytics";
  if (key === "sql") return "select 1";
  if (key === "apiVersion") return "v1";
  if (key === "resource") return "pods";
  if (key === "path") return "/api/v1/nodes";
  if (key === "method") return "GET";
  if (key === "token") return "<openshift-bearer-token>";
  if (key === "key") return "feature.flag.example";

  switch (typeName) {
    case "ZodString":
      return `<${key || "value"}>`;
    case "ZodNumber":
      return 1;
    case "ZodBoolean":
      return true;
    case "ZodEnum": {
      const values = Array.isArray(baseSchema?._def?.values) ? baseSchema._def.values : [];
      return values[0] ?? null;
    }
    case "ZodArray":
      return [];
    case "ZodObject":
    case "ZodRecord":
      return {};
    default:
      return null;
  }
}

function summarizeToolSchema(schema) {
  const shape = getZodShape(schema);
  return Object.entries(shape).map(([name, value]) => {
    const unwrapped = unwrapZodType(value);
    return {
      name,
      type: describeZodType(unwrapped.baseSchema),
      required: unwrapped.required,
      hasDefault: unwrapped.hasDefault,
      nullable: unwrapped.nullable
    };
  });
}

function buildExampleArgs(schema) {
  const shape = getZodShape(schema);
  const requiredArgs = {};
  for (const [name, value] of Object.entries(shape)) {
    const unwrapped = unwrapZodType(value);
    if (!unwrapped.required) {
      continue;
    }
    const example = getParameterExample(name, value);
    if (example !== null) {
      requiredArgs[name] = example;
    }
  }
  return requiredArgs;
}

function scoreToolForIntent(toolName, description, intentWords) {
  if (!intentWords.length) {
    return 0;
  }

  const haystack = new Set([...splitWords(toolName), ...splitWords(description)]);
  let score = 0;
  for (const word of intentWords) {
    if (haystack.has(word)) {
      score += 3;
    }
    if (toolName.includes(word)) {
      score += 2;
    }
  }

  const intentText = intentWords.join(" ");
  if (intentText.includes("discover") || intentText.includes("schema")) {
    if (toolName.includes("discover") || toolName.includes("resource_request")) {
      score += 2;
    }
  }
  if (intentText.includes("redshift") || intentText.includes("sql") || intentText.includes("query")) {
    if (toolName.startsWith("redshift_")) {
      score += 3;
    }
  }
  if (intentText.includes("auth") || intentText.includes("token")) {
    if (toolName.startsWith("mcp_admin_auth_") || toolName.includes("token")) {
      score += 3;
    }
  }

  return score;
}

export function createMcpServer({
  name,
  version,
  serviceClient,
  configStore,
  vaultService,
  redshiftService,
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

  const normalizedAppName = normalizeAppName(appName ?? process.env.APP_NAME ?? "openshift");
  const adminAuthSecretPath = `${normalizedAppName}/admin/auth`;
  const envAdminAuthKey = String(process.env.MCP_ADMIN_AUTH_KEY ?? "").trim();
  const envAdminAuthKeyHash = envAdminAuthKey ? sha256Hex(envAdminAuthKey) : "";
  let adminAuthState = {
    loaded: false,
    configured: Boolean(envAdminAuthKeyHash),
    keyHash: envAdminAuthKeyHash,
    source: envAdminAuthKeyHash ? "env" : "none",
    rotatedAt: null
  };
  const resolvedDefaultUserId = String(defaultUserId ?? "default").trim() || "default";
  const normalizedTokenPathPrefix = normalizeTokenPathPrefix(tokenSecretPathPrefix);
  const resolvedTokenIndexPath = String(tokenIndexPath ?? getVaultTokenIndexPath(normalizedAppName)).trim();
  const redshiftConfigKeyPrefix = "redshift.cluster.";

  function normalizeClusterId(clusterId) {
    const normalized = String(clusterId ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(normalized)) {
      const error = new Error("clusterId must use 1-63 lowercase letters, numbers, hyphens, or underscores");
      error.status = 400;
      throw error;
    }
    return normalized;
  }

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

  function hashesMatch(left, right) {
    if (!left || !right || left.length !== right.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  }

  async function loadAdminAuthState({ force = false } = {}) {
    if (adminAuthState.loaded && !force) {
      return adminAuthState;
    }

    let payload;
    try {
      payload = await vaultService.getSecret(adminAuthSecretPath);
    } catch (error) {
      error.status = Number(error?.status ?? 503);
      throw error;
    }

    const keyHash = String(payload?.keyHash ?? "").trim();
    if (keyHash) {
      adminAuthState = {
        loaded: true,
        configured: true,
        keyHash,
        source: "vault",
        rotatedAt: payload?.rotatedAt ?? payload?.migratedAt ?? null
      };
      return adminAuthState;
    }

    if (envAdminAuthKeyHash) {
      const migratedAt = new Date().toISOString();
      await vaultService.setSecret(adminAuthSecretPath, {
        keyHash: envAdminAuthKeyHash,
        migratedAt
      });
      adminAuthState = {
        loaded: true,
        configured: true,
        keyHash: envAdminAuthKeyHash,
        source: "vault",
        rotatedAt: migratedAt
      };
      return adminAuthState;
    }

    adminAuthState = {
      loaded: true,
      configured: false,
      keyHash: "",
      source: "none",
      rotatedAt: null
    };
    return adminAuthState;
  }

  async function assertAuthorized(authorizationKey) {
    const state = await loadAdminAuthState();
    if (!state.configured) {
      return;
    }

    const candidateHash = authorizationKey ? sha256Hex(authorizationKey) : "";
    if (!hashesMatch(candidateHash, state.keyHash)) {
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

  function getRedshiftConfigKey(clusterId) {
    return `${redshiftConfigKeyPrefix}${normalizeClusterId(clusterId)}`;
  }

  function getRedshiftSecretPath(userId, clusterId) {
    return `${normalizedAppName}/redshift/users/${normalizeUserIdForPath(resolveUserId(userId))}/clusters/${normalizeClusterId(clusterId)}`;
  }

  async function readRedshiftConnection(userId, clusterId) {
    const resolvedUserId = resolveUserId(userId);
    const normalizedClusterId = normalizeClusterId(clusterId);
    const [configRecord, credentials] = await Promise.all([
      configStore.getConfig(getRedshiftConfigKey(normalizedClusterId), resolvedUserId),
      vaultService.getSecret(getRedshiftSecretPath(resolvedUserId, normalizedClusterId))
    ]);

    if (!configRecord) {
      const error = new Error(`Redshift cluster not found: ${normalizedClusterId}`);
      error.status = 404;
      throw error;
    }
    if (!credentials?.username || !credentials?.password) {
      const error = new Error(`Redshift credentials are missing for cluster: ${normalizedClusterId}`);
      error.status = 422;
      throw error;
    }

    return {
      clusterId: normalizedClusterId,
      metadata: configRecord.value,
      connection: { ...configRecord.value, ...credentials }
    };
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

  function registerOpenShiftReadTool(toolName, description, schema, operation) {
    server.tool(
      toolName,
      description,
      schema,
      withErrorHandling(async (args) => {
        const tokenPayload = await readUserTokenPayload(args.userId);
        const bearerToken = String(tokenPayload.token ?? "").trim();
        return {
          ok: true,
          status: 200,
          data: await operation(args, bearerToken)
        };
      })
    );
  }

  function registerOpenShiftMutatingTool(toolName, description, schema, operation) {
    server.tool(
      toolName,
      description,
      { ...schema, authorizationKey: z.string().min(1).optional() },
      withErrorHandling(async (args) => {
        await assertAuthorized(args.authorizationKey);
        const tokenPayload = await readUserTokenPayload(args.userId);
        const bearerToken = String(tokenPayload.token ?? "").trim();
        return {
          ok: true,
          status: 200,
          data: await operation(args, bearerToken)
        };
      })
    );
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
            adminAuthConfigured: (await loadAdminAuthState()).configured,
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
    "mcp_admin_auth_status",
    "Return MCP admin authorization status without exposing key material.",
    {},
    withErrorHandling(async () => {
      const state = await loadAdminAuthState();
      return {
        ok: true,
        status: 200,
        data: {
          configured: state.configured,
          source: state.source,
          vaultPath: adminAuthSecretPath,
          rotatedAt: state.rotatedAt
        }
      };
    })
  );

  server.tool(
    "mcp_admin_auth_verify",
    "Verify an MCP_ADMIN_AUTH_KEY-compatible authorization key.",
    {
      authorizationKey: z.string().min(1)
    },
    withErrorHandling(async ({ authorizationKey }) => {
      await assertAuthorized(authorizationKey);
      return {
        ok: true,
        status: 200,
        data: { authorized: true }
      };
    })
  );

  server.tool(
    "mcp_admin_auth_rotate",
    "Rotate MCP admin authorization into Vault. The current key is required and the new key is never returned.",
    {
      authorizationKey: z.string().min(1),
      newAuthorizationKey: z.string().min(16)
    },
    withErrorHandling(async ({ authorizationKey, newAuthorizationKey }) => {
      const currentState = await loadAdminAuthState();
      if (!currentState.configured) {
        const error = new Error("Admin authorization is not configured; bootstrap MCP_ADMIN_AUTH_KEY before rotation");
        error.status = 409;
        throw error;
      }

      await assertAuthorized(authorizationKey);
      const rotatedAt = new Date().toISOString();
      const keyHash = sha256Hex(newAuthorizationKey);
      await vaultService.setSecret(adminAuthSecretPath, { keyHash, rotatedAt });
      adminAuthState = {
        loaded: true,
        configured: true,
        keyHash,
        source: "vault",
        rotatedAt
      };

      return {
        ok: true,
        status: 200,
        data: {
          configured: true,
          source: "vault",
          vaultPath: adminAuthSecretPath,
          rotatedAt
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
    "openshift_discover_api_groups",
    "Discover every Kubernetes, OpenShift, aggregated, operator, and custom API group/version installed on the cluster.",
    {
      userId: z.string().min(1).optional()
    },
    withErrorHandling(async ({ userId }) => {
      const tokenPayload = await readUserTokenPayload(userId);
      const bearerToken = String(tokenPayload.token ?? "").trim();
      return {
        ok: true,
        status: 200,
        data: await serviceClient.discoverApiGroups({ bearerToken })
      };
    })
  );

  server.tool(
    "openshift_discover_api_resources",
    "Discover resources, scope, verbs, short names, categories, and subresources for an installed API version.",
    {
      apiVersion: z.string().min(1),
      userId: z.string().min(1).optional()
    },
    withErrorHandling(async ({ apiVersion, userId }) => {
      const tokenPayload = await readUserTokenPayload(userId);
      const bearerToken = String(tokenPayload.token ?? "").trim();
      return {
        ok: true,
        status: 200,
        data: await serviceClient.discoverApiResources(apiVersion, { bearerToken })
      };
    })
  );

  server.tool(
    "openshift_discover_openapi",
    "List OpenAPI v3 schemas or retrieve one schema using an api/... or apis/... path returned by the index.",
    {
      schemaPath: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    withErrorHandling(async ({ schemaPath, userId }) => {
      const tokenPayload = await readUserTokenPayload(userId);
      const bearerToken = String(tokenPayload.token ?? "").trim();
      return {
        ok: true,
        status: 200,
        data: await serviceClient.discoverOpenApi({ schemaPath, bearerToken })
      };
    })
  );

  server.tool(
    "openshift_resource_request",
    "Operate on any discovered core, OpenShift, aggregated, operator, or custom resource using structured coordinates.",
    {
      apiVersion: z.string().min(1),
      resource: z.string().min(1),
      namespace: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      subresource: z.string().min(1).optional(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.unknown().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      userId: z.string().min(1).optional(),
      authorizationKey: z.string().min(1).optional()
    },
    withErrorHandling(async ({
      apiVersion,
      resource,
      namespace,
      name,
      subresource,
      method,
      query,
      body,
      headers,
      userId,
      authorizationKey
    }) => {
      const normalizedMethod = normalizeMethod(method);
      if (MUTATING_METHODS.has(normalizedMethod)) {
        await assertAuthorized(authorizationKey);
      }

      const tokenPayload = await readUserTokenPayload(userId);
      const bearerToken = String(tokenPayload.token ?? "").trim();
      return {
        ok: true,
        status: 200,
        data: await serviceClient.resourceRequest({
          apiVersion,
          resource,
          namespace,
          name,
          subresource,
          method: normalizedMethod,
          query,
          body,
          headers,
          bearerToken
        })
      };
    })
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

  registerOpenShiftReadTool(
    "openshift_get_version",
    "Get the OpenShift and Kubernetes API server version.",
    { userId: z.string().min(1).optional() },
    (_args, bearerToken) => serviceClient.getVersion({ bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_get_pod",
    "Get one pod and its container/status details.",
    {
      namespace: z.string().min(1),
      podName: z.string().min(1),
      userId: z.string().min(1).optional()
    },
    ({ namespace, podName }, bearerToken) => serviceClient.getPod(namespace, podName, { bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_get_pod_logs",
    "Get pod logs with container, previous instance, time, and tail controls.",
    {
      namespace: z.string().min(1),
      podName: z.string().min(1),
      container: z.string().min(1).optional(),
      previous: z.boolean().optional(),
      tailLines: z.number().int().nonnegative().optional(),
      sinceSeconds: z.number().int().positive().optional(),
      timestamps: z.boolean().optional(),
      userId: z.string().min(1).optional()
    },
    ({ namespace, podName, container, previous, tailLines, sinceSeconds, timestamps }, bearerToken) =>
      serviceClient.getPodLogs(namespace, podName, {
        container,
        previous,
        tailLines,
        sinceSeconds,
        timestamps,
        bearerToken
      })
  );

  registerOpenShiftReadTool(
    "openshift_list_events",
    "List cluster or namespace events with field and event-type filters.",
    {
      namespace: z.string().min(1).optional(),
      fieldSelector: z.string().min(1).optional(),
      type: z.enum(["Normal", "Warning"]).optional(),
      userId: z.string().min(1).optional()
    },
    ({ namespace, fieldSelector, type }, bearerToken) =>
      serviceClient.listEvents({ namespace, fieldSelector, type, bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_list_deployments",
    "List deployments in a namespace.",
    {
      namespace: z.string().min(1),
      labelSelector: z.string().min(1).optional(),
      fieldSelector: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    ({ namespace, labelSelector, fieldSelector }, bearerToken) =>
      serviceClient.listDeployments(namespace, { labelSelector, fieldSelector, bearerToken })
  );

  registerOpenShiftMutatingTool(
    "openshift_scale_deployment",
    "Set deployment replicas through the scale subresource.",
    {
      namespace: z.string().min(1),
      deploymentName: z.string().min(1),
      replicas: z.number().int().nonnegative(),
      userId: z.string().min(1).optional()
    },
    ({ namespace, deploymentName, replicas }, bearerToken) =>
      serviceClient.scaleDeployment(namespace, deploymentName, replicas, { bearerToken })
  );

  registerOpenShiftMutatingTool(
    "openshift_rollout_restart",
    "Restart a deployment rollout by updating its pod-template restart annotation.",
    {
      namespace: z.string().min(1),
      deploymentName: z.string().min(1),
      restartedAt: z.string().datetime().optional(),
      userId: z.string().min(1).optional()
    },
    ({ namespace, deploymentName, restartedAt }, bearerToken) =>
      serviceClient.rolloutRestart(namespace, deploymentName, { restartedAt, bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_list_services",
    "List Kubernetes services in a namespace.",
    {
      namespace: z.string().min(1),
      labelSelector: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    ({ namespace, labelSelector }, bearerToken) =>
      serviceClient.listServices(namespace, { labelSelector, bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_list_routes",
    "List OpenShift routes in a namespace.",
    {
      namespace: z.string().min(1),
      labelSelector: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    ({ namespace, labelSelector }, bearerToken) => serviceClient.listRoutes(namespace, { labelSelector, bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_get_route",
    "Get one OpenShift route.",
    {
      namespace: z.string().min(1),
      routeName: z.string().min(1),
      userId: z.string().min(1).optional()
    },
    ({ namespace, routeName }, bearerToken) => serviceClient.getRoute(namespace, routeName, { bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_list_cluster_operators",
    "List OpenShift ClusterOperators and their conditions.",
    { userId: z.string().min(1).optional() },
    (_args, bearerToken) => serviceClient.listClusterOperators({ bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_get_cluster_version",
    "Get ClusterVersion status, desired version, history, and available updates.",
    {
      name: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    ({ name }, bearerToken) => serviceClient.getClusterVersion({ name, bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_list_nodes",
    "List cluster nodes and their conditions.",
    {
      labelSelector: z.string().min(1).optional(),
      fieldSelector: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    ({ labelSelector, fieldSelector }, bearerToken) =>
      serviceClient.listNodes({ labelSelector, fieldSelector, bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_can_i",
    "Check whether the current user's OpenShift token may perform a resource action.",
    {
      verb: z.string().min(1),
      resource: z.string().min(1),
      apiGroup: z.string().optional(),
      namespace: z.string().min(1).optional(),
      resourceName: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    ({ verb, resource, apiGroup, namespace, resourceName }, bearerToken) =>
      serviceClient.canI({ verb, resource, apiGroup, namespace, resourceName, bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_list_role_bindings",
    "List RoleBindings across the cluster or in one namespace.",
    {
      namespace: z.string().min(1).optional(),
      labelSelector: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    ({ namespace, labelSelector }, bearerToken) =>
      serviceClient.listRoleBindings({ namespace, labelSelector, bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_list_crds",
    "List installed CustomResourceDefinitions.",
    {
      labelSelector: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    ({ labelSelector }, bearerToken) => serviceClient.listCrds({ labelSelector, bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_list_subscriptions",
    "List Operator Lifecycle Manager subscriptions across the cluster or in one namespace.",
    {
      namespace: z.string().min(1).optional(),
      labelSelector: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    ({ namespace, labelSelector }, bearerToken) =>
      serviceClient.listSubscriptions({ namespace, labelSelector, bearerToken })
  );

  registerOpenShiftReadTool(
    "openshift_get_resource_usage",
    "Get pod or node resource usage from the Kubernetes Metrics API.",
    {
      resourceType: z.enum(["pods", "nodes"]),
      namespace: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      labelSelector: z.string().min(1).optional(),
      userId: z.string().min(1).optional()
    },
    ({ resourceType, namespace, name, labelSelector }, bearerToken) =>
      serviceClient.getResourceUsage({ resourceType, namespace, name, labelSelector, bearerToken })
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
        await assertAuthorized(authorizationKey);
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
      await assertAuthorized(authorizationKey);
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
      await assertAuthorized(authorizationKey);
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
      await assertAuthorized(authorizationKey);
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

  if (redshiftService) {
    server.tool(
      "redshift_list_clusters",
      "List Redshift clusters configured for a user without exposing credentials.",
      { userId: z.string().min(1).optional() },
      withErrorHandling(async ({ userId }) => {
        const resolvedUserId = resolveUserId(userId);
        const records = await configStore.listConfigs(redshiftConfigKeyPrefix, resolvedUserId);
        return {
          ok: true,
          status: 200,
          data: records.map((record) => ({
            clusterId: record.key.slice(redshiftConfigKeyPrefix.length),
            ...record.value,
            updatedAt: record.updated_at
          }))
        };
      })
    );

    server.tool(
      "redshift_get_cluster",
      "Get Redshift cluster connection metadata without exposing credentials.",
      {
        clusterId: z.string().min(1),
        userId: z.string().min(1).optional()
      },
      withErrorHandling(async ({ clusterId, userId }) => {
        const resolvedUserId = resolveUserId(userId);
        const normalizedClusterId = normalizeClusterId(clusterId);
        const record = await configStore.getConfig(getRedshiftConfigKey(normalizedClusterId), resolvedUserId);
        if (!record) {
          const error = new Error(`Redshift cluster not found: ${normalizedClusterId}`);
          error.status = 404;
          throw error;
        }
        return {
          ok: true,
          status: 200,
          data: { clusterId: normalizedClusterId, ...record.value, updatedAt: record.updated_at }
        };
      })
    );

    server.tool(
      "redshift_set_cluster",
      "Create or replace a named Redshift cluster configuration and its Vault-backed credentials.",
      {
        clusterId: z.string().min(1),
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535).default(5439),
        database: z.string().min(1),
        username: z.string().min(1),
        password: z.string().min(1),
        ssl: z.boolean().default(true),
        timeoutMs: z.number().int().positive().default(15000),
        userId: z.string().min(1).optional(),
        authorizationKey: z.string().min(1).optional()
      },
      withErrorHandling(async ({ clusterId, host, port, database, username, password, ssl, timeoutMs, userId, authorizationKey }) => {
        await assertAuthorized(authorizationKey);
        const resolvedUserId = resolveUserId(userId);
        const normalizedClusterId = normalizeClusterId(clusterId);
        const metadata = { host, port, database, ssl, timeoutMs };
        await vaultService.setSecret(getRedshiftSecretPath(resolvedUserId, normalizedClusterId), { username, password });
        const record = await configStore.setConfig(getRedshiftConfigKey(normalizedClusterId), metadata, resolvedUserId);
        return {
          ok: true,
          status: 200,
          data: { clusterId: normalizedClusterId, ...record.value, updatedAt: record.updated_at }
        };
      })
    );

    server.tool(
      "redshift_remove_cluster",
      "Remove a named Redshift cluster configuration and its credentials.",
      {
        clusterId: z.string().min(1),
        userId: z.string().min(1).optional(),
        authorizationKey: z.string().min(1).optional()
      },
      withErrorHandling(async ({ clusterId, userId, authorizationKey }) => {
        await assertAuthorized(authorizationKey);
        const resolvedUserId = resolveUserId(userId);
        const normalizedClusterId = normalizeClusterId(clusterId);
        const [deleted] = await Promise.all([
          configStore.deleteConfig(getRedshiftConfigKey(normalizedClusterId), resolvedUserId),
          vaultService.deleteSecret(getRedshiftSecretPath(resolvedUserId, normalizedClusterId))
        ]);
        return { ok: true, status: 200, data: { clusterId: normalizedClusterId, deleted } };
      })
    );

    server.tool(
      "redshift_health_check",
      "Test connectivity to a named Redshift cluster.",
      {
        clusterId: z.string().min(1),
        userId: z.string().min(1).optional()
      },
      withErrorHandling(async ({ clusterId, userId }) => {
        const selected = await readRedshiftConnection(userId, clusterId);
        const data = await redshiftService.healthCheck(selected.connection);
        return { ok: true, status: 200, data: { clusterId: selected.clusterId, ...data } };
      })
    );

    server.tool(
      "redshift_query",
      "Run a parameterized SQL statement against a named Redshift cluster.",
      {
        clusterId: z.string().min(1),
        sql: z.string().min(1),
        parameters: z.array(z.unknown()).default([]),
        maxRows: z.number().int().min(1).max(10000).default(1000),
        userId: z.string().min(1).optional(),
        authorizationKey: z.string().min(1).optional()
      },
      withErrorHandling(async ({ clusterId, sql, parameters, maxRows, userId, authorizationKey }) => {
        await assertAuthorized(authorizationKey);
        const selected = await readRedshiftConnection(userId, clusterId);
        const data = await redshiftService.query(selected.connection, sql, parameters, maxRows);
        return { ok: true, status: 200, data: { clusterId: selected.clusterId, ...data } };
      })
    );
  }

  server.tool(
    "mcp_query_suggestion_schema_discovery",
    "Discover MCP tool schemas and get intent-based recommendations for which tool to use next.",
    {
      intent: z.string().min(1).optional(),
      includeSchemas: z.boolean().default(true),
      includeExamples: z.boolean().default(true),
      includeHighRisk: z.boolean().default(true),
      maxRecommendations: z.number().int().min(1).max(25).default(12)
    },
    withErrorHandling(async ({ intent, includeSchemas, includeExamples, includeHighRisk, maxRecommendations }) => {
      const resolvedIncludeSchemas = includeSchemas ?? true;
      const resolvedIncludeExamples = includeExamples ?? true;
      const resolvedIncludeHighRisk = includeHighRisk ?? true;
      const resolvedMaxRecommendations = Number.isFinite(maxRecommendations) ? maxRecommendations : 12;
      const registeredTools = server._registeredTools && typeof server._registeredTools === "object" ? server._registeredTools : {};
      const catalog = Object.entries(registeredTools)
        .filter(([toolName]) => toolName !== "mcp_query_suggestion_schema_discovery")
        .map(([toolName, definition]) => {
          const schema = definition?.inputSchema;
          const parameters = summarizeToolSchema(schema);
          return {
            name: toolName,
            category: inferToolCategory(toolName),
            risk: inferToolRisk(toolName),
            description: String(definition?.description ?? ""),
            parameters,
            exampleArgs: resolvedIncludeExamples ? buildExampleArgs(schema) : undefined
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name));

      const intentWords = splitWords(intent);
      const recommendationPool = catalog.filter((tool) => resolvedIncludeHighRisk || tool.risk !== "high-risk");
      const recommendations = recommendationPool
        .map((tool) => {
          const score = scoreToolForIntent(tool.name, tool.description, intentWords);
          return {
            ...tool,
            score,
            reason:
              score > 0
                ? `Matched requested intent terms in tool name/description (score ${score}).`
                : "Found as part of the complete MCP capability catalog."
          };
        })
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          return left.name.localeCompare(right.name);
        })
        .slice(0, resolvedMaxRecommendations);

      return {
        ok: true,
        status: 200,
        data: {
          intent: intent ?? null,
          totalDiscoveredTools: catalog.length,
          recommendationCount: recommendations.length,
          recommendations,
          schemaDiscovery: resolvedIncludeSchemas ? catalog : undefined,
          safety:
            "Mutating and high-risk tools may require authorizationKey and can alter cluster, credential, or data state. Use mcp_admin_auth_status and mcp_admin_auth_verify before guarded operations.",
          preflightSequence: [
            "mcp_admin_auth_status",
            "mcp_admin_auth_verify",
            "openshift_connection_info",
            "target tool",
            "matching read-only verification tool"
          ]
        }
      };
    })
  );

  return server;
}
