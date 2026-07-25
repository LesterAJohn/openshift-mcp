#!/usr/bin/env node

import {
  DEFAULT_VAULT_UNSEAL_KEY_PATH,
  persistVaultUnsealKey,
  resolveVaultUnsealKey
} from "../src/config/vaultUnsealKey.js";

function usage() {
  process.stdout.write(`Usage:\n  node scripts/vault-unseal-key.js [options]\n\nOptions:\n  --json                 Print JSON output\n  --path <file>          Override key file path (default: src/config/vault.unseal.key.json)\n  --set <key>            Persist key to file and print result\n  --no-create            Do not create a new key when file is missing/empty\n  -h, --help             Show help\n`);
}

function fail(message) {
  process.stderr.write(`[vault-unseal-key][error] ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    json: false,
    filePath: DEFAULT_VAULT_UNSEAL_KEY_PATH,
    setKey: "",
    createIfMissing: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--json") {
      args.json = true;
      continue;
    }

    if (arg === "--path") {
      args.filePath = argv[i + 1] ?? "";
      i += 1;
      continue;
    }

    if (arg === "--set") {
      args.setKey = String(argv[i + 1] ?? "").trim();
      i += 1;
      continue;
    }

    if (arg === "--no-create") {
      args.createIfMissing = false;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }

    fail(`Unknown argument: ${arg}`);
  }

  if (!args.filePath) {
    fail("--path requires a non-empty value");
  }

  return args;
}

function printResult(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  process.stdout.write(`${result.key}\n`);
}

(function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.setKey) {
    persistVaultUnsealKey(args.setKey, args.filePath);
    printResult({
      key: args.setKey,
      source: "set",
      filePath: args.filePath
    }, args.json);
    return;
  }

  const resolved = resolveVaultUnsealKey({
    filePath: args.filePath,
    createIfMissing: args.createIfMissing
  });

  printResult(resolved, args.json);
})();
