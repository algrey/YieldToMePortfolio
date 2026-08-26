export {
  deriveSharesHeldAtDate,
  type LedgerQuantityFact,
} from "./shares-held.ts";
export {
  resolveFrankingPerShare,
  computeDefaultFrankingCredit,
  AU_COMPANY_TAX_RATE,
  type FrankingResolution,
} from "./franking.ts";
export {
  resolveEventOverrideForLineage,
  type EventOverrideFact,
  type EventOverrideLineageNode,
} from "./event-override-resolution.ts";
export {
  fyWindowForDate,
  fyWindowForEndingYear,
  type FyWindowForDateResult,
} from "./fy-window.ts";
export {
  deriveDividendHistoryForSecurity,
  PROXIMITY_WINDOW_DAYS,
  type DeriveDividendHistoryInput,
  type DerivedDividendRow,
  type DerivedDividendRowLifecycleStatus,
  type DerivedDividendRowSource,
  type DividendManualRecordFact,
  type DividendReceiptFact,
  type ProviderDividendEventFact,
} from "./history.ts";
export {
  computeFyDividendTotals,
  computeLifetimeDividendTotals,
  type ComputeFyDividendTotalsResult,
  type FyDividendOverrideFact,
  type FyDividendTotal,
  type FyDividendTotalSource,
  type LifetimeDividendTotals,
} from "./aggregations.ts";
export {
  computeSecurityDividendForecast,
  deriveHistoryTrailingTwelveMonthDividend,
  type ComputeSecurityForecastInput,
  type ForecastCoverageStatus,
  type HistoryTtmDividendResult,
  type SecurityDividendForecast,
} from "./forecast.ts";
// BUG-005: shared per-row shares/per-share derivation -- the same functions
// `forecast.ts`'s history-TTM fallback uses, now also consumed by the
// Dividends tab's own display (`app/owned-security-dividends.ts`).
export {
  deriveHistoryRowDisplay,
  deriveHistoryRowDps,
  deriveHistoryRowFrankingPerShare,
  type DerivedHistoryRowDisplay,
  type HistoryRowDpsResult,
} from "./history-row-derivation.ts";
