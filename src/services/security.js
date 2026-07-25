const SENSITIVE_KEY_PARTS = [
  "token",
  "secret",
  "password",
  "apikey",
  "api_key",
  "private_key"
];

export function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

export function redactObject(value, allowSensitiveOutput) {
  if (allowSensitiveOutput) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactObject(entry, false));
  }

  if (value && typeof value === "object") {
    const output = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? "[REDACTED]" : redactObject(nestedValue, false);
    }
    return output;
  }

  return value;
}
