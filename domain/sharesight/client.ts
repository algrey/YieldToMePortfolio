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

  return {
    async listPortfolios() {
      const result = await getJson("/portfolios");
      if (!result.ok) return result;
      return parseSharesightPortfolios(result.value);
    },
    async getPortfolioHoldings(portfolioId) {
      const result = await getJson(
        `/portfolios/${encodeURIComponent(portfolioId)}/holdings`,
      );
      if (!result.ok) return result;
      return parseSharesightHoldings(result.value, portfolioId);
    },
    async listTrades(portfolioId, params) {
      const result = await getJson(
        `/portfolios/${encodeURIComponent(portfolioId)}/trades`,
        toSearchParams(params),
      );
      if (!result.ok) return result;
      return parseSharesightTrades(result.value, portfolioId);
    },
    async listPayouts(portfolioId, params) {
      const result = await getJson(
        `/portfolios/${encodeURIComponent(portfolioId)}/payouts`,
        toSearchParams(params),
      );
      if (!result.ok) return result;
      return parseSharesightPayouts(result.value, portfolioId);
    },
  };
}
