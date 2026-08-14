// BRK-003: OAuth 2.0 client-credentials token acquisition for Sharesight.
//
// This is the SOLE non-GET request this package ever issues (AGENTS.md /
// BRK-002 decision): a POST to Sharesight's OAuth TOKEN endpoint, which is
// auth infrastructure, not Sharesight data. It is deliberately isolated in
// its own module so the data client (`client.ts`) never holds a reference
// to anything that can send a non-GET request -- it only ever consumes the
// `SharesightTokenProvider.getAccessToken()` result this module produces,
// never the POST capability itself.
//
// Token endpoint URL: BRK-002's decision entry cites
// portfolio.sharesight.com/api/3/authentication_flow and
// /api/3/configuring_oauth as the v3 OAuth sources, but this worker has no
// live network access to re-verify the exact token URL from those docs. The
// default below (`https://api.sharesight.com/oauth2/token`) is the owner
// task's stated best-known value; it is UNVERIFIED against a live request
// and therefore fully configurable via `SharesightTokenClientOptions.tokenUrl`
// so BRK-008's live spike can correct it without a code change.
//
// BRK-003 review (B1/B2): a configured `tokenUrl` is validated for its
// SHAPE exactly once, at `createSharesightTokenProvider` creation --
// `validateSharesightTokenUrlShape` below is the real control, rejecting
// (synchronously, before the provider object even exists, so the fetcher is
// never called) any URL that looks like the Sharesight DATA API (contains
// `/api/`) or isn't shaped like an OAuth token endpoint, and rejecting
// plaintext `http:` except to a loopback host reserved for future local
// mock tooling. `assertSharesightTokenUrl` is a SEPARATE, secondary
// consistency pin used at request time: it guarantees every POST targets
// the exact same URL object that already passed shape validation, rather
// than one reconstructed on the fly -- it is not itself a shape check, and
// must not be read as one.
//
// SECURITY CONTEXT UPDATE: the owner now authenticates via their MAIN PAID
// Sharesight account -- there is no longer an account-level write barrier
// (previously a read-only-shared guest account made a client-credentials
// grant with write scope moot even if this module were compromised). With
// full-account credentials, this module's GET-only/host/shape enforcement
// is the SOLE protection for the owner's tax data. The BRK-003 review's
// remaining follow-ups (F8/F9/F10 below) close the gaps that mattered once
// that changed: a misconfigured or attacker-influenced `tokenUrl` pointing
// at a host that merely LOOKS like Sharesight (F8), evading the `/api/`
// data-shape rejection via case or percent-encoding (F9), or smuggling
// credentials via URL userinfo (F10).
//
// Access tokens expire after 30 minutes (BRK-002). This module refreshes
// before expiry using an injected clock (`now`, epoch milliseconds -- the
// repo's injectable-clock convention, see `yahoo-compatible.ts`'s `now`
// option, adapted to milliseconds because expiry math needs arithmetic, not
// an ISO string) so tests never depend on wall-clock time.

import type { SharesightError, SharesightResult } from "./contracts.ts";
import type { SharesightFetcher } from "./transport.ts";

export const DEFAULT_SHARESIGHT_TOKEN_URL =
  "https://api.sharesight.com/oauth2/token";

const DEFAULT_TIMEOUT_MS = 8_000;
/** Refresh this many ms before actual expiry, so a data call never races a
 * token that expires mid-request. */
const DEFAULT_REFRESH_LEEWAY_MS = 60_000;

export type SharesightTokenClientOptions = Readonly<{
  /** Sharesight Settings -> API tab client credentials. Constructor-only;
   * never read from a client-supplied value. */
  clientId: string;
  clientSecret: string;
  /** Defaults to `DEFAULT_SHARESIGHT_TOKEN_URL`; see module doc for why this
   * is configurable rather than hard-coded. */
  tokenUrl?: string;
  /** Permits `tokenUrl` to target a host other than `sharesight.com` (or a
   * subdomain of it). Default `false` (rejected). Intended ONLY for
   * BRK-008 spike tooling (e.g. a local mock server) -- never set for a
   * real deployment, mirroring the data client's `unsafeAllowOtherHost`
   * (BRK-003 review finding F6, extended to the token endpoint by F8).
   * Loopback hosts remain permitted for `http:` regardless of this flag
   * (see `LOOPBACK_HOSTS`); this flag only widens the HOST allowed, not the
   * protocol exception. */
  unsafeAllowOtherHost?: boolean;
  fetcher?: SharesightFetcher;
  /** Injected clock returning epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  timeoutMs?: number;
  refreshLeewayMs?: number;
}>;

export type SharesightAccessToken = Readonly<{
  accessToken: string;
  tokenType: string;
  expiresAtMs: number;
}>;

export type SharesightTokenProvider = Readonly<{
  getAccessToken(): Promise<SharesightResult<string>>;
}>;

export class SharesightTokenUrlRejectedError extends Error {
  readonly kind = "invalid_response" as const;

  constructor(
    message = "Sharesight token request target does not match the configured token endpoint; the request was not sent.",
  ) {
    super(message);
    this.name = "SharesightTokenUrlRejectedError";
  }
}

/**
 * Secondary consistency pin: guarantees every token POST targets the exact
 * URL object that already passed `validateSharesightTokenUrlShape`, never
 * one reconstructed on the fly. Exported so the pinning defense can be
 * probed directly by tests independent of the network mock; the factory
 * below always calls this with the same `configured` URL it captured at
 * creation, so under normal use this never rejects. NOTE: this function
 * does not itself validate URL shape (see `validateSharesightTokenUrlShape`
 * for the real safety control against a misconfigured `tokenUrl` pointing
 * at the data API) -- a prior version of this module conflated the two,
 * which a review found tautological (BRK-003 finding B1).
 */
export function assertSharesightTokenUrl(
  candidate: URL,
  configured: URL,
): void {
  if (candidate.href !== configured.href) {
    throw new SharesightTokenUrlRejectedError();
  }
}

/** Loopback-only hosts permitted to use `http:` for the token endpoint --
 * reserved for a future local mock server in BRK-008 spike tooling. Any
 * other host must use `https:`; sending client credentials over plaintext
 * HTTP to a real host is never permitted (BRK-003 finding B2). These hosts
 * are also exempt from the `sharesight.com` host pin below (F8) -- they are
 * the documented local-mock-only exception, not a live Sharesight host, and
 * must keep working without the separate `unsafeAllowOtherHost` flag. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Sharesight's registrable domain for the OAuth token endpoint (BRK-003
 * review finding F8). Matched by EXACT LABEL suffix only: the hostname
 * must equal this string outright, or end with `.` + this string. A bare
 * `endsWith("sharesight.com")` substring check would be fooled by a
 * same-suffix-but-different-domain host like `evilsharesight.com`; a check
 * that only inspects the hostname's PREFIX would be fooled by
 * `api.sharesight.com.evil.com` (a real subdomain of `evil.com` that merely
 * starts with Sharesight's domain). Requiring the full `sharesight.com`
 * label pair as either the whole hostname or preceded by a dot closes both. */
const SHARESIGHT_REGISTRABLE_DOMAIN = "sharesight.com";

function isSharesightHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  // BRK-004 review: a leading/doubled/trailing dot produces an empty label
  // (e.g. `.sharesight.com`, `api..sharesight.com`) whose string still ends
  // with `.sharesight.com` and would otherwise slip past the suffix check
  // below untouched. Reject any hostname containing an empty label outright.
  if (lower.split(".").some((label) => label.length === 0)) return false;
  return (
    lower === SHARESIGHT_REGISTRABLE_DOMAIN ||
    lower.endsWith(`.${SHARESIGHT_REGISTRABLE_DOMAIN}`)
  );
}

/** Lowercases and percent-decodes `pathname` ONCE, before either path-shape
 * check below reads it (BRK-003 review finding F9). Without this, an
 * uppercase (`/API/v3/...`) or percent-encoded (`/api%2Fv3/...`) variant of
 * the data-API path would evade the `/api/` rejection while still routing
 * to the same place server-side. A malformed percent-escape (e.g. a
 * trailing lone `%`) makes `decodeURIComponent` throw; that must become a
 * typed rejection here, never an uncaught exception -- returns `null` on
 * decode failure so the caller can reject cleanly.
 *
 * BRK-004 review: decoding exactly ONCE (not to a fixed point / repeatedly)
 * is deliberate, not an oversight -- it matches the server's own decoding
 * depth for a single path segment. Decoding to a fixed point would
 * over-reject a legitimate literal `%2F` in a path segment (which decodes
 * once to `/` and would then wrongly look like an extra path separator on a
 * second pass), and would let a DOUBLY-encoded payload (`%252F`) masquerade
 * as this function's job to detect -- that class of attack is a
 * transport-layer concern, not this shape check's. */
function canonicalizePathname(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return decoded.toLowerCase();
}

export type SharesightTokenUrlValidationOptions = Readonly<{
  /** See `SharesightTokenClientOptions.unsafeAllowOtherHost`. */
  unsafeAllowOtherHost?: boolean;
}>;

/**
 * The real safety control for the token endpoint URL (BRK-003 findings
 * B1/B2/F8/F9/F10): validates that a candidate URL is actually SHAPED like
 * Sharesight's OAuth token endpoint, not the data API surface, and actually
 * TARGETS Sharesight. A bare URL-equality "pin" (`assertSharesightTokenUrl`
 * above) cannot stop a misconfigured `tokenUrl` from pointing straight at a
 * data endpoint (e.g. `https://api.sharesight.com/api/v3/portfolios/1`)
 * with client credentials in the POST body -- this function is what
 * actually rejects that. Throws `SharesightTokenUrlRejectedError`
 * synchronously on any violation:
 *  - protocol must be `https:`, EXCEPT `http:` is permitted to a loopback
 *    host only (`LOOPBACK_HOSTS`) -- never to a real host, where `http:`
 *    would send client credentials in cleartext.
 *  - the URL must not carry userinfo (username/password) components (F10)
 *    -- never permitted, even to a loopback host: credentials belong solely
 *    in the client-credentials POST body, never embedded in the URL.
 *  - the hostname must be `sharesight.com` or a subdomain of it (F8),
 *    unless the host is loopback (the documented http exception above) or
 *    `options.unsafeAllowOtherHost` was explicitly set (BRK-008 spike
 *    tooling only).
 *  - the (canonicalized -- F9) path must NOT contain `/api/` (the data-API
 *    shape).
 *  - the (canonicalized) path must end with `/oauth2/token` or contain
 *    `/oauth` (the token-endpoint shape).
 */
export function validateSharesightTokenUrlShape(
  url: URL,
  options?: SharesightTokenUrlValidationOptions,
): void {
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new SharesightTokenUrlRejectedError(
      "Sharesight token URL must use https (http is only permitted to a loopback host for local mock tooling).",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new SharesightTokenUrlRejectedError(
      "Sharesight token URL must not contain userinfo (username/password) components.",
    );
  }
  if (
    !isLoopback &&
    !options?.unsafeAllowOtherHost &&
    !isSharesightHost(url.hostname)
  ) {
    throw new SharesightTokenUrlRejectedError(
      "Sharesight token URL host is not sharesight.com or a subdomain of it; set unsafeAllowOtherHost explicitly (BRK-008 local-mock-only) to override.",
    );
  }
  const pathname = canonicalizePathname(url.pathname);
  if (pathname === null) {
    throw new SharesightTokenUrlRejectedError(
      "Sharesight token URL path contains a malformed percent-encoding.",
    );
  }
  if (pathname.includes("/api/")) {
    throw new SharesightTokenUrlRejectedError(
      "Sharesight token URL must not target the data API surface.",
    );
  }
  if (!pathname.endsWith("/oauth2/token") && !pathname.includes("/oauth")) {
    throw new SharesightTokenUrlRejectedError(
      "Sharesight token URL is not shaped like an OAuth token endpoint.",
    );
  }
}

/**
 * Parses and validates a configured token URL ONCE (called only from
 * `createSharesightTokenProvider`, at creation). Throws synchronously --
 * before the provider object (and therefore its fetcher) even exists -- on
 * an unparseable URL or a shape violation, so an invalid configuration can
 * never result in a request being sent.
 */
function resolveAndValidateTokenUrl(
  tokenUrl: string | undefined,
  unsafeAllowOtherHost: boolean | undefined,
): URL {
  let url: URL;
  try {
    url = new URL(tokenUrl ?? DEFAULT_SHARESIGHT_TOKEN_URL);
  } catch {
    throw new SharesightTokenUrlRejectedError(
      "Sharesight token URL is not a valid absolute URL.",
    );
  }
  validateSharesightTokenUrlShape(url, { unsafeAllowOtherHost });
  return url;
}

function tokenError(
  kind: SharesightErrorKindForToken,
  message: string,
  retryable: boolean,
): SharesightResult<never> {
  return { ok: false, error: { kind, message, retryable } };
}

type SharesightErrorKindForToken = SharesightError["kind"];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Requests a fresh token from the configured token endpoint. This is the
 * only function in this module (and therefore the only path in the entire
 * `domain/sharesight/` package) that constructs a non-GET request. It never
 * logs or returns the request body, the client secret, or the raw response
 * body -- only a typed success/error result.
 */
async function requestNewToken(
  fetcher: SharesightFetcher,
  configuredTokenUrl: URL,
  clientId: string,
  clientSecret: string,
  now: () => number,
  timeoutMs: number,
): Promise<SharesightResult<SharesightAccessToken>> {
  assertSharesightTokenUrl(configuredTokenUrl, configuredTokenUrl);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<Response>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("sharesight_token_timeout"));
    }, timeoutMs);
  });

  let response: Response;
  try {
    response = await Promise.race([
      fetcher(configuredTokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
        // Never silently follow a redirect away from the pinned token URL.
        redirect: "manual",
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);
  } catch {
    return tokenError("timeout", "Sharesight token request timed out.", true);
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
    return tokenError(
      "invalid_response",
      "Sharesight token endpoint returned a redirect, which is not followed.",
      false,
    );
  }

  if (!response.ok) {
    const retryable = response.status >= 500;
    return tokenError(
      response.status === 401 || response.status === 400
        ? "authentication"
        : response.status === 429
          ? "rate_limit"
          : retryable
            ? "transient_upstream"
            : "invalid_response",
      "Sharesight token request was not accepted.",
      retryable,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return tokenError(
      "invalid_response",
      "Sharesight token response was not valid JSON.",
      false,
    );
  }

  const record = asRecord(parsed);
  const accessToken = record ? nonEmptyString(record.access_token) : null;
  const tokenType = record
    ? (nonEmptyString(record.token_type) ?? "Bearer")
    : "Bearer";
  const expiresIn = record ? positiveInteger(record.expires_in) : null;
  if (!accessToken || !expiresIn) {
    return tokenError(
      "invalid_response",
      "Sharesight token response is missing a usable access token or expiry.",
      false,
    );
  }

  return {
    ok: true,
    value: {
      accessToken,
      tokenType,
      expiresAtMs: now() + expiresIn * 1000,
    },
  };
}

/**
 * Creates a token provider that acquires and refreshes a Sharesight
 * client-credentials token, refreshing before expiry using the injected
 * clock. The returned provider exposes only `getAccessToken()`; it never
 * exposes the underlying fetcher or POST capability to a consumer, so a
 * data client that only holds a `SharesightTokenProvider` structurally
 * cannot issue a token request itself.
 */
export function createSharesightTokenProvider(
  options: SharesightTokenClientOptions,
): SharesightTokenProvider {
  // Validated ONCE, here, with real shape rules (BRK-003 review B1/B2) --
  // not on every call, and not merely pinned by equality. An invalid or
  // data-API-shaped token URL throws synchronously, before this provider
  // object (and therefore its fetcher) even exists, so no request can ever
  // be sent against a misconfigured endpoint.
  const configuredTokenUrl = resolveAndValidateTokenUrl(
    options.tokenUrl,
    options.unsafeAllowOtherHost,
  );
  const fetcher = options.fetcher ?? fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshLeewayMs = options.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS;

  let cached: SharesightAccessToken | null = null;
  let inFlight: Promise<SharesightResult<SharesightAccessToken>> | null = null;

  async function refresh(): Promise<SharesightResult<SharesightAccessToken>> {
    // configuredTokenUrl is always valid here -- it was already validated
    // once at creation, above.
    if (!inFlight) {
      inFlight = requestNewToken(
        fetcher,
        configuredTokenUrl,
        options.clientId,
        options.clientSecret,
        now,
        timeoutMs,
      ).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  return {
    async getAccessToken(): Promise<SharesightResult<string>> {
      if (cached && cached.expiresAtMs - refreshLeewayMs > now()) {
        return { ok: true, value: cached.accessToken };
      }
      const result = await refresh();
      if (!result.ok) {
        cached = null;
        return result;
      }
      cached = result.value;
      return { ok: true, value: result.value.accessToken };
    },
  };
}
