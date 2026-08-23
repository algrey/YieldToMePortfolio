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
import { fyWindowForDate } from "./fy-window.ts";
import type { FyWindow } from "../calculations/financial-year.ts";
import type {
  FyDividendOverrideFact,
  FyDividendTotal,
} from "./aggregations.ts";
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

/** Portfolio value-growth %: the single `dividend_portfolio_assumptions.value_growth_percent_decimal` input, or an explicit "no growth assumed" 0%. There is no further fallback tier -- this IS the top of its own chain. */
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
    growthPercentDecimal: "0",
    method: "no growth assumed",
  };
}

/** Portfolio dividend-growth %, used as the multi-year projection's yield-compounding input. Same single-tier shape as `resolvePortfolioValueGrowth`. */
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
    growthPercentDecimal: "0",
    method: "no growth assumed",
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
// never silently blurred into a bare "no data at all" reason.
export type YieldAssumptionStatus =
  | "ok"
  | "insufficient_history"
  | "price_unavailable"
  | "currency_mismatch"
  | "mixed_currency"
  | "invalid_input"
  | "unknown_amount"
  | "history_gap";

export type YieldAssumptionResolution =
  | {
      source: "owner_override";
      status: "ok";
      grossedYieldPercentDecimal: string;
      cashYieldPercentDecimal: null;
      frankingPercentUsedDecimal: null;
      frankingSource: null;
      method: string;
    }
  | {
      source: "provider_ttm" | "history_ttm";
      status: "ok";
      grossedYieldPercentDecimal: string;
      cashYieldPercentDecimal: string;
      frankingPercentUsedDecimal: string;
      frankingSource: FrankingAssumptionSource;
      method: string;
    }
  | {
      source: "none";
      status: Exclude<YieldAssumptionStatus, "ok">;
      grossedYieldPercentDecimal: null;
      cashYieldPercentDecimal: null;
      frankingPercentUsedDecimal: null;
      frankingSource: null;
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
  return {
    source: ttmYield.ttmSource,
    status: "ok",
    grossedYieldPercentDecimal,
    cashYieldPercentDecimal,
    frankingPercentUsedDecimal: frankingResolution.frankingPercentDecimal,
    frankingSource: frankingResolution.source,
    method:
      frankingResolution.source === "owner_override"
        ? `${legLabel} grossed up using the owner's franking assumption`
        : `${legLabel}; no franking assumption set, so no franking credit is added (0%)`,
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

export type AggregateYieldResult = {
  status: "ok" | "no_coverage";
  effectiveYieldPercentDecimal: string | null;
  effectiveFrankingMixPercentDecimal: string | null;
  includedValueDecimal: string;
  includedCount: number;
  excluded: AggregateYieldExclusion[];
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
  }
  if (included.length === 0) {
    return {
      status: "no_coverage",
      effectiveYieldPercentDecimal: null,
      effectiveFrankingMixPercentDecimal: null,
      includedValueDecimal: "0",
      includedCount: 0,
      excluded,
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
  return {
    status: "ok",
    effectiveYieldPercentDecimal,
    effectiveFrankingMixPercentDecimal,
    includedValueDecimal: formatDecimalExact(includedValue),
    includedCount: included.length,
    excluded,
    method:
      excluded.length === 0
        ? "value-weighted average of every held security's resolved yield"
        : `value-weighted average across ${included.length} of ${included.length + excluded.length} held securities; ${excluded.length} excluded (named) for an unavailable current value or insufficient yield data`,
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
  baseYieldPercentDecimal: string;
  baseFrankingMixPercentDecimal: string;
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
  /** The FY ending year the CURRENT (year-0) row belongs to, for FY-labelled rows; `null` produces plain "Year N" labels. */
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
       * concrete `currentPortfolioValueDecimal`/`baseYieldPercentDecimal`) --
       * they exist on this union so the SERVICE layer
       * (`app/owned-income-projection.ts`) can report a degraded portfolio
       * (no published holdings value, or no security has a resolved yield)
       * through the identical typed shape instead of inventing a different
       * failure contract, and so it never has to fabricate `"0"` inputs just
       * to get a well-typed result back (review finding B3).
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

/** One compounding step: `current * factor`, rounded ONCE to `PROJECTION_SCALE` -- the "single documented rounding per step" this task requires, and the mechanism that keeps a 10-year loop's tracked decimal scale bounded (see the `PROJECTION_SCALE` comment above). */
function compoundOnce(currentDecimal: string, factor: DecimalFraction): string {
  const product = multiplyDecimal(parseDecimal(currentDecimal), factor);
  return formatDecimalExact(roundDecimal(product, PROJECTION_SCALE));
}

function grossDividendForYear(
  valueDecimal: string,
  yieldPercentDecimal: string,
): string {
  const yieldFraction = roundDecimal(
    divideDecimal(parseDecimal(yieldPercentDecimal), HUNDRED),
    PROJECTION_SCALE,
  );
  return formatDecimalExact(
    roundDecimal(
      multiplyDecimal(parseDecimal(valueDecimal), yieldFraction),
      PROJECTION_SCALE,
    ),
  );
}

/**
 * Year N (N = 1..`yearsForward`): `value_N = value_{N-1} * (1 + valueGrowth)`,
 * `yield_N = yield_{N-1} * (1 + dividendGrowth)`,
 * `dividend_N = value_N * yield_N` (yield expressed as a fraction of value,
 * i.e. `yield% / 100`) -- compounded by REPEATED multiplication year over
 * year (not `(1+g)^N` computed once), each step rounded exactly once. The
 * grossed dividend is then split into cash/franking-credit using the
 * portfolio's aggregate franking mix (`decomposeGrossedAmount`). Every row
 * carries the assumptions and their sources so a consumer can render
 * "projected: value grows N%/yr (source), yield grows N%/yr (source)" next
 * to every number -- never a bare projected figure.
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
    const yieldFactor = growthFactor(assumptions.dividendGrowthPercentDecimal);
    let value = assumptions.currentPortfolioValueDecimal;
    let yieldPercent = assumptions.baseYieldPercentDecimal;
    rows = [];
    const method =
      `portfolio value compounds at ${assumptions.valueGrowthPercentDecimal}%/yr ` +
      `(${assumptions.valueGrowthSource}); effective yield compounds at ` +
      `${assumptions.dividendGrowthPercentDecimal}%/yr (${assumptions.dividendGrowthSource}); ` +
      `dividend includes franking credits` +
      (assumptions.currentPortfolioValueStatus === "partial"
        ? // Review finding B4: this note must live IN the row's own `method`
          // string, not just alongside it in a separate response field --
          // `projectMultiYearIncomeWhatIf`'s output can be (and is meant to
          // be) rendered standalone by a caller that never sees the
          // original `OwnedIncomeProjection.portfolioValueStatus`, so the
          // disclosure has to travel with the row itself to survive that.
          `; based on a partial (understated) current portfolio value -- some holdings are unpriced`
        : "");
    for (let yearIndex = 1; yearIndex <= yearsForward; yearIndex += 1) {
      value = compoundOnce(value, valueFactor);
      yieldPercent = compoundOnce(yieldPercent, yieldFactor);
      const grossDividendDecimal = grossDividendForYear(value, yieldPercent);
      const { cashDecimal, frankingDecimal } = decomposeGrossedAmount(
        grossDividendDecimal,
        assumptions.baseFrankingMixPercentDecimal,
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
        yieldPercentDecimal: yieldPercent,
        grossDividendDecimal,
        cashDividendDecimal: cashDecimal,
        frankingCreditDecimal: frankingDecimal,
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
// happened so far this FY. Deliberately the "honest simpler option" per the
// review's own framing: this reports FY-TO-DATE actuals (the current FY's
// share of DIV-001's already-precedence-resolved per-security totals),
// labelled as partial-year, rather than trying to forecast the remainder of
// the year and risk conflating a modelled estimate with what has actually
// been received so far.
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
    if (security.forecast.ttmIncomplete) {
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
