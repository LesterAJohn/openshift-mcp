# Vault Production Migration (Raft)

This directory contains assets to migrate the local dev Vault setup to a Raft-backed Vault server.

## Structure

- `config/vault.hcl`:
  Vault server config that enables Raft storage at `/vault/data`.
- `docker-compose.vault-prod.yml`:
  Compose service for running Vault with `vault server -config=/vault/config/vault.hcl`.
- `scripts/convert-dev-to-prod.sh`:
  Conversion script that exports secrets from dev Vault, starts Raft Vault, initializes/unseals, and imports secrets.
- `scripts/bootstrap-post-conversion.sh`:
  Post-conversion bootstrap script that enables audit logging, writes a least-privilege policy, and configures AppRole credentials for MCP service use.
- `../scripts/vault-unseal-key.js`:
  Resolves Vault unseal key from `VAULT_UNSEAL_KEY` or `src/config/vault.unseal.key.json`.
- `backups/`:
  Export files created during conversion.

## Usage

From repository root:

```bash
bash vault-production/scripts/convert-dev-to-prod.sh --init-keys-out vault-production/backups/vault-init.json
```

Useful options:

```bash
# Use a different mount
bash vault-production/scripts/convert-dev-to-prod.sh --mount secret

# Skip export/import when testing only infrastructure transition
bash vault-production/scripts/convert-dev-to-prod.sh --skip-export --skip-import

# If Vault is already initialized, skip init/unseal steps
bash vault-production/scripts/convert-dev-to-prod.sh --skip-init

# Override key file path used for manual unseal flows
bash vault-production/scripts/convert-dev-to-prod.sh --unseal-key-path src/config/vault.unseal.key.json

# Post-conversion hardening bootstrap (policy, AppRole, audit)
bash vault-production/scripts/bootstrap-post-conversion.sh --vault-token <root_or_admin_token>

# Emit credentials as JSON for CI pipelines
bash vault-production/scripts/bootstrap-post-conversion.sh \
  --vault-token <root_or_admin_token> \
  --output json

# Write credentials to a secure file
bash vault-production/scripts/bootstrap-post-conversion.sh \
  --vault-token <root_or_admin_token> \
  --output json \
  --output-file vault-production/backups/approle-credentials.json
```

## Important Follow-ups

1. Replace `tls_disable = 1` in `config/vault.hcl` with proper TLS cert/key settings.
2. Use the bootstrap script to create AppRole credentials, then stop using root token for applications.
3. Rotate bootstrap credentials and store generated ROLE_ID/SECRET_ID securely.
4. Back up Raft data and test restore procedures.

## Managed Unseal Key Injection

By default, conversion and unseal helpers read key material in this order:

1. `VAULT_UNSEAL_KEY` environment variable
2. `src/config/vault.unseal.key.json`
3. Generate and save a 24-character key in `src/config/vault.unseal.key.json` when the file is missing/empty

Schema carryover:

- `APP_NAME` is the single source of truth for app-prefixed names.
- The Postgres config table is derived as `${APP_NAME}_config`.
- The Vault token index path is derived as `${APP_NAME}/users/<user_id>/http/auth/token-index`.
- External Vault and Postgres stores should use the same derived table/path names as local development.

Compose startup behavior:

- `docker-compose.vault-prod.yml` runs a one-shot `vault-unseal-key-init` service before starting Vault.
- This ensures managed key material is resolved/created on every compose startup.

Examples:

```bash
# Use an injected key for this shell session
export VAULT_UNSEAL_KEY="replace-with-24-char-key"

# Resolve key source (env/file/generated)
npm run vault:unseal-key -- --json

# Persist a specific key to file
npm run vault:unseal-key -- --set "replace-with-24-char-key"
```

Note: this helper automates manual key handling and is not equivalent to Vault cloud KMS/HSM auto-unseal.

## Bootstrap Output Modes

- `--output env` (default): prints `ROLE_ID` and `SECRET_ID` as env-style lines.
- `--output json`: prints machine-readable JSON for CI/CD consumption.
- `--output-file <path>`: writes output to a file with restrictive permissions.
