// CGT-001B: lifetime rollup over already-computed per-FY totals
// (`computeFyCapitalGainsTotals`'s output, `fy-aggregation.ts`) for the
// Capital gains screen's lifetime summary section.
//
// This is a purely ADDITIVE disclosure across independently-derived FY
// totals -- NOT a recomputation and explicitly NOT loss carry-forward. Each
// FY's own `netCapitalGainEstimateDecimal`/`unabsorbedLossDecimal` stays
// exactly what that FY already reported, standalone (see
// `CGT_CARRY_FORWARD_OUT_OF_SCOPE_NOTE`). Summing that sequence of
// already-final per-FY figures for a lifetime total never implies an
// unabsorbed loss from one FY offset a gain in another -- it is arithmetic
// over the disclosed history, not a different tax outcome.
//
// Informational estimate only -- NOT tax advice. See
// `docs/CALCULATIONS.md` section 14.
import {
  addDecimal,
  formatDecimalExact,
  fromInteger,
  parseDecimalResult,
  type DecimalFraction,
} from "../calculations/decimal.ts";
import type { FyCapitalGainsTotal } from "./fy-aggregation.ts";

const ZERO = fromInteger(0n);

export type LifetimeCapitalGainsTotal = {
  fyCount: number;
  /** Sum of every FY's `disposalCount` -- ALLOCATIONS (lot matches), not distinct sale transactions; see `disposal-rows.ts`/CGT-001A's completion note. */
  disposalCount: number;
  excludedIncompleteCount: number;
  /** Sorted, de-duplicated across every FY. */
  excludedIncompleteSecurityNames: string[];
  partialCoverage: boolean;
  totalDiscountableGainsGrossDecimal: string;
  totalNonDiscountableGainsGrossDecimal: string;
  totalLossesDecimal: string;
  totalUnabsorbedLossDecimal: string;
  /** Sum of each FY's own (already-discounted, already loss-offset) net capital gain estimate. */
  netCapitalGainEstimateDecimal: string;
};

function sumField(
  fyTotals: readonly FyCapitalGainsTotal[],
  field: (total: FyCapitalGainsTotal) => string,
): DecimalFraction {
  return fyTotals.reduce<DecimalFraction>(
    (total, fy) => addDecimal(total, parseDecimalResult(field(fy))),
    ZERO,
  );
}

/**
 * Rolls up `fyTotals` (sorted newest-first, per
 * `computeFyCapitalGainsTotals`'s contract) into one lifetime summary. An
 * empty list returns an all-zero/empty summary rather than throwing -- the
 * Capital gains screen's own "no disposals yet" state renders that
 * separately and never calls this for a portfolio with zero FYs, but this
 * function stays total for callers that do.
 */
export function computeLifetimeCapitalGainsTotal(
  fyTotals: readonly FyCapitalGainsTotal[],
): LifetimeCapitalGainsTotal {
  const excludedIncompleteSecurityNames = [
    ...new Set(fyTotals.flatMap((fy) => fy.excludedIncompleteSecurityNames)),
  ].sort((left, right) => left.localeCompare(right));

  return {
    fyCount: fyTotals.length,
    disposalCount: fyTotals.reduce((total, fy) => total + fy.disposalCount, 0),
    excludedIncompleteCount: fyTotals.reduce(
      (total, fy) => total + fy.excludedIncompleteCount,
      0,
    ),
    excludedIncompleteSecurityNames,
    partialCoverage: fyTotals.some((fy) => fy.partialCoverage),
    totalDiscountableGainsGrossDecimal: formatDecimalExact(
      sumField(fyTotals, (fy) => fy.totalDiscountableGainsGrossDecimal),
    ),
    totalNonDiscountableGainsGrossDecimal: formatDecimalExact(
      sumField(fyTotals, (fy) => fy.totalNonDiscountableGainsGrossDecimal),
    ),
    totalLossesDecimal: formatDecimalExact(
      sumField(fyTotals, (fy) => fy.totalLossesDecimal),
    ),
    totalUnabsorbedLossDecimal: formatDecimalExact(
      sumField(fyTotals, (fy) => fy.unabsorbedLossDecimal),
    ),
    netCapitalGainEstimateDecimal: formatDecimalExact(
      sumField(fyTotals, (fy) => fy.netCapitalGainEstimateDecimal),
    ),
  };
}
