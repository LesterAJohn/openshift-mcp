#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-openshift}"
TABLE_NAME="${APP_NAME}_config"

case "$APP_NAME" in
  ""|*[!a-z0-9_-]*)
    echo "Invalid APP_NAME: $APP_NAME" >&2
    exit 1
    ;;
esac

case "$TABLE_NAME" in
  ""|*[!a-z0-9_]*|[0-9]*)
    echo "Invalid derived table name: $TABLE_NAME" >&2
    exit 1
    ;;
esac

psql -v ON_ERROR_STOP=1 <<SQL
CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
  user_id TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

ALTER TABLE ${TABLE_NAME}
  ADD COLUMN IF NOT EXISTS user_id TEXT;

UPDATE ${TABLE_NAME}
SET user_id = 'default'
WHERE user_id IS NULL OR trim(user_id) = '';

ALTER TABLE ${TABLE_NAME}
  ALTER COLUMN user_id SET DEFAULT 'default';

ALTER TABLE ${TABLE_NAME}
  ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS ${TABLE_NAME}_key_idx ON ${TABLE_NAME} (key);

INSERT INTO ${TABLE_NAME} (user_id, key, value)
VALUES
  ('default', 'openshift.defaults', '{"apiVersion": "v1", "requestTimeoutMs": 15000}'),
  ('default', 'openshift.project.default', '"default"'),
  ('default', 'token.rotation.intervalMs', '86400000'),
  ('default', 'vault.agent.auth.mode', '"file"'),
  ('default', 'vault.agent.tokenFilePath', '"/tmp/vault-agent-token"'),
  ('default', 'vault.agent.listener.addr', '"http://127.0.0.1:8100"')
ON CONFLICT (user_id, key) DO NOTHING;
SQL
