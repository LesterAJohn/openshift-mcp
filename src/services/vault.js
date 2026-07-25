import vault from "node-vault";
import { readFile } from "node:fs/promises";

export class VaultService {
  constructor({
    endpoint,
    token,
    agentEnabled = false,
    agentAuthMode = "file",
    agentTokenFilePath = "",
    agentListenerEnabled = false,
    agentListenerAddr = "",
    kvMount,
    writeRetryAttempts = 3,
    writeRetryBaseDelayMs = 200,
    writeRetryMaxDelayMs = 2000
  }) {
    const effectiveEndpoint = agentListenerEnabled && agentListenerAddr ? agentListenerAddr : endpoint;
    this.client = vault({ endpoint: effectiveEndpoint, token, apiVersion: "v1" });
    this.endpoint = endpoint;
    this.tokenConfigured = Boolean(token);
    this.agentEnabled = agentEnabled;
    this.agentAuthMode = agentAuthMode;
    this.agentTokenFilePath = agentTokenFilePath;
    this.agentListenerEnabled = agentListenerEnabled;
    this.agentListenerAddr = agentListenerAddr;
    this.kvMount = kvMount;
    this.writeRetryAttempts = writeRetryAttempts;
    this.writeRetryBaseDelayMs = writeRetryBaseDelayMs;
    this.writeRetryMaxDelayMs = writeRetryMaxDelayMs;
    this.writeQueue = Promise.resolve();
  }

  getConnectionInfo() {
    const usesAgentFile = this.agentEnabled && (this.agentAuthMode === "file" || this.agentAuthMode === "both");
    const usesAgentListener =
      this.agentEnabled && (this.agentAuthMode === "listener" || this.agentAuthMode === "both");

    return {
      VAULT_ADDR: this.endpoint,
      VAULT_TOKEN: this.tokenConfigured ? "set" : null,
      VAULT_AGENT_ENABLED: this.agentEnabled,
      VAULT_AGENT_AUTH_MODE: this.agentAuthMode,
      VAULT_AGENT_TOKEN_FILE_PATH: usesAgentFile ? this.agentTokenFilePath || null : null,
      VAULT_AGENT_LISTENER_ENABLED: usesAgentListener && this.agentListenerEnabled,
      VAULT_AGENT_LISTENER_ADDR: usesAgentListener ? this.agentListenerAddr || null : null,
      VAULT_KV_MOUNT: this.kvMount,
      VAULT_WRITE_RETRY_ATTEMPTS: this.writeRetryAttempts,
      VAULT_WRITE_RETRY_BASE_DELAY_MS: this.writeRetryBaseDelayMs,
      VAULT_WRITE_RETRY_MAX_DELAY_MS: this.writeRetryMaxDelayMs
    };
  }

  async refreshTokenFromAgentFile() {
    if (!this.agentEnabled || (this.agentAuthMode !== "file" && this.agentAuthMode !== "both")) {
      return;
    }

    if (!this.agentTokenFilePath) {
      throw new Error("Vault Agent token file path is required when VAULT_AGENT_ENABLED=true");
    }

    const token = (await readFile(this.agentTokenFilePath, "utf8")).trim();
    if (!token) {
      throw new Error(`Vault Agent token file is empty: ${this.agentTokenFilePath}`);
    }

    this.client.token = token;
    this.tokenConfigured = true;
  }

  async readAgentToken() {
    if (!this.agentEnabled || (this.agentAuthMode !== "file" && this.agentAuthMode !== "both")) {
      throw new Error("Vault Agent token file access is disabled");
    }

    if (!this.agentTokenFilePath) {
      throw new Error("Vault Agent token file path is not configured");
    }

    const token = (await readFile(this.agentTokenFilePath, "utf8")).trim();
    if (!token) {
      throw new Error(`Vault Agent token file is empty: ${this.agentTokenFilePath}`);
    }

    return {
      token,
      tokenFilePath: this.agentTokenFilePath
    };
  }

  async healthcheck() {
    await this.refreshTokenFromAgentFile();
    await this.client.health();
    return { ok: true };
  }

  async listSecrets(prefix) {
    await this.refreshTokenFromAgentFile();
    const normalizedPrefix = String(prefix ?? "").replace(/^\/+|\/+$/g, "");
    const path = normalizedPrefix ? `${this.kvMount}/metadata/${normalizedPrefix}` : `${this.kvMount}/metadata`;
    const response = await this.client.list(path);
    return response?.data?.keys ?? [];
  }

  async getSecret(path) {
    await this.refreshTokenFromAgentFile();
    const response = await this.client.read(`${this.kvMount}/data/${path}`);
    return response?.data?.data ?? null;
  }

  async setSecret(path, value) {
    await this.refreshTokenFromAgentFile();
    await this.enqueueWrite(() => this.client.write(`${this.kvMount}/data/${path}`, { data: value }));
    return { ok: true, path };
  }

  async deleteSecret(path) {
    await this.refreshTokenFromAgentFile();
    await this.enqueueWrite(() => this.client.delete(`${this.kvMount}/data/${path}`));
    return { ok: true, path };
  }

  async tokenLookupSelf() {
    await this.refreshTokenFromAgentFile();
    return await this.client.tokenLookupSelf();
  }

  async tokenRenewSelf(increment) {
    await this.refreshTokenFromAgentFile();
    return await this.client.tokenRenewSelf(increment ? { increment } : undefined);
  }

  async tokenCreate(options = {}) {
    await this.refreshTokenFromAgentFile();
    return await this.client.tokenCreate(options);
  }

  async tokenRevoke(token) {
    await this.refreshTokenFromAgentFile();
    return await this.client.tokenRevoke({ token });
  }

  async tokenRevokeSelf() {
    await this.refreshTokenFromAgentFile();
    return await this.client.tokenRevokeSelf();
  }

  enqueueWrite(operation) {
    const job = this.writeQueue.then(() => this.withWriteRetry(operation));
    this.writeQueue = job.catch(() => undefined);
    return job;
  }

  async withWriteRetry(operation) {
    let attempt = 0;

    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= this.writeRetryAttempts) {
          throw error;
        }

        const delay = Math.min(this.writeRetryBaseDelayMs * Math.pow(2, attempt), this.writeRetryMaxDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt += 1;
      }
    }
  }
}
