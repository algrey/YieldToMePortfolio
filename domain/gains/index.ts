export {
  CGT_INDIVIDUAL_DISCOUNT_RATE,
  addTwelveMonths,
  evaluateDiscountEligibility,
  type DiscountEligibilityResult,
} from "./eligibility.ts";
export {
  deriveCapitalGainDisposalRow,
  type CapitalGainAllocationFact,
  type CapitalGainBasisStatus,
  type CapitalGainDisposalRow,
  type CapitalGainEligibilityLabel,
  type CapitalGainRowResult,
} from "./disposal-rows.ts";
export {
  CGT_CARRY_FORWARD_OUT_OF_SCOPE_NOTE,
  CGT_METHOD_LABELS,
  computeFyCapitalGainsTotals,
  type ComputeFyCapitalGainsTotalsResult,
  type FyCapitalGainsTotal,
} from "./fy-aggregation.ts";
