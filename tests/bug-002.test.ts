import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  REQUEST_NOW_HEADER,
  resolveRequestNow,
} from "../domain/observability/index.ts";

// BUG-002 (hydration half): Vinext invokes a page's async Server Component
// TWICE per request. `app/authenticated-workspace.ts` used to call
// `new Date()` directly on each invocation, so a second/minute boundary
// crossed between the two passes could make the server-rendered HTML and
// the RSC flight payload disagree -- a React hydration mismatch. The fix
// stamps the request's canonical "now" ONCE at the Worker boundary
// (`worker/index.ts`) and carries it via `REQUEST_NOW_HEADER`; these tests
// cover the pure parse/validate/fallback helper and the Worker-boundary
// strip-before-stamp behaviour.

test("resolveRequestNow accepts a well-formed Worker-stamped header value", () => {
  const stamped = "2026-08-26T01:02:03.456Z";
  assert.equal(
    resolveRequestNow(stamped, () => "generated"),
    stamped,
  );
});

test("resolveRequestNow falls back to generate() when the header is missing", () => {
  assert.equal(
    resolveRequestNow(null, () => "generated"),
    "generated",
  );
  assert.equal(
    resolveRequestNow(undefined, () => "generated"),
    "generated",
  );
  assert.equal(
    resolveRequestNow("", () => "generated"),
    "generated",
  );
});

test("resolveRequestNow falls back on malformed or unparsable header values", () => {
  // Wrong shape (no milliseconds) -- the Worker only ever writes the exact
  // `Date#toISOString()` format, so anything else is untrusted.
  assert.equal(
    resolveRequestNow("2026-08-26T01:02:03Z", () => "generated"),
    "generated",
  );
  // Not a date at all.
  assert.equal(
    resolveRequestNow("not-a-date", () => "generated"),
    "generated",
  );
  // Injection-shaped value a spoofing client might try.
  assert.equal(
    resolveRequestNow("<script>bad</script>", () => "generated"),
    "generated",
  );
  // Syntactically matches the pattern but is not a real calendar date.
  assert.equal(
    resolveRequestNow("2026-13-40T99:99:99.999Z", () => "generated"),
    "generated",
  );
});

test("resolveRequestNow defaults to a fresh new Date() with no generate() override", () => {
  const before = Date.now();
  const resolved = resolveRequestNow(null);
  const after = Date.now();
  const resolvedMs = new Date(resolved).getTime();
  assert.ok(resolvedMs >= before && resolvedMs <= after);
});

test("two sequential reads of the same stamped request header yield the identical instant", () => {
  // Simulates Vinext's two RSC invocations of the SAME request: both read
  // the SAME `REQUEST_NOW_HEADER` value the Worker stamped once, so both
  // resolve to the identical instant regardless of how much wall-clock
  // time elapses between the two invocations (the exact scenario a bare
  // `new Date()` per invocation could desync across a second boundary).
  const request = new Request("https://example.test", {
    headers: { [REQUEST_NOW_HEADER]: "2026-08-26T01:02:03.456Z" },
  });
  const firstPassInstant = resolveRequestNow(
    request.headers.get(REQUEST_NOW_HEADER),
  );
  const secondPassInstant = resolveRequestNow(
    request.headers.get(REQUEST_NOW_HEADER),
  );
  assert.equal(firstPassInstant, secondPassInstant);
  assert.equal(firstPassInstant, "2026-08-26T01:02:03.456Z");
});

test("Worker entry strips a client-supplied request-now header before stamping its own", async () => {
  // `worker/index.ts` imports `vinext/server/app-router-entry`, which is
  // not runnable in a plain node:test process (same constraint the
  // existing MKT-011A scheduled-handler test works around) -- so, per that
  // precedent, this asserts against the SOURCE rather than executing
  // `fetch`. It mirrors the established `VERIFIED_PRINCIPAL_HEADER`
  // strip-before-stamp shape immediately above it in the same function.
  const source = await readFile(
    new URL("../worker/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /authenticatedHeaders\.delete\(REQUEST_NOW_HEADER\);\s*\n\s*authenticatedHeaders\.set\(\s*REQUEST_NOW_HEADER,\s*new Date\(\)\.toISOString\(\),?\s*\);/,
  );
  // The delete MUST run before the set for every header this boundary
  // stamps -- a client-supplied copy must never survive into the
  // authenticated request that reaches page render code.
  const principalDeleteIndex = source.indexOf(
    "authenticatedHeaders.delete(VERIFIED_PRINCIPAL_HEADER)",
  );
  const nowDeleteIndex = source.indexOf(
    "authenticatedHeaders.delete(REQUEST_NOW_HEADER)",
  );
  const nowSetIndex = source.indexOf(
    "authenticatedHeaders.set(REQUEST_NOW_HEADER",
  );
  assert.ok(principalDeleteIndex >= 0);
  assert.ok(nowDeleteIndex > principalDeleteIndex);
  assert.ok(nowSetIndex > nowDeleteIndex);
});
