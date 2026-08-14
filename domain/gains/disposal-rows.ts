// CGT-001A: per-disposal capital gain rows derived from one `lot_allocations`
// row (matched quantity, allocated base basis, net proceeds, fees, tax, and
// `base_realised_gain_decimal`) joined to its `tax_lots` acquisition and the
// sell transaction's disposal date. Every amount here is already in the
// portfolio's BASE (home) currency -- `lot_allocations`' `base*` columns are
// computed against `fx_rate_to_base_decimal` at ledger-projection time, so
// (unlike `domain/dividends`' native-currency rows) there is no
// mixed-currency concern when summing across securities in one portfolio.
//
// `basisStatus` ('complete' | 'incomplete_fx' | 'incomplete_basis') mirrors
// `domain/ledger/projections.ts`'s meaning exactly: 'complete' means every
// amount below is a real, known decimal; anything else means the gain is
// genuinely UNKNOWN (never a fabricated zero) because the FX rate or native
// cost basis needed to compute it was missing at some point in the lot's
// history. Discount eligibility, in contrast, is a pure function of the
// acquisition/disposal DATES (see `eligibility.ts`) and stays computable
// even when the gain amount itself is unknown -- but the combined row label
// below still reports "unknown" for an incomplete-basis row, because
// whether the discount even APPLIES depends on whether the (unknown)
// outcome is a gain at all.
import {
  compareDecimal,
  fromInteger,
  parseDecimalResult,
} from "../calculations/decimal.ts";
import { evaluateDiscountEligibility } from "./eligibility.ts";

const ZERO = fromInteger(0n);

export type CapitalGainBasisStatus =
  "complete" | "incomplete_fx" | "incomplete_basis";

export type CapitalGainAllocationFact = {
  allocationId: string;
  portfolioSecurityId: string;
  securitySymbol: string;
  securityName: string;
  /** Local calendar date (YYYY-MM-DD) the disposed tax lot was acquired -- the opening transaction's `local_trade_date`, not `tax_lots.acquired_at` (which stores the full trade instant). */
  acquiredDate: string;
  /** Local calendar date (YYYY-MM-DD) of the sell transaction's `local_trade_date`. */
  disposedDate: string;
  matchedQuantityDecimal: string;
  allocatedBaseBasisDecimal: string | null;
  baseNetProceedsDecimal: string | null;
  feeBaseDecimal: string | null;
  taxBaseDecimal: string | null;
  baseRealisedGainDecimal: string | null;
  basisStatus: CapitalGainBasisStatus;
};

export type CapitalGainEligibilityLabel =
  | "discount_eligible"
  | "discount_ineligible"
  | "not_applicable_loss"
  | "not_applicable_zero"
  | "unknown_incomplete_basis";

export type CapitalGainDisposalRow = {
  allocationId: string;
  portfolioSecurityId: string;
  securitySymbol: string;
  securityName: string;
  acquiredDate: string;
  disposedDate: string;
  quantityDecimal: string;
  proceedsDecimal: string | null;
  basisDecimal: string | null;
  feeDecimal: string | null;
  taxDecimal: string | null;
  /** `null` only when `basisStatus !== 'complete'` -- never a fabricated zero. */
  gainDecimal: string | null;
  basisStatus: CapitalGainBasisStatus;
  /**
   * Pure date-based holding-period fact (>12 months), computable even for
   * an incomplete-basis row. `null` only on a date-validation failure,
   * which should not occur for well-formed ledger data.
   */
  holdingPeriodEligible: boolean | null;
  /** Threshold date (acquisition + 12 months); disposal after this date is eligible. `null` alongside `holdingPeriodEligible`. */
  discountThresholdDate: string | null;
  eligibility: CapitalGainEligibilityLabel;
};

export type CapitalGainRowResult =
  | { ok: true; row: CapitalGainDisposalRow }
  | { ok: false; reason: "invalid_acquired_date" | "invalid_disposed_date" };

/** Derives one disposal row from one allocation fact. Pure and total for well-formed dates; returns a typed failure rather than throwing on a malformed date string. */
export function deriveCapitalGainDisposalRow(
  fact: CapitalGainAllocationFact,
): CapitalGainRowResult {
  const eligibility = evaluateDiscountEligibility(
    fact.acquiredDate,
    fact.disposedDate,
  );
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason };

  const holdingPeriodEligible = eligibility.eligible;
  const discountThresholdDate = eligibility.thresholdDate;

  let label: CapitalGainEligibilityLabel;
  if (
    fact.basisStatus !== "complete" ||
    fact.baseRealisedGainDecimal === null
  ) {
    label = "unknown_incomplete_basis";
  } else {
    const gain = parseDecimalResult(fact.baseRealisedGainDecimal);
    const comparedToZero = compareDecimal(gain, ZERO);
    if (comparedToZero < 0) {
      label = "not_applicable_loss";
    } else if (comparedToZero === 0) {
      label = "not_applicable_zero";
    } else {
      label = holdingPeriodEligible
        ? "discount_eligible"
        : "discount_ineligible";
    }
  }

  return {
    ok: true,
    row: {
      allocationId: fact.allocationId,
      portfolioSecurityId: fact.portfolioSecurityId,
      securitySymbol: fact.securitySymbol,
      securityName: fact.securityName,
      acquiredDate: fact.acquiredDate,
      disposedDate: fact.disposedDate,
      quantityDecimal: fact.matchedQuantityDecimal,
      proceedsDecimal: fact.baseNetProceedsDecimal,
      basisDecimal: fact.allocatedBaseBasisDecimal,
      feeDecimal: fact.feeBaseDecimal,
      taxDecimal: fact.taxBaseDecimal,
      gainDecimal:
        fact.basisStatus === "complete" ? fact.baseRealisedGainDecimal : null,
      basisStatus: fact.basisStatus,
      holdingPeriodEligible,
      discountThresholdDate,
      eligibility: label,
    },
  };
}
