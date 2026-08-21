/**
 * UI-018: owner-scoped read of a single security's daily price series for
 * the holding-detail price-history chart. Reads `price_observations`
 * directly (ALL providers the owner's reads may see -- deployment rows
 * plus the owner's OWN user-scoped rows, INCLUDING `sharesight`) through
 * the same owner-visible scope predicate `app/owned-holdings.ts` uses.
 *
 * Deliberately does NOT apply BRK-012C's `provider_id <> 'sharesight'`
 * holdings/snapshot exclusion -- that exclusion exists so a delayed quote
 * never masquerades as a valuation input; this chart is not a valuation
 * input, it is a historical DISPLAY of every price the owner's account has
 * actually recorded, so hiding Sharesight rows here would be LESS honest,
 * not more. (See MARKET_DATA_STRATEGY.md section 19.)
 *
 * Review round-1 fix (B1, BLOCKING): a security can carry `price_observations`
 * rows in more than one currency (e.g. a trade-currency correction, a
 * mis-mapped provider row, or -- concretely -- a foreign-currency dividend
 * payout accidentally sharing a `security_id` with a differently-denominated
 * price feed). Plotting them on one line as if they were the same unit
 * produced a fake ~35% "crash" with no currency shown anywhere. The series
 * is now constrained to the HOLDING'S OWN IDENTITY CURRENCY --
 * `securities.primary_currency_code`, the same value `app/owned-holdings.ts`
 * treats as the security's currency -- and every off-currency row
 * encountered in the query window is EXCLUDED, never plotted, with the
 * exclusion count disclosed in `provenance.excludedCurrencyCount` (never
 * silently dropped -- MKT-008's disclosure discipline).
 */
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { currentFyWindow } from "../domain/calculations/financial-year.ts";
import { resolveDailyCaptureWindowStatus } from "../domain/market-data/daily-capture-window.ts";
import {
  listOwnedIntradayPricePointsForDate,
  resolveSecurityMarketTimezones,
} from "../db/repositories/intraday-price-capture.ts";
import {
  downsamplePriceHistoryPoints,
  parsePriceHistoryRangeParam,
  priceHistoryWindow,
  selectDailyWinners,
  type PriceHistoryRange,
  type RawPricePoint,
} from "./price-history-range.ts";

const DEFAULT_FY_START_MONTH = 7;
// One security's own daily-close history, not a whole portfolio's -- the
// real owner fixture referenced in TASKS.md UI-018 is ~7,313 raw days
// (28 years), so this cap is honestly generous while still bounding the
// read. Ask for one row past the cap (see the MAX+1 pattern documented in
// `app/dividend-assumptions-actions.ts`); if it comes back, the true count
// is unbounded and the read fails closed rather than silently truncating.
const MAX_RAW_OBSERVATIONS = 20_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const INTERVALS = new Set(["eod", "delayed", "intraday"]);

function localDate(now: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(
      parts.map((part) => [part.type, part.value]),
    );
    const result = `${values.year}-${values.month}-${values.day}`;
    if (!DATE.test(result)) throw new Error("invalid_local_date");
    return result;
  } catch {
    throw new Error("invalid_portfolio_timezone");
  }
}

type Row = Record<string, unknown>;

/** Validates a raw DB row into a `RawPricePoint`, or `null` if the row is
 * malformed -- an external-boundary read (AGENTS.md: validate `unknown` at
 * external boundaries), never trusted blindly even though ingestion should
 * already guarantee well-formed values. A `null` return is counted by the
 * caller as `excludedMalformedCount`, never silently dropped (F4). */
function mapRow(row: Row): RawPricePoint | null {
  const marketDate = String(row.market_date ?? "");
  const priceDecimal = String(row.close_decimal ?? "");
  const currencyCode = String(row.currency_code ?? "");
  const providerId = String(row.provider_id ?? "");
  const interval = String(row.interval ?? "");
  const observationAt = String(row.observation_at ?? "");
  if (
    !DATE.test(marketDate) ||
    !DECIMAL.test(priceDecimal) ||
    !currencyCode ||
    !providerId ||
    !INTERVALS.has(interval) ||
    !observationAt
  ) {
    return null;
  }
  return {
    marketDate,
    priceDecimal,
    currencyCode,
    providerId,
    interval: interval as RawPricePoint["interval"],
    observationAt,
  };
}

export type PriceHistoryPoint = Readonly<{
  date: string;
  priceDecimal: string;
  currencyCode: string;
  providerId: string;
  interval: "eod" | "delayed" | "intraday";
}>;

function toApiPoint(point: RawPricePoint): PriceHistoryPoint {
  return {
    date: point.marketDate,
    priceDecimal: point.priceDecimal,
    currencyCode: point.currencyCode,
    providerId: point.providerId,
    interval: point.interval,
  };
}

export type PriceHistoryProvenance = Readonly<{
  providers: readonly string[];
  fromDate: string | null;
  toDate: string | null;
  pointCountRaw: number;
  pointCountReturned: number;
  bucketSize: number;
  /** Rows in the query window carrying a DIFFERENT currency than the
   * holding's own identity currency -- excluded from the plotted series
   * rather than silently mixed onto one line (B1). */
  excludedCurrencyCount: number;
  /** Rows in the query window that failed row-shape validation (F4) --
   * counted, never silently dropped, mirroring MKT-008's malformed-row
   * disclosure discipline. */
  excludedMalformedCount: number;
  /** MKT-011B: today's intraday overlay's OWN exclusion counts -- kept
   * separate from `excludedCurrencyCount`/`excludedMalformedCount` above
   * because they describe a DIFFERENT read (`intraday_price_points`, a
   * single market day) rather than folding into the historical series'
   * counts and implying they came from the same query. */
  todayExcludedCurrencyCount: number;
  todayExcludedMalformedCount: number;
}>;

export type PriceHistorySuccess = Readonly<{
  ok: true;
  range: PriceHistoryRange;
  invalidRangeRequested: boolean;
  /** The holding's own identity currency (`securities.primary_currency_code`)
   * -- every plotted point and `latestDelayed` are in this currency. Always
   * resolved (the column is NOT NULL), never a per-row guess. */
  currencyCode: string;
  points: readonly PriceHistoryPoint[];
  provenance: PriceHistoryProvenance;
  latestDelayed: PriceHistoryPoint | null;
  /** MKT-011B: the security's OWN market-day date (its exchange
   * timezone -- `domain/market-data/daily-capture-window.ts`'s own
   * derivation, the SAME timezone source the capture/rollup sweep uses),
   * or `null` when that timezone cannot be resolved -- an honest "cannot
   * evaluate today for this security" state, never a guessed date. This
   * is DELIBERATELY separate from the range window's own "today" used
   * above (portfolio timezone, for day/week/ytd/... range math) -- the
   * intraday overlay must match the capture sweep's own notion of "today"
   * for this security, not the portfolio's. */
  todayMarketDate: string | null;
  /** MKT-011B: today's cached intraday ticks (`interval: 'intraday'`),
   * ordered by observation time ascending -- empty when nothing has been
   * captured yet today (market closed, capture not yet run, or the
   * source disabled all read identically as "nothing cached"; NEVER a
   * fabricated point). Dedupe ruling (TASKS.md MKT-011B): when this is
   * non-empty, any SAME-DATE historical winner is dropped from `points`
   * below so a transient daily-rollup-plus-not-yet-purged-intraday
   * overlap (a crash-recovery rollup racing this read, or the ordinary
   * end-of-day window between rollup and purge) never double-plots the
   * same day -- the intraday series is preferred as the more granular,
   * more current representation of today.
   */
  todayPoints: readonly PriceHistoryPoint[];
}>;

export type PriceHistoryFailure = Readonly<{
  ok: false;
  // Matches `app/portfolio-actions.ts`'s `ActionFailure` status union --
  // `getAuthenticatedSqlContext` is typed to that union even though only
  // 401/404/503 are reachable through the paths this module actually
  // exercises (400/409 are other actions' validation/version-conflict
  // statuses).
  status: 400 | 401 | 404 | 409 | 503;
  message: string;
}>;

export type PriceHistoryResult = PriceHistorySuccess | PriceHistoryFailure;

/** The owner-visible scope predicate `app/owned-holdings.ts` uses: rows
 * published deployment-wide, plus the CALLING owner's own user-scoped rows
 * -- never another user's user-scoped rows (F3 pins this with a fixture
 * row of user-b's user-scoped observation on user-a's own security_id). */
const SCOPE_PREDICATE =
  "((po.access_scope = 'deployment' AND po.scope_user_id IS NULL) OR (po.access_scope = 'user' AND po.scope_user_id = ?))";

type FetchedObservations = Readonly<{
  points: RawPricePoint[];
  excludedCurrencyCount: number;
  excludedMalformedCount: number;
}>;

async function fetchObservations(
  client: SqlClient,
  userId: string,
  securityId: string,
  currencyCode: string,
  extra: string,
  extraParams: readonly unknown[],
  limit: number,
): Promise<FetchedObservations | null> {
  const rows = await client.all<Row>(
    `SELECT po.market_date, po.close_decimal, po.currency_code, po.provider_id, po.interval, po.observation_at
     FROM price_observations po
     WHERE po.security_id = ?
       AND po.adjustment_state = 'raw'
       AND ${SCOPE_PREDICATE}
       ${extra}
     ORDER BY po.market_date ASC, po.observation_at ASC
     LIMIT ?`,
    [securityId, userId, ...extraParams, limit + 1],
  );
  if (rows.length > limit) return null; // unbounded -- caller fails closed
  const points: RawPricePoint[] = [];
  let excludedCurrencyCount = 0;
  let excludedMalformedCount = 0;
  for (const row of rows) {
    const point = mapRow(row);
    if (!point) {
      excludedMalformedCount += 1;
      continue;
    }
    // B1: constrain to the holding's own identity currency -- a
    // differently-denominated row sharing this security_id is real data,
    // just not plottable on the SAME line without lying about units.
    if (point.currencyCode !== currencyCode) {
      excludedCurrencyCount += 1;
      continue;
    }
    points.push(point);
  }
  return { points, excludedCurrencyCount, excludedMalformedCount };
}

export async function loadOwnedPriceHistory(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  portfolioSecurityId: string,
  rangeQuery: string | null,
  now = new Date(),
): Promise<PriceHistoryResult> {
  const portfolio = await client.get<Row>(
    `SELECT timezone FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolio) {
    return { ok: false, status: 404, message: "Portfolio was not found." };
  }
  const timezone = String(portfolio.timezone ?? "");

  // B1: resolve the holding's OWN identity currency the same way
  // `app/owned-holdings.ts` does (`securities.primary_currency_code`) so
  // the series is constrained to one unit, never mixed.
  const holding = await client.get<Row>(
    `SELECT ps.security_id AS security_id, s.primary_currency_code AS currency_code
     FROM portfolio_securities ps
     JOIN securities s ON s.id = ps.security_id
     WHERE ps.id = ? AND ps.user_id = ? AND ps.portfolio_id = ?
     LIMIT 1`,
    [portfolioSecurityId, userId, portfolioId],
  );
  if (!holding) {
    return { ok: false, status: 404, message: "That security was not found." };
  }
  const securityId = String(holding.security_id ?? "");
  const currencyCode = String(holding.currency_code ?? "");

  let todayLocal: string;
  try {
    todayLocal = localDate(now, timezone);
  } catch {
    return {
      ok: false,
      status: 503,
      message: "Portfolio timezone is unavailable.",
    };
  }

  const { range, invalidRangeRequested } =
    parsePriceHistoryRangeParam(rangeQuery);

  let fyStartMonth = DEFAULT_FY_START_MONTH;
  if (range === "fy") {
    const settings = await client.get<Row>(
      `SELECT financial_year_start_month FROM user_settings WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    const raw = settings?.financial_year_start_month;
    if (
      typeof raw === "number" &&
      Number.isInteger(raw) &&
      raw >= 1 &&
      raw <= 12
    ) {
      fyStartMonth = raw;
    }
  }
  const fyResult =
    range === "fy"
      ? currentFyWindow(now.toISOString(), fyStartMonth, timezone)
      : null;
  const window = priceHistoryWindow(range, todayLocal, fyResult);

  const extra = window.fromDate
    ? "AND po.market_date >= ? AND po.market_date <= ?"
    : "AND po.market_date <= ?";
  const extraParams = window.fromDate
    ? [window.fromDate, window.toDate]
    : [window.toDate];

  const windowed = await fetchObservations(
    client,
    userId,
    securityId,
    currencyCode,
    extra,
    extraParams,
    MAX_RAW_OBSERVATIONS,
  );
  if (windowed === null) {
    return {
      ok: false,
      status: 503,
      message:
        "This security has too much price history to chart safely for this range.",
    };
  }
  let winners = selectDailyWinners(windowed.points);
  let excludedCurrencyCount = windowed.excludedCurrencyCount;
  let excludedMalformedCount = windowed.excludedMalformedCount;

  // MKT-011B: resolve "today" for the INTRADAY overlay using the
  // SECURITY'S OWN market timezone (`exchanges.timezone`), the same
  // derivation `domain/market-data/daily-capture-window.ts` and the
  // capture/rollup sweep use -- deliberately NOT the portfolio timezone
  // `todayLocal` above (which only drives the range-window math). An
  // unresolvable timezone (no exchange linked) means "today" cannot be
  // evaluated for this security at all -- the overlay stays honestly
  // empty rather than guessing.
  const marketTimezones = await resolveSecurityMarketTimezones(client, [
    securityId,
  ]);
  const marketTimezone = marketTimezones.get(securityId) ?? null;
  const windowStatus = marketTimezone
    ? resolveDailyCaptureWindowStatus(now.toISOString(), marketTimezone)
    : null;
  const todayMarketDate = windowStatus?.localDate ?? null;

  const todayPoints: PriceHistoryPoint[] = [];
  let todayExcludedCurrencyCount = 0;
  let todayExcludedMalformedCount = 0;
  if (todayMarketDate) {
    const intraday = await listOwnedIntradayPricePointsForDate(client, {
      userId,
      securityId,
      marketDate: todayMarketDate,
    });
    // F5 (MKT-011B review follow-up): mirrors `windowed === null` below --
    // an unbounded row count fails the request closed rather than
    // silently truncating today's overlay.
    if (intraday === null) {
      return {
        ok: false,
        status: 503,
        message:
          "Today's intraday price cache has too many points to chart safely.",
      };
    }
    todayExcludedMalformedCount = intraday.excludedMalformedCount;
    for (const point of intraday.points) {
      // Same B1 discipline as the historical series: a row sharing this
      // security_id in a DIFFERENT currency is excluded, never mixed onto
      // one line.
      if (point.currencyCode !== currencyCode) {
        todayExcludedCurrencyCount += 1;
        continue;
      }
      todayPoints.push({
        date: point.marketDate,
        priceDecimal: point.priceDecimal,
        currencyCode: point.currencyCode,
        providerId: point.providerId,
        interval: "intraday",
      });
    }
  }

  // "Day" ruling (TASKS.md UI-018): a dailies-dominated series usually has
  // at most one point for "today" -- show the latest available point PLUS
  // the previous close for context, honest about sparsity, never a
  // fabricated second point. Only reached for `range === "day"`, and only
  // supplements when the single-day window did not already yield 2+ dates.
  if (range === "day" && winners.length < 2) {
    // Review round-2 follow-up: constrained to the SAME identity currency
    // (B1) -- otherwise the nearest EARLIER date found here could be one
    // where the only observation is off-currency, which `fetchObservations`
    // below would then filter down to nothing, silently reporting no
    // previous-close context even though an earlier same-currency date
    // genuinely exists further back.
    const priorDate = await client.get<Row>(
      `SELECT po.market_date AS market_date
       FROM price_observations po
       WHERE po.security_id = ?
         AND po.adjustment_state = 'raw'
         AND po.currency_code = ?
         AND ${SCOPE_PREDICATE}
         AND po.market_date < ?
       ORDER BY po.market_date DESC
       LIMIT 1`,
      [securityId, currencyCode, userId, window.toDate],
    );
    if (priorDate?.market_date) {
      const priorRows = await fetchObservations(
        client,
        userId,
        securityId,
        currencyCode,
        "AND po.market_date = ?",
        [String(priorDate.market_date)],
        50,
      );
      if (priorRows) {
        excludedCurrencyCount += priorRows.excludedCurrencyCount;
        excludedMalformedCount += priorRows.excludedMalformedCount;
        const priorWinners = selectDailyWinners(priorRows.points);
        winners = selectDailyWinners([...priorWinners, ...winners]);
      }
    }
  }

  // MKT-011B dedupe ruling: when today's intraday overlay has real data,
  // it wins the plot for that date -- drop any historical winner sharing
  // `todayMarketDate` so the chart never double-plots today (the ordinary
  // window between a successful rollup and its purge, or a crash-recovery
  // rollup racing this exact read, can otherwise leave a `price_observations`
  // row AND `intraday_price_points` rows coexisting briefly for the same
  // day). Chosen over an alternative "drop the intraday points instead"
  // because the intraday series is strictly MORE current and MORE granular
  // than the single rolled-up daily point it would otherwise duplicate.
  if (todayMarketDate && todayPoints.length > 0) {
    winners = winners.filter((point) => point.marketDate !== todayMarketDate);
  }

  const { points: downsampledRaw, bucketSize } =
    downsamplePriceHistoryPoints(winners);

  const providerSet = new Set(winners.map((point) => point.providerId));
  const provenance: PriceHistoryProvenance = {
    providers: [...providerSet].sort(),
    fromDate: winners[0]?.marketDate ?? null,
    toDate: winners[winners.length - 1]?.marketDate ?? null,
    pointCountRaw: winners.length,
    pointCountReturned: downsampledRaw.length,
    bucketSize,
    excludedCurrencyCount,
    excludedMalformedCount,
    todayExcludedCurrencyCount,
    todayExcludedMalformedCount,
  };

  const latestDelayedRow = await client.get<Row>(
    `SELECT po.market_date, po.close_decimal, po.currency_code, po.provider_id, po.interval, po.observation_at
     FROM price_observations po
     WHERE po.security_id = ?
       AND po.adjustment_state = 'raw'
       AND po.interval = 'delayed'
       AND po.currency_code = ?
       AND ${SCOPE_PREDICATE}
     ORDER BY po.observation_at DESC
     LIMIT 1`,
    [securityId, currencyCode, userId],
  );
  const latestDelayedPoint = latestDelayedRow ? mapRow(latestDelayedRow) : null;

  return {
    ok: true,
    range,
    invalidRangeRequested,
    currencyCode,
    points: downsampledRaw.map(toApiPoint),
    provenance,
    latestDelayed: latestDelayedPoint ? toApiPoint(latestDelayedPoint) : null,
    todayMarketDate,
    todayPoints,
  };
}

export type PriceHistoryActionResult = PriceHistoryResult;

/**
 * Route-facing entry point: resolves the authenticated context (dynamic
 * import mirrors `app/dividend-assumptions-actions.ts`'s
 * `authenticatedContext` -- `./portfolio-actions.ts` transitively imports
 * `next/headers`, which only resolves through vinext's bundler, not
 * Node's strict ESM loader under `node --test`) then delegates to the pure
 * `loadOwnedPriceHistory` above so tests can exercise the real logic
 * directly against a sqlite-backed `SqlClient` without that import.
 */
export async function priceHistoryAction(
  portfolioId: string,
  portfolioSecurityId: string,
  rangeQuery: string | null,
): Promise<PriceHistoryActionResult> {
  const { getAuthenticatedSqlContext } = await import("./portfolio-actions.ts");
  const context = await getAuthenticatedSqlContext(portfolioId);
  if (!context.ok) {
    return { ok: false, status: context.status, message: context.message };
  }
  return loadOwnedPriceHistory(
    context.client,
    context.userId,
    portfolioId,
    portfolioSecurityId,
    rangeQuery,
  );
}
