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
 * read and opportunistically persists exactly those
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
 * **CORRECTED by BUG-012 below**: an unresolvable date is now marked and
 * skipped rather than re-attempted forever -- see that entry.
 *
 * BUG-012 (2026-09-03, BUG-010 follow-up): the paragraph above described a
 * real hazard, not just an inefficiency -- BUG-010's own entry recorded
 * that a CONTIGUOUS run of unresolvable dates at least as long as one
 * call's bound pins that call's bounded slice in place PERMANENTLY
 * (`toDerive` keeps re-selecting the same unresolvable dates every call)
 * and starves every candidate date behind it; the read/cron sweeping from
 * opposite ends was a mitigation, not a fix (both ends could still stall).
 * `resolveValueHistorySeries` below now also loads
 * `db/repositories/portfolio-value-history.ts`'s
 * `portfolio_value_history_unresolvable` sibling table and excludes any
 * date already marked there from `missingDates` -- such a date can never
 * occupy a slot in a bounded slice again, closing the hazard by
 * construction rather than merely making it less likely. A date this call's
 * OWN derivation attempts (`toDerive`) and still cannot resolve is marked
 * immediately after (`recordUnresolvableValueHistoryDates`), categorised by
 * `computeUnresolvedReason` -- EXCEPT a date with ANY FX-caused missing
 * component (`'no_fx_rate'`), which is deliberately never persisted
 * (BUG-012 F2 and round-3 FU1 -- see that function's doc comment). This is a CACHED "not resolvable
 * as of the last attempt" fact, not a permanent write-off: see the
 * Invalidation paragraph below for why every write path that can make a
 * date newly resolvable also clears the mark, in the same atomic unit as
 * its existing `portfolio_value_history` invalidation. See db/schema.ts's
 * `portfolioValueHistoryUnresolvable` header comment for the full schema
 * design record (why a sibling table, not nullable columns).
 *
 * BUG-010 (owner-reported production OUTAGE, 2026-09-01): the paragraph
 * above describes the mechanism correctly, but its BOUND was ~10x the free
 * plan's per-invocation CPU allowance, which turned a wiped series into a
 * permanent Error 1102 loop -- the read could never finish deriving its
 * slice, so it never persisted one, so the next read repeated identically.
 * Two changes close that: `MAX_DERIVE_DATES_PER_READ` is now sized from a
 * re-measurement of the CURRENT code (see its own comment -- the
 * ~0.05ms/candidate-date figure `docs/ARCHITECTURE.md` §9.2 recorded does
 * not hold), and `backfillStoredValueHistoryForPortfolio` below lets the
 * hourly cron (`app/value-history-backfill-service.ts`) rebuild a wiped
 * series without any page load at all. Neither changes what is stored, what
 * is rendered, or the honesty invariant -- only how much of the rebuild one
 * invocation attempts.
 *
 * PRF-010 (production, measured, 2026-09-02; corrected 2026-09-02 after
 * review found the first version both under-detected staleness and
 * overstated the saving): once converged, that same cron kept paying the
 * full candidate-date scan on every tick with nothing left to derive --
 * 52,040 `rows_read`/tick, ~1.25M/day at 24 unconditional ticks.
 * `backfillStoredValueHistoryForPortfolio` now checks a convergence marker
 * (`db/repositories/portfolio-value-history.ts`) before that scan; see its
 * own doc comment for the measured before/after (a skipped tick still
 * costs ~2,600 `rows_read`, not free -- ~79% daily reduction once
 * `CONVERGENCE_RECHECK_INTERVAL_MS`'s periodic full checks are folded in)
 * and for exactly what the marker does and does NOT prove (it combines a
 * STORED-side snapshot with a CANDIDATE-side `MAX(market_date)` probe --
 * neither alone is sufficient, and even combined an interior candidate
 * addition is a known, accepted residual gap for which the recheck
 * interval is the PRIMARY cron-side backstop, not eliminated). This ONLY
 * changes the
 * CRON's own per-tick cost -- the read path above (and its
 * `MAX_DERIVE_DATES_PER_READ` bound) is untouched.
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
 * BUG-012 fold: all three shapes above ALSO clear the matching
 * `portfolio_value_history_unresolvable` rows, in the SAME atomic unit as
 * the DELETE they already issue -- a date this portfolio had marked
 * unresolvable is exactly the shape of stale fact each shape already exists
 * to correct (a new trade can turn "nothing held" into "held"; a price/FX
 * write can turn "no priceable security" into "priceable"). See
 * `db/repositories/portfolio-value-history.ts`'s own Invalidation section
 * header for the paired clear next to each shape.
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
  isFutureDate,
  type HistoricalPortfolioValuePoint,
  type HistoricalValueSecurityFact,
} from "../domain/snapshots/historical-portfolio-value.ts";
import type { LedgerQuantityFact } from "../domain/dividends/shares-held.ts";
import {
  CONVERGENCE_RECHECK_INTERVAL_MS,
  convergenceFingerprintMatches,
  deleteStoredValueHistoryInRangeForOwnedSecurity,
  loadPortfolioConvergenceMarker,
  loadStoredValueHistory,
  loadUnresolvableValueHistoryDates,
  loadValueHistoryConvergenceFingerprint,
  recordPortfolioConvergenceMarker,
  recordUnresolvableValueHistoryDates,
  upsertStoredValueHistory,
  type UnresolvableValueHistoryReason,
} from "../db/repositories/portfolio-value-history.ts";
import {
  assertOwnedPortfolioContext,
  type OwnedPortfolioContext,
} from "./owned-portfolio-context.ts";

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
/**
 * HIST-002: bounds how many MISSING (not-yet-stored) candidate dates one
 * READ will derive read-time before persisting -- the free-tier CPU-safety
 * lever (see this module header's HIST-002 paragraph).
 *
 * BUG-010 (owner-reported production OUTAGE, 2026-09-01): this was 400,
 * sized from `docs/ARCHITECTURE.md` §9.2's recorded ~0.05ms-per-candidate-
 * date figure (400 x 0.05ms ~= 20ms). BOTH halves of that arithmetic were
 * wrong for the current code, and the error was load-bearing:
 *
 * - RE-MEASURED for BUG-010 on the production-scale fixture this bound is
 *   sized against (18 securities, ~2,600 candidate dates, one EOD close per
 *   security per date -- `tests/bug-010.test.ts`'s own fixture), separating
 *   SQL-client time (D1 network wait in production, NOT Worker CPU) from
 *   app-side CPU: the derivation alone (`computeHistoricalPortfolioValueSeries`,
 *   the exact thing §9.2 measured) costs **~0.17ms per candidate date**, and
 *   the whole read-path slice -- price-row mapping/validation, the per-read
 *   index build, the upsert statements -- costs **~0.26ms per candidate
 *   date**, linear from 10 dates to 400. At 400 that is **~104ms of Worker
 *   CPU**, not 20ms.
 * - Cloudflare Workers FREE allows **10ms of CPU per invocation** (verified
 *   2026-09-01 against developers.cloudflare.com/workers/platform/limits/ --
 *   and the SAME 10ms applies to the Cron Trigger handler, see
 *   `app/value-history-backfill-service.ts`). The old bound was therefore
 *   ~10x over budget, not the ~2x §9.2's arithmetic implied.
 *
 * In steady state (0-3 missing dates) that never mattered. The moment an
 * import commit's ranged DELETE wiped the whole series, every read tried to
 * derive 400 dates, was killed at the CPU limit BEFORE `upsertStoredValueHistory`
 * committed, persisted nothing, and the next read repeated identically --
 * a loop that could not self-heal because escaping it cost more than the
 * budget that killed it.
 *
 * 10 dates ~= 2.6ms of MARGINAL app CPU (~4.4ms measured for a whole
 * derivation read at this scale, once the fixed cost of entering the
 * derivation path at all -- `loadFacts`' transaction/price marshalling and
 * the candidate-vs-stored diff -- is included; `tests/bug-010.test.ts` logs
 * that figure on every run). Roughly a quarter to a half of the free plan's
 * per-invocation allowance, leaving the rest of the Overview render its own
 * budget, while still covering the steady-state case (0-3 new trading days
 * per read, plus the intraday capture's re-derivation of TODAY's row) with
 * 3x headroom.
 *
 * Why 10 rather than 5 or 1: that per-read FIXED cost does not shrink with
 * the bound, so below roughly this size a smaller slice buys very little CPU
 * while proportionally slowing every rebuild. 10 sits near that knee.
 *
 * A wiped cache now rebuilds incrementally -- every read
 * derives its slice, PERSISTS it, and makes strictly forward progress --
 * with the hourly cron (`app/value-history-backfill-service.ts`) carrying
 * the bulk so recovery does not depend on the owner loading pages.
 *
 * Do NOT raise this without re-measuring: raising it back toward 400 is a
 * regression into the BUG-010 outage. Pinned by `tests/bug-010.test.ts`.
 */
export const MAX_DERIVE_DATES_PER_READ = 10;
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
 * ONE query set, not two divergent ones.
 *
 * PRF-003 (owner-reported slow tab navigation, "shortest 3 seconds and
 * longest 20 seconds" per tab change -- the confirmed 20-second outlier):
 * `priceWindows` optionally narrows ONLY the `price_observations`/
 * `fx_rate_observations` date bound below to something tighter than
 * `[rangeFrom, rangeTo]` -- `transactions` stay bound by the full
 * `rangeTo` regardless (computing shares held at a date genuinely needs
 * every prior transaction, however old). The graph loader below passes a
 * single-element array covering the exact span of the dates it is about to
 * derive (`toDerive`'s own min/max), since the series computation uses
 * exact-date (tolerance-0) price/FX lookups only -- a date outside that
 * span is NEVER consulted for ANY of `toDerive`'s points, so fetching it
 * wastes both D1 rows-read and Worker marshalling CPU for data that is
 * provably unused this call. This matters because the previous
 * unconditional `[rangeFrom, rangeTo]` window spans a portfolio's ENTIRE
 * multi-year history: after the daily cron price capture invalidates just
 * ONE day's stored `portfolio_value_history` row
 * (`invalidateStoredValueHistoryForSecurity`, called from the intraday/
 * Yahoo-compatible capture paths), the very next Overview load had exactly
 * ONE missing date but still paid for `loadFacts`'s full historical
 * `price_observations` read (tens of thousands of rows at the owner's real
 * scale) just to derive that single day -- the dominant cost behind the
 * reported multi-second outlier.
 *
 * PRF-005 (owner-reported Error 1102 on `/portfolio/:id/income`, the first
 * dividend tab): `loadHistoricalPortfolioValueAtDates` (Multi-Year FY-end
 * lookups, also consumed by the Income landing page's `pastFinancialYears`)
 * previously called this with NO window at all, defaulting to the FULL
 * `[rangeFrom, rangeTo]` span on EVERY call regardless of how few dates
 * (`yearsBack`, capped at 10) were requested -- the exact PRF-003 defect
 * class, just never fixed for this second caller (PRF-003's own comment
 * here explicitly deferred it as "not implicated in this task's reported
 * symptom", which stopped being true once the owner hit 1102 loading
 * `/income`). Each requested date only ever needs prices/FX within
 * `MULTI_YEAR_PRICE_TOLERANCE_DAYS` calendar days BEFORE it (never after --
 * the SAME backward-only window `computeHistoricalPortfolioValueAtDate`
 * itself consults via `candidatesWithinTolerance`), so `priceWindows` now
 * accepts MULTIPLE small windows, OR'd together in one query, letting the
 * FY-end caller pass one narrow window per requested date instead of one
 * window spanning its entire multi-year date range. An empty array (as
 * opposed to `undefined`) means "no rows needed" -- the price/FX queries
 * are skipped entirely (mirrors the existing `securityIds.length === 0`/
 * `currencyList.length === 0` short-circuits below) -- used when every
 * requested date falls outside `[rangeFrom, rangeTo]`. */
async function loadFacts(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  rangeFrom: string,
  rangeTo: string,
  priceWindows?: ReadonlyArray<{ from: string; to: string }>,
  // PRF-012: an optional, already-verified context (see
  // `resolveOwnedPortfolioContext`'s own doc comment) -- when supplied,
  // both reads below are skipped in favour of `context.portfolio`/
  // `context.identities` (ALL statuses, matching `securityRows`' own
  // unfiltered query -- a sold security can still be held ON a requested
  // past date). Callers must have already asserted this context belongs
  // to `userId`/`portfolioId` (`loadHistoricalPortfolioValueAtDates` does
  // this once, at its own entry point).
  context?: OwnedPortfolioContext,
): Promise<{
  baseCurrencyCode: string;
  timezone: string;
  securities: HistoricalValueSecurityFact[];
  fxObservations: FxObservation[];
  observedDates: string[];
} | null> {
  // `undefined` (not passed) means "the whole range" (the graph loader's
  // pre-PRF-003 behaviour, still the right default absent a narrower ask);
  // an explicit `[]` means "no rows needed at all" -- see this function's
  // PRF-005 doc comment above.
  const windows = priceWindows ?? [{ from: rangeFrom, to: rangeTo }];
  const priceOrFxWhereClause = (column: "po.market_date" | "fx.market_date") =>
    windows.map(() => `${column} BETWEEN ? AND ?`).join(" OR ");
  const windowParams = windows.flatMap((w) => [w.from, w.to]);
  // PRF-003: `portfolio` and `securityRows` are independent reads (neither's
  // SQL references the other) -- fetched concurrently rather than paying
  // two sequential round trips before this function even knows how many
  // securities it is dealing with.
  const [portfolio, securityRows]: [Row | undefined, Row[]] = context
    ? [
        {
          base_currency_code: context.portfolio.baseCurrencyCode,
          timezone: context.portfolio.timezone,
        },
        context.identities.map((identity): Row => ({
          portfolio_security_id: identity.id,
          security_id: identity.securityId,
          source_currency_code: identity.sourceCurrencyCode,
        })),
      ]
    : await Promise.all([
        client.get<Row>(
          `SELECT base_currency_code, timezone FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
          [portfolioId, userId],
        ),
        client.all<Row>(
          `SELECT ps.id AS portfolio_security_id, ps.security_id, ps.source_currency_code
       FROM portfolio_securities ps WHERE ps.user_id = ? AND ps.portfolio_id = ?
       ORDER BY ps.id LIMIT ?`,
          [userId, portfolioId, MAX_SECURITIES + 1],
        ),
      ]);
  if (!portfolio) return null;
  const baseCurrencyCode = String(portfolio.base_currency_code ?? "");
  const timezone = String(portfolio.timezone ?? "");
  if (!CURRENCY.test(baseCurrencyCode) || !timezone) return null;

  if (securityRows.length > MAX_SECURITIES)
    throw new Error("too_many_securities");
  const securityIds = securityRows
    .map((row) =>
      typeof row.security_id === "string" ? row.security_id : null,
    )
    .filter((id): id is string => id !== null);
  // Same predicate `foreignCurrencies` below (post-fetch) always used --
  // computed here, from `securityRows` alone, ONLY to decide whether the FX
  // query is worth issuing at all before `transactionRows`/`priceRows` (its
  // siblings in the wave below) have resolved.
  const foreignCurrenciesForQuery = new Set(
    securityRows
      .map((row) =>
        typeof row.source_currency_code === "string"
          ? row.source_currency_code
          : "",
      )
      .filter((currency) => currency && currency !== baseCurrencyCode),
  );

  // PRF-003: `transactionRows`, `priceRows`, and `fxRows` are three more
  // mutually independent reads -- `transactionRows` is scoped by
  // portfolioId/userId alone (never by `securityIds`), `priceRows` needs
  // only `securityIds` (resolved above), and `fxRows` needs only
  // `foreignCurrenciesForQuery` (also resolved above, from `securityRows`
  // directly -- it does NOT need `transactionRows`/`priceRows` to already
  // exist). Collapsed into one wave instead of three sequential round
  // trips.
  const currencyList = [...foreignCurrenciesForQuery];
  const [transactionRows, priceRows, rawFxRows] = await Promise.all([
    securityRows.length === 0
      ? Promise.resolve([] as Row[])
      : client.all<Row>(
          `SELECT t.id, t.portfolio_security_id, t.type, t.status, t.trade_at,
             t.local_trade_date, t.quantity_decimal, t.unit_price_decimal,
             t.reverses_transaction_id
           FROM transactions t WHERE t.user_id = ? AND t.portfolio_id = ?
             AND t.local_trade_date <= ?
           ORDER BY t.local_trade_date, t.trade_at, t.id LIMIT ?`,
          [userId, portfolioId, rangeTo, MAX_TRANSACTIONS + 1],
        ),
    securityIds.length === 0 || windows.length === 0
      ? Promise.resolve([] as Row[])
      : client.all<Row>(
          `SELECT po.* FROM price_observations po
           WHERE po.security_id IN (${securityIds.map(() => "?").join(",")})
             AND (${priceOrFxWhereClause("po.market_date")}) AND ${PRICE_SCOPE}
           ORDER BY po.security_id, po.market_date, po.observation_at, po.id
           LIMIT ?`,
          [...securityIds, ...windowParams, userId, MAX_PRICE_OBSERVATIONS + 1],
        ),
    currencyList.length === 0 || windows.length === 0
      ? Promise.resolve([] as Row[])
      : client.all<Row>(
          `SELECT fx.* FROM fx_rate_observations fx
           WHERE (${priceOrFxWhereClause("fx.market_date")})
             AND ((fx.base_currency_code = ? AND fx.quote_currency_code IN (${currencyList.map(() => "?").join(",")}))
               OR (fx.quote_currency_code = ? AND fx.base_currency_code IN (${currencyList.map(() => "?").join(",")})))
             AND ${FX_SCOPE}
           ORDER BY fx.market_date, fx.observed_at LIMIT ?`,
          [
            ...windowParams,
            baseCurrencyCode,
            ...currencyList,
            baseCurrencyCode,
            ...currencyList,
            userId,
            MAX_FX_OBSERVATIONS + 1,
          ],
        ),
  ]);
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
  if (rawFxRows.length > MAX_FX_OBSERVATIONS)
    throw new Error("too_many_fx_observations");
  const fxObservations: FxObservation[] = rawFxRows
    .map(mapFx)
    .filter((row): row is FxObservation => row !== null);

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
  // untouched by this decision. (`fxObservations` -- the FX read that would
  // otherwise sit here -- is already resolved above, in the same wave as
  // `transactionRows`/`priceRows`; see this function's PRF-003 comment.)

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
  // PRF-012: when supplied, `context.portfolio.timezone` replaces this
  // function's own `portfolios` read for that column -- ownership is
  // already verified by the caller (`loadHistoricalPortfolioValueAtDates`
  // asserts it once) -- so only the earliest-trade-date lookup against
  // `transactions` still needs to run.
  context?: OwnedPortfolioContext,
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
  // PRF-012: `context`, when supplied, already carries a verified
  // `timezone` -- only the earliest-trade-date lookup still needs to run,
  // scoped by `userId`/`portfolioId` directly (no `portfolios` join
  // needed; ownership was already asserted once by the caller).
  const row: Row | undefined = context
    ? await client.get<Row>(
        `SELECT t.local_trade_date AS earliest_trade_date FROM transactions t
         WHERE t.user_id = ? AND t.portfolio_id = ?
           AND t.status IN ('posted', 'reversed')
         ORDER BY t.local_trade_date ASC, t.id ASC LIMIT 1`,
        [userId, portfolioId],
      )
    : await client.get<Row>(
        `SELECT timezone,
       (SELECT t.local_trade_date FROM transactions t
        WHERE t.user_id = p.user_id AND t.portfolio_id = p.id
          AND t.status IN ('posted', 'reversed')
        ORDER BY t.local_trade_date ASC, t.id ASC LIMIT 1) AS earliest_trade_date
     FROM portfolios p WHERE p.id = ? AND p.user_id = ?`,
        [portfolioId, userId],
      );
  if (!context && !row) return null;
  const timezone = String(
    context ? context.portfolio.timezone : (row?.timezone ?? ""),
  );
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
    typeof row?.earliest_trade_date === "string"
      ? row.earliest_trade_date
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

/** PRF-002 (owner-reported production CPU-limit failure across every
 * authenticated page): `loadHistoricalPortfolioValueSeries` below used to
 * call `loadFacts` -- the FULL `transactions` + `price_observations` (every
 * column, every row, `mapPrice`-validated) + `fx_rate_observations` read --
 * unconditionally, on EVERY call, purely to compute `observedDates`. In the
 * overwhelmingly common STEADY-STATE case (the Overview page, since every
 * candidate date is already stored in `portfolio_value_history` from a
 * previous read), that entire read was immediately discarded: the
 * "`missingDates.length === 0`" fast path below never even looks at
 * `facts.securities`/`facts.fxObservations`. At the owner's real scale this
 * meant re-fetching and re-validating tens of thousands of
 * `price_observations` rows on every single Overview page load, for data
 * that was never used. This lighter query answers "which dates have price
 * data in range" -- the ONLY thing the fast path needs -- with a single
 * `DISTINCT market_date` read using the SAME security-id-scoped/`PRICE_SCOPE`
 * predicate `loadFacts`'s own price query uses (so it matches the identical
 * row set), without fetching or mapping any other column. The full,
 * unabridged `loadFacts` read still runs, unchanged, whenever there is
 * genuine derivation work to do (the slow path below). */
async function loadCandidateDates(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  rangeFrom: string,
  rangeTo: string,
): Promise<{ baseCurrencyCode: string; observedDates: string[] } | null> {
  const portfolio = await client.get<Row>(
    `SELECT base_currency_code, timezone FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolio) return null;
  const baseCurrencyCode = String(portfolio.base_currency_code ?? "");
  const timezone = String(portfolio.timezone ?? "");
  if (!CURRENCY.test(baseCurrencyCode) || !timezone) return null;

  const securityRows = await client.all<Row>(
    `SELECT ps.security_id FROM portfolio_securities ps
     WHERE ps.user_id = ? AND ps.portfolio_id = ? ORDER BY ps.id LIMIT ?`,
    [userId, portfolioId, MAX_SECURITIES + 1],
  );
  if (securityRows.length > MAX_SECURITIES)
    throw new Error("too_many_securities");
  const securityIds = securityRows
    .map((row) =>
      typeof row.security_id === "string" ? row.security_id : null,
    )
    .filter((id): id is string => id !== null);

  if (securityIds.length === 0) {
    return { baseCurrencyCode, observedDates: [] };
  }

  const dateRows = await client.all<Row>(
    `SELECT DISTINCT po.market_date FROM price_observations po
     WHERE po.security_id IN (${securityIds.map(() => "?").join(",")})
       AND po.market_date BETWEEN ? AND ? AND ${PRICE_SCOPE}
     ORDER BY po.market_date LIMIT ?`,
    [...securityIds, rangeFrom, rangeTo, userId, MAX_CANDIDATE_DATES + 1],
  );
  const observedDates = dateRows
    .map((row) =>
      typeof row.market_date === "string" && DATE.test(row.market_date)
        ? row.market_date
        : null,
    )
    .filter((date): date is string => date !== null);

  return { baseCurrencyCode, observedDates };
}

/**
 * PRF-010 ruling 1: the CANDIDATE-side half of the convergence fingerprint
 * (`db/repositories/portfolio-value-history.ts`'s own header comment has
 * the full record of why the stored-side snapshot alone is not enough).
 * `MAX(market_date)` over this portfolio's held securities'
 * `price_observations`, under the SAME `PRICE_SCOPE` predicate
 * `loadCandidateDates` uses -- deliberately NOT bounded by `rangeTo`, since
 * this is a fingerprint comparison, not a derivation input, and a bound
 * would only add a query parameter for no cost benefit.
 *
 * This is a genuine index seek, not `loadCandidateDates`'s full scan:
 * `price_observations_security_date_idx` is `(security_id, adjustment_state,
 * market_date)`, and SQLite applies its MIN/MAX optimization once per value
 * of the `security_id IN (...)` list (confirmed empirically -- this costs a
 * small constant multiple of the security count, not the ~46,800-row full
 * range scan `loadCandidateDates` pays for the SAME predicate once a
 * `market_date BETWEEN` bound is added). `null` only when the portfolio
 * holds no securities at all.
 *
 * Exported for `tests/prf-010.test.ts` only (to construct the same merged
 * fingerprint `backfillStoredValueHistoryForPortfolio` does) -- every real
 * caller reaches this through that function.
 */
export async function loadCandidateMaxDate(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<string | null> {
  const securityRows = await client.all<Row>(
    `SELECT ps.security_id FROM portfolio_securities ps
     WHERE ps.user_id = ? AND ps.portfolio_id = ? ORDER BY ps.id LIMIT ?`,
    [userId, portfolioId, MAX_SECURITIES + 1],
  );
  if (securityRows.length > MAX_SECURITIES)
    throw new Error("too_many_securities");
  const securityIds = securityRows
    .map((row) =>
      typeof row.security_id === "string" ? row.security_id : null,
    )
    .filter((id): id is string => id !== null);
  if (securityIds.length === 0) return null;

  const row = await client.get<Row>(
    `SELECT MAX(po.market_date) AS hi FROM price_observations po
     WHERE po.security_id IN (${securityIds.map(() => "?").join(",")})
       AND ${PRICE_SCOPE}`,
    [...securityIds, userId],
  );
  return typeof row?.hi === "string" && DATE.test(row.hi) ? row.hi : null;
}

/** Loads the full bounded value series for the graph -- one point per
 * distinct observation date in range, never a synthetic daily grid.
 *
 * HIST-002: candidate dates already present in `portfolio_value_history`
 * are served from that store directly (no derivation); the newest
 * `MAX_DERIVE_DATES_PER_READ` MISSING dates are derived read-time and
 * opportunistically persisted for next time -- see this module's header
 * comment for the full design record. PRF-002: which dates are even
 * "candidates" is now answered by the lightweight `loadCandidateDates`
 * above rather than the full `loadFacts` read -- see that function's doc
 * comment. */
export async function loadHistoricalPortfolioValueSeries(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now: Date = new Date(),
): Promise<HistoricalPortfolioValueResult | null> {
  const resolved = await resolveValueHistorySeries(
    client,
    userId,
    portfolioId,
    now,
    MAX_DERIVE_DATES_PER_READ,
    "newest",
  );
  return resolved ? resolved.result : null;
}

/** Which end of the still-missing candidate-date set one call's bounded
 * slice is taken from.
 *
 * BUG-010: the READ path takes `"newest"` (unchanged -- the dates an owner
 * is most likely looking at, and the same "keep the most recent" convention
 * `MAX_CANDIDATE_DATES` truncation uses). The CRON backfill takes
 * `"oldest"` deliberately, so the two sweep the missing set from OPPOSITE
 * ends and meet in the middle.
 *
 * That is not just load-sharing. Before BUG-012, a candidate date the
 * derivation genuinely could not resolve was NEVER stored (the honesty
 * invariant -- no fabricated or placeholder value, ever), so it stayed
 * "missing" forever and was re-attempted on every call. A contiguous run of
 * such dates that was at least as long as one call's bound therefore pinned
 * that call's slice in place permanently and starved every date behind it.
 * That property was pre-existing (it applied at the old 400 bound too, just
 * needing a 400-date run to trigger) but a smaller bound made a shorter run
 * sufficient, so the two sweeps were pointed at different ends: an
 * unresolvable run at one end could no longer block the other end's
 * progress. That was a mitigation, not a proof -- runs at BOTH ends could
 * still stall. Recorded in `docs/ARCHITECTURE.md`'s BUG-010 entry.
 *
 * **BUG-012 (2026-09-03) closes this by construction**: an unresolvable
 * date is now persisted as a fact
 * (`portfolio_value_history_unresolvable`, see this module's header) and
 * excluded from `missingDates`, so it can never occupy a slot in a bounded
 * slice again -- a contiguous unresolvable run of any length no longer
 * blocks progress from either end. This opposite-ends sweep remains
 * (load-sharing is still a real benefit), but is no longer load-bearing for
 * correctness the way it was before. */
export type ValueHistoryDeriveEnd = "newest" | "oldest";

/** What one bounded derive-and-persist slice actually did -- the cron's
 * progress signal (`app/value-history-backfill-service.ts`). `rowsPersisted`
 * is the EFF-001-guarded write count, so an unchanged re-derivation reports
 * 0 writes while still reporting the dates it derived. */
export type ValueHistoryBackfillOutcome = {
  /** Candidate dates in range this call considered. */
  candidateDates: number;
  /** Candidate dates not yet stored when this call started. */
  missingDates: number;
  /** Dates this call actually ran the derivation for (<= the bound). */
  datesDerived: number;
  /** Rows the derivation resolved a real value for and persisted. Fewer
   * than `datesDerived` when a date could not be resolved (never stored --
   * never fabricated) or when the value was unchanged. */
  rowsPersisted: number;
  /** At least one candidate date is still missing after this call. */
  backfillPending: boolean;
  /** PRF-010 ruling 3: `true` only on the cron's convergence-marker
   * shortcut (`backfillStoredValueHistoryForPortfolio`) -- this tick did
   * NOT run `loadCandidateDates` and every other field here is INFERRED
   * from the last full check's proof plus a fingerprint match, not
   * independently measured this tick. Omitted (never `false`) for every
   * outcome that ran the real check, so a log/consumer can tell "verified"
   * from "assumed still converged" apart at a glance. */
  skipped?: boolean;
};

/** BUG-012: categorizes WHY `computeHistoricalPortfolioValueSeries` could
 * not resolve a value for a date, from the same point it already returns --
 * see `domain/snapshots/historical-portfolio-value.ts`'s `valuePointAtDate`.
 * `heldSecurityCount === 0` means nothing was held on this date at all
 * (`'no_holdings'`, e.g. a candidate date before this portfolio's first
 * trade in a currently-held security); otherwise every held security failed
 * to resolve a price/FX within tolerance (`'no_priceable_security'`).
 * Diagnostic categorisation only -- both DB-persisted reasons are cleared
 * identically by every existing invalidation path.
 *
 * BUG-012 F2, Orchestrator ruling: a THIRD, IN-MEMORY-ONLY reason,
 * `'no_fx_rate'`, is never persisted to `portfolio_value_history_unresolvable`
 * -- see `computeUnresolvedReason`'s caller below. Unlike a missing security
 * price or holding gap, a missing FX rate is expected to fill in on the next
 * FX import/refresh -- and no FX write path invalidates that table at all --
 * so such a date must keep its pre-BUG-012 retry-on-every-read behaviour
 * rather than being written off.
 *
 * BUG-012 round-3 FU1 CORRECTION: the trigger is `fxMissingComponent` --
 * ANY held security whose failure was FX-caused -- not the round-2
 * "every held security's failure was FX" predicate. A MIXED date (one
 * unpriced base-currency security plus one FX-gapped foreign one) is
 * unresolvable for BOTH reasons at once; marking it `'no_priceable_security'`
 * meant the FX arrival could never clear it and a later price arrival for
 * the unpriced security would clear a mark on a date that is STILL FX-blocked.
 * Any FX-caused component therefore suppresses the mark entirely.
 *
 * This is a deliberate, disclosed residual: a genuinely FX-caused CONTIGUOUS
 * run (e.g. an outage in FX ingestion) can still pin a bounded slice exactly
 * as BUG-010 originally described, mitigated the same way -- opposite-end
 * sweeps -- see `docs/ARCHITECTURE.md` §9.8, which also records the standing
 * free-plan `rows_read` cost such a run carries. */
type UnresolvedReason = UnresolvableValueHistoryReason | "no_fx_rate";

function computeUnresolvedReason(
  point: HistoricalPortfolioValuePoint,
): UnresolvedReason {
  if (point.heldSecurityCount === 0) return "no_holdings";
  if (point.fxMissingComponent) return "no_fx_rate";
  return "no_priceable_security";
}

/**
 * BUG-010: the ONE bounded derive-and-persist mechanism, shared verbatim by
 * the Overview read (`loadHistoricalPortfolioValueSeries` above) and the
 * hourly cron backfill (`backfillStoredValueHistoryForPortfolio` below) --
 * deliberately not a second code path, and not a second formula. The two
 * callers differ ONLY in their bound and in which end of the missing set
 * they slice from.
 */
async function resolveValueHistorySeries(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now: Date,
  maxDeriveDates: number,
  deriveEnd: ValueHistoryDeriveEnd,
): Promise<{
  result: HistoricalPortfolioValueResult;
  outcome: ValueHistoryBackfillOutcome;
} | null> {
  const nowIso = now.toISOString();
  const range = await resolveRange(client, userId, portfolioId, nowIso);
  if (!range) return null;
  // PRF-003: `loadCandidateDates` and `loadStoredValueHistory` are
  // independent reads -- both are keyed only by `range.rangeFrom`/
  // `range.rangeTo` (already resolved above), neither consumes the other's
  // output (the "missing = candidate but not stored" comparison below reads
  // both results only AFTER they resolve) -- so they run concurrently
  // instead of as two sequential round trips. BUG-012: `loadUnresolvableValueHistoryDates`
  // joins the same concurrent group -- it is exactly as independent as
  // `loadStoredValueHistory` (same keys, same "read only, no derivation"
  // shape).
  const [candidates, stored, unresolvable] = await Promise.all([
    loadCandidateDates(
      client,
      userId,
      portfolioId,
      range.rangeFrom,
      range.rangeTo,
    ),
    loadStoredValueHistory(
      client,
      userId,
      portfolioId,
      range.rangeFrom,
      range.rangeTo,
      MAX_CANDIDATE_DATES + 1,
    ),
    loadUnresolvableValueHistoryDates(
      client,
      userId,
      portfolioId,
      range.rangeFrom,
      range.rangeTo,
      MAX_CANDIDATE_DATES + 1,
    ),
  ]);
  if (!candidates) return null;

  let dates = candidates.observedDates;
  // Review fold: the RANGE clamp (an earliest-trade date older than the
  // 10-year floor) truncates just as honestly as a candidate-date COUNT
  // overflow does -- both mean real history exists that this read did not
  // fetch.
  let datesTruncated = range.rangeClamped;
  if (dates.length > MAX_CANDIDATE_DATES) {
    datesTruncated = true;
    dates = dates.slice(dates.length - MAX_CANDIDATE_DATES); // keep the MOST RECENT dates
  }

  // BUG-012: a date already marked "attempted, genuinely unresolvable" is
  // excluded here -- never re-attempted just because it is still not
  // `stored` -- which is exactly the structural fix for the stall hazard
  // this task exists to close (a contiguous unresolvable run can no longer
  // pin a bounded slice, because such dates never occupy a slot in it).
  const missingDates = dates.filter(
    (date) => !stored.has(date) && !unresolvable.has(date),
  );

  if (missingDates.length === 0) {
    // Fully backfilled for this range (or every remaining candidate date is
    // marked unresolvable): the trivial bounded-read fast path HIST-002
    // exists for -- no shares/price/FX derivation, and (PRF-002) no full
    // `price_observations` read, at all. A date that is unresolvable rather
    // than stored has no row in `stored` -- filtered out here, so it is
    // simply absent from `points` (the same honest-gap shape every other
    // "not derived this call" date already renders), never a fabricated or
    // null-valued placeholder entry.
    const points = dates
      .filter((date) => stored.has(date))
      .map((date) => stored.get(date)!);
    return {
      result: {
        baseCurrencyCode: candidates.baseCurrencyCode,
        rangeFrom: range.rangeFrom,
        rangeTo: range.rangeTo,
        points,
        datesTruncated,
        backfillPending: false,
      },
      outcome: {
        candidateDates: dates.length,
        missingDates: 0,
        datesDerived: 0,
        rowsPersisted: 0,
        backfillPending: false,
      },
    };
  }

  // `dates`/`missingDates` are ascending, so the TAIL is the newest and the
  // HEAD is the oldest. The read path slices the newest (the range an owner
  // is most likely viewing, matching MAX_CANDIDATE_DATES' own "keep the most
  // recent" convention); BUG-010's cron backfill slices the oldest -- see
  // `ValueHistoryDeriveEnd`.
  const toDerive =
    missingDates.length > maxDeriveDates
      ? deriveEnd === "newest"
        ? missingDates.slice(-maxDeriveDates)
        : missingDates.slice(0, maxDeriveDates)
      : missingDates;
  const backfillPending = toDerive.length < missingDates.length;

  // PRF-002: only NOW -- once real derivation work is known to exist --
  // does this pay for the full `transactions`/`price_observations`/
  // `fx_rate_observations` read. PRF-003: the price/FX portion of that read
  // is further narrowed to `toDerive`'s own span (`priceWindow` below) --
  // see `loadFacts`'s own doc comment for why this is safe (exact-date-only
  // lookups) and why it is the fix for the reported multi-second-outlier
  // tab-navigation regression. `toDerive` is ascending (a contiguous slice
  // of the ascending `missingDates`, from either end), so its first/last
  // elements are its min/max.
  const facts = await loadFacts(
    client,
    userId,
    portfolioId,
    range.rangeFrom,
    range.rangeTo,
    [{ from: toDerive[0]!, to: toDerive[toDerive.length - 1]! }],
  );
  if (!facts) return null;

  const derived = computeHistoricalPortfolioValueSeries({
    baseCurrencyCode: facts.baseCurrencyCode,
    portfolioTimezone: facts.timezone,
    now: nowIso,
    dates: toDerive,
    securities: facts.securities,
    fxObservations: facts.fxObservations,
  });
  const persisted = await upsertStoredValueHistory(client, {
    userId,
    portfolioId,
    points: derived,
    now: nowIso,
  });
  // BUG-012: every date this call attempted (`toDerive`) that came back
  // with a `null` valueDecimal is genuinely unresolvable AS OF THIS
  // ATTEMPT -- record it so it is never re-attempted until a write path
  // that already invalidates this portfolio's value history (a ledger
  // mutation, a price/FX import, a rollup) clears the mark. `toDerive`
  // already excludes previously-marked dates (via `missingDates` above),
  // so this only ever writes NEW marks or refreshes one just cleared and
  // retried -- never the same mark on every read.
  //
  // BUG-012 F2, corrected by round-3 FU1: a date with ANY FX-caused
  // missing component (`computeUnresolvedReason` returning the in-memory-
  // only `'no_fx_rate'`) is deliberately EXCLUDED here -- never persisted
  // -- so it keeps retrying on every read/cron call until the FX rate
  // arrives, rather than being written off. A MIXED date (an unpriced
  // base-currency security AND an FX-gapped foreign one) counts as
  // FX-caused for this purpose, because the FX half can never be repaired
  // by a mark-clearing write. See `computeUnresolvedReason`'s doc comment
  // for the Orchestrator ruling and the disclosed residual.
  //
  // BUG-012 review follow-up: a FUTURE-dated candidate (`isFutureDate`,
  // the same guard `computeHistoricalPortfolioValueSeries` itself uses to
  // short-circuit to an honest `null` point) is also excluded -- it is
  // "not yet due", not genuinely unresolvable, and nothing invalidates a
  // mark on it just because time passes and the date stops being in the
  // future.
  const unresolvedNow = derived
    .filter(
      (point) =>
        point.valueDecimal === null && !isFutureDate(point.date, nowIso),
    )
    .map((point) => ({ point, reason: computeUnresolvedReason(point) }))
    .filter(
      (
        entry,
      ): entry is {
        point: HistoricalPortfolioValuePoint;
        reason: UnresolvableValueHistoryReason;
      } => entry.reason !== "no_fx_rate",
    );
  if (unresolvedNow.length > 0) {
    await recordUnresolvableValueHistoryDates(client, {
      userId,
      portfolioId,
      points: unresolvedNow.map(({ point, reason }) => ({
        date: point.date,
        reason,
        fingerprint: `held=${point.heldSecurityCount};priced=${point.pricedSecurityCount}`,
      })),
      now: nowIso,
    });
  }
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
    result: {
      baseCurrencyCode: facts.baseCurrencyCode,
      rangeFrom: range.rangeFrom,
      rangeTo: range.rangeTo,
      points,
      datesTruncated,
      backfillPending,
    },
    outcome: {
      candidateDates: dates.length,
      missingDates: missingDates.length,
      datesDerived: toDerive.length,
      // `written` is the honest progress signal: this call only ever derives
      // dates that were MISSING, so every resolvable one is an INSERT. A
      // derived date absent from this count is one the derivation could not
      // resolve -- never stored, never fabricated (the honesty invariant).
      rowsPersisted: persisted.written,
      backfillPending,
    },
  };
}

/**
 * BUG-010 part (b): one bounded derive-and-persist slice for ONE portfolio,
 * driven by the hourly cron rather than by a page load, so a wiped
 * `portfolio_value_history` recovers without the owner repeatedly loading
 * the Overview. Thin wrapper over the SAME `resolveValueHistorySeries` the
 * read path uses -- same candidate-date resolution, same derivation, same
 * honesty invariant, same owner scoping (`userId` is supplied by the sweep
 * from `portfolios.user_id`'s own authoritative column, never a
 * client-supplied id) -- differing only in the bound and in slicing the
 * OLDEST missing dates instead of the newest (see `ValueHistoryDeriveEnd`).
 *
 * PRF-010 (production, measured): every tick, for every portfolio, this used
 * to run `loadCandidateDates`'s full `DISTINCT market_date` seek over
 * `price_observations` (~47k index entries at the owner's real 18-security
 * scale) even after that portfolio's series had fully converged --
 * 52,040 `rows_read`/tick, ~1.25M/day if every tick paid it (see
 * `tests/prf-010.test.ts`'s measurement; the fingerprint check that now
 * short-circuits this is itself ~2,600 `rows_read`, not free). Before
 * paying for that scan, this now checks
 * `db/repositories/portfolio-value-history.ts`'s convergence marker -- a
 * fingerprint combining a snapshot of `portfolio_value_history` (the STORED
 * side) with `loadCandidateMaxDate` below (the CANDIDATE side), taken the
 * last time a full check proved zero candidate dates were missing. A match
 * (and a fresh-enough `CONVERGENCE_RECHECK_INTERVAL_MS`) skips the scan
 * entirely; anything else -- no marker, a stale one, or a mismatched
 * fingerprint -- falls through to the same full check as before. See that
 * module's own doc comment for exactly what this fingerprint does and does
 * NOT prove -- in particular, an interior candidate addition (a backdated
 * price-history import introducing dates that were never priced before) is
 * NOT detected by the fingerprint at all; `CONVERGENCE_RECHECK_INTERVAL_MS`
 * is that residue's primary backstop on the cron side.
 *
 * The marker is written ONLY when `missingDates === 0` from the very first
 * look this tick (never merely because a tick exhausted its derive budget
 * over dates that turned out unresolvable this tick).
 *
 * **CORRECTED by BUG-012 (2026-09-03)**: before that task, a portfolio with
 * even one permanently-unresolvable candidate date (BUG-010 follow-up (e)'s
 * territory) could never satisfy `missingDates === 0` at all -- an
 * unresolvable date was never stored, so it was always counted as missing,
 * and the portfolio kept paying for, and kept LOGGING, the full check and
 * its `datesDerived > 0`/`rowsPersisted === 0` tell on every tick forever.
 * BUG-012 excludes a MARKED-unresolvable date from `missingDates`, so such
 * a portfolio now CAN converge and record this marker once every remaining
 * candidate date is either stored or marked unresolvable -- this is the
 * intended fix for the stall hazard, not a regression of it. The
 * convergence fingerprint (`ValueHistoryConvergenceFingerprint`) folds in
 * `portfolio_value_history_unresolvable`'s own row count/`MAX(attempted_at)`
 * specifically so that a later CLEARED mark (a newly-resolvable date)
 * un-converges the marker rather than leaving it stale.
 *
 * Returns `null` for a portfolio this owner does not have (the same
 * fail-closed shape every read here uses), never a thrown error for a
 * missing row.
 */
export async function backfillStoredValueHistoryForPortfolio(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  maxDeriveDates: number,
  now: Date = new Date(),
): Promise<ValueHistoryBackfillOutcome | null> {
  if (!Number.isInteger(maxDeriveDates) || maxDeriveDates <= 0) return null;

  const marker = await loadPortfolioConvergenceMarker(
    client,
    userId,
    portfolioId,
  );
  // Guard against a negative age: a future-dated `verifiedAt` (clock skew,
  // or a hand-edited row) must fall through to the full check rather than
  // being treated as "just verified" by an unguarded `<` comparison. A
  // malformed `verified_at` already fails open via `Date.parse`'s `NaN`
  // (any comparison against `NaN` is `false`) -- that stays unchanged.
  const markerAgeMs = marker
    ? now.getTime() - Date.parse(marker.verifiedAt)
    : NaN;
  if (
    marker &&
    markerAgeMs >= 0 &&
    markerAgeMs < CONVERGENCE_RECHECK_INTERVAL_MS
  ) {
    const [storedFingerprint, candidateMaxDate] = await Promise.all([
      loadValueHistoryConvergenceFingerprint(client, userId, portfolioId),
      loadCandidateMaxDate(client, userId, portfolioId),
    ]);
    const fingerprint = { ...storedFingerprint, candidateMaxDate };
    if (convergenceFingerprintMatches(marker, fingerprint)) {
      return {
        candidateDates: fingerprint.rowCount,
        missingDates: 0,
        datesDerived: 0,
        rowsPersisted: 0,
        backfillPending: false,
        skipped: true,
      };
    }
  }

  const resolved = await resolveValueHistorySeries(
    client,
    userId,
    portfolioId,
    now,
    maxDeriveDates,
    "oldest",
  );
  if (!resolved) return null;
  if (resolved.outcome.missingDates === 0) {
    const [storedFingerprint, candidateMaxDate] = await Promise.all([
      loadValueHistoryConvergenceFingerprint(client, userId, portfolioId),
      loadCandidateMaxDate(client, userId, portfolioId),
    ]);
    await recordPortfolioConvergenceMarker(
      client,
      userId,
      portfolioId,
      { ...storedFingerprint, candidateMaxDate },
      now.toISOString(),
    );
  }
  return resolved.outcome;
}

/** Values a SMALL, caller-specific set of dates (Multi-Year's FY-end dates,
 * also consumed by the Income landing page's `pastFinancialYears`) against
 * the SAME bounded fact set/derivation as the graph above -- one
 * derivation, two call shapes. Unlike the graph (exact-date only), these
 * lookups use `MULTI_YEAR_PRICE_TOLERANCE_DAYS` (review B3 ruling: the
 * last observation on-or-before the date within a bounded 7-calendar-day
 * lookback, covering a weekend/holiday landing exactly on an FY end).
 * A requested date outside [rangeFrom, rangeTo] (older than the range this
 * read bothered to fetch prices for) is honestly reported as a gap rather
 * than silently re-querying an unbounded window per date.
 *
 * PRF-005 (owner-reported Error 1102 on `/portfolio/:id/income`): `loadFacts`
 * below now receives one narrow `{from, to}` window PER in-range requested
 * date (each `MULTI_YEAR_PRICE_TOLERANCE_DAYS` wide, matching the exact
 * backward-only tolerance `computeHistoricalPortfolioValueAtDate` applies)
 * instead of the entire `[boundedRangeFrom, range.rangeTo]` span -- see
 * `loadFacts`'s own PRF-005 doc comment. At `yearsBack` <= 10 this is at
 * most 10 tiny windows, versus the portfolio's entire multi-year
 * `price_observations` history every single call. */
export async function loadHistoricalPortfolioValueAtDates(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  requestedDates: readonly string[],
  now: Date = new Date(),
  // PRF-012: an optional, pre-resolved `{userId, portfolio, settings,
  // identities}` a page-level caller resolved ONCE and threads through
  // here instead of paying this function's (and its internal
  // `resolveRange`/`loadFacts` helpers') own portfolio/`portfolio_securities`
  // reads again. `undefined` (every existing caller, unchanged by
  // omission) self-loads exactly as before. Asserted below, never trusted
  // blindly.
  context?: OwnedPortfolioContext,
): Promise<Map<string, HistoricalPortfolioValuePoint> | null> {
  if (context) assertOwnedPortfolioContext(context, userId, portfolioId);
  const validDates = [...new Set(requestedDates.filter((d) => DATE.test(d)))];
  if (validDates.length === 0) return new Map();
  const nowIso = now.toISOString();
  const sortedRequested = [...validDates].sort();
  const range = await resolveRange(
    client,
    userId,
    portfolioId,
    nowIso,
    context,
  );
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
  //
  // PRF-005: one narrow window per IN-RANGE requested date (see this
  // function's own PRF-005 doc comment above) -- a date already known to
  // fall outside `[boundedRangeFrom, range.rangeTo]` gets no window at all
  // (it is reported as an honest gap in the loop below without ever
  // touching `facts`), matching that same `date < boundedRangeFrom || date
  // > range.rangeTo` condition exactly.
  //
  // PRF-005 review F1 (honesty-material behavior change, documented rather
  // than silently shipped): a window's `from` here can land BELOW
  // `boundedRangeFrom` for a date sitting AT (or just above) the 10-year
  // clamp floor -- `subtractDaysForWidening` subtracts
  // `MULTI_YEAR_PRICE_TOLERANCE_DAYS` MORE calendar days below whatever
  // `boundedRangeFrom` already clamped to, same as the `earliestRequested`
  // widening above does for the overall range. The OLD unconditional
  // `[boundedRangeFrom, range.rangeTo]` read could never see a price that
  // far below the floor (it was excluded by the read's own outer bound);
  // this per-date window CAN, and correctly resolves a floor-adjacent date
  // that the old read reported as an honest gap even when a real,
  // in-tolerance price existed just below the floor. This is MORE correct
  // (never fabricates; simply stops manufacturing an artificial gap the
  // tolerance rule would otherwise resolve), not a regression -- but is a
  // real, previously-undocumented behavior change; see
  // `docs/ARCHITECTURE.md`'s dated PRF-005/F1 correction note and
  // `tests/prf-002.test.ts`'s dedicated clamp-floor regression test.
  const priceWindows = validDates
    .filter((date) => date >= boundedRangeFrom && date <= range.rangeTo)
    .map((date) => ({
      from: subtractDaysForWidening(date, MULTI_YEAR_PRICE_TOLERANCE_DAYS),
      to: date,
    }));
  const facts = await loadFacts(
    client,
    userId,
    portfolioId,
    boundedRangeFrom,
    range.rangeTo,
    priceWindows,
    context,
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
