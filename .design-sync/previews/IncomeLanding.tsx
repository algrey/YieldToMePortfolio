import { IncomeLanding } from "yieldtome-ui";

// `projection` mirrors `OwnedIncomeProjection` from
// app/owned-income-projection.ts. The screen reads `status`,
// `baseCurrencyCode`, `breakdown`, `currentFinancialYear`,
// `currentFinancialYearEstimate`, `trailingTwelveMonthActual`,
// `pastFinancialYears` and `aggregateYield.method`; the remaining fields are
// carried as honest placeholders so the object matches the real shape.

type Projection = Parameters<typeof IncomeLanding>[0]["projection"];

const hrefs = {
  portfolioId: "p1",
  multiYearHref: "/portfolio/p1/income/multi-year",
  assumptionsHref: "/portfolio/p1/income/assumptions",
  dividendsHref: "/portfolio/p1/income/dividends",
};

const fyWindow = (endingYear: number) => ({
  startDate: `${endingYear - 1}-07-01`,
  endDate: `${endingYear}-06-30`,
});

function pastRow(
  endingYear: number,
  source: string,
  gross: string | null,
  cash: string | null,
  franking: string | null,
  extra: Record<string, unknown> = {},
) {
  return {
    endingYear,
    label: `FY${String(endingYear).slice(-2)}`,
    window: fyWindow(endingYear),
    dividendSource: source,
    dividendGrossDecimal: gross,
    dividendCashDecimal: cash,
    dividendFrankingKnownDecimal: franking,
    dividendFrankingIncomplete: false,
    includedSecurityCount: 6,
    excludedSecurities: [],
    portfolioValueDecimal: null,
    valueStatus: "unavailable",
    effectiveYieldPercentDecimal: null,
    method: "Sum of paid dividends attributed to this financial year by payment date.",
    ...extra,
  };
}

const aggregateYieldMethod =
  "Aggregate yield weights each held security's trailing-12-month per-share dividend rate by its current market value; securities without a usable price or dividend history are excluded and listed.";

const baseProjection = {
  status: "ok",
  baseCurrencyCode: "AUD",
  today: "2026-09-04",
  currentPortfolioValueDecimal: "182417.60",
  portfolioValueStatus: "available",
  portfolioValueCoverage: { total: 7, nonZero: 7, zero: 0, priced: 7, converted: 1, basis: 6 },
  assumptionGrid: [],
  aggregateYield: {
    status: "ok",
    effectiveYieldPercentDecimal: "4.12",
    effectiveFrankingMixPercentDecimal: "61.5",
    includedValueDecimal: "182417.60",
    includedCount: 7,
    excluded: [],
    partialTtmSecurities: [],
    method: aggregateYieldMethod,
  },
  portfolioValueGrowth: { source: "default", percentDecimal: "0" },
  portfolioDividendGrowth: { source: "default", percentDecimal: "0" },
  multiYear: { ok: false, reason: "invalid_years" },
  multiYearBaselineInput: null,
  financialYearStartMonth: 7,
};

const breakdownOk = {
  status: "ok",
  currencyCode: "AUD",
  totalGrossDecimal: "9846.32",
  totalCashDecimal: "7512.90",
  totalFrankingKnownDecimal: "2333.42",
  totalFrankingIncomplete: false,
  averagePerMonthDecimal: "820.53",
  averagePerWeekDecimal: "189.35",
  incomePercentOfValueDecimal: "5.40",
  incomePercentOfValueStatus: "available",
  includedSecurityCount: 7,
  excludedSecurities: [],
  partialTtmSecurities: [],
  method:
    "Declared dividends with a known ex-date inside the next 12 months are counted at their declared amount. Every other holding is projected from its trailing 12-month per-share rate multiplied by shares held today. Franking credits are grossed up at 30%.",
};

const currentFyRow = {
  endingYear: 2027,
  label: "FY27",
  window: fyWindow(2027),
  dividendSource: "fy_to_date",
  dividendGrossDecimal: "1418.22",
  dividendCashDecimal: "1050.00",
  dividendFrankingKnownDecimal: "368.22",
  dividendFrankingIncomplete: false,
  includedSecurityCount: 6,
  excludedSecurities: [],
  portfolioValueDecimal: "182417.60",
  valueStatus: "available",
  effectiveYieldPercentDecimal: null,
  method: "Dividends paid between 2026-07-01 and today.",
};

const estimateRow = {
  endingYear: 2027,
  label: "FY27",
  status: "ok",
  dividendGrossDecimal: "9611.08",
  dividendCashDecimal: "7328.41",
  dividendFrankingKnownDecimal: "2282.67",
  dividendFrankingIncomplete: false,
  dividendAmountIncomplete: false,
  excludedSecurities: [],
  partialTtmSecurities: [],
  method: "Received so far plus declared-unpaid plus the remainder-of-year forecast.",
};

const trailingRow = {
  windowFromDate: "2025-09-05",
  windowToDate: "2026-09-04",
  status: "ok",
  dividendGrossDecimal: "9102.77",
  dividendCashDecimal: "6944.10",
  dividendFrankingKnownDecimal: "2158.67",
  dividendFrankingIncomplete: false,
  dividendAmountIncomplete: false,
  includedSecurityCount: 7,
  excludedSecurities: [],
};

const pastRows = [
  pastRow(2026, "actual", "8917.40", "6810.15", "2107.25"),
  pastRow(2025, "actual", "8240.66", "6301.02", "1939.64"),
  pastRow(2024, "partially_estimated", "7105.30", "5480.12", "1625.18", {
    dividendFrankingIncomplete: true,
  }),
  pastRow(2023, "actual", "6288.91", "4830.20", "1458.71", {
    excludedSecurities: [
      { portfolioSecurityId: "ps-aapl", symbol: "AAPL", reason: "foreign_currency" },
    ],
  }),
  pastRow(2022, "no_evidence", null, null, null, { includedSecurityCount: 0 }),
];

const okProjection = {
  ...baseProjection,
  breakdown: breakdownOk,
  currentFinancialYear: { ok: true, row: currentFyRow },
  currentFinancialYearEstimate: { ok: true, row: estimateRow },
  trailingTwelveMonthActual: trailingRow,
  pastFinancialYears: { ok: true, rows: pastRows },
} as unknown as Projection;

/** Canonical next-12-months estimate with the so-far, estimate, trailing and closed-FY rows. */
export function Populated() {
  return <IncomeLanding projection={okProjection} {...hrefs} />;
}

const partialProjection = {
  ...baseProjection,
  portfolioValueStatus: "partial",
  breakdown: {
    ...breakdownOk,
    status: "partial",
    totalGrossDecimal: "7204.18",
    totalCashDecimal: "5610.44",
    totalFrankingKnownDecimal: "1593.74",
    totalFrankingIncomplete: true,
    averagePerMonthDecimal: "600.35",
    averagePerWeekDecimal: "138.54",
    incomePercentOfValueDecimal: "4.67",
    incomePercentOfValueStatus: "partial",
    includedSecurityCount: 5,
    excludedSecurities: [
      { portfolioSecurityId: "ps-bhp", symbol: "BHP", reason: "no_dividend_history" },
      { portfolioSecurityId: "ps-aapl", symbol: "AAPL", reason: "missing_fx" },
    ],
    partialTtmSecurities: [{ portfolioSecurityId: "ps-wes", symbol: "WES" }],
  },
  currentFinancialYear: {
    ok: true,
    row: {
      ...currentFyRow,
      dividendFrankingIncomplete: true,
      excludedSecurities: [
        { portfolioSecurityId: "ps-aapl", symbol: "AAPL", reason: "foreign_currency" },
      ],
    },
  },
  currentFinancialYearEstimate: {
    ok: true,
    row: { ...estimateRow, status: "partial", dividendAmountIncomplete: true },
  },
  trailingTwelveMonthActual: { ...trailingRow, dividendAmountIncomplete: true },
  pastFinancialYears: { ok: true, rows: pastRows.slice(0, 3) },
} as unknown as Projection;

/** Partial coverage: two holdings excluded, franking partially unknown, income % against a partial value. */
export function PartialCoverage() {
  return <IncomeLanding projection={partialProjection} {...hrefs} />;
}

const noCoverageProjection = {
  ...baseProjection,
  currentPortfolioValueDecimal: null,
  portfolioValueStatus: "unavailable",
  aggregateYield: {
    ...baseProjection.aggregateYield,
    status: "no_coverage",
    effectiveYieldPercentDecimal: null,
    includedValueDecimal: "0",
    includedCount: 0,
  },
  breakdown: {
    ...breakdownOk,
    status: "no_coverage",
    totalGrossDecimal: null,
    totalCashDecimal: null,
    totalFrankingKnownDecimal: null,
    averagePerMonthDecimal: null,
    averagePerWeekDecimal: null,
    incomePercentOfValueDecimal: null,
    incomePercentOfValueStatus: "unavailable",
    includedSecurityCount: 0,
    excludedSecurities: [
      { portfolioSecurityId: "ps-vas", symbol: "VAS", reason: "no_dividend_history" },
      { portfolioSecurityId: "ps-cba", symbol: "CBA", reason: "no_dividend_history" },
      { portfolioSecurityId: "ps-aapl", symbol: "AAPL", reason: "missing_price" },
    ],
    method:
      "No held security has a usable dividend history or owner-entered yield assumption, so no next-12-months figure can be projected.",
  },
  currentFinancialYear: {
    ok: true,
    row: {
      ...currentFyRow,
      dividendSource: "no_evidence",
      dividendGrossDecimal: null,
      dividendCashDecimal: null,
      dividendFrankingKnownDecimal: null,
      includedSecurityCount: 0,
    },
  },
  currentFinancialYearEstimate: {
    ok: true,
    row: {
      ...estimateRow,
      status: "unavailable",
      dividendGrossDecimal: null,
      dividendCashDecimal: null,
      dividendFrankingKnownDecimal: null,
    },
  },
  trailingTwelveMonthActual: {
    ...trailingRow,
    status: "unavailable",
    dividendGrossDecimal: null,
    dividendCashDecimal: null,
    dividendFrankingKnownDecimal: null,
    includedSecurityCount: 0,
  },
  pastFinancialYears: { ok: true, rows: [] },
} as unknown as Projection;

/** Holdings exist but nothing can be projected: exclusions listed, history rows honest "Unavailable". */
export function NoCoverage() {
  return <IncomeLanding projection={noCoverageProjection} {...hrefs} />;
}

const degradedCalendarProjection = {
  ...okProjection,
  currentFinancialYear: { ok: false, reason: "invalid_start_month" },
  currentFinancialYearEstimate: { ok: false, reason: "invalid_start_month" },
  pastFinancialYears: { ok: false, reason: "invalid_start_month" },
} as unknown as Projection;

/** FY calendar misconfigured: the projection still renders, history fails closed to warning banners. */
export function DegradedCalendar() {
  return <IncomeLanding projection={degradedCalendarProjection} {...hrefs} />;
}

const emptyProjection = {
  ...noCoverageProjection,
  status: "empty",
} as unknown as Projection;

/** Portfolio holds no securities at all. */
export function Empty() {
  return <IncomeLanding projection={emptyProjection} {...hrefs} />;
}
