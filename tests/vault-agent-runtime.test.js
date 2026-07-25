import assert from "node:assert/strict";
import test from "node:test";

import { resolveVaultAgentRuntimeConfig } from "../src/config/vaultAgentRuntime.js";

function createEnv(overrides = {}) {
  return {
    config: {
      defaultUserId: "default",
      vaultAgent: {
        authModeConfigKey: "vault.agent.auth.mode",
        tokenFilePathConfigKey: "vault.agent.tokenFilePath",
        listenerAddrConfigKey: "vault.agent.listener.addr"
      }
    },
    vault: {
      agentEnabled: false,
      agentAuthMode: "file",
      agentTokenFilePath: "/tmp/vault-agent-token",
      agentListenerEnabled: false,
      agentListenerAddr: "http://127.0.0.1:8100"
    },
    ...overrides
  };
}

function createConfigStore(valuesByKey = {}) {
  return {
    async getConfig(key, userId) {
      assert.equal(userId, "default");
      if (!(key in valuesByKey)) {
        return null;
      }

      return {
        user_id: userId,
        key,
        value: valuesByKey[key]
      };
    }
  };
}

test("resolveVaultAgentRuntimeConfig enables listener mode from Postgres defaults", async () => {
  const env = createEnv();
  const configStore = createConfigStore({
    "vault.agent.auth.mode": "listener",
    "vault.agent.listener.addr": "http://127.0.0.1:18200"
  });

  const resolved = await resolveVaultAgentRuntimeConfig({ configStore, env });

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.authMode, "listener");
  assert.equal(resolved.usesAgentListener, true);
  assert.equal(resolved.usesAgentFile, false);
  assert.equal(resolved.listenerEnabled, true);
  assert.equal(resolved.listenerAddr, "http://127.0.0.1:18200");
  assert.equal(resolved.sources.authMode, "db");
  assert.equal(resolved.sources.listenerAddr, "db");
});

test("resolveVaultAgentRuntimeConfig supports both mode with db file path and listener addr", async () => {
  const env = createEnv({
    vault: {
      agentEnabled: false,
      agentAuthMode: "none",
      agentTokenFilePath: "/tmp/env-token",
      agentListenerEnabled: false,
      agentListenerAddr: "http://127.0.0.1:8100"
    }
  });

  const configStore = createConfigStore({
    "vault.agent.auth.mode": "both",
    "vault.agent.tokenFilePath": "/tmp/db-token",
    "vault.agent.listener.addr": "http://127.0.0.1:19100"
  });

  const resolved = await resolveVaultAgentRuntimeConfig({ configStore, env });

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.authMode, "both");
  assert.equal(resolved.usesAgentFile, true);
  assert.equal(resolved.usesAgentListener, true);
  assert.equal(resolved.tokenFilePath, "/tmp/db-token");
  assert.equal(resolved.listenerAddr, "http://127.0.0.1:19100");
  assert.equal(resolved.sources.tokenFilePath, "db");
  assert.equal(resolved.sources.listenerAddr, "db");
});

test("resolveVaultAgentRuntimeConfig falls back to env when db mode is invalid", async () => {
  const env = createEnv({
    vault: {
      agentEnabled: true,
      agentAuthMode: "file",
      agentTokenFilePath: "/tmp/env-token",
      agentListenerEnabled: false,
      agentListenerAddr: "http://127.0.0.1:8100"
    }
  });

  const configStore = createConfigStore({
    "vault.agent.auth.mode": "invalid-mode"
  });

  const resolved = await resolveVaultAgentRuntimeConfig({ configStore, env });

  assert.equal(resolved.enabled, true);
  assert.equal(resolved.authMode, "file");
  assert.equal(resolved.usesAgentFile, true);
  assert.equal(resolved.usesAgentListener, false);
  assert.equal(resolved.tokenFilePath, "/tmp/env-token");
  assert.equal(resolved.sources.authMode, "db");
  assert.equal(resolved.sources.tokenFilePath, "env");
});
