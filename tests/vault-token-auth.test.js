import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createVaultTokenVerifier } from "../src/http/vaultTokenAuth.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("vault token verifier authorizes active user token from token index", async () => {
  const token = "token-user-1";
  const tokenHash = sha256(token);

  const verifier = createVaultTokenVerifier({
    vaultService: {
      async getSecret(path) {
        assert.equal(path, "skeleton/http/auth/token-index");
        return {
          tokens: {
            [tokenHash]: {
              userId: "user-1",
              tokenId: "tok-001",
              active: true,
              scopes: ["mcp:invoke", "mcp:read"],
              audience: ["codex", "claude"]
            }
          }
        };
      }
    },
    indexPath: "skeleton/http/auth/token-index",
    requiredScopes: ["mcp:invoke"],
    requiredAudience: "codex",
    cacheTtlMs: 30_000
  });

  const result = await verifier.verify(token);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.userId, "user-1");
  assert.equal(result.metadata.tokenId, "tok-001");
});

test("vault token verifier rejects inactive or missing scope tokens", async () => {
  const token = "token-user-2";
  const tokenHash = sha256(token);

  const verifier = createVaultTokenVerifier({
    vaultService: {
      async getSecret() {
        return {
          tokens: {
            [tokenHash]: {
              userId: "user-2",
              tokenId: "tok-002",
              active: false,
              scopes: ["mcp:read"],
              audience: ["codex"]
            }
          }
        };
      }
    },
    indexPath: "skeleton/http/auth/token-index",
    requiredScopes: ["mcp:invoke"],
    requiredAudience: "codex",
    cacheTtlMs: 30_000
  });

  const result = await verifier.verify(token);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "token_inactive");
});

test("vault token verifier supports top-level hash map format", async () => {
  const token = "token-user-3";
  const tokenHash = sha256(token);

  const verifier = createVaultTokenVerifier({
    vaultService: {
      async getSecret() {
        return {
          [tokenHash]: {
            userId: "user-3",
            tokenId: "tok-003",
            active: true,
            scopes: "mcp:invoke mcp:read",
            audience: "claude"
          }
        };
      }
    },
    indexPath: "skeleton/http/auth/token-index",
    requiredScopes: ["mcp:invoke"],
    requiredAudience: "claude",
    cacheTtlMs: 30_000
  });

  const result = await verifier.verify(token);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.userId, "user-3");
});

test("vault token verifier falls back to default user when no other users exist", async () => {
  const token = "token-default-user";
  const tokenHash = sha256(token);

  const verifier = createVaultTokenVerifier({
    vaultService: {
      async getSecret() {
        return {
          defaultUserId: "default",
          users: {
            default: {
              tokens: {
                [tokenHash]: {
                  tokenId: "tok-default-001",
                  active: true,
                  scopes: ["mcp:invoke"],
                  audience: ["codex"]
                }
              }
            }
          }
        };
      }
    },
    indexPath: "skeleton/http/auth/token-index",
    defaultUserId: "default",
    requiredScopes: ["mcp:invoke"],
    requiredAudience: "codex",
    cacheTtlMs: 30_000
  });

  const result = await verifier.verify(token);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.userId, "default");
  assert.equal(result.metadata.tokenId, "tok-default-001");
});
