// BRK-003: the Sharesight data client. Every method here reaches Sharesight
// through `sharesightGet` (`transport.ts`) only -- there is no other way for
// this module to send a request, and it never imports anything capable of
// sending a POST (that capability lives solely in `token.ts`, consumed here
// only as an already-negotiated `SharesightTokenProvider`).
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
  SharesightListParams,
  SharesightPayout,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
} from "./contracts.ts";
import type { SharesightFetcher } from "./transport.ts";
import { SharesightNonGetAttemptError, sharesightGet } from "./transport.ts";
import type { SharesightTokenProvider } from "./token.ts";
import {
  parseSharesightHoldings,
  parseSharesightPayouts,
  parseSharesightPortfolios,
  parseSharesightTrades,
} from "./parse.ts";
import { deriveShapeEvidence } from "./shape-evidence.ts";

const DEFAULT_BASE_URL = "https://api.sharesight.com/api/v3";
const DEFAULT_TIMEOUT_MS = 8_000;
/** The only host a Bearer token is ever sent to by default (BRK-003 review
 * finding F6) -- a misconfigured `baseUrl` must not be able to ship the
 * access token to an arbitrary host. */
const EXPECTED_BASE_URL_HOST = "api.sharesight.com";

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
   * failure class): invoked ONLY when `getJson` reads a response body
   * successfully but `JSON.parse` itself throws -- e.g. an endpoint that
   * silently returns an HTML page instead of JSON (the observed 2026-08-15
   * `listPayouts` symptom before its endpoint path was corrected). There is
   * no parsed JSON to derive a field shape from in this case, so this
   * callback carries transport-level metadata only: content-type, HTTP
   * status, the fixed `bodyParseable: false` marker, and a byte count --
   * never the body itself, matching `onShapeEvidence`'s no-values
   * discipline. Never fired for a non-2xx response (that path never reads a
   * body) or for a timeout. `endpoint` is the same static per-method label
   * `onShapeEvidence` uses, never a caller-supplied value. Any exception
   * this callback throws is caught and discarded, same as
   * `onShapeEvidence`.
   */
  onBodyParseDiagnostic?: (
    endpoint: string,
    diagnostic: SharesightBodyParseDiagnostic,
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

function toSearchParams(
  params: SharesightListParams | undefined,
): Record<string, string> | undefined {
  if (!params) return undefined;
  const result: Record<string, string> = {};
  if (params.from) result.from = params.from;
  if (params.to) result.to = params.to;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function createSharesightClient(
  options: SharesightClientOptions,
): SharesightClient {
  // Validated ONCE, here, before any request can be sent (BRK-003 review
  // finding F6).
  const baseUrl = resolveBaseUrl(options.baseUrl, options.unsafeAllowOtherHost);
  const fetcher = options.fetcher ?? fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date().toISOString());

  async function getJson(
    endpoint: string,
    path: string,
    searchParams?: Record<string, string>,
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
      url = new URL(`${baseUrl}${path}`);
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

    let response: Response;
    try {
      response = await Promise.race([
        sharesightGet(fetcher, url, {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${tokenResult.value}`,
          },
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

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch {
      return requestError(
        "invalid_response",
        "Sharesight response body could not be read.",
        false,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // BRK-008: this is the failure class `onBodyParseDiagnostic` exists
      // for -- a body was read successfully but did not parse as JSON at
      // all (e.g. an HTML page from a misrouted endpoint), so there is no
      // parsed JSON for `onShapeEvidence` to derive a field shape from.
      // Metadata only, never the body itself.
      if (options.onBodyParseDiagnostic) {
        try {
          options.onBodyParseDiagnostic(endpoint, {
            contentType: response.headers.get("content-type"),
            httpStatus: response.status,
            bodyParseable: false,
            bodyBytes: new TextEncoder().encode(bodyText).length,
          });
        } catch {
          // Deliberately ignored -- see the option's doc comment.
        }
      }
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
  // anything.
  function reportShapeEvidenceIfInvalid<T>(
    endpoint: string,
    raw: unknown,
    parsed: SharesightResult<T>,
  ): SharesightResult<T> {
    if (
      !parsed.ok &&
      parsed.error.kind === "invalid_response" &&
      options.onShapeEvidence
    ) {
      try {
        options.onShapeEvidence(endpoint, deriveShapeEvidence(raw));
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
        result.value,
        parseSharesightTrades(result.value, portfolioId),
      );
    },
    async listPayouts(portfolioId, params) {
      // BRK-008 (2026-08-15): the account's live listPayouts response was
      // not valid JSON at the un-suffixed path -- Sharesight's v3 API
      // documents this endpoint's path as `/portfolios/:id/payouts.json`
      // (confirmed against the provider's published Swagger-derived
      // client), unlike `holdings`/`trades`, which are v3-native routes
      // that don't take a format suffix. See docs/ARCHITECTURE.md §8.2.
      const result = await getJson(
        "listPayouts",
        `/portfolios/${encodeURIComponent(portfolioId)}/payouts.json`,
        toSearchParams(params),
      );
      if (!result.ok) return result;
      return reportShapeEvidenceIfInvalid(
        "listPayouts",
        result.value,
        parseSharesightPayouts(result.value, portfolioId),
      );
    },
  };
}
