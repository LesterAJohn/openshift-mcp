#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEFAULT_MOUNT="${VAULT_KV_MOUNT:-secret}"
EXPORT_DIR="$ROOT_DIR/vault-production/backups"
EXPORT_FILE=""
TMP_EXPORT=""

COMPOSE_DEV_FILE="docker-compose.yml"
COMPOSE_PROD_FILE="vault-production/docker-compose.vault-prod.yml"
VAULT_CONTAINER_NAME="skeleton-mcp-vault"
VAULT_ADDR_DEFAULT="http://127.0.0.1:8200"
DEV_TOKEN_DEFAULT="root"
INIT_KEYS_OUT=""
SKIP_EXPORT=0
SKIP_IMPORT=0
SKIP_INIT=0
UNSEAL_KEY_PATH="src/config/vault.unseal.key.json"

usage() {
  cat <<'EOF'
Usage:
  bash vault-production/scripts/convert-dev-to-prod.sh [options]

Options:
  --mount <name>             KV mount to export/import (default: secret)
  --dev-token <token>        Dev root token (default: root)
  --vault-addr <url>         Vault API address (default: http://127.0.0.1:8200)
  --container <name>         Vault container name (default: skeleton-mcp-vault)
  --compose-dev <path>       Dev compose file (default: docker-compose.yml)
  --compose-prod <path>      Prod compose file (default: vault-production/docker-compose.vault-prod.yml)
  --skip-export              Do not export secrets from dev Vault
  --skip-import              Do not import exported secrets into prod Vault
  --skip-init                Skip vault operator init/unseal/login (already initialized)
  --unseal-key-path <path>   Unseal key JSON path (default: src/config/vault.unseal.key.json)
  --init-keys-out <path>     File path where init keys and root token are stored (mode 600)
  -h, --help                 Show this help

What this script does:
  1) Exports KV v2 secrets from a dev Vault instance.
  2) Stops dev Vault and starts a Raft-backed Vault container using vault-production config.
  3) Initializes and unseals Vault (unless --skip-init).
  4) Recreates the KV mount and imports exported secrets.

Important:
  - Generated vault-production/config/vault.hcl uses tls_disable=1 for bootstrap simplicity.
  - Replace with TLS cert/key before exposing outside localhost.
EOF
}

log() {
  printf '[convert] %s\n' "$*"
}

fail() {
  printf '[convert][error] %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

cleanup() {
  if [[ -n "$TMP_EXPORT" && -f "$TMP_EXPORT" ]]; then
    rm -f "$TMP_EXPORT"
  fi
}
trap cleanup EXIT

MOUNT="$DEFAULT_MOUNT"
DEV_TOKEN="$DEV_TOKEN_DEFAULT"
VAULT_ADDR="$VAULT_ADDR_DEFAULT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mount)
      MOUNT="$2"
      shift 2
      ;;
    --dev-token)
      DEV_TOKEN="$2"
      shift 2
      ;;
    --vault-addr)
      VAULT_ADDR="$2"
      shift 2
      ;;
    --container)
      VAULT_CONTAINER_NAME="$2"
      shift 2
      ;;
    --compose-dev)
      COMPOSE_DEV_FILE="$2"
      shift 2
      ;;
    --compose-prod)
      COMPOSE_PROD_FILE="$2"
      shift 2
      ;;
    --skip-export)
      SKIP_EXPORT=1
      shift
      ;;
    --skip-import)
      SKIP_IMPORT=1
      shift
      ;;
    --skip-init)
      SKIP_INIT=1
      shift
      ;;
    --unseal-key-path)
      UNSEAL_KEY_PATH="$2"
      shift 2
      ;;
    --init-keys-out)
      INIT_KEYS_OUT="$2"
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

need_cmd docker
need_cmd jq
need_cmd node

mkdir -p "$EXPORT_DIR"

[[ -f "$ROOT_DIR/$COMPOSE_DEV_FILE" ]] || fail "Compose file not found: $ROOT_DIR/$COMPOSE_DEV_FILE"
[[ -f "$ROOT_DIR/$COMPOSE_PROD_FILE" ]] || fail "Compose file not found: $ROOT_DIR/$COMPOSE_PROD_FILE"

run_in_container() {
  local token="$1"
  shift
  docker exec \
    -e VAULT_ADDR="$VAULT_ADDR" \
    -e VAULT_TOKEN="$token" \
    "$VAULT_CONTAINER_NAME" "$@"
}

read_vault_status() {
  docker exec -e VAULT_ADDR="$VAULT_ADDR" "$VAULT_CONTAINER_NAME" vault status -format=json
}

is_vault_initialized() {
  read_vault_status | jq -e '.initialized == true' >/dev/null 2>&1
}

is_vault_sealed() {
  read_vault_status | jq -e '.sealed == true' >/dev/null 2>&1
}

resolve_managed_unseal_key_no_create() {
  local output
  output="$(node "$ROOT_DIR/scripts/vault-unseal-key.js" --json --path "$ROOT_DIR/$UNSEAL_KEY_PATH" --no-create)"
  jq -r '.key' <<<"$output"
}

persist_managed_unseal_key() {
  local key="$1"
  node "$ROOT_DIR/scripts/vault-unseal-key.js" --path "$ROOT_DIR/$UNSEAL_KEY_PATH" --set "$key" >/dev/null
  log "Persisted Vault unseal key to: $UNSEAL_KEY_PATH"
}

unseal_with_managed_key() {
  local key
  key="$(resolve_managed_unseal_key_no_create)"

  [[ -n "$key" ]] || fail "Vault is sealed but no managed key was found. Set VAULT_UNSEAL_KEY or populate $UNSEAL_KEY_PATH"

  log "Unsealing Vault with managed key"
  docker exec -e VAULT_ADDR="$VAULT_ADDR" "$VAULT_CONTAINER_NAME" vault operator unseal "$key" >/dev/null
}

wait_for_vault() {
  local retries=30
  local i=0
  until docker exec "$VAULT_CONTAINER_NAME" sh -c 'vault status >/dev/null 2>&1'; do
    i=$((i + 1))
    if [[ $i -ge $retries ]]; then
      fail "Vault did not become ready in time"
    fi
    sleep 1
  done
}

list_kv_recursive() {
  local token="$1"
  local base="$2"

  local list_json
  if ! list_json="$(run_in_container "$token" vault kv list -format=json "$base" 2>/dev/null)"; then
    return 0
  fi

  jq -r '.[]' <<<"$list_json" | while IFS= read -r item; do
    if [[ "$item" == */ ]]; then
      list_kv_recursive "$token" "$base${item}"
    else
      printf '%s\n' "$base$item"
    fi
  done
}

export_dev_secrets() {
  TMP_EXPORT="$(mktemp)"
  local now
  now="$(date +%Y%m%d-%H%M%S)"
  EXPORT_FILE="$EXPORT_DIR/vault-kv-export-${now}.json"

  log "Exporting KV v2 secrets from mount: $MOUNT"

  local prefix="${MOUNT}/"
  mapfile -t paths < <(list_kv_recursive "$DEV_TOKEN" "$prefix")

  jq -n '{mount: $mount, exportedAt: $ts, secrets: []}' \
    --arg mount "$MOUNT" \
    --arg ts "$(date -u +%FT%TZ)" >"$TMP_EXPORT"

  for full_path in "${paths[@]:-}"; do
    [[ -z "$full_path" ]] && continue

    local rel
    rel="${full_path#${MOUNT}/}"

    local secret_json
    if ! secret_json="$(run_in_container "$DEV_TOKEN" vault kv get -format=json "${MOUNT}/${rel}" 2>/dev/null)"; then
      log "Skipping unreadable path: ${MOUNT}/${rel}"
      continue
    fi

    local data_json
    data_json="$(jq -c '.data.data' <<<"$secret_json")"

    jq --arg path "$rel" --argjson data "$data_json" \
      '.secrets += [{path: $path, data: $data}]' \
      "$TMP_EXPORT" >"${TMP_EXPORT}.next"
    mv "${TMP_EXPORT}.next" "$TMP_EXPORT"
  done

  mv "$TMP_EXPORT" "$EXPORT_FILE"
  TMP_EXPORT=""
  log "Export complete: $EXPORT_FILE"
}

start_prod_vault() {
  log "Stopping dev stack: $COMPOSE_DEV_FILE"
  docker compose -f "$ROOT_DIR/$COMPOSE_DEV_FILE" stop vault >/dev/null

  log "Starting prod Raft Vault stack: $COMPOSE_PROD_FILE"
  docker compose -f "$ROOT_DIR/$COMPOSE_PROD_FILE" up -d vault >/dev/null

  wait_for_vault
}

init_unseal_login() {
  if [[ "$SKIP_INIT" -eq 1 ]]; then
    log "Skipping init by request"
    if is_vault_sealed; then
      unseal_with_managed_key
    fi
    return
  fi

  if ! is_vault_initialized; then
    log "Initializing Vault"
    local init_json
    init_json="$(docker exec -e VAULT_ADDR="$VAULT_ADDR" "$VAULT_CONTAINER_NAME" vault operator init -format=json -key-shares=1 -key-threshold=1)"

    if [[ -n "$INIT_KEYS_OUT" ]]; then
      umask 177
      printf '%s\n' "$init_json" >"$INIT_KEYS_OUT"
      log "Wrote init keys and root token to: $INIT_KEYS_OUT"
    fi

    local key1 root_token
    key1="$(jq -r '.unseal_keys_b64[0]' <<<"$init_json")"
    root_token="$(jq -r '.root_token' <<<"$init_json")"

    persist_managed_unseal_key "$key1"
    log "Unsealing Vault"
    docker exec -e VAULT_ADDR="$VAULT_ADDR" "$VAULT_CONTAINER_NAME" vault operator unseal "$key1" >/dev/null

    DEV_TOKEN="$root_token"
    return
  fi

  if is_vault_sealed; then
    unseal_with_managed_key
  fi
}

enable_kv_mount_if_needed() {
  log "Ensuring KV v2 mount exists: $MOUNT"
  if run_in_container "$DEV_TOKEN" vault secrets list -format=json | jq -e --arg m "$MOUNT/" '.[$m]' >/dev/null 2>&1; then
    return
  fi
  run_in_container "$DEV_TOKEN" vault secrets enable -path="$MOUNT" kv-v2 >/dev/null
}

import_prod_secrets() {
  [[ "$SKIP_IMPORT" -eq 1 ]] && {
    log "Skipping import by request"
    return
  }

  if [[ -z "$EXPORT_FILE" ]]; then
    local latest
    latest="$(ls -1t "$EXPORT_DIR"/vault-kv-export-*.json 2>/dev/null | head -n1 || true)"
    [[ -z "$latest" ]] && fail "No export file found in $EXPORT_DIR"
    EXPORT_FILE="$latest"
  fi

  log "Importing secrets from: $EXPORT_FILE"

  local count
  count="$(jq '.secrets | length' "$EXPORT_FILE")"
  if [[ "$count" -eq 0 ]]; then
    log "No secrets to import"
    return
  fi

  while IFS= read -r entry; do
    local path data
    path="$(jq -r '.path' <<<"$entry")"
    data="$(jq -c '.data' <<<"$entry")"

    run_in_container "$DEV_TOKEN" vault write "$MOUNT/data/$path" "data=$data" >/dev/null
  done < <(jq -c '.secrets[]' "$EXPORT_FILE")

  log "Import complete"
}

log "Starting Vault dev-to-prod conversion (Raft storage)"
log "Root directory: $ROOT_DIR"
log "Mount: $MOUNT"

if [[ "$SKIP_EXPORT" -eq 0 ]]; then
  export_dev_secrets
else
  log "Skipping export by request"
fi

start_prod_vault
init_unseal_login
enable_kv_mount_if_needed
import_prod_secrets

log "Conversion finished"
log "Next steps: enable TLS, configure real auth methods, and rotate root token"
