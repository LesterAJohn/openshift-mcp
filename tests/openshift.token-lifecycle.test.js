import assert from "node:assert/strict";
import test from "node:test";

import { createMcpServer } from "../src/mcp/server.js";

function createServiceClientMock() {
  return {
    getConnectionInfo() {
      return { apiBaseUrl: "https://api.cluster.local:6443", authMode: "bearer" };
    },
    listKnownEndpoints() {
      return [];
    },
    async healthCheck() {
      return { status: 200, data: { ok: true } };
    },
    async listProjects({ bearerToken } = {}) {
      return {
        status: 200,
        data: {
          seenToken: bearerToken || null,
          items: []
        }
      };
    },
    async getProject() {
      return { status: 200, data: {} };
    },
    async listPods() {
      return { status: 200, data: {} };
    },
    async request(payload) {
      return { status: 200, ...payload };
    }
  };
}

function createConfigStoreMock() {
  const values = new Map();
  return {
    async healthcheck() {
      return { ok: true };
    },
    async getConfig(key, userId) {
      const item = values.get(`${userId}:${key}`);
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
      values.set(`${userId}:${key}`, { value, updatedAt });
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

test("token lifecycle persists to vault and postgres for multi-user flow", async () => {
  const previousAdminKey = process.env.MCP_ADMIN_AUTH_KEY;
  process.env.MCP_ADMIN_AUTH_KEY = "admin-key";

  try {
    const serviceClient = createServiceClientMock();
    const configStore = createConfigStoreMock();
    const vaultService = createVaultServiceMock();
    const server = createMcpServer({
      name: "openshift-mcp",
      version: "0.1.0",
      appName: "openshift",
      serviceClient,
      configStore,
      vaultService
    });

    const setResult = await invokeTool(server, "openshift_set_user_token", {
      userId: "team-a",
      token: "token-team-a",
      scopes: ["mcp:invoke"],
      audience: ["codex"],
      authorizationKey: "admin-key"
    });
    assert.equal(setResult.payload.ok, true);
    assert.equal(setResult.payload.data.userId, "team-a");

    const projectsResult = await invokeTool(server, "openshift_list_projects", {
      userId: "team-a"
    });
    assert.equal(projectsResult.payload.ok, true);
    assert.equal(projectsResult.payload.data.data.seenToken, "token-team-a");

    const metadataResult = await invokeTool(server, "openshift_get_user_token_metadata", {
      userId: "team-a"
    });
    assert.equal(metadataResult.payload.ok, true);
    assert.equal(metadataResult.payload.data.userId, "team-a");
    assert.equal(metadataResult.payload.data.tokenConfigured, "[REDACTED]");

    const deactivateResult = await invokeTool(server, "openshift_deactivate_user_token", {
      userId: "team-a",
      authorizationKey: "admin-key"
    });
    assert.equal(deactivateResult.payload.ok, true);
    assert.equal(deactivateResult.payload.data.active, false);
  } finally {
    if (previousAdminKey === undefined) {
      delete process.env.MCP_ADMIN_AUTH_KEY;
    } else {
      process.env.MCP_ADMIN_AUTH_KEY = previousAdminKey;
    }
  }
});
