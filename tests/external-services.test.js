import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const rootDir = process.cwd();
const externalComposePath = path.join(rootDir, "docker-compose.external.yml");
const readmePath = path.join(rootDir, "README.md");
const agentReadmePath = path.join(rootDir, "agent", "README.md");
const playbookPath = path.join(rootDir, "agent", "playbooks", "service-onboarding.md");
const templatePath = path.join(rootDir, "agent", "templates", "service-spec.md");
const agentDefinitionPath = path.join(rootDir, ".github", "agents", "skeleton-services-mcp.agent.md");
const promptPath = path.join(rootDir, ".github", "prompts", "adapt-skeleton-service.prompt.md");

test("external services compose file exists and targets external Vault/Postgres", () => {
  const compose = fs.readFileSync(externalComposePath, "utf8");

  assert.match(compose, /mcp-http:/);
  assert.match(compose, /POSTGRES_HOST: \$\{POSTGRES_HOST:\?set POSTGRES_HOST for external Postgres\}/);
  assert.match(compose, /VAULT_ADDR: \$\{VAULT_ADDR:\?set VAULT_ADDR for external Vault\}/);
  assert.doesNotMatch(compose, /postgres:/);
  assert.doesNotMatch(compose, /vault:/);
});

test("documentation mentions external services mode", () => {
  const readme = fs.readFileSync(readmePath, "utf8");

  assert.match(readme, /docker-compose\.external\.yml/);
  assert.match(readme, /External Services Mode/);
  assert.match(readme, /POSTGRES_HOST/);
  assert.match(readme, /VAULT_ADDR/);
});

test("agent docs mention external services support", () => {
  const agentReadme = fs.readFileSync(agentReadmePath, "utf8");
  const playbook = fs.readFileSync(playbookPath, "utf8");
  const template = fs.readFileSync(templatePath, "utf8");
  const agentDefinition = fs.readFileSync(agentDefinitionPath, "utf8");
  const prompt = fs.readFileSync(promptPath, "utf8");

  assert.match(agentReadme, /external Vault and Postgres services/i);
  assert.match(playbook, /app-only compose path/i);
  assert.match(template, /External Vault\/Postgres support requirements/i);
  assert.match(agentDefinition, /App-only external deployment mode/i);
  assert.match(prompt, /external Vault\/Postgres services/i);
});
