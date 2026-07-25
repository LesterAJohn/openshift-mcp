import assert from "node:assert/strict";
import test from "node:test";

import { createMcpServer } from "../src/mcp/server.js";

function setEnv(updates) {
  const previous = {};
  for (const [key, value] of Object.entries(updates)) {
    previous[key] = process.env[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

function createServiceClientMock() {
  const calls = {
    discoverApiGroups: 0,
    discoverApiResources: 0,
    getVersion: 0,
    scaleDeployment: 0,
    resourceRequest: 0,
    listProjects: 0,
    request: 0
  };

  const client = {
    getConnectionInfo() {
      return {
        apiBaseUrl: "https://api.example.openshift.local:6443",
        authMode: "bearer"
      };
    },
    listKnownEndpoints() {
      return [{ method: "GET", path: "/healthz" }];
    },
    async healthCheck() {
      return { status: 200, data: { ok: true } };
    },
    async discoverApiGroups() {
      calls.discoverApiGroups += 1;
      return { core: { data: { versions: ["v1"] } }, groups: { data: { groups: [] } } };
    },
    async discoverApiResources(apiVersion) {
      calls.discoverApiResources += 1;
      return { status: 200, data: { groupVersion: apiVersion, resources: [] } };
    },
    async discoverOpenApi() {
      return { status: 200, data: { paths: {} } };
    },
    async resourceRequest(payload) {
      calls.resourceRequest += 1;
      return { status: 200, ...payload };
    },
    async getVersion() {
      calls.getVersion += 1;
      return { status: 200, data: { gitVersion: "v1.30.0" } };
    },
    async scaleDeployment(namespace, deploymentName, replicas) {
      calls.scaleDeployment += 1;
      return { status: 200, data: { namespace, deploymentName, replicas } };
    },
    async listProjects() {
      calls.listProjects += 1;
      return { status: 200, data: { items: [] } };
    },
    async getProject(projectName) {
      return { status: 200, data: { metadata: { name: projectName } } };
    },
    async listPods(namespace) {
      return { status: 200, data: { namespace, items: [] } };
    },
    async request(payload) {
      calls.request += 1;
      return {
        status: 200,
        ...payload
      };
    }
  };

  return { client, calls };
}

function createConfigStoreMock() {
  const configs = new Map();

  return {
    async healthcheck() {
      return { ok: true };
    },
    async getConfig(key, userId) {
      const item = configs.get(`${userId}:${key}`);
      if (!item) {
        return null;
      }
      return {
        user_id: userId,
        key,
        value: item.value,
        updated_at: item.updatedAt
      };
    },
    async setConfig(key, value, userId) {
      const updatedAt = new Date().toISOString();
      configs.set(`${userId}:${key}`, { value, updatedAt });
      return {
        user_id: userId,
        key,
        value,
        updated_at: updatedAt
      };
    }
  };
}

function createVaultServiceMock() {
  const secrets = new Map();

  return {
    async healthcheck() {
      return { ok: true };
    },
    async getSecret(path) {
      return secrets.get(path) ?? null;
    },
    async setSecret(path, value) {
      secrets.set(path, value);
      return { ok: true, path };
    },
    async deleteSecret(path) {
      secrets.delete(path);
      return { ok: true, path };
    }
  };
}

async function invokeTool(server, name, args = {}) {
  const registeredTools = server._registeredTools;
  assert.ok(registeredTools[name], `Expected tool ${name} to be registered`);
  const result = await registeredTools[name].handler(args);
  const payload = JSON.parse(result.content[0].text);
  return { result, payload };
}

test("openshift_health_check returns ok", async () => {
  const restoreEnv = setEnv({ MCP_ADMIN_AUTH_KEY: "" });

  try {
    const { client } = createServiceClientMock();
    const configStore = createConfigStoreMock();
    const vaultService = createVaultServiceMock();
    const server = createMcpServer({
      name: "openshift-mcp",
      version: "0.1.0",
      appName: "openshift",
      serviceClient: client,
      configStore,
      vaultService
    });

    const { payload } = await invokeTool(server, "openshift_health_check");

    assert.equal(payload.ok, true);
    assert.equal(payload.status, 200);
    assert.equal(payload.data.status, 200);
  } finally {
    restoreEnv();
  }
});

test("mutating openshift tools require authorizationKey when admin key is configured", async () => {
  const restoreEnv = setEnv({ MCP_ADMIN_AUTH_KEY: "super-secret" });

  try {
    const { client, calls } = createServiceClientMock();
    const configStore = createConfigStoreMock();
    const vaultService = createVaultServiceMock();
    const server = createMcpServer({
      name: "openshift-mcp",
      version: "0.1.0",
      appName: "openshift",
      serviceClient: client,
      configStore,
      vaultService
    });

    const unauthorized = await invokeTool(server, "openshift_set_user_token", {
      userId: "alice",
      token: "my-token"
    });
    assert.equal(unauthorized.result.isError, true);
    assert.equal(unauthorized.payload.status, 401);

    const authorized = await invokeTool(server, "openshift_set_user_token", {
      userId: "alice",
      token: "my-token",
      authorizationKey: "super-secret"
    });
    assert.equal(authorized.payload.ok, true);
    assert.equal(authorized.payload.data.userId, "alice");

    const genericUnauthorized = await invokeTool(server, "openshift_api_request", {
      method: "POST",
      path: "/apis/project.openshift.io/v1/projects"
    });
    assert.equal(genericUnauthorized.result.isError, true);
    assert.equal(genericUnauthorized.payload.status, 401);

    const genericAuthorized = await invokeTool(server, "openshift_api_request", {
      method: "POST",
      path: "/apis/project.openshift.io/v1/projects",
      authorizationKey: "super-secret"
    });
    assert.equal(genericAuthorized.payload.ok, true);
    assert.equal(calls.request, 1);

    const resourceUnauthorized = await invokeTool(server, "openshift_resource_request", {
      apiVersion: "apps/v1",
      resource: "deployments",
      namespace: "team-a",
      name: "api",
      method: "PATCH",
      body: { spec: { replicas: 2 } }
    });
    assert.equal(resourceUnauthorized.result.isError, true);
    assert.equal(resourceUnauthorized.payload.status, 401);

    const resourceAuthorized = await invokeTool(server, "openshift_resource_request", {
      apiVersion: "apps/v1",
      resource: "deployments",
      namespace: "team-a",
      name: "api",
      method: "PATCH",
      body: { spec: { replicas: 2 } },
      authorizationKey: "super-secret"
    });
    assert.equal(resourceAuthorized.payload.ok, true);
    assert.equal(calls.resourceRequest, 1);
  } finally {
    restoreEnv();
  }
});

test("discovery tools expose installed API groups and resources", async () => {
  const restoreEnv = setEnv({ MCP_ADMIN_AUTH_KEY: "" });

  try {
    const { client, calls } = createServiceClientMock();
    const server = createMcpServer({
      name: "openshift-mcp",
      version: "0.1.0",
      appName: "openshift",
      serviceClient: client,
      configStore: createConfigStoreMock(),
      vaultService: createVaultServiceMock()
    });

    const groups = await invokeTool(server, "openshift_discover_api_groups");
    assert.equal(groups.payload.ok, true);
    assert.deepEqual(groups.payload.data.core.data.versions, ["v1"]);

    const resources = await invokeTool(server, "openshift_discover_api_resources", {
      apiVersion: "operators.coreos.com/v1alpha1"
    });
    assert.equal(resources.payload.data.data.groupVersion, "operators.coreos.com/v1alpha1");
    assert.equal(calls.discoverApiGroups, 1);
    assert.equal(calls.discoverApiResources, 1);
  } finally {
    restoreEnv();
  }
});

test("dedicated tools delegate reads and authorize mutations", async () => {
  const restoreEnv = setEnv({ MCP_ADMIN_AUTH_KEY: "super-secret" });

  try {
    const { client, calls } = createServiceClientMock();
    const server = createMcpServer({
      name: "openshift-mcp",
      version: "0.1.0",
      appName: "openshift",
      serviceClient: client,
      configStore: createConfigStoreMock(),
      vaultService: createVaultServiceMock()
    });

    const version = await invokeTool(server, "openshift_get_version");
    assert.equal(version.payload.data.data.gitVersion, "v1.30.0");
    assert.equal(calls.getVersion, 1);

    const unauthorized = await invokeTool(server, "openshift_scale_deployment", {
      namespace: "team-a",
      deploymentName: "api",
      replicas: 3
    });
    assert.equal(unauthorized.result.isError, true);
    assert.equal(unauthorized.payload.status, 401);

    const authorized = await invokeTool(server, "openshift_scale_deployment", {
      namespace: "team-a",
      deploymentName: "api",
      replicas: 3,
      authorizationKey: "super-secret"
    });
    assert.equal(authorized.payload.data.data.replicas, 3);
    assert.equal(calls.scaleDeployment, 1);
  } finally {
    restoreEnv();
  }
});

test("MCP admin auth tools migrate, verify, and rotate the key in Vault", async () => {
  const restoreEnv = setEnv({ MCP_ADMIN_AUTH_KEY: "bootstrap-admin-key" });

  try {
    const vaultService = createVaultServiceMock();
    const createServer = () => {
      const { client } = createServiceClientMock();
      return createMcpServer({
        name: "openshift-mcp",
        version: "0.1.0",
        appName: "openshift",
        serviceClient: client,
        configStore: createConfigStoreMock(),
        vaultService
      });
    };

    const server = createServer();
    const initialStatus = await invokeTool(server, "mcp_admin_auth_status");
    assert.equal(initialStatus.payload.data.configured, true);
    assert.equal(initialStatus.payload.data.source, "vault");
    assert.equal(initialStatus.payload.data.vaultPath, "openshift/admin/auth");

    const migrated = await vaultService.getSecret("openshift/admin/auth");
    assert.equal(typeof migrated.keyHash, "string");
    assert.equal(migrated.keyHash.length, 64);
    assert.equal("authorizationKey" in migrated, false);

    const invalid = await invokeTool(server, "mcp_admin_auth_verify", {
      authorizationKey: "incorrect-key"
    });
    assert.equal(invalid.result.isError, true);
    assert.equal(invalid.payload.status, 401);

    const valid = await invokeTool(server, "mcp_admin_auth_verify", {
      authorizationKey: "bootstrap-admin-key"
    });
    assert.equal(valid.payload.data.authorized, true);

    const rotated = await invokeTool(server, "mcp_admin_auth_rotate", {
      authorizationKey: "bootstrap-admin-key",
      newAuthorizationKey: "replacement-admin-key"
    });
    assert.equal(rotated.payload.ok, true);
    assert.equal(rotated.payload.data.source, "vault");

    const oldKey = await invokeTool(server, "mcp_admin_auth_verify", {
      authorizationKey: "bootstrap-admin-key"
    });
    assert.equal(oldKey.result.isError, true);
    assert.equal(oldKey.payload.status, 401);

    const newKey = await invokeTool(server, "mcp_admin_auth_verify", {
      authorizationKey: "replacement-admin-key"
    });
    assert.equal(newKey.payload.data.authorized, true);

    const restartedServer = createServer();
    const persisted = await invokeTool(restartedServer, "mcp_admin_auth_verify", {
      authorizationKey: "replacement-admin-key"
    });
    assert.equal(persisted.payload.data.authorized, true);
  } finally {
    restoreEnv();
  }
});
