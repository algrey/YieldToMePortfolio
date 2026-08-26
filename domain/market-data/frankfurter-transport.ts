// MKT-021: the structural GET-only enforcement for the Frankfurter FX-rate
// client, mirroring `domain/sharesight/transport.ts`'s BRK-003 pattern
// exactly (same shape, same rationale: this module is the ONLY place
// allowed to hold a reference to a raw `fetch`-shaped function for
// Frankfurter, and its single exported request primitive has no `method`
// parameter -- GET is hard-coded into the call it makes).
//
// Frankfurter needs no credentials and this codebase has no AGENTS.md
// non-negotiable specific to it (unlike Sharesight's read-only mandate), but
// the same structural discipline is applied anyway: a free public data feed
// this codebase only ever reads from should still be provably incapable of
// sending anything but a GET, so a future edit can never accidentally widen
// this into a write path.
//
// Because `RequestInit["method"]` can still be smuggled in past the type
// system (a caller doing `init as RequestInit` or similar), `frankfurterGet`
// defensively inspects `init` at runtime and throws
// `FrankfurterNonGetAttemptError` -- BEFORE calling `fetcher` -- if a
// `method` key is present at all, regardless of its value. The request is
// never sent. It also rejects method-override-shaped headers
// (`X-HTTP-Method-Override`, `X-Method-Override`, `_method`) for the same
// reason BRK-003 does.

export type FrankfurterFetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The init shape `frankfurterGet` accepts. Deliberately has no `method`
 * field -- there is no parameter through which a caller could ask for a
 * different HTTP method even if they wanted to.
 */
export type FrankfurterGetInit = Readonly<{
  headers?: Record<string, string>;
  signal?: AbortSignal;
}>;

export class FrankfurterNonGetAttemptError extends Error {
  readonly kind = "non_get_rejected" as const;

  constructor(
    message = "Frankfurter FX client only permits GET requests; a smuggled request method was rejected before any request was sent.",
  ) {
    super(message);
    this.name = "FrankfurterNonGetAttemptError";
  }
}

const METHOD_OVERRIDE_HEADER_NAMES = new Set([
  "x-http-method-override",
  "x-method-override",
  "_method",
]);

function containsMethodOverrideHeader(
  headers: Record<string, string> | undefined,
): boolean {
  if (!headers) return false;
  for (const headerName of Object.keys(headers)) {
    if (METHOD_OVERRIDE_HEADER_NAMES.has(headerName.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * The ONLY function in this module that sends an HTTP request to
 * Frankfurter. GET is hard-coded; there is no way to pass a different
 * method through this signature. The request is rejected here,
 * synchronously, before `fetcher` is ever invoked, if either:
 *  - `init` carries a `method` property by any means (a widened/`as any`
 *    cast bypassing the type above), or
 *  - `init.headers` carries a method-override-shaped header name, matching
 *    `METHOD_OVERRIDE_HEADER_NAMES` case-insensitively.
 */
export function frankfurterGet(
  fetcher: FrankfurterFetcher,
  url: URL,
  init?: FrankfurterGetInit,
): Promise<Response> {
  if (init !== undefined && init !== null) {
    if (Object.prototype.hasOwnProperty.call(init, "method")) {
      throw new FrankfurterNonGetAttemptError();
    }
  }
  if (containsMethodOverrideHeader(init?.headers)) {
    throw new FrankfurterNonGetAttemptError(
      "Frankfurter FX client rejects method-override-shaped headers; the request was not sent.",
    );
  }
  return fetcher(url, {
    headers: init?.headers,
    signal: init?.signal,
    method: "GET",
  });
}
