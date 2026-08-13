// DIV-003: owner-scoped, READ-ONLY retirement-income projection service.
// Composes holdings value (`app/owned-holdings.ts`), dividend history/
// forecast (`app/owned-dividend-history.ts`, DIV-001), owner assumptions
// (`db/repositories/dividends.ts`), historical portfolio value
// (`db/repositories/snapshots.ts`), and provider trailing yield
// (`domain/market-data/dividend-yield.ts`, MKT-005) into the pure
// `domain/dividends/projection.ts` (DIV-003) functions. Every actual
// projection/aggregation RULE lives in that pure domain module; this file
// only fetches owner-scoped facts and calls it -- mirrors
// `app/owned-dividend-history.ts`'s own split between I/O and derivation.
//
// Nothing in this file writes to storage. The what-if overlay
// (`projectMultiYearIncomeWhatIf`, re-exported below for callers) is a pure
// function a caller applies to this service's baseline output; it never
// touches this module's SqlClient.
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { loadOwnedDividendHistory } from "./owned-dividend-history.ts";
import { loadOwnedHoldings } from "./owned-holdings.ts";
import { createDividendAssumptionsRepository } from "../db/repositories/dividends.ts";
import { createHistoricalSnapshotRepository } from "../db/repositories/snapshots.ts";
import { fyWindowForDate } from "../domain/dividends/fy-window.ts";
import {
  deriveTrailingDividendYield,
  type TrailingDividendEventInput,
} from "../domain/market-data/dividend-yield.ts";
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
const MAX_EVENTS_PER_PORTFOLIO = 20_000;

type Row = Record<string, unknown>;
type PortfolioValueStatus = "available" | "partial" | "unavailable";

function inClause(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

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

  // Provider trailing yield needs each security's raw ingested
  // `dividend_events` -- DIV-001's read service does not return these (it
  // only returns already-derived rows), so this service fetches them itself
  // in one bounded, whole-portfolio query, mirroring
  // `app/owned-dividend-history.ts`'s own batching pattern.
  const securityIds = [
    ...new Set(history.securities.map((security) => security.securityId)),
  ];
  const eventsBySecurityId = new Map<string, TrailingDividendEventInput[]>();
  if (securityIds.length > 0) {
    const eventRows = await client.all<Row>(
      `SELECT security_id, kind, status, ex_date, currency_code, gross_per_share_decimal
       FROM dividend_events
       WHERE security_id IN (${inClause(securityIds.length)})
       LIMIT ?`,
      [...securityIds, MAX_EVENTS_PER_PORTFOLIO + 1],
    );
    if (eventRows.length > MAX_EVENTS_PER_PORTFOLIO) {
      throw new Error("too_many_dividend_events");
    }
    for (const row of eventRows) {
      if (row.gross_per_share_decimal === null || row.ex_date === null)
        continue;
      const securityId = String(row.security_id);
      const list = eventsBySecurityId.get(securityId) ?? [];
      list.push({
        exDate: String(row.ex_date),
        currencyCode: String(row.currency_code),
        grossPerShareDecimal: String(row.gross_per_share_decimal),
        kind: String(row.kind) as TrailingDividendEventInput["kind"],
        status: String(row.status) as TrailingDividendEventInput["status"],
      });
      eventsBySecurityId.set(securityId, list);
    }
  }

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
      const events = eventsBySecurityId.get(security.securityId) ?? [];
      const providerTtmYield = deriveTrailingDividendYield(
        events,
        today,
        nativePrice !== null
          ? { amountDecimal: nativePrice, currencyCode: security.currencyCode }
          : null,
      );
      const yieldResolution = resolveSecurityYield(
        ownerAssumptions?.dividendYieldPercentDecimal ?? null,
        providerTtmYield,
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
  } else if (aggregateYield.status !== "ok") {
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
        baseYieldPercentDecimal: aggregateYield.effectiveYieldPercentDecimal!,
        baseFrankingMixPercentDecimal:
          aggregateYield.effectiveFrankingMixPercentDecimal!,
        valueGrowthPercentDecimal: portfolioValueGrowth.growthPercentDecimal,
        valueGrowthSource: portfolioValueGrowth.source,
        dividendGrowthPercentDecimal:
          portfolioDividendGrowth.growthPercentDecimal,
        dividendGrowthSource: portfolioDividendGrowth.source,
      },
      yearsForward,
      startEndingYear: currentFyWindowResult.ok ? currentEndingYear : null,
    };
    multiYear = projectMultiYearIncome(multiYearBaselineInput);
  }

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

  let historicalPortfolioValueByYear = new Map<number, string | null>();
  if (yearsBack > 0) {
    try {
      const overview = await createHistoricalSnapshotRepository(
        client,
      ).loadPublishedOverview(userId, portfolioId);
      if (overview) {
        const byDate = new Map(
          overview.history.map((point) => [
            point.date,
            point.totalValueDecimal,
          ]),
        );
        for (let yearsAgo = 1; yearsAgo <= yearsBack; yearsAgo += 1) {
          const endingYear = currentEndingYear - yearsAgo;
          const anchorMonth = history.financialYearStartMonth;
          const anchorYear = anchorMonth === 1 ? endingYear : endingYear - 1;
          const anchorDate = `${String(anchorYear).padStart(4, "0")}-${String(anchorMonth).padStart(2, "0")}-01`;
          const windowResult = fyWindowForDate(anchorDate, anchorMonth);
          if (!windowResult.ok) continue;
          historicalPortfolioValueByYear.set(
            endingYear,
            byDate.get(windowResult.window.endDate) ?? null,
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
  };
}
