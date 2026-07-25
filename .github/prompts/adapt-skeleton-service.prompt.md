# Adapt Skeleton Prompt

Convert skeleton-style MCP capabilities into OpenShift-specific tools while preserving:
- Vault persistence for all secret material.
- Postgres persistence for all configuration state.
- Multi-user token lifecycle support.
- App-only external deployment mode with external Vault/Postgres services.

Required deliverables:
1. OpenShift endpoint wrappers in `src/services/targetService.js`.
2. MCP tools in `src/mcp/server.js` for OpenShift operations and token updates.
3. Tests covering auth, token persistence, and user-scoped behavior.
4. Documentation updates in `README.md`, `.env.example`, and agent docs.
