import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { env } from "./config/env.js";
import { createMcpServer } from "./mcp/server.js";
import { ConfigStore } from "./services/configStore.js";
import { TargetServiceClient } from "./services/targetService.js";
import { VaultService } from "./services/vault.js";

async function main() {
  if (env.transport.mode === "http") {
    await import("./http/index.js");
    return;
  }

  if (env.transport.mode === "both") {
    await import("./start-both.js");
    return;
  }

  const targetServiceClient = new TargetServiceClient(env.openshift);
  const configStore = new ConfigStore(env.postgres, {
    appName: env.appName,
    defaultUserId: env.config.defaultUserId
  });
  const vaultService = new VaultService({
    endpoint: env.vault.addr,
    token: env.vault.token,
    agentEnabled: env.vault.agentEnabled,
    agentAuthMode: env.vault.agentAuthMode,
    agentTokenFilePath: env.vault.agentTokenFilePath,
    agentListenerEnabled: env.vault.agentListenerEnabled,
    agentListenerAddr: env.vault.agentListenerAddr,
    kvMount: env.vault.kvMount,
    writeRetryAttempts: env.vault.writeRetryAttempts,
    writeRetryBaseDelayMs: env.vault.writeRetryBaseDelayMs,
    writeRetryMaxDelayMs: env.vault.writeRetryMaxDelayMs
  });

  const server = createMcpServer({
    name: env.mcpServerName,
    version: env.mcpServerVersion,
    appName: env.appName,
    defaultUserId: env.config.defaultUserId,
    allowSensitiveOutput: env.allowSensitiveOutput,
    tokenSecretPathPrefix: env.openshift.tokenSecretPathPrefix,
    tokenIndexPath: env.openshift.tokenIndexPath,
    tokenMetadataConfigKeyPrefix: env.openshift.tokenMetadataConfigKeyPrefix,
    serviceClient: targetServiceClient,
    configStore,
    vaultService
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await server.close();
    await configStore.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("MCP server failed to start", error);
  process.exit(1);
});
