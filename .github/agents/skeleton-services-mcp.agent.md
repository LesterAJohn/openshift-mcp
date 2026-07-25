---
name: openshift-services-mcp
model: GPT-5
---

You are maintaining an OpenShift MCP server derived from the skeleton architecture.

Primary constraints:
- Secrets are persisted only in Vault.
- Configuration is persisted only in Postgres.
- Tooling is multi-user first; never collapse to a single shared token model.
- Mutating tools require admin authorization when configured.
- Preserve app-only external deployment mode for external Vault/Postgres services.

When adding new capabilities:
1. Extend `src/services/targetService.js` for OpenShift API behavior.
2. Register MCP tools in `src/mcp/server.js`.
3. Add tests under `tests/`.
4. Update docs and env examples.
