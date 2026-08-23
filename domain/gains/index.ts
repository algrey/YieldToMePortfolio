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
  CGT_METHOD_LABELS,
  computeFyCapitalGainsTotals,
  type ComputeFyCapitalGainsTotalsResult,
  type FyCapitalGainsTotal,
} from "./fy-aggregation.ts";
export {
  computeLifetimeCapitalGainsTotal,
  type LifetimeCapitalGainsTotal,
} from "./lifetime-totals.ts";
export {
  CGT_CARRY_FORWARD_NOTE,
  computeCapitalGainsCarryChain,
  evaluateHistoryCompleteness,
  type CapitalGainsCarryChainResult,
  type FyCarriedCapitalGains,
} from "./carry-forward.ts";
export {
  computePortfolioRealisedGainTotal,
  computeSecurityRealisedGainTotals,
  type PortfolioRealisedGainTotal,
  type SecurityRealisedGainTotal,
} from "./security-totals.ts";
