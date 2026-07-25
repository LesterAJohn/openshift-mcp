import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const rootDir = process.cwd();
const vaultProdDir = path.join(rootDir, "vault-production");
const scriptPath = path.join(vaultProdDir, "scripts", "convert-dev-to-prod.sh");
const bootstrapScriptPath = path.join(vaultProdDir, "scripts", "bootstrap-post-conversion.sh");
const configPath = path.join(vaultProdDir, "config", "vault.hcl");
const composePath = path.join(vaultProdDir, "docker-compose.vault-prod.yml");
const devComposePath = path.join(rootDir, "docker-compose.yml");
const unsealKeyScriptPath = path.join(rootDir, "scripts", "vault-unseal-key.js");
const initScriptPath = path.join(rootDir, "initdb", "001_config.sh");

test("vault-production scaffold files exist", () => {
  assert.equal(fs.existsSync(vaultProdDir), true);
  assert.equal(fs.existsSync(scriptPath), true);
  assert.equal(fs.existsSync(bootstrapScriptPath), true);
  assert.equal(fs.existsSync(configPath), true);
  assert.equal(fs.existsSync(composePath), true);
  assert.equal(fs.existsSync(unsealKeyScriptPath), true);
  assert.equal(fs.existsSync(initScriptPath), true);
});

test("vault production config uses raft storage", () => {
  const config = fs.readFileSync(configPath, "utf8");
  const initdb = fs.readFileSync(initScriptPath, "utf8");

  assert.match(config, /storage\s+"raft"\s*\{/);
  assert.match(config, /path\s*=\s*"\/vault\/data"/);
  assert.match(config, /node_id\s*=\s*"vault-1"/);
  assert.match(config, /listener\s+"tcp"\s*\{/);
  assert.match(initdb, /APP_NAME="\$\{APP_NAME:-openshift\}"/);
  assert.match(initdb, /TABLE_NAME="\$\{APP_NAME\}_config"/);
  assert.match(initdb, /CREATE TABLE IF NOT EXISTS \$\{TABLE_NAME\}/);
  assert.match(initdb, /INSERT INTO \$\{TABLE_NAME\}/);
});

test("prod compose runs vault in config mode and not dev mode", () => {
  const compose = fs.readFileSync(composePath, "utf8");

  assert.match(compose, /vault-unseal-key-init:/);
  assert.match(compose, /npm\s+run\s+vault:unseal-key\s+--\s+--json/);
  assert.match(compose, /depends_on:\s*[\s\S]*vault-unseal-key-init:\s*[\s\S]*service_completed_successfully/);
  assert.match(compose, /vault\s+server\s+-config=\/vault\/config\/vault\.hcl/);
  assert.doesNotMatch(compose, /vault\s+server\s+-dev/);
});

test("dev compose uses raft-backed vault persistence", () => {
  const compose = fs.readFileSync(devComposePath, "utf8");

  assert.match(compose, /vault-unseal-key-init:/);
  assert.match(compose, /npm\s+run\s+vault:unseal-key\s+--\s+--json/);
  assert.match(compose, /depends_on:\s*[\s\S]*vault-unseal-key-init:\s*[\s\S]*service_completed_successfully/);
  assert.match(compose, /\.\/src\/config\/vault\.dev\.hcl:\/vault\/config\/vault\.hcl:ro/);
  assert.match(compose, /vault_dev_raft_data:\/vault\/data/);
  assert.match(compose, /vault\s+server\s+-config=\/vault\/config\/vault\.hcl/);
  assert.match(compose, /VAULT_UNSEAL_KEY:/);
});

test("conversion script help is available and documents migration flow", () => {
  const output = execFileSync("bash", [scriptPath, "--help"], {
    cwd: rootDir,
    encoding: "utf8"
  });

  assert.match(output, /Usage:/);
  assert.match(output, /--compose-prod/);
  assert.match(output, /--skip-init/);
  assert.match(output, /Raft-backed Vault container/);
});

test("conversion script has valid bash syntax", () => {
  execFileSync("bash", ["-n", scriptPath], {
    cwd: rootDir,
    stdio: "pipe"
  });

  assert.ok(true);
});

test("bootstrap script help is available and documents security bootstrap flow", () => {
  const output = execFileSync("bash", [bootstrapScriptPath, "--help"], {
    cwd: rootDir,
    encoding: "utf8"
  });

  assert.match(output, /Usage:/);
  assert.match(output, /--vault-token/);
  assert.match(output, /--role-name/);
  assert.match(output, /--output/);
  assert.match(output, /--output-file/);
  assert.match(output, /AppRole/);
});

test("bootstrap script has valid bash syntax", () => {
  execFileSync("bash", ["-n", bootstrapScriptPath], {
    cwd: rootDir,
    stdio: "pipe"
  });

  assert.ok(true);
});

test("vault unseal key helper script provides help text", () => {
  const output = execFileSync("node", [unsealKeyScriptPath, "--help"], {
    cwd: rootDir,
    encoding: "utf8"
  });

  assert.match(output, /Usage:/);
  assert.match(output, /--json/);
  assert.match(output, /--set/);
  assert.match(output, /--no-create/);
});
