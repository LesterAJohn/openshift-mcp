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
  } finally {
    restoreEnv();
  }
});
