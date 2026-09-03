// BRK-003: the Sharesight data client. Every method here reaches Sharesight
// through `sharesightGet` (`transport.ts`) only -- there is no other way for
// this module to send a request, and it never imports anything capable of
// sending a POST (that capability lives solely in `token.ts`, consumed here
// only as an already-negotiated `SharesightTokenProvider`).
//
// BRK-012A (2026-08-20) added three EVIDENCE-PROBE methods --
// `listUserInstruments`, `listInstrumentPrices`, `getPortfolioValuation` --
// for the price-endpoint evidence spike (docs/ARCHITECTURE.md §8.2). Unlike
// `listPortfolios`/`getPortfolioHoldings`/`listTrades`/`listPayouts`, these
// three deliberately returned RAW parsed JSON (`SharesightResult<unknown>`,
// no `parse.ts` domain contract) -- BRK-012A was evidence-only (no schema,
// no pipeline), so building a typed contract ahead of live shape
// confirmation would have risked guessing.
//
// BRK-012B (2026-08-20) promotes `listUserInstruments` to a typed, validated
// method (`parseSharesightUserInstruments`, mirroring the other four) now
// that the price refresh pipeline actually consumes it, and REMOVES
// `listInstrumentPrices` entirely: BRK-012A's follow-up sweep confirmed the
// underlying route is a hard HTTP 406 gate for this app registration across
// every policy-compliant Accept/path/query variant (see
// docs/ARCHITECTURE.md §8.2's BRK-012A follow-up entry) -- "do not
// re-attempt without new evidence." Its probe-only params
// (`acceptOverride`/`pathSuffix`/`apiVersion`/`limit`) and the `getJson`
// plumbing that existed solely to support them are removed with it, rather
// than kept as inert dead code; `scripts/sharesight-price-spike.mjs`'s
// follow-up sweep is preserved evidence, not a live code path this client
// still exposes. `getPortfolioValuation` stays RAW/unpromoted -- BRK-012A's
// own evidence found it exactly reproduces `listUserInstruments`'s price for
// the same instrument (not an independent freshness signal), adds no
// currency field, and needs derived arithmetic, so it remains a lower-
// confidence secondary cross-check candidate, not promoted here.
//
// Server-only: this module performs network I/O and consumes constructor-
// supplied credentials indirectly via the token provider; it must only ever
// be imported from server code (a Worker route/service), never from an
// `app/` client component. There is nothing here for a bundler to tree-shake
// into a client bundle by accident -- no `"use client"` boundary imports
// this module, and it has no browser-only API surface to tempt one to.

import type {
  SharesightBodyParseDiagnostic,
  SharesightError,
  SharesightFetchEvidence,
  SharesightHolding,
  SharesightItemFailureEvidence,
  SharesightListParams,
  SharesightPayout,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
  SharesightUserInstrument,
} from "./contracts.ts";
import type { SharesightFetcher } from "./transport.ts";
import { SharesightNonGetAttemptError, sharesightGet } from "./transport.ts";
import type { SharesightTokenProvider } from "./token.ts";
import {
  parseSharesightHoldings,
  parseSharesightPayouts,
  parseSharesightPortfolios,
  parseSharesightTrades,
  parseSharesightUserInstruments,
} from "./parse.ts";
import { deriveShapeEvidence } from "./shape-evidence.ts";

const DEFAULT_BASE_URL = "https://api.sharesight.com/api/v3";
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * BRK-008 (2026-08-15, documentation-derived re-derivation -- see
 * docs/ARCHITECTURE.md §8.2): `listPayouts` alone must be requested against
 * the LEGACY `v2` API version, never `v3` -- `markcatley/sharesight.rs`, a
 * THIRD-PARTY Rust client generated from Sharesight's PUBLISHED Swagger/API
 * documentation (documentation-derived evidence, not a live Sharesight
 * response and not Sharesight's own artifact), records the portfolio-scoped
 * payouts list (`crates/sharesight-generate/assets/api_data_2.json`, entry
 * `ListPortfolioPayouts`) only under `GET /portfolios/:portfolio_id/
 * payouts.json`, `User_API_Payouts` (version `2.0.0`); the SAME third-party
 * client's `api_data_3.json` has no portfolio-scoped payouts route at all --
 * its only `payouts` list route is `GET /holdings/{holding_id}/payouts`
 * (`PayoutList`, `User_API_V3_Payouts`), which is scoped to a HOLDING, not a
 * portfolio, and would require a different call shape entirely. Hitting the
 * v2 path under a v3 URL prefix is exactly the 404 this constant fixes.
 * `portfolios`/`holdings`/`trades` remain on `v3` (`DEFAULT_BASE_URL`),
 * confirmed live and unaffected by this change.
 */
const PAYOUTS_API_VERSION = "v2";

/**
 * Derives the payouts-only `v2` request root from the client's ALREADY
 * host-pinned/validated `baseUrl` by substituting just the `/api/vN` path
 * segment -- never a second host, never re-validated, since it is a pure
 * string transform of a URL that already passed `resolveBaseUrl`'s host/
 * userinfo checks. If `baseUrl` doesn't carry a `/api/vN` segment at all (a
 * non-default override with no version in its path), this is a no-op and
 * `listPayouts` falls back to requesting the same root as every other
 * endpoint -- there is no version segment to swap.
 */
function withPayoutsApiVersion(baseUrl: string): string {
  return baseUrl.replace(/\/api\/v\d+(?=\/|$)/, `/api/${PAYOUTS_API_VERSION}`);
}

/** The only host a Bearer token is ever sent to by default (BRK-003 review
 * finding F6) -- a misconfigured `baseUrl` must not be able to ship the
 * access token to an arbitrary host. */
const EXPECTED_BASE_URL_HOST = "api.sharesight.com";

/** BRK-008 diagnostic (2026-08-15 review fix, B1): the maximum number of
 * bytes of a non-2xx DATA response body this module will ever read, ONLY to
 * size `onBodyParseDiagnostic`'s `bodyBytes` field. Mirrors `token.ts`'s
 * `MAX_OAUTH_ERROR_BODY_BYTES` bound/technique exactly -- large enough for
 * any realistic error body, small enough that this diagnostic can never
 * become an unbounded-buffering liability. */
const MAX_NON_2XX_DIAGNOSTIC_BODY_BYTES = 4_096;

/** BRK-008 diagnostic (2026-08-15 review fix, B1): the bounded read above is
 * additionally raced against its own short timeout, independent of the
 * OUTER per-request `timeoutMs` (that timeout only bounds the initial
 * response; a body read performed afterward, on an already-received
 * response, is not covered by it and could otherwise hang on a stalled or
 * slow-drip error body). Best-effort only -- a caller that hits this timeout
 * gets `bodyBytes: 0`, never a hang. */
const NON_2XX_DIAGNOSTIC_READ_TIMEOUT_MS = 1_000;

/**
 * BRK-004 (closes the BRK-008 review follow-up recorded in `client.ts`'s
 * former inline comment and `docs/ARCHITECTURE.md` §8.2): the 2xx
 * success-path body IS the actual response data, so unlike the two bounded
 * diagnostic reads above it can never be truncated at a byte cap -- the fix
 * here is a TIMEOUT, not a byte bound. Reuses `getJson`'s own configured
 * `timeoutMs` (the same duration already budgeted for receiving the
 * response) as this read's OWN, independent timer -- separate from the
 * outer per-request `AbortController`, whose timer is already cleared by
 * the time this read starts (that timer only bounds the time to receive the
 * initial response, not a body read performed afterward on a response
 * already received).
 */
type BoundedTextReadResult =
  { kind: "ok"; text: string } | { kind: "timeout" } | { kind: "error" };

async function readResponseTextWithTimeout(
  response: Response,
  timeoutMs: number,
): Promise<BoundedTextReadResult> {
  const body = response.body;
  if (!body) {
    // No stream to race a timer against -- `response.text()` on a bodyless
    // response resolves immediately.
    try {
      return { kind: "ok", text: await response.text() };
    } catch {
      return { kind: "error" };
    }
  }

  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let outcome: "timeout" | "error" | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(() => {
      outcome = "timeout";
      resolve();
    }, timeoutMs);
  });
  const readLoopPromise = (async (): Promise<void> => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          text += decoder.decode(value, { stream: true });
        }
      }
    } catch {
      outcome = "error";
    }
  })();
  try {
    await Promise.race([readLoopPromise, timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try {
      await reader.cancel();
    } catch {
      // Deliberately ignored -- cancellation failure must never surface.
    }
  }
  if (outcome === "timeout") return { kind: "timeout" };
  if (outcome === "error") return { kind: "error" };
  text += decoder.decode();
  return { kind: "ok", text };
}

export type SharesightClientOptions = Readonly<{
  baseUrl?: string;
  /** Permits `baseUrl` to target a host other than `api.sharesight.com`.
   * Default `false` (rejected). Intended ONLY for BRK-008 spike tooling
   * (e.g. a local mock server) -- never set for a real deployment, since it
   * removes the guarantee that the Bearer token can only reach Sharesight's
   * real host. */
  unsafeAllowOtherHost?: boolean;
  fetcher?: SharesightFetcher;
  tokenProvider: SharesightTokenProvider;
  now?: () => string;
  timeoutMs?: number;
  /** Optional hash/metadata evidence hook (MKT-002 `payloadSha256`
   * convention): invoked after each successful GET with a hash of the raw
   * response body and the ingestion timestamp only -- never the body
   * itself. Durable evidence persistence is out of scope for this
   * foundation layer (BRK-004+). */
  onFetchEvidence?: (evidence: SharesightFetchEvidence) => void;
  /**
   * BRK-008 live-spike diagnostic: invoked ONLY when a `parse.ts` parser
   * returns a typed `invalid_response` result for an endpoint's raw parsed
   * JSON -- never on success, and never for a transport-level failure
   * (timeout, non-2xx status, unparseable JSON) that returns
   * `invalid_response` before any domain parsing is attempted, since there
   * is no parsed JSON to derive a shape from in that case. `shape` is
   * produced INSIDE this module by `deriveShapeEvidence` (see
   * `shape-evidence.ts` for its privacy contract): key names, `typeof`
   * leaves, and format-class annotations only -- the raw parsed JSON this
   * shape was derived from is never itself exposed to a caller of this
   * client, matching `onFetchEvidence`'s hash-only discipline above.
   * `endpoint` is a static label (e.g. `"listPortfolios"`), never an
   * instance value (never a portfolio id or other caller-supplied
   * argument), so this callback can never leak request data either.
   *
   * Any exception this callback throws is caught and discarded -- same
   * discipline as `token.ts`'s `onRefreshTokenRotated`: a caller-side
   * diagnostic callback must never fail the parse result it's merely
   * reacting to.
   */
  onShapeEvidence?: (endpoint: string, shape: unknown) => void;
  /**
   * BRK-008 diagnostic (sibling of `onShapeEvidence` above, for a different
   * failure class): invoked whenever `getJson` reaches an `invalid_response`
   * (or other non-2xx-derived) outcome with NO parsed JSON to derive a field
   * shape from -- there are two such cases:
   *   1. a response body was read successfully but `JSON.parse` itself
   *      threw -- e.g. an endpoint that silently returns an HTML page
   *      instead of JSON;
   *   2. the response status itself was not 2xx (any of the
   *      authentication/entitlement/rate_limit/transient_upstream/
   *      invalid_response-mapped statuses) -- this is the BRK-008 2026-08-15
   *      follow-up fix: the observed live `listPayouts` symptom (an
   *      `invalid_response` result with NEITHER this diagnostic NOR
   *      `onShapeEvidence` firing) was traced to exactly this previously
   *      diagnostic-less branch, not to a dropped callback wire-up -- see
   *      `docs/ARCHITECTURE.md` §8.2.
   * Both cases carry transport-level metadata only: content-type, HTTP
   * status, the fixed `bodyParseable: false` marker, a byte count, and
   * `redirected` (`Response.redirected` -- whether the underlying fetch
   * followed a redirect before landing on this response, e.g. a 302 to an
   * HTML login page) -- never the body itself, matching `onShapeEvidence`'s
   * no-values discipline. `bodyParseable: false` means something SLIGHTLY
   * different across the two cases above, even though the literal value is
   * identical in both: in case 1 a body WAS handed to `JSON.parse`, which
   * then threw; in case 2 no body was ever handed to `JSON.parse` at all --
   * the HTTP status disqualified the response before parsing was even
   * attempted. Read it as "no usable JSON reached the domain parser," not as
   * "JSON.parse was attempted and failed" universally. Never fired for a
   * timeout (no response was ever received) or when JSON parses
   * successfully, even into an invalid domain shape (`onShapeEvidence`
   * covers that case instead). `endpoint` is the same static per-method
   * label `onShapeEvidence` uses, never a caller-supplied value. Any
   * exception this callback throws is caught and discarded, same as
   * `onShapeEvidence`.
   *
   * Review finding B1 (2026-08-15 follow-up): in case 2, the body is read
   * ONLY when this option is actually registered -- a caller that never
   * opts in never triggers a body read at all, and gets exactly the same
   * prompt return as before this diagnostic existed. When it IS registered,
   * that read is bounded (4,096 bytes, mirroring `token.ts`'s
   * `readOAuthErrorCode`) and raced against its own short timeout
   * independent of the outer per-request `timeoutMs`, so a stalled or
   * slow-drip non-2xx error body can never hang the call -- see
   * `readBoundedBodyByteCountForDiagnostic` in `client.ts`.
   */
  onBodyParseDiagnostic?: (
    endpoint: string,
    diagnostic: SharesightBodyParseDiagnostic,
  ) => void;
  /**
   * BRK-008 diagnostic (2026-08-15 follow-up, sibling of `onShapeEvidence`):
   * invoked ONLY when a `parse.ts` parser fails closed on ONE SPECIFIC item
   * within a response list (`SharesightError.itemFailure` is present on the
   * `invalid_response` result) -- never on an envelope-level failure (e.g.
   * the list key itself missing) and never on success. Carries
   * `itemFailure`'s names/enums (`itemIndex`/`fieldName`/`reason`) PLUS the
   * FAILING item's own derived shape (`itemShape`, via `deriveShapeEvidence`
   * on just that one item -- key names/`typeof` leaves/format-class
   * annotations only, same privacy contract as `onShapeEvidence`'s
   * whole-payload shape). This is what lets a parser built on invented
   * fixtures be corrected against exactly the field a real live item failed
   * on, without ever seeing that field's value. `endpoint` is the same
   * static per-method label the other diagnostics use. Any exception this
   * callback throws is caught and discarded, same as `onShapeEvidence`.
   */
  onItemFailureEvidence?: (
    endpoint: string,
    evidence: SharesightItemFailureEvidence,
  ) => void;
}>;

export class SharesightBaseUrlRejectedError extends Error {
  readonly kind = "invalid_response" as const;

  constructor(
    message = `Sharesight client baseUrl host is not ${EXPECTED_BASE_URL_HOST}; set unsafeAllowOtherHost explicitly (BRK-008 spike tooling only) to override.`,
  ) {
    super(message);
    this.name = "SharesightBaseUrlRejectedError";
  }
}

/**
 * Validates the client's `baseUrl` host ONCE, at `createSharesightClient`
 * creation, before any request can be sent. Throws synchronously on an
 * unparseable URL or an unexpected host unless the caller explicitly opted
 * in via `unsafeAllowOtherHost` (BRK-003 review finding F6).
 */
function resolveBaseUrl(
  baseUrlOption: string | undefined,
  unsafeAllowOtherHost: boolean | undefined,
): string {
  const raw = baseUrlOption ?? DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SharesightBaseUrlRejectedError(
      "Sharesight client baseUrl is not a valid absolute URL.",
    );
  }
  // F10: a baseUrl carrying userinfo (username/password) is never a
  // legitimate Sharesight API host and is rejected unconditionally -- even
  // with `unsafeAllowOtherHost` set, since embedding credentials in the URL
  // is a distinct hazard from host targeting and has no legitimate use
  // here (the Bearer token is sent via the Authorization header, never the
  // URL).
  if (parsed.username !== "" || parsed.password !== "") {
    throw new SharesightBaseUrlRejectedError(
      "Sharesight client baseUrl must not contain userinfo (username/password) components.",
    );
  }
  if (parsed.hostname !== EXPECTED_BASE_URL_HOST && !unsafeAllowOtherHost) {
    throw new SharesightBaseUrlRejectedError();
  }
  return raw.replace(/\/$/, "");
}

export type SharesightClient = Readonly<{
  listPortfolios(): Promise<SharesightResult<SharesightPortfolio[]>>;
  getPortfolioHoldings(
    portfolioId: string,
  ): Promise<SharesightResult<SharesightHolding[]>>;
  listTrades(
    portfolioId: string,
    params?: SharesightListParams,
  ): Promise<SharesightResult<SharesightTrade[]>>;
  listPayouts(
    portfolioId: string,
    params?: SharesightListParams,
  ): Promise<SharesightResult<SharesightPayout[]>>;
  /**
   * BRK-012B: typed, validated (promoted from BRK-012A's raw evidence
   * probe -- see this file's header comment). Documentation:
   * `markcatley/sharesight.rs`, `api_data_2.json`, `ListUserInstruments`,
   * `GET /user_instruments.json`, v2, no version-suffix qualifier -- a flat
   * list of every instrument across the user's portfolios, each carrying
   * `current_price`/`current_price_updated_at`/`currency_code`, LIVE
   * -CONFIRMED (docs/ARCHITECTURE.md §8.2's BRK-012A entry). Requested
   * against the same v2 root `listPayouts` already uses. No documented
   * params -- one call covers every instrument the account holds across
   * every portfolio, which is exactly why the BRK-012B refresh pipeline
   * calls this ONCE per run rather than once per local portfolio/security.
   */
  listUserInstruments(): Promise<SharesightResult<SharesightUserInstrument[]>>;
  /**
   * BRK-012A evidence probe (2026-08-20) -- documentation-derived candidate
   * for a per-holding current price bundled with a full portfolio valuation
   * report. Third-party documentation (`markcatley/sharesight.rs`,
   * `api_data_2.json`, `Valuation`, `GET /portfolios/:portfolio_id/
   * valuation.json`) shows `portfolio_valuation_holdings[].instrument_price`
   * as of an optional `balanceDate` (documented server-side default:
   * today). Returns RAW parsed JSON, same discipline as the two probes
   * above.
   */
  getPortfolioValuation?(
    portfolioId: string,
    params?: Readonly<{ balanceDate?: string }>,
  ): Promise<SharesightResult<unknown>>;
  /**
   * BRK-011 evidence probe (2026-08-21) -- same discipline as
   * `getPortfolioValuation` above: RAW parsed JSON, no `parse.ts` domain
   * contract, requested against the identical endpoint `listPayouts`
   * already uses (`payoutsBaseUrl`, `/portfolios/:id/payouts.json`). Exists
   * SOLELY so `scripts/sharesight-franking-fx-spike.mjs` can inspect a
   * payout's full raw field SHAPE (via the pure, values-safe
   * `deriveShapeEvidence`) without `parse.ts`'s typed `listPayouts` silently
   * dropping an undocumented/unparsed field (e.g. `tax_credit`) before the
   * spike ever sees it existed. Never promoted to a typed contract, never
   * consumed by any production code path -- this is the "explicitly
   * spike-only hook INSIDE domain/sharesight/" AGENTS.md's Sharesight
   * read-only rule requires in place of an out-of-module `fetch` (BRK-011
   * review finding B1).
   */
  getPayoutsRaw?(
    portfolioId: string,
    params?: SharesightListParams,
  ): Promise<SharesightResult<unknown>>;
}>;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function requestError(
  kind: SharesightError["kind"],
  message: string,
  retryable: boolean,
): SharesightResult<never> {
  return { ok: false, error: { kind, message, retryable } };
}

/**
 * BRK-015 fix: Sharesight's documented query parameter names for both
 * `ListPortfolioTrades` (v2.1.0) and `ListPortfolioPayouts` (v2.0.0) are
 * `start_date`/`end_date`, NOT `from`/`to` -- confirmed both from
 * `markcatley/sharesight.rs`'s Swagger-derived API documentation and a live
 * BRK-015 investigation spike against the owner's real account (a narrowed
 * `start_date`/`end_date` window returned 2 payouts vs. 119 for the
 * unwindowed default; the same window under the previous `from`/`to` keys
 * returned all 119, proving those keys were silently ignored). See
 * `docs/ARCHITECTURE.md` §8.2's BRK-015 entry and
 * `SharesightListParams`'s doc comment.
 */
function toSearchParams(
  params: SharesightListParams | undefined,
): Record<string, string> | undefined {
  if (!params) return undefined;
  const result: Record<string, string> = {};
  if (params.from) result.start_date = params.from;
  if (params.to) result.end_date = params.to;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function createSharesightClient(
  options: SharesightClientOptions,
): SharesightClient {
  // Validated ONCE, here, before any request can be sent (BRK-003 review
  // finding F6).
  const baseUrl = resolveBaseUrl(options.baseUrl, options.unsafeAllowOtherHost);
  // Derived ONCE from the already-pinned `baseUrl` above -- see
  // `withPayoutsApiVersion`'s doc comment. Same origin/host as `baseUrl`,
  // never a second one.
  const payoutsBaseUrl = withPayoutsApiVersion(baseUrl);
  const fetcher = options.fetcher ?? fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date().toISOString());

  // BRK-008 (2026-08-15 follow-up): the single place `onBodyParseDiagnostic`
  // is ever invoked, from either of its two firing points below (a
  // JSON.parse failure, or a non-2xx status) -- see the option's doc comment
  // for why both are now covered.
  function emitBodyParseDiagnostic(
    endpoint: string,
    response: Response,
    bodyBytes: number,
  ): void {
    if (!options.onBodyParseDiagnostic) return;
    try {
      options.onBodyParseDiagnostic(endpoint, {
        contentType: response.headers.get("content-type"),
        httpStatus: response.status,
        bodyParseable: false,
        bodyBytes,
        redirected: response.redirected,
      });
    } catch {
      // Deliberately ignored -- see the option's doc comment.
    }
  }

  /**
   * BRK-008 diagnostic (2026-08-15 review fix, B1): bounded, independently
   * timed, best-effort byte-COUNT read of a non-2xx response body -- used
   * ONLY to size `onBodyParseDiagnostic`'s `bodyBytes` field, and ONLY ever
   * called after the caller has already confirmed `options.onBodyParseDiagnostic`
   * is registered (see the call site in `getJson`'s `!response.ok` branch) --
   * a caller that never opts into this diagnostic never reaches this
   * function at all, so the body is never touched and the call returns
   * exactly as promptly as it did before this diagnostic existed.
   *
   * Mirrors `token.ts`'s `readOAuthErrorCode` bounded-reader technique (a
   * capped `ReadableStreamDefaultReader` loop, `MAX_NON_2XX_DIAGNOSTIC_BODY_BYTES`
   * matching that module's `MAX_OAUTH_ERROR_BODY_BYTES`), with one addition:
   * this read is ALSO raced against its own short timeout
   * (`NON_2XX_DIAGNOSTIC_READ_TIMEOUT_MS`), independent of `getJson`'s outer
   * per-request `timeoutMs` -- that outer timeout only bounds the INITIAL
   * response, not a body read performed afterward on a response already
   * received, so without this a stalled or slow-drip non-2xx error body
   * could hang a call that would otherwise have returned promptly (review
   * finding B1: an earlier version of this fix read the full body
   * unconditionally and without a cap/timeout of its own). On ANY failure --
   * no body, a stream error, the byte cap, or the race timeout firing --
   * this returns whatever byte count was read so far (0 in the worst case),
   * never throws, and is never load-bearing for the typed error result the
   * caller returns regardless of this outcome.
   */
  async function readBoundedBodyByteCountForDiagnostic(
    response: Response,
  ): Promise<number> {
    const body = response.body;
    if (!body) return 0;
    const reader = body.getReader();
    let totalBytes = 0;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, NON_2XX_DIAGNOSTIC_READ_TIMEOUT_MS);
    });
    const readLoopPromise = (async (): Promise<void> => {
      try {
        while (totalBytes < MAX_NON_2XX_DIAGNOSTIC_BODY_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          const remaining = MAX_NON_2XX_DIAGNOSTIC_BODY_BYTES - totalBytes;
          totalBytes +=
            value.byteLength > remaining ? remaining : value.byteLength;
        }
      } catch {
        // best-effort only -- fall through with whatever totalBytes reached
      }
    })();
    try {
      await Promise.race([readLoopPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      try {
        await reader.cancel();
      } catch {
        // Deliberately ignored -- cancellation failure must never surface.
      }
    }
    return totalBytes;
  }

  async function getJson(
    endpoint: string,
    path: string,
    searchParams?: Record<string, string>,
    // BRK-008: per-endpoint API version override. Defaults to the client's
    // pinned `baseUrl` (v3); `listPayouts` alone passes `payoutsBaseUrl` (v2)
    // -- see `withPayoutsApiVersion`'s doc comment above.
    requestBaseUrl: string = baseUrl,
  ): Promise<SharesightResult<unknown>> {
    // Refresh-before-expiry token acquisition happens entirely inside the
    // token provider; a refresh failure returns a typed unavailable result
    // here and no data request is ever attempted.
    const tokenResult = await options.tokenProvider.getAccessToken();
    if (!tokenResult.ok) {
      return tokenResult;
    }

    let url: URL;
    try {
      url = new URL(`${requestBaseUrl}${path}`);
    } catch {
      return requestError(
        "invalid_response",
        "Sharesight request URL is malformed.",
        false,
      );
    }
    if (searchParams) {
      for (const [key, value] of Object.entries(searchParams)) {
        url.searchParams.set(key, value);
      }
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<Response>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("sharesight_get_timeout"));
      }, timeoutMs);
    });

    const headers: Record<string, string> = {
      authorization: `Bearer ${tokenResult.value}`,
      accept: "application/json",
    };

    let response: Response;
    try {
      response = await Promise.race([
        sharesightGet(fetcher, url, {
          headers,
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
    } catch (caught) {
      // A structural GET-only rejection (a smuggled method or a
      // method-override header -- see `transport.ts`) is NOT a timeout; it
      // must surface as its own typed, non-retryable kind, never be folded
      // into "timeout" (BRK-003 review finding F7 -- this branch was
      // previously dead/mismapped).
      if (caught instanceof SharesightNonGetAttemptError) {
        return requestError("non_get_rejected", caught.message, false);
      }
      return requestError("timeout", "Sharesight request timed out.", true);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (!response.ok) {
      const retryable = response.status >= 500;
      // BRK-016: a 401 means the token this request just used is no longer
      // good (expired server-side ahead of our local clock, or revoked) --
      // invalidate the provider's cache so the NEXT call (in this same
      // invocation, or a later one sharing the memoized provider via
      // worker/sharesight-config.ts) re-exchanges instead of repeating the
      // now-known-bad token. This module never retries the DATA call itself
      // (out of scope -- a 502 to the owner stays visible and actionable);
      // it only ensures the FOLLOWING call starts clean. `invalidate` is
      // optional on `SharesightTokenProvider` so a minimal test fake that
      // only implements `getAccessToken` still works unchanged.
      if (response.status === 401) {
        options.tokenProvider.invalidate?.();
      }
      // BRK-008 (2026-08-15 follow-up): this branch previously returned with
      // NO diagnostic evidence at all for ANY non-2xx status -- that gap is
      // exactly the observed live `listPayouts` symptom (invalid_response
      // with neither this diagnostic nor `onShapeEvidence` firing; see
      // docs/ARCHITECTURE.md §8.2). Review finding B1: the body is read here
      // ONLY when a caller has registered `onBodyParseDiagnostic` -- a
      // caller that hasn't returns immediately below with zero body access,
      // exactly as promptly as before this diagnostic existed -- and, when
      // it is read, via a bounded/independently-timed reader (see
      // `readBoundedBodyByteCountForDiagnostic`) so a stalled or oversized
      // non-2xx error body can never hang this call. Best-effort,
      // diagnostic-only in all cases -- never load-bearing for the typed
      // error result below.
      if (options.onBodyParseDiagnostic) {
        const bodyBytes = await readBoundedBodyByteCountForDiagnostic(response);
        emitBodyParseDiagnostic(endpoint, response, bodyBytes);
      }
      return requestError(
        response.status === 401
          ? "authentication"
          : response.status === 403
            ? "entitlement"
            : response.status === 429
              ? "rate_limit"
              : retryable
                ? "transient_upstream"
                : "invalid_response",
        "Sharesight request was not accepted.",
        retryable,
      );
    }

    // BRK-004 (closes the BRK-008 review follow-up): this 2xx success-path
    // body read is unconditional (this IS the actual response data, not a
    // diagnostic, so it can't be skipped like the non-2xx diagnostic reads
    // above) but is now bounded by its OWN timer, independent of the outer
    // per-request `timeoutMs` (which only bounds the time to receive the
    // INITIAL response, not this read performed afterward) -- see
    // `readResponseTextWithTimeout`'s doc comment. A stalled body yields a
    // typed, retryable `timeout` result, never a hang.
    const bodyRead = await readResponseTextWithTimeout(response, timeoutMs);
    if (bodyRead.kind === "timeout") {
      return requestError(
        "timeout",
        "Sharesight response body read timed out.",
        true,
      );
    }
    if (bodyRead.kind === "error") {
      return requestError(
        "invalid_response",
        "Sharesight response body could not be read.",
        false,
      );
    }
    const bodyText = bodyRead.text;

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // BRK-008: this is the failure class `onBodyParseDiagnostic` exists
      // for -- a body was read successfully but did not parse as JSON at
      // all (e.g. an HTML page from a misrouted endpoint), so there is no
      // parsed JSON for `onShapeEvidence` to derive a field shape from.
      // Metadata only, never the body itself.
      emitBodyParseDiagnostic(
        endpoint,
        response,
        new TextEncoder().encode(bodyText).length,
      );
      return requestError(
        "invalid_response",
        "Sharesight response was not valid JSON.",
        false,
      );
    }

    if (options.onFetchEvidence) {
      options.onFetchEvidence({
        payloadSha256: await sha256Hex(bodyText),
        ingestedAt: now(),
      });
    }

    return { ok: true, value: parsed };
  }

  // BRK-008: reports `onShapeEvidence` for a domain parse failure only --
  // `endpoint` is always the static label below, never a caller-supplied
  // value (see the option's doc comment). `raw` is the already-parsed JSON
  // `getJson` produced; this function itself never re-reads or re-parses
  // anything. `envelopeKey` is the static list key (`"portfolios"`,
  // `"holdings"`, `"trades"`, `"payouts"`) this endpoint's parser reads --
  // used ONLY to re-locate the failing item within `raw` when
  // `parsed.error.itemFailure` is present, so `onItemFailureEvidence` (BRK-008
  // 2026-08-15 follow-up) can report that item's OWN derived shape alongside
  // its index/field/reason.
  function reportShapeEvidenceIfInvalid<T>(
    endpoint: string,
    envelopeKey: string,
    raw: unknown,
    parsed: SharesightResult<T>,
  ): SharesightResult<T> {
    if (parsed.ok || parsed.error.kind !== "invalid_response") return parsed;

    if (options.onShapeEvidence) {
      try {
        options.onShapeEvidence(endpoint, deriveShapeEvidence(raw));
      } catch {
        // Deliberately ignored -- see the option's doc comment above.
      }
    }

    const itemFailure = parsed.error.itemFailure;
    if (itemFailure && options.onItemFailureEvidence) {
      const rawRecord =
        typeof raw === "object" && raw !== null
          ? (raw as Record<string, unknown>)
          : null;
      const rawList = rawRecord ? rawRecord[envelopeKey] : undefined;
      const rawItem = Array.isArray(rawList)
        ? rawList[itemFailure.itemIndex]
        : undefined;
      try {
        options.onItemFailureEvidence(endpoint, {
          itemIndex: itemFailure.itemIndex,
          fieldName: itemFailure.fieldName,
          reason: itemFailure.reason,
          itemShape: deriveShapeEvidence(rawItem),
        });
      } catch {
        // Deliberately ignored -- see the option's doc comment above.
      }
    }

    return parsed;
  }

  return {
    async listPortfolios() {
      const result = await getJson("listPortfolios", "/portfolios");
      if (!result.ok) return result;
      return reportShapeEvidenceIfInvalid(
        "listPortfolios",
        "portfolios",
        result.value,
        parseSharesightPortfolios(result.value),
      );
    },
    async getPortfolioHoldings(portfolioId) {
      const result = await getJson(
        "getPortfolioHoldings",
        `/portfolios/${encodeURIComponent(portfolioId)}/holdings`,
      );
      if (!result.ok) return result;
      return reportShapeEvidenceIfInvalid(
        "getPortfolioHoldings",
        "holdings",
        result.value,
        parseSharesightHoldings(result.value, portfolioId),
      );
    },
    async listTrades(portfolioId, params) {
      const result = await getJson(
        "listTrades",
        `/portfolios/${encodeURIComponent(portfolioId)}/trades`,
        toSearchParams(params),
      );
      if (!result.ok) return result;
      return reportShapeEvidenceIfInvalid(
        "listTrades",
        "trades",
        result.value,
        parseSharesightTrades(result.value, portfolioId),
      );
    },
    async listPayouts(portfolioId, params) {
      // BRK-008 (2026-08-15, documentation-derived re-derivation): a
      // portfolio-scoped payouts list does not exist under v3 at all per
      // this evidence -- v3 only documents a HOLDING-scoped payouts list
      // (`GET /holdings/{holding_id}/payouts`). The portfolio-scoped
      // `ListPortfolioPayouts` route this client needs is documented as a
      // LEGACY v2-only route, `GET /portfolios/:portfolio_id/payouts.json`
      // (per `markcatley/sharesight.rs`, a third-party Rust client generated
      // from Sharesight's published Swagger/API documentation --
      // `api_data_2.json`; documentation-derived, not a live response) --
      // requested here against `payoutsBaseUrl` (v2, same pinned host)
      // rather than the v3 `baseUrl` every other method uses. See
      // docs/ARCHITECTURE.md §8.2.
      const result = await getJson(
        "listPayouts",
        `/portfolios/${encodeURIComponent(portfolioId)}/payouts.json`,
        toSearchParams(params),
        payoutsBaseUrl,
      );
      if (!result.ok) return result;
      return reportShapeEvidenceIfInvalid(
        "listPayouts",
        "payouts",
        result.value,
        parseSharesightPayouts(result.value, portfolioId),
      );
    },
    // BRK-012B: promoted to a typed, validated contract (see this file's
    // header comment and `SharesightClient.listUserInstruments`'s doc
    // comment above). Requests against `payoutsBaseUrl` (v2), matching the
    // third-party documentation this candidate is derived from -- never a
    // second host, same as `listPayouts`.
    async listUserInstruments() {
      const result = await getJson(
        "listUserInstruments",
        "/user_instruments.json",
        undefined,
        payoutsBaseUrl,
      );
      if (!result.ok) return result;
      return reportShapeEvidenceIfInvalid(
        "listUserInstruments",
        "instruments",
        result.value,
        parseSharesightUserInstruments(result.value),
      );
    },
    // BRK-012A evidence probe (2026-08-20), UNPROMOTED -- RAW passthrough,
    // no domain parsing (see this file's header comment). Requests against
    // `payoutsBaseUrl` (v2), matching the third-party documentation this
    // candidate is derived from -- never a second host, same as
    // `listPayouts`.
    async getPortfolioValuation(portfolioId, params) {
      return getJson(
        "getPortfolioValuation",
        `/portfolios/${encodeURIComponent(portfolioId)}/valuation.json`,
        params?.balanceDate ? { balance_date: params.balanceDate } : undefined,
        payoutsBaseUrl,
      );
    },
    // BRK-011 evidence probe (2026-08-21), UNPROMOTED -- RAW passthrough, no
    // domain parsing (see `SharesightClient.getPayoutsRaw`'s doc comment
    // above). Identical endpoint/params/host to `listPayouts` -- never a
    // second host, never a different route -- this is purely "same request,
    // skip the typed parse" so a spike script can see fields `parse.ts`
    // doesn't capture.
    async getPayoutsRaw(portfolioId, params) {
      return getJson(
        "getPayoutsRaw",
        `/portfolios/${encodeURIComponent(portfolioId)}/payouts.json`,
        toSearchParams(params),
        payoutsBaseUrl,
      );
    },
  };
}
