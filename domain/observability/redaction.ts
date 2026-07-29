const SENSITIVE_KEY =
  /(access.?token|api.?key|authorization|cookie|secret|password|email|amount|price|quantity|balance|cost|value|user.?id|portfolio.?id|security.?id|target.?id|csv.*(row|data|content|text)|raw.*payload|provider.*payload)/i;
const SENSITIVE_STRING =
  /(?:bearer\s+ey[a-z0-9._-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|-----BEGIN [^-]+-----)/i;

export const REDACTED_VALUE = "[REDACTED]";

function redactValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) {
    return REDACTED_VALUE;
  }

  if (typeof value === "string") {
    return SENSITIVE_STRING.test(value) ? REDACTED_VALUE : value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }

  return value;
}

export function redactMetadata(value: unknown): Record<string, unknown> {
  const redacted = redactValue(value);
  return typeof redacted === "object" &&
    redacted !== null &&
    !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : { value: redacted };
}
