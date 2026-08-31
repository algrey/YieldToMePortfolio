// DIV-003: owner-scoped, READ-ONLY retirement-income projection service.
// Composes holdings value (`app/owned-holdings.ts`), dividend history/
// forecast (`app/owned-dividend-history.ts`, DIV-001), owner assumptions
// (`db/repositories/dividends.ts`), and historical portfolio value
// (`db/repositories/snapshots.ts`) into the pure `domain/dividends/projection.ts`
// (DIV-003) functions. Every actual projection/aggregation RULE lives in
// that pure domain module; this file only fetches owner-scoped facts and
// calls it -- mirrors `app/owned-dividend-history.ts`'s own split between
// I/O and derivation. DIV-009: the per-security trailing yield feeding the
// assumption grid is resolved from each security's ALREADY-COMPUTED
// `forecast.ttmPerShareDecimal`/`ttmSource` (DIV-001's `loadOwnedDividendHistory`
// already ran `computeSecurityDividendForecast` with this portfolio's
// provider `dividend_events` AND its imported dividend history --
// `domain/market-data/dividend-yield.ts`'s `deriveYieldFromResolvedTtm`,
// MKT-005/DIV-009) -- this file does NOT fetch provider events a second
// time or re-decide provider-vs-history precedence itself.
//
// Nothing in this file writes to storage. The what-if overlay
// (`projectMultiYearIncomeWhatIf`, re-exported below for callers) is a pure
// function a caller applies to this service's baseline output; it never
// touches this module's SqlClient.
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { loadOwnedDividendHistory } from "./owned-dividend-history.ts";
import { loadOwnedHoldings } from "./owned-holdings.ts";
import { createDividendAssumptionsRepository } from "../db/repositories/dividends.ts";
import { loadHistoricalPortfolioValueAtDates } from "./historical-portfolio-value.ts";
import { fyWindowForDate } from "../domain/dividends/fy-window.ts";
import { deriveYieldFromResolvedTtm } from "../domain/market-data/dividend-yield.ts";
import {
  aggregateSecurityYields,
  computeCurrentFinancialYearEstimateRow,
  computeCurrentFinancialYearRow,
  computeIncomeBreakdown,
  computePastFinancialYearRows,
  computeTrailingTwelveMonthActualDividendRow,
  projectMultiYearIncome,
  resolvePortfolioDividendGrowth,
  resolvePortfolioValueGrowth,
  resolveSecurityDividendGrowth,
  resolveSecurityFranking,
  resolveSecurityYield,
  type AggregateYieldResult,
  type ComputeCurrentFinancialYearEstimateRowResult,
  type ComputeCurrentFinancialYearRowResult,
  type ComputePastFinancialYearRowsResult,
  type FrankingAssumptionResolution,
  type GrowthAssumptionResolution,
  type IncomeBreakdownResult,
  type MultiYearProjectionInput,
  type MultiYearProjectionResult,
  type PastFinancialYearSecurityInput,
  type PortfolioGrowthAssumption,
  type TrailingTwelveMonthActualRow,
  type YieldAssumptionResolution,
} from "../domain/dividends/projection.ts";

export { projectMultiYearIncomeWhatIf } from "../domain/dividends/projection.ts";
export type { WhatIfGrowthOverrides } from "../domain/dividends/projection.ts";

const MAX_YEARS = 10;

type Row = Record<string, unknown>;
type PortfolioValueStatus = "available" | "partial" | "unavailable";

function clampYearsBack(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(Math.trunc(value), MAX_YEARS));
}

export type IncomeProjectionAssumptionRow = {
  portfolioSecurityId: string;
  symbol: string;
  currencyCode: string;
  yield: YieldAssumptionResolution;
  franking: FrankingAssumptionResolution;
  growth: GrowthAssumptionResolution;
};

export type PortfolioValueCoverage = {
  total: number;
  nonZero: number;
  zero: number;
  priced: number;
  converted: number;
  basis: number;
};

export type OwnedIncomeProjection = {
  status: "ok" | "empty" | "unavailable";
  baseCurrencyCode: string;
  today: string;
  currentPortfolioValueDecimal: string | null;
  /**
   * `"partial"` is a real, honest, but UNDERSTATED known total (some
   * holdings unpriced) -- distinct from `"available"` (complete) and
   * `"unavailable"` (nothing known at all). Review finding B2: this used to
   * collapse "partial" into "available", so a partially-priced portfolio's
   * total was presented with the same confidence as a fully complete one.
   */
  portfolioValueStatus: PortfolioValueStatus;
  /** Coverage counts behind `currentPortfolioValueDecimal` (from `app/owned-holdings.ts`), `null` only when the holdings pipeline itself is unavailable. Lets a consumer disclose exactly how partial a `"partial"` status is. */
  portfolioValueCoverage: PortfolioValueCoverage | null;
  assumptionGrid: IncomeProjectionAssumptionRow[];
  aggregateYield: AggregateYieldResult;
  portfolioValueGrowth: PortfolioGrowthAssumption;
  portfolioDividendGrowth: PortfolioGrowthAssumption;
  /** Baseline multi-year projection (no what-if applied). Typed `ok: false` reasons (`portfolio_value_unavailable`/`no_yield_coverage`/`invalid_years`) replace what used to be a misleading blanket `invalid_decimal` (review finding B3). */
  multiYear: MultiYearProjectionResult;
  /**
   * The exact input `projectMultiYearIncomeWhatIf` needs to recompute this
   * with substituted growth assumptions -- `null` whenever `multiYear` is
   * `ok: false` (review finding B3): a degraded portfolio must never hand a
   * caller a confident-looking `"0"`-substituted input that `what-if` could
   * silently turn into an `ok: true` all-zero projection. Only present
   * alongside a successful `multiYear`.
   */
  multiYearBaselineInput: MultiYearProjectionInput | null;
  /** The current, still-open FY's row (follow-up 2) -- financial-year-to-date, explicitly not a full-year figure, closing the gap between the last closed past FY and the first forward-projected year. */
  currentFinancialYear: ComputeCurrentFinancialYearRowResult;
  /** UI-046: the current FY's FULL-YEAR estimate. NOT built from
   * `currentFinancialYear` above (that row buckets declared-pending rows
   * too, which would double-count against the remainder forecast's
   * declared leg -- the review-reproduced B1 defect). Instead the row
   * partitions raw history rows by EVENT: RECEIVED (paid on or before
   * today) + GAP (ex-date passed, unpaid) + the `[today+1, FY end]`
   * remainder forecast -- each dividend event counted exactly once.
   * `ok: false` exactly when `currentFinancialYear` is (the same FY
   * calendar failure). */
  currentFinancialYearEstimate: ComputeCurrentFinancialYearEstimateRowResult;
  /** UI-046: the trailing 365-day ACTUAL (received, non-projected) dividend
   * total across every held security -- distinct from `breakdown` (a
   * forward-looking, partly-projected Next 12 Months estimate) and from
   * `currentFinancialYear` (bounded by the FY calendar, not a rolling
   * window). */
  trailingTwelveMonthActual: TrailingTwelveMonthActualRow;
  pastFinancialYears: ComputePastFinancialYearRowsResult;
  breakdown: IncomeBreakdownResult;
  /** DIV-013: the portfolio's own FY start month (1-12), threaded through so
   * the "Add/Remove Capital" what-if overlay can place an owner-chosen
   * calendar month/year onto the SAME FY calendar the multi-year rows
   * already use (`applyCapitalEventsToProjection`,
   * `domain/dividends/projection.ts`). Already resolved by
   * `loadOwnedDividendHistory` above -- reused verbatim, never re-derived. */
  financialYearStartMonth: number;
};

export async function loadOwnedIncomeProjection(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  now = new Date(),
  options: { yearsForward?: number; yearsBack?: number } = {},
): Promise<OwnedIncomeProjection> {
  // Deliberately NOT clamped to a minimum of 1 (review finding B3 / follow-up
  // 3): `0` (or any other out-of-[1,10] value) must surface as an explicit
  // `invalid_years` boundary rejection below, never be silently forced up to
  // a confident one-year projection the caller never asked for. `??` only
  // substitutes the default for `undefined`, so an explicit `0` passes
  // through untouched.
  const yearsForward = options.yearsForward ?? MAX_YEARS;
  const yearsBack = clampYearsBack(options.yearsBack, MAX_YEARS);

  // Ownership gate mirrors every other owned-* service: a portfolio id alone
  // never discloses whether another owner has one.
  const portfolio = await client.get<Row>(
    `SELECT id FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
    [portfolioId, userId],
  );
  if (!portfolio) throw new Error("not_owned");

  // PRF-005 (owner-reported Error 1102 on `/portfolio/:id/income`):
  // `loadOwnedDividendHistory` and `loadOwnedHoldings` are mutually
  // independent reads -- neither's SQL/output feeds the other (`today`
  // below derives only from `history`; `baseCurrencyCode` below derives
  // only from `holdings`) -- so they run concurrently instead of two
  // sequential waterfalls, mirroring PRF-003's established pattern for this
  // exact shape. `loadOwnedHoldings`'s failure stays LOCAL (`.catch` on the
  // promise itself, matching the original try/catch's degrade-to-null
  // behaviour) so a holdings failure never propagates through this
  // Promise and never masks a genuine `loadOwnedDividendHistory` failure
  // the caller still needs to see thrown.
  const holdingsPromise = loadOwnedHoldings(
    client,
    userId,
    portfolioId,
    now,
  ).catch(() => null);
  const history = await loadOwnedDividendHistory(
    client,
    userId,
    portfolioId,
    now,
  );
  const today = history.today;
  const holdings: Awaited<ReturnType<typeof loadOwnedHoldings>> | null =
    await holdingsPromise;
  const baseCurrencyCode = holdings?.homeCurrencyCode ?? null;
  // BUG-002 owner ruling (2026-08-25, verbatim: "How is cash handled. First
  // step is to make it work for the stocks, give the value of the stock
  // portfolio. No magic negative cash or anything."): extended from the
  // historical derivation (`app/historical-portfolio-value.ts`) to the
  // CURRENT portfolio-value figure too -- every surface labelled/
  // functioning as "portfolio value" is securities-only for now. Sourced
  // from `holdings.cash.securitiesSubtotal` (the securities-only subtotal
  // `app/owned-holdings.ts` already computes internally, NOT
  // `.knownTotal`, which additionally sums cash). `app/owned-holdings.ts`
  // itself, `loadCash`, and every cash-specific consumer (the cash ledger,
  // its own screens) are UNTOUCHED -- this narrows only what THIS figure
  // reads, never deletes or degrades cash data.
  const currentPortfolioValueDecimal =
    holdings !== null && holdings.status !== "unavailable"
      ? (holdings.cash.securitiesSubtotal ?? null)
      : null;
  // BUG-002: isolates the ONE gap that can understate the NOW-securities-
  // only `currentPortfolioValueDecimal` -- a held security whose home
  // VALUE (not basis, not cash) never converted. Computed BEFORE the
  // status below so the status itself can be based on this signal
  // directly, rather than the coarser `holdings.status` (which also flips
  // "partial" for a cash account's own `completeness` flag or a held
  // security's cost BASIS being unavailable -- neither of which affects
  // this VALUE figure at all, the exact "incorrect future years"
  // misattribution HIST-001 originally fixed for cash and now closes for
  // basis too, by construction rather than a second special case).
  const securitiesValueGapCount =
    holdings !== null
      ? Math.max(0, holdings.coverage.nonZero - holdings.coverage.converted)
      : 0;
  const holdingsPortfolioValueStatus: PortfolioValueStatus =
    holdings === null
      ? "unavailable"
      : securitiesValueGapCount > 0
        ? "partial"
        : "available";
  const portfolioValueStatus: PortfolioValueStatus =
    currentPortfolioValueDecimal === null
      ? "unavailable"
      : holdingsPortfolioValueStatus;
  const portfolioValueCoverage: PortfolioValueCoverage | null =
    holdings?.coverage ?? null;
  // BUG-002: since `portfolioValueStatus` can now ONLY be "partial" via a
  // security value-conversion gap (never cash, never basis -- see above),
  // the reason is always exactly that gap; no cash-shaped or generic
  // "other data incomplete" fallback clause is reachable any more.
  const currentPortfolioValuePartialReason: string | null =
    portfolioValueStatus === "partial"
      ? `${securitiesValueGapCount} held ${securitiesValueGapCount === 1 ? "security is" : "securities are"} unpriced`
      : null;

  // Fall back to the portfolio's own base currency for aggregation scope
  // even when the holdings pipeline is unavailable (e.g. no published
  // calculation yet) -- read it directly rather than leaving every
  // base-currency-scoped aggregate permanently unavailable too.
  const resolvedBaseCurrencyCode =
    baseCurrencyCode ??
    String(
      (
        await client.get<Row>(
          `SELECT base_currency_code FROM portfolios WHERE id = ? AND user_id = ? LIMIT 1`,
          [portfolioId, userId],
        )
      )?.base_currency_code ?? "",
    );

  const holdingsByPortfolioSecurityId = new Map(
    (holdings?.rows ?? []).map((row) => [row.id, row]),
  );

  // PRF-005: these two reads are mutually independent (both scoped by
  // userId/portfolioId alone, neither consumes the other's output) --
  // collapsed into one concurrent wave instead of two sequential round
  // trips, matching the same pattern `loadOwnedDividendHistory` already
  // applies to its own batch of independent per-portfolio reads.
  const assumptions = createDividendAssumptionsRepository(client);
  const [securityAssumptionsRecords, portfolioAssumptions] = await Promise.all([
    assumptions.listSecurityAssumptions(userId, portfolioId),
    assumptions.getPortfolioAssumptions(userId, portfolioId),
  ]);
  const securityAssumptionsById = new Map(
    securityAssumptionsRecords.map((record) => [
      record.portfolioSecurityId,
      record,
    ]),
  );

  const portfolioValueGrowth = resolvePortfolioValueGrowth(
    portfolioAssumptions?.valueGrowthPercentDecimal ?? null,
  );
  const portfolioDividendGrowth = resolvePortfolioDividendGrowth(
    portfolioAssumptions?.portfolioDividendGrowthPercentDecimal ?? null,
  );

  const assumptionGrid: IncomeProjectionAssumptionRow[] =
    history.securities.map((security) => {
      const ownerAssumptions = securityAssumptionsById.get(
        security.portfolioSecurityId,
      );
      // DIV-016 part B: `hasFullYearHistoryEvidence` is the SAME field
      // `security.forecast` (this security's `SecurityDividendForecast`,
      // already computed by `loadOwnedDividendHistory`) already resolved --
      // never re-derived here. `forceAssumption` is the owner's explicit
      // per-security escape hatch, default off.
      const hasFullYearHistoryEvidence =
        security.forecast.hasFullYearHistoryEvidence;
      const forceAssumption = ownerAssumptions?.forceAssumption ?? false;
      const frankingResolution = resolveSecurityFranking(
        ownerAssumptions?.frankingPercentDecimal ?? null,
        hasFullYearHistoryEvidence,
        forceAssumption,
      );
      const growthResolution = resolveSecurityDividendGrowth(
        ownerAssumptions?.dividendGrowthPercentDecimal ?? null,
        portfolioDividendGrowth.source === "portfolio_assumption"
          ? portfolioDividendGrowth.growthPercentDecimal
          : null,
      );
      const holdingRow = holdingsByPortfolioSecurityId.get(
        security.portfolioSecurityId,
      );
      const nativePrice = holdingRow?.nativePrice ?? null;
      // DIV-009: reuse the security's ALREADY-COMPUTED forecast TTM
      // (`security.forecast.ttmPerShareDecimal`/`ttmSource`, DIV-001's
      // `loadOwnedDividendHistory` already ran `computeSecurityDividendForecast`
      // with this portfolio's provider `dividend_events` AND its imported
      // dividend history) instead of re-deriving a trailing yield from raw
      // provider events alone -- that used to gate the whole Multi-Year tab
      // on provider coverage even when the DIV-008 history fallback had a
      // real figure. Provider precedence is NOT re-decided here; the
      // forecast already decided it.
      const ttmYield = deriveYieldFromResolvedTtm(
        {
          ttmPerShareDecimal: security.forecast.ttmPerShareDecimal,
          ttmSource: security.forecast.ttmSource,
          // DIV-009 review fix (B1): threaded through so a partially
          // determinable history-derived rate is disclosed, never silently
          // presented as complete.
          ttmIncomplete: security.forecast.ttmIncomplete,
          currencyCode: security.forecast.currencyCode,
          uncoveredReason: security.forecast.uncoveredReason,
          // DIV-009 review fix (B2): a security fully covered by declared
          // events has a REAL, known 12-month total even when no trailing
          // TTM rate exists -- never "insufficient_history" in that case.
          hasFullDeclaredCoverage:
            security.forecast.status === "fully_covered_by_declared",
        },
        nativePrice !== null
          ? { amountDecimal: nativePrice, currencyCode: security.currencyCode }
          : null,
      );
      const yieldResolution = resolveSecurityYield(
        ownerAssumptions?.dividendYieldPercentDecimal ?? null,
        ttmYield,
        frankingResolution,
        hasFullYearHistoryEvidence,
        forceAssumption,
      );
      return {
        portfolioSecurityId: security.portfolioSecurityId,
        symbol: security.symbol,
        currencyCode: security.currencyCode,
        yield: yieldResolution,
        franking: frankingResolution,
        growth: growthResolution,
      };
    });

  const aggregateYield = aggregateSecurityYields(
    assumptionGrid.map((row) => {
      const holdingRow = holdingsByPortfolioSecurityId.get(
        row.portfolioSecurityId,
      );
      return {
        portfolioSecurityId: row.portfolioSecurityId,
        symbol: row.symbol,
        // Review finding B1: an unpriced holding (no `holdingRow`, or a
        // `homeValue.status !== "available"`) must pass a distinguishable
        // `null`, never `"0"` -- collapsing "unknown value" into "known
        // zero value" silently erased large unpriced holdings from BOTH the
        // numerator and the denominator with no disclosure, letting a small
        // covered remainder report a confident-looking effective yield.
        // `aggregateSecurityYields` itself now names every `null`-value
        // holding in `excluded` before it ever reaches the zero-value skip.
        valueDecimal:
          holdingRow && holdingRow.homeValue.status === "available"
            ? holdingRow.homeValue.value
            : null,
        yield: row.yield,
        franking: row.franking,
      };
    }),
  );

  // The current FY window containing `today` -- the multi-year projection's
  // starting-year label, the current-FY-to-date row, and the past-FY loop's
  // "how far back" anchor all derive from this single resolution (FY-001A
  // windows/labels via `fyWindowForDate`, consistent with how DIV-001
  // itself attributes dates).
  const currentFyWindowResult = fyWindowForDate(
    today,
    history.financialYearStartMonth,
  );
  const currentEndingYear = currentFyWindowResult.ok
    ? currentFyWindowResult.endingYear
    : new Date(`${today}T00:00:00Z`).getUTCFullYear();

  const pastFinancialYearSecurities: PastFinancialYearSecurityInput[] =
    history.securities.map((security) => ({
      portfolioSecurityId: security.portfolioSecurityId,
      symbol: security.symbol,
      currencyCode: security.currencyCode,
      fyTotals: security.fyTotals,
      fyTotalsStatus: security.fyTotalsStatus,
    }));

  // Review finding B3: `multiYearBaselineInput` must never be built with
  // `"0"` substitutions for a missing current value or missing yield
  // coverage -- that produced a confident-looking `ok: true` all-zero
  // projection (and let `projectMultiYearIncomeWhatIf` silently "recover" an
  // equally fabricated non-zero one). A degraded input surfaces a typed
  // `MultiYearProjectionResult` failure and a `null` baseline input instead;
  // `yearsForward` outside 1-10 (including the explicit `0` case, follow-up
  // 3) is checked FIRST, independent of data availability, so a shape error
  // is never masked by a data-availability error or vice versa.
  const currentFinancialYear: ComputeCurrentFinancialYearRowResult =
    computeCurrentFinancialYearRow({
      baseCurrencyCode: resolvedBaseCurrencyCode,
      startMonth: history.financialYearStartMonth,
      currentEndingYear,
      securities: pastFinancialYearSecurities,
      portfolioFyOverrides: history.portfolioFyOverrides,
      currentPortfolioValueDecimal,
      currentPortfolioValueStatus: portfolioValueStatus,
    });

  // DIV-011 (owner directive, 2026-08-23): computed BEFORE the multi-year
  // block below so its `totalGrossDecimal`/`totalCashDecimal` can be reused
  // VERBATIM as the multi-year projection's year-1 base -- the root-cause
  // fix for the $20,731-vs-$38,552 divergence (the old base derived year 1
  // from `aggregateYield.effectiveYieldPercentDecimal * currentPortfolioValueDecimal`,
  // an aggregate value-weighted yield that structurally shrank below what
  // this per-security forecast SUM already knew whenever coverage/value
  // gaps existed). `aggregateYield`/`assumptionGrid` are UNCHANGED and still
  // computed above for the assumption-grid display and the landing page's
  // "Explain this estimate" dialog -- they simply no longer feed the
  // multi-year base.
  const breakdown = computeIncomeBreakdown({
    baseCurrencyCode: resolvedBaseCurrencyCode,
    currentPortfolioValueDecimal,
    currentPortfolioValueStatus: portfolioValueStatus,
    securities: history.securities.map((security) => ({
      portfolioSecurityId: security.portfolioSecurityId,
      symbol: security.symbol,
      currencyCode: security.currencyCode,
      forecast: security.forecast,
    })),
  });

  // UI-046: the SAME `computeIncomeBreakdown` aggregation as `breakdown`
  // above, fed each security's FY-REMAINDER-windowed forecast instead of
  // the fixed rolling-365-day one -- one aggregation function, two
  // differently-windowed forecast inputs, never a second aggregation
  // formula. Feeds the REMAINDER leg of the "FY{yy} Estimate" row's
  // RECEIVED/GAP/REMAINDER event partition -- never combined with the
  // `currentFinancialYear` display row, whose declared-pending bucketing
  // would double-count the remainder's declared leg.
  const fyRemainderBreakdown = computeIncomeBreakdown({
    baseCurrencyCode: resolvedBaseCurrencyCode,
    currentPortfolioValueDecimal,
    currentPortfolioValueStatus: portfolioValueStatus,
    securities: history.securities.map((security) => ({
      portfolioSecurityId: security.portfolioSecurityId,
      symbol: security.symbol,
      currencyCode: security.currencyCode,
      forecast: security.fyRemainderForecast,
    })),
  });
  // UI-046 (B1 fix): computed directly from raw history rows (RECEIVED/GAP
  // legs, event-partitioned -- see `domain/dividends/projection.ts`'s
  // section header) rather than reusing `currentFinancialYear`'s own
  // already-aggregated total, which attributes by `paymentDate ?? exDate`
  // regardless of status and so can double-count a declared-but-not-yet-
  // paid event against `fyRemainderBreakdown`'s declared leg.
  const currentFinancialYearEstimate = computeCurrentFinancialYearEstimateRow({
    baseCurrencyCode: resolvedBaseCurrencyCode,
    startMonth: history.financialYearStartMonth,
    currentEndingYear,
    today,
    securities: history.securities.map((security) => ({
      portfolioSecurityId: security.portfolioSecurityId,
      symbol: security.symbol,
      currencyCode: security.currencyCode,
      rows: security.rows,
    })),
    remainderBreakdown: fyRemainderBreakdown,
  });

  // UI-046: the trailing 365-day ACTUAL (received, non-projected) total --
  // reuses each security's already-derived history rows (DIV-001) the same
  // way `breakdown`/`currentFinancialYear` already do, just window-filtered
  // instead of forecast/FY-filtered.
  const trailingTwelveMonthActual = computeTrailingTwelveMonthActualDividendRow(
    {
      baseCurrencyCode: resolvedBaseCurrencyCode,
      asOfDate: today,
      securities: history.securities.map((security) => ({
        portfolioSecurityId: security.portfolioSecurityId,
        symbol: security.symbol,
        currencyCode: security.currencyCode,
        rows: security.rows,
      })),
    },
  );

  let multiYear: MultiYearProjectionResult;
  let multiYearBaselineInput: MultiYearProjectionInput | null = null;
  if (
    !Number.isInteger(yearsForward) ||
    yearsForward < 1 ||
    yearsForward > MAX_YEARS
  ) {
    multiYear = { ok: false, reason: "invalid_years" };
  } else if (currentPortfolioValueDecimal === null) {
    multiYear = { ok: false, reason: "portfolio_value_unavailable" };
  } else if (breakdown.totalGrossDecimal === null) {
    // DIV-011: the gate now mirrors the base itself -- no held security has
    // a usable 12-month forecast (`breakdown.status === "no_coverage"`),
    // not "no security has a resolved yield" (the old `aggregateYield`-based
    // gate, which could disagree with the base's own real coverage).
    multiYear = { ok: false, reason: "no_yield_coverage" };
  } else {
    multiYearBaselineInput = {
      assumptions: {
        currentPortfolioValueDecimal,
        // `portfolioValueStatus` is guaranteed "available" or "partial" here
        // (never "unavailable" -- that branch already returned above when
        // `currentPortfolioValueDecimal === null`), matching
        // `MultiYearProjectionAssumptions.currentPortfolioValueStatus`'s
        // narrower type. Review finding B4: this must travel with the
        // assumptions so `projectMultiYearIncomeWhatIf`'s output -- which
        // UI-006A can render standalone, without this service's
        // `portfolioValueStatus` alongside it -- still discloses a partial
        // base in its own row `method` labels.
        currentPortfolioValueStatus: portfolioValueStatus as
          "available" | "partial",
        currentPortfolioValuePartialReason,
        baseForecastGrossDecimal: breakdown.totalGrossDecimal,
        baseForecastCashDecimal: breakdown.totalCashDecimal!,
        // DIV-009 review fix (B1), identical B4 precedent, SURVIVING the
        // DIV-011 base swap: now sourced from `breakdown.partialTtmSecurities`
        // (the SAME forecast-sum aggregation that feeds the base itself),
        // not the separate `aggregateYield` chain.
        baseYieldIncludesPartialTtm: breakdown.partialTtmSecurities.length > 0,
        // DIV-011 review fix (B3): a security EXCLUDED ENTIRELY from
        // `breakdown` (foreign currency or insufficient history --
        // `IncomeBreakdownResult.excludedSecurities`) contributes NOTHING to
        // the reused base, unlike a partial-TTM security above (which still
        // contributes a real, merely understated figure) -- named
        // separately so a base built from a minority of held securities
        // never reads as confidently complete.
        baseExcludedSecurityCount: breakdown.excludedSecurities.length,
        baseForecastFrankingIncomplete: breakdown.totalFrankingIncomplete,
        valueGrowthPercentDecimal: portfolioValueGrowth.growthPercentDecimal,
        valueGrowthSource: portfolioValueGrowth.source,
        dividendGrowthPercentDecimal:
          portfolioDividendGrowth.growthPercentDecimal,
        dividendGrowthSource: portfolioDividendGrowth.source,
      },
      yearsForward,
      // DIV-011: year 1's `endingYear` (`startEndingYear + 1`) is now the
      // CURRENT financial year, not the year after it -- year 1 represents
      // the current FY's own forward-looking forecast (see
      // `MultiYearProjectionInput.startEndingYear`'s doc comment).
      startEndingYear: currentFyWindowResult.ok ? currentEndingYear - 1 : null,
    };
    multiYear = projectMultiYearIncome(multiYearBaselineInput);
  }

  let historicalPortfolioValueByYear = new Map<number, string | null>();
  if (yearsBack > 0) {
    try {
      // HIST-001: previously read from `createHistoricalSnapshotRepository()
      // .loadPublishedOverview()` (the CALC-003/CALC-004 persisted
      // `portfolio_daily_snapshots` pipeline). Investigation (see
      // `docs/ARCHITECTURE.md`'s HIST-001 entry) found that pipeline had
      // NEVER published for the real account under review -- a resumable,
      // budgeted, multi-day-advancing background rebuild that started
      // before the owner's price-history import landed, so its early
      // progress recorded zero priced holdings for those dates and, being
      // cursor-based, never revisits them -- which is why every historical
      // year read "unavailable" regardless of how much price history now
      // exists. This now reads a per-FY-end-date value from the READ-TIME
      // derivation (`app/historical-portfolio-value.ts`), the SAME
      // derivation the Overview graph uses (one derivation for both
      // surfaces) -- bounded, no writes, no dependency on any background
      // pipeline ever completing.
      const anchorMonth = history.financialYearStartMonth;
      const endDatesByYear = new Map<number, string>();
      for (let yearsAgo = 1; yearsAgo <= yearsBack; yearsAgo += 1) {
        const endingYear = currentEndingYear - yearsAgo;
        const anchorYear = anchorMonth === 1 ? endingYear : endingYear - 1;
        const anchorDate = `${String(anchorYear).padStart(4, "0")}-${String(anchorMonth).padStart(2, "0")}-01`;
        const windowResult = fyWindowForDate(anchorDate, anchorMonth);
        if (!windowResult.ok) continue;
        endDatesByYear.set(endingYear, windowResult.window.endDate);
      }
      const valuesByDate = await loadHistoricalPortfolioValueAtDates(
        client,
        userId,
        portfolioId,
        [...endDatesByYear.values()],
        now,
      );
      if (valuesByDate) {
        for (const [endingYear, endDate] of endDatesByYear) {
          const point = valuesByDate.get(endDate);
          // `historicalPortfolioValueByYear` (and `computePastFinancialYearRows`
          // downstream) is a 2-state contract (available/unavailable) with
          // no "partial" row state -- a PARTIAL point (e.g. a held security
          // genuinely unpriced on this exact FY-end date; BUG-002 owner
          // ruling: this derivation is securities-only, so cash is never a
          // cause -- see `app/historical-portfolio-value.ts`'s header) must
          // never be presented as a confident, fully-known figure. Fails
          // closed to "unavailable" for that year rather than silently
          // upgrading a partial sum into an apparently-solid one.
          historicalPortfolioValueByYear.set(
            endingYear,
            point?.completeness === "complete" ? point.valueDecimal : null,
          );
        }
      }
    } catch {
      historicalPortfolioValueByYear = new Map();
    }
  }

  const pastFinancialYears = computePastFinancialYearRows({
    baseCurrencyCode: resolvedBaseCurrencyCode,
    startMonth: history.financialYearStartMonth,
    currentEndingYear,
    yearsBack,
    securities: pastFinancialYearSecurities,
    portfolioFyOverrides: history.portfolioFyOverrides,
    historicalPortfolioValueByYear,
  });

  const status: OwnedIncomeProjection["status"] =
    history.securities.length === 0 ? "empty" : "ok";

  return {
    status,
    baseCurrencyCode: resolvedBaseCurrencyCode,
    today,
    currentPortfolioValueDecimal,
    portfolioValueStatus,
    portfolioValueCoverage,
    assumptionGrid,
    aggregateYield,
    portfolioValueGrowth,
    portfolioDividendGrowth,
    multiYear,
    multiYearBaselineInput,
    currentFinancialYear,
    currentFinancialYearEstimate,
    trailingTwelveMonthActual,
    pastFinancialYears,
    breakdown,
    financialYearStartMonth: history.financialYearStartMonth,
  };
}
