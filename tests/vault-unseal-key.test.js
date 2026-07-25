import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  persistVaultUnsealKey,
  resolveVaultUnsealKey
} from "../src/config/vaultUnsealKey.js";

function makeTempPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-unseal-key-"));
  return {
    dir,
    filePath: path.join(dir, "vault.unseal.key.json")
  };
}

test("resolveVaultUnsealKey prefers VAULT_UNSEAL_KEY env value", () => {
  const { dir, filePath } = makeTempPath();
  const envKey = "abcdefghijklmnopqrstuvwx";

  try {
    const resolved = resolveVaultUnsealKey({
      env: { VAULT_UNSEAL_KEY: envKey },
      filePath
    });

    assert.equal(resolved.key, envKey);
    assert.equal(resolved.source, "env");
    assert.equal(fs.existsSync(filePath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveVaultUnsealKey reads key from file when env is empty", () => {
  const { dir, filePath } = makeTempPath();

  try {
    persistVaultUnsealKey("123456789012345678901234", filePath);

    const resolved = resolveVaultUnsealKey({
      env: {},
      filePath
    });

    assert.equal(resolved.key, "123456789012345678901234");
    assert.equal(resolved.source, "file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveVaultUnsealKey creates and persists 24-char key when missing", () => {
  const { dir, filePath } = makeTempPath();

  try {
    const resolved = resolveVaultUnsealKey({
      env: {},
      filePath
    });

    assert.equal(resolved.source, "generated");
    assert.equal(resolved.key.length, 24);
    assert.equal(fs.existsSync(filePath), true);

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(parsed.unsealKey, resolved.key);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persistVaultUnsealKey rejects invalid key length", () => {
  const { dir, filePath } = makeTempPath();

  try {
    assert.throws(
      () => persistVaultUnsealKey("short", filePath),
      /must be exactly 24 characters/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
