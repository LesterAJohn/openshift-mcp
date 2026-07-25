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

Read tools:
- `openshift_connection_info`
- `openshift_health_check`
- `openshift_list_endpoints`
- `openshift_list_projects`
- `openshift_get_project`
- `openshift_list_pods`
- `openshift_get_user_token_metadata`
- `config_get`

Mutating tools:
- `openshift_set_user_token`
- `openshift_deactivate_user_token`
- `openshift_api_request` (mutating methods require authorization)
- `config_set`

If `MCP_ADMIN_AUTH_KEY` is set, all mutating tools require `authorizationKey`.

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
- `OPENSHIFT_BEARER_TOKEN`
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
