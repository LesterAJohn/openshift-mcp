# openshift-mcp

OpenShift-focused MCP server built from the `skeleton-mcp` architecture.

This implementation keeps the skeleton contract intact:
- Secrets are persistent in Vault.
- Configuration is persistent in Postgres.
- Token and config operations are user-scoped (multi-user by design).
- Mutating MCP tools can be locked behind `MCP_ADMIN_AUTH_KEY`.

## Architecture

Runtime flow:
1. `src/index.js` boots stdio mode.
2. `src/http/index.js` boots HTTP mode.
3. `src/config/env.js` validates all runtime settings.
4. `src/services/configStore.js` persists configuration in Postgres (`${APP_NAME}_config`).
5. `src/services/vault.js` persists secret material in Vault KV.
6. `src/services/targetService.js` wraps OpenShift API requests.
7. `src/mcp/server.js` registers OpenShift and token lifecycle MCP tools.

## OpenShift MCP Tools

The server exposes 32 OpenShift-specific tools plus 2 Postgres configuration tools (34 total).

Read tools:
- `openshift_connection_info`
- `openshift_health_check`
- `openshift_get_version`
- `openshift_list_endpoints`
- `openshift_discover_api_groups`
- `openshift_discover_api_resources`
- `openshift_discover_openapi`
- `openshift_list_projects`
- `openshift_get_project`
- `openshift_list_pods`
- `openshift_get_pod`
- `openshift_get_pod_logs`
- `openshift_list_events`
- `openshift_list_deployments`
- `openshift_list_services`
- `openshift_list_routes`
- `openshift_get_route`
- `openshift_list_cluster_operators`
- `openshift_get_cluster_version`
- `openshift_list_nodes`
- `openshift_can_i`
- `openshift_list_role_bindings`
- `openshift_list_crds`
- `openshift_list_subscriptions`
- `openshift_get_resource_usage`
- `openshift_get_user_token_metadata`
- `config_get`

Mutating tools:
- `openshift_scale_deployment`
- `openshift_rollout_restart`
- `openshift_set_user_token`
- `openshift_deactivate_user_token`
- `openshift_resource_request` (mutating methods require authorization)
- `openshift_api_request` (mutating methods require authorization)
- `config_set`

If `MCP_ADMIN_AUTH_KEY` is set, all mutating tools require `authorizationKey`.

Dedicated tools cover routine operations with validated inputs:
- Workloads and diagnostics: pods, logs, events, deployments, scaling, and rollout restart
- Networking: services and OpenShift routes
- Platform health: version, ClusterOperators, ClusterVersion, and nodes
- Authorization: self-access reviews and RoleBindings
- Extensibility: CRDs and Operator Lifecycle Manager subscriptions
- Capacity: pod and node usage through `metrics.k8s.io`

## Complete API Coverage

OpenShift API availability varies by release, enabled cluster features, aggregated API servers, installed Operators, and CustomResourceDefinitions. For that reason, complete coverage is discovery-driven rather than a fixed list of hard-coded endpoints.

1. `openshift_discover_api_groups` reads `/api` and `/apis` to enumerate every installed core and grouped API version.
2. `openshift_discover_api_resources` reads the selected version endpoint and returns its resources, namespaced scope, supported verbs, short names, categories, and subresources.
3. `openshift_discover_openapi` reads `/openapi/v3` and its returned schema paths for request and response schemas.
4. `openshift_resource_request` addresses any discovered resource using `apiVersion`, plural `resource`, optional `namespace`, optional `name`, and optional `subresource`.
5. `openshift_api_request` covers non-resource and specialized endpoints by raw path.

This covers Kubernetes APIs, OpenShift APIs, aggregated APIs such as metrics, Operator Lifecycle Manager APIs, installed Operator APIs, CRDs, and future APIs without requiring a server release. Actual discovery results and allowed operations are constrained by the selected user's OpenShift RBAC permissions.

Examples supported by `openshift_resource_request`:
- Core namespaced resource: `apiVersion=v1`, `resource=pods`, `namespace=default`
- Cluster-scoped resource: `apiVersion=v1`, `resource=nodes`
- OpenShift resource: `apiVersion=route.openshift.io/v1`, `resource=routes`, `namespace=my-project`
- Operator resource: `apiVersion=operators.coreos.com/v1alpha1`, `resource=subscriptions`, `namespace=openshift-operators`
- Arbitrary CRD: use the `apiVersion` and plural resource returned by discovery
- Subresource: set `name` and `subresource`, such as `deployments/{name}/scale` or `pods/{name}/log`

## Multi-User Token Model

Each user token is stored in Vault and indexed for policy validation:
- Direct user token secret path: `${OPENSHIFT_USER_TOKEN_SECRET_PATH_PREFIX}/{normalizedUserId}`
- Shared token index path: `${OPENSHIFT_TOKEN_INDEX_PATH}`

Token metadata is persisted to Postgres under:
- key pattern: `${OPENSHIFT_TOKEN_METADATA_CONFIG_KEY_PREFIX}.{userId}`

This lets each user independently rotate/revoke tokens without impacting other users.

## Configuration Persistence Model

All runtime/user configuration is persisted in Postgres table `${APP_NAME}_config`:
- Primary key: `(user_id, key)`
- Value type: `JSONB`

`config_get` and `config_set` expose this persistence model through MCP.

## Environment Variables

Core:
- `APP_NAME`
- `MCP_SERVER_NAME`
- `MCP_SERVER_VERSION`
- `MCP_ALLOW_SENSITIVE_OUTPUT`
- `MCP_ADMIN_AUTH_KEY`
- `MCP_CONFIG_DEFAULT_USER_ID`
- `MCP_TRANSPORT_MODE`

OpenShift:
- `OPENSHIFT_API_BASE_URL`
- `OPENSHIFT_TIMEOUT_MS`
- `OPENSHIFT_AUTH_MODE` (`none`, `bearer`)
- `OPENSHIFT_USER_TOKEN_SECRET_PATH_PREFIX`
- `OPENSHIFT_TOKEN_INDEX_PATH`
- `OPENSHIFT_TOKEN_METADATA_CONFIG_KEY_PREFIX`

Postgres:
- `POSTGRES_HOST`
- `POSTGRES_PORT`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`

Vault:
- `VAULT_ADDR`
- `VAULT_TOKEN`
- `VAULT_AGENT_ENABLED`
- `VAULT_AGENT_AUTH_MODE`
- `VAULT_AGENT_TOKEN_FILE_PATH`
- `VAULT_AGENT_LISTENER_ENABLED`
- `VAULT_AGENT_LISTENER_ADDR`
- `VAULT_KV_MOUNT`
- `VAULT_WRITE_RETRY_ATTEMPTS`
- `VAULT_WRITE_RETRY_BASE_DELAY_MS`
- `VAULT_WRITE_RETRY_MAX_DELAY_MS`

HTTP transport:
- `MCP_HTTP_HOST`
- `MCP_HTTP_PORT`
- `MCP_HTTP_PATH`
- `MCP_HTTP_HEALTH_PATH`
- `MCP_HTTP_AUTH_MODE`
- `MCP_HTTP_AUTH_TOKENS`
- `MCP_HTTP_TRUST_PROXY`
- `MCP_HTTP_ALLOWED_ORIGINS`
- `MCP_HTTP_ALLOWED_IPS`
- `MCP_HTTP_MAX_BODY_BYTES`
- `MCP_HTTP_RATE_LIMIT_WINDOW_MS`
- `MCP_HTTP_RATE_LIMIT_MAX_REQUESTS`

Use `.env.example` as the baseline.

## Local Development

1. Install dependencies.
2. Copy `.env.example` to `.env` and set OpenShift + Vault + Postgres values.
3. Start local infra:
   - `docker compose up -d`
4. Start MCP:
   - stdio: `npm run start:stdio`
   - HTTP: `npm run start:http`
5. Run tests:
   - `npm test`

## External Services Mode

Use this when Vault and Postgres are managed externally.

- Compose file: `docker-compose.external.yml`
- Required external settings include:
  - `POSTGRES_HOST`
  - `POSTGRES_PORT`
  - `POSTGRES_DB`
  - `POSTGRES_USER`
  - `POSTGRES_PASSWORD`
  - `VAULT_ADDR`
  - `VAULT_TOKEN`

The app-only compose path keeps this repo focused on MCP runtime while connecting to external Vault and Postgres services.

## MCP Registration Example (stdio)

```json
{
  "mcpServers": {
    "openshift-mcp": {
      "command": "npm",
      "args": ["run", "start:stdio"],
      "cwd": "/Users/lesterjohn/Documents/GitHub/openshift-mcp"
    }
  }
}
```
