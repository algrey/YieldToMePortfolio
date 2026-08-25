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
  computeCurrentFinancialYearRow,
  computeIncomeBreakdown,
  computePastFinancialYearRows,
  projectMultiYearIncome,
  resolvePortfolioDividendGrowth,
  resolvePortfolioValueGrowth,
  resolveSecurityDividendGrowth,
  resolveSecurityFranking,
  resolveSecurityYield,
  type AggregateYieldResult,
  type ComputeCurrentFinancialYearRowResult,
  type ComputePastFinancialYearRowsResult,
  type FrankingAssumptionResolution,
  type GrowthAssumptionResolution,
  type IncomeBreakdownResult,
  type MultiYearProjectionInput,
  type MultiYearProjectionResult,
  type PastFinancialYearSecurityInput,
  type PortfolioGrowthAssumption,
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

  const history = await loadOwnedDividendHistory(
    client,
    userId,
    portfolioId,
    now,
  );
  const today = history.today;

  let holdings: Awaited<ReturnType<typeof loadOwnedHoldings>> | null = null;
  try {
    holdings = await loadOwnedHoldings(client, userId, portfolioId, now);
  } catch {
    holdings = null;
  }
  const baseCurrencyCode = holdings?.homeCurrencyCode ?? null;
  const currentPortfolioValueDecimal =
    holdings !== null && holdings.status !== "unavailable"
      ? (holdings.cash.knownTotal ?? null)
      : null;
  // Review finding B2: `holdings.status` distinguishes "complete" from
  // "partial" (some holdings unpriced, but a real known total exists) --
  // both used to collapse into a single "available" here, presenting an
  // understated partial total with full confidence. If, defensively, no
  // total actually came through despite a non-degraded status, the status
  // is forced back to "unavailable" so the two fields can never disagree.
  const holdingsPortfolioValueStatus: PortfolioValueStatus =
    holdings === null
      ? "unavailable"
      : holdings.status === "complete"
        ? "available"
        : holdings.status === "partial"
          ? "partial"
          : "unavailable";
  const portfolioValueStatus: PortfolioValueStatus =
    currentPortfolioValueDecimal === null
      ? "unavailable"
      : holdingsPortfolioValueStatus;
  const portfolioValueCoverage: PortfolioValueCoverage | null =
    holdings?.coverage ?? null;
  // HIST-001 (owner-reported "incorrect numbers for future years"):
  // `portfolioValueStatus === "partial"` used to ALWAYS render as "some
  // holdings are unpriced" downstream (`domain/dividends/projection.ts`'s
  // method text, `income-multi-year.tsx`'s summary line) -- but
  // `holdings.status` (the source of `portfolioValueStatus`) also flips to
  // "partial" whenever `holdings.cash.status !== "complete"` (e.g. a cash
  // account flagged `completeness = 'incomplete'`, a provenance caveat
  // wholly unrelated to security pricing) OR a held security's cost BASIS
  // is unavailable (`homeBasis`, which `currentPortfolioValueDecimal` never
  // reads at all). Investigation on the real account found exactly the
  // first case: 18/18 held securities fully priced, `portfolioValueStatus`
  // "partial" solely from the cash account's completeness flag -- the OLD
  // blanket copy told the owner their future-year numbers were understated
  // because of unpriced holdings when nothing was actually unpriced,
  // reading as "incorrect" even though the dollar figure itself was the
  // full, correct total. `securitiesValueGapCount` isolates the ONE gap
  // that genuinely understates `currentPortfolioValueDecimal` (a held
  // security whose home VALUE -- not basis -- never converted); when it is
  // zero, the disclosure says so honestly instead of naming a cause that
  // is not real.
  const securitiesValueGapCount =
    holdings !== null
      ? Math.max(0, holdings.coverage.nonZero - holdings.coverage.converted)
      : 0;
  // Review fold (HIST-001): a NONZERO cash account that failed to CONVERT
  // (`cash.coverage.nonZero - cash.coverage.converted`, the SAME
  // converted-vs-nonZero shape as `securitiesValueGapCount` above, sourced
  // from `app/owned-holdings.ts`'s `loadCash` own coverage counts) DOES
  // genuinely understate `currentPortfolioValueDecimal` -- real dollars are
  // missing from the sum, not merely a provenance caveat. This is
  // DIFFERENT from `cash.status !== "complete"` alone (which also flips
  // for the `completeness = 'incomplete'` flag even when every account's
  // balance summed and converted fine -- the real account this task
  // investigated hit exactly that non-understating case). Only an actual
  // conversion failure belongs in the "understated" branch below.
  const cashValueGapCount =
    holdings !== null
      ? Math.max(
          0,
          holdings.cash.coverage.nonZero - holdings.cash.coverage.converted,
        )
      : 0;
  const currentPortfolioValuePartialReason: string | null =
    portfolioValueStatus === "partial"
      ? securitiesValueGapCount > 0 || cashValueGapCount > 0
        ? [
            securitiesValueGapCount > 0
              ? `${securitiesValueGapCount} held ${securitiesValueGapCount === 1 ? "security is" : "securities are"} unpriced`
              : null,
            cashValueGapCount > 0
              ? `${cashValueGapCount} cash ${cashValueGapCount === 1 ? "account" : "accounts"} could not convert to the base currency`
              : null,
          ]
            .filter((clause): clause is string => clause !== null)
            .join(" and ")
        : "other portfolio data (cash history or cost-basis provenance) is incomplete -- the value total itself is not understated by unpriced holdings or unconverted cash"
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

  const assumptions = createDividendAssumptionsRepository(client);
  const securityAssumptionsRecords = await assumptions.listSecurityAssumptions(
    userId,
    portfolioId,
  );
  const securityAssumptionsById = new Map(
    securityAssumptionsRecords.map((record) => [
      record.portfolioSecurityId,
      record,
    ]),
  );
  const portfolioAssumptions = await assumptions.getPortfolioAssumptions(
    userId,
    portfolioId,
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
      const frankingResolution = resolveSecurityFranking(
        ownerAssumptions?.frankingPercentDecimal ?? null,
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
          // no "partial" row state -- a PARTIAL point (e.g. cash known but
          // the held security genuinely unpriced on this exact FY-end date)
          // must never be presented as a confident, fully-known figure.
          // Fails closed to "unavailable" for that year rather than
          // silently upgrading a partial sum into an apparently-solid one.
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
    pastFinancialYears,
    breakdown,
    financialYearStartMonth: history.financialYearStartMonth,
  };
}
