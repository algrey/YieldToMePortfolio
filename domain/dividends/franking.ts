// DIV-001: franking-per-share resolution chain.
//
// Per-dividend override -> the holding's "franking if not known" default
// (`dividend_security_assumptions.franking_percent_decimal`) -> unknown
// (excluded from franking totals, flagged, never a silent zero).
//
// Orchestrator ruling (2026-08-13), correcting this module's original
// literal-percentage interpretation: the assumptions-grid "franking %" is
// the Australian FRANKED PROPORTION of the dividend (0 = unfranked, 100 =
// fully franked) -- not a direct dollar-scaling factor. The dollar franking
// CREDIT attached to a fully franked dividend is larger than the cash
// dividend itself is not: it is the standard ATO gross-up amount,
//
//   creditPerShare = dividendPerShare * (frankingPercent / 100)
//                    * (companyTaxRate / (1 - companyTaxRate))
//
// so a 100%-franked dividend at the standard 30% company tax rate yields a
// credit equal to dividend * (30/70) = dividend * 3/7 ~= 42.857% of the cash
// amount -- matching the owner-approved wireframe's "franking if not known:
// 42.86%" figure for a fully-franked default, which confirms the percentage
// is a PROPORTION, not a literal dollar multiplier. `AU_COMPANY_TAX_RATE`
// below names that 30% assumption explicitly (this IS arithmetic from a
// stated, documented assumption, not tax advice -- see
// `docs/CALCULATIONS.md` section 11 for the same disclosure). Base-rate
// entities (25% company tax rate) are NOT modelled in v1; the constant is a
// candidate for a future per-security or per-portfolio setting, not a
// literal law-of-Australia fact this codebase asserts.
//
// Per-event override/receipt/manual-record franking fields
// (`franking_credit_per_share_decimal`) remain direct, owner/provider-typed
// DOLLAR per-share CREDIT values -- no conversion applied to those; only the
// percentage-based DEFAULT tier goes through this formula.
import {
  formatDecimalExact,
  fromInteger,
  multiplyDecimal,
  parseDecimal,
  divideDecimal,
  roundDecimal,
  subtractDecimal,
  type DecimalFraction,
} from "../calculations/decimal.ts";

/**
 * Standard Australian company tax rate assumption used to gross up a
 * franking PERCENTAGE into a dollar franking CREDIT. Named and documented
 * rather than inlined so its provenance (a stated assumption, not a
 * carried-through fact) stays visible at every call site and in
 * `docs/CALCULATIONS.md`. Base-rate (25%) entities are not modelled in v1.
 */
export const AU_COMPANY_TAX_RATE = "0.30";

// Rounding rule: the formula's division (companyTaxRate / (1 -
// companyTaxRate) folded into one combined ratio against the dividend
// amount) has no fixed terminating decimal scale, so it cannot use
// `formatDecimalExact` directly. This module performs exactly ONE division
// at the end of the computation (all three multiplications --
// dividend x frankingPercent x taxRate, and 100 x (1 - taxRate) for the
// denominator -- are exact and stay unrounded), then rounds that single
// result to a fixed scale using `roundDecimal`'s half-even mode (this
// codebase's only rounding mode) at 24 decimal places -- the same
// `DECIMAL_LIMITS.allocationScale`-matching intermediate scale
// `domain/ledger/projections.ts` uses elsewhere for financial math with no
// natural terminating scale. Doing the division once, last, avoids
// compounding rounding error across multiple intermediate roundings.
const DEFAULT_TIER_SCALE = 24;

/**
 * Grosses up `dividendAmountDecimal` (a per-share amount OR a total cash
 * amount -- the formula is linear, so both call sites in this module use
 * it) by `frankingPercentDecimal` (0-100, the franked proportion) into a
 * dollar franking credit, using `AU_COMPANY_TAX_RATE`. Exported so
 * `forecast.ts`'s uncovered-tail estimate (a total cash amount, not a
 * per-share figure) shares this exact formula/rounding rather than
 * duplicating it.
 */
export function computeDefaultFrankingCredit(
  dividendAmountDecimal: string,
  frankingPercentDecimal: string,
): string {
  const dividend = parseDecimal(dividendAmountDecimal);
  const percent = parseDecimal(frankingPercentDecimal);
  const taxRate = parseDecimal(AU_COMPANY_TAX_RATE);
  const oneMinusTaxRate: DecimalFraction = subtractDecimal(
    fromInteger(1n),
    taxRate,
  );
  const numerator = multiplyDecimal(
    multiplyDecimal(dividend, percent),
    taxRate,
  );
  const denominator = multiplyDecimal(fromInteger(100n), oneMinusTaxRate);
  const ratio = roundDecimal(
    divideDecimal(numerator, denominator),
    DEFAULT_TIER_SCALE,
  );
  return formatDecimalExact(ratio);
}

export type FrankingResolution =
  | { source: "override"; perShareDecimal: string }
  | { source: "default"; perShareDecimal: string }
  | { source: "unknown"; perShareDecimal: null };

/**
 * `overridePerShareDecimal`: the winning row's own known dollar
 * franking-credit-per-share fact (from an event override, a receipt, or a
 * manual record) -- `null` when the winning source did not supply one.
 * `defaultFrankingPercentDecimal`: the security's assumptions-grid
 * "franking if not known" default (a franked-proportion percentage), or
 * `null` if never set.
 * `dividendPerShareDecimal`: the row's own per-share dividend amount, used
 * to gross up the default percentage into a credit (see the module header).
 * `null` here means the per-share dividend amount itself is unknown (a
 * defensively-handled edge case -- see `history.ts`'s null
 * `gross_per_share_decimal` handling): the default tier cannot scale an
 * unknown amount, so it resolves to `"unknown"` even when a default percent
 * exists. An explicit per-dividend override credit is still usable on its
 * own regardless (it does not depend on the dividend amount at all).
 */
export function resolveFrankingPerShare(
  overridePerShareDecimal: string | null,
  defaultFrankingPercentDecimal: string | null,
  dividendPerShareDecimal: string | null,
): FrankingResolution {
  if (overridePerShareDecimal !== null) {
    return { source: "override", perShareDecimal: overridePerShareDecimal };
  }
  if (
    defaultFrankingPercentDecimal !== null &&
    dividendPerShareDecimal !== null
  ) {
    try {
      return {
        source: "default",
        perShareDecimal: computeDefaultFrankingCredit(
          dividendPerShareDecimal,
          defaultFrankingPercentDecimal,
        ),
      };
    } catch {
      return { source: "unknown", perShareDecimal: null };
    }
  }
  return { source: "unknown", perShareDecimal: null };
}
