# Agent Notes: openshift-mcp

This repository implements an OpenShift MCP server derived from the skeleton architecture.

Guidance for contributors:
- Keep secrets in Vault, never in Postgres or plain files.
- Keep user/project/runtime configuration in Postgres.
- Preserve multi-user token isolation per user id.
- Keep mutating MCP tools guarded by `MCP_ADMIN_AUTH_KEY` when enabled.
- Preserve external Vault and Postgres services support via `docker-compose.external.yml`.

The app-only compose path is required for deployments that rely on external Vault and Postgres services.
