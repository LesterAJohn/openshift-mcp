# Changelog

## Unreleased

- Added `mcp_query_suggestion_schema_discovery` to recommend tool usage and expose schema discovery for all registered MCP tools.
- Added user-scoped multi-cluster Redshift registration with Postgres metadata and Vault-backed credentials.
- Added Redshift cluster listing, lookup, removal, health check, and parameterized query tools selected by `clusterId`.
- Added MCP admin authorization status, verification, and rotation tools.
- Added automatic SHA-256 bootstrap verifier migration from `MCP_ADMIN_AUTH_KEY` to Vault.
- Changed all mutating tool guards to use fail-closed, Vault-backed authorization with immediate key rotation.
- Added 18 dedicated OpenShift tools for workloads, logs, events, networking, cluster health, RBAC, Operators, CRDs, and metrics.
- Added guarded deployment scaling and rollout restart operations.
- Added canonical API path and MCP authorization tests for the dedicated tools.
- Added dynamic discovery for core, grouped, aggregated, Operator, and custom-resource APIs.
- Added OpenAPI v3 schema discovery and a structured universal resource request tool.
- Added tests for core, grouped, namespaced, cluster-scoped, CRD, and subresource paths.
- Enforced user-scoped Vault token resolution without an environment bearer-token fallback.
- Documented multi-user Vault secrets and Postgres configuration persistence.
