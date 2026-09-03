import { CapitalGainsScreen } from "yieldtome-ui";

type Result = Parameters<typeof CapitalGainsScreen>[0]["result"];
type History = Extract<Result, { status: "ok" }>["history"];
type Fy = History["fyTotals"][number];
type Row = Fy["rows"][number];

const rowBase = {
  taxDecimal: "0",
  basisStatus: "complete",
  holdingPeriodEligible: true,
} as const;

/** FY2024: a single CBA lot sold at a loss -- the loss carries forward. */
const cbaLoss: Row = {
  ...rowBase,
  allocationId: "alloc-2024-01",
  portfolioSecurityId: "ps-cba",
  securitySymbol: "CBA",
  securityName: "Commonwealth Bank of Australia",
  acquiredDate: "2022-11-08",
  disposedDate: "2024-03-19",
  quantityDecimal: "40",
  proceedsDecimal: "4480.00",
  basisDecimal: "5710.00",
  feeDecimal: "19.95",
  gainDecimal: "-1250.00",
  discountThresholdDate: "2023-11-08",
  eligibility: "not_applicable_loss",
};

/** FY2025: two VAS lots matched against one sale -- one held over 12 months, one under. */
const vasLongLot: Row = {
  ...rowBase,
  allocationId: "alloc-2025-01",
  portfolioSecurityId: "ps-vas",
  securitySymbol: "VAS",
  securityName: "Vanguard Australian Shares Index ETF",
  acquiredDate: "2021-02-15",
  disposedDate: "2025-05-06",
  quantityDecimal: "120",
  proceedsDecimal: "11760.00",
  basisDecimal: "8340.05",
  feeDecimal: "19.95",
  gainDecimal: "3400.00",
  discountThresholdDate: "2022-02-15",
  eligibility: "discount_eligible",
};

const vasShortLot: Row = {
  ...rowBase,
  allocationId: "alloc-2025-02",
  portfolioSecurityId: "ps-vas",
  securitySymbol: "VAS",
  securityName: "Vanguard Australian Shares Index ETF",
  acquiredDate: "2024-09-02",
  disposedDate: "2025-05-06",
  quantityDecimal: "30",
  proceedsDecimal: "2940.00",
  basisDecimal: "2340.00",
  feeDecimal: "0",
  gainDecimal: "600.00",
  holdingPeriodEligible: false,
  discountThresholdDate: "2025-09-02",
  eligibility: "discount_ineligible",
};

/** FY2026: a WES gain and a small BHP loss in the same year. */
const wesGain: Row = {
  ...rowBase,
  allocationId: "alloc-2026-01",
  portfolioSecurityId: "ps-wes",
  securitySymbol: "WES",
  securityName: "Wesfarmers Limited",
  acquiredDate: "2020-04-22",
  disposedDate: "2025-11-14",
  quantityDecimal: "85",
  proceedsDecimal: "6885.00",
  basisDecimal: "1744.55",
  feeDecimal: "19.95",
  gainDecimal: "5120.50",
  discountThresholdDate: "2021-04-22",
  eligibility: "discount_eligible",
};

const bhpLoss: Row = {
  ...rowBase,
  allocationId: "alloc-2026-02",
  portfolioSecurityId: "ps-bhp",
  securitySymbol: "BHP",
  securityName: "BHP Group Limited",
  acquiredDate: "2025-01-20",
  disposedDate: "2026-02-03",
  quantityDecimal: "25",
  proceedsDecimal: "1005.00",
  basisDecimal: "1465.05",
  feeDecimal: "19.95",
  gainDecimal: "-480.00",
  holdingPeriodEligible: false,
  discountThresholdDate: "2026-01-20",
  eligibility: "not_applicable_loss",
};

/** An NAB lot whose cost basis could not be established (imported without a buy). */
const nabUnknown: Row = {
  ...rowBase,
  allocationId: "alloc-2026-03",
  portfolioSecurityId: "ps-nab",
  securitySymbol: "NAB",
  securityName: "National Australia Bank Limited",
  acquiredDate: "2019-08-30",
  disposedDate: "2026-04-10",
  quantityDecimal: "60",
  proceedsDecimal: "2262.00",
  basisDecimal: null,
  feeDecimal: "19.95",
  gainDecimal: null,
  basisStatus: "incomplete_basis",
  discountThresholdDate: "2020-08-30",
  eligibility: "unknown_incomplete_basis",
};

const fyBase = {
  excludedIncompleteCount: 0,
  excludedIncompleteSecurityNames: [] as string[],
  partialCoverage: false,
  discountRateDecimal: "0.5",
};

const fy2024: Fy = {
  ...fyBase,
  endingYear: 2024,
  label: "FY24",
  window: { startDate: "2023-07-01", endDate: "2024-06-30" },
  rows: [cbaLoss],
  disposalCount: 1,
  totalDiscountableGainsGrossDecimal: "0",
  totalNonDiscountableGainsGrossDecimal: "0",
  totalLossesDecimal: "1250.00",
  lossAppliedToNonDiscountableDecimal: "0",
  lossAppliedToDiscountableDecimal: "0",
  remainingNonDiscountableAfterLossDecimal: "0",
  remainingDiscountableAfterLossDecimal: "0",
  discountAppliedDecimal: "0",
  netCapitalGainEstimateDecimal: "0",
  unabsorbedLossDecimal: "1250.00",
};

const fy2025: Fy = {
  ...fyBase,
  endingYear: 2025,
  label: "FY25",
  window: { startDate: "2024-07-01", endDate: "2025-06-30" },
  rows: [vasLongLot, vasShortLot],
  disposalCount: 2,
  totalDiscountableGainsGrossDecimal: "3400.00",
  totalNonDiscountableGainsGrossDecimal: "600.00",
  totalLossesDecimal: "0",
  lossAppliedToNonDiscountableDecimal: "0",
  lossAppliedToDiscountableDecimal: "0",
  remainingNonDiscountableAfterLossDecimal: "600.00",
  remainingDiscountableAfterLossDecimal: "3400.00",
  discountAppliedDecimal: "1700.00",
  netCapitalGainEstimateDecimal: "2300.00",
  unabsorbedLossDecimal: "0",
};

const fy2026: Fy = {
  ...fyBase,
  endingYear: 2026,
  label: "FY26",
  window: { startDate: "2025-07-01", endDate: "2026-06-30" },
  rows: [wesGain, bhpLoss],
  disposalCount: 2,
  totalDiscountableGainsGrossDecimal: "5120.50",
  totalNonDiscountableGainsGrossDecimal: "0",
  totalLossesDecimal: "480.00",
  lossAppliedToNonDiscountableDecimal: "0",
  lossAppliedToDiscountableDecimal: "480.00",
  remainingNonDiscountableAfterLossDecimal: "0",
  remainingDiscountableAfterLossDecimal: "4640.50",
  discountAppliedDecimal: "2320.25",
  netCapitalGainEstimateDecimal: "2320.25",
  unabsorbedLossDecimal: "0",
};

/** FY2026 again, but with the NAB incomplete-basis lot excluded from totals. */
const fy2026Partial: Fy = {
  ...fy2026,
  rows: [wesGain, bhpLoss, nabUnknown],
  disposalCount: 3,
  excludedIncompleteCount: 1,
  excludedIncompleteSecurityNames: ["National Australia Bank Limited"],
  partialCoverage: true,
};

function history(overrides: Partial<History> = {}): History {
  return {
    today: "2026-09-04",
    financialYearStartMonth: 7,
    baseCurrencyCode: "AUD",
    disposalCount: 5,
    fyTotals: [fy2026, fy2025, fy2024],
    historyCompleteFrom: "2019-07-01",
    earliestTradeDate: "2019-08-30",
    projectionPending: { pending: false },
    ...overrides,
  };
}

const shell = { portfolioId: "p1", holdingsHref: "/portfolios/p1/holdings" };

/** Three disposal years with a FY2024 loss carried into FY2025; complete history. */
export function ThreeYearsWithCarry() {
  return (
    <CapitalGainsScreen
      {...shell}
      result={{ status: "ok", history: history() }}
    />
  );
}

/** Latest FY excludes an incomplete-basis NAB lot (partial coverage) while a recalculation is still running. */
export function PartialCoverageRecalculating() {
  return (
    <CapitalGainsScreen
      {...shell}
      result={{
        status: "ok",
        history: history({
          disposalCount: 6,
          fyTotals: [fy2026Partial, fy2025, fy2024],
          projectionPending: { pending: true, reason: "running" },
        }),
      }}
    />
  );
}

/** No declared history-completeness date: carried figures are starred and the chain warns about unknown prior losses. */
export function IncompleteHistory() {
  return (
    <CapitalGainsScreen
      {...shell}
      result={{
        status: "ok",
        history: history({
          historyCompleteFrom: null,
          earliestTradeDate: "2022-03-14",
        }),
      }}
    />
  );
}

/** Portfolio with no sell transactions yet. */
export function NoDisposals() {
  return (
    <CapitalGainsScreen
      {...shell}
      result={{
        status: "ok",
        history: history({
          disposalCount: 0,
          fyTotals: [],
          historyCompleteFrom: null,
          earliestTradeDate: "2024-01-15",
        }),
      }}
    />
  );
}

/** Calculation run has not published yet. */
export function UnavailableUnpublished() {
  return (
    <CapitalGainsScreen
      {...shell}
      result={{ status: "unavailable", reason: "unpublished" }}
    />
  );
}

/** Generic load failure. */
export function UnavailableError() {
  return (
    <CapitalGainsScreen
      {...shell}
      result={{ status: "unavailable", reason: "error" }}
    />
  );
}
