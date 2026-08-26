// UI-046: "Last 12 Months" and "FY{yy} Estimate" rows on the Next 12 Months
// screen (owner directive: "add 2 more rows to the table: Last 12 Months and
// FY27 Estimate"). This file covers the FIRST building block -- the
// `computeSecurityDividendForecast` `windowDays` parameter that lets the
// FY27 Estimate row reuse the EXACT same declared-then-trailing-twelve-month
// forecast composition the Next 12 Months headline already uses, just
// windowed to the current financial year's remaining days instead of a
// fixed rolling 365. Only the window LENGTH changes; the annual-rate
// proration denominator stays 365 (see `forecast.ts`'s module header).
import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveDividendHistoryForSecurity,
  type ProviderDividendEventFact,
} from "../domain/dividends/history.ts";
import { computeSecurityDividendForecast } from "../domain/dividends/forecast.ts";
import type { LedgerQuantityFact } from "../domain/dividends/shares-held.ts";
import type { TrailingDividendEventInput } from "../domain/market-data/dividend-yield.ts";

const TODAY = "2026-08-13";

function tx(
  overrides: Partial<LedgerQuantityFact> & { id: string },
): LedgerQuantityFact {
  const localTradeDate = overrides.localTradeDate ?? "2020-01-01";
  return {
    type: "buy",
    status: "posted",
    localTradeDate,
    tradeAt: `${localTradeDate}T00:00:00Z`,
    quantityDecimal: "1",
    unitPriceDecimal: null,
    reversesTransactionId: null,
    ...overrides,
  };
}

const HOLDING_TX: LedgerQuantityFact[] = [
  tx({ id: "b1", localTradeDate: "2023-01-01", quantityDecimal: "10" }),
];

test("UI-046: windowDays defaults to the standard rolling 365-day window when omitted (no regression for the existing Next 12 Months headline)", () => {
  const ttmEvents: TrailingDividendEventInput[] = [
    {
      exDate: "2026-02-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "100",
      kind: "cash",
      status: "paid",
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const withoutWindowDays = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const withExplicit365 = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
    windowDays: 365,
  });
  assert.deepEqual(withoutWindowDays, withExplicit365);
  assert.equal(withoutWindowDays.windowToDate, "2027-08-12"); // today + 364
  assert.equal(withoutWindowDays.uncoveredDays, 365);
});

test("UI-046: a shorter windowDays (e.g. days remaining in the current FY) shrinks the window and the uncovered-day proration accordingly", () => {
  const ttmEvents: TrailingDividendEventInput[] = [
    {
      exDate: "2026-02-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "36.5", // 0.1/day annualised over 365 for round numbers
      kind: "cash",
      status: "paid",
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  // 100 days remaining in the current FY, purely as a round test number.
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
    windowDays: 100,
  });
  assert.equal(forecast.windowToDate, "2026-11-20"); // today + 99
  assert.equal(forecast.uncoveredDays, 100);
  // ttmAnnualCash = 10 shares * 36.5 DPS = 365; no declared cash to
  // displace; prorated over 100/365 days = 100.
  assert.equal(forecast.uncoveredCashDecimal, "100");
  assert.equal(forecast.totalCashDecimal, "100");
});

test("UI-046: a declared event beyond windowDays' shortened horizon is excluded from the window entirely (never counted, never double-displaced)", () => {
  const events: ProviderDividendEventFact[] = [
    {
      id: "e1",
      exDate: "2026-12-01", // 110 days out -- beyond a 100-day windowDays
      paymentDate: null,
      currencyCode: "AUD",
      grossPerShareDecimal: "5",
      kind: "cash",
      status: "declared",
      supersedesEventId: null,
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
    windowDays: 100,
  });
  assert.equal(
    forecast.declaredEventCount,
    0,
    "the declared event's ex-date (110 days out) falls outside the 100-day window",
  );
});

test("UI-046: a declared event WITHIN the shortened window still displaces its share of the trailing-rate tail (no double counting)", () => {
  const events: ProviderDividendEventFact[] = [
    {
      id: "e1",
      exDate: "2026-09-01", // 19 days out -- inside a 100-day window
      paymentDate: null,
      currencyCode: "AUD",
      grossPerShareDecimal: "10", // 10 shares * 10 = 100 declared cash
      kind: "cash",
      status: "declared",
      supersedesEventId: null,
    },
  ];
  const ttmEvents: TrailingDividendEventInput[] = [
    {
      exDate: "2026-02-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "36.5",
      kind: "cash",
      status: "paid",
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
    windowDays: 100,
  });
  assert.equal(forecast.declaredEventCount, 1);
  assert.equal(forecast.declaredCashDecimal, "100");
  // ttmAnnualCash = 10 * 36.5 = 365; declared cash 100 already counted, so
  // remainingAnnualCash = 265, prorated over the 80 uncovered days
  // (2026-09-02 .. 2026-11-20 inclusive) / 365.
  assert.equal(forecast.uncoveredDays, 80);
  const expectedUncovered = (265 * 80) / 365; // 58.08219178082191...
  const actual = Number(forecast.uncoveredCashDecimal);
  assert.ok(
    Math.abs(actual - expectedUncovered) < 1e-9,
    `expected ~${expectedUncovered}, got ${forecast.uncoveredCashDecimal}`,
  );
  // Total must never exceed declared + the FULL remaining annual rate --
  // the same B1 bound the standard 365-day window already guarantees.
  assert.ok(Number(forecast.totalCashDecimal) <= 365 + 1e-9);
});

test("UI-046 B1 (one-day seam): windowFromDate shifts the forward window's start (e.g. today + 1) while today itself still drives currentSharesDecimal and the backward-looking TTM evidence window", () => {
  const ttmEvents: TrailingDividendEventInput[] = [
    {
      exDate: "2026-02-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "36.5",
      kind: "cash",
      status: "paid",
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
    windowFromDate: "2026-08-14", // today + 1
    windowDays: 100,
  });
  assert.equal(forecast.windowFromDate, "2026-08-14");
  assert.equal(forecast.windowToDate, "2026-11-21"); // windowFromDate + 99
  assert.equal(forecast.uncoveredDays, 100);
  // The TTM per-share rate/provenance is still resolved -- the shift only
  // moves the FORWARD window, never the backward TTM evidence window (which
  // stays anchored on the real `today`).
  assert.equal(forecast.ttmSource, "provider_ttm");
  assert.equal(forecast.ttmPerShareDecimal, "36.5");
});

test("UI-046 B1 (one-day seam): a declared event with exDate == today is never reachable through the shifted forward window (it is structurally 'ex_date_passed', never 'declared_pending')", () => {
  const events: ProviderDividendEventFact[] = [
    {
      id: "e1",
      exDate: TODAY,
      paymentDate: null,
      currencyCode: "AUD",
      grossPerShareDecimal: "5",
      kind: "cash",
      status: "declared",
      supersedesEventId: null,
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  assert.equal(
    rows[0]!.status,
    "ex_date_passed",
    "exDate <= today always yields ex_date_passed, never declared_pending",
  );
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
    windowFromDate: "2026-08-14",
    windowDays: 100,
  });
  assert.equal(
    forecast.declaredEventCount,
    0,
    "an ex_date_passed row can never be declared_pending, independent of the window shift",
  );
});

test("UI-046: windowDays: 0 is honored explicitly (an intentionally empty window, e.g. today is the FY's last day) rather than falling back to the 365-day default", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [
      {
        exDate: "2026-02-01",
        currencyCode: "AUD",
        grossPerShareDecimal: "36.5",
        kind: "cash",
        status: "paid",
      },
    ],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
    windowFromDate: "2026-08-14",
    windowDays: 0,
  });
  assert.equal(forecast.uncoveredDays, 0);
  assert.equal(forecast.totalGrossDecimal, "0");
  assert.notEqual(
    forecast.totalGrossDecimal,
    null,
    "a genuinely empty (zero-day) window is a real, fully-known 0 -- never null/insufficient_history",
  );
});
