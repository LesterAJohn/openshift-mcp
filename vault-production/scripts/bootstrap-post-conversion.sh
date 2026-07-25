#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
VAULT_CONTAINER_NAME="skeleton-mcp-vault"
KV_MOUNT="${VAULT_KV_MOUNT:-secret}"
APPROLE_PATH="approle"
POLICY_NAME="mcp-service-policy"
ROLE_NAME="skeleton-mcp-service"
AUDIT_PATH="file"
AUDIT_FILE="/vault/file/audit.log"
OUTPUT_FORMAT="env"
OUTPUT_FILE=""

usage() {
  cat <<'EOF'
Usage:
  bash vault-production/scripts/bootstrap-post-conversion.sh [options]

Options:
  --vault-addr <url>         Vault address (default: http://127.0.0.1:8200)
  --vault-token <token>      Vault token with admin privileges (required)
  --container <name>         Vault container name (default: skeleton-mcp-vault)
  --kv-mount <name>          KV v2 mount for app secrets (default: secret)
  --policy-name <name>       Policy name (default: mcp-service-policy)
  --role-name <name>         AppRole name (default: skeleton-mcp-service)
  --approle-path <path>      Auth mount path for AppRole (default: approle)
  --audit-path <path>        Audit device path (default: file)
  --audit-file <path>        Audit log file path (default: /vault/file/audit.log)
  --output <format>          Credential output format: env or json (default: env)
  --output-file <path>       Write credential output to file instead of stdout
  -h, --help                 Show help

What this script does:
  1) Enables a file audit device (if not already enabled).
  2) Creates or updates a least-privilege policy for KV v2 access.
  3) Enables AppRole auth method (if needed).
  4) Creates or updates an AppRole for MCP service usage.
  5) Prints ROLE_ID and a newly generated SECRET_ID.
EOF
}

log() {
  printf '[bootstrap] %s\n' "$*"
}

fail() {
  printf '[bootstrap][error] %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

VAULT_TOKEN=""

emit_credentials() {
  local role_id="$1"
  local secret_id="$2"
  local output

  case "$OUTPUT_FORMAT" in
    env)
      output=$(printf 'ROLE_ID=%s\nSECRET_ID=%s\n' "$role_id" "$secret_id")
      ;;
    json)
      output=$(jq -n --arg role_id "$role_id" --arg secret_id "$secret_id" '{role_id: $role_id, secret_id: $secret_id}')
      ;;
    *)
      fail "Unsupported output format: $OUTPUT_FORMAT (use env or json)"
      ;;
  esac

  if [[ -n "$OUTPUT_FILE" ]]; then
    umask 177
    printf '%s\n' "$output" >"$OUTPUT_FILE"
    log "Credential output written to: $OUTPUT_FILE"
    return
  fi

  printf '%s\n' "$output"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault-addr)
      VAULT_ADDR="$2"
      shift 2
      ;;
    --vault-token)
      VAULT_TOKEN="$2"
      shift 2
      ;;
    --container)
      VAULT_CONTAINER_NAME="$2"
      shift 2
      ;;
    --kv-mount)
      KV_MOUNT="$2"
      shift 2
      ;;
    --policy-name)
      POLICY_NAME="$2"
      shift 2
      ;;
    --role-name)
      ROLE_NAME="$2"
      shift 2
      ;;
    --approle-path)
      APPROLE_PATH="$2"
      shift 2
      ;;
    --audit-path)
      AUDIT_PATH="$2"
      shift 2
      ;;
    --audit-file)
      AUDIT_FILE="$2"
      shift 2
      ;;
    --output)
      OUTPUT_FORMAT="$2"
      shift 2
      ;;
    --output-file)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

[[ -n "$VAULT_TOKEN" ]] || fail "--vault-token is required"

need_cmd docker
need_cmd jq

run_in_container() {
  docker exec \
    -e VAULT_ADDR="$VAULT_ADDR" \
    -e VAULT_TOKEN="$VAULT_TOKEN" \
    "$VAULT_CONTAINER_NAME" "$@"
}

wait_for_unsealed_vault() {
  local retries=30
  local i=0

  until run_in_container vault status -format=json | jq -e '.initialized == true and .sealed == false' >/dev/null 2>&1; do
    i=$((i + 1))
    if [[ $i -ge $retries ]]; then
      fail "Vault not ready (must be initialized and unsealed)"
    fi
    sleep 1
  done
}

enable_audit_if_needed() {
  log "Ensuring audit device is enabled at path: $AUDIT_PATH"

  if run_in_container vault audit list -format=json | jq -e --arg p "$AUDIT_PATH/" '.[$p]' >/dev/null 2>&1; then
    return
  fi

  run_in_container vault audit enable -path="$AUDIT_PATH" file file_path="$AUDIT_FILE" >/dev/null
}

write_policy() {
  log "Writing policy: $POLICY_NAME"

  local tmp_policy
  tmp_policy="$(mktemp)"

  cat >"$tmp_policy" <<EOF
path "${KV_MOUNT}/data/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

path "${KV_MOUNT}/metadata/*" {
  capabilities = ["read", "list"]
}
EOF

  docker cp "$tmp_policy" "$VAULT_CONTAINER_NAME:/tmp/${POLICY_NAME}.hcl"
  run_in_container vault policy write "$POLICY_NAME" "/tmp/${POLICY_NAME}.hcl" >/dev/null
  run_in_container rm -f "/tmp/${POLICY_NAME}.hcl" >/dev/null
  rm -f "$tmp_policy"
}

enable_approle_if_needed() {
  log "Ensuring AppRole auth method is enabled at: $APPROLE_PATH"

  if run_in_container vault auth list -format=json | jq -e --arg p "$APPROLE_PATH/" '.[$p]' >/dev/null 2>&1; then
    return
  fi

  run_in_container vault auth enable -path="$APPROLE_PATH" approle >/dev/null
}

write_role() {
  log "Writing AppRole: $ROLE_NAME"

  run_in_container vault write "auth/${APPROLE_PATH}/role/${ROLE_NAME}" \
    token_policies="$POLICY_NAME" \
    token_ttl="1h" \
    token_max_ttl="4h" \
    secret_id_ttl="24h" \
    secret_id_num_uses="10" >/dev/null
}

print_role_credentials() {
  local role_id secret_id
  role_id="$(run_in_container vault read -field=role_id "auth/${APPROLE_PATH}/role/${ROLE_NAME}/role-id")"
  secret_id="$(run_in_container vault write -f -field=secret_id "auth/${APPROLE_PATH}/role/${ROLE_NAME}/secret-id")"

  emit_credentials "$role_id" "$secret_id"
  log "Store these credentials securely and rotate them according to policy"
}

log "Starting post-conversion Vault bootstrap"
wait_for_unsealed_vault
enable_audit_if_needed
write_policy
enable_approle_if_needed
write_role
print_role_credentials
log "Bootstrap complete"
