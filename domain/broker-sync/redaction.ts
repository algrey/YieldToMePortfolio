// SPK-003 design-spike: defensive redaction for any raw provider payload a
// future broker adapter might log or surface in an error. This is a
// belt-and-braces guard, not the primary control — the primary control is
// that `BrokerAdapter`/`TokenEnvelopeRef` (see `contracts.ts`) never model a
// raw token/secret value in the first place, so there is normally nothing
// to redact. This function exists so that if an adapter implementation ever
// passes through an upstream payload verbatim (e.g. into a diagnostic
// error), obviously-named secret fields are stripped before serialization.

const SECRET_KEY_PATTERN =
  /token|secret|password|refresh|credential|api[_-]?key/i;
export const REDACTED_MARKER = "[redacted]";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively walks a plain-data payload and replaces the value of any key
 * matching a secret-shaped name with `REDACTED_MARKER`. Arrays and nested
 * objects are walked; non-plain values (functions, class instances) are
 * left untouched since they should never appear in a fixture/log payload.
 */
export function redactBrokerPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map((item) => redactBrokerPayload(item));
  }
  if (!isPlainObject(payload)) {
    return payload;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = REDACTED_MARKER;
      continue;
    }
    result[key] = redactBrokerPayload(value);
  }
  return result;
}

/** Redacts a payload and returns it as a JSON string safe to log. */
export function redactBrokerPayloadToJson(payload: unknown): string {
  return JSON.stringify(redactBrokerPayload(payload));
}
