// BRK-003: the structural enforcement of the AGENTS.md Sharesight read-only
// rule. This module is the ONLY place in `domain/sharesight/` that is
// allowed to hold a reference to a raw `fetch`-shaped function for Sharesight
// DATA requests, and its single exported request primitive, `sharesightGet`,
// has no `method` parameter -- GET is hard-coded into the call it makes.
// There is no generic `request(method, ...)` export anywhere in this module
// or its barrel; that surface must never exist.
//
// Because `RequestInit["method"]` can still be smuggled in past the type
// system (a caller doing `init as RequestInit` or similar), `sharesightGet`
// also defensively inspects `init` at runtime and throws
// `SharesightNonGetAttemptError` -- BEFORE calling `fetcher` -- if a `method`
// key is present at all, regardless of its value. The request is never sent.
//
// It also rejects method-override-SHAPED headers (`X-HTTP-Method-Override`,
// `X-Method-Override`, `_method`) for the same reason: several HTTP
// frameworks/proxies interpret one of these as "treat this request as a
// different method," which would let a non-GET intent reach Sharesight
// through a header instead of `RequestInit.method` (BRK-003 review finding
// F5). The check is case-insensitive and, like the `method` check, runs
// before `fetcher` is ever invoked.
//
// The sole documented exception to GET-only is OAuth client-credentials
// token acquisition, which is a POST to Sharesight's auth infrastructure,
// not its data API. That exception is isolated in `token.ts`, whose fetch
// path is scoped to the configured token URL only and never touches this
// module. See `docs/ARCHITECTURE.md`'s Sharesight boundary section.

export type SharesightFetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The init shape `sharesightGet` accepts. Deliberately has no `method`
 * field -- there is no parameter through which a caller could ask for a
 * different HTTP method even if they wanted to.
 */
export type SharesightGetInit = Readonly<{
  headers?: Record<string, string>;
  signal?: AbortSignal;
}>;

export class SharesightNonGetAttemptError extends Error {
  readonly kind = "non_get_rejected" as const;

  constructor(
    message = "Sharesight data client only permits GET requests; a smuggled request method was rejected before any request was sent.",
  ) {
    super(message);
    this.name = "SharesightNonGetAttemptError";
  }
}

/** Header names some HTTP frameworks/proxies treat as a method override.
 * Rejected outright rather than stripped -- if one is present, something
 * upstream of this call intended a non-GET request, and that intent must
 * fail loud, not be silently downgraded to GET (BRK-003 finding F5). */
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
 * The ONLY function in this module that sends an HTTP request for
 * Sharesight DATA. GET is hard-coded; there is no way to pass a different
 * method through this signature. The request is rejected here,
 * synchronously, before `fetcher` is ever invoked, if either:
 *  - `init` carries a `method` property by any means (a widened/`as any`
 *    cast bypassing the type above), or
 *  - `init.headers` carries a method-override-shaped header name (see
 *    `METHOD_OVERRIDE_HEADER_NAMES`), case-insensitively.
 */
export function sharesightGet(
  fetcher: SharesightFetcher,
  url: URL,
  init?: SharesightGetInit,
): Promise<Response> {
  if (init !== undefined && init !== null) {
    if (Object.prototype.hasOwnProperty.call(init, "method")) {
      throw new SharesightNonGetAttemptError();
    }
  }
  if (containsMethodOverrideHeader(init?.headers)) {
    throw new SharesightNonGetAttemptError(
      "Sharesight data client rejects method-override-shaped headers; the request was not sent.",
    );
  }
  return fetcher(url, {
    headers: init?.headers,
    signal: init?.signal,
    method: "GET",
  });
}
