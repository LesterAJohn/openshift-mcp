# Service Onboarding Playbook

Use this playbook when extending OpenShift MCP tools.

## Requirements

1. New secrets must persist in Vault KV only.
2. New user/runtime configuration must persist in Postgres (`${APP_NAME}_config`).
3. Multi-user behavior is mandatory; include `userId` in tool schemas where relevant.
4. Mutating operations must support `authorizationKey` checks.
5. Keep app-only compose path available for external Vault/Postgres support.

## Onboarding Checklist

- Add endpoint wrapper in `src/services/targetService.js`.
- Add MCP tool registration in `src/mcp/server.js`.
- Add or update tests in `tests/`.
- Update `.env.example` if configuration changes.
- Update README with tool and configuration impacts.

This playbook assumes OpenShift API consumption and an app-only compose path for external services.
