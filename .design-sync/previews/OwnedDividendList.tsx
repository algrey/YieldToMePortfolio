import { OwnedDividendList } from "yieldtome-ui";

type Row = Parameters<typeof OwnedDividendList>[0]["rows"][number];

const base = {
  notPaid: false,
  amountUnreadable: false,
  frankingDerivedZero: false,
  excluded: false,
  originalCurrencyCode: null,
  fxRateToPortfolioDecimal: null,
  fxRateSource: null,
} as const;

const rows: Row[] = [
  {
    ...base,
    id: "d1",
    portfolioSecurityId: "s1",
    symbol: "VAS",
    currencyCode: "AUD",
    paymentDate: "2026-07-17",
    exDate: "2026-07-01",
    cashDecimal: "412.36",
    frankingTotalDecimal: "118.22",
    grossDecimal: "530.58",
    source: "imported",
  },
  {
    ...base,
    id: "d2",
    portfolioSecurityId: "s2",
    symbol: "CBA",
    currencyCode: "AUD",
    paymentDate: "2026-06-26",
    exDate: "2026-06-12",
    cashDecimal: "1050.00",
    frankingTotalDecimal: "450.00",
    grossDecimal: "1500.00",
    source: "receipt",
  },
  {
    ...base,
    id: "d3",
    portfolioSecurityId: "s3",
    symbol: "VTS",
    currencyCode: "AUD",
    paymentDate: "2026-06-30",
    exDate: "2026-06-24",
    cashDecimal: "188.41",
    frankingTotalDecimal: "0",
    frankingDerivedZero: true,
    grossDecimal: "188.41",
    source: "imported",
    originalCurrencyCode: "USD",
    fxRateToPortfolioDecimal: "1.5312",
    fxRateSource: "Frankfurter",
  },
  {
    ...base,
    id: "d4",
    portfolioSecurityId: "s4",
    symbol: "WES",
    currencyCode: "AUD",
    paymentDate: "2026-10-02",
    exDate: "2026-08-25",
    notPaid: true,
    cashDecimal: null,
    frankingTotalDecimal: null,
    grossDecimal: null,
    source: "auto",
  },
  {
    ...base,
    id: "d5",
    portfolioSecurityId: "s2",
    symbol: "CBA",
    currencyCode: "AUD",
    paymentDate: "2026-03-27",
    exDate: "2026-02-19",
    cashDecimal: "1015.00",
    frankingTotalDecimal: "435.00",
    grossDecimal: "1450.00",
    source: "edited",
    excluded: true,
  },
  {
    ...base,
    id: "d6",
    portfolioSecurityId: "s5",
    symbol: "NAB",
    currencyCode: "AUD",
    paymentDate: "2025-12-18",
    exDate: "2025-11-13",
    cashDecimal: null,
    amountUnreadable: true,
    frankingTotalDecimal: null,
    grossDecimal: null,
    source: "manual",
  },
];

const common = {
  portfolioId: "p1",
  baseCurrencyCode: "AUD",
  allYearsHref: "/portfolio/p1/income/dividends",
  today: "2026-09-04",
};

/** All years: paid, foreign-converted, declared-not-paid, excluded, and unreadable rows. */
export function AllYears() {
  return (
    <OwnedDividendList
      {...common}
      rows={rows}
      truncated={false}
      totalCount={rows.length}
      filter={{ mode: "all", invalidFyRequested: false }}
    />
  );
}

/** Filtered to one financial year, with two undated rows reported. */
export function FinancialYear() {
  return (
    <OwnedDividendList
      {...common}
      rows={rows.slice(0, 3)}
      truncated={false}
      totalCount={3}
      filter={{
        mode: "fy",
        endingYear: 2026,
        label: "FY 2025–26",
        window: { startDate: "2025-07-01", endDate: "2026-06-30" },
      }}
      undatedRowCount={2}
    />
  );
}

/** Next 12 months window: only the upcoming declared payout. */
export function Next12Months() {
  return (
    <OwnedDividendList
      {...common}
      rows={rows.filter((r) => r.paymentDate && r.paymentDate > common.today)}
      truncated={false}
      totalCount={1}
      filter={{ mode: "next12" }}
    />
  );
}

/** Truncated at the list cap: the list says how many rows it is not showing. */
export function Truncated() {
  return (
    <OwnedDividendList
      {...common}
      rows={rows.slice(0, 2)}
      truncated={true}
      totalCount={2417}
      filter={{ mode: "all", invalidFyRequested: false }}
    />
  );
}

/** Empty: no dividends recorded yet. */
export function Empty() {
  return (
    <OwnedDividendList
      {...common}
      rows={[]}
      truncated={false}
      totalCount={0}
      filter={{ mode: "all", invalidFyRequested: false }}
    />
  );
}
