import type {
  DailyPriceRequest,
  DividendEventInput,
  DividendRequest,
  FxObservation,
  FxRequest,
  LatestRequest,
  MarketDataError,
  MarketDataProvider,
  MarketDataResult,
  NormalizationContext,
  PriceObservation,
  ProviderCapabilities,
  SecurityCandidate,
  SecurityQuery,
  SplitEventInput,
  SplitRequest,
} from "./contracts.ts";
import {
  normalizeDividendEventInput,
  normalizeFxObservation,
  normalizePriceObservation,
  normalizeSplitEventInput,
} from "./normalize.ts";

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

// MKT-009B: the owner's exported Yahoo login cookies (`T`/`Y`, per MKT-009A's
// dated evidence -- docs/MARKET_DATA_STRATEGY.md §20). Built by
// `worker/yahoo-auth-config.ts`'s `createYahooAuthConfig` from
// `YAHOO_COOKIE_T`/`YAHOO_COOKIE_Y`; this module never reads env directly.
export type YahooAuthCredentials = {
  cookieT: string;
  cookieY: string;
};

// Per-observation session provenance, recorded in `providerRevisionId` (an
// existing free-text provenance field, already repurposed per-request for
// FX direction below -- see `normalizeChartFx`) rather than a new column,
// so no `price_observations` migration is needed for this. Only set when
// `options.auth` is actually configured; a deployment with no cookies
// configured keeps today's exact `providerRevisionId: null` shape for price
// observations (zero behaviour change for the common case).
export type YahooSessionState = "authenticated" | "anonymous";

export type YahooCompatibleAdapterOptions = {
  baseUrl?: string;
  providerId?: string;
  fetcher?: Fetcher;
  resolveSymbol: (mappingId: string) => Promise<string | null>;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  timeoutMs?: number;
  /**
   * Optional login-cookie jar (MKT-009B). Attached ONLY to this adapter's
   * pre-existing crumb-free chart/search calls -- no new dependency on the
   * `/v1/test/getcrumb` handshake, per MKT-009A's "safest scope"
   * recommendation. `null`/`undefined` (the default) is today's fully
   * anonymous behaviour, byte-for-byte unchanged.
   */
  auth?: YahooAuthCredentials | null;
};

type YahooChartMeta = {
  currency: unknown;
  exchangeTimezoneName: unknown;
  regularMarketPrice?: unknown;
  regularMarketPreviousClose?: unknown;
  previousClose?: unknown;
  regularMarketTime?: unknown;
  exchangeDataDelayedBy?: unknown;
  symbol?: unknown;
  instrumentType?: unknown;
};

type YahooChartResult = {
  meta: YahooChartMeta;
  timestamp?: unknown;
  indicators: {
    quote: unknown[];
  };
  // Only present when the request asked for `events=div,splits`; a chart
  // request without that parameter simply omits the field, so every reader
  // must treat it as optional/absent rather than malformed.
  events?: unknown;
};

type YahooQuote = {
  symbol?: unknown;
  shortname?: unknown;
  longname?: unknown;
  exchange?: unknown;
  exchangeDisplayName?: unknown;
  quoteType?: unknown;
  currency?: unknown;
};

type CachedLatest = {
  key: string;
  value: PriceObservation;
};

const CAPABILITIES: ProviderCapabilities = {
  exchanges: [],
  intervals: ["eod", "delayed"],
  supportsRawPrices: true,
  supportsAdjustedPrices: false,
  supportsFx: true,
  supportsDividends: true,
  supportsSplits: true,
  supportsFundamentals: false,
};

const DEFAULT_BASE_URL = "https://query1.finance.yahoo.com";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BACKOFF_MS = 2_000;

const FX_PAIR_MAPPINGS = {
  "AUD/USD": {
    providerSymbol: "AUDUSD=X",
    providerBaseCurrencyCode: "AUD",
    providerQuoteCurrencyCode: "USD",
    invert: false,
  },
  "USD/AUD": {
    providerSymbol: "AUDUSD=X",
    providerBaseCurrencyCode: "AUD",
    providerQuoteCurrencyCode: "USD",
    invert: true,
  },
} as const;

class FetchTimeoutError extends Error {
  constructor() {
    super("Yahoo-compatible provider request timed out.");
    this.name = "FetchTimeoutError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function positiveDecimal(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return /^(0|[1-9]\d*)(\.\d+)?$/.test(normalized) &&
    /[1-9]/.test(normalized.replace(".", ""))
    ? normalized
    : null;
}

type Decimal = { coefficient: bigint; scale: number };

function parseDecimal(value: string): Decimal | null {
  const match = /^(0|[1-9]\d*)(\.\d+)?$/.exec(value);
  if (!match) return null;
  const fraction = match[2]?.slice(1) ?? "";
  return {
    coefficient: BigInt(`${match[1]}${fraction}`),
    scale: fraction.length,
  };
}

function powerOfTen(scale: number): bigint {
  return 10n ** BigInt(scale);
}

function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = remainder * 2n;
  return doubled > denominator ||
    (doubled === denominator && quotient % 2n !== 0n)
    ? quotient + 1n
    : quotient;
}

function normalizeDecimal(value: Decimal): string {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  if (scale === 0) return coefficient.toString();
  const digits = coefficient.toString().padStart(scale + 1, "0");
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function invertDecimal(value: string, scale = 18): string | null {
  const decimal = parseDecimal(value);
  if (!decimal || decimal.coefficient <= 0n) return null;
  const numerator = powerOfTen(scale + decimal.scale);
  return normalizeDecimal({
    coefficient: roundHalfEven(numerator, decimal.coefficient),
    scale,
  });
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function isoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isMarketDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

function marketDateFromInstant(
  instant: string,
  timezone: string,
): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instant));
    const values = new Map(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const result = `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
  } catch {
    return null;
  }
}

function normalizeScopeKey(scope: LatestRequest["scope"]): string {
  return scope.kind === "deployment" ? "deployment" : `user:${scope.userId}`;
}

function error(
  kind: MarketDataError["kind"],
  message: string,
  retryable: boolean,
): MarketDataResult<never> {
  return { ok: false, error: { kind, message, retryable } };
}

function unavailable<T>(capability: string): MarketDataResult<T> {
  return error(
    "unavailable_capability",
    `${capability} is unavailable for this provider.`,
    false,
  );
}

function chartResult(value: unknown): MarketDataResult<YahooChartResult> {
  const root = asRecord(value);
  const chart = root ? asRecord(root.chart) : null;
  const result = chart && Array.isArray(chart.result) ? chart.result[0] : null;
  const resultRecord = asRecord(result);
  const meta = resultRecord ? asRecord(resultRecord.meta) : null;
  const indicators = resultRecord ? asRecord(resultRecord.indicators) : null;
  const quote = indicators ? indicators.quote : null;
  if (!meta || !indicators || !Array.isArray(quote) || !quote[0]) {
    return error(
      "invalid_response",
      "Provider chart response is malformed.",
      false,
    );
  }
  return {
    ok: true,
    value: {
      meta: meta as YahooChartMeta,
      timestamp: resultRecord?.timestamp,
      indicators: { quote: quote as unknown[] },
      events: resultRecord?.events,
    },
  };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, DEFAULT_MAX_BACKOFF_MS)
    : null;
}

function requestKey(
  request: LatestRequest | DailyPriceRequest,
  symbol: string,
): string {
  return [
    request.mappingId,
    request.securityId,
    symbol,
    normalizeScopeKey(request.scope),
  ].join("|");
}

function fxPairKey(request: FxRequest): string {
  return `${request.baseCurrencyCode.toUpperCase()}/${request.quoteCurrencyCode.toUpperCase()}`;
}

export function createYahooCompatibleProvider(
  options: YahooCompatibleAdapterOptions,
): MarketDataProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const providerId = options.providerId ?? "yahoo-compatible";
  const fetcher = options.fetcher ?? fetch.bind(globalThis);
  const now = options.now ?? (() => new Date().toISOString());
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = options.random ?? Math.random;
  const maxAttempts = Math.max(
    1,
    Math.min(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 5),
  );
  const failureThreshold = Math.max(
    1,
    options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
  );
  const circuitCooldownMs =
    options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cachedLatest = new Map<string, CachedLatest>();
  let consecutiveFailures = 0;
  let circuitOpenedAt = 0;
  // MKT-009B: sticky per-instance flag -- once an authenticated request
  // comes back 401 (login cookie invalid/expired), every later call in this
  // adapter's lifetime skips the authenticated attempt entirely rather than
  // repeatedly resending a cookie jar Yahoo has already rejected. There is
  // no refresh path for these cookies (docs/MARKET_DATA_STRATEGY.md §20) --
  // the only fix is the owner re-exporting them, which means constructing a
  // fresh provider instance (a new Worker invocation/isolate).
  let authInvalid = false;

  function authHeaders(): Record<string, string> | undefined {
    if (!options.auth || authInvalid) return undefined;
    // Cookie value discipline: this header is sent to Yahoo only, over the
    // adapter's own `fetcher`. It is never logged, never included in any
    // `MarketDataError`, and never returned from this module.
    return { cookie: `T=${options.auth.cookieT}; Y=${options.auth.cookieY}` };
  }

  function circuitOpen(): boolean {
    if (circuitOpenedAt === 0) {
      return false;
    }
    if (Date.now() - circuitOpenedAt >= circuitCooldownMs) {
      circuitOpenedAt = 0;
      consecutiveFailures = 0;
      return false;
    }
    return true;
  }

  function recordSuccess(): void {
    consecutiveFailures = 0;
    circuitOpenedAt = 0;
  }

  function recordFailure(): void {
    consecutiveFailures += 1;
    if (consecutiveFailures >= failureThreshold) {
      circuitOpenedAt = Date.now();
    }
  }

  async function fetchJson(
    url: URL,
    extraHeaders?: Record<string, string>,
  ): Promise<MarketDataResult<unknown>> {
    if (circuitOpen()) {
      return error(
        "transient_upstream",
        "Market-data provider circuit is open.",
        true,
      );
    }

    let lastError: MarketDataResult<never> = error(
      "transient_upstream",
      "Market-data provider request failed.",
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
          fetcher(url, {
            headers: { accept: "application/json", ...extraHeaders },
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
            ? "Market-data provider request timed out."
            : "Market-data provider request failed.",
          true,
        );
        recordFailure();
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
          response.status === 401
            ? "authentication"
            : response.status === 403
              ? "entitlement"
              : response.status === 404
                ? "symbol_not_found"
                : response.status === 429
                  ? "rate_limit"
                  : isRetryable
                    ? "transient_upstream"
                    : "invalid_response",
          "Market-data provider request was not accepted.",
          isRetryable,
        );
        if (!isRetryable) {
          return lastError;
        }
        recordFailure();
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

      try {
        const body: unknown = await response.json();
        recordSuccess();
        return { ok: true, value: body };
      } catch {
        recordFailure();
        return error(
          "invalid_response",
          "Provider response is not valid JSON.",
          false,
        );
      }
    }
    return lastError;
  }

  /**
   * MKT-009B: the auth-aware entry point every chart/search call site below
   * uses in place of a bare `fetchJson(url)`. When no login cookie is
   * configured (or a prior call already invalidated one -- `authInvalid`),
   * this is IDENTICAL to `fetchJson(url)` -- zero behaviour change.
   *
   * When a cookie jar is attached: a clean `401` is the only signal this
   * spike-evidenced design treats as "the login session is invalid" (per
   * docs/MARKET_DATA_STRATEGY.md §20's binding failure-mode requirement) --
   * on that specific outcome, and ONLY that outcome, this degrades to a
   * second, anonymous attempt against the SAME url and marks the cookie
   * jar invalid for the rest of this adapter's lifetime (no repeated
   * hammering with cookies Yahoo has already rejected). A `429` (or any
   * other outcome) is returned exactly as `fetchJson` produced it --
   * `fetchJson`'s own retry loop and circuit breaker already own that path,
   * and this function never reinterprets a rate limit as a login failure.
   */
  async function fetchJsonAuthAware(url: URL): Promise<{
    result: MarketDataResult<unknown>;
    sessionState: YahooSessionState;
  }> {
    const headers = authHeaders();
    if (!headers) {
      return { result: await fetchJson(url), sessionState: "anonymous" };
    }
    const authedResult = await fetchJson(url, headers);
    if (!authedResult.ok && authedResult.error.kind === "authentication") {
      authInvalid = true;
      return {
        result: await fetchJson(url),
        sessionState: "anonymous",
      };
    }
    return { result: authedResult, sessionState: "authenticated" };
  }

  async function symbolFor(
    mappingId: string,
  ): Promise<MarketDataResult<string>> {
    const symbol = await options.resolveSymbol(mappingId);
    return symbol && /^[A-Za-z0-9.^=_-]{1,32}$/.test(symbol)
      ? { ok: true, value: symbol }
      : error(
          "symbol_not_found",
          "No provider symbol is mapped for this security.",
          false,
        );
  }

  function chartUrl(symbol: string, params: Record<string, string>): URL {
    const url = new URL(
      `${baseUrl}/v8/finance/chart/${encodeURIComponent(symbol)}`,
    );
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  function chartContext(result: YahooChartResult): MarketDataResult<{
    currency: string;
    timezone: string;
    delayedMinutes: number | null;
    symbol: string | null;
  }> {
    const currency = requiredString(result.meta.currency);
    const timezone = requiredString(result.meta.exchangeTimezoneName);
    const symbol = requiredString(result.meta.symbol);
    const delayedMinutes =
      result.meta.exchangeDataDelayedBy === undefined ||
      result.meta.exchangeDataDelayedBy === null
        ? null
        : nonNegativeInteger(result.meta.exchangeDataDelayedBy);
    if (
      !currency ||
      !timezone ||
      (result.meta.exchangeDataDelayedBy !== undefined &&
        result.meta.exchangeDataDelayedBy !== null &&
        delayedMinutes === null)
    ) {
      return error(
        "invalid_response",
        "Provider chart metadata is malformed.",
        false,
      );
    }
    return {
      ok: true,
      value: { currency, timezone, delayedMinutes, symbol },
    };
  }

  /**
   * Shared fetch/parse path for `getDividendEvents`/`getSplitEvents`
   * (MKT-005): both request the same `events=div,splits` chart shape and
   * only differ in which `events` sub-object they read, so the resolve
   * symbol / validate range / fetch / parse-chart / parse-metadata steps are
   * factored out once rather than duplicated per capability.
   */
  async function fetchCorporateActionChart(
    request: DividendRequest | SplitRequest,
  ): Promise<
    MarketDataResult<{
      chart: YahooChartResult;
      metadata: {
        currency: string;
        timezone: string;
        delayedMinutes: number | null;
        symbol: string | null;
      };
    }>
  > {
    const symbol = await symbolFor(request.mappingId);
    if (!symbol.ok) return symbol;
    const from = Date.parse(`${request.from}T00:00:00Z`);
    const to = Date.parse(`${request.to}T00:00:00Z`);
    if (
      !isMarketDate(request.from) ||
      !isMarketDate(request.to) ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to < from
    ) {
      return error(
        "invalid_response",
        "Corporate-action event date range is invalid.",
        false,
      );
    }
    const { result: response } = await fetchJsonAuthAware(
      chartUrl(symbol.value, {
        period1: String(Math.floor(from / 1000)),
        period2: String(Math.floor(to / 1000) + 86_400),
        interval: "1d",
        events: "div,splits",
      }),
    );
    if (!response.ok) return response;
    const chart = chartResult(response.value);
    if (!chart.ok) return chart;
    const metadata = chartContext(chart.value);
    if (!metadata.ok) return metadata;
    return {
      ok: true,
      value: { chart: chart.value, metadata: metadata.value },
    };
  }

  function normalizeChartPrice(
    request: LatestRequest | DailyPriceRequest,
    timestamp: unknown,
    close: unknown,
    previousClose: unknown,
    interval: "eod" | "delayed",
    metadata: {
      currency: string;
      timezone: string;
      delayedMinutes: number | null;
    },
    // MKT-009B: only ever set (non-undefined) when `options.auth` is
    // configured -- see the type's own doc comment for why an unconfigured
    // deployment keeps today's exact `providerRevisionId: null` shape.
    sessionState?: YahooSessionState,
  ): MarketDataResult<PriceObservation> {
    const observationAt = isoFromUnixSeconds(timestamp);
    const closeDecimal = positiveDecimal(close);
    const previousCloseDecimal =
      previousClose === null || previousClose === undefined
        ? null
        : positiveDecimal(previousClose);
    const marketDate = observationAt
      ? marketDateFromInstant(observationAt, metadata.timezone)
      : null;
    if (
      !observationAt ||
      !closeDecimal ||
      (previousClose !== null &&
        previousClose !== undefined &&
        !previousCloseDecimal) ||
      !marketDate
    ) {
      return error(
        "invalid_response",
        "Provider price data is malformed.",
        false,
      );
    }
    const normalized = normalizePriceObservation(
      {
        interval,
        observationAt,
        marketDate,
        marketTimezone: metadata.timezone,
        currencyCode: metadata.currency,
        closeDecimal,
        previousCloseDecimal,
        adjustmentState: "raw",
        quality: "observed",
        delayedMinutes: metadata.delayedMinutes,
        providerRevisionId:
          sessionState === undefined ? null : `session:${sessionState}`,
      },
      {
        providerId,
        mappingId: request.mappingId,
        securityId: request.securityId,
        scope: request.scope,
        ingestedAt: now(),
      } satisfies NormalizationContext,
    );
    return normalized;
  }

  function normalizeChartFx(
    request: FxRequest,
    timestamp: unknown,
    close: unknown,
    metadata: {
      currency: string;
      timezone: string;
      delayedMinutes: number | null;
      symbol: string | null;
    },
    mapping: (typeof FX_PAIR_MAPPINGS)[keyof typeof FX_PAIR_MAPPINGS],
  ): MarketDataResult<FxObservation> {
    const observedAt = isoFromUnixSeconds(timestamp);
    const providerRateDecimal = positiveDecimal(close);
    const marketDate = observedAt
      ? marketDateFromInstant(observedAt, metadata.timezone)
      : null;
    if (
      !observedAt ||
      !providerRateDecimal ||
      !marketDate ||
      (metadata.symbol !== null &&
        metadata.symbol !== mapping.providerSymbol) ||
      metadata.currency.toUpperCase() !== mapping.providerQuoteCurrencyCode
    ) {
      return error(
        "invalid_response",
        "Provider FX data has malformed direction, date, or rate.",
        false,
      );
    }
    const rateDecimal = mapping.invert
      ? invertDecimal(providerRateDecimal)
      : providerRateDecimal;
    if (!rateDecimal) {
      return error(
        "invalid_response",
        "Provider FX rate cannot be inverted.",
        false,
      );
    }
    return normalizeFxObservation(
      {
        interval: "eod",
        observedAt,
        marketDate,
        baseCurrencyCode: request.baseCurrencyCode.toUpperCase(),
        quoteCurrencyCode: request.quoteCurrencyCode.toUpperCase(),
        rateDecimal,
        quality: "observed",
        delayedMinutes: metadata.delayedMinutes,
        providerRevisionId: mapping.invert
          ? `inverted:${mapping.providerBaseCurrencyCode}/${mapping.providerQuoteCurrencyCode}`
          : `direct:${mapping.providerBaseCurrencyCode}/${mapping.providerQuoteCurrencyCode}`,
      },
      {
        providerId,
        scope: request.scope,
        ingestedAt: now(),
      } satisfies NormalizationContext,
    );
  }

  function staleFallback(
    key: string,
  ): MarketDataResult<PriceObservation> | null {
    const cached = cachedLatest.get(key);
    if (!cached) {
      return null;
    }
    return {
      ok: true,
      value: { ...cached.value, quality: "stale_candidate" },
    };
  }

  return {
    capabilities: () => CAPABILITIES,

    async searchSecurities(
      query: SecurityQuery,
    ): Promise<MarketDataResult<SecurityCandidate[]>> {
      const url = new URL(`${baseUrl}/v1/finance/search`);
      url.searchParams.set("q", query.text);
      if (query.exchangeId) url.searchParams.set("quotesCount", "20");
      const { result: response } = await fetchJsonAuthAware(url);
      if (!response.ok) return response;
      const root = asRecord(response.value);
      const quotes = root?.quotes;
      if (!Array.isArray(quotes))
        return error(
          "invalid_response",
          "Provider search response is malformed.",
          false,
        );
      const candidates: SecurityCandidate[] = [];
      for (const quote of quotes) {
        const record = asRecord(quote) as YahooQuote | null;
        const symbol = record ? requiredString(record.symbol) : null;
        const name = record
          ? (requiredString(record.longname) ??
            requiredString(record.shortname))
          : null;
        const quoteType = record ? requiredString(record.quoteType) : null;
        const currencyCode = record ? requiredString(record.currency) : null;
        if (
          !symbol ||
          !name ||
          !quoteType ||
          !currencyCode ||
          !["EQUITY", "ETF", "MUTUALFUND"].includes(quoteType)
        ) {
          continue;
        }
        const exchangeId = record
          ? (requiredString(record.exchange) ??
            requiredString(record.exchangeDisplayName))
          : null;
        const assetType: SecurityCandidate["assetType"] =
          quoteType === "EQUITY"
            ? "equity"
            : quoteType === "ETF"
              ? "etf"
              : "fund";
        candidates.push({
          securityId: null,
          mappingId: null,
          symbol,
          exchangeId,
          currencyCode,
          name,
          confidence: "medium",
          assetType,
        });
      }
      return candidates.length > 0
        ? { ok: true, value: candidates }
        : error(
            "symbol_not_found",
            "Provider returned no supported security matches.",
            false,
          );
    },

    async getDailyPrices(
      request: DailyPriceRequest,
    ): Promise<MarketDataResult<PriceObservation[]>> {
      const symbol = await symbolFor(request.mappingId);
      if (!symbol.ok) return symbol;
      const from = Date.parse(`${request.from}T00:00:00Z`);
      const to = Date.parse(`${request.to}T00:00:00Z`);
      if (
        !isMarketDate(request.from) ||
        !isMarketDate(request.to) ||
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        to < from
      ) {
        return error(
          "invalid_response",
          "Daily price date range is invalid.",
          false,
        );
      }
      const { result: response, sessionState } = await fetchJsonAuthAware(
        chartUrl(symbol.value, {
          period1: String(Math.floor(from / 1000)),
          period2: String(Math.floor(to / 1000) + 86_400),
          interval: "1d",
          events: "history",
        }),
      );
      if (!response.ok) return response;
      const chart = chartResult(response.value);
      if (!chart.ok) return chart;
      const metadata = chartContext(chart.value);
      if (!metadata.ok) return metadata;
      const timestamps = Array.isArray(chart.value.timestamp)
        ? chart.value.timestamp
        : null;
      const quote = asRecord(chart.value.indicators.quote[0]);
      const closes = quote?.close;
      if (
        !timestamps ||
        !Array.isArray(closes) ||
        timestamps.length !== closes.length
      ) {
        return error(
          "invalid_response",
          "Provider daily price arrays are malformed.",
          false,
        );
      }
      const observations: PriceObservation[] = [];
      for (let index = 0; index < timestamps.length; index += 1) {
        const timestamp = timestamps[index];
        const close = closes[index];
        if (close === null || close === undefined) continue;
        const normalized = normalizeChartPrice(
          request,
          timestamp,
          close,
          null,
          "eod",
          metadata.value,
          options.auth ? sessionState : undefined,
        );
        if (!normalized.ok) return normalized;
        if (
          normalized.value.marketDate >= request.from &&
          normalized.value.marketDate <= request.to
        ) {
          observations.push(normalized.value);
        }
      }
      return { ok: true, value: observations };
    },

    async getLatestObservation(
      request: LatestRequest,
    ): Promise<MarketDataResult<PriceObservation | null>> {
      const symbol = await symbolFor(request.mappingId);
      if (!symbol.ok) return symbol;
      const key = requestKey(request, symbol.value);
      const { result: response, sessionState } = await fetchJsonAuthAware(
        chartUrl(symbol.value, {
          range: "1d",
          interval: "1d",
          events: "history",
        }),
      );
      if (!response.ok) {
        const fallbackAllowed = [
          "invalid_response",
          "rate_limit",
          "timeout",
          "transient_upstream",
        ].includes(response.error.kind);
        return fallbackAllowed ? (staleFallback(key) ?? response) : response;
      }
      const chart = chartResult(response.value);
      if (!chart.ok) return staleFallback(key) ?? chart;
      const metadata = chartContext(chart.value);
      if (!metadata.ok) return staleFallback(key) ?? metadata;
      const timestamp =
        chart.value.meta.regularMarketTime ??
        (Array.isArray(chart.value.timestamp)
          ? chart.value.timestamp.at(-1)
          : null);
      const quote = asRecord(chart.value.indicators.quote[0]);
      const close =
        chart.value.meta.regularMarketPrice ??
        (Array.isArray(quote?.close) ? quote.close.at(-1) : null);
      const previousClose =
        chart.value.meta.regularMarketPreviousClose ??
        chart.value.meta.previousClose ??
        null;
      if (
        close === null ||
        close === undefined ||
        timestamp === null ||
        timestamp === undefined
      ) {
        return (
          staleFallback(key) ??
          error("invalid_response", "Provider latest price is missing.", false)
        );
      }
      const normalized = normalizeChartPrice(
        request,
        timestamp,
        close,
        previousClose,
        metadata.value.delayedMinutes === null ? "eod" : "delayed",
        metadata.value,
        options.auth ? sessionState : undefined,
      );
      if (!normalized.ok) return staleFallback(key) ?? normalized;
      cachedLatest.set(key, { key, value: normalized.value });
      return normalized;
    },

    async getFxRates(
      request: FxRequest,
    ): Promise<MarketDataResult<FxObservation[]>> {
      const baseCurrencyCode = request.baseCurrencyCode.toUpperCase();
      const quoteCurrencyCode = request.quoteCurrencyCode.toUpperCase();
      if (baseCurrencyCode === quoteCurrencyCode) {
        return { ok: true, value: [] };
      }
      const mapping =
        FX_PAIR_MAPPINGS[fxPairKey(request) as keyof typeof FX_PAIR_MAPPINGS];
      if (!mapping) {
        return unavailable(`FX pair ${baseCurrencyCode}/${quoteCurrencyCode}`);
      }
      const from = Date.parse(`${request.from}T00:00:00Z`);
      const to = Date.parse(`${request.to}T00:00:00Z`);
      if (
        !isMarketDate(request.from) ||
        !isMarketDate(request.to) ||
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        to < from
      ) {
        return error("invalid_response", "FX date range is invalid.", false);
      }
      // FX provenance keeps its existing direct/inverted `providerRevisionId`
      // encoding (see `normalizeChartFx` below) rather than also carrying
      // session state -- see this call's own note; cookies are still
      // attached (this is an existing crumb-free chart call), but FX
      // observations are out of MKT-009B's provenance scope.
      const { result: response } = await fetchJsonAuthAware(
        chartUrl(mapping.providerSymbol, {
          period1: String(Math.floor(from / 1000)),
          period2: String(Math.floor(to / 1000) + 86_400),
          interval: "1d",
          events: "history",
        }),
      );
      if (!response.ok) return response;
      const chart = chartResult(response.value);
      if (!chart.ok) return chart;
      const metadata = chartContext(chart.value);
      if (!metadata.ok) return metadata;
      const timestamps = Array.isArray(chart.value.timestamp)
        ? chart.value.timestamp
        : null;
      const quote = asRecord(chart.value.indicators.quote[0]);
      const closes = quote?.close;
      if (
        !timestamps ||
        !Array.isArray(closes) ||
        timestamps.length !== closes.length
      ) {
        return error(
          "invalid_response",
          "Provider FX arrays are malformed.",
          false,
        );
      }
      const observations: FxObservation[] = [];
      for (let index = 0; index < timestamps.length; index += 1) {
        const timestamp = timestamps[index];
        const close = closes[index];
        if (close === null || close === undefined) continue;
        const observedAt = isoFromUnixSeconds(timestamp);
        const marketDate = observedAt
          ? marketDateFromInstant(observedAt, metadata.value.timezone)
          : null;
        if (!observedAt || !marketDate) {
          return error(
            "invalid_response",
            "Provider FX timestamp is malformed.",
            false,
          );
        }
        if (marketDate > request.to) {
          return error(
            "invalid_response",
            "Provider FX response contains a future observation.",
            false,
          );
        }
        if (marketDate < request.from) continue;
        const normalized = normalizeChartFx(
          {
            ...request,
            baseCurrencyCode,
            quoteCurrencyCode,
          },
          timestamp,
          close,
          metadata.value,
          mapping,
        );
        if (!normalized.ok) return normalized;
        observations.push(normalized.value);
      }
      return { ok: true, value: observations };
    },
    async getDividendEvents(
      request: DividendRequest,
    ): Promise<MarketDataResult<DividendEventInput[]>> {
      const fetched = await fetchCorporateActionChart(request);
      if (!fetched.ok) return fetched;
      const { chart, metadata } = fetched.value;
      const eventsRoot = asRecord(chart.events);
      const dividends = eventsRoot ? eventsRoot.dividends : undefined;
      if (dividends === undefined || dividends === null) {
        return { ok: true, value: [] };
      }
      const dividendRecord = asRecord(dividends);
      if (!dividendRecord) {
        return error(
          "invalid_response",
          "Provider dividend events are malformed.",
          false,
        );
      }
      const context: NormalizationContext = {
        providerId,
        securityId: request.securityId,
        mappingId: request.mappingId,
        scope: request.scope,
        ingestedAt: now(),
      };
      const observations: DividendEventInput[] = [];
      for (const entry of Object.values(dividendRecord)) {
        const entryRecord = asRecord(entry);
        const amountDecimal = entryRecord
          ? positiveDecimal(entryRecord.amount)
          : null;
        const observedAt = entryRecord
          ? isoFromUnixSeconds(entryRecord.date)
          : null;
        const exDate = observedAt
          ? marketDateFromInstant(observedAt, metadata.timezone)
          : null;
        if (!entryRecord || !amountDecimal || !exDate) {
          return error(
            "invalid_response",
            "Provider dividend event is malformed.",
            false,
          );
        }
        if (exDate < request.from || exDate > request.to) continue;
        const normalized = normalizeDividendEventInput(
          {
            exDate,
            // Yahoo's dividend events never carry a payment date -- see the
            // `paymentDate` field comment on `DividendEventInput`.
            paymentDate: null,
            currencyCode: metadata.currency,
            amountDecimal,
          },
          context,
        );
        if (!normalized.ok) return normalized;
        observations.push(normalized.value);
      }
      return { ok: true, value: observations };
    },

    async getSplitEvents(
      request: SplitRequest,
    ): Promise<MarketDataResult<SplitEventInput[]>> {
      const fetched = await fetchCorporateActionChart(request);
      if (!fetched.ok) return fetched;
      const { chart, metadata } = fetched.value;
      const eventsRoot = asRecord(chart.events);
      const splits = eventsRoot ? eventsRoot.splits : undefined;
      if (splits === undefined || splits === null) {
        return { ok: true, value: [] };
      }
      const splitRecord = asRecord(splits);
      if (!splitRecord) {
        return error(
          "invalid_response",
          "Provider split events are malformed.",
          false,
        );
      }
      const context: NormalizationContext = {
        providerId,
        securityId: request.securityId,
        mappingId: request.mappingId,
        scope: request.scope,
        ingestedAt: now(),
      };
      const observations: SplitEventInput[] = [];
      for (const entry of Object.values(splitRecord)) {
        const entryRecord = asRecord(entry);
        const numeratorDecimal = entryRecord
          ? positiveDecimal(entryRecord.numerator)
          : null;
        const denominatorDecimal = entryRecord
          ? positiveDecimal(entryRecord.denominator)
          : null;
        const observedAt = entryRecord
          ? isoFromUnixSeconds(entryRecord.date)
          : null;
        // Yahoo's split events carry a single date; MKT-005 uses it for both
        // the domain `effectiveDate` and (in the ingestion mapper) the
        // repository's required `ex_date`, since the provider does not
        // distinguish the two.
        const effectiveDate = observedAt
          ? marketDateFromInstant(observedAt, metadata.timezone)
          : null;
        if (
          !entryRecord ||
          !numeratorDecimal ||
          !denominatorDecimal ||
          !effectiveDate
        ) {
          return error(
            "invalid_response",
            "Provider split event is malformed.",
            false,
          );
        }
        if (effectiveDate < request.from || effectiveDate > request.to)
          continue;
        const normalized = normalizeSplitEventInput(
          { effectiveDate, numeratorDecimal, denominatorDecimal },
          context,
        );
        if (!normalized.ok) return normalized;
        observations.push(normalized.value);
      }
      return { ok: true, value: observations };
    },
    getFundamentals: async () => unavailable("Fundamentals"),
  };
}
