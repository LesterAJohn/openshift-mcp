const ALLOWED_AGENT_AUTH_MODES = new Set(["none", "file", "listener", "both"]);

function asConfigString(value) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  return String(value).trim();
}

export async function resolveVaultAgentRuntimeConfig({ configStore, env }) {
  const defaultUserId = env.config.defaultUserId;

  const [authModeConfig, tokenFilePathConfig, listenerAddrConfig] = await Promise.all([
    configStore.getConfig(env.config.vaultAgent.authModeConfigKey, defaultUserId),
    configStore.getConfig(env.config.vaultAgent.tokenFilePathConfigKey, defaultUserId),
    configStore.getConfig(env.config.vaultAgent.listenerAddrConfigKey, defaultUserId)
  ]);

  const authModeCandidate = asConfigString(authModeConfig?.value).toLowerCase();
  const authMode = ALLOWED_AGENT_AUTH_MODES.has(authModeCandidate)
    ? authModeCandidate
    : env.vault.agentAuthMode;

  const tokenFilePath = asConfigString(tokenFilePathConfig?.value) || env.vault.agentTokenFilePath;
  const listenerAddr = asConfigString(listenerAddrConfig?.value) || env.vault.agentListenerAddr;

  const usesAgentFile = authMode === "file" || authMode === "both";
  const usesAgentListener = authMode === "listener" || authMode === "both";
  const enabled = env.vault.agentEnabled || authMode !== "none";

  return {
    enabled,
    authMode,
    tokenFilePath,
    listenerEnabled: usesAgentListener || env.vault.agentListenerEnabled,
    listenerAddr,
    sources: {
      authMode: authModeConfig ? "db" : "env",
      tokenFilePath: tokenFilePathConfig ? "db" : "env",
      listenerAddr: listenerAddrConfig ? "db" : "env"
    },
    usesAgentFile,
    usesAgentListener
  };
}
