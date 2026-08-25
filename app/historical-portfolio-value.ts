/**
 * HIST-001: owner-scoped, READ-ONLY, bounded read of historical portfolio
 * value, computed READ-TIME from `price_observations`/ledger facts rather
 * than the CALC-003/CALC-004 persisted `portfolio_daily_snapshots` pipeline
 * -- see `domain/snapshots/historical-portfolio-value.ts`'s header for the
 * full architecture decision and `docs/ARCHITECTURE.md`'s HIST-001 entry.
 *
 * This module ONLY reads (`client.all`/`client.get`); it never calls
 * `client.run`/`client.batch`, so no D1 write budget is ever spent serving
 * a view (pinned by tests/hist-001.test.ts's source-regex test). Every
 * query is bounded with an explicit LIMIT and the MAX+1 fail-closed pattern
 * (`app/owned-price-history.ts`'s precedent: ask for one row past the cap;
 * if it comes back, the true count is unbounded and the read fails closed
 * rather than silently truncating). Owner-scoped: every query is
 * parameterized by the CALLING user's id, never a client-supplied one --
 * pinned by tests/hist-001.test.ts's cross-owner denial tests.
 *
 * Provider scope (review B2a): `PRICE_SCOPE` below matches
 * `app/owned-holdings.ts`'s CURRENT-value read exactly (every
 * owner-visible provider, Sharesight included) -- NOT the sibling
 * persisted-snapshot pipeline's BRK-012C EOD-only exclusion. See
 * `PRICE_SCOPE`'s own comment for why that distinction matters.
 *
 * Measured read budget (review fold; see `docs/ARCHITECTURE.md` §9.1 and
 * tests/hist-001.test.ts's B1 compute-bound pin for the full record): an
 * Overview load for an 18-security, ~1,500-shared-trading-date portfolio
 * measured 27,036 total rows across securities/transactions/price/fx --
 * against D1's free-tier ~5M rows/day read allowance that is ~185 such
 * loads per day of headroom, comfortably above a single owner's real usage
 * pattern.
 *
 * BUG-002 owner ruling: this feature is SECURITIES-ONLY -- `loadFacts`
 * below deliberately never reads `cash_accounts`/`cash_ledger_entries` --
 * see `domain/snapshots/historical-portfolio-value.ts`'s header for the
 * full record (an earlier version replayed cash the same way it replays
 * share transactions, which surfaced a real data-quality problem: the
 * owner's actual cash ledger has no reliable opening balance).
 *
 * HIST-002 (owner ruling, 2026-08-25 -- "go" on persist-once + incremental):
 * `loadHistoricalPortfolioValueSeries` now consults `portfolio_value_history`
 * (db/repositories/portfolio-value-history.ts) before deriving anything --
 * a candidate date already stored is served from that trivial bounded read
 * (no shares/price/FX derivation at all). The read-time derivation above
 * remains the ONE formula and stays the fallback/verifier for whatever is
 * NOT yet stored: the bounded backfill-on-read logic INLINE in
 * `loadHistoricalPortfolioValueSeries` below derives up to
 * `MAX_DERIVE_DATES_PER_READ` of the newest MISSING candidate dates per
 * read (bounded compute, "tens of ms" per Layer 1's ~0.05ms/candidate-date
 * measurement on the real DB copy -- see TASKS.md's HIST-002 entry for the
 * full before/after numbers) and opportunistically persists exactly those
 * freshly-derived points (EFF-001-style identical-value guard: an unchanged
 * re-derivation writes zero rows). Any STILL-missing dates beyond that
 * bound are simply absent from this read's `points` -- never a fabricated
 * or null-value placeholder, the SAME "date not a candidate" shape this
 * feature already uses for genuine gaps; `backfillPending` discloses the
 * fact honestly rather than silently. This is how a brand-new portfolio's
 * ~1,700-candidate-date backfill (see the HIST-002 entry's measured count)
 * completes over several reads, newest dates first (matching
 * `MAX_CANDIDATE_DATES` truncation's existing "keep the most recent"
 * convention), while every read's OWN derivation cost stays bounded --
 * unlike `MAX_CANDIDATE_DATES` truncation this is NOT a permanent limit:
 * once a date is stored it stays stored, subject to invalidation (see
 * below). Review fold: "fully backfilled never re-derives" is NOT a
 * universal guarantee -- a date the derivation genuinely cannot resolve
 * (`valueDecimal: null`) is NEVER stored (the honesty invariant), so it is
 * always "missing" and gets a cheap, bounded, single-date re-derivation
 * attempt on every subsequent read until it genuinely resolves.
 *
 * Invalidation (review B2, BLOCKING -- a stored row is a CACHE, and a cache
 * that never invalidates is a correctness bug, not a performance feature):
 * three write paths can make a stored row wrong, all fixed in this task --
 * (1) a price-history import touching a past date
 * (`invalidateStoredValueHistoryForSecurity` below, wired into
 * `app/price-upload-service.ts`'s MKT-008/MKT-020 confirm paths); (2) a
 * ledger mutation (a back-dated buy, a reversal, a superseding edit) that
 * changes shares-held from some date forward
 * (`db/repositories/ledger.ts`'s `persist`, and
 * `db/repositories/import-commit.ts`'s `finalize` for the ledger-CSV commit
 * path -- both delete every stored row from the earliest affected
 * `local_trade_date` onward, via
 * `db/repositories/portfolio-value-history.ts`'s
 * `valueHistoryInvalidationFromDateStatement`, in the SAME atomic batch as
 * the mutation itself); (3) a non-CSV price writer
 * (`db/repositories/market-data-refresh.ts`'s Yahoo-compatible rollup,
 * `db/repositories/intraday-price-capture.ts`'s MKT-011A capture) landing a
 * fresher price for a security/date already stored (via that same module's
 * `buildValueHistoryInvalidationStatementsForSecurities`). See each site's own
 * doc comment for exactly what "affected" means there.
 *
 * Recorded follow-up (deliberately NOT solved by this task -- review B2):
 * `loadFacts`'s `PRICE_SCOPE` predicate does not filter by `interval`, so a
 * `delayed`/`intraday` price observation participates in this derivation
 * exactly like an `eod` one (matching `app/owned-holdings.ts`'s CURRENT-
 * value read, per the B2a decision above). Combined with invalidation (3),
 * this means TODAY's stored point can be invalidated and re-derived
 * multiple times as intraday ticks accrete through the day, converging on
 * whatever was captured LAST before the next read -- never a fabricated or
 * stale value, but also never a considered "which intraday tick should
 * TODAY's stored point reflect" decision. Whether the store should exclude
 * `delayed`/`intraday` rows entirely (matching the OTHER persisted
 * pipeline's BRK-012C EOD-only exclusion) is a real open product question,
 * not addressed here.
 *
 * Multi-Year's FY-end lookups (`loadHistoricalPortfolioValueAtDates`) use a
 * DIFFERENT, non-zero `priceToleranceDays` (see that function's own doc
 * comment) -- a value the tolerance-0 stored table CANNOT answer from a
 * nearby stored date, ever (different securities can each resolve their OWN
 * nearest-within-tolerance price on a DIFFERENT calendar date, so no single
 * stored aggregate row is equivalent -- proven, and reproduced: an earlier
 * version of this function consulted the store for an EXACT date match
 * before falling back to the tolerance-7 derivation, which review B1 found
 * silently serves the tolerance-0 stored value whenever a candidate date
 * happens to exist exactly on the FY-end date -- UNDER-counting held
 * securities priced only in the preceding week, reproduced as a 3x
 * understatement and a complete->partial->unavailable flip on real fixture
 * data. That store consult is REMOVED: `loadHistoricalPortfolioValueAtDates`
 * never reads `portfolio_value_history` at all -- the tolerance-7 read-time
 * derivation is the SOLE authority for every FY-end value, always. At ~10
 * dates/read this costs negligible CPU, so there is no efficiency reason to
 * risk the correctness bug.
 */
import type { SqlClient } from "../db/repositories/sql-client.ts";
import type {
  FxObservation,
  PriceObservation,
} from "../domain/market-data/contracts.ts";
import {
  computeHistoricalPortfolioValueAtDate,
  computeHistoricalPortfolioValueSeries,
  type HistoricalPortfolioValuePoint,
  type HistoricalValueSecurityFact,
} from "../domain/snapshots/historical-portfolio-value.ts";
import type { LedgerQuantityFact } from "../domain/dividends/shares-held.ts";
import {
  deleteStoredValueHistoryInRangeForOwnedSecurity,
  loadStoredValueHistory,
  upsertStoredValueHistory,
} from "../db/repositories/portfolio-value-history.ts";

// Bounds, documented (free-plan READ discipline -- this feature performs no
// writes at all, so the binding budget is D1's per-request statement/row
// practicality, not the 100k-rows/day WRITE cap that HIST-001's persisted
// alternative would have had to reckon with).
const MAX_SECURITIES = 500;
const MAX_TRANSACTIONS = 20_000;
// One security's own daily-close history can be ~7,300 raw days (UI-018's
// real 28-year fixture); a whole PORTFOLIO's price rows across many
// securities scales with security count, hence the higher cap than
// `app/owned-price-history.ts`'s single-security 20,000.
const MAX_PRICE_OBSERVATIONS = 120_000;
const MAX_FX_OBSERVATIONS = 20_000;
// Bounds the number of distinct DATES actually valued (and so the CPU cost
// of the pure per-date derivation) -- matches `MAX_OVERVIEW_HISTORY_POINTS`'s
// existing ~10-year/3,660-point precedent (`app/authenticated-workspace.ts`'s
// sibling Overview read). When the union of observation dates exceeds this,
// the OLDEST dates are dropped first (the most recent history is the one
// the chart/Multi-Year baseline actually need); `datesTruncated` discloses
// this honestly rather than silently.
const MAX_CANDIDATE_DATES = 3_660;
// HIST-002: bounds how many MISSING (not-yet-stored) candidate dates one
// read will derive read-time before persisting -- the free-tier CPU-safety
// lever (see this module header's HIST-002 paragraph). Chosen from Layer
// 1's measured ~0.05ms-per-candidate-date compute cost on the real DB copy
// (18 securities, ~2,600 candidate dates): 400 * 0.05ms ~= 20ms, a "tens of
// ms" bound with headroom under this request's other work, while a fully
// backfilled/steady-state portfolio (the overwhelmingly common case after
// the first several reads) skips derivation ENTIRELY via the stored-only
// fast path below.
const MAX_DERIVE_DATES_PER_READ = 400;
// Review B3 ruling: Multi-Year's FY-end lookups may use the last
// observation on-or-before the FY end within this bounded lookback --
// covers a weekend/holiday landing exactly on an FY-end date; beyond it,
// honestly unavailable. The Overview graph does NOT use this (it passes
// `priceToleranceDays: 0` -- exact-date only, unchanged).
const MULTI_YEAR_PRICE_TOLERANCE_DAYS = 7;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Pure calendar-day subtraction for widening a read window's lower bound
 * (never used for the actual per-observation tolerance lookup -- that
 * lives in `domain/snapshots/historical-portfolio-value.ts`'s own
 * `subtractCalendarDays`). Malformed input passes through unchanged. */
function subtractDaysForWidening(date: string, days: number): string {
  const match = DATE_PARTS.exec(date);
  if (!match) return date;
  const [, year, month, day] = match;
  const ms =
    Date.UTC(Number(year), Number(month) - 1, Number(day)) - days * 86_400_000;
  const result = new Date(ms);
  return `${String(result.getUTCFullYear()).padStart(4, "0")}-${String(
    result.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(result.getUTCDate()).padStart(2, "0")}`;
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CURRENCY = /^[A-Z]{3}$/;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

type Row = Record<string, unknown>;

/** Owner-visible scope predicate -- deployment rows plus the CALLING
 * owner's own user-scoped rows, never another user's (identical predicate
 * to `app/owned-price-history.ts`/`app/owned-holdings.ts`). Review B2a
 * (BLOCKING correction): this MUST match `app/owned-holdings.ts`'s own
 * CURRENT-value scope -- every owner-visible provider, Sharesight
 * INCLUDED -- not the sibling persisted-snapshot pipeline's BRK-012C
 * EOD-only exclusion. An earlier version of this predicate excluded
 * `provider_id = 'sharesight'` "to keep EOD semantics", which produced
 * up-to-$48k phantom step-downs on dates only a Sharesight quote existed
 * and a ~$47k disagreement against the CURRENT-value figure on the SAME
 * screen -- two conventions for "this security's price on this date"
 * disagreeing is exactly the bug this module exists to prevent. `raw`
 * `adjustment_state` stays (owned-holdings.ts filters it identically;
 * split/total-return-adjusted rows are a different, not-yet-used series). */
const PRICE_SCOPE =
  "po.adjustment_state = 'raw' AND " +
  "((po.access_scope = 'deployment' AND po.scope_user_id IS NULL) OR (po.access_scope = 'user' AND po.scope_user_id = ?))";
const FX_SCOPE =
  "(fx.access_scope = 'deployment' AND fx.scope_user_id IS NULL) OR (fx.access_scope = 'user' AND fx.scope_user_id = ?)";

function mapTransaction(row: Row): LedgerQuantityFact | null {
  const id = row.id;
  const type = row.type;
  const status = row.status;
  const localTradeDate = row.local_trade_date;
  const tradeAt = row.trade_at;
  if (
    typeof id !== "string" ||
    typeof type !== "string" ||
    (status !== "posted" && status !== "reversed") ||
    typeof localTradeDate !== "string" ||
    !DATE.test(localTradeDate) ||
    typeof tradeAt !== "string"
  ) {
    return null;
  }
  return {
    id,
    type,
    status,
    localTradeDate,
    tradeAt,
    quantityDecimal:
      typeof row.quantity_decimal === "string" ? row.quantity_decimal : null,
    unitPriceDecimal:
      typeof row.unit_price_decimal === "string"
        ? row.unit_price_decimal
        : null,
    reversesTransactionId:
      typeof row.reverses_transaction_id === "string"
        ? row.reverses_transaction_id
        : null,
  };
}

function mapPrice(row: Row): PriceObservation | null {
  const marketDate = row.market_date;
  const closeDecimal = row.close_decimal;
  const currencyCode = row.currency_code;
  const providerId = row.provider_id;
  const observationAt = row.observation_at;
  const interval = row.interval;
  const quality = row.quality;
  const adjustmentState = row.adjustment_state;
  if (
    typeof marketDate !== "string" ||
    !DATE.test(marketDate) ||
    typeof closeDecimal !== "string" ||
    !DECIMAL.test(closeDecimal) ||
    typeof currencyCode !== "string" ||
    !CURRENCY.test(currencyCode) ||
    typeof providerId !== "string" ||
    typeof observationAt !== "string" ||
    !ISO.test(observationAt) ||
    (interval !== "eod" && interval !== "delayed" && interval !== "intraday") ||
    (quality !== "observed" &&
      quality !== "corrected" &&
      quality !== "indicative" &&
      quality !== "stale_candidate") ||
    (adjustmentState !== "raw" &&
      adjustmentState !== "split_adjusted" &&
      adjustmentState !== "total_return_adjusted")
  ) {
    return null;
  }
  return {
    kind: "price",
    providerId,
    providerRevisionId:
      typeof row.provider_revision_id === "string"
        ? row.provider_revision_id
        : null,
    mappingId: typeof row.mapping_id === "string" ? row.mapping_id : "",
    securityId: typeof row.security_id === "string" ? row.security_id : "",
    scope:
      row.access_scope === "user"
        ? { kind: "user", userId: String(row.scope_user_id ?? "") }
        : { kind: "deployment", userId: null },
    interval,
    observationAt,
    marketDate,
    marketTimezone:
      typeof row.market_timezone === "string" ? row.market_timezone : "",
    currencyCode,
    closeDecimal,
    previousCloseDecimal:
      typeof row.previous_close_decimal === "string"
        ? row.previous_close_decimal
        : null,
    adjustmentState,
    adjustmentFactor: null,
    quality,
    delayedMinutes:
      typeof row.delayed_minutes === "number" ? row.delayed_minutes : null,
    ingestedAt: typeof row.ingested_at === "string" ? row.ingested_at : "",
    payloadSha256:
      typeof row.payload_sha256 === "string" ? row.payload_sha256 : null,
  };
}

function mapFx(row: Row): FxObservation | null {
  const marketDate = row.market_date;
  const rateDecimal = row.rate_decimal;
  const baseCurrencyCode = row.base_currency_code;
  const quoteCurrencyCode = row.quote_currency_code;
  const observedAt = row.observed_at;
  const interval = row.interval;
  const quality = row.quality;
  if (
    typeof marketDate !== "string" ||
    !DATE.test(marketDate) ||
    typeof rateDecimal !== "string" ||
    !DECIMAL.test(rateDecimal) ||
    typeof baseCurrencyCode !== "string" ||
    !CURRENCY.test(baseCurrencyCode) ||
    typeof quoteCurrencyCode !== "string" ||
    !CURRENCY.test(quoteCurrencyCode) ||
    typeof observedAt !== "string" ||
    !ISO.test(observedAt) ||
    (interval !== "eod" && interval !== "delayed" && interval !== "intraday") ||
    (quality !== "observed" &&
      quality !== "corrected" &&
      quality !== "indicative" &&
      quality !== "stale_candidate")
  ) {
    return null;
  }
  return {
    kind: "fx",
    providerId: typeof row.provider_id === "string" ? row.provider_id : "",
    providerRevisionId:
      typeof row.provider_revision_id === "string"
        ? row.provider_revision_id
        : null,
    scope:
      row.access_scope === "user"
        ? { kind: "user", userId: String(row.scope_user_id ?? "") }
        : { kind: "deployment", userId: null },
    baseCurrencyCode,
    quoteCurrencyCode,
    rateDecimal,
    interval,
    observedAt,
    marketDate,
    quality,
    delayedMinutes:
      typeof row.delayed_minutes === "number" ? row.delayed_minutes : null,
    ingestedAt: typeof row.ingested_at === "string" ? row.ingested_at : "",
    payloadSha256:
      typeof row.payload_sha256 === "string" ? row.payload_sha256 : null,
  };
}

export type HistoricalPortfolioValueResult = {
  baseCurrencyCode: string;
  rangeFrom: string;
  rangeTo: string;
  points: readonly HistoricalPortfolioValuePoint[];
  /** `true` when more distinct observation dates existed than
   * `MAX_CANDIDATE_DATES` could hold -- the oldest dates were dropped, kept
   * most-recent-first; disclosed rather than silently thinned. */
  datesTruncated: boolean;
  /** HIST-002: `true` when at least one candidate date within range has NOT
   * yet been derived+stored (this read's `MAX_DERIVE_DATES_PER_READ` bound
   * was hit) -- those dates are simply absent from `points` this time, and
   * will appear once a later read's bounded backfill reaches them (newest
   * dates first). Disclosed honestly rather than silently thinning the
   * series the way `datesTruncated` already is. */
  backfillPending: boolean;
};

/** Bounded owner-scoped read of every fact this feature needs, shared by
 * both the graph loader and the Multi-Year FY-end loader below so there is
 * ONE query set, not two divergent ones. */
async function loadFacts(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  rangeFrom: string,
  rangeTo: string,
): Promise<{
  baseCurrencyCode: string;
  timezone: string;
  securities: HistoricalValueSecurityFact[];
  fxObservations: FxObservation[];
  observedDates: string[];
} | null> {
  const portfolio = await client.get<Row>(
    `SELECT base_currency_code, timezone FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolio) return null;
  const baseCurrencyCode = String(portfolio.base_currency_code ?? "");
  const timezone = String(portfolio.timezone ?? "");
  if (!CURRENCY.test(baseCurrencyCode) || !timezone) return null;

  const securityRows = await client.all<Row>(
    `SELECT ps.id AS portfolio_security_id, ps.security_id, ps.source_currency_code
     FROM portfolio_securities ps WHERE ps.user_id = ? AND ps.portfolio_id = ?
     ORDER BY ps.id LIMIT ?`,
    [userId, portfolioId, MAX_SECURITIES + 1],
  );
  if (securityRows.length > MAX_SECURITIES)
    throw new Error("too_many_securities");
  const securityIds = securityRows
    .map((row) =>
      typeof row.security_id === "string" ? row.security_id : null,
    )
    .filter((id): id is string => id !== null);

  const transactionRows =
    securityRows.length === 0
      ? []
      : await client.all<Row>(
          `SELECT t.id, t.portfolio_security_id, t.type, t.status, t.trade_at,
             t.local_trade_date, t.quantity_decimal, t.unit_price_decimal,
             t.reverses_transaction_id
           FROM transactions t WHERE t.user_id = ? AND t.portfolio_id = ?
             AND t.local_trade_date <= ?
           ORDER BY t.local_trade_date, t.trade_at, t.id LIMIT ?`,
          [userId, portfolioId, rangeTo, MAX_TRANSACTIONS + 1],
        );
  if (transactionRows.length > MAX_TRANSACTIONS)
    throw new Error("too_many_transactions");
  const transactionsBySecurity = new Map<string, LedgerQuantityFact[]>();
  for (const row of transactionRows) {
    const mapped = mapTransaction(row);
    if (!mapped) continue;
    const portfolioSecurityId = row.portfolio_security_id;
    if (typeof portfolioSecurityId !== "string") continue;
    const list = transactionsBySecurity.get(portfolioSecurityId) ?? [];
    list.push(mapped);
    transactionsBySecurity.set(portfolioSecurityId, list);
  }

  const priceRows =
    securityIds.length === 0
      ? []
      : await client.all<Row>(
          `SELECT po.* FROM price_observations po
           WHERE po.security_id IN (${securityIds.map(() => "?").join(",")})
             AND po.market_date BETWEEN ? AND ? AND ${PRICE_SCOPE}
           ORDER BY po.security_id, po.market_date, po.observation_at, po.id
           LIMIT ?`,
          [
            ...securityIds,
            rangeFrom,
            rangeTo,
            userId,
            MAX_PRICE_OBSERVATIONS + 1,
          ],
        );
  if (priceRows.length > MAX_PRICE_OBSERVATIONS)
    throw new Error("too_many_price_observations");
  const pricesBySecurity = new Map<string, PriceObservation[]>();
  const observedDateSet = new Set<string>();
  for (const row of priceRows) {
    const mapped = mapPrice(row);
    if (!mapped) continue;
    const list = pricesBySecurity.get(mapped.securityId) ?? [];
    list.push(mapped);
    pricesBySecurity.set(mapped.securityId, list);
    observedDateSet.add(mapped.marketDate);
  }

  const securities: HistoricalValueSecurityFact[] = securityRows.map((row) => {
    const portfolioSecurityId = String(row.portfolio_security_id ?? "");
    const securityId =
      typeof row.security_id === "string" ? row.security_id : null;
    return {
      portfolioSecurityId,
      currencyCode: String(row.source_currency_code ?? ""),
      transactions: transactionsBySecurity.get(portfolioSecurityId) ?? [],
      priceObservations: securityId
        ? (pricesBySecurity.get(securityId) ?? [])
        : [],
    };
  });

  // BUG-002 owner ruling: `cash_accounts`/`cash_ledger_entries` are
  // deliberately NOT read here -- this feature is securities-only (see this
  // module's header). The cash ledger itself, `app/owned-holdings.ts`'s
  // `loadCash`, and every other current-value consumer are unaffected and
  // untouched by this decision.
  const foreignCurrencies = new Set(
    securities
      .map((security) => security.currencyCode)
      .filter((currency) => currency && currency !== baseCurrencyCode),
  );
  let fxObservations: FxObservation[] = [];
  if (foreignCurrencies.size > 0) {
    const currencyList = [...foreignCurrencies];
    const fxRows = await client.all<Row>(
      `SELECT fx.* FROM fx_rate_observations fx
       WHERE fx.market_date BETWEEN ? AND ?
         AND ((fx.base_currency_code = ? AND fx.quote_currency_code IN (${currencyList.map(() => "?").join(",")}))
           OR (fx.quote_currency_code = ? AND fx.base_currency_code IN (${currencyList.map(() => "?").join(",")})))
         AND ${FX_SCOPE}
       ORDER BY fx.market_date, fx.observed_at LIMIT ?`,
      [
        rangeFrom,
        rangeTo,
        baseCurrencyCode,
        ...currencyList,
        baseCurrencyCode,
        ...currencyList,
        userId,
        MAX_FX_OBSERVATIONS + 1,
      ],
    );
    if (fxRows.length > MAX_FX_OBSERVATIONS)
      throw new Error("too_many_fx_observations");
    fxObservations = fxRows
      .map(mapFx)
      .filter((row): row is FxObservation => row !== null);
  }

  return {
    baseCurrencyCode,
    timezone,
    securities,
    fxObservations,
    observedDates: [...observedDateSet].sort(),
  };
}

/** The bounded RANGE (earliest trade date through today, capped) this
 * feature values within -- shares its shape with
 * `db/repositories/snapshots.ts`'s `computeSnapshotRunRange` conceptually,
 * but this module intentionally does not import it (a different pipeline;
 * see this module's header) and needs no `history_complete_from` clamp
 * since this read never writes/publishes a durable range claim. */
async function resolveRange(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now: string,
): Promise<{
  rangeFrom: string;
  rangeTo: string;
  /** `true` when the TRUE earliest-trade-derived `rangeFrom` was pulled
   * forward by the `MAX_CANDIDATE_DATES`-derived 10-year floor -- review
   * fold: this must feed `datesTruncated` too, not just an overflow of the
   * candidate-date COUNT (a portfolio whose earliest trade predates the
   * 10-year floor never even gets a chance to read that older history's
   * price rows in the first place). */
  rangeClamped: boolean;
} | null> {
  const portfolio = await client.get<Row>(
    `SELECT timezone,
       (SELECT t.local_trade_date FROM transactions t
        WHERE t.user_id = p.user_id AND t.portfolio_id = p.id
          AND t.status IN ('posted', 'reversed')
        ORDER BY t.local_trade_date ASC, t.id ASC LIMIT 1) AS earliest_trade_date
     FROM portfolios p WHERE p.id = ? AND p.user_id = ?`,
    [portfolioId, userId],
  );
  if (!portfolio) return null;
  const timezone = String(portfolio.timezone ?? "");
  let rangeTo: string;
  try {
    rangeTo = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(now));
  } catch {
    rangeTo = now.slice(0, 10);
  }
  if (!DATE.test(rangeTo)) rangeTo = now.slice(0, 10);
  const earliestTradeDate =
    typeof portfolio.earliest_trade_date === "string"
      ? portfolio.earliest_trade_date
      : null;
  let rangeFrom =
    earliestTradeDate && DATE.test(earliestTradeDate)
      ? earliestTradeDate
      : rangeTo;
  const earliestAllowedMs =
    Date.parse(`${rangeTo}T00:00:00Z`) - (MAX_CANDIDATE_DATES - 1) * 86_400_000;
  const earliestAllowed = Number.isFinite(earliestAllowedMs)
    ? new Date(earliestAllowedMs).toISOString().slice(0, 10)
    : rangeFrom;
  let rangeClamped = false;
  if (rangeFrom < earliestAllowed) {
    rangeFrom = earliestAllowed;
    rangeClamped = true;
  }
  if (rangeFrom > rangeTo) rangeFrom = rangeTo;
  return { rangeFrom, rangeTo, rangeClamped };
}

/** Loads the full bounded value series for the graph -- one point per
 * distinct observation date in range, never a synthetic daily grid.
 *
 * HIST-002: candidate dates already present in `portfolio_value_history`
 * are served from that store directly (no derivation); the newest
 * `MAX_DERIVE_DATES_PER_READ` MISSING dates are derived read-time and
 * opportunistically persisted for next time -- see this module's header
 * comment for the full design record. */
export async function loadHistoricalPortfolioValueSeries(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now: Date = new Date(),
): Promise<HistoricalPortfolioValueResult | null> {
  const nowIso = now.toISOString();
  const range = await resolveRange(client, userId, portfolioId, nowIso);
  if (!range) return null;
  const facts = await loadFacts(
    client,
    userId,
    portfolioId,
    range.rangeFrom,
    range.rangeTo,
  );
  if (!facts) return null;

  let dates = facts.observedDates;
  // Review fold: the RANGE clamp (an earliest-trade date older than the
  // 10-year floor) truncates just as honestly as a candidate-date COUNT
  // overflow does -- both mean real history exists that this read did not
  // fetch.
  let datesTruncated = range.rangeClamped;
  if (dates.length > MAX_CANDIDATE_DATES) {
    datesTruncated = true;
    dates = dates.slice(dates.length - MAX_CANDIDATE_DATES); // keep the MOST RECENT dates
  }

  const stored = await loadStoredValueHistory(
    client,
    userId,
    portfolioId,
    range.rangeFrom,
    range.rangeTo,
    MAX_CANDIDATE_DATES + 1,
  );
  const missingDates = dates.filter((date) => !stored.has(date));

  if (missingDates.length === 0) {
    // Fully backfilled for this range: the trivial bounded-read fast path
    // HIST-002 exists for -- no shares/price/FX derivation at all.
    const points = dates.map((date) => stored.get(date)!);
    return {
      baseCurrencyCode: facts.baseCurrencyCode,
      rangeFrom: range.rangeFrom,
      rangeTo: range.rangeTo,
      points,
      datesTruncated,
      backfillPending: false,
    };
  }

  // Newest-missing-first (dates/missingDates are ascending, so the tail is
  // the newest) -- matches MAX_CANDIDATE_DATES' own "keep the most recent"
  // convention and prioritises the range an owner is most likely viewing.
  const toDerive =
    missingDates.length > MAX_DERIVE_DATES_PER_READ
      ? missingDates.slice(-MAX_DERIVE_DATES_PER_READ)
      : missingDates;
  const backfillPending = toDerive.length < missingDates.length;

  const derived = computeHistoricalPortfolioValueSeries({
    baseCurrencyCode: facts.baseCurrencyCode,
    portfolioTimezone: facts.timezone,
    now: nowIso,
    dates: toDerive,
    securities: facts.securities,
    fxObservations: facts.fxObservations,
  });
  await upsertStoredValueHistory(client, {
    userId,
    portfolioId,
    points: derived,
    now: nowIso,
  });
  const derivedByDate = new Map(derived.map((point) => [point.date, point]));

  const points: HistoricalPortfolioValuePoint[] = [];
  for (const date of dates) {
    const storedPoint = stored.get(date);
    if (storedPoint) {
      points.push(storedPoint);
      continue;
    }
    const derivedPoint = derivedByDate.get(date);
    if (derivedPoint) points.push(derivedPoint);
    // else: beyond this read's derive bound -- honestly absent, see
    // `backfillPending`.
  }

  return {
    baseCurrencyCode: facts.baseCurrencyCode,
    rangeFrom: range.rangeFrom,
    rangeTo: range.rangeTo,
    points,
    datesTruncated,
    backfillPending,
  };
}

/** Values a SMALL, caller-specific set of dates (Multi-Year's FY-end dates)
 * against the SAME bounded fact set/derivation as the graph above -- one
 * derivation, two call shapes. Unlike the graph (exact-date only), these
 * lookups use `MULTI_YEAR_PRICE_TOLERANCE_DAYS` (review B3 ruling: the
 * last observation on-or-before the date within a bounded 7-calendar-day
 * lookback, covering a weekend/holiday landing exactly on an FY end).
 * A requested date outside [rangeFrom, rangeTo] (older than the range this
 * read bothered to fetch prices for) is honestly reported as a gap rather
 * than silently re-querying an unbounded window per date. */
export async function loadHistoricalPortfolioValueAtDates(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  requestedDates: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, HistoricalPortfolioValuePoint> | null> {
  const validDates = [...new Set(requestedDates.filter((d) => DATE.test(d)))];
  if (validDates.length === 0) return new Map();
  const nowIso = now.toISOString();
  const sortedRequested = [...validDates].sort();
  const range = await resolveRange(client, userId, portfolioId, nowIso);
  if (!range) return null;
  // Widen the read window (never narrow it) so an FY-end date older than
  // the range's own earliest-trade-derived floor still gets its own facts
  // read -- capped by the SAME MAX_CANDIDATE_DATES-derived floor as
  // `resolveRange` uses, so a pathological request still cannot force an
  // unbounded read. ALSO widened by `MULTI_YEAR_PRICE_TOLERANCE_DAYS` past
  // the earliest requested date (review fold) -- otherwise a lookback
  // candidate sitting just before the earliest FY-end date would never
  // even be fetched, silently truncating the tolerance window this
  // function promises `computeHistoricalPortfolioValueAtDate`.
  const earliestRequested = subtractDaysForWidening(
    sortedRequested[0]!,
    MULTI_YEAR_PRICE_TOLERANCE_DAYS,
  );
  const rangeFrom =
    earliestRequested < range.rangeFrom ? earliestRequested : range.rangeFrom;
  const earliestAllowedMs =
    Date.parse(`${range.rangeTo}T00:00:00Z`) -
    (MAX_CANDIDATE_DATES - 1) * 86_400_000;
  const earliestAllowed = Number.isFinite(earliestAllowedMs)
    ? new Date(earliestAllowedMs).toISOString().slice(0, 10)
    : rangeFrom;
  const boundedRangeFrom =
    rangeFrom < earliestAllowed ? earliestAllowed : rangeFrom;

  // HIST-002/review B1 (BLOCKING correction): this loader deliberately does
  // NOT consult `portfolio_value_history` at all, ever -- see this module's
  // header for the reproduced correctness bug an earlier "exact stored
  // match" shortcut caused (a stored tolerance-0 row can UNDER-count a
  // tolerance-7 answer, silently, whenever a candidate date happens to
  // exist exactly on the FY-end date). The read-time tolerance-7
  // derivation below is the SOLE authority for every FY-end value.
  const facts = await loadFacts(
    client,
    userId,
    portfolioId,
    boundedRangeFrom,
    range.rangeTo,
  );
  if (!facts) return null;

  const result = new Map<string, HistoricalPortfolioValuePoint>();
  for (const date of validDates) {
    if (date < boundedRangeFrom || date > range.rangeTo) {
      result.set(date, {
        date,
        valueDecimal: null,
        completeness: "partial",
        heldSecurityCount: 0,
        pricedSecurityCount: 0,
      });
      continue;
    }
    result.set(
      date,
      computeHistoricalPortfolioValueAtDate({
        baseCurrencyCode: facts.baseCurrencyCode,
        portfolioTimezone: facts.timezone,
        now: nowIso,
        securities: facts.securities,
        fxObservations: facts.fxObservations,
        date,
        priceToleranceDays: MULTI_YEAR_PRICE_TOLERANCE_DAYS,
      }),
    );
  }
  return result;
}

/**
 * HIST-002 invalidation (the CALC-005 requeue-gap lesson, applied here):
 * called from `app/price-upload-service.ts`'s MKT-008/MKT-020 confirm paths
 * immediately after a price-history write touches `dates` for `securityId`.
 * DELETES the corresponding `portfolio_value_history` rows for every
 * owner-scoped portfolio that holds this security, one ranged
 * `value_date BETWEEN MIN(dates) AND MAX(dates)` DELETE per portfolio
 * (review B2 follow-up 5: a single ranged delete, not one chunked DELETE
 * per ~50 dates -- a few untouched dates inside that span may be
 * conservatively invalidated too, which is safe: they are cheaply
 * re-derived, and the EFF-001 guard makes an unchanged re-derivation a
 * zero-write no-op). Deliberately does NOT recompute anything itself: a
 * deleted row is indistinguishable from a never-backfilled one to
 * `loadHistoricalPortfolioValueSeries`'s existing bounded backfill-on-read
 * path, which re-derives it the next time that portfolio's history is
 * actually read -- so invalidation never needs a second, parallel
 * recompute implementation.
 *
 * Owner-scoped: `securityId` alone is never trusted to imply ownership --
 * only portfolios belonging to `userId` are touched (matches every other
 * query in this module) -- see
 * `deleteStoredValueHistoryInRangeForOwnedSecurity`'s own doc comment.
 */
export async function invalidateStoredValueHistoryForSecurity(
  client: SqlClient,
  userId: string,
  securityId: string,
  dates: readonly string[],
): Promise<{ portfoliosInvalidated: number; rowsDeleted: number }> {
  const validDates = [...new Set(dates.filter((d) => DATE.test(d)))].sort();
  if (validDates.length === 0)
    return { portfoliosInvalidated: 0, rowsDeleted: 0 };
  return deleteStoredValueHistoryInRangeForOwnedSecurity(
    client,
    userId,
    securityId,
    validDates[0]!,
    validDates[validDates.length - 1]!,
  );
}
