// UI-046: "Last 12 Months" row -- `computeTrailingTwelveMonthActualDividendRow`
// (`domain/dividends/projection.ts`). ACTUAL (received, non-projected)
// dividend cash/franking over the trailing 365 days, reusing
// `computeLifetimeDividendTotals` (DIV-001) window-filtered rather than a
// second cash-summing formula. Window boundary matches `forecast.ts`'s
// `deriveHistoryTrailingTwelveMonthDividend` convention exactly (inclusive
// both ends: `asOfDate - 365` through `asOfDate`) so the Next 12 Months
// headline's own history-TTM fallback and this row agree on what "last 12
// months" means.
import assert from "node:assert/strict";
import test from "node:test";
import { deriveDividendHistoryForSecurity } from "../domain/dividends/history.ts";
import { computeTrailingTwelveMonthActualDividendRow } from "../domain/dividends/projection.ts";

const TODAY = "2026-08-13";
const BASE_CCY = "AUD";

function rowsFor(paymentDates: string[], currencyCode = BASE_CCY) {
  return deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: currencyCode,
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: paymentDates.map((paymentDate, index) => ({
      id: `m${index}`,
      paymentDate,
      sharesDecimal: "100",
      dividendPerShareDecimal: "1.00",
      frankingCreditPerShareDecimal: "0.30",
      importBatchId: null,
    })),
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
}

test("UI-046: sums actual received cash+franking within the trailing 365-day window across every base-currency security", () => {
  const rows = rowsFor(["2026-02-01", "2026-05-01"]);
  const result = computeTrailingTwelveMonthActualDividendRow({
    baseCurrencyCode: BASE_CCY,
    asOfDate: TODAY,
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "AAA",
        currencyCode: BASE_CCY,
        rows,
      },
    ],
  });
  assert.equal(result.status, "ok");
  // Two payments of 100 shares x $1.00 = $100 cash each = $200 cash;
  // franking 100 x $0.30 = $30 each = $60.
  assert.equal(result.dividendCashDecimal, "200");
  assert.equal(result.dividendFrankingKnownDecimal, "60");
  assert.equal(result.dividendGrossDecimal, "260");
  assert.equal(result.includedSecurityCount, 1);
  assert.equal(result.excludedSecurities.length, 0);
  assert.equal(result.dividendAmountIncomplete, false);
});

test("UI-046 B2 (review finding): a windowed RECEIVED row whose cash amount is genuinely unknown is excluded from the sum (never fabricated) but flags dividendAmountIncomplete -- never a silent smaller total under status 'ok'", () => {
  const known = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: BASE_CCY,
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "m-known",
        paymentDate: "2026-02-01",
        sharesDecimal: "100",
        dividendPerShareDecimal: "1.00",
        frankingCreditPerShareDecimal: null,
        importBatchId: null,
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const unknown = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: BASE_CCY,
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "m-unknown",
        paymentDate: "2026-05-01",
        sharesDecimal: null,
        dividendPerShareDecimal: null,
        frankingCreditPerShareDecimal: null,
        totalCashDecimal: null,
        totalFrankingDecimal: null,
        importBatchId: null,
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const result = computeTrailingTwelveMonthActualDividendRow({
    baseCurrencyCode: BASE_CCY,
    asOfDate: TODAY,
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "AAA",
        currencyCode: BASE_CCY,
        rows: [...known, ...unknown],
      },
    ],
  });
  // The known $100 row still shows -- never zeroed out just because a
  // sibling row's amount is unknown.
  assert.equal(result.status, "ok");
  assert.equal(result.dividendCashDecimal, "100");
  assert.equal(result.dividendAmountIncomplete, true);
});

test("UI-046: window boundary -- a payment dated exactly 365 days before asOfDate is INCLUDED (inclusive both ends, matches forecast.ts's TTM convention)", () => {
  // 2025-08-13 is exactly 365 days before 2026-08-13.
  const rows = rowsFor(["2025-08-13"]);
  const result = computeTrailingTwelveMonthActualDividendRow({
    baseCurrencyCode: BASE_CCY,
    asOfDate: TODAY,
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "AAA",
        currencyCode: BASE_CCY,
        rows,
      },
    ],
  });
  assert.equal(result.windowFromDate, "2025-08-13");
  assert.equal(result.status, "ok");
  assert.equal(result.dividendCashDecimal, "100");
});

test("UI-046: window boundary -- a payment dated 366 days before asOfDate is EXCLUDED", () => {
  const rows = rowsFor(["2025-08-12"]);
  const result = computeTrailingTwelveMonthActualDividendRow({
    baseCurrencyCode: BASE_CCY,
    asOfDate: TODAY,
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "AAA",
        currencyCode: BASE_CCY,
        rows,
      },
    ],
  });
  // The security HAS history (just outside the window) -- a real,
  // confirmed "0" contribution, not an exclusion.
  assert.equal(result.status, "ok");
  assert.equal(result.dividendCashDecimal, "0");
  assert.equal(result.excludedSecurities.length, 0);
});

test("UI-046: a security with NO derived history at all (ever) is excluded and named no_evidence -- never a fabricated 0 (AGENTS.md)", () => {
  const result = computeTrailingTwelveMonthActualDividendRow({
    baseCurrencyCode: BASE_CCY,
    asOfDate: TODAY,
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "NEW",
        currencyCode: BASE_CCY,
        rows: [],
      },
      {
        portfolioSecurityId: "ps2",
        symbol: "AAA",
        currencyCode: BASE_CCY,
        rows: rowsFor(["2026-02-01"]),
      },
    ],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.includedSecurityCount, 1);
  assert.deepEqual(result.excludedSecurities, [
    { portfolioSecurityId: "ps1", symbol: "NEW", reason: "no_evidence" },
  ]);
  assert.equal(result.dividendCashDecimal, "100");
});

test("UI-046: a foreign-currency security is excluded and named, never mis-summed", () => {
  const usdRows = rowsFor(["2026-02-01"], "USD");
  const result = computeTrailingTwelveMonthActualDividendRow({
    baseCurrencyCode: BASE_CCY,
    asOfDate: TODAY,
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "USA",
        currencyCode: "USD",
        rows: usdRows,
      },
    ],
  });
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.excludedSecurities, [
    { portfolioSecurityId: "ps1", symbol: "USA", reason: "foreign_currency" },
  ]);
  assert.equal(result.dividendGrossDecimal, null);
});

test("UI-046: no eligible base-currency security in the portfolio at all reports unavailable, never a fabricated 0", () => {
  const result = computeTrailingTwelveMonthActualDividendRow({
    baseCurrencyCode: BASE_CCY,
    asOfDate: TODAY,
    securities: [],
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.dividendGrossDecimal, null);
  assert.equal(result.dividendCashDecimal, null);
});
