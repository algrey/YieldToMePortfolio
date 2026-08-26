// DIV-003: retirement-income projection engine. Pure domain functions only
// (no repository/SqlClient imports anywhere in this module -- the what-if
// overlay's "never persisted" acceptance rule is partly enforced
// STRUCTURALLY by this: nothing in this file can write to storage because
// nothing in this file can even reach storage). `app/owned-income-projection.ts`
// is the owner-scoped read service that fetches inputs and composes these
// functions; this file only turns already-fetched facts into projected,
// labelled numbers.
//
// Owner decisions binding this module (TASKS.md DIV-003, recorded
// 2026-08-13):
// - All dividend math is per 12-month period; multi-year views are per
//   financial year (FY-001A windows/labels).
// - "Yield" throughout this module means TOTAL yield INCLUDING franking
//   credits -- the grossed-up figure is the forecasting basis. Cash/franking
//   splits are derived FROM a grossed figure via the franking assumption,
//   never the other way around.
// - Assumption precedence per security: owner override wins when present;
//   blank falls back to the next tier; the bottom tier is always an
//   explicit "none"/0 with a method label, never a fabricated number.
// - What-if growth substitutions are applied ephemerally and must never be
//   persisted -- enforced here by this module simply having no persistence
//   capability at all.
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  formatDecimalExact,
  fromInteger,
  multiplyDecimal,
  parseDecimal,
  roundDecimal,
  subtractDecimal,
  type DecimalFraction,
} from "../calculations/decimal.ts";
import { computeDefaultFrankingCredit } from "./franking.ts";
import { fyWindowForDate, fyWindowForEndingYear } from "./fy-window.ts";
import {
  isValidFinancialYearStartMonth,
  type FyWindow,
} from "../calculations/financial-year.ts";
import {
  computeLifetimeDividendTotals,
  type FyDividendOverrideFact,
  type FyDividendTotal,
} from "./aggregations.ts";
import type { DerivedDividendRow } from "./history.ts";
import type { SecurityDividendForecast } from "./forecast.ts";
import type { ResolvedTtmYieldResult } from "../market-data/dividend-yield.ts";

const ZERO = fromInteger(0n);
const ONE = fromInteger(1n);
const HUNDRED = fromInteger(100n);

// Shared intermediate rounding scale for every division this module
// performs (percentage-to-fraction conversion, franking-ratio decomposition,
// value-weighted averaging). Matches `franking.ts`'s `DEFAULT_TIER_SCALE`
// and `DECIMAL_LIMITS.allocationScale` -- this codebase's standard
// "no natural terminating scale" intermediate precision. A SINGLE rounding
// per division keeps compounding (10 years forward) from either losing
// precision or growing its tracked scale past the 96-scale result boundary
// (multiplying two already-tracked decimals adds their scales; without
// resetting to a fixed scale at every step, 10 sequential multiplications
// would otherwise grow unbounded).
const PROJECTION_SCALE = 24;
const MAX_YEARS = 10;

// ---------------------------------------------------------------------------
// a. Assumption resolution.
// ---------------------------------------------------------------------------

export type FrankingAssumptionSource = "owner_override" | "none";

export type FrankingAssumptionResolution = {
  source: FrankingAssumptionSource;
  /** The percent actually used by downstream gross-up math -- "0" (never null) when `source` is `"none"`, so callers never need a separate null-check before arithmetic. */
  frankingPercentDecimal: string;
  method: string;
};

/**
 * Franking % precedence: owner security assumption
 * (`dividend_security_assumptions.franking_percent_decimal`) wins when set;
 * otherwise there is no portfolio-level or provider-derived franking-percent
 * fallback in this codebase (a provider event's own per-event franking
 * field is a fact about ONE past dividend, not a forward assumption), so the
 * bottom tier is an explicit, disclosed "treated as unfranked" default --
 * never a silent zero pretending to be data.
 */
export function resolveSecurityFranking(
  ownerFrankingPercentDecimal: string | null,
): FrankingAssumptionResolution {
  if (ownerFrankingPercentDecimal !== null) {
    return {
      source: "owner_override",
      frankingPercentDecimal: ownerFrankingPercentDecimal,
      method: "owner-set franking assumption",
    };
  }
  return {
    source: "none",
    frankingPercentDecimal: "0",
    method:
      "no franking assumption set for this security -- treated as unfranked (0%) for projection purposes",
  };
}

export type GrowthAssumptionSource =
  "owner_override" | "portfolio_default" | "none";

export type GrowthAssumptionResolution = {
  source: GrowthAssumptionSource;
  growthPercentDecimal: string;
  method: string;
};

/**
 * Per-security dividend-growth % precedence: owner security override, else
 * the portfolio's dividend-growth assumption, else an explicit "no growth
 * assumed" 0% -- never a fabricated growth rate.
 */
export function resolveSecurityDividendGrowth(
  ownerSecurityGrowthPercentDecimal: string | null,
  portfolioDividendGrowthPercentDecimal: string | null,
): GrowthAssumptionResolution {
  if (ownerSecurityGrowthPercentDecimal !== null) {
    return {
      source: "owner_override",
      growthPercentDecimal: ownerSecurityGrowthPercentDecimal,
      method: "owner-set security dividend-growth assumption",
    };
  }
  if (portfolioDividendGrowthPercentDecimal !== null) {
    return {
      source: "portfolio_default",
      growthPercentDecimal: portfolioDividendGrowthPercentDecimal,
      method: "portfolio-level dividend-growth assumption",
    };
  }
  return {
    source: "none",
    growthPercentDecimal: "0",
    method: "no growth assumed",
  };
}

export type PortfolioAssumptionSource =
  "portfolio_assumption" | "none" | "what_if";

export type PortfolioGrowthAssumption = {
  source: PortfolioAssumptionSource;
  growthPercentDecimal: string;
  method: string;
};

// DIV-011 (owner directive, 2026-08-23 verbatim): "the portfolio growth %
// affect the portfolio size and dividend growth affects the dividend
// growth. These should both default to 6%." This is a DEFAULT-only change
// -- an owner-set value (either column non-null) still wins outright and is
// used exactly as typed, never overridden by this constant. Only the
// bottom, no-assumption-recorded tier moves from the old "no growth
// assumed" 0% to this figure, disclosed honestly in `method` below (never
// silently presented as an owner choice).
const DEFAULT_PORTFOLIO_GROWTH_PERCENT = "6";

/** Portfolio value-growth %: the single `dividend_portfolio_assumptions.value_growth_percent_decimal` input, or -- when unset -- the DIV-011 default of 6%/yr (disclosed as a default, not an owner choice). There is no further fallback tier -- this IS the top of its own chain. */
export function resolvePortfolioValueGrowth(
  valueGrowthPercentDecimal: string | null,
): PortfolioGrowthAssumption {
  if (valueGrowthPercentDecimal !== null) {
    return {
      source: "portfolio_assumption",
      growthPercentDecimal: valueGrowthPercentDecimal,
      method: "owner-set portfolio value-growth assumption",
    };
  }
  return {
    source: "none",
    growthPercentDecimal: DEFAULT_PORTFOLIO_GROWTH_PERCENT,
    method: `no owner-set portfolio value-growth assumption -- defaulting to ${DEFAULT_PORTFOLIO_GROWTH_PERCENT}%/yr`,
  };
}

/** Portfolio dividend-growth %, used as the multi-year projection's dividend-compounding input (DIV-011: independently of value growth). Same single-tier shape as `resolvePortfolioValueGrowth`, including the DIV-011 6%/yr default when unset. */
export function resolvePortfolioDividendGrowth(
  portfolioDividendGrowthPercentDecimal: string | null,
): PortfolioGrowthAssumption {
  if (portfolioDividendGrowthPercentDecimal !== null) {
    return {
      source: "portfolio_assumption",
      growthPercentDecimal: portfolioDividendGrowthPercentDecimal,
      method: "owner-set portfolio dividend-growth assumption",
    };
  }
  return {
    source: "none",
    growthPercentDecimal: DEFAULT_PORTFOLIO_GROWTH_PERCENT,
    method: `no owner-set portfolio dividend-growth assumption -- defaulting to ${DEFAULT_PORTFOLIO_GROWTH_PERCENT}%/yr`,
  };
}

// DIV-009: `"history_ttm"` added -- the DIV-008 history-derived TTM fallback
// (`SecurityDividendForecast.ttmSource`) can now win the assumption grid's
// yield resolution exactly as it already wins the forecast, so a consumer
// must be able to tell the two TTM legs apart, not just "TTM vs none".
export type YieldAssumptionSource =
  "owner_override" | "provider_ttm" | "history_ttm" | "none";

// DIV-009: `"unknown_amount" | "history_gap"` added -- `SecurityDividendForecast.uncoveredReason`'s
// DIV-006/DIV-008 reasons for a forecast whose history TTM leg is unusable;
// surfaced here (rather than collapsed into "insufficient_history") so a
// security with a PROVABLE ledger gap (`"history_gap"`) is named as such,
// never silently blurred into a bare "no data at all" reason. DIV-009
// review fix (B2): `"fully_covered_no_ttm"` added -- a security whose
// 12-month forecast TOTAL is fully known from declared events but has no
// trailing TTM rate must never read as `"insufficient_history"` (which
// would wrongly suggest nothing is known about it at all).
export type YieldAssumptionStatus =
  | "ok"
  | "insufficient_history"
  | "price_unavailable"
  | "currency_mismatch"
  | "mixed_currency"
  | "invalid_input"
  | "unknown_amount"
  | "history_gap"
  | "fully_covered_no_ttm";

export type YieldAssumptionResolution =
  | {
      source: "owner_override";
      status: "ok";
      grossedYieldPercentDecimal: string;
      cashYieldPercentDecimal: null;
      frankingPercentUsedDecimal: null;
      frankingSource: null;
      // An owner-typed total yield has no trailing-window sample to be
      // partial about -- always `false`, never omitted (DIV-009 review fix
      // B1: a uniform boolean across every variant, so a consumer never has
      // to narrow the union just to check completeness).
      ttmIncomplete: false;
      method: string;
    }
  | {
      source: "provider_ttm" | "history_ttm";
      status: "ok";
      grossedYieldPercentDecimal: string;
      cashYieldPercentDecimal: string;
      frankingPercentUsedDecimal: string;
      frankingSource: FrankingAssumptionSource;
      // DIV-009 review fix (B1): threaded from `SecurityDividendForecast.ttmIncomplete`
      // via `ResolvedTtmYieldResult` -- `true` only ever alongside
      // `source: "history_ttm"` (the provider leg has no partial-row
      // concept). A `true` value means this yield is REAL but may
      // understate the true trailing rate; `method` names this explicitly
      // (DIV-006's disclosure convention) rather than presenting it as a
      // clean, complete figure.
      ttmIncomplete: boolean;
      method: string;
    }
  | {
      source: "none";
      status: Exclude<YieldAssumptionStatus, "ok">;
      grossedYieldPercentDecimal: null;
      cashYieldPercentDecimal: null;
      frankingPercentUsedDecimal: null;
      frankingSource: null;
      // No yield was resolved at all -- there is nothing to be "partially"
      // complete, so always `false`.
      ttmIncomplete: false;
      method: string;
    };

/**
 * Resolved TOTAL (grossed, franking-inclusive) yield %, the forecasting
 * basis throughout this module. Precedence: owner override (already
 * total-yield by definition -- the assumptions-grid field is generically
 * labelled "yield" and this task's binding ruling is that "yield" always
 * means the grossed total, so an owner-entered value needs no further
 * gross-up) -- else the resolved trailing-twelve-month CASH yield (DIV-009:
 * `domain/market-data/dividend-yield.ts`'s `deriveYieldFromResolvedTtm`,
 * which itself keeps the provider TTM leg's precedence over the DIV-008
 * history-derived fallback exactly as `computeSecurityDividendForecast`
 * already decided -- this function never re-decides that precedence),
 * grossed up by the resolved franking % using the identical ATO formula
 * `franking.ts`'s `computeDefaultFrankingCredit` already implements
 * (grossed = cash + creditOnCash, and `computeDefaultFrankingCredit`'s
 * dividend-amount argument is linear, so passing the cash YIELD percentage
 * in place of a dollar amount computes the credit YIELD percentage using
 * the exact same formula) -- else `"none"`, carrying the TTM resolution's
 * own typed unavailability reason forward rather than a guess. `source`/
 * `method` distinguish a provider- from a history-derived yield (DIV-006's
 * disclosure convention) so the assumption grid never presents a
 * history-derived figure as if it were provider data.
 */
export function resolveSecurityYield(
  ownerYieldOverridePercentDecimal: string | null,
  ttmYield: ResolvedTtmYieldResult,
  frankingResolution: FrankingAssumptionResolution,
): YieldAssumptionResolution {
  if (ownerYieldOverridePercentDecimal !== null) {
    return {
      source: "owner_override",
      status: "ok",
      grossedYieldPercentDecimal: ownerYieldOverridePercentDecimal,
      cashYieldPercentDecimal: null,
      frankingPercentUsedDecimal: null,
      frankingSource: null,
      ttmIncomplete: false,
      method:
        "owner-set total yield assumption (already includes franking credits)",
    };
  }
  if (!ttmYield.ok) {
    return {
      source: "none",
      status: ttmYield.reason,
      grossedYieldPercentDecimal: null,
      cashYieldPercentDecimal: null,
      frankingPercentUsedDecimal: null,
      frankingSource: null,
      ttmIncomplete: false,
      method: `no owner override and no usable trailing dividend yield is available (${ttmYield.reason})`,
    };
  }
  const cashYieldPercentDecimal = ttmYield.trailingYieldPercentDecimal;
  const creditYieldPercentDecimal = computeDefaultFrankingCredit(
    cashYieldPercentDecimal,
    frankingResolution.frankingPercentDecimal,
  );
  const grossedYieldPercentDecimal = formatDecimalExact(
    addDecimal(
      parseDecimal(cashYieldPercentDecimal),
      parseDecimal(creditYieldPercentDecimal),
    ),
  );
  const legLabel =
    ttmYield.ttmSource === "history_ttm"
      ? "trailing 12-month cash yield derived from the security's own imported dividend history (DIV-008 fallback -- no usable provider trailing-yield data)"
      : "provider trailing 12-month cash yield";
  // DIV-009 review fix (B1): a partially-determinable history-derived rate
  // must be named in the method text, mirroring `computeIncomeBreakdown`'s
  // `partialTtmSecurities`/`method` disclosure convention (DIV-006) -- never
  // silently presented as a clean, complete figure.
  const incompleteNote = ttmYield.ttmIncomplete
    ? " (only PARTIALLY determinable -- at least one trailing-window history row's rate could not be established, so this may understate the true rate)"
    : "";
  return {
    source: ttmYield.ttmSource,
    status: "ok",
    grossedYieldPercentDecimal,
    cashYieldPercentDecimal,
    frankingPercentUsedDecimal: frankingResolution.frankingPercentDecimal,
    frankingSource: frankingResolution.source,
    ttmIncomplete: ttmYield.ttmIncomplete,
    method:
      (frankingResolution.source === "owner_override"
        ? `${legLabel} grossed up using the owner's franking assumption`
        : `${legLabel}; no franking assumption set, so no franking credit is added (0%)`) +
      incompleteNote,
  };
}

// ---------------------------------------------------------------------------
// Franking gross-up / decomposition shared helpers.
// ---------------------------------------------------------------------------

/**
 * Splits an already-GROSSED (cash + franking credit) dollar amount back into
 * its cash and franking-credit components, given the franking % that
 * produced it. Reuses `computeDefaultFrankingCredit` rather than
 * re-deriving its ratio: calling it with a $1 dividend returns the
 * credit-per-dollar-of-cash ratio (`computeDefaultFrankingCredit` is linear
 * in its dividend-amount argument), so `cash = gross / (1 + ratio)`.
 *
 * Precision note (follow-up 4, softened from an earlier overclaim): that
 * ratio is EXACT only when the underlying ATO fraction terminates in
 * decimal (e.g. 70% franking gives ratio `0.3` exactly); for a franking %
 * that does not (e.g. 100% franking gives the repeating `3/7`),
 * `computeDefaultFrankingCredit`'s own documented single rounding applies,
 * bounding the ratio's error to roughly `1e-24` relative -- not literally
 * zero. `cash`'s own division against that ratio is itself rounded once
 * more at the same `PROJECTION_SCALE`, so `cash` alone can carry a similarly
 * bounded (not exactly zero) drift from the mathematically exact split in
 * that case. `franking = gross - cash` is still computed by SUBTRACTION
 * from the SAME `gross` value (never an independent multiplication), so
 * `cash + franking` always sums back to `gross` EXACTLY regardless -- the
 * bounded drift, when the ratio doesn't terminate, only ever shows up in
 * how that exact sum is split between the two components, never in a
 * missing or invented cent.
 */
export function decomposeGrossedAmount(
  grossDecimal: string,
  frankingPercentDecimal: string,
): { cashDecimal: string; frankingDecimal: string } {
  const ratioDecimal = computeDefaultFrankingCredit(
    "1",
    frankingPercentDecimal,
  );
  const onePlusRatio = addDecimal(ONE, parseDecimal(ratioDecimal));
  const gross = parseDecimal(grossDecimal);
  const cashDecimal = formatDecimalExact(
    roundDecimal(divideDecimal(gross, onePlusRatio), PROJECTION_SCALE),
  );
  const frankingDecimal = formatDecimalExact(
    subtractDecimal(parseDecimal(grossDecimal), parseDecimal(cashDecimal)),
  );
  return { cashDecimal, frankingDecimal };
}

// ---------------------------------------------------------------------------
// Value-weighted aggregation of per-security resolved yields into one
// portfolio effective yield (and franking mix), for the multi-year
// projection's portfolio-level rows.
// ---------------------------------------------------------------------------

export type SecurityYieldContribution = {
  portfolioSecurityId: string;
  symbol: string;
  /**
   * Current home-currency market value of this holding, or `null` when it is
   * genuinely UNKNOWN (missing price/FX at the holdings layer) -- distinct
   * from a real, priced `"0"`. This distinction is load-bearing (review
   * finding B1): collapsing "unknown" into `"0"` silently erases an unpriced
   * holding's weight from the aggregate without disclosure, understating the
   * true denominator while the method text still claims full coverage. Only
   * a caller-supplied `null` is treated as unknown; `"0"` is always a real
   * zero-value holding.
   *
   * Percentages are dimensionless, so -- unlike a dollar total -- this
   * weighting has no cross-currency problem: every KNOWN security's VALUE is
   * already expressed in one common home currency by the caller (see
   * `app/owned-holdings.ts`'s `homeValue`), only the resolved yield/franking
   * PERCENTAGES are combined here.
   */
  valueDecimal: string | null;
  yield: YieldAssumptionResolution;
  franking: FrankingAssumptionResolution;
};

export type AggregateYieldExclusionReason =
  Exclude<YieldAssumptionStatus, "ok"> | "value_unavailable";

export type AggregateYieldExclusion = {
  portfolioSecurityId: string;
  symbol: string;
  reason: AggregateYieldExclusionReason;
};

/**
 * DIV-009 review fix (B1): an INCLUDED security (not excluded -- see
 * `excluded` above) whose resolved yield carries `ttmIncomplete: true`
 * (a real but only partially-determinable history-derived rate --
 * `SecurityDividendForecast.ttmIncomplete`) -- named here rather than
 * silently folded into a confident-looking `effectiveYieldPercentDecimal`,
 * mirroring `computeIncomeBreakdown`'s `partialTtmSecurities` disclosure
 * convention (DIV-006).
 */
export type AggregateYieldPartialTtmSecurity = {
  portfolioSecurityId: string;
  symbol: string;
};

export type AggregateYieldResult = {
  status: "ok" | "no_coverage";
  effectiveYieldPercentDecimal: string | null;
  effectiveFrankingMixPercentDecimal: string | null;
  includedValueDecimal: string;
  includedCount: number;
  excluded: AggregateYieldExclusion[];
  /** DIV-009 review fix (B1): included securities whose contribution to `effectiveYieldPercentDecimal` is only partially known (never re-excluded on top of the row-level disclosure -- a real, non-fabricated figure still feeds the average, just possibly understated). Deliberately does NOT change `status` (a partial-TTM security must never gate the multi-year projection itself into `no_yield_coverage` -- unlike `computeIncomeBreakdown`'s standalone breakdown dialog, this result's `status` feeds `app/owned-income-projection.ts`'s multi-year availability gate directly). */
  partialTtmSecurities: AggregateYieldPartialTtmSecurity[];
  method: string;
};

/**
 * Value-weighted portfolio effective yield: `sum(value_i * yield_i) /
 * sum(value_i)` over securities with a KNOWN current value and a resolved
 * (non-"none") yield -- i.e. each security's weight is its own value
 * divided by the total value of every OTHER INCLUDED security, not the
 * whole portfolio. Two independent, separately-disclosed reasons keep a
 * security out of the weighting, in this order:
 *
 * 1. **`value_unavailable`** -- `valueDecimal` is `null` (checked FIRST,
 *    before the yield check and before the zero-value skip below; review
 *    finding B1). An unpriced holding must never be silently folded in as
 *    a `"0"`-weight contributor: a large unpriced position with a real
 *    yield assumption would then vanish from BOTH the numerator and the
 *    denominator without disclosure, so a small covered remainder can
 *    report a confident-looking effective yield with no exclusions and no
 *    hint that most of the portfolio's value was never weighed in.
 * 2. A resolved yield of `source: "none"` -- excluded and named with the
 *    yield chain's own typed reason, rather than silently treated as 0%
 *    yield, which would understate the true effective yield of the
 *    covered securities.
 *
 * A real, priced zero/negative value (`valueDecimal: "0"` or negative) is
 * distinct from both: it carries no weight but is NOT a coverage gap, so it
 * is silently skipped, not disclosed as excluded. The franking mix is the
 * identical value-weighted average of each included security's resolved
 * franking %, used later to split a projected gross-dividend total into
 * cash/credit.
 */
export function aggregateSecurityYields(
  contributions: readonly SecurityYieldContribution[],
): AggregateYieldResult {
  const excluded: AggregateYieldExclusion[] = [];
  const partialTtmSecurities: AggregateYieldPartialTtmSecurity[] = [];
  const included: {
    value: DecimalFraction;
    yieldPercent: DecimalFraction;
    frankingPercent: DecimalFraction;
  }[] = [];
  for (const contribution of contributions) {
    if (contribution.valueDecimal === null) {
      excluded.push({
        portfolioSecurityId: contribution.portfolioSecurityId,
        symbol: contribution.symbol,
        reason: "value_unavailable",
      });
      continue;
    }
    const value = parseDecimal(contribution.valueDecimal);
    if (compareDecimal(value, ZERO) <= 0) continue; // a real, priced zero/negative value carries no weight and is not a coverage gap
    if (contribution.yield.source === "none") {
      excluded.push({
        portfolioSecurityId: contribution.portfolioSecurityId,
        symbol: contribution.symbol,
        reason: contribution.yield.status,
      });
      continue;
    }
    included.push({
      value,
      yieldPercent: parseDecimal(
        contribution.yield.grossedYieldPercentDecimal!,
      ),
      frankingPercent: parseDecimal(
        contribution.franking.frankingPercentDecimal,
      ),
    });
    // DIV-009 review fix (B1): included, but disclose the underlying rate
    // may be understated -- never re-excluded on top of this (a real,
    // non-fabricated figure still feeds the weighted average).
    if (contribution.yield.ttmIncomplete) {
      partialTtmSecurities.push({
        portfolioSecurityId: contribution.portfolioSecurityId,
        symbol: contribution.symbol,
      });
    }
  }
  if (included.length === 0) {
    return {
      status: "no_coverage",
      effectiveYieldPercentDecimal: null,
      effectiveFrankingMixPercentDecimal: null,
      includedValueDecimal: "0",
      includedCount: 0,
      excluded,
      partialTtmSecurities: [],
      method:
        "no security in this portfolio has both a known current value and a resolved yield",
    };
  }
  const includedValue = included.reduce(
    (total, entry) => addDecimal(total, entry.value),
    ZERO,
  );
  const yieldNumerator = included.reduce(
    (total, entry) =>
      addDecimal(total, multiplyDecimal(entry.value, entry.yieldPercent)),
    ZERO,
  );
  const frankingNumerator = included.reduce(
    (total, entry) =>
      addDecimal(total, multiplyDecimal(entry.value, entry.frankingPercent)),
    ZERO,
  );
  const effectiveYieldPercentDecimal = formatDecimalExact(
    roundDecimal(
      divideDecimal(yieldNumerator, includedValue),
      PROJECTION_SCALE,
    ),
  );
  const effectiveFrankingMixPercentDecimal = formatDecimalExact(
    roundDecimal(
      divideDecimal(frankingNumerator, includedValue),
      PROJECTION_SCALE,
    ),
  );
  const partialTtmNote =
    partialTtmSecurities.length > 0
      ? ` (${partialTtmSecurities.length} of the ${included.length} included securit${partialTtmSecurities.length === 1 ? "y has" : "ies have"} an only partially determinable trailing-twelve-month figure -- named -- and may understate the true effective yield)`
      : "";
  return {
    status: "ok",
    effectiveYieldPercentDecimal,
    effectiveFrankingMixPercentDecimal,
    includedValueDecimal: formatDecimalExact(includedValue),
    includedCount: included.length,
    excluded,
    partialTtmSecurities,
    method:
      (excluded.length === 0
        ? "value-weighted average of every held security's resolved yield"
        : `value-weighted average across ${included.length} of ${included.length + excluded.length} held securities; ${excluded.length} excluded (named) for an unavailable current value or insufficient yield data`) +
      partialTtmNote,
  };
}

// ---------------------------------------------------------------------------
// b. Multi-year projection.
// ---------------------------------------------------------------------------

export type MultiYearProjectionAssumptions = {
  currentPortfolioValueDecimal: string;
  /**
   * Whether `currentPortfolioValueDecimal` is a complete known total or a
   * partial (real but understated) one -- review finding B4: the service
   * only ever builds a `MultiYearProjectionInput` when the value is known
   * at all (a fully `"unavailable"` value short-circuits to a typed
   * `portfolio_value_unavailable` failure before this type is ever
   * constructed, see `MultiYearProjectionResult`'s `reason` union), so
   * `"unavailable"` is not a member here. This flows into every row's
   * `method` label (below) so the disclosure survives standalone
   * consumption of a `projectMultiYearIncomeWhatIf` result -- a what-if
   * table rendered on its own, without the baseline `OwnedIncomeProjection`
   * alongside it, must not read as confidently fully-sourced when it was
   * built on a half-priced base.
   */
  currentPortfolioValueStatus: "available" | "partial";
  /**
   * HIST-001 (owner-reported "incorrect numbers for future years"): a
   * caller-supplied, HONEST description of why `currentPortfolioValueStatus`
   * is `"partial"` -- e.g. "N held securities are unpriced" when a
   * security's home value genuinely didn't convert, or an explicit
   * statement that the value total is NOT understated when the gap is
   * something else entirely (cash-history completeness, cost-basis
   * provenance) that merely happens to share the same status flag. `null`
   * whenever `currentPortfolioValueStatus === "available"` (nothing to
   * explain) OR a caller has not supplied one -- the method text below
   * falls back to a generic, still-honest phrase rather than the OLD
   * hardcoded "some holdings are unpriced" claim, which investigation
   * showed could be flatly wrong (see `app/owned-income-projection.ts`'s
   * `currentPortfolioValuePartialReason`).
   */
  currentPortfolioValuePartialReason?: string | null;
  /**
   * DIV-011 (owner directive, 2026-08-23): year 1's dividend base -- the
   * SAME per-security 12-month forecast sum feeding `computeIncomeBreakdown`'s
   * Next-12-months headline (`IncomeBreakdownResult.totalGrossDecimal`/
   * `totalCashDecimal`), reused verbatim by the caller (one derivation, never
   * re-derived from a portfolio-level yield -- the root cause this task
   * fixes: the old `baseYieldPercentDecimal * currentPortfolioValueDecimal`
   * base structurally diverged from the headline whenever coverage/value
   * gaps shrank the value-weighted yield below what the forecast sum itself
   * knew). `franking = gross - cash` (by subtraction, the same
   * `decomposeGrossedAmount`-style identity used elsewhere in this module),
   * so no separate franking-mix input is needed here.
   */
  baseForecastGrossDecimal: string;
  baseForecastCashDecimal: string;
  /**
   * DIV-009 review fix (B1), disclosure SURVIVES the DIV-011 base swap:
   * `true` when the reused forecast sum above includes at least one
   * security whose trailing-twelve-month figure is only partially
   * determinable (`IncomeBreakdownResult.partialTtmSecurities` non-empty --
   * the SAME concept `AggregateYieldResult.partialTtmSecurities` named
   * pre-DIV-011, now sourced from the forecast-sum breakdown that actually
   * feeds this base, not the separate yield-aggregation chain). Mirrors
   * `currentPortfolioValueStatus` immediately above, the identical B4
   * precedent: flows into every row's `method` label so the disclosure
   * survives standalone consumption of a `projectMultiYearIncomeWhatIf`
   * result.
   */
  baseYieldIncludesPartialTtm: boolean;
  /**
   * DIV-011: `true` when the reused forecast sum's franking figure is only
   * partially known (`IncomeBreakdownResult.totalFrankingIncomplete`) --
   * the forecast total is built from real declared/estimated dividend
   * events, some of which may carry an unknown per-event franking amount;
   * disclosed here per the same B1/B4 "survive standalone consumption"
   * precedent as `baseYieldIncludesPartialTtm` above, never silently
   * dropped just because this base is now a direct dollar sum rather than a
   * yield-derived figure.
   */
  baseForecastFrankingIncomplete: boolean;
  /**
   * DIV-011 review fix (B3): `computeIncomeBreakdown` can exclude WHOLE
   * securities from the reused forecast sum entirely
   * (`IncomeBreakdownResult.excludedSecurities` -- foreign-currency or
   * `insufficient_history`), which is a MORE severe gap than
   * `baseYieldIncludesPartialTtm` above (an included security whose figure
   * may merely understate): an excluded security contributes NOTHING to
   * `baseForecastGrossDecimal` at all. Pre-fix, a base built from (say) 1 of
   * 4 held securities read exactly as confident as one built from 4 of 4 --
   * this count, named in every row's `method`, closes that gap. `0` means
   * every held (base-currency) security is included.
   */
  baseExcludedSecurityCount: number;
  valueGrowthPercentDecimal: string;
  valueGrowthSource: PortfolioAssumptionSource;
  dividendGrowthPercentDecimal: string;
  dividendGrowthSource: PortfolioAssumptionSource;
};

export type ProjectionYearRow = {
  yearIndex: number;
  endingYear: number | null;
  label: string;
  valueDecimal: string;
  yieldPercentDecimal: string;
  grossDividendDecimal: string;
  cashDividendDecimal: string;
  frankingCreditDecimal: string;
  method: string;
};

export type MultiYearProjectionInput = {
  assumptions: MultiYearProjectionAssumptions;
  /** 1-10 inclusive (TASKS.md: "up to 10 years forward"). `0` (and anything else outside 1-10) is REJECTED with `reason: "invalid_years"`, never silently substituted with a minimum of 1 -- a caller explicitly requesting zero forward years must get an explicit boundary error, not a confident one-year projection it never asked for (review finding B3 / follow-up 3). */
  yearsForward: number;
  /**
   * DIV-011: the FY ending year immediately BEFORE year 1's own ending year
   * -- i.e. `startEndingYear + 1` is year 1's `endingYear`, which is now the
   * CURRENT financial year (year 1 represents the current FY's forward
   * leg, reusing the Next-12-months forecast sum -- see
   * `MultiYearProjectionAssumptions.baseForecastGrossDecimal` -- not a full
   * future year the way it did pre-DIV-011). Each subsequent row is the
   * next FY forward. `null` produces plain "Year N" labels.
   */
  startEndingYear: number | null;
};

export type MultiYearProjectionResult =
  | {
      ok: true;
      rows: ProjectionYearRow[];
      assumptions: MultiYearProjectionAssumptions;
    }
  | {
      ok: false;
      /**
       * `"invalid_years"` / `"invalid_decimal"` are this function's OWN input
       * validation. `"portfolio_value_unavailable"` / `"no_yield_coverage"`
       * are never returned by this function itself (it always receives a
       * concrete `currentPortfolioValueDecimal`/`baseForecastGrossDecimal`) --
       * they exist on this union so the SERVICE layer
       * (`app/owned-income-projection.ts`) can report a degraded portfolio
       * (no published holdings value, or no held security has a usable
       * 12-month forecast -- DIV-011: `computeIncomeBreakdown` reporting
       * `"no_coverage"`, the same coverage gate the reused base itself now
       * depends on) through the identical typed shape instead of inventing a
       * different failure contract, and so it never has to fabricate `"0"`
       * inputs just to get a well-typed result back (review finding B3). The
       * `"no_yield_coverage"` reason NAME is kept unchanged across the
       * DIV-011 base swap (minimal-diff -- every caller/test already
       * branches on this literal); its MEANING moved from "no security has a
       * resolved yield" to "no held security has a usable 12-month forecast".
       */
      reason:
        | "invalid_years"
        | "invalid_decimal"
        | "portfolio_value_unavailable"
        | "no_yield_coverage";
    };

function growthFactor(growthPercentDecimal: string): DecimalFraction {
  const fraction = roundDecimal(
    divideDecimal(parseDecimal(growthPercentDecimal), HUNDRED),
    PROJECTION_SCALE,
  );
  return addDecimal(ONE, fraction);
}

/**
 * DIV-011 review fix (B2): a raw `PortfolioAssumptionSource` enum value
 * (`"none"`) read as neutral -- indistinguishable from an owner's real 0%
 * choice -- even though this module now substitutes a real, non-zero 6%
 * figure for it. Named here so every row's `method` (and the UI's own
 * summary line, which mirrors this wording) states plainly that a
 * `"none"`-sourced rate is a DEFAULT, never presented as if the owner set
 * it.
 */
function describeGrowthSource(source: PortfolioAssumptionSource): string {
  switch (source) {
    case "portfolio_assumption":
      return "owner-set";
    case "what_if":
      return "what-if";
    case "none":
      return `default, ${DEFAULT_PORTFOLIO_GROWTH_PERCENT}%/yr unless set`;
  }
}

/** One compounding step: `current * factor`, rounded ONCE to `PROJECTION_SCALE` -- the "single documented rounding per step" this task requires, and the mechanism that keeps a 10-year loop's tracked decimal scale bounded (see the `PROJECTION_SCALE` comment above). */
function compoundOnce(currentDecimal: string, factor: DecimalFraction): string {
  const product = multiplyDecimal(parseDecimal(currentDecimal), factor);
  return formatDecimalExact(roundDecimal(product, PROJECTION_SCALE));
}

/**
 * DIV-011: yield is a DERIVED DISPLAY figure only (`dividend / value * 100`)
 * -- never re-consulted as a compounding input (value and dividend now
 * compound independently on their own growth assumptions). Guards the
 * zero/negative-value edge case (a genuinely zero or negative base
 * portfolio value has no meaningful yield) by reporting `"0"` rather than
 * dividing by zero; this mirrors `computeIncomeBreakdown`'s own
 * `compareDecimal(currentValue, ZERO) > 0` guard for the identical
 * dividend-over-value computation.
 */
function deriveYieldPercent(
  grossDividendDecimal: string,
  valueDecimal: string,
): string {
  const value = parseDecimal(valueDecimal);
  if (compareDecimal(value, ZERO) <= 0) return "0";
  return formatDecimalExact(
    roundDecimal(
      multiplyDecimal(
        divideDecimal(parseDecimal(grossDividendDecimal), value),
        HUNDRED,
      ),
      PROJECTION_SCALE,
    ),
  );
}

/**
 * DIV-011 (owner directive, 2026-08-23 verbatim): "the portfolio growth %
 * affect the portfolio size and dividend growth affects the dividend
 * growth ... update the calculation to be similar to what we did in the
 * recent turn [`computeIncomeBreakdown`'s per-security forecast sum], then
 * grow by the default growth percent for future years."
 *
 * Year 1 is the base: `value_1 = currentPortfolioValueDecimal` (unchanged --
 * "now"), `dividend_1 = baseForecastGrossDecimal`/`baseForecastCashDecimal`
 * (the SAME per-security forecast sum feeding the Next-12-months headline,
 * reused verbatim -- one derivation, never re-derived from a portfolio-level
 * yield). Year N (N = 2..`yearsForward`): `value_N = value_{N-1} * (1 +
 * valueGrowth)`, `cash_N = cash_{N-1} * (1 + dividendGrowth)`, `gross_N =
 * gross_{N-1} * (1 + dividendGrowth)` -- value and dividend compound
 * independently on their OWN growth assumptions (neither drives the other);
 * each compounding step rounded exactly once (`compoundOnce`, bounding
 * `PROJECTION_SCALE` growth over up to 10 years). `franking_N = gross_N -
 * cash_N` by SUBTRACTION from that year's own gross/cash (the
 * `decomposeGrossedAmount`-style identity used elsewhere in this module),
 * never an independent multiplication, so cash + franking always sums back
 * to gross exactly regardless of any rounding drift between the
 * independently-compounded gross/cash chains. `yieldPercentDecimal` on every
 * row is a DERIVED DISPLAY figure (`deriveYieldPercent`), not a compounding
 * input. Every row carries the assumptions and their sources so a consumer
 * can render "projected: value grows N%/yr (source), dividend grows N%/yr
 * (source)" next to every number -- never a bare projected figure.
 */
export function projectMultiYearIncome(
  input: MultiYearProjectionInput,
): MultiYearProjectionResult {
  const { assumptions, yearsForward, startEndingYear } = input;
  if (
    !Number.isInteger(yearsForward) ||
    yearsForward < 1 ||
    yearsForward > MAX_YEARS
  ) {
    return { ok: false, reason: "invalid_years" };
  }
  let rows: ProjectionYearRow[];
  try {
    const valueFactor = growthFactor(assumptions.valueGrowthPercentDecimal);
    const dividendFactor = growthFactor(
      assumptions.dividendGrowthPercentDecimal,
    );
    let value = assumptions.currentPortfolioValueDecimal;
    let grossDividend = assumptions.baseForecastGrossDecimal;
    let cashDividend = assumptions.baseForecastCashDecimal;
    rows = [];
    const method =
      `year 1 reuses the SAME 12-month per-security forecast sum as the ` +
      `Next 12 Months headline (one derivation, not re-derived from a ` +
      `portfolio-level yield) -- a ROLLING today+12-months window, not the ` +
      `FY calendar boundary (the current FY's separate "received so far" ` +
      `actuals annotation uses the FY window instead); portfolio value ` +
      `compounds at ${assumptions.valueGrowthPercentDecimal}%/yr ` +
      `(${describeGrowthSource(assumptions.valueGrowthSource)}) and ` +
      `dividends compound at ${assumptions.dividendGrowthPercentDecimal}%/yr ` +
      `(${describeGrowthSource(assumptions.dividendGrowthSource)}) ` +
      `independently from year 2 onward; the yield shown is derived ` +
      `(dividend ÷ value), not a projection input; dividend includes ` +
      `franking credits` +
      (assumptions.currentPortfolioValueStatus === "partial"
        ? // Review finding B4: this note must live IN the row's own `method`
          // string, not just alongside it in a separate response field --
          // `projectMultiYearIncomeWhatIf`'s output can be (and is meant to
          // be) rendered standalone by a caller that never sees the
          // original `OwnedIncomeProjection.portfolioValueStatus`, so the
          // disclosure has to travel with the row itself to survive that.
          // HIST-001: a caller-supplied `currentPortfolioValuePartialReason`
          // replaces the OLD unconditional "some holdings are unpriced"
          // claim, which investigation showed could be flatly wrong (the
          // status can flip to "partial" for reasons -- cash-history
          // completeness, cost-basis provenance -- that never touch the
          // value total at all). Omitted (`undefined`, the default for
          // every existing caller/fixture) keeps the ORIGINAL wording
          // byte-identical.
          assumptions.currentPortfolioValuePartialReason
          ? `; current portfolio value is partial -- ${assumptions.currentPortfolioValuePartialReason}`
          : `; based on a partial (understated) current portfolio value -- some holdings are unpriced`
        : "") +
      // DIV-011 review fix (B3): a security EXCLUDED ENTIRELY from the
      // reused forecast sum (foreign currency or insufficient history) is a
      // MORE severe gap than a merely partial-TTM security below -- named
      // separately so a base built from only a minority of held securities
      // never reads as confidently complete.
      (assumptions.baseExcludedSecurityCount > 0
        ? `; ${assumptions.baseExcludedSecurityCount} held ${assumptions.baseExcludedSecurityCount === 1 ? "security" : "securities"} excluded entirely from this base (foreign currency or insufficient history, named on the Next 12 Months breakdown) -- may understate true income`
        : "") +
      // DIV-009 review fix (B1), identical B4 precedent, SURVIVING the
      // DIV-011 base swap: the reused forecast sum may include at least one
      // security whose trailing-twelve-month figure is only partially
      // determinable.
      (assumptions.baseYieldIncludesPartialTtm
        ? `; the base forecast includes at least one security whose trailing-twelve-month figure is only partially determinable -- may understate true income`
        : "") +
      (assumptions.baseForecastFrankingIncomplete
        ? `; franking credits are not fully known for every dividend in the base forecast`
        : "");
    for (let yearIndex = 1; yearIndex <= yearsForward; yearIndex += 1) {
      if (yearIndex > 1) {
        value = compoundOnce(value, valueFactor);
        grossDividend = compoundOnce(grossDividend, dividendFactor);
        cashDividend = compoundOnce(cashDividend, dividendFactor);
      }
      const frankingCreditDecimal = formatDecimalExact(
        subtractDecimal(
          parseDecimal(grossDividend),
          parseDecimal(cashDividend),
        ),
      );
      const endingYear =
        startEndingYear === null ? null : startEndingYear + yearIndex;
      rows.push({
        yearIndex,
        endingYear,
        label:
          endingYear === null
            ? `Year ${yearIndex}`
            : `FY${String(endingYear).slice(-2)}`,
        valueDecimal: value,
        yieldPercentDecimal: deriveYieldPercent(grossDividend, value),
        grossDividendDecimal: grossDividend,
        cashDividendDecimal: cashDividend,
        frankingCreditDecimal,
        method,
      });
    }
  } catch {
    return { ok: false, reason: "invalid_decimal" };
  }
  return { ok: true, rows, assumptions };
}

// ---------------------------------------------------------------------------
// e. What-if overlay: substitutes ONLY the two growth assumptions into the
// same projection formula. Pure function of (baseline input, overrides);
// nothing here reads or writes storage -- see the module header.
// ---------------------------------------------------------------------------

export type WhatIfGrowthOverrides = {
  valueGrowthPercentDecimal?: string;
  dividendGrowthPercentDecimal?: string;
};

export function projectMultiYearIncomeWhatIf(
  baseline: MultiYearProjectionInput,
  overrides: WhatIfGrowthOverrides,
): MultiYearProjectionResult {
  const assumptions: MultiYearProjectionAssumptions = {
    ...baseline.assumptions,
  };
  if (overrides.valueGrowthPercentDecimal !== undefined) {
    assumptions.valueGrowthPercentDecimal = overrides.valueGrowthPercentDecimal;
    assumptions.valueGrowthSource = "what_if";
  }
  if (overrides.dividendGrowthPercentDecimal !== undefined) {
    assumptions.dividendGrowthPercentDecimal =
      overrides.dividendGrowthPercentDecimal;
    assumptions.dividendGrowthSource = "what_if";
  }
  return projectMultiYearIncome({ ...baseline, assumptions });
}

// ---------------------------------------------------------------------------
// f. Capital-event overlay (DIV-013, owner directive 2026-08-24): layers
// owner-entered hypothetical add/remove-capital "parcels" onto an
// ALREADY-COMPUTED multi-year projection (normally `projectMultiYearIncomeWhatIf`'s
// own output -- this function never re-derives the growth what-if itself,
// it only takes that result's `rows`/`assumptions` as its own base, so
// calling it twice with the same overrides never happens). Pure, what-if-
// only display math -- no persistence capability in this module, the same
// structural guarantee as the rest of this file (see the module header).
//
// Parcel mechanics (Orchestrator ruling, TASKS.md DIV-013): a parcel
// "joins" the projection at its own owner-chosen calendar month/year, and
// mirrors the base projection's OWN year-1-is-the-base/year-N-compounds-once
// shape (`compoundOnce`) rather than inventing a second compounding
// convention: the parcel's VALUE is exactly its (signed) amount, unchanged,
// in the FY it joins (no growth applied yet -- "now" for this parcel,
// exactly like the base projection's own year 1), then compounds once per
// FY thereafter at its own (or, when blank, the CURRENT portfolio's) growth
// rate. The parcel's DIVIDEND is pro-rated in its OWN joining FY by
// months-held-that-FY/12 (owner directive, verbatim) against its full-year
// rate (`amount * yield% / 100`); every later FY uses that full annual
// rate, compounded the same once-per-FY way as the value. A negative
// amount (capital REMOVAL) uses the identical formula -- the sign carries
// through every step by ordinary arithmetic, so a removal's contributions
// simply subtract from the totals rather than needing a mirrored,
// duplicated code path.
export type CapitalEventInput = {
  id: string;
  name: string;
  /** Signed -- negative removes capital. */
  amountDecimal: string;
  /** 1-12, the calendar month the parcel starts (or stops) compounding. */
  month: number;
  /** Calendar year, e.g. 2027. */
  year: number;
  /** This parcel's OWN total (grossed) dividend yield %/yr. */
  yieldPercentDecimal: string;
  /**
   * `null` means LIVE-follow the CURRENT portfolio value-growth assumption
   * -- resolved fresh from `base.assumptions.valueGrowthPercentDecimal` on
   * EVERY call, never copied/cached (this function has no memory between
   * calls), so a later change to the portfolio's -- or an active DIV-012
   * what-if's -- growth assumption changes this parcel's own projected
   * figures the very next call, by construction.
   */
  capitalGrowthPercentDecimal: string | null;
  /** Same blank-follows-portfolio contract as `capitalGrowthPercentDecimal`, against the current dividend-growth assumption. */
  dividendGrowthPercentDecimal: string | null;
};

export type CapitalEventContribution = {
  id: string;
  name: string;
  valueDecimal: string;
  grossDividendDecimal: string;
};

export type CapitalEventProjectionYearRow = Omit<
  ProjectionYearRow,
  "yieldPercentDecimal"
> & {
  /** Every capital-event parcel (owner-entered, or -- when reinvestment is
   * on -- auto-generated) that has JOINED by this row, i.e. this row's own
   * FY ending year is at or after the parcel's join FY. Empty when no
   * parcel has joined yet, or none are configured at all. */
  capitalEventContributions: readonly CapitalEventContribution[];
  /**
   * DIV-013 review (fold): `null` when this row's OWN capital-adjusted
   * `valueDecimal` is zero or negative -- newly reachable via an owner's
   * over-removal parcel (the base projection's own real portfolio value can
   * never go negative on its own, so `deriveYieldPercent`'s plain `"0"`
   * fallback was never reachable there; overloading that same "0" here
   * would read as a real, confirmed zero-yield holding rather than the
   * honest "no meaningful yield at a zero/negative value" it actually is).
   */
  yieldPercentDecimal: string | null;
};

export type CapitalEventProjectionResult =
  | {
      ok: true;
      rows: CapitalEventProjectionYearRow[];
      assumptions: MultiYearProjectionAssumptions;
    }
  | {
      ok: false;
      reason:
        | "invalid_start_month"
        // A parcel's own month/year, amount, yield, or growth override is
        // not a usable decimal/calendar value -- fails the WHOLE overlay
        // closed (never silently drops just the one bad parcel), mirroring
        // `projectMultiYearIncome`'s own `invalid_decimal` contract.
        | "invalid_decimal"
        // The base projection's own rows carry no `endingYear` at all
        // (`MultiYearProjectionInput.startEndingYear` was `null`) -- there
        // is no FY calendar to place a parcel's calendar month/year onto.
        // Only reachable when at least one parcel/reinvestment is actually
        // configured (see the empty-input fast path below); an unconfigured
        // overlay never needs a calendar and always succeeds.
        | "no_fy_calendar";
    };

export type ApplyCapitalEventsOptions = {
  /** The portfolio's financial-year start month (1-12) -- needed to place
   * each parcel's owner-chosen calendar month/year into the SAME FY
   * calendar the base projection's rows already use. */
  startMonth: number;
  /** DIV-013 (owner directive): when true, each projected FY's OWN
   * (already capital-event-adjusted) total dividend is layered back in as a
   * new, auto-generated capital-event parcel dated at that FY's calendar
   * midpoint, yielding that FY's own derived average yield -- see
   * `applyCapitalEventsToProjection`'s doc comment for the exact,
   * owner-approved simple-approximation formula this implements verbatim
   * (recorded again in `docs/CALCULATIONS.md`). */
  reinvestDividends: boolean;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

/** `amount * percent / 100`, single rounding at `PROJECTION_SCALE` -- the
 * same "one rounding per arithmetic step" convention as every other money
 * calc in this module. */
function applyPercentToAmount(
  amountDecimal: string,
  percentDecimal: string,
): string {
  return formatDecimalExact(
    roundDecimal(
      multiplyDecimal(
        parseDecimal(amountDecimal),
        divideDecimal(parseDecimal(percentDecimal), HUNDRED),
      ),
      PROJECTION_SCALE,
    ),
  );
}

/** Adds `months` calendar months to a `{year, month}` pair (`month` 1-12), plain integer arithmetic -- used only to date the reinvestment-generated parcel at its FY's calendar midpoint (display/record purposes; see the doc comment below). */
function addCalendarMonths(
  year: number,
  month: number,
  months: number,
): { year: number; month: number } {
  const zeroBasedTotal = year * 12 + (month - 1) + months;
  return {
    year: Math.floor(zeroBasedTotal / 12),
    month: (((zeroBasedTotal % 12) + 12) % 12) + 1,
  };
}

type ResolvedCapitalEvent = {
  id: string;
  name: string;
  amountDecimal: string;
  joinEndingYear: number;
  /** 1-12 -- months from the parcel's own join month (inclusive) to its
   * join FY's end month (inclusive). Only ever consulted for the parcel's
   * OWN join-FY row (`k === 0` below); irrelevant, and never read, for any
   * later row. */
  monthsHeldInJoinFy: number;
  fullYearDividendBaseDecimal: string;
  capitalGrowthFactor: DecimalFraction;
  dividendGrowthFactor: DecimalFraction;
};

/** Resolves one owner-entered (or auto-generated) parcel against the
 * portfolio's FY calendar and its CURRENT growth assumptions -- throws on
 * any unusable decimal/calendar input, caught by the caller's try/catch
 * (mirrors `projectMultiYearIncome`'s own fail-closed contract). */
function resolveCapitalEvent(
  event: CapitalEventInput,
  startMonth: number,
  currentValueGrowthPercentDecimal: string,
  currentDividendGrowthPercentDecimal: string,
): ResolvedCapitalEvent {
  if (
    !Number.isInteger(event.month) ||
    event.month < 1 ||
    event.month > 12 ||
    !Number.isInteger(event.year)
  ) {
    throw new Error("invalid_capital_event_date");
  }
  const joinDate = `${pad4(event.year)}-${pad2(event.month)}-01`;
  const joinWindow = fyWindowForDate(joinDate, startMonth);
  if (!joinWindow.ok) throw new Error("invalid_capital_event_fy");
  const [endYear, endMonth] = joinWindow.window.endDate.split("-").map(Number);
  const monthsHeldInJoinFy =
    endYear! * 12 + endMonth! - (event.year * 12 + event.month) + 1;
  const resolvedCapitalGrowthPercentDecimal =
    event.capitalGrowthPercentDecimal ?? currentValueGrowthPercentDecimal;
  const resolvedDividendGrowthPercentDecimal =
    event.dividendGrowthPercentDecimal ?? currentDividendGrowthPercentDecimal;
  return {
    id: event.id,
    name: event.name,
    amountDecimal: event.amountDecimal,
    joinEndingYear: joinWindow.endingYear,
    monthsHeldInJoinFy,
    fullYearDividendBaseDecimal: applyPercentToAmount(
      event.amountDecimal,
      event.yieldPercentDecimal,
    ),
    capitalGrowthFactor: growthFactor(resolvedCapitalGrowthPercentDecimal),
    dividendGrowthFactor: growthFactor(resolvedDividendGrowthPercentDecimal),
  };
}

/** This parcel's contribution to one row (identified by that row's own FY
 * ending year), or `null` when the parcel has not joined by then. `k = 0`
 * (the parcel's OWN join FY) pro-rates the dividend by
 * `monthsHeldInJoinFy/12`, value unprorated (see the module-section header);
 * `k >= 1` compounds both the value and the full-year dividend rate `k`
 * times via the SAME once-per-step `compoundOnce` the base projection uses. */
function capitalEventContributionForYear(
  resolved: ResolvedCapitalEvent,
  rowEndingYear: number,
): { valueDecimal: string; grossDividendDecimal: string } | null {
  const k = rowEndingYear - resolved.joinEndingYear;
  if (k < 0) return null;
  if (k === 0) {
    const monthsFraction = roundDecimal(
      divideDecimal(
        fromInteger(BigInt(resolved.monthsHeldInJoinFy)),
        fromInteger(12n),
      ),
      PROJECTION_SCALE,
    );
    return {
      valueDecimal: resolved.amountDecimal,
      grossDividendDecimal: formatDecimalExact(
        roundDecimal(
          multiplyDecimal(
            parseDecimal(resolved.fullYearDividendBaseDecimal),
            monthsFraction,
          ),
          PROJECTION_SCALE,
        ),
      ),
    };
  }
  let value = resolved.amountDecimal;
  let dividend = resolved.fullYearDividendBaseDecimal;
  for (let step = 0; step < k; step += 1) {
    value = compoundOnce(value, resolved.capitalGrowthFactor);
    dividend = compoundOnce(dividend, resolved.dividendGrowthFactor);
  }
  return { valueDecimal: value, grossDividendDecimal: dividend };
}

/**
 * DIV-013 (owner's simple formula, recorded verbatim -- `docs/CALCULATIONS.md`
 * mirrors this note): "each projected year reinvests that year's dividends
 * as a mid-year parcel whose yield is the average portfolio yield."
 * Implemented as: after finalising FY N's own row (base + every
 * ALREADY-EXISTING parcel's contribution -- owner-entered parcels and any
 * auto-generated parcel from an EARLIER FY, never this same FY's own
 * not-yet-created parcel, which would be circular), a new parcel is
 * generated dated at FY N's calendar midpoint, with: amount = FY N's own
 * just-finalised TOTAL gross dividend (base + every already-applied
 * parcel -- may be negative if capital removals net out the base income);
 * yield = FY N's own just-finalised derived yield % (dividend ÷ value,
 * i.e. the SAME value-weighted-composition figure the row's own Yield
 * column already shows -- the "average portfolio yield" in the owner's own
 * words); both growth axes left blank (follow the CURRENT portfolio
 * assumptions -- an auto-generated parcel has no owner-chosen growth rate
 * of its own). Because the parcel is only ever ADDED to the working list
 * AFTER FY N's own row is finalised, its first VISIBLE effect on any row is
 * FY N+1 onward (a full one-FY compounding step, `k=1`) -- it can never
 * retroactively change the very total it was generated from, and the
 * first-partial-FY pro-rata rule above is consequently never exercised for
 * an auto-generated parcel (it is dated mid-year purely as a record of
 * WHEN in the FY the dividends were notionally received, matching the
 * owner's own "mid-year parcel" phrase -- not to claim any partial-year
 * income of its own the FY it is created).
 */
export function applyCapitalEventsToProjection(
  base: {
    rows: readonly ProjectionYearRow[];
    assumptions: MultiYearProjectionAssumptions;
  },
  capitalEvents: readonly CapitalEventInput[],
  options: ApplyCapitalEventsOptions,
): CapitalEventProjectionResult {
  // Fast path: nothing to layer on -- never touches the FY-calendar
  // requirement below, so an unconfigured overlay is byte-for-byte the base
  // projection's own rows (plus the empty-contributions field), regardless
  // of whether `options.startMonth`/`base.rows[*].endingYear` would even
  // support placing a parcel.
  if (capitalEvents.length === 0 && !options.reinvestDividends) {
    return {
      ok: true,
      rows: base.rows.map((row) => ({
        ...row,
        capitalEventContributions: [],
      })),
      assumptions: base.assumptions,
    };
  }
  if (!isValidFinancialYearStartMonth(options.startMonth)) {
    return { ok: false, reason: "invalid_start_month" };
  }
  if (!base.rows.every((row) => row.endingYear !== null)) {
    return { ok: false, reason: "no_fy_calendar" };
  }
  try {
    const active: ResolvedCapitalEvent[] = capitalEvents.map((event) =>
      resolveCapitalEvent(
        event,
        options.startMonth,
        base.assumptions.valueGrowthPercentDecimal,
        base.assumptions.dividendGrowthPercentDecimal,
      ),
    );
    const outputRows: CapitalEventProjectionYearRow[] = [];
    for (const row of base.rows) {
      const endingYear = row.endingYear!;
      const contributions: CapitalEventContribution[] = [];
      let valueSum = ZERO;
      // DIV-013 review (B1, BLOCKING): a POSITIVE and a NEGATIVE net
      // contribution are combined differently below (see the cash/franking
      // split), so they are tracked separately from the moment each
      // contribution is seen, not just summed into one `divSum` the way an
      // earlier draft did.
      let positiveDivSum = ZERO;
      let negativeDivSum = ZERO;
      for (const resolved of active) {
        const contribution = capitalEventContributionForYear(
          resolved,
          endingYear,
        );
        if (!contribution) continue;
        contributions.push({
          id: resolved.id,
          name: resolved.name,
          valueDecimal: contribution.valueDecimal,
          grossDividendDecimal: contribution.grossDividendDecimal,
        });
        valueSum = addDecimal(
          valueSum,
          parseDecimal(contribution.valueDecimal),
        );
        const contributionDividend = parseDecimal(
          contribution.grossDividendDecimal,
        );
        if (compareDecimal(contributionDividend, ZERO) < 0) {
          negativeDivSum = addDecimal(negativeDivSum, contributionDividend);
        } else {
          positiveDivSum = addDecimal(positiveDivSum, contributionDividend);
        }
      }
      const totalDivSum = addDecimal(positiveDivSum, negativeDivSum);
      const newValueDecimal = formatDecimalExact(
        addDecimal(parseDecimal(row.valueDecimal), valueSum),
      );
      const newGrossDecimal = formatDecimalExact(
        addDecimal(parseDecimal(row.grossDividendDecimal), totalDivSum),
      );
      // DIV-013 review (B1, BLOCKING, Orchestrator ruling): a POSITIVE net
      // contribution stays the documented simplification (a capital-event
      // parcel carries a single owner-entered TOTAL yield, not a separate
      // franking assumption -- its dividend is treated as pure CASH, 0%
      // franked). A NEGATIVE net contribution (capital REMOVAL) is the true
      // mirror of removing part of the real portfolio, so it splits
      // PRO-RATA against THIS ROW'S OWN (base, pre-capital-event)
      // cash/franking composition instead -- charging the whole reduction
      // against cash alone could otherwise render a deeply negative cash
      // figure next to an UNCHANGED (or even larger, proportionally)
      // franking figure, which is not what removing part of a real
      // portfolio would do (reviewer finding B1: gross 10,000 / cash
      // -20,000 / franking 30,000 was reachable pre-fix). The cash
      // reduction is computed via ONE proportional multiplication (the
      // row's own cash÷gross ratio, rounded once at `PROJECTION_SCALE`);
      // `franking = gross - cash` by SUBTRACTION from the combined totals
      // (this module's standing identity) then automatically halves the
      // franking figure alongside gross for an exact half-portfolio
      // removal, with no separate franking-side rounding to drift.
      let cashDelta = positiveDivSum;
      if (compareDecimal(negativeDivSum, ZERO) < 0) {
        const baseGrossDividend = parseDecimal(row.grossDividendDecimal);
        if (compareDecimal(baseGrossDividend, ZERO) > 0) {
          const cashRatio = roundDecimal(
            divideDecimal(
              parseDecimal(row.cashDividendDecimal),
              baseGrossDividend,
            ),
            PROJECTION_SCALE,
          );
          const cashReduction = roundDecimal(
            multiplyDecimal(negativeDivSum, cashRatio),
            PROJECTION_SCALE,
          );
          cashDelta = addDecimal(cashDelta, cashReduction);
        } else {
          // No meaningful base cash/franking ratio to split a removal
          // against (the row's OWN base dividend is itself zero or
          // negative) -- falls back to charging the whole reduction
          // against cash, the pre-B1 treatment, rather than dividing by a
          // zero/negative base.
          cashDelta = addDecimal(cashDelta, negativeDivSum);
        }
      }
      const newCashDecimal = formatDecimalExact(
        addDecimal(parseDecimal(row.cashDividendDecimal), cashDelta),
      );
      const newFrankingDecimal = formatDecimalExact(
        subtractDecimal(
          parseDecimal(newGrossDecimal),
          parseDecimal(newCashDecimal),
        ),
      );
      // DIV-013 review (fold): an over-removal parcel can newly drive a
      // row's combined value to zero or negative -- the base projection's
      // own `deriveYieldPercent` "0" fallback was designed for a guard that
      // was never actually reachable there (a real portfolio value cannot
      // go negative on its own); reusing it here would present a fabricated
      // "0.00%" as if it were a real, confirmed zero yield.
      const valueNonPositive =
        compareDecimal(parseDecimal(newValueDecimal), ZERO) <= 0;
      const outputRow: CapitalEventProjectionYearRow = {
        ...row,
        valueDecimal: newValueDecimal,
        grossDividendDecimal: newGrossDecimal,
        cashDividendDecimal: newCashDecimal,
        frankingCreditDecimal: newFrankingDecimal,
        yieldPercentDecimal: valueNonPositive
          ? null
          : deriveYieldPercent(newGrossDecimal, newValueDecimal),
        capitalEventContributions: contributions,
      };
      outputRows.push(outputRow);
      if (options.reinvestDividends) {
        const window = fyWindowForEndingYear(endingYear, options.startMonth);
        if (!window.ok) throw new Error("invalid_reinvest_window");
        const [startYear, startMonthNum] = window.window.startDate
          .split("-")
          .map(Number);
        const mid = addCalendarMonths(startYear!, startMonthNum!, 6);
        active.push(
          resolveCapitalEvent(
            {
              id: `reinvest-fy-${endingYear}`,
              name: `Reinvested dividends (FY${String(endingYear).slice(-2)})`,
              amountDecimal: newGrossDecimal,
              month: mid.month,
              year: mid.year,
              // A zero/negative-value row has no meaningful derived yield
              // (`outputRow.yieldPercentDecimal` is `null` there) -- the
              // auto-generated reinvestment parcel falls back to an
              // explicit 0% for that FY rather than failing the whole
              // overlay closed over an internally-generated input.
              yieldPercentDecimal: outputRow.yieldPercentDecimal ?? "0",
              capitalGrowthPercentDecimal: null,
              dividendGrowthPercentDecimal: null,
            },
            options.startMonth,
            base.assumptions.valueGrowthPercentDecimal,
            base.assumptions.dividendGrowthPercentDecimal,
          ),
        );
      }
    }
    return { ok: true, rows: outputRows, assumptions: base.assumptions };
  } catch {
    return { ok: false, reason: "invalid_decimal" };
  }
}

// ---------------------------------------------------------------------------
// c. Past financial-year rows.
// ---------------------------------------------------------------------------

export type PastFyDividendSource =
  | "fy_override"
  | "actual"
  | "partially_estimated"
  | "provider_estimate"
  /**
   * No eligible (base-currency, `fyTotalsStatus: "ok"`) security has ANY
   * `fyTotals` entry for this year at all -- e.g. the year predates every
   * held security's own dividend history, or simply predates the ingested
   * data. DIV-001 has no way to distinguish "this security definitely paid
   * nothing that year" from "no data exists for that year", so this MUST
   * NOT be reported as `"actual"` `"0"` (review follow-up 1) -- that would
   * assert a fact (a known, confirmed zero) this layer cannot actually back.
   */
  | "no_evidence"
  | "unavailable";

export type PastFyExclusionReason =
  "foreign_currency" | "mixed_currency" | "unknown_amount";

export type PastFyExclusion = {
  portfolioSecurityId: string;
  symbol: string;
  reason: PastFyExclusionReason;
};

export type PastFinancialYearRow = {
  endingYear: number;
  label: string;
  window: FyWindow;
  dividendSource: PastFyDividendSource;
  dividendGrossDecimal: string | null;
  dividendCashDecimal: string | null;
  dividendFrankingKnownDecimal: string | null;
  dividendFrankingIncomplete: boolean;
  includedSecurityCount: number;
  excludedSecurities: PastFyExclusion[];
  portfolioValueDecimal: string | null;
  valueStatus: "available" | "unavailable";
  effectiveYieldPercentDecimal: string | null;
  method: string;
};

export type PastFinancialYearSecurityInput = {
  portfolioSecurityId: string;
  symbol: string;
  currencyCode: string;
  fyTotals: readonly FyDividendTotal[];
  /** DIV-001's `fyTotalsStatus` -- anything other than `"ok"` excludes this security from the aggregate for every year (named, not silently dropped). */
  fyTotalsStatus: string;
};

export type ComputePastFinancialYearRowsInput = {
  baseCurrencyCode: string;
  startMonth: number;
  /** The CURRENT (in-progress) FY's ending year -- past rows run from `currentEndingYear - 1` back. */
  currentEndingYear: number;
  /** 0-10 (TASKS.md: "history up to 10 years back"). */
  yearsBack: number;
  securities: readonly PastFinancialYearSecurityInput[];
  portfolioFyOverrides: readonly FyDividendOverrideFact[];
  /** Portfolio value AT the FY's end date, keyed by ending year, when a historical snapshot exists for that exact date (see `db/repositories/snapshots.ts`'s published-overview history). Absent key or a `null` value both mean "value unavailable for this year" -- never a fabricated zero. */
  historicalPortfolioValueByYear: ReadonlyMap<number, string | null>;
};

export type ComputePastFinancialYearRowsResult =
  | { ok: true; rows: PastFinancialYearRow[] }
  | { ok: false; reason: "invalid_years" | "invalid_start_month" };

type YearAggregationTotals = {
  excludedSecurities: PastFyExclusion[];
  includedCount: number;
  anyKnown: boolean;
  allActual: boolean;
  allEstimate: boolean;
  cashTotal: DecimalFraction;
  frankingTotal: DecimalFraction;
  frankingIncomplete: boolean;
};

/**
 * Shared per-year, per-security aggregation used by BOTH
 * `computePastFinancialYearRows` (closed prior years) and
 * `computeCurrentFinancialYearRow` (the in-progress current year, follow-up
 * 2) -- one aggregation rule, not two copies that could silently drift
 * apart. Every foreign-currency security is excluded and named regardless
 * of whether it has data for `endingYear`; every home-currency security
 * with a degraded `fyTotalsStatus` or an unknown per-year amount is
 * similarly excluded and named. A home-currency, `"ok"`-status security
 * with simply no `fyTotals` entry for `endingYear` contributes nothing and
 * is NOT flagged here -- the caller decides what "nothing known at all"
 * means for its own row (a real 0 vs `"no_evidence"` vs `"fy_to_date"`
 * with nothing yet).
 */
function aggregateHomeCurrencySecuritiesForYear(
  homeCurrencySecurities: readonly PastFinancialYearSecurityInput[],
  foreignSecurities: readonly PastFinancialYearSecurityInput[],
  endingYear: number,
): YearAggregationTotals {
  const excludedSecurities: PastFyExclusion[] = foreignSecurities.map(
    (security) => ({
      portfolioSecurityId: security.portfolioSecurityId,
      symbol: security.symbol,
      reason: "foreign_currency" as const,
    }),
  );
  let includedCount = 0;
  let anyKnown = false;
  let allActual = true;
  let allEstimate = true;
  let cashTotal = ZERO;
  let frankingTotal = ZERO;
  let frankingIncomplete = false;
  for (const security of homeCurrencySecurities) {
    if (security.fyTotalsStatus !== "ok") {
      excludedSecurities.push({
        portfolioSecurityId: security.portfolioSecurityId,
        symbol: security.symbol,
        reason: "mixed_currency",
      });
      continue;
    }
    const yearTotal = security.fyTotals.find(
      (total) => total.endingYear === endingYear,
    );
    if (!yearTotal) continue; // no evidence for this security this year -- see the caller's own no-evidence handling
    if (yearTotal.cashDecimal === null) {
      excludedSecurities.push({
        portfolioSecurityId: security.portfolioSecurityId,
        symbol: security.symbol,
        reason: "unknown_amount",
      });
      continue;
    }
    includedCount += 1;
    anyKnown = true;
    if (yearTotal.source !== "actual") allActual = false;
    if (yearTotal.source !== "provider_estimate") allEstimate = false;
    cashTotal = addDecimal(cashTotal, parseDecimal(yearTotal.cashDecimal));
    if (yearTotal.frankingKnownDecimal !== null) {
      frankingTotal = addDecimal(
        frankingTotal,
        parseDecimal(yearTotal.frankingKnownDecimal),
      );
    } else {
      frankingIncomplete = true;
    }
  }
  return {
    excludedSecurities,
    includedCount,
    anyKnown,
    allActual,
    allEstimate,
    cashTotal,
    frankingTotal,
    frankingIncomplete,
  };
}

/**
 * Portfolio-level past-FY rows, precedence per TASKS.md: owner FY override
 * (`dividend_fy_overrides`, already a portfolio-scoped, portfolio-BASE-
 * CURRENCY figure -- used directly, no conversion) > sum of DIV-001's
 * already-precedence-resolved per-security FY totals > (nothing -- DIV-001
 * itself only returns a year when it has actual evidence, so there is no
 * separate "provider estimate" tier to apply again here beyond what DIV-001's
 * per-security `source` label already reflects).
 *
 * Scope decision (documented, mirrors DIV-001's own flagged follow-up in
 * `app/owned-dividend-history.ts`): summing per-security totals into ONE
 * portfolio dollar figure requires every contributing security to share one
 * currency, since dollar amounts (unlike percentages) cannot be blended
 * across currencies without an FX conversion this task does not implement
 * (DIV-001 explicitly left multi-currency FX-aware aggregation to a
 * consuming task). This function aggregates only securities denominated in
 * the portfolio's OWN base currency and EXCLUDES + NAMES every
 * foreign-currency security in `excludedSecurities` rather than silently
 * omitting or mis-converting it.
 *
 * A year where NO eligible security has any `fyTotals` entry at all is
 * reported as `dividendSource: "no_evidence"` with a `null` figure, never
 * an asserted `"actual"` `"0"` (follow-up 1): DIV-001's per-security totals
 * cannot distinguish "confirmed paid nothing" from "no data for that year"
 * (e.g. the year predates the security's own history), so this layer must
 * not assert the former. A genuine data problem for one security
 * (mixed-currency status, or a year whose amount is unknown) is a separate,
 * per-security exclusion, disclosed alongside whatever the other eligible
 * securities DO contribute for that year.
 */
export function computePastFinancialYearRows(
  input: ComputePastFinancialYearRowsInput,
): ComputePastFinancialYearRowsResult {
  if (
    !Number.isInteger(input.yearsBack) ||
    input.yearsBack < 0 ||
    input.yearsBack > MAX_YEARS
  ) {
    return { ok: false, reason: "invalid_years" };
  }
  const overrideByYear = new Map(
    input.portfolioFyOverrides.map((override) => [
      override.endingYear,
      override,
    ]),
  );
  const foreignSecurities = input.securities.filter(
    (security) => security.currencyCode !== input.baseCurrencyCode,
  );
  const homeCurrencySecurities = input.securities.filter(
    (security) => security.currencyCode === input.baseCurrencyCode,
  );

  const rows: PastFinancialYearRow[] = [];
  for (let yearsAgo = 1; yearsAgo <= input.yearsBack; yearsAgo += 1) {
    const endingYear = input.currentEndingYear - yearsAgo;
    const anchorMonth = input.startMonth;
    const anchorYear = anchorMonth === 1 ? endingYear : endingYear - 1;
    const anchorDate = `${String(anchorYear).padStart(4, "0")}-${String(anchorMonth).padStart(2, "0")}-01`;
    const windowResult = fyWindowForDate(anchorDate, input.startMonth);
    if (!windowResult.ok) {
      return { ok: false, reason: "invalid_start_month" };
    }

    const excludedSecurities: PastFyExclusion[] = foreignSecurities.map(
      (security) => ({
        portfolioSecurityId: security.portfolioSecurityId,
        symbol: security.symbol,
        reason: "foreign_currency" as const,
      }),
    );

    const override = overrideByYear.get(endingYear);
    if (override) {
      const dividendCashDecimal =
        override.frankingAmountDecimal !== null
          ? formatDecimalExact(
              subtractDecimal(
                parseDecimal(override.grossedAmountDecimal),
                parseDecimal(override.frankingAmountDecimal),
              ),
            )
          : override.grossedAmountDecimal;
      const portfolioValueDecimal =
        input.historicalPortfolioValueByYear.get(endingYear) ?? null;
      rows.push({
        endingYear,
        label: windowResult.label,
        window: windowResult.window,
        dividendSource: "fy_override",
        dividendGrossDecimal: override.grossedAmountDecimal,
        dividendCashDecimal,
        dividendFrankingKnownDecimal: override.frankingAmountDecimal,
        dividendFrankingIncomplete: override.frankingAmountDecimal === null,
        includedSecurityCount: 0,
        excludedSecurities,
        portfolioValueDecimal,
        valueStatus:
          portfolioValueDecimal === null ? "unavailable" : "available",
        effectiveYieldPercentDecimal:
          portfolioValueDecimal !== null &&
          compareDecimal(parseDecimal(portfolioValueDecimal), ZERO) > 0
            ? formatDecimalExact(
                roundDecimal(
                  multiplyDecimal(
                    divideDecimal(
                      parseDecimal(override.grossedAmountDecimal),
                      parseDecimal(portfolioValueDecimal),
                    ),
                    HUNDRED,
                  ),
                  PROJECTION_SCALE,
                ),
              )
            : null,
        method:
          "owner FY correction (replaces the derived total for this year)",
      });
      continue;
    }

    const totals = aggregateHomeCurrencySecuritiesForYear(
      homeCurrencySecurities,
      foreignSecurities,
      endingYear,
    );
    const grossTotal = addDecimal(totals.cashTotal, totals.frankingTotal);

    const hasEligibleSecurities = homeCurrencySecurities.length > 0;
    const dividendSource: PastFyDividendSource = !totals.anyKnown
      ? hasEligibleSecurities
        ? "no_evidence" // no eligible security has ANY fyTotals entry for this year -- never asserted as a confirmed "actual $0" (follow-up 1)
        : "unavailable"
      : totals.allActual
        ? "actual"
        : totals.allEstimate
          ? "provider_estimate"
          : "partially_estimated";
    const hasNoFigure =
      dividendSource === "unavailable" || dividendSource === "no_evidence";

    const portfolioValueDecimal =
      input.historicalPortfolioValueByYear.get(endingYear) ?? null;
    const dividendGrossDecimal = hasNoFigure
      ? null
      : formatDecimalExact(grossTotal);
    const dividendCashDecimal = hasNoFigure
      ? null
      : formatDecimalExact(totals.cashTotal);
    const dividendFrankingKnownDecimal = hasNoFigure
      ? null
      : formatDecimalExact(totals.frankingTotal);
    rows.push({
      endingYear,
      label: windowResult.label,
      window: windowResult.window,
      dividendSource,
      dividendGrossDecimal,
      dividendCashDecimal,
      dividendFrankingKnownDecimal,
      dividendFrankingIncomplete: totals.frankingIncomplete,
      includedSecurityCount: totals.includedCount,
      excludedSecurities: totals.excludedSecurities,
      portfolioValueDecimal,
      valueStatus: portfolioValueDecimal === null ? "unavailable" : "available",
      effectiveYieldPercentDecimal:
        dividendGrossDecimal !== null &&
        portfolioValueDecimal !== null &&
        compareDecimal(parseDecimal(portfolioValueDecimal), ZERO) > 0
          ? formatDecimalExact(
              roundDecimal(
                multiplyDecimal(
                  divideDecimal(
                    parseDecimal(dividendGrossDecimal),
                    parseDecimal(portfolioValueDecimal),
                  ),
                  HUNDRED,
                ),
                PROJECTION_SCALE,
              ),
            )
          : null,
      method:
        dividendSource === "unavailable"
          ? "no eligible (base-currency) security in this portfolio"
          : dividendSource === "no_evidence"
            ? "no dividend evidence for any eligible security this year -- may predate the security's own history or the ingested data; not asserted as a confirmed zero"
            : `sum of each security's own precedence-resolved FY total (${dividendSource})`,
    });
  }
  return { ok: true, rows };
}

// ---------------------------------------------------------------------------
// c2. Current (in-progress) financial-year row -- follow-up 2: the
// multi-year view otherwise has a gap between the last CLOSED past FY and
// the first FORWARD-projected FY, with nowhere to show what has actually
// happened so far this FY. This function itself is UNCHANGED by DIV-011: it
// still reports FY-TO-DATE actuals only (the current FY's share of DIV-001's
// already-precedence-resolved per-security totals), labelled as partial-year,
// never trying to forecast the remainder of the year itself (that would risk
// conflating a modelled estimate with what has actually been received so
// far). DIV-011 (owner directive, 2026-08-23): the SERVICE/UI layer
// (`app/owned-income-projection.ts`/`app/components/income-multi-year.tsx`)
// now pairs this function's output ALONGSIDE `projectMultiYearIncome`'s year
// 1 row (the current FY's forward-looking forecast, `startEndingYear + 1 ===
// currentEndingYear`) as ONE displayed "current FY" row -- actuals-to-date
// (this function, reused verbatim) shown next to, never summed into, the
// forward forecast composition (a different derivation over a different,
// rolling time window; summing would double-count/misstate). See DIV-011's
// completion note for the exact merged-row contract.
// ---------------------------------------------------------------------------

export type CurrentFinancialYearDividendSource =
  "fy_override" | "fy_to_date" | "no_evidence" | "unavailable";

export type CurrentFinancialYearRow = {
  endingYear: number;
  label: string;
  window: FyWindow;
  dividendSource: CurrentFinancialYearDividendSource;
  dividendGrossDecimal: string | null;
  dividendCashDecimal: string | null;
  dividendFrankingKnownDecimal: string | null;
  dividendFrankingIncomplete: boolean;
  includedSecurityCount: number;
  excludedSecurities: PastFyExclusion[];
  portfolioValueDecimal: string | null;
  /** Unlike a past (closed) year's snapshot-sourced value, the CURRENT value can be a `"partial"` known total (review finding B2 -- some holdings priced, some not) as well as fully `"available"` or `"unavailable"`. */
  valueStatus: "available" | "partial" | "unavailable";
  effectiveYieldPercentDecimal: string | null;
  method: string;
};

export type ComputeCurrentFinancialYearRowInput = {
  baseCurrencyCode: string;
  startMonth: number;
  currentEndingYear: number;
  securities: readonly PastFinancialYearSecurityInput[];
  portfolioFyOverrides: readonly FyDividendOverrideFact[];
  currentPortfolioValueDecimal: string | null;
  currentPortfolioValueStatus: "available" | "partial" | "unavailable";
};

export type ComputeCurrentFinancialYearRowResult =
  | { ok: true; row: CurrentFinancialYearRow }
  | { ok: false; reason: "invalid_start_month" };

/**
 * The current, still-open FY's row: same owner-FY-override-then-derived-sum
 * precedence and the same base-currency-only aggregation scope decision as
 * `computePastFinancialYearRows` (sharing `aggregateHomeCurrencySecuritiesForYear`),
 * but the derived tier is always labelled `"fy_to_date"` (never
 * `"actual"`/`"provider_estimate"`/`"partially_estimated"`, which this
 * module reserves for CLOSED years) since the year has not finished --
 * summing what DIV-001 already attributes to this FY is not the same claim
 * as a full year's total. `portfolioValueDecimal`/`valueStatus` come
 * directly from the CURRENT holdings value (not a historical snapshot),
 * including its own `"partial"` state when only some holdings are priced.
 */
export function computeCurrentFinancialYearRow(
  input: ComputeCurrentFinancialYearRowInput,
): ComputeCurrentFinancialYearRowResult {
  const endingYear = input.currentEndingYear;
  const anchorMonth = input.startMonth;
  const anchorYear = anchorMonth === 1 ? endingYear : endingYear - 1;
  const anchorDate = `${String(anchorYear).padStart(4, "0")}-${String(anchorMonth).padStart(2, "0")}-01`;
  const windowResult = fyWindowForDate(anchorDate, input.startMonth);
  if (!windowResult.ok) {
    return { ok: false, reason: "invalid_start_month" };
  }

  const foreignSecurities = input.securities.filter(
    (security) => security.currencyCode !== input.baseCurrencyCode,
  );
  const homeCurrencySecurities = input.securities.filter(
    (security) => security.currencyCode === input.baseCurrencyCode,
  );
  const portfolioValueDecimal =
    input.currentPortfolioValueStatus === "unavailable"
      ? null
      : input.currentPortfolioValueDecimal;

  const override = input.portfolioFyOverrides.find(
    (candidate) => candidate.endingYear === endingYear,
  );
  const partialValueNote =
    input.currentPortfolioValueStatus === "partial"
      ? " (current portfolio value is a partial known total -- see coverage)"
      : "";

  if (override) {
    const dividendCashDecimal =
      override.frankingAmountDecimal !== null
        ? formatDecimalExact(
            subtractDecimal(
              parseDecimal(override.grossedAmountDecimal),
              parseDecimal(override.frankingAmountDecimal),
            ),
          )
        : override.grossedAmountDecimal;
    return {
      ok: true,
      row: {
        endingYear,
        label: windowResult.label,
        window: windowResult.window,
        dividendSource: "fy_override",
        dividendGrossDecimal: override.grossedAmountDecimal,
        dividendCashDecimal,
        dividendFrankingKnownDecimal: override.frankingAmountDecimal,
        dividendFrankingIncomplete: override.frankingAmountDecimal === null,
        includedSecurityCount: 0,
        excludedSecurities: foreignSecurities.map((security) => ({
          portfolioSecurityId: security.portfolioSecurityId,
          symbol: security.symbol,
          reason: "foreign_currency" as const,
        })),
        portfolioValueDecimal,
        valueStatus: input.currentPortfolioValueStatus,
        effectiveYieldPercentDecimal:
          portfolioValueDecimal !== null &&
          compareDecimal(parseDecimal(portfolioValueDecimal), ZERO) > 0
            ? formatDecimalExact(
                roundDecimal(
                  multiplyDecimal(
                    divideDecimal(
                      parseDecimal(override.grossedAmountDecimal),
                      parseDecimal(portfolioValueDecimal),
                    ),
                    HUNDRED,
                  ),
                  PROJECTION_SCALE,
                ),
              )
            : null,
        method: `owner FY correction (replaces the FY-to-date total for this year)${partialValueNote}`,
      },
    };
  }

  const totals = aggregateHomeCurrencySecuritiesForYear(
    homeCurrencySecurities,
    foreignSecurities,
    endingYear,
  );
  const grossTotal = addDecimal(totals.cashTotal, totals.frankingTotal);
  const hasEligibleSecurities = homeCurrencySecurities.length > 0;
  const dividendSource: CurrentFinancialYearDividendSource = !totals.anyKnown
    ? hasEligibleSecurities
      ? "no_evidence"
      : "unavailable"
    : "fy_to_date";
  const hasNoFigure =
    dividendSource === "unavailable" || dividendSource === "no_evidence";
  const dividendGrossDecimal = hasNoFigure
    ? null
    : formatDecimalExact(grossTotal);
  const dividendCashDecimal = hasNoFigure
    ? null
    : formatDecimalExact(totals.cashTotal);
  const dividendFrankingKnownDecimal = hasNoFigure
    ? null
    : formatDecimalExact(totals.frankingTotal);

  return {
    ok: true,
    row: {
      endingYear,
      label: windowResult.label,
      window: windowResult.window,
      dividendSource,
      dividendGrossDecimal,
      dividendCashDecimal,
      dividendFrankingKnownDecimal,
      dividendFrankingIncomplete: totals.frankingIncomplete,
      includedSecurityCount: totals.includedCount,
      excludedSecurities: totals.excludedSecurities,
      portfolioValueDecimal,
      valueStatus: input.currentPortfolioValueStatus,
      effectiveYieldPercentDecimal:
        dividendGrossDecimal !== null &&
        portfolioValueDecimal !== null &&
        compareDecimal(parseDecimal(portfolioValueDecimal), ZERO) > 0
          ? formatDecimalExact(
              roundDecimal(
                multiplyDecimal(
                  divideDecimal(
                    parseDecimal(dividendGrossDecimal),
                    parseDecimal(portfolioValueDecimal),
                  ),
                  HUNDRED,
                ),
                PROJECTION_SCALE,
              ),
            )
          : null,
      method:
        dividendSource === "unavailable"
          ? "no eligible (base-currency) security in this portfolio"
          : dividendSource === "no_evidence"
            ? "no dividend evidence yet for any eligible security this financial year"
            : `financial-year-to-date total (not a full-year figure)${partialValueNote}`,
    },
  };
}

// ---------------------------------------------------------------------------
// d. Single-12-month breakdown.
// ---------------------------------------------------------------------------

export type IncomeBreakdownStatus = "ok" | "partial" | "no_coverage";

export type IncomeBreakdownExclusionReason =
  "insufficient_history" | "foreign_currency";

export type IncomeBreakdownExclusion = {
  portfolioSecurityId: string;
  symbol: string;
  reason: IncomeBreakdownExclusionReason;
};

/**
 * DIV-006 review follow-up (MATERIAL): a security whose forecast's history-
 * derived TTM leg is only PARTIALLY determinable (`SecurityDividendForecast.ttmIncomplete
 * === true` -- some trailing-window history rows had no determinable
 * per-share rate, see `forecast.ts`'s `deriveHistoryTrailingTwelveMonthDividend`)
 * still has a real, non-null `totalGrossDecimal` and so is INCLUDED in the
 * sums below (never excluded/dropped a second time -- the row-level
 * incompleteness is already honestly disclosed by not fabricating the
 * missing rows' contribution as 0). Pre-DIV-006 there was no such
 * in-between state: a security either had a full, complete TTM figure or
 * was excluded outright as `insufficient_history`. Named here (mirroring
 * `excludedSecurities`'s own disclosure convention) so a consumer can warn
 * that the aggregate total may UNDERSTATE true income for these securities,
 * rather than silently presenting the partial sum as a complete one.
 */
export type IncomeBreakdownPartialTtmSecurity = {
  portfolioSecurityId: string;
  symbol: string;
};

export type IncomeBreakdownResult = {
  status: IncomeBreakdownStatus;
  currencyCode: string;
  totalGrossDecimal: string | null;
  totalCashDecimal: string | null;
  totalFrankingKnownDecimal: string | null;
  totalFrankingIncomplete: boolean;
  averagePerMonthDecimal: string | null;
  averagePerWeekDecimal: string | null;
  incomePercentOfValueDecimal: string | null;
  /**
   * Mirrors the CALLER-supplied `currentPortfolioValueStatus` whenever a
   * percent was computed (review finding B2): `"partial"` means the
   * denominator is a real but UNDERSTATED known total (some holdings
   * unpriced), so `incomePercentOfValueDecimal` may read higher than the
   * true figure -- it is still the honest best-known number, not
   * fabricated, but must not be presented as exact. `"unavailable"` when
   * there was no usable value at all (`incomePercentOfValueDecimal` is then
   * always `null`).
   */
  incomePercentOfValueStatus: "available" | "partial" | "unavailable";
  includedSecurityCount: number;
  excludedSecurities: IncomeBreakdownExclusion[];
  /** DIV-006 review follow-up: INCLUDED securities (not excluded -- see `excludedSecurities`) whose contribution to the totals above is only partially known. `status` is `"partial"` whenever this is non-empty, even if `excludedSecurities` is empty. */
  partialTtmSecurities: IncomeBreakdownPartialTtmSecurity[];
  method: string;
};

export type IncomeBreakdownSecurityInput = {
  portfolioSecurityId: string;
  symbol: string;
  currencyCode: string;
  forecast: SecurityDividendForecast;
};

/**
 * Aggregates DIV-001's per-security 12-month baseline forecasts
 * (`computeSecurityDividendForecast`) into one portfolio-level breakdown.
 * Same base-currency-only aggregation scope decision as
 * `computePastFinancialYearRows` (dollar totals cannot cross currencies
 * without FX, which this task does not implement) -- a foreign-currency
 * security is excluded and NAMED, never mis-summed. A security whose
 * forecast is `"insufficient_history"` (no usable declared or TTM data --
 * `totalGrossDecimal: null`) is likewise excluded and named, the concrete
 * form of TASKS.md's "a security with no dividend history and no override
 * contributes `insufficient history`, not zero, and the total discloses
 * partial coverage". A security with a zero forecast because it currently
 * holds no shares (`status: "no_current_holding"`) is a REAL fact and
 * contributes an honest 0, not an exclusion.
 *
 * DIV-011 (owner directive, 2026-08-23): this result is now ALSO the
 * multi-year projection's year-1 base (`MultiYearProjectionAssumptions.baseForecastGrossDecimal`/
 * `baseForecastCashDecimal`, `app/owned-income-projection.ts`) -- one
 * derivation, reused verbatim by that caller, never re-derived from a
 * separate portfolio-level yield the way the multi-year base used to be.
 */
export function computeIncomeBreakdown(input: {
  baseCurrencyCode: string;
  currentPortfolioValueDecimal: string | null;
  /** Whether `currentPortfolioValueDecimal` is a complete known total, a partial (understated) known total, or unavailable -- see `incomePercentOfValueStatus` (review finding B2). */
  currentPortfolioValueStatus: "available" | "partial" | "unavailable";
  securities: readonly IncomeBreakdownSecurityInput[];
}): IncomeBreakdownResult {
  const excludedSecurities: IncomeBreakdownExclusion[] = [];
  const partialTtmSecurities: IncomeBreakdownPartialTtmSecurity[] = [];
  let includedCount = 0;
  let grossTotal = ZERO;
  let cashTotal = ZERO;
  let frankingTotal = ZERO;
  let frankingIncomplete = false;
  for (const security of input.securities) {
    if (security.currencyCode !== input.baseCurrencyCode) {
      excludedSecurities.push({
        portfolioSecurityId: security.portfolioSecurityId,
        symbol: security.symbol,
        reason: "foreign_currency",
      });
      continue;
    }
    if (security.forecast.totalGrossDecimal === null) {
      excludedSecurities.push({
        portfolioSecurityId: security.portfolioSecurityId,
        symbol: security.symbol,
        reason: "insufficient_history",
      });
      continue;
    }
    includedCount += 1;
    grossTotal = addDecimal(
      grossTotal,
      parseDecimal(security.forecast.totalGrossDecimal),
    );
    cashTotal = addDecimal(
      cashTotal,
      parseDecimal(security.forecast.totalCashDecimal ?? "0"),
    );
    if (security.forecast.totalFrankingKnownDecimal !== null) {
      frankingTotal = addDecimal(
        frankingTotal,
        parseDecimal(security.forecast.totalFrankingKnownDecimal),
      );
    }
    if (security.forecast.totalFrankingIncomplete) frankingIncomplete = true;
    // DIV-006 review follow-up: this security IS included above (it has a
    // real `totalGrossDecimal`), but that figure's history-TTM leg may be
    // understated -- disclose it distinctly from `excludedSecurities`
    // rather than silently presenting the partial sum as complete.
    //
    // DIV-009 review fix (round-2, BLOCKING): `ttmIncomplete` alone is NOT
    // enough to gate this -- since DIV-009's B2 fix, `ttmIncomplete` can be
    // `true` on a forecast whose TOTAL never consulted the TTM at all (a
    // `fully_covered_by_declared` forecast, whose total is purely declared
    // events; or the rarer "neither leg usable but declared coverage
    // exists" case, whose total is likewise purely declared). Pushing on
    // the flag alone there would report a purely-declared, fully-known
    // total as "may understate true income", contradicting
    // `IncomeBreakdownPartialTtmSecurity`'s own contract. The TTM only
    // ACTUALLY feeds `totalGrossDecimal` in the `"declared_plus_ttm"`
    // status with a resolved `ttmSource` (the branch that computes
    // `uncoveredCashDecimal` from the annualised TTM rate) -- gate on that,
    // not the flag alone.
    if (
      security.forecast.status === "declared_plus_ttm" &&
      security.forecast.ttmSource !== null &&
      security.forecast.ttmIncomplete
    ) {
      partialTtmSecurities.push({
        portfolioSecurityId: security.portfolioSecurityId,
        symbol: security.symbol,
      });
    }
  }

  if (includedCount === 0) {
    return {
      status: "no_coverage",
      currencyCode: input.baseCurrencyCode,
      totalGrossDecimal: null,
      totalCashDecimal: null,
      totalFrankingKnownDecimal: null,
      totalFrankingIncomplete: false,
      averagePerMonthDecimal: null,
      averagePerWeekDecimal: null,
      incomePercentOfValueDecimal: null,
      incomePercentOfValueStatus: "unavailable",
      includedSecurityCount: 0,
      excludedSecurities,
      partialTtmSecurities: [],
      method: "no held security has a usable 12-month forecast",
    };
  }

  const totalGrossDecimal = formatDecimalExact(grossTotal);
  const totalCashDecimal = formatDecimalExact(cashTotal);
  const totalFrankingKnownDecimal = formatDecimalExact(frankingTotal);
  // Divisor convention: "average per month" = gross / 12 (calendar months in
  // the 12-month forecast window); "average per week" = gross / 52 (the
  // standard 52-week approximation of a year -- NOT 365/7 = 52.14..., a
  // deliberate, documented simplification matching common personal-finance
  // convention rather than a more precise but less familiar divisor).
  const averagePerMonthDecimal = formatDecimalExact(
    roundDecimal(divideDecimal(grossTotal, fromInteger(12n)), PROJECTION_SCALE),
  );
  const averagePerWeekDecimal = formatDecimalExact(
    roundDecimal(divideDecimal(grossTotal, fromInteger(52n)), PROJECTION_SCALE),
  );
  const currentValue =
    input.currentPortfolioValueDecimal !== null
      ? parseDecimal(input.currentPortfolioValueDecimal)
      : null;
  const incomePercentOfValueComputed =
    currentValue !== null && compareDecimal(currentValue, ZERO) > 0;
  const incomePercentOfValueDecimal = incomePercentOfValueComputed
    ? formatDecimalExact(
        roundDecimal(
          multiplyDecimal(divideDecimal(grossTotal, currentValue!), HUNDRED),
          PROJECTION_SCALE,
        ),
      )
    : null;
  // The percent's own status mirrors the caller's denominator status ONLY
  // when a percent was actually computed -- a `"partial"` current value
  // that turned out to be non-positive (or absent) still correctly reports
  // `"unavailable"` here, matching `incomePercentOfValueDecimal: null`.
  const incomePercentOfValueStatus: IncomeBreakdownResult["incomePercentOfValueStatus"] =
    incomePercentOfValueComputed
      ? input.currentPortfolioValueStatus === "unavailable"
        ? // Contradictory input: a positive value was supplied alongside
          // `"unavailable"` -- a well-behaved caller should never produce
          // this, but the CONSERVATIVE label under an internal
          // contradiction is "unavailable" (round-2 review correction:
          // this previously defaulted to "available", the confident
          // label, on a contradiction it could not actually verify),
          // never the confident one.
          "unavailable"
        : input.currentPortfolioValueStatus
      : "unavailable";

  // DIV-006 review follow-up: a security with a partially-determinable
  // history TTM is INCLUDED (not excluded), but its contribution to the
  // totals above may understate true income -- `status` must reflect that
  // exactly like an exclusion does, even when nothing was excluded outright.
  const hasPartialCoverage =
    excludedSecurities.length > 0 || partialTtmSecurities.length > 0;
  return {
    status: hasPartialCoverage ? "partial" : "ok",
    currencyCode: input.baseCurrencyCode,
    totalGrossDecimal,
    totalCashDecimal,
    totalFrankingKnownDecimal,
    totalFrankingIncomplete: frankingIncomplete,
    averagePerMonthDecimal,
    averagePerWeekDecimal,
    incomePercentOfValueDecimal,
    incomePercentOfValueStatus,
    includedSecurityCount: includedCount,
    excludedSecurities,
    partialTtmSecurities,
    method: (() => {
      if (!hasPartialCoverage) {
        return "sum of every held security's 12-month baseline forecast (gross, includes franking credits)";
      }
      const clauses: string[] = [];
      if (excludedSecurities.length > 0) {
        clauses.push(
          `${excludedSecurities.length} excluded (named) for insufficient history or a foreign currency`,
        );
      }
      if (partialTtmSecurities.length > 0) {
        clauses.push(
          `${partialTtmSecurities.length} included but with an only partially determinable trailing-twelve-month figure (named) -- may understate true income`,
        );
      }
      return `sum of ${includedCount} of ${includedCount + excludedSecurities.length} held securities' 12-month forecasts; ${clauses.join("; ")}`;
    })(),
  };
}

// ---------------------------------------------------------------------------
// e. UI-046: "Last 12 Months" (rolling, ACTUAL) and "FY{yy} Estimate" (FY-to-
// date actuals + an evidence-based projection for the FY's remaining days)
// rows on the Next 12 Months screen's "Recent financial years" table.
//
// B1 (Orchestrator ruling, blocking review finding -- a reproduced real
// double-count: one declared $100 dividend inflated the estimate to $200).
// ROOT CAUSE: the original design summed `computeCurrentFinancialYearRow`'s
// FY-to-date total (which attributes every history row -- REGARDLESS OF
// STATUS -- to the current FY via `paymentDate ?? exDate`) with the
// remainder forecast's own declared-near-certain leg. A `declared_pending`
// row commonly carries a real, provider-supplied FUTURE payment date
// alongside its future ex-date -- so `computeFyDividendTotals` attributed
// its cash to "so far" via that payment date, while the SAME row's ex-date
// falling inside the remainder window ALSO fed the forecast's declared leg:
// one event, two legs, double cash.
//
// FIX: PARTITION BY EVENT so every history row feeds the estimate through
// EXACTLY ONE of three disjoint legs, keyed off `status` (a pure function
// of `exDate <= today`, see `history.ts`'s `lifecycleStatus`) and, for an
// ex-date-passed row, whether payment has actually landed:
//   1. RECEIVED -- `status: "ex_date_passed"` AND a known `paymentDate`
//      that is `<= today` (cash literally in hand). Attributed by
//      `paymentDate` into the current FY window.
//   2. GAP -- `status: "ex_date_passed"` but NOT (1): the ex-date has
//      passed (economically committed) but payment has not yet posted
//      (`paymentDate` unknown, or known but still in the future -- the
//      reviewer's exact repro shape: ex 2026-08-01, pay 2026-09-20, today
//      2026-08-13). Without this bucket such a row falls through BOTH the
//      RECEIVED leg (fails the `paymentDate <= today` test) AND the
//      REMAINDER leg's declared-near-certain sum (`computeSecurityDividendForecast`
//      only ever considers `status: "declared_pending"` rows -- a row whose
//      ex-date has already passed can never be `declared_pending` again),
//      silently vanishing from the estimate entirely. Attributed by the
//      established DIV-001 `paymentDate ?? exDate` fallback.
//   3. REMAINDER -- `status: "declared_pending"` (ex-date still in the
//      future) plus the uncovered-tail trailing-twelve-month estimate --
//      `computeSecurityDividendForecast`'s EXISTING composition, unchanged,
//      fed via `remainderBreakdown` (`computeIncomeBreakdown` over each
//      security's FY-remainder-windowed forecast, computed by the caller
//      and reused verbatim here -- one aggregation, not re-derived).
// (1) and (2) partition every `"ex_date_passed"` row exactly once (mutually
// exclusive by construction: a row's known-and-past-payment-date test
// either holds or it doesn't). (3) can never overlap either leg, since
// `"declared_pending"` and `"ex_date_passed"` are themselves mutually
// exclusive statuses on any one row.
//
// ONE-DAY SEAM: `app/owned-dividend-history.ts` starts the remainder
// forecast's own window at `today + 1`, not `today`
// (`ComputeSecurityForecastInput.windowFromDate`) -- otherwise the forward
// leg's smooth per-day trailing-twelve-month proration would implicitly
// claim a fractional share of "today" on top of whatever (1)/(2) already
// counted for that exact day. A row with `exDate === today` cannot be
// `"declared_pending"` at all (the SAME `<=` boundary that ends the
// backward RECEIVED/GAP legs' eligibility on `today` is also what flips
// such a row's status to `"ex_date_passed"`), so it can only ever land in
// (1) or (2) above -- never the remainder's declared leg -- independent of
// the window shift; the shift's own job is purely to stop the SEPARATE
// smooth TTM-tail estimate (which has no per-event awareness at all) from
// also crediting "today" a second, statistical time.
//
// Both new rows reuse existing aggregation machinery rather than a second
// formula: the trailing row and the RECEIVED/GAP legs all window/status-
// filter raw history rows through `computeLifetimeDividendTotals` (DIV-001,
// `aggregations.ts`) -- the exact aggregation the past-FY rows already rely
// on; the REMAINDER leg reuses `computeIncomeBreakdown` verbatim, fed a
// second, differently-windowed forecast.
// ---------------------------------------------------------------------------

function subtractDaysUi046(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

// Mirrors `forecast.ts`'s identically-named/valued `TRAILING_WINDOW_DAYS`
// and its exact inclusive-both-ends boundary (`asOfDate - 365` through
// `asOfDate`) -- duplicated rather than imported, matching this codebase's
// established convention of re-deriving small date primitives per module
// (see `forecast.ts`'s own header on this). Using the IDENTICAL boundary
// here is deliberate: this row and the Next 12 Months headline's own
// history-TTM fallback must agree on what "last 12 months"/"trailing
// twelve months" means, or the two adjacent figures would silently use
// different windows.
const UI046_TRAILING_WINDOW_DAYS = 365;

export type TrailingTwelveMonthActualStatus = "ok" | "unavailable";

export type TrailingTwelveMonthActualExclusionReason =
  | "foreign_currency"
  | "mixed_currency"
  /** This security has NO derived dividend history rows at all (ever) --
   * distinct from a security with real history but nothing paid in the
   * trailing window (a genuine, disclosed "0" contribution -- see the
   * function doc comment). Mirrors `computePastFinancialYearRows`'
   * `"no_evidence"` reasoning, applied per-security instead of per-year. */
  | "no_evidence";

export type TrailingTwelveMonthActualExclusion = {
  portfolioSecurityId: string;
  symbol: string;
  reason: TrailingTwelveMonthActualExclusionReason;
};

export type TrailingTwelveMonthActualRow = {
  windowFromDate: string;
  windowToDate: string;
  status: TrailingTwelveMonthActualStatus;
  dividendGrossDecimal: string | null;
  dividendCashDecimal: string | null;
  dividendFrankingKnownDecimal: string | null;
  dividendFrankingIncomplete: boolean;
  /** B2 (review finding): `true` whenever at least one included security
   * had a windowed RECEIVED row whose CASH amount is genuinely unknown --
   * `computeLifetimeDividendTotals` already excludes that row from the
   * sums above (never fabricated as "0"), but its existence must never be
   * silently invisible behind a confident `status: "ok"` total. Rendered
   * the same "· partial" way `dividendFrankingIncomplete` already is. */
  dividendAmountIncomplete: boolean;
  includedSecurityCount: number;
  excludedSecurities: TrailingTwelveMonthActualExclusion[];
};

export type TrailingTwelveMonthActualSecurityInput = {
  portfolioSecurityId: string;
  symbol: string;
  currencyCode: string;
  /** This security's full derived dividend history rows (DIV-001) --
   * window-filtered internally to the trailing 365 days; an EMPTY array
   * (no history at all, ever) is distinguished from "has history but none
   * fell in the window" (see `TrailingTwelveMonthActualExclusionReason`). */
  rows: readonly DerivedDividendRow[];
};

/**
 * Portfolio-level "Last 12 Months" row: the sum of ACTUAL (received,
 * `status: "ex_date_passed"`, non-excluded) dividend cash/franking across
 * every base-currency held security over the trailing 365 days ending
 * `asOfDate` -- never a projection, never TTM-annualised. Same
 * base-currency-only aggregation scope as `computePastFinancialYearRows`/
 * `computeIncomeBreakdown` (a foreign-currency security is excluded and
 * named, never mis-summed or silently converted).
 *
 * A security with an EMPTY history (`rows.length === 0`) is excluded and
 * named `"no_evidence"` -- AGENTS.md's "missing data is never zero" applies
 * here exactly as it does to `computePastFinancialYearRows`' identically-
 * motivated distinction: a security with literally no imported/derived
 * dividend record could mean "genuinely never paid" or "history not yet
 * imported", and this layer cannot tell which. A security that DOES have
 * real history somewhere (even outside the trailing window) but nothing
 * fell inside it is a real, CONFIRMED fact -- it received nothing in the
 * last 12 months -- and contributes an honest "0", not an exclusion.
 */
export function computeTrailingTwelveMonthActualDividendRow(input: {
  baseCurrencyCode: string;
  asOfDate: string;
  securities: readonly TrailingTwelveMonthActualSecurityInput[];
}): TrailingTwelveMonthActualRow {
  const windowFromDate = subtractDaysUi046(
    input.asOfDate,
    UI046_TRAILING_WINDOW_DAYS,
  );
  const windowToDate = input.asOfDate;
  const foreignSecurities = input.securities.filter(
    (security) => security.currencyCode !== input.baseCurrencyCode,
  );
  const homeCurrencySecurities = input.securities.filter(
    (security) => security.currencyCode === input.baseCurrencyCode,
  );
  const excludedSecurities: TrailingTwelveMonthActualExclusion[] =
    foreignSecurities.map((security) => ({
      portfolioSecurityId: security.portfolioSecurityId,
      symbol: security.symbol,
      reason: "foreign_currency" as const,
    }));

  let includedCount = 0;
  let cashTotal = ZERO;
  let frankingTotal = ZERO;
  let frankingIncomplete = false;
  let amountIncomplete = false;
  for (const security of homeCurrencySecurities) {
    if (security.rows.length === 0) {
      excludedSecurities.push({
        portfolioSecurityId: security.portfolioSecurityId,
        symbol: security.symbol,
        reason: "no_evidence",
      });
      continue;
    }
    const windowedRows = security.rows.filter((row) => {
      if (row.status !== "ex_date_passed" || row.excluded) return false;
      const date = row.paymentDate ?? row.exDate;
      return date !== null && date >= windowFromDate && date <= windowToDate;
    });
    const totals = computeLifetimeDividendTotals(
      windowedRows,
      security.currencyCode,
    );
    if (totals.status === "mixed_currency") {
      excludedSecurities.push({
        portfolioSecurityId: security.portfolioSecurityId,
        symbol: security.symbol,
        reason: "mixed_currency",
      });
      continue;
    }
    includedCount += 1;
    cashTotal = addDecimal(
      cashTotal,
      parseDecimal(totals.receivedCashDecimal ?? "0"),
    );
    if (totals.receivedFrankingKnownDecimal !== null) {
      frankingTotal = addDecimal(
        frankingTotal,
        parseDecimal(totals.receivedFrankingKnownDecimal),
      );
    }
    if (totals.receivedFrankingUnknownCount > 0) frankingIncomplete = true;
    // B2 (review finding): every row reaching `windowedRows` already has
    // `status: "ex_date_passed"`, so any `unknownAmountCount` here is
    // exclusively a RECEIVED-row cash-amount gap -- excluded from the sum
    // above, never fabricated, but must not stay invisible under a
    // confident `status: "ok"`.
    if (totals.unknownAmountCount > 0) amountIncomplete = true;
  }

  if (includedCount === 0) {
    return {
      windowFromDate,
      windowToDate,
      status: "unavailable",
      dividendGrossDecimal: null,
      dividendCashDecimal: null,
      dividendFrankingKnownDecimal: null,
      dividendFrankingIncomplete: false,
      dividendAmountIncomplete: false,
      includedSecurityCount: 0,
      excludedSecurities,
    };
  }

  const dividendCashDecimal = formatDecimalExact(cashTotal);
  const dividendFrankingKnownDecimal = formatDecimalExact(frankingTotal);
  return {
    windowFromDate,
    windowToDate,
    status: "ok",
    dividendGrossDecimal: formatDecimalExact(
      addDecimal(cashTotal, frankingTotal),
    ),
    dividendCashDecimal,
    dividendFrankingKnownDecimal,
    dividendFrankingIncomplete: frankingIncomplete,
    dividendAmountIncomplete: amountIncomplete,
    includedSecurityCount: includedCount,
    excludedSecurities,
  };
}

export type CurrentFinancialYearEstimateStatus =
  "ok" | "partial" | "unavailable";

export type CurrentFinancialYearEstimateExclusionReason =
  PastFyExclusionReason | IncomeBreakdownExclusionReason;

export type CurrentFinancialYearEstimateExclusion = {
  portfolioSecurityId: string;
  symbol: string;
  reason: CurrentFinancialYearEstimateExclusionReason;
};

export type CurrentFinancialYearEstimateRow = {
  endingYear: number;
  label: string;
  status: CurrentFinancialYearEstimateStatus;
  dividendGrossDecimal: string | null;
  dividendCashDecimal: string | null;
  dividendFrankingKnownDecimal: string | null;
  dividendFrankingIncomplete: boolean;
  /** B2-style disclosure (Orchestrator ruling): `true` whenever the
   * RECEIVED or GAP leg (computed directly from history rows below)
   * excluded at least one row because its own cash amount is genuinely
   * unknown -- a real, non-fabricated total that may still understate true
   * income. Rendered the same "· partial" way `dividendFrankingIncomplete`
   * already is. */
  dividendAmountIncomplete: boolean;
  excludedSecurities: CurrentFinancialYearEstimateExclusion[];
  /** Included securities whose REMAINDER-of-FY forecast leg is only
   * partially known (mirrors `IncomeBreakdownResult.partialTtmSecurities`
   * exactly -- reused, not re-derived). */
  partialTtmSecurities: IncomeBreakdownPartialTtmSecurity[];
  method: string;
};

export type ComputeCurrentFinancialYearEstimateRowResult =
  | { ok: true; row: CurrentFinancialYearEstimateRow }
  | { ok: false; reason: "invalid_start_month" };

export type CurrentFinancialYearEstimateSecurityInput = {
  portfolioSecurityId: string;
  symbol: string;
  currencyCode: string;
  /** This security's full derived dividend history rows (DIV-001). The
   * RECEIVED and GAP legs below status/date-filter these directly --
   * deliberately NEVER `computeFyDividendTotals`'s own already-aggregated
   * (`paymentDate ?? exDate`)-attributed total, which sums rows regardless
   * of status and so can double-count a `declared_pending` row (one whose
   * provider-supplied payment date is already known) against the REMAINDER
   * leg's own declared-near-certain sum (B1). */
  rows: readonly DerivedDividendRow[];
};

function sumNullableDecimals(
  left: string | null,
  right: string | null,
): string {
  return formatDecimalExact(
    addDecimal(parseDecimal(left ?? "0"), parseDecimal(right ?? "0")),
  );
}

/**
 * "FY{yy} Estimate" row: the current financial year's full-year estimate,
 * PARTITIONED BY EVENT (B1 fix) so no dividend ever contributes twice --
 * see this section's header comment for the full three-way (RECEIVED / GAP
 * / REMAINDER) partition and why the naive "FY-to-date total + remainder
 * forecast" design double-counted a declared-but-not-yet-paid event.
 *
 * RECEIVED and GAP are computed HERE, directly from each security's raw
 * history rows (`input.securities[].rows`) -- reusing `computeLifetimeDividendTotals`
 * (DIV-001, `aggregations.ts`) per bucket, never a second cash-summing
 * formula. REMAINDER is the caller-supplied `remainderBreakdown`
 * (`computeIncomeBreakdown` fed each security's FY-remainder-windowed
 * forecast, windowed to `today + 1` through the FY's calendar end date) --
 * reused verbatim, not re-derived.
 *
 * `ok: false` only when the current FY's calendar window itself cannot be
 * resolved (`invalid_start_month`) -- the identical failure
 * `computeCurrentFinancialYearRow`/`computePastFinancialYearRows` report
 * for the same underlying reason.
 */
export function computeCurrentFinancialYearEstimateRow(input: {
  baseCurrencyCode: string;
  startMonth: number;
  currentEndingYear: number;
  today: string;
  securities: readonly CurrentFinancialYearEstimateSecurityInput[];
  remainderBreakdown: IncomeBreakdownResult;
}): ComputeCurrentFinancialYearEstimateRowResult {
  const anchorMonth = input.startMonth;
  const anchorYear =
    anchorMonth === 1 ? input.currentEndingYear : input.currentEndingYear - 1;
  const anchorDate = `${String(anchorYear).padStart(4, "0")}-${String(anchorMonth).padStart(2, "0")}-01`;
  const windowResult = fyWindowForDate(anchorDate, input.startMonth);
  if (!windowResult.ok) {
    return { ok: false, reason: "invalid_start_month" };
  }
  const window = windowResult.window;

  const foreignSecurities = input.securities.filter(
    (security) => security.currencyCode !== input.baseCurrencyCode,
  );
  const homeCurrencySecurities = input.securities.filter(
    (security) => security.currencyCode === input.baseCurrencyCode,
  );

  const seen = new Set<string>();
  const excludedSecurities: CurrentFinancialYearEstimateExclusion[] = [];
  function addExclusion(
    portfolioSecurityId: string,
    symbol: string,
    reason: CurrentFinancialYearEstimateExclusionReason,
  ): void {
    const key = `${portfolioSecurityId}:${reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    excludedSecurities.push({ portfolioSecurityId, symbol, reason });
  }
  for (const security of foreignSecurities) {
    addExclusion(
      security.portfolioSecurityId,
      security.symbol,
      "foreign_currency",
    );
  }
  // The REMAINDER leg's own exclusions (foreign-currency or
  // insufficient-history securities in the `computeIncomeBreakdown` call
  // the caller already ran) are folded in here too, de-duplicated against
  // the ones this function names itself.
  for (const security of input.remainderBreakdown.excludedSecurities) {
    addExclusion(
      security.portfolioSecurityId,
      security.symbol,
      security.reason,
    );
  }

  let cashTotal = ZERO;
  let frankingTotal = ZERO;
  let frankingIncomplete = false;
  let amountIncomplete = false;
  for (const security of homeCurrencySecurities) {
    // RECEIVED: cash literally in hand -- `ex_date_passed` AND a known
    // payment date on or before today, attributed by that payment date.
    const receivedRows = security.rows.filter((row) => {
      if (row.status !== "ex_date_passed" || row.excluded) return false;
      if (row.paymentDate === null || row.paymentDate > input.today) {
        return false;
      }
      return (
        row.paymentDate >= window.startDate && row.paymentDate <= window.endDate
      );
    });
    // GAP: the ex-date has passed (economically committed) but payment has
    // not yet posted (unknown, or known but still in the future) -- see
    // this section's header comment for why this bucket exists at all.
    // Explicitly re-excludes anything the RECEIVED filter above already
    // claimed, so the two sets are disjoint by construction, not merely by
    // convention.
    const gapRows = security.rows.filter((row) => {
      if (row.status !== "ex_date_passed" || row.excluded) return false;
      if (row.paymentDate !== null && row.paymentDate <= input.today) {
        return false; // already counted as RECEIVED
      }
      const attributionDate = row.paymentDate ?? row.exDate;
      return (
        attributionDate !== null &&
        attributionDate >= window.startDate &&
        attributionDate <= window.endDate
      );
    });

    const receivedTotals = computeLifetimeDividendTotals(
      receivedRows,
      security.currencyCode,
    );
    const gapTotals = computeLifetimeDividendTotals(
      gapRows,
      security.currencyCode,
    );
    if (
      receivedTotals.status === "mixed_currency" ||
      gapTotals.status === "mixed_currency"
    ) {
      addExclusion(
        security.portfolioSecurityId,
        security.symbol,
        "mixed_currency",
      );
      continue;
    }
    cashTotal = addDecimal(
      cashTotal,
      parseDecimal(receivedTotals.receivedCashDecimal ?? "0"),
    );
    cashTotal = addDecimal(
      cashTotal,
      parseDecimal(gapTotals.receivedCashDecimal ?? "0"),
    );
    if (receivedTotals.receivedFrankingKnownDecimal !== null) {
      frankingTotal = addDecimal(
        frankingTotal,
        parseDecimal(receivedTotals.receivedFrankingKnownDecimal),
      );
    }
    if (gapTotals.receivedFrankingKnownDecimal !== null) {
      frankingTotal = addDecimal(
        frankingTotal,
        parseDecimal(gapTotals.receivedFrankingKnownDecimal),
      );
    }
    if (
      receivedTotals.receivedFrankingUnknownCount > 0 ||
      gapTotals.receivedFrankingUnknownCount > 0
    ) {
      frankingIncomplete = true;
    }
    // B2-style disclosure: a RECEIVED-or-GAP row whose CASH amount is
    // itself unknown is excluded from the sum above (never fabricated),
    // but must not stay invisible under a confident total.
    if (
      receivedTotals.unknownAmountCount > 0 ||
      gapTotals.unknownAmountCount > 0
    ) {
      amountIncomplete = true;
    }
  }

  const remainder = input.remainderBreakdown;
  const receivedGapAvailable = homeCurrencySecurities.length > 0;
  const remainderHasFigure = remainder.totalGrossDecimal !== null;
  const receivedGapCashDecimal = receivedGapAvailable
    ? formatDecimalExact(cashTotal)
    : null;
  const receivedGapFrankingDecimal = receivedGapAvailable
    ? formatDecimalExact(frankingTotal)
    : null;
  const receivedGapGrossDecimal = receivedGapAvailable
    ? formatDecimalExact(addDecimal(cashTotal, frankingTotal))
    : null;

  if (!receivedGapAvailable && !remainderHasFigure) {
    return {
      ok: true,
      row: {
        endingYear: windowResult.endingYear,
        label: windowResult.label,
        status: "unavailable",
        dividendGrossDecimal: null,
        dividendCashDecimal: null,
        dividendFrankingKnownDecimal: null,
        dividendFrankingIncomplete: true,
        dividendAmountIncomplete: false,
        excludedSecurities,
        partialTtmSecurities: [],
        method:
          "no eligible (base-currency) security for this financial year, and no usable evidence-based projection for its remaining days",
      },
    };
  }

  const dividendGrossDecimal = sumNullableDecimals(
    receivedGapGrossDecimal,
    remainder.totalGrossDecimal,
  );
  const dividendCashDecimal = sumNullableDecimals(
    receivedGapCashDecimal,
    remainder.totalCashDecimal,
  );
  const dividendFrankingKnownDecimal = sumNullableDecimals(
    receivedGapFrankingDecimal,
    remainder.totalFrankingKnownDecimal,
  );
  const dividendFrankingIncomplete =
    frankingIncomplete ||
    remainder.totalFrankingIncomplete ||
    !receivedGapAvailable ||
    !remainderHasFigure;
  const status: CurrentFinancialYearEstimateStatus =
    excludedSecurities.length > 0 ||
    amountIncomplete ||
    remainder.partialTtmSecurities.length > 0 ||
    !receivedGapAvailable ||
    !remainderHasFigure
      ? "partial"
      : "ok";

  return {
    ok: true,
    row: {
      endingYear: windowResult.endingYear,
      label: windowResult.label,
      status,
      dividendGrossDecimal,
      dividendCashDecimal,
      dividendFrankingKnownDecimal,
      dividendFrankingIncomplete,
      dividendAmountIncomplete: amountIncomplete,
      excludedSecurities,
      partialTtmSecurities: remainder.partialTtmSecurities,
      method: `received-plus-pending-declared actuals for the financial year so far${receivedGapAvailable ? "" : " (unavailable)"} plus an evidence-based projection for its remaining days${remainderHasFigure ? "" : " (unavailable)"} -- every dividend event counted exactly once (received, ex-date-passed-but-unpaid, or future-declared/trailing-estimate)`,
    },
  };
}
