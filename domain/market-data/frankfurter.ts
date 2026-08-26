// MKT-021 (owner directive, verbatim, 2026-08-26): "Currency quotes should
// display a value using the free source (with example AUD/USD):
// https://api.frankfurter.dev/v2/rate/AUD/USD." Frankfurter republishes the
// European Central Bank's daily reference rates -- a free, no-API-key,
// explicitly-built-for-programmatic-use source (frankfurter.dev's
// `robots.txt` is `Allow: /` for every user agent; see
// docs/MARKET_DATA_STRATEGY.md §25 for the full spike evidence). This is the
// "authoritative daily central-bank source for supported AUD crosses"
// docs/MARKET_DATA_STRATEGY.md §12 already anticipated as the fallback when
// the primary FX source's coverage falls short (the Yahoo-compatible
// adapter's own `FX_PAIR_MAPPINGS`, `./yahoo-compatible.ts`, covers only
// AUD/USD today).
//
// ECB reference rates are set once per business day (published "usually
// around 16:00 CET", per the ECB's own methodology) -- this is a DAILY
// REFERENCE rate, never an intraday/live price. Every observation this
// module produces is `interval: "eod"` / `quality: "observed"`, matching
// this codebase's existing `eod` convention (see `./yahoo-compatible.ts`'s
// own `normalizeChartFx`, which labels ITS daily FX bars `"eod"` too) --
// never `"delayed"` (that label is reserved for a genuinely intraday
// capture running some known/estimated number of minutes behind a live
// market) and never anything resembling "live" (AGENTS.md non-negotiable:
// never call a price live without contractual/timestamp evidence -- ECB
// publishes once a day, which is the opposite of live).
//
// This is a narrow, FX-only client -- deliberately NOT a full
// `MarketDataProvider` (no security search, no dividends/splits/daily-price
// history capability exists to implement here, and stubbing all of that out
// would only obscure that this provider does exactly one thing). Callers
// that need the generic `MarketDataProvider` shape keep using
// `createYahooCompatibleProvider`; `app/frankfurter-fx-service.ts` resolves
// this client directly, the same way `primeWatchlistSecurityPrice`
// (`app/watchlist-actions.ts`) calls a provider directly for its own
// best-effort on-add prime rather than going through the durable
// `market_data_refresh_jobs` queue (`domain/market-data/ingestion.ts`) --
// that queue is driven by portfolio-holding FX needs, not watch-only
// currency-pair entries, and extending it was judged out of MKT-021's scope
// (see this task's Worker report for the full reasoning).
import type {
  FxObservation,
  MarketDataError,
  MarketDataResult,
  NormalizationContext,
} from "./contracts.ts";
import { normalizeFxObservation } from "./normalize.ts";
import {
  frankfurterGet,
  type FrankfurterFetcher,
} from "./frankfurter-transport.ts";

export const FRANKFURTER_PROVIDER_ID = "frankfurter";

const DEFAULT_BASE_URL = "https://api.frankfurter.dev/v2";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_BACKOFF_MS = 2_000;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export type FrankfurterFxClientOptions = {
  fetcher?: FrankfurterFetcher;
  baseUrl?: string;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  timeoutMs?: number;
};

export type FrankfurterRateRequest = {
  baseCurrencyCode: string;
  quoteCurrencyCode: string;
};

export type FrankfurterFxClient = {
  getLatestRate(
    request: FrankfurterRateRequest,
  ): Promise<MarketDataResult<FxObservation>>;
};

class FetchTimeoutError extends Error {}

type ErrorResult = { ok: false; error: MarketDataError };

type FetchJsonResult =
  { ok: true; value: unknown; bodyText: string } | ErrorResult;

function error(
  kind: MarketDataError["kind"],
  message: string,
  retryable: boolean,
): ErrorResult {
  return { ok: false, error: { kind, message, retryable } };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, DEFAULT_MAX_BACKOFF_MS)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Mirrors `yahoo-compatible.ts`'s `positiveDecimal` exactly: Frankfurter's
 * `rate` field arrives as a JSON NUMBER, not a decimal string, so this is
 * the identical boundary-conversion problem this codebase already accepted
 * an established answer for (Yahoo's `close`/`previousClose` numbers hit
 * the same JSON-number-to-decimal-string conversion). `String(value)` is
 * the established precedent, not a new one invented for this provider.
 */
function positiveDecimal(value: unknown): string | null {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) && value > 0 ? String(value) : null;
}

function isMarketDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Builds the Frankfurter FX-rate client. No auth is needed -- the API is
 * free and requires no key -- so the "provider conventions" this mirrors
 * are the transport/retry/validation shape (`./yahoo-compatible.ts`'s
 * `fetchJson`), not credential handling.
 */
export function createFrankfurterFxClient(
  options: FrankfurterFxClientOptions = {},
): FrankfurterFxClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const fetcher =
    options.fetcher ?? (fetch.bind(globalThis) as FrankfurterFetcher);
  const now = options.now ?? (() => new Date().toISOString());
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  const maxAttempts = Math.max(
    1,
    Math.min(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 5),
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function fetchJson(url: URL): Promise<FetchJsonResult> {
    let lastError: ErrorResult = error(
      "transient_upstream",
      "Frankfurter request failed.",
      true,
    );
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<Response>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new FetchTimeoutError());
        }, timeoutMs);
      });
      let response: Response;
      try {
        response = await Promise.race([
          frankfurterGet(fetcher, url, {
            headers: { accept: "application/json" },
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
      } catch (caught: unknown) {
        const timedOut =
          caught instanceof FetchTimeoutError || controller.signal.aborted;
        lastError = error(
          timedOut ? "timeout" : "transient_upstream",
          timedOut
            ? "Frankfurter request timed out."
            : "Frankfurter request failed.",
          true,
        );
        if (timeout) clearTimeout(timeout);
        if (attempt + 1 < maxAttempts) {
          await sleep(
            Math.min(
              DEFAULT_MAX_BACKOFF_MS,
              100 * 2 ** attempt + Math.floor(random() * 100),
            ),
          );
          continue;
        }
        return lastError;
      } finally {
        if (timeout) clearTimeout(timeout);
      }

      if (!response.ok) {
        const isRetryable = retryableStatus(response.status);
        lastError = error(
          response.status === 429
            ? "rate_limit"
            : isRetryable
              ? "transient_upstream"
              : "invalid_response",
          "Frankfurter request was not accepted.",
          isRetryable,
        );
        if (!isRetryable) {
          return lastError;
        }
        if (attempt + 1 < maxAttempts) {
          await sleep(
            retryAfterMilliseconds(response) ??
              Math.min(
                DEFAULT_MAX_BACKOFF_MS,
                100 * 2 ** attempt + Math.floor(random() * 100),
              ),
          );
          continue;
        }
        return lastError;
      }

      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch {
        return error(
          "invalid_response",
          "Frankfurter response could not be read.",
          false,
        );
      }
      try {
        return { ok: true, value: JSON.parse(bodyText), bodyText };
      } catch {
        return error(
          "invalid_response",
          "Frankfurter response is not valid JSON.",
          false,
        );
      }
    }
    return lastError;
  }

  return {
    async getLatestRate(
      request: FrankfurterRateRequest,
    ): Promise<MarketDataResult<FxObservation>> {
      const baseCurrencyCode = request.baseCurrencyCode.trim().toUpperCase();
      const quoteCurrencyCode = request.quoteCurrencyCode.trim().toUpperCase();
      if (
        !CURRENCY_CODE_PATTERN.test(baseCurrencyCode) ||
        !CURRENCY_CODE_PATTERN.test(quoteCurrencyCode)
      ) {
        return error(
          "invalid_response",
          "Frankfurter currency codes must be 3-letter ISO codes.",
          false,
        );
      }
      if (baseCurrencyCode === quoteCurrencyCode) {
        return error(
          "invalid_response",
          "Frankfurter base and quote currency must differ.",
          false,
        );
      }

      // The owner's own directed URL shape (verbatim, MKT-021): confirmed
      // live against the real API during this task's spike (see
      // docs/MARKET_DATA_STRATEGY.md §25) -- `/v2/rate/{base}/{quote}`
      // returns `{"date","base","quote","rate"}` directly, no nested
      // `rates` object to unwrap (unlike the `/v1/latest` shape).
      const url = new URL(
        `${baseUrl}/rate/${baseCurrencyCode}/${quoteCurrencyCode}`,
      );
      const fetched = await fetchJson(url);
      if (!fetched.ok) return fetched;

      const record = asRecord(fetched.value);
      const base = record?.base;
      const quote = record?.quote;
      const date = record?.date;
      const rateDecimal = positiveDecimal(record?.rate);
      if (
        !record ||
        typeof base !== "string" ||
        base.toUpperCase() !== baseCurrencyCode ||
        typeof quote !== "string" ||
        quote.toUpperCase() !== quoteCurrencyCode ||
        !isMarketDate(date) ||
        !rateDecimal
      ) {
        return error(
          "invalid_response",
          "Frankfurter response has a malformed pair, date, or rate.",
          false,
        );
      }

      const payloadSha256 = await sha256Hex(fetched.bodyText);
      return normalizeFxObservation(
        {
          interval: "eod",
          // ECB publishes one reference rate per business day and no
          // intraday timestamp -- `observedAt` anchors the reference DATE
          // at UTC midnight, a deterministic, re-fetch-stable instant,
          // never a fabricated wall-clock capture time. This mirrors
          // MKT-008's "derive `observation_at` deterministically from the
          // bare trading date" convention for owner-uploaded EOD closes
          // (docs/DATA_MODEL.md's owner-import entry) -- there is no
          // per-pair "exchange timezone" for FX the way MKT-008 has one for
          // ASX equities, so UTC midnight is the neutral anchor.
          //
          // MKT-021 review (B3, BLOCKING): the VISIBLE row itself shows
          // only the reference date -- `app/owned-watchlist.ts` renders a
          // currency-pair row's `marketDate`, never a time (FxObservation
          // carries no market-timezone field to convert one into). But the
          // ACCESSIBLE explanation (`app/watchlist-contract.ts`'s
          // `watchlistExplanation`, rendered via
          // `app/components/portfolio-shell.tsx`) DOES surface this exact
          // UTC-midnight anchor verbatim as "observation timestamp:
          // 2026-08-26T00:00:00Z" -- an earlier version of this comment
          // (and docs/MARKET_DATA_STRATEGY.md §25) claimed the owner never
          // sees this instant at all, which the reviewer disproved
          // end-to-end. The anchor choice itself is still the right one
          // (deterministic, honest about being a derived date-anchor, not
          // a captured wall-clock time) -- only the "never visible" claim
          // was false, corrected here and in §25.
          observedAt: `${date}T00:00:00Z`,
          marketDate: date,
          baseCurrencyCode,
          quoteCurrencyCode,
          rateDecimal,
          quality: "observed",
          delayedMinutes: null,
          providerRevisionId: null,
          payloadSha256,
        },
        {
          providerId: FRANKFURTER_PROVIDER_ID,
          scope: { kind: "deployment", userId: null },
          ingestedAt: now(),
        } satisfies NormalizationContext,
      );
    },
  };
}
