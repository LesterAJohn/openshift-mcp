# openshift-mcp

OpenShift-focused MCP server with multi-cluster Amazon Redshift access, built from the `skeleton-mcp` architecture.

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
7. `src/services/redshift.js` connects to the Redshift cluster selected by each request.
8. `src/mcp/server.js` registers OpenShift, Redshift, and token lifecycle MCP tools.

## OpenShift MCP Tools

The server exposes 32 OpenShift-specific tools, 6 Redshift tools, 3 MCP admin-auth tools, and 2 Postgres configuration tools (43 total).

### Shared Invocation Contract

Use this contract for all tools unless a tool-specific note says otherwise.

- Access type:
  - Read-only tools do not mutate OpenShift, Postgres, or Vault.
  - Mutating tools can change cluster state, config state, token state, or queryable data.
  - High-risk tools can revoke credentials, run SQL, or issue arbitrary mutating API calls.
- Permission model:
  - If `MCP_ADMIN_AUTH_KEY` is configured and migrated to Vault, mutating operations require `authorizationKey`.
  - Read-only operations do not require `authorizationKey`.
  - All OpenShift operations execute with the selected user's token (if present) and are constrained by OpenShift RBAC.
- Environment and scope selection:
  - `userId` is optional on many tools. If omitted, the server uses `MCP_CONFIG_DEFAULT_USER_ID` (or `default`).
  - Redshift tools also require `clusterId` to select one named cluster within that user scope.
  - OpenShift tools use runtime base URL/timeouts from environment (`OPENSHIFT_API_BASE_URL`, `OPENSHIFT_TIMEOUT_MS`, auth mode settings).
- Parameter rules:
  - Strings use `min(1)` unless noted.
  - `clusterId` is normalized to lowercase and must match `^[a-z0-9][a-z0-9_-]{0,62}$`.
  - Mutating HTTP verbs are `POST`, `PUT`, `PATCH`, `DELETE`.
- Response shape:
  - Success payload is serialized into MCP text content and includes `{ ok: true, status: 200, data: ... }`.
  - Errors include `{ ok: false, status, error, details? }` and set `isError: true`.
- Common failure conditions:
  - `401` invalid or missing `authorizationKey` for required mutating calls.
  - `403` OpenShift RBAC denial.
  - `404` missing project/resource/cluster config.
  - `409` auth rotation requested before bootstrap.
  - `422` missing or invalid persisted credentials.
  - `503` Vault/Postgres/OpenShift connectivity issues.

### Tool Definitions

Notes:
- `Use` and `Avoid` define when the tool should and should not be used.
- `Risk` values are `read-only`, `mutating`, or `high-risk`.
- `Flow` recommends prerequisite and follow-up tools.
- `Example` snippets are valid request argument payloads.

#### OpenShift Read-Only Tools

| Tool | Use / Avoid | Risk | Permissions and prerequisites | Parameters and constraints | Scope selection | Expected `data` shape | Common failures | Flow | Example |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `openshift_connection_info` | Use to inspect MCP/OpenShift/Vault/Postgres wiring. Avoid for workload data. | read-only | Requires healthy service connections. | `userId?` | Uses resolved `userId` to show scope model paths. | server metadata, persistence health, connection info | 503 backend unavailable | Start here before troubleshooting, then `openshift_health_check`. | `{ "userId": "alice" }` |
| `openshift_health_check` | Use for API reachability/liveness. Avoid for version/capability details. | read-only | Requires OpenShift endpoint access; token optional by auth mode. | `userId?` | User token is loaded from Vault for that user. | upstream health response | 401/403 token or RBAC, 503 API down | After setting token, run before other OpenShift calls. | `{ "userId": "alice" }` |
| `openshift_get_version` | Use to read API server version. Avoid for upgrade planning details. | read-only | OpenShift API reachable. | `userId?` | Token by user scope. | Kubernetes/OpenShift version payload | 403/503 | After health check; pair with `openshift_get_cluster_version`. | `{}` |
| `openshift_list_endpoints` | Use to discover MCP-known convenience endpoints. Avoid for full dynamic API discovery. | read-only | None beyond server startup. | none | Not user-scoped. | `{ endpoints: [...] }` | rare; 500 internal only | Follow with `openshift_api_request` or dedicated tools. | `{}` |
| `openshift_discover_api_groups` | Use for full installed API group/version inventory. Avoid when dedicated tool already exists. | read-only | OpenShift discovery endpoints enabled. | `userId?` | Token by user scope affects visible groups. | groups/versions discovery | 403, 503 | Prerequisite for `openshift_discover_api_resources`. | `{ "userId": "alice" }` |
| `openshift_discover_api_resources` | Use to discover resources/verbs/subresources for one API version. Avoid guessing plural names. | read-only | Requires valid `apiVersion` from discovery. | `apiVersion`, `userId?` | Token by user scope. | resource list with verbs/subresources | 404 apiVersion missing, 403 | Run after `openshift_discover_api_groups`; before `openshift_resource_request`. | `{ "apiVersion": "apps/v1" }` |
| `openshift_discover_openapi` | Use for schema-level request/response structure. Avoid for live objects. | read-only | OpenAPI v3 available on cluster. | `schemaPath?`, `userId?` | Token by user scope. | OpenAPI index or one schema document | 404 schemaPath invalid, 503 | Use before crafting complex body payloads. | `{ "schemaPath": "apis/apps/v1" }` |
| `openshift_list_projects` | Use to enumerate accessible namespaces/projects. Avoid if exact project known. | read-only | User token should have project list/get rights. | `userId?` | Token by user scope. | project list | 403 | Use before namespace-scoped calls. | `{ "userId": "alice" }` |
| `openshift_get_project` | Use for one project details/status. Avoid for broad listings. | read-only | Project must exist and be visible by RBAC. | `projectName`, `userId?` | Token by user scope. | project object | 404, 403 | Follow `openshift_list_projects`. | `{ "projectName": "my-project" }` |
| `openshift_list_pods` | Use to list pods in namespace with selectors. Avoid for logs/details of one pod. | read-only | Namespace access required. | `namespace`, `labelSelector?`, `fieldSelector?`, `userId?` | Namespace + user token scope. | pod list | 403, 404 namespace | Follow with `openshift_get_pod` / `openshift_get_pod_logs`. | `{ "namespace": "my-project", "labelSelector": "app=api" }` |
| `openshift_get_pod` | Use to inspect one pod state/containers. Avoid for historical log analysis. | read-only | Pod must exist and be readable. | `namespace`, `podName`, `userId?` | Namespace + user token scope. | pod object | 404 pod, 403 | Start after `openshift_list_pods`. | `{ "namespace": "my-project", "podName": "api-abc123" }` |
| `openshift_get_pod_logs` | Use for container logs with tail/time controls. Avoid for metrics/events. | read-only | Pod/log RBAC needed. | `namespace`, `podName`, `container?`, `previous?`, `tailLines? (>=0)`, `sinceSeconds? (>0)`, `timestamps?`, `userId?` | Namespace + user token scope. | log text or structured log response | 400 invalid options, 404 pod/container | Use after identifying pod/container. | `{ "namespace": "my-project", "podName": "api-abc123", "tailLines": 200 }` |
| `openshift_list_events` | Use to troubleshoot warnings/failures by event stream. Avoid for object spec retrieval. | read-only | Event API and RBAC required. | `namespace?`, `fieldSelector?`, `type? (Normal|Warning)`, `userId?` | Cluster or namespace by args + user scope. | event list | 403 | Pair with pod/deployment diagnostics. | `{ "namespace": "my-project", "type": "Warning" }` |
| `openshift_list_deployments` | Use to inspect deployments in namespace. Avoid for scaling/restart actions. | read-only | Apps API readable. | `namespace`, `labelSelector?`, `fieldSelector?`, `userId?` | Namespace + user token scope. | deployment list | 403, 404 | Pre-check before scale/restart. | `{ "namespace": "my-project" }` |
| `openshift_list_services` | Use to list service frontends. Avoid for route hostnames. | read-only | Core services API readable. | `namespace`, `labelSelector?`, `userId?` | Namespace + user token scope. | service list | 403, 404 | Pair with routes/pods for traffic debugging. | `{ "namespace": "my-project" }` |
| `openshift_list_routes` | Use to list OpenShift routes. Avoid on pure Kubernetes clusters without route API. | read-only | Route API installed and authorized. | `namespace`, `labelSelector?`, `userId?` | Namespace + user token scope. | route list | 404 API absent, 403 | Follow with `openshift_get_route`. | `{ "namespace": "my-project" }` |
| `openshift_get_route` | Use for one route host/TLS/backends. Avoid for list use-cases. | read-only | Route must exist and be readable. | `namespace`, `routeName`, `userId?` | Namespace + user token scope. | route object | 404 route/API absent, 403 | After listing routes. | `{ "namespace": "my-project", "routeName": "frontend" }` |
| `openshift_list_cluster_operators` | Use to assess operator health/degradation. Avoid for workload troubleshooting only. | read-only | OpenShift config APIs available. | `userId?` | Cluster scope, token by user. | ClusterOperator list/conditions | 404 API absent, 403 | Pair with cluster version and events. | `{}` |
| `openshift_get_cluster_version` | Use to inspect desired/current updates and history. Avoid for node-level issues. | read-only | ClusterVersion API available. | `name?`, `userId?` | Cluster scope, token by user. | ClusterVersion object | 404 API/name, 403 | Use with `openshift_get_version`. | `{}` |
| `openshift_list_nodes` | Use for node inventory/conditions. Avoid for per-pod details. | read-only | Node list RBAC required. | `labelSelector?`, `fieldSelector?`, `userId?` | Cluster scope, token by user. | node list | 403 | Pair with `openshift_get_resource_usage` for capacity checks. | `{ "labelSelector": "node-role.kubernetes.io/worker" }` |
| `openshift_can_i` | Use for RBAC preflight checks. Avoid as a substitute for full policy audit. | read-only | SubjectAccessReview permission path available. | `verb`, `resource`, `apiGroup?`, `namespace?`, `resourceName?`, `userId?` | User token scope. | authorization decision details | 403 on SAR endpoint | Run before mutating operations to preflight rights. | `{ "verb": "patch", "resource": "deployments", "namespace": "my-project" }` |
| `openshift_list_role_bindings` | Use to inspect namespace/cluster RoleBindings. Avoid for full RBAC graphing. | read-only | RBAC APIs readable. | `namespace?`, `labelSelector?`, `userId?` | Cluster-wide or namespace scope. | RoleBinding list | 403 | Follow with `openshift_can_i` for action checks. | `{ "namespace": "my-project" }` |
| `openshift_list_crds` | Use to inventory installed CRDs. Avoid for CR instance data itself. | read-only | apiextensions API readable. | `labelSelector?`, `userId?` | Cluster scope, token by user. | CRD list | 403, 404 API absent | Pair with discovery tools and `openshift_resource_request`. | `{}` |
| `openshift_list_subscriptions` | Use to inspect OLM subscriptions. Avoid if OLM not installed. | read-only | OLM APIs and RBAC required. | `namespace?`, `labelSelector?`, `userId?` | Cluster or namespace scope. | subscription list | 404 OLM API absent, 403 | Pair with operator troubleshooting flows. | `{ "namespace": "openshift-operators" }` |
| `openshift_get_resource_usage` | Use for live metrics (`pods`/`nodes`). Avoid as a long-term monitoring replacement. | read-only | Metrics API (`metrics.k8s.io`) must be installed. | `resourceType (pods|nodes)`, `namespace?`, `name?`, `labelSelector?`, `userId?` | Scope depends on resource type and namespace. | usage metrics list/object | 404 metrics API absent, 403 | Prereq: validate metrics API via discovery. | `{ "resourceType": "pods", "namespace": "my-project" }` |
| `openshift_get_user_token_metadata` | Use to verify token metadata/index state without exposing token. Avoid for setting/revoking token. | read-only | Metadata key and Vault token path may or may not exist. | `userId` | Exact user scope required. | tokenConfigured flag, metadata record, index entry | 404/503 backing store errors | Use after set/deactivate operations to verify state. | `{ "userId": "alice" }` |

#### OpenShift Mutating and Generic Tools

Safety warning: these tools can alter production cluster state or credential state. Validate `userId`, namespace, and target name before invocation.

| Tool | Use / Avoid | Risk | Permissions and prerequisites | Parameters and constraints | Scope selection | Expected `data` shape | Common failures | Flow | Example |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `openshift_scale_deployment` | Use to change replica count. Avoid for rollout image/env changes. | mutating | Requires valid `authorizationKey` when admin auth configured and RBAC to patch scale. | `namespace`, `deploymentName`, `replicas (int >= 0)`, `userId?`, `authorizationKey?` | Namespace + user token scope. | scale result/deployment summary | 401 auth key, 403 RBAC, 404 deployment | Prereq: `openshift_list_deployments`; follow with `openshift_get_pod`/events. | `{ "namespace": "my-project", "deploymentName": "api", "replicas": 3, "authorizationKey": "..." }` |
| `openshift_rollout_restart` | Use for restart via pod-template annotation patch. Avoid for full rollout strategy changes. | mutating | Requires mutating auth and deployment patch rights. | `namespace`, `deploymentName`, `restartedAt? (ISO datetime)`, `userId?`, `authorizationKey?` | Namespace + user token scope. | rollout restart patch result | 401, 403, 404 | Prereq: check deployment health; follow with events/pod status. | `{ "namespace": "my-project", "deploymentName": "api", "authorizationKey": "..." }` |
| `openshift_resource_request` | Use for any discovered resource operation by coordinates. Avoid when a dedicated tool exists for safer validation. | high-risk for mutating verbs | For `POST/PUT/PATCH/DELETE`, mutating auth required. Requires accurate discovery coordinates. | `apiVersion`, `resource`, `method (GET/POST/PUT/PATCH/DELETE default GET)`, optional `namespace`, `name`, `subresource`, `query?`, `body?`, `headers?`, `userId?`, `authorizationKey?` | Uses user token; namespace optional based on resource scope. | passthrough API response | 400 malformed coordinates/body, 401 mutating auth, 403 RBAC, 404 resource | Prereq: discovery tools; follow with targeted read tool. | `{ "apiVersion": "apps/v1", "resource": "deployments", "namespace": "my-project", "method": "GET" }` |
| `openshift_api_request` | Use for raw path/non-resource APIs not covered elsewhere. Avoid for common workflows where dedicated tools exist. | high-risk for mutating verbs | Mutating verbs require `authorizationKey`; path must be valid API path. | `method`, `path`, optional `query?`, `body?`, `headers?`, `userId?`, `authorizationKey?` | Path is normalized to leading `/`; token by user scope. | passthrough API response | 400 invalid path/method, 401, 403, 404 | Prereq: `openshift_list_endpoints` or discovery; follow with specific read validation. | `{ "method": "GET", "path": "/apis/apps/v1/namespaces/my-project/deployments" }` |
| `openshift_set_user_token` | Use to create/rotate a user's OpenShift bearer token and metadata/index records. Avoid for temporary session-only tokens. | high-risk | Mutating auth required when configured; Vault and Postgres must be writable. | `userId`, `token`, optional `tokenId`, `expiresAt`, `scopes[]`, `audience[]`, `authorizationKey?` | Writes to user-scoped Vault token path, shared token index, and user metadata key. | redacted token path/index metadata summary | 401, 422 Vault write/read issues, 503 backends | Prereq: `mcp_admin_auth_verify`; follow with `openshift_get_user_token_metadata` and `openshift_health_check`. | `{ "userId": "alice", "token": "sha256:replace-me", "authorizationKey": "..." }` |
| `openshift_deactivate_user_token` | Use to revoke user token, mark index inactive, and delete user token secret. Avoid if you only need metadata inspection. | high-risk destructive | Mutating auth required when configured. Operation is destructive for direct token secret. | `userId`, `authorizationKey?` | Affects only selected user scope and shared index entry for that token hash. | `{ userId, tokenSecretPath, tokenIndexPath, active:false }` | 401, 503 Vault/store failures | Prereq: confirm target with `openshift_get_user_token_metadata`; follow with metadata check and health check as that user. | `{ "userId": "alice", "authorizationKey": "..." }` |

#### MCP Admin Authorization Tools

Safety warning: rotation invalidates prior mutating access immediately.

| Tool | Use / Avoid | Risk | Permissions and prerequisites | Parameters and constraints | Scope selection | Expected `data` shape | Common failures | Flow | Example |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `mcp_admin_auth_status` | Use to confirm whether mutating guard is active and where verifier is sourced. Avoid for key validation. | read-only | Vault reachable for final source of truth. | none | Global server scope. | `{ configured, source, vaultPath, rotatedAt }` | 503 Vault unavailable | Prereq for verify/rotate runbooks. | `{}` |
| `mcp_admin_auth_verify` | Use to test an `authorizationKey` without mutation. Avoid as a substitute for role management. | read-only security check | Requires candidate key. | `authorizationKey` | Global auth verifier scope. | `{ authorized: true }` on success | 401 invalid key, 503 vault issues | Run before all mutating calls. | `{ "authorizationKey": "current-admin-key" }` |
| `mcp_admin_auth_rotate` | Use to replace admin key hash in Vault. Avoid frequent unnecessary rotation in active automations without client coordination. | high-risk mutating | Requires currently valid `authorizationKey`; new key min length 16. | `authorizationKey`, `newAuthorizationKey (min 16)` | Global auth verifier scope. | `{ configured:true, source:"vault", vaultPath, rotatedAt }` | 401 invalid current key, 409 not bootstrapped, 503 Vault | Prereq: status + verify; follow by updating all clients and re-verify. | `{ "authorizationKey": "old-key", "newAuthorizationKey": "new-key-with-16-plus" }` |

#### Redshift Tools

Safety warning: query and cluster mutation can affect data availability and integrity.

| Tool | Use / Avoid | Risk | Permissions and prerequisites | Parameters and constraints | Scope selection | Expected `data` shape | Common failures | Flow | Example |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `redshift_list_clusters` | Use to list configured clusters for user without credentials. Avoid for connectivity validation. | read-only | Redshift feature enabled and config store readable. | `userId?` | User-scoped config prefix `redshift.cluster.*`. | metadata list with `clusterId` and `updatedAt` | 503 config store | Prereq before selecting `clusterId`. | `{ "userId": "alice" }` |
| `redshift_get_cluster` | Use to inspect one cluster metadata. Avoid for secrets (never returned). | read-only | Cluster record must exist. | `clusterId`, `userId?` (`clusterId` normalized/lowercase policy) | User + cluster selection. | one metadata record | 404 cluster missing, 400 invalid id | Follow `redshift_list_clusters`. | `{ "clusterId": "analytics" }` |
| `redshift_health_check` | Use to validate connection/auth to selected cluster. Avoid for SQL validation. | read-only | Cluster metadata and Vault credentials must exist. | `clusterId`, `userId?` | User + cluster selection. | connectivity/status fields | 404 cluster, 422 missing credentials, network errors | Run before `redshift_query`. | `{ "clusterId": "analytics", "userId": "alice" }` |
| `redshift_set_cluster` | Use to create/replace cluster connection + credentials. Avoid storing ad-hoc temporary credentials. | high-risk mutating | Mutating auth required when configured; Vault and Postgres writable. | `clusterId`, `host`, `database`, `username`, `password`, optional `port (1-65535 default 5439)`, `ssl (default true)`, `timeoutMs (>0 default 15000)`, `userId?`, `authorizationKey?` | Writes metadata to Postgres and credentials to Vault for user+cluster. | stored metadata (credentials excluded) | 401, 400 invalid id/port, 503 stores | Prereq: verify admin key; follow with health check. | `{ "clusterId": "analytics", "host": "example.redshift.amazonaws.com", "database": "warehouse", "username": "svc", "password": "secret", "authorizationKey": "..." }` |
| `redshift_remove_cluster` | Use to delete metadata and credentials for one cluster. Avoid if you only want to disable query access temporarily. | high-risk destructive | Mutating auth required when configured. | `clusterId`, `userId?`, `authorizationKey?` | Removes selected user+cluster config and secret. | `{ clusterId, deleted }` | 401, 400 invalid id, 503 store errors | Prereq: list/get to confirm target; follow by list check. | `{ "clusterId": "analytics", "authorizationKey": "..." }` |
| `redshift_query` | Use for parameterized SQL on a selected cluster. Avoid non-parameterized dynamic SQL from untrusted input. | high-risk mutating/data-impacting | Mutating auth required when configured; cluster and credentials must exist. | `clusterId`, `sql`, optional `parameters[] (default [])`, `maxRows (1-10000 default 1000)`, `userId?`, `authorizationKey?` | Executes in selected user+cluster context. | result rows/metadata limited by `maxRows` | 401, 404 cluster, 422 missing creds, SQL/runtime errors | Prereq: health check; follow with read-back validation query. | `{ "clusterId": "analytics", "sql": "select * from users where id = $1", "parameters": [42], "maxRows": 100 }` |

#### Postgres Config Tools

| Tool | Use / Avoid | Risk | Permissions and prerequisites | Parameters and constraints | Scope selection | Expected `data` shape | Common failures | Flow | Example |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `config_get` | Use to read user-scoped config keys. Avoid for secret material (use Vault-backed tools). | read-only | Postgres reachable. | `key`, `userId?` | Reads one key in selected user scope. | `{ userId, key, value, updatedAt }` | 503 db errors | Prereq: know exact key naming. | `{ "key": "redshift.cluster.analytics" }` |
| `config_set` | Use to write user-scoped non-secret config JSON. Avoid storing credentials/tokens in config. | mutating | Mutating auth required when configured; Postgres writable. | `key`, `value`, `userId?`, `authorizationKey?` | Writes one key in selected user scope. | `{ userId, key, value, updatedAt }` | 401, 503 db errors | Prereq: optional `config_get`; follow with `config_get` verification. | `{ "key": "feature.flag.demo", "value": { "enabled": true }, "authorizationKey": "..." }` |

### Destructive and High-Risk Operations Checklist

Before running these operations, explicitly verify target scope and identity:

- `openshift_deactivate_user_token`: confirm exact `userId`, then re-check metadata after revoke.
- `redshift_remove_cluster`: confirm `clusterId` and user scope to avoid removing the wrong tenant config.
- `mcp_admin_auth_rotate`: coordinate client key rollout first to avoid automation lockout.
- `openshift_api_request` and `openshift_resource_request` with mutating methods: prefer dedicated tools unless you need unsupported endpoints.
- `redshift_query`: use parameterized SQL and conservative `maxRows`.

Recommended preflight sequence for mutating sessions:

1. `mcp_admin_auth_status`
2. `mcp_admin_auth_verify`
3. `openshift_connection_info` or `redshift_health_check`
4. Targeted mutating tool
5. Matching read-only verification tool

`MCP_ADMIN_AUTH_KEY` is a bootstrap value. On first authorization or status operation, the server hashes it with SHA-256 and persists the verifier at `${APP_NAME}/admin/auth` in Vault. Vault takes precedence on subsequent process starts. The plaintext bootstrap or replacement key is never stored or returned by the server. Use a minimum of 16 characters when rotating.

Dedicated tools cover routine operations with validated inputs:
- Workloads and diagnostics: pods, logs, events, deployments, scaling, and rollout restart
- Networking: services and OpenShift routes
- Platform health: version, ClusterOperators, ClusterVersion, and nodes
- Authorization: self-access reviews and RoleBindings
- Extensibility: CRDs and Operator Lifecycle Manager subscriptions
- Capacity: pod and node usage through `metrics.k8s.io`

## Multi-Cluster Redshift

Redshift connections are user-scoped and selected by the required `clusterId` argument. A single MCP process can hold any number of named clusters for each user.

- `redshift_set_cluster` creates or replaces a cluster. Connection metadata is stored in Postgres, while `username` and `password` are stored in Vault.
- `redshift_list_clusters` and `redshift_get_cluster` return metadata without credentials.
- `redshift_health_check` validates the selected connection.
- `redshift_query` runs parameterized SQL and caps returned rows with `maxRows`.
- `redshift_remove_cluster` deletes both metadata and credentials for only the selected cluster.

Cluster configuration keys use `redshift.cluster.{clusterId}`. Credentials use `${APP_NAME}/redshift/users/{userId}/clusters/{clusterId}` in Vault. Cluster IDs accept 1-63 lowercase letters, numbers, hyphens, or underscores. When `MCP_ADMIN_AUTH_KEY` is configured, setting/removing clusters and running SQL require `authorizationKey`.

Example cluster registration:

```json
{
  "clusterId": "analytics",
  "host": "analytics.abc123.us-east-1.redshift.amazonaws.com",
  "port": 5439,
  "database": "warehouse",
  "username": "mcp_user",
  "password": "replace-with-secret",
  "ssl": true,
  "timeoutMs": 15000
}
```

Configure another cluster with a different `clusterId`, then pass the intended ID to every health check or query. SQL parameters use PostgreSQL placeholders such as `$1`, `$2`, and are supplied through the `parameters` array.

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

### Admin Key Bootstrap And Rotation

1. Set `MCP_ADMIN_AUTH_KEY` for the initial deployment.
2. Call `mcp_admin_auth_status`; this imports the hashed bootstrap verifier into Vault.
3. Call `mcp_admin_auth_verify` with `authorizationKey` to confirm access.
4. Call `mcp_admin_auth_rotate` with the current `authorizationKey` and `newAuthorizationKey`.
5. Update the calling client's key. The previous key no longer authorizes mutations.

If Vault cannot be read, admin verification fails closed rather than falling back to process-only authorization.

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
