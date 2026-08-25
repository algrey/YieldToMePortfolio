const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function createRequestId(
  request: Request,
  generate: () => string = () => crypto.randomUUID(),
): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : generate();
}

export function addRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// BUG-002 (hydration half, 2026-08-26): Vinext v0.0.50 invokes a page's
// async Server Component TWICE per request (a discarded probe pass for
// redirect/notFound detection, then the real render, ~13ms apart --
// confirmed by prior investigation). `app/authenticated-workspace.ts`'s
// `loadAuthenticatedWorkspace` feeds a formatted "now" into rendered
// output (FY-window math); if each of the two passes independently called
// `new Date()`, a second/minute boundary crossed between them could make
// the HTML and the RSC flight payload disagree, producing exactly a React
// hydration mismatch. Rather than memoizing across the two passes with
// React.cache/AsyncLocalStorage (their request-scoping semantics are
// undocumented for this Vinext version -- getting that wrong risks a
// cross-user leak, not just a display bug), the Worker boundary stamps the
// request's canonical "now" ONCE (`worker/index.ts`) and carries it WITH
// the Request object, so both RSC invocations of the SAME request read the
// identical instant by construction.
export const REQUEST_NOW_HEADER = "x-yieldtome-request-now";

// Exact `Date#toISOString()` shape only (e.g. "2026-08-26T01:02:03.456Z")
// -- the only format the Worker boundary ever writes. Deliberately strict
// rather than "anything `Date` can parse": this header is meant to carry
// ONE trusted, server-stamped value end to end, not to double as a general
// date-parsing input.
const REQUEST_NOW_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Resolves the per-request "now" a rendered server page should anchor on.
 * Reads the Worker-stamped `REQUEST_NOW_HEADER` value (see the module
 * comment above) and falls back to a fresh `new Date()` only when the
 * header is absent or fails strict validation -- e.g. tests and dev paths
 * that reach server code without going through `worker/index.ts`. Never
 * throws on a missing/malformed header: a missing request-scoped "now" is
 * a degraded-determinism condition, not a fatal one.
 */
export function resolveRequestNow(
  headerValue: string | null | undefined,
  generate: () => string = () => new Date().toISOString(),
): string {
  if (headerValue && REQUEST_NOW_PATTERN.test(headerValue)) {
    const parsed = new Date(headerValue);
    if (Number.isFinite(parsed.getTime())) return headerValue;
  }
  return generate();
}
