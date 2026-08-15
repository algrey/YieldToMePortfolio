// BRK-003: OAuth 2.0 token acquisition for Sharesight. BRK-008 extended the
// original client-credentials-only design to three grants, since the
// owner's Sharesight app registration uses the authorization-code flow with
// an out-of-band redirect (client-credentials may or may not be enabled for
// this app -- the live spike tries it first and falls back):
//   - `client_credentials` -- the original BRK-003 grant.
//   - `authorization_code` -- exchanges a short-lived, ONE-TIME code
//     (`SharesightTokenClientOptions.code`) Sharesight displayed to the
//     owner, plus the exact configured `redirectUri`, for the first token.
//   - `refresh_token` -- renews using a refresh token (either supplied
//     directly, or one a prior `authorization_code`/`refresh_token`
//     exchange returned and this module has held in memory since).
// Grant selection is always the caller's EXPLICIT `grantType` option, never
// inferred. See `SharesightGrantType` and `GrantState` below.
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
import {
  SHARESIGHT_OAUTH_ERROR_CODES,
  type SharesightOAuthErrorCode,
} from "./contracts.ts";
import type { SharesightFetcher } from "./transport.ts";

export const DEFAULT_SHARESIGHT_TOKEN_URL =
  "https://api.sharesight.com/oauth2/token";

/**
 * BRK-008: the owner's Sharesight app registration uses the authorization-
 * code flow with an out-of-band redirect -- Sharesight shows a short-lived,
 * one-time code in the browser rather than redirecting to a callback URL.
 * This is the standard OAuth 2.0 literal for that ("no redirect, display the
 * code"), not a URL, so it is handled as an allowed literal constant
 * throughout this module rather than being run through URL parsing.
 */
export const SHARESIGHT_OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

const DEFAULT_TIMEOUT_MS = 8_000;
/** Refresh this many ms before actual expiry, so a data call never races a
 * token that expires mid-request. */
const DEFAULT_REFRESH_LEEWAY_MS = 60_000;

/**
 * BRK-008: which OAuth grant a provider uses. Always an EXPLICIT option,
 * never inferred/guessed from which other options happen to be set --
 * defaults to `client_credentials` (the only grant BRK-003 originally
 * supported) so existing callers are unaffected.
 */
export type SharesightGrantType =
  "client_credentials" | "authorization_code" | "refresh_token";

export type SharesightTokenClientOptions = Readonly<{
  /** Sharesight Settings -> API tab client credentials. Constructor-only;
   * never read from a client-supplied value. Required for every grant --
   * Sharesight's token endpoint authenticates the CLIENT regardless of
   * which grant is used to authenticate the resource owner. */
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
  /** Defaults to `"client_credentials"`. See `SharesightGrantType`. */
  grantType?: SharesightGrantType;
  /** `authorization_code` grant only: the short-lived, ONE-TIME code
   * Sharesight displayed to the owner. Consumed for exactly the first
   * exchange; a provider never resends it (see `GrantState`'s
   * `"exhausted"` state below). */
  code?: string;
  /** `authorization_code` grant only: must be EXACTLY the redirect URI
   * configured on the Sharesight app registration -- either
   * `SHARESIGHT_OOB_REDIRECT_URI` or a validated `https:` URL
   * (`validateSharesightRedirectUri`). Trimmed of surrounding whitespace,
   * then sent exactly as configured -- never otherwise
   * reconstructed/renormalized (e.g. never round-tripped through `URL`,
   * which can rewrite it, adding a trailing slash). */
  redirectUri?: string;
  /** `refresh_token` grant only: an existing refresh token (e.g. one the
   * owner persisted to `.dev.vars` from a prior run's
   * `onRefreshTokenRotated` callback). */
  refreshToken?: string;
  /**
   * Fired whenever a token exchange response includes a `refresh_token`,
   * so the CALLER may persist it (this module never persists it itself --
   * it is held only in memory for the lifetime of this provider). Never
   * logged or otherwise surfaced by this module itself; the caller is
   * responsible for treating the value as a secret.
   *
   * NOT fired for the `client_credentials` grant even if the response
   * happens to include a `refresh_token` -- a `client_credentials` provider
   * never transitions to using it (BRK-008 review B1: grant state must stay
   * exactly what the caller configured, never silently drift to a
   * different grant based on response shape alone), so surfacing a token
   * this module will never itself use would just be handing the caller a
   * secret to look after for no benefit. See `GrantState`.
   *
   * Any exception this callback throws is caught and discarded (BRK-008
   * review F1): a caller-side persistence failure must never fail the
   * `getAccessToken()` call it's merely reacting to, nor discard the
   * access token the same exchange just issued.
   */
  onRefreshTokenRotated?: (refreshToken: string) => void;
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
 * BRK-008: thrown synchronously at provider creation when the options for
 * the selected `grantType` are missing/empty -- e.g. `authorization_code`
 * with no `code`, or `refresh_token` with no `refreshToken`. Mirrors
 * `SharesightTokenUrlRejectedError`'s synchronous-at-creation contract: an
 * incompletely configured grant can never result in a request being sent.
 */
export class SharesightTokenGrantConfigError extends Error {
  readonly kind = "invalid_response" as const;

  constructor(message: string) {
    super(message);
    this.name = "SharesightTokenGrantConfigError";
  }
}

/**
 * BRK-008: thrown synchronously when a configured `redirectUri` is neither
 * the OOB literal (`SHARESIGHT_OOB_REDIRECT_URI`) nor a validated `https:`
 * URL. The message is static and never echoes the candidate value, matching
 * this module's existing URL-rejection convention (no candidate URL is ever
 * echoed back in a thrown/returned value).
 */
export class SharesightRedirectUriRejectedError extends Error {
  readonly kind = "invalid_response" as const;

  constructor(
    message = `Sharesight redirect_uri must be the OOB literal ("${SHARESIGHT_OOB_REDIRECT_URI}") or a valid absolute https URL with no userinfo.`,
  ) {
    super(message);
    this.name = "SharesightRedirectUriRejectedError";
  }
}

/**
 * BRK-008: validates a configured `redirectUri` is either the documented OOB
 * literal (the urn is not a URL, so it is checked as an exact-match allowed
 * constant rather than parsed) or an `https:` URL carrying no userinfo
 * (mirroring `validateSharesightTokenUrlShape`'s userinfo/protocol rules,
 * minus the Sharesight-host/token-path pins, which do not apply here -- a
 * redirect URI is the APP's own registered callback, not a Sharesight
 * endpoint). Throws `SharesightRedirectUriRejectedError` synchronously on
 * any violation.
 */
export function validateSharesightRedirectUri(value: string): void {
  if (value === SHARESIGHT_OOB_REDIRECT_URI) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SharesightRedirectUriRejectedError();
  }
  if (url.protocol !== "https:") {
    throw new SharesightRedirectUriRejectedError(
      "Sharesight redirect_uri must use https, except the documented OOB literal.",
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new SharesightRedirectUriRejectedError(
      "Sharesight redirect_uri must not contain userinfo (username/password) components.",
    );
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
  oauthErrorCode?: SharesightOAuthErrorCode | null,
): SharesightResult<never> {
  return {
    ok: false,
    error: {
      kind,
      message,
      retryable,
      ...(oauthErrorCode ? { oauthErrorCode } : {}),
    },
  };
}

type SharesightErrorKindForToken = SharesightError["kind"];

const OAUTH_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  SHARESIGHT_OAUTH_ERROR_CODES,
);

/** BRK-008 diagnostic: the maximum number of bytes of a non-2xx TOKEN
 * endpoint response body this module will ever read. Large enough for any
 * realistic RFC 6749 §5.2 OAuth error JSON body; small enough that this
 * diagnostic itself can never be turned into an unbounded-buffering
 * liability by a misbehaving or hostile endpoint. Bytes beyond this bound
 * are never read -- the diagnostic simply fails closed (`null`) rather than
 * reading further, matching the "tolerate anything, never throw" contract
 * below. */
const MAX_OAUTH_ERROR_BODY_BYTES = 4_096;

/**
 * BRK-008: the ONE bounded, allowlisted-enum exception to this module's
 * otherwise-absolute "never read a non-2xx body" rule (see the module doc
 * comment) -- see docs/ARCHITECTURE.md §8.2 for why this specific exception
 * is safe. Called ONLY from the non-2xx branch of `requestNewToken`, on the
 * TOKEN endpoint response (never the data client, which is untouched by
 * this function and never calls it).
 *
 * Reads at most `MAX_OAUTH_ERROR_BODY_BYTES` of the body, tolerating every
 * failure mode by returning `null` rather than throwing: no body, a stream
 * read error, a body that isn't valid UTF-8/JSON, or a body larger than the
 * bound (silently truncated, which then simply fails to parse as JSON in
 * the ordinary case). Of the parsed JSON, ONLY the top-level `error` field
 * is read, and ONLY if it exactly matches one entry in the closed
 * `SHARESIGHT_OAUTH_ERROR_CODES` allowlist -- an unrecognized code,
 * `error_description` (which can reflect request data the caller sent, e.g.
 * echoing back an authorization code or client secret -- BRK-003 leak
 * discipline), and every other field are discarded unread: never returned
 * from this function, never logged, never included in a thrown/returned
 * error message.
 */
async function readOAuthErrorCode(
  response: Response,
): Promise<SharesightOAuthErrorCode | null> {
  const body = response.body;
  if (!body) return null;

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let totalBytes = 0;
  try {
    while (totalBytes < MAX_OAUTH_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = MAX_OAUTH_ERROR_BODY_BYTES - totalBytes;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(chunk, { stream: true });
      totalBytes += chunk.byteLength;
    }
  } catch {
    return null;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Deliberately ignored -- cancellation failure must never surface.
    }
  }
  if (totalBytes === 0) return null;
  text += decoder.decode();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Includes a body truncated at the byte bound above, which will
    // ordinarily fail to parse as complete JSON -- an oversized body is
    // therefore handled by this same catch, not a separate check.
    return null;
  }

  const record = asRecord(parsed);
  const candidate = record ? record.error : null;
  return typeof candidate === "string" && OAUTH_ERROR_CODE_SET.has(candidate)
    ? (candidate as SharesightOAuthErrorCode)
    : null;
}

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
 * BRK-008: the provider's internal, mutable grant state -- distinct from the
 * caller-facing `SharesightGrantType` option, because `authorization_code`
 * TRANSITIONS over the provider's lifetime (this is a forced protocol
 * necessity, not guessing: an authorization code is single-use by
 * definition, so once consumed the provider must either move to
 * `refresh_token` -- if the exchange returned one -- or become
 * `"exhausted"`, never resend the same code):
 *  - `client_credentials` stays `client_credentials` for every refresh --
 *    UNCONDITIONALLY, even if a response happens to carry a `refresh_token`
 *    (BRK-008 review B1: response shape alone must never drift the grant a
 *    caller explicitly configured).
 *  - `authorization_code` is used for exactly the FIRST exchange, then:
 *     - if the response included a `refresh_token`, state moves to
 *       `refresh_token` for all subsequent refreshes;
 *     - otherwise state moves to `"exhausted"` -- there is nothing left to
 *       refresh with, and a caller must supply a fresh code/redirectUri (a
 *       new provider) to continue.
 *  - `refresh_token` stays `refresh_token`, using whichever token is
 *    currently held (rotated on each response that includes a new one; if a
 *    response omits it, the previously held token is reused, matching a
 *    non-rotating authorization server).
 */
type GrantState =
  | { kind: "client_credentials" }
  | { kind: "authorization_code"; code: string; redirectUri: string }
  | { kind: "refresh_token"; refreshToken: string }
  | { kind: "exhausted" };

/** The subset of `GrantState` that can actually be sent in a token request
 * -- `"exhausted"` is intercepted before `requestNewToken` is ever called. */
type RequestableGrantState = Exclude<GrantState, { kind: "exhausted" }>;

/**
 * Resolves and validates the provider's INITIAL grant state from options,
 * once, at `createSharesightTokenProvider` creation -- mirroring
 * `resolveAndValidateTokenUrl`'s synchronous-at-creation contract. Grant
 * selection is always the caller's EXPLICIT `grantType` option (defaulting
 * to `"client_credentials"` for backward compatibility), never inferred from
 * which other options happen to be set.
 */
function resolveInitialGrantState(
  options: SharesightTokenClientOptions,
): GrantState {
  const grantType = options.grantType ?? "client_credentials";
  switch (grantType) {
    case "client_credentials":
      return { kind: "client_credentials" };
    case "authorization_code": {
      const code = nonEmptyString(options.code);
      if (!code) {
        throw new SharesightTokenGrantConfigError(
          "authorization_code grant requires a non-empty code.",
        );
      }
      const redirectUri = nonEmptyString(options.redirectUri);
      if (!redirectUri) {
        throw new SharesightTokenGrantConfigError(
          "authorization_code grant requires a non-empty redirectUri.",
        );
      }
      validateSharesightRedirectUri(redirectUri);
      return { kind: "authorization_code", code, redirectUri };
    }
    case "refresh_token": {
      const refreshToken = nonEmptyString(options.refreshToken);
      if (!refreshToken) {
        throw new SharesightTokenGrantConfigError(
          "refresh_token grant requires a non-empty refreshToken.",
        );
      }
      return { kind: "refresh_token", refreshToken };
    }
    default:
      // BRK-008 review (F2): unreachable for a TypeScript caller -- the
      // switch above is exhaustive over `SharesightGrantType` -- but a
      // plain-JS caller (e.g. this repo's own `.mjs` scripts, which have no
      // type backstop) can pass an arbitrary string. Reject it
      // synchronously at creation, exactly like every other malformed-grant
      // case above, rather than silently falling through to an `undefined`
      // grant state that would only fail later, confusingly, inside
      // `requestNewToken`.
      throw new SharesightTokenGrantConfigError(
        `Unknown Sharesight grantType: "${String(grantType)}".`,
      );
  }
}

/** Builds the token-request body for the given grant. `client_id` /
 * `client_secret` are sent for every grant (Sharesight's token endpoint
 * authenticates the client regardless of which grant authenticates the
 * resource owner). `redirect_uri` was already trimmed of surrounding
 * whitespace by `resolveInitialGrantState`, then is sent exactly as
 * configured from there -- never otherwise reconstructed via `URL` (which
 * can renormalize, e.g. add a trailing slash) -- so it matches the app
 * registration. */
function buildGrantRequestBody(
  clientId: string,
  clientSecret: string,
  grantState: RequestableGrantState,
): URLSearchParams {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
  });
  switch (grantState.kind) {
    case "client_credentials":
      body.set("grant_type", "client_credentials");
      break;
    case "authorization_code":
      body.set("grant_type", "authorization_code");
      body.set("code", grantState.code);
      body.set("redirect_uri", grantState.redirectUri);
      break;
    case "refresh_token":
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", grantState.refreshToken);
      break;
  }
  return body;
}

/**
 * Requests a fresh token from the configured token endpoint, for whichever
 * grant `grantState` describes. This is the only function in this module
 * (and therefore the only path in the entire `domain/sharesight/` package)
 * that constructs a non-GET request. It never logs or returns the request
 * body, the client secret, the authorization code, the refresh token, or the
 * raw response body -- only a typed success/error result. On success, also
 * reports whether the response included a `refresh_token` (validated as a
 * non-empty string like every other token field), so the caller
 * (`createSharesightTokenProvider`) can rotate its grant state and notify
 * `onRefreshTokenRotated` -- this function itself never persists or logs it.
 */
async function requestNewToken(
  fetcher: SharesightFetcher,
  configuredTokenUrl: URL,
  clientId: string,
  clientSecret: string,
  grantState: RequestableGrantState,
  now: () => number,
  timeoutMs: number,
): Promise<
  SharesightResult<{
    accessToken: SharesightAccessToken;
    refreshToken: string | null;
  }>
> {
  assertSharesightTokenUrl(configuredTokenUrl, configuredTokenUrl);

  const body = buildGrantRequestBody(clientId, clientSecret, grantState);

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
    // BRK-008 diagnostic exception (module doc, docs/ARCHITECTURE.md §8.2):
    // the ONLY body this module ever reads, bounded and allowlist-matched.
    // The failure MESSAGE below stays static regardless of what (if
    // anything) this returns -- only the typed, closed-enum
    // `oauthErrorCode` field carries it.
    const oauthErrorCode = await readOAuthErrorCode(response);
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
      oauthErrorCode,
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
  // Optional on every grant response; validated the same way as every other
  // token field (non-empty string), never trusted unvalidated.
  const refreshToken = record ? nonEmptyString(record.refresh_token) : null;

  return {
    ok: true,
    value: {
      accessToken: {
        accessToken,
        tokenType,
        expiresAtMs: now() + expiresIn * 1000,
      },
      refreshToken,
    },
  };
}

/**
 * Creates a token provider that acquires and refreshes a Sharesight access
 * token for the configured grant (`client_credentials`, `authorization_code`,
 * or `refresh_token` -- BRK-008), refreshing before expiry using the
 * injected clock. The returned provider exposes only `getAccessToken()`; it
 * never exposes the underlying fetcher or POST capability to a consumer, so
 * a data client that only holds a `SharesightTokenProvider` structurally
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
  // BRK-008: likewise validated ONCE, synchronously, at creation -- an
  // incompletely configured grant (missing code/redirectUri/refreshToken)
  // can never result in a request being sent.
  let grantState: GrantState = resolveInitialGrantState(options);
  const fetcher = options.fetcher ?? fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refreshLeewayMs = options.refreshLeewayMs ?? DEFAULT_REFRESH_LEEWAY_MS;

  let cached: SharesightAccessToken | null = null;
  let inFlight: Promise<
    SharesightResult<{
      accessToken: SharesightAccessToken;
      refreshToken: string | null;
    }>
  > | null = null;

  async function refresh(): Promise<SharesightResult<SharesightAccessToken>> {
    // configuredTokenUrl is always valid here -- it was already validated
    // once at creation, above.
    if (grantState.kind === "exhausted") {
      // The one-time authorization_code exchange already happened and
      // returned no refresh_token -- there is nothing left to refresh with.
      // Fails closed rather than resending the (now certainly invalid)
      // code.
      return tokenError(
        "authentication",
        "Sharesight authorization code was already used and no refresh token was issued; a new authorization code is required.",
        false,
      );
    }
    if (!inFlight) {
      // Captured so the state-transition logic below always reflects the
      // grant that THIS specific request actually used, even if `grantState`
      // is reassigned by the time concurrent callers observe the settled
      // promise. The transition itself runs inside this async block -- run
      // exactly once per network exchange -- rather than after each
      // caller's `await`, so a rotated refresh token is never reported to
      // `onRefreshTokenRotated` more than once for the same exchange when
      // multiple `getAccessToken()` calls race the same in-flight request.
      const requestGrantState = grantState;
      inFlight = requestNewToken(
        fetcher,
        configuredTokenUrl,
        options.clientId,
        options.clientSecret,
        requestGrantState,
        now,
        timeoutMs,
      )
        .then((result) => {
          // BRK-008 review B1: `client_credentials` NEVER transitions, even
          // if a response happens to carry a `refresh_token` -- a
          // `client_credentials` provider must keep sending
          // `grant_type=client_credentials` on every subsequent request,
          // not silently drift to `refresh_token` based on response shape
          // alone (that would corrupt the live spike's grant evidence: the
          // SECOND request would use a different grant than the one
          // actually being tested, with no caller-visible signal that
          // happened). `onRefreshTokenRotated` is correspondingly not fired
          // either -- see that option's doc comment for why surfacing a
          // token this provider will never itself use is not a service to
          // the caller.
          if (result.ok && requestGrantState.kind !== "client_credentials") {
            if (result.value.refreshToken) {
              grantState = {
                kind: "refresh_token",
                refreshToken: result.value.refreshToken,
              };
              try {
                // BRK-008 review F1: a caller-supplied persistence callback
                // must never fail the token acquisition it's merely
                // reacting to, nor discard the access token this same
                // exchange just issued. Swallowed, not rethrown or logged
                // (logging could echo whatever the callback's own error
                // carries, which callers are free to construct however
                // they like -- including embedding the token itself).
                options.onRefreshTokenRotated?.(result.value.refreshToken);
              } catch {
                // Deliberately ignored -- see comment above.
              }
            } else if (requestGrantState.kind === "authorization_code") {
              grantState = { kind: "exhausted" };
            }
          }
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    const result = await inFlight;
    return result.ok ? { ok: true, value: result.value.accessToken } : result;
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
