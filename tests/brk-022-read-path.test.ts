/**
 * BRK-022 slice 3 -- read path + UI for announced-but-unpaid Sharesight
 * payouts. Covers: `deriveDividendHistoryForSecurity`'s `announcedUnpaid`
 * fact handling (status, tier placement, totals-mode, FX conversion,
 * Round A event dedupe); `domain/dividends/forecast.ts`'s declared-coverage
 * exclusion (ruling 1); the FY-total/current-FY/estimate/trailing-actual
 * unpaid-subtotal plumbing (`aggregations.ts`/`projection.ts`); the
 * `app/owned-dividend-history.ts` paid-overrides-pending suppression
 * (identity + proximity, unresolved counting, cross-user isolation); the
 * dividend list's `?fy=`/`?window=next12` inclusion; and the Income
 * landing/multi-year UI disclosures. See the `### BRK-022` entry in
 * TASKS.md for the full ruling set this implements.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  deriveDividendHistoryForSecurity,
  PROXIMITY_WINDOW_DAYS,
  type DividendManualRecordFact,
  type ProviderDividendEventFact,
} from "../domain/dividends/history.ts";
import { computeSecurityDividendForecast } from "../domain/dividends/forecast.ts";
import {
  computeFyDividendTotals,
  type FyDividendTotal,
} from "../domain/dividends/aggregations.ts";
import {
  computeCurrentFinancialYearRow,
  computeIncomeBreakdown,
  computePastFinancialYearRows,
  computeTrailingTwelveMonthActualDividendRow,
  projectMultiYearIncome,
  type ComputeCurrentFinancialYearRowInput,
  type MultiYearProjectionAssumptions,
  type MultiYearProjectionInput,
} from "../domain/dividends/projection.ts";
import {
  filterRowsForFyWindow,
  filterRowsForNext12,
} from "../app/dividend-list-query.ts";
import type { OwnedDividendListRow } from "../app/owned-dividend-list.ts";
import { loadOwnedDividendHistory } from "../app/owned-dividend-history.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import {
  linkSharesightPortfolioWithContext,
  runSharesightSyncWithContext,
} from "../app/sharesight-sync-service.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSharesightPendingPayoutsRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
} from "../db/repositories/index.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import type {
  SharesightClient,
  SharesightPayout,
  SharesightPortfolio,
} from "../domain/sharesight/index.ts";

// ---------------------------------------------------------------------------
// Section A -- pure history derivation of an `announcedUnpaid` fact.
// ---------------------------------------------------------------------------

function pendingFact(
  overrides: Partial<DividendManualRecordFact> = {},
): DividendManualRecordFact {
  return {
    id: "pending:pp1",
    paymentDate: "2026-09-12",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "120",
    totalFrankingDecimal: null,
    importBatchId: null,
    announcedUnpaid: true,
    ...overrides,
  };
}

test("BRK-022 slice 3: a standalone pending fact (no matching event) derives a declared_pending, announcedUnpaid, totals-mode 'imported'-tier row", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [pendingFact()],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  });
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.id, "imported:pending:pp1");
  assert.equal(row.dividendEventId, null);
  assert.equal(row.source, "imported");
  assert.equal(row.status, "declared_pending");
  assert.equal(row.announcedUnpaid, true);
  assert.equal(row.cashDecimal, "120");
  assert.equal(row.sharesDecimal, null);
  assert.equal(row.dividendPerShareDecimal, null);
  assert.equal(row.amountUnknown, false);
});

test("BRK-022 slice 3: a pending fact's status stays declared_pending even though its OWN payment date has already passed -- only a receipt/committed record proves payment, never date passage alone", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [pendingFact({ paymentDate: "2026-01-01" })],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01", // well after the pending fact's own payment date
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "declared_pending");
});

test("BRK-022 slice 3: a zero-amount pending fact is a real known $0, never fabricated as 'amount unknown'", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [pendingFact({ totalCashDecimal: "0" })],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  });
  assert.equal(rows[0]!.cashDecimal, "0");
  assert.equal(rows[0]!.amountUnknown, false);
});

test("BRK-022 slice 3, F2 correction round (RULING): an announcement's absent total_franking_decimal stays genuinely UNKNOWN -- never DIV-007's derived-zero inference, which is confirmed PAID payouts only", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    // Absent franking, totals-mode, native currency -- exactly the shape
    // that WOULD trigger DIV-007's derived-zero inference for an ordinary
    // imported (Sharesight-committed) record.
    manualRecords: [pendingFact({ totalFrankingDecimal: null })],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  });
  const row = rows[0]!;
  assert.equal(row.announcedUnpaid, true);
  assert.equal(
    row.frankingTotalDecimal,
    null,
    "absent franking on an announcement stays unknown, never a derived $0",
  );
  assert.equal(row.frankingDerivedZero, false);
});

test("BRK-022 slice 3, F2 correction round: an EXPLICIT '0' Sharesight sends on an announcement is unaffected -- it stays a real, known reported zero", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [pendingFact({ totalFrankingDecimal: "0" })],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  });
  const row = rows[0]!;
  assert.equal(row.frankingTotalDecimal, "0");
  assert.equal(row.frankingDerivedZero, false);
});

test("BRK-022 slice 3: a foreign-currency pending fact converts through the SAME BRK-010 imported-fact pipeline (cash * fx rate)", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      pendingFact({
        totalCashDecimal: "10",
        currencyCode: "USD",
        fxRateToPortfolioDecimal: "2",
        fxRateSource: "sharesight",
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  });
  const row = rows[0]!;
  assert.equal(row.cashDecimal, "20");
  assert.equal(row.originalCurrencyCode, "USD");
  assert.equal(row.fxRateToPortfolioDecimal, "2");
  assert.equal(row.fxRateSource, "sharesight");
});

test("BRK-022 slice 3 (Round A): a pending fact within PROXIMITY_WINDOW_DAYS of an active future-dated event wins that event's row -- one row, dividendEventId set, announcedUnpaid true, status derived from the EVENT's own future exDate", () => {
  const event: ProviderDividendEventFact = {
    id: "e1",
    kind: "cash",
    status: "declared",
    exDate: "2026-09-10",
    paymentDate: null,
    currencyCode: "AUD",
    grossPerShareDecimal: "5",
    supersedesEventId: null,
  };
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [event],
    overrides: [],
    receipts: [],
    manualRecords: [
      pendingFact({ paymentDate: "2026-09-12" }), // within PROXIMITY_WINDOW_DAYS (7) of e1's exDate
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  });
  assert.equal(
    rows.length,
    1,
    "the event and the pending fact collapse into ONE row",
  );
  const row = rows[0]!;
  assert.equal(row.dividendEventId, "e1");
  assert.equal(row.source, "imported");
  assert.equal(row.announcedUnpaid, true);
  assert.equal(row.status, "declared_pending"); // e1's own exDate is future
  assert.equal(row.cashDecimal, "120");
  assert.ok(
    PROXIMITY_WINDOW_DAYS >= 2,
    "sanity: the fixture dates rely on a >=2-day window",
  );
});

// ---------------------------------------------------------------------------
// Section B -- forecast.ts ruling 1: declared-coverage exclusion.
// ---------------------------------------------------------------------------

test("BRK-022 slice 3 (forecast R3): a STANDALONE announced row (no dividendEventId) never adds declared coverage -- the forecast is byte-identical with and without it", () => {
  const baseRows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  });
  const rowsWithPending = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [pendingFact({ paymentDate: "2026-08-20" })],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  });
  const input = {
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    ttmEvents: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  };
  const without = computeSecurityDividendForecast({
    ...input,
    historyRows: baseRows,
  });
  const withPending = computeSecurityDividendForecast({
    ...input,
    historyRows: rowsWithPending,
  });
  assert.deepEqual(without, withPending);
  assert.equal(without.declaredEventCount, 0);
});

test("BRK-022 slice 3 (forecast R3): an EVENT-ANCHORED announced row (Round A match) keeps counting as declared coverage -- it replaced the provider row that already contributed it", () => {
  const event: ProviderDividendEventFact = {
    id: "e1",
    kind: "cash",
    status: "declared",
    exDate: "2026-09-10",
    paymentDate: null,
    currencyCode: "AUD",
    grossPerShareDecimal: "5",
    supersedesEventId: null,
  };
  const holdingTx = [
    {
      id: "b1",
      type: "buy",
      status: "posted" as const,
      localTradeDate: "2020-01-01",
      tradeAt: "2020-01-01T00:00:00Z",
      quantityDecimal: "10",
      unitPriceDecimal: null,
      reversesTransactionId: null,
    },
  ];
  const rowsWithoutPending = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [event],
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: holdingTx,
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  });
  const rowsWithPending = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [event],
    overrides: [],
    receipts: [],
    manualRecords: [pendingFact({ paymentDate: "2026-09-12" })],
    transactions: holdingTx,
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  });
  const input = {
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    ttmEvents: [],
    transactions: holdingTx, // a real holding -- otherwise the forecast's zero-shares early return always reports declaredEventCount: 0
    defaultFrankingPercentDecimal: null,
    today: "2026-08-01",
  };
  const withoutPending = computeSecurityDividendForecast({
    ...input,
    historyRows: rowsWithoutPending,
  });
  const withPending = computeSecurityDividendForecast({
    ...input,
    historyRows: rowsWithPending,
  });
  // The provider event contributes exactly ONE declared row either way
  // (Round A collapses the announced fact into the SAME row) -- the
  // announced fact's own cash ($120) replaces the auto-derived provider
  // amount, but declaredEventCount is unchanged.
  assert.equal(withoutPending.declaredEventCount, 1);
  assert.equal(withPending.declaredEventCount, 1);
  assert.equal(withPending.declaredCashDecimal, "120");
});

// ---------------------------------------------------------------------------
// Section C -- aggregations.ts / projection.ts unpaid-subtotal plumbing.
// ---------------------------------------------------------------------------

test("BRK-022 slice 3: computeFyDividendTotals sums an announcedUnpaid row into unpaidCashDecimal/unpaidCount, ALWAYS still inside cashDecimal too", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      pendingFact({ paymentDate: "2026-08-20", totalCashDecimal: "100" }),
      {
        id: "paid-1",
        paymentDate: "2026-08-01",
        sharesDecimal: "10",
        dividendPerShareDecimal: "2",
        frankingCreditPerShareDecimal: null,
        importBatchId: null,
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-25",
  });
  const result = computeFyDividendTotals(rows, [], 7);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const fy26: FyDividendTotal = result.totals.find(
    (t) => t.endingYear === 2027,
  )!;
  assert.ok(fy26, "expected an FY27 total");
  assert.equal(fy26.cashDecimal, "120"); // 100 (pending) + 20 (paid)
  assert.equal(fy26.unpaidCashDecimal, "100");
  assert.equal(fy26.unpaidCount, 1);
});

test("BRK-022 slice 3, F3 correction round (RULING): 'unpaid' is every declared_pending row, not just an announcedUnpaid one -- a plain provider-declared event whose own ex-date has not yet passed counts too (paid $200 + provider-declared $110 => FY 310, unpaid 110, count 1)", () => {
  // e1: a PLAIN provider-declared event, no Sharesight announcement
  // involved at all (`announcedUnpaid` never set anywhere in this fixture)
  // -- its own ex-date is still in the future relative to `today`, so
  // `lifecycleStatus` derives `declared_pending` from the real event date
  // alone. An override supplies the exact shares/per-share figures so the
  // fixture needs no transactions.
  const e1: ProviderDividendEventFact = {
    id: "e1",
    kind: "cash",
    status: "declared",
    exDate: "2026-09-10", // after `today` below
    paymentDate: null,
    currencyCode: "AUD",
    grossPerShareDecimal: "11",
    supersedesEventId: null,
  };
  // e2: a provider event whose ex-date has already passed -- paid.
  const e2: ProviderDividendEventFact = {
    id: "e2",
    kind: "cash",
    status: "declared",
    exDate: "2026-08-01", // before `today` below
    paymentDate: null,
    currencyCode: "AUD",
    grossPerShareDecimal: "10",
    supersedesEventId: null,
  };
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [e1, e2],
    overrides: [
      {
        dividendEventId: "e1",
        sharesDecimal: "10",
        dividendPerShareDecimal: "11", // 10 * 11 = 110
        frankingCreditPerShareDecimal: null,
        exclude: false,
      },
      {
        dividendEventId: "e2",
        sharesDecimal: "20",
        dividendPerShareDecimal: "10", // 20 * 10 = 200
        frankingCreditPerShareDecimal: null,
        exclude: false,
      },
    ],
    receipts: [],
    manualRecords: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-25",
  });
  const e1Row = rows.find((row) => row.dividendEventId === "e1")!;
  const e2Row = rows.find((row) => row.dividendEventId === "e2")!;
  assert.equal(e1Row.status, "declared_pending");
  assert.equal(e1Row.announcedUnpaid, false, "no announcement involved");
  assert.equal(e2Row.status, "ex_date_passed");
  assert.equal(e2Row.cashDecimal, "200");
  assert.equal(e1Row.cashDecimal, "110");

  const result = computeFyDividendTotals(rows, [], 7);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const fy27: FyDividendTotal = result.totals.find(
    (t) => t.endingYear === 2027,
  )!;
  assert.ok(fy27, "expected an FY27 total");
  assert.equal(fy27.cashDecimal, "310"); // 200 (paid) + 110 (declared_pending)
  assert.equal(fy27.unpaidCashDecimal, "110");
  assert.equal(fy27.unpaidCount, 1);
});

test("BRK-022 slice 3: computeCurrentFinancialYearRow threads the unpaid fields, and reports null/0 under an fy_override", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      pendingFact({ paymentDate: "2026-08-20", totalCashDecimal: "100" }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-25",
  });
  const fyResult = computeFyDividendTotals(rows, [], 7);
  assert.equal(fyResult.ok, true);
  if (!fyResult.ok) return;

  const baseInput: ComputeCurrentFinancialYearRowInput = {
    baseCurrencyCode: "AUD",
    startMonth: 7,
    currentEndingYear: 2027,
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "ABC",
        currencyCode: "AUD",
        fyTotals: fyResult.totals,
        fyTotalsStatus: "ok",
      },
    ],
    portfolioFyOverrides: [],
    currentPortfolioValueDecimal: null,
    currentPortfolioValueStatus: "unavailable",
  };
  const result = computeCurrentFinancialYearRow(baseInput);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.dividendUnpaidCashDecimal, "100");
  assert.equal(result.row.dividendUnpaidCount, 1);
  assert.equal(result.row.dividendUnpaidGrossDecimal, "100");

  const overridden = computeCurrentFinancialYearRow({
    ...baseInput,
    portfolioFyOverrides: [
      {
        endingYear: 2027,
        grossedAmountDecimal: "500",
        frankingAmountDecimal: null,
      },
    ],
  });
  assert.equal(overridden.ok, true);
  if (!overridden.ok) return;
  assert.equal(overridden.row.dividendSource, "fy_override");
  assert.equal(overridden.row.dividendUnpaidGrossDecimal, null);
  assert.equal(overridden.row.dividendUnpaidCashDecimal, null);
  assert.equal(overridden.row.dividendUnpaidCount, 0);
});

test("BRK-022 slice 3: computePastFinancialYearRows also carries the unpaid fields (normally zero for a closed year, but not asserted zero by construction)", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      pendingFact({ paymentDate: "2025-08-20", totalCashDecimal: "40" }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-25",
  });
  const fyResult = computeFyDividendTotals(rows, [], 7);
  assert.equal(fyResult.ok, true);
  if (!fyResult.ok) return;
  const result = computePastFinancialYearRows({
    baseCurrencyCode: "AUD",
    startMonth: 7,
    currentEndingYear: 2027,
    yearsBack: 2,
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "ABC",
        currencyCode: "AUD",
        fyTotals: fyResult.totals,
        fyTotalsStatus: "ok",
      },
    ],
    portfolioFyOverrides: [],
    historicalPortfolioValueByYear: new Map(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const fy26 = result.rows.find((row) => row.endingYear === 2026)!;
  assert.equal(fy26.dividendUnpaidCashDecimal, "40");
  assert.equal(fy26.dividendUnpaidCount, 1);
});

test("BRK-022 slice 3: computeTrailingTwelveMonthActualDividendRow counts only ex_date_passed rows -- a standalone announced (declared_pending) row is excluded, unchanged", () => {
  const rowsWithout = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "paid-1",
        paymentDate: "2026-08-01",
        sharesDecimal: "10",
        dividendPerShareDecimal: "2",
        frankingCreditPerShareDecimal: null,
        importBatchId: null,
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  const rowsWith = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "paid-1",
        paymentDate: "2026-08-01",
        sharesDecimal: "10",
        dividendPerShareDecimal: "2",
        frankingCreditPerShareDecimal: null,
        importBatchId: null,
      },
      pendingFact({ paymentDate: "2026-08-10" }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  const input = { baseCurrencyCode: "AUD", asOfDate: "2026-08-13" };
  const without = computeTrailingTwelveMonthActualDividendRow({
    ...input,
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "ABC",
        currencyCode: "AUD",
        rows: rowsWithout,
      },
    ],
  });
  const withPending = computeTrailingTwelveMonthActualDividendRow({
    ...input,
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "ABC",
        currencyCode: "AUD",
        rows: rowsWith,
      },
    ],
  });
  assert.deepEqual(without, withPending);
});

test("BRK-022 slice 3: computeIncomeBreakdown/computeSecurityDividendForecast REMAINDER leg also excludes a standalone announced row (via the forecast R3 exclusion), so the FY estimate composition is unaffected", () => {
  const rowsWithout = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  const rowsWith = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [pendingFact({ paymentDate: "2026-08-20" })],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  const forecastInput = {
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    ttmEvents: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  };
  const forecastWithout = computeSecurityDividendForecast({
    ...forecastInput,
    historyRows: rowsWithout,
  });
  const forecastWith = computeSecurityDividendForecast({
    ...forecastInput,
    historyRows: rowsWith,
  });
  const breakdownWithout = computeIncomeBreakdown({
    baseCurrencyCode: "AUD",
    currentPortfolioValueDecimal: null,
    currentPortfolioValueStatus: "unavailable",
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "ABC",
        currencyCode: "AUD",
        forecast: forecastWithout,
      },
    ],
  });
  const breakdownWith = computeIncomeBreakdown({
    baseCurrencyCode: "AUD",
    currentPortfolioValueDecimal: null,
    currentPortfolioValueStatus: "unavailable",
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "ABC",
        currencyCode: "AUD",
        forecast: forecastWith,
      },
    ],
  });
  assert.deepEqual(breakdownWithout, breakdownWith);
});

// ---------------------------------------------------------------------------
// Section D -- dividend-list-query.ts: ?fy=/?window=next12 inclusion.
// ---------------------------------------------------------------------------

function listRow(
  overrides: Partial<OwnedDividendListRow>,
): OwnedDividendListRow {
  return {
    id: overrides.id ?? "row",
    portfolioSecurityId: "psa1",
    symbol: "ALPHA",
    currencyCode: "AUD",
    paymentDate: null,
    exDate: null,
    notPaid: false,
    cashDecimal: null,
    amountUnreadable: false,
    frankingTotalDecimal: null,
    frankingDerivedZero: false,
    frankingUnreadable: false,
    grossDecimal: null,
    source: "auto",
    excluded: false,
    originalCurrencyCode: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
    announcedUnpaid: false,
    ...overrides,
  };
}

test("BRK-022 slice 3: an announced (not-paid) row is included in its ?fy= window alongside a paid row for the same year", () => {
  const window = { startDate: "2026-07-01", endDate: "2027-06-30" };
  const rows = [
    listRow({ id: "paid", paymentDate: "2026-08-01", notPaid: false }),
    listRow({
      id: "announced",
      paymentDate: "2026-09-01",
      notPaid: true,
      announcedUnpaid: true,
    }),
  ];
  const result = filterRowsForFyWindow(rows, window);
  assert.deepEqual(result.rows.map((r) => r.id).sort(), ["announced", "paid"]);
});

test("BRK-022 slice 3: an announced row is included in ?window=next12 UNCAPPED, via the existing notPaid branch", () => {
  const rows = [
    listRow({
      id: "far-future-announced",
      paymentDate: "2028-01-01", // well beyond the 365-day paid-leg cap
      notPaid: true,
      announcedUnpaid: true,
    }),
  ];
  const result = filterRowsForNext12(rows, "2026-08-13");
  assert.deepEqual(
    result.map((r) => r.id),
    ["far-future-announced"],
  );
});

// ---------------------------------------------------------------------------
// Section E -- DB integration: paid-overrides-pending suppression,
// unresolved counting, cross-user isolation.
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    database.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-19', '2026-08-19', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-19', '2026-08-19', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-19', '2026-08-19', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-19', '2026-08-19', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-19', '2026-08-19', 1),
           ('portfolio-b', 'user-b', 'B', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-19', '2026-08-19', 1);
  `);
  return database;
}

/** A real, already-linked `securities`/`portfolio_securities` row -- no
 * Sharesight identifiers needed for the direct (non-sync) DB tests below. */
function seedSecurity(
  database: DatabaseSync,
  args: {
    securityId: string;
    userId: string;
    portfolioId: string;
    symbol: string;
    currencyCode: string;
    status?: string;
  },
): void {
  const now = "2026-08-01T00:00:00.000Z";
  database
    .prepare(
      `INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
       VALUES (?, 'equity', ?, ?, 'active', ?, ?)`,
    )
    .run(args.securityId, args.currencyCode, args.symbol, now, now);
  database
    .prepare(
      `INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${args.securityId}-ps`,
      args.userId,
      args.portfolioId,
      args.securityId,
      args.symbol,
      args.currencyCode,
      args.status ?? "held",
      now,
      now,
    );
}

function insertCommittedManualRecord(
  database: DatabaseSync,
  args: {
    id: string;
    userId: string;
    portfolioId: string;
    portfolioSecurityId: string;
    paymentDate: string;
    totalCashDecimal: string;
    sourceReference?: string | null;
  },
): void {
  const now = "2026-08-01T00:00:00.000Z";
  database
    .prepare(
      `INSERT INTO dividend_manual_records
        (id, user_id, portfolio_id, portfolio_security_id, payment_date,
         shares_decimal, dividend_per_share_decimal, franking_credit_per_share_decimal,
         total_cash_decimal, total_franking_decimal, import_batch_id, source_reference,
         created_at, updated_at, version)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, 'batch-1', ?, ?, ?, 1)`,
    )
    .run(
      args.id,
      args.userId,
      args.portfolioId,
      args.portfolioSecurityId,
      args.paymentDate,
      args.totalCashDecimal,
      args.sourceReference ?? null,
      now,
      now,
    );
}

test("BRK-022 slice 3 (DB): a pending row is suppressed by PROXIMITY against a committed manual/CSV record 6 days away, but NOT one 8 days away", async () => {
  const database = await migratedDatabase();
  seedSecurity(database, {
    securityId: "sec-a",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    currencyCode: "AUD",
  });
  seedSecurity(database, {
    securityId: "sec-b",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "DEF",
    currencyCode: "AUD",
  });
  insertCommittedManualRecord(database, {
    id: "committed-a",
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "sec-a-ps",
    paymentDate: "2026-08-14",
    totalCashDecimal: "50",
  });
  insertCommittedManualRecord(database, {
    id: "committed-b",
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "sec-b-ps",
    paymentDate: "2026-08-14",
    totalCashDecimal: "50",
  });
  const client = createSqliteSqlClient(database);
  const pendingRepo = createSharesightPendingPayoutsRepository(client);
  const observation = {
    sharesightHoldingId: "holding-x",
    sharesightInstrumentId: null,
    sharesightPayoutId: null,
    marketCode: "ASX",
    currencyCode: "AUD",
    exDate: null,
    grossAmountDecimal: "100",
    totalFrankingDecimal: null,
    residentWithholdingTaxDecimal: null,
    nonResidentWithholdingTaxDecimal: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
  };
  await pendingRepo.upsertObserved("user-a", "portfolio-a", [
    {
      ...observation,
      portfolioSecurityId: "sec-a-ps",
      sourceReference: "sharesight-payout:sp-1:holding-a:2026-08-20",
      symbol: "ABC",
      paymentDate: "2026-08-20", // 6 days from committed-a's 2026-08-14
      totalCashDecimal: "90",
    },
    {
      ...observation,
      portfolioSecurityId: "sec-b-ps",
      sourceReference: "sharesight-payout:sp-1:holding-b:2026-08-22",
      symbol: "DEF",
      paymentDate: "2026-08-22", // 8 days from committed-b's 2026-08-14
      totalCashDecimal: "90",
    },
  ]);

  const history = await loadOwnedDividendHistory(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-09-01T00:00:00.000Z"),
  );
  assert.equal(history.pendingPayoutCounts.pendingSuppressedByProximity, 1);
  assert.equal(history.pendingPayoutCounts.pendingIncluded, 1);

  const secA = history.securities.find(
    (s) => s.portfolioSecurityId === "sec-a-ps",
  )!;
  assert.equal(
    secA.rows.some((row) => row.id.startsWith("imported:pending:")),
    false,
    "the 6-day-proximity pending row is suppressed",
  );
  const secB = history.securities.find(
    (s) => s.portfolioSecurityId === "sec-b-ps",
  )!;
  assert.equal(
    secB.rows.some((row) => row.announcedUnpaid),
    true,
    "the 8-day-away pending row is NOT suppressed by proximity",
  );
});

test("BRK-022 slice 3 (DB): a pending row with a null security, and one whose security is not held (sold/hidden), are both counted pendingUnresolved rather than crashing", async () => {
  const database = await migratedDatabase();
  // A real HELD security -- this test targets the "not held" (`sold-ps`)
  // and "null security" branches of the MAIN derivation loop specifically,
  // distinct from the zero-held-identities early-return path (F5 correction
  // round: that path ALSO counts every active row `pendingUnresolved` now
  // -- see the dedicated F5 test below -- but exercises a different code
  // path than this one).
  seedSecurity(database, {
    securityId: "sec-held",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "HELD",
    currencyCode: "AUD",
  });
  seedSecurity(database, {
    securityId: "sec-sold",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "SOLD",
    currencyCode: "AUD",
    status: "hidden", // outside the loader's held-composition set, mirroring a sold/no-longer-tracked holding
  });
  const client = createSqliteSqlClient(database);
  const pendingRepo = createSharesightPendingPayoutsRepository(client);
  const observation = {
    sharesightHoldingId: "holding-x",
    sharesightInstrumentId: null,
    sharesightPayoutId: null,
    marketCode: "ASX",
    currencyCode: "AUD",
    exDate: null,
    grossAmountDecimal: "100",
    totalFrankingDecimal: null,
    residentWithholdingTaxDecimal: null,
    nonResidentWithholdingTaxDecimal: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
  };
  await pendingRepo.upsertObserved("user-a", "portfolio-a", [
    {
      ...observation,
      portfolioSecurityId: null,
      sourceReference: "sharesight-payout:sp-1:holding-null:2026-08-20",
      symbol: "NEW",
      paymentDate: "2026-08-20",
      totalCashDecimal: "90",
    },
    {
      ...observation,
      portfolioSecurityId: "sec-sold-ps",
      sourceReference: "sharesight-payout:sp-1:holding-sold:2026-08-21",
      symbol: "SOLD",
      paymentDate: "2026-08-21",
      totalCashDecimal: "90",
    },
  ]);

  const history = await loadOwnedDividendHistory(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-09-01T00:00:00.000Z"),
  );
  assert.equal(history.pendingPayoutCounts.pendingUnresolved, 2);
  assert.equal(history.pendingPayoutCounts.pendingIncluded, 0);
});

test("BRK-022 slice 3, F-c correction round: on the MAIN (held-identities) path, seeding more than MAX_PENDING_PAYOUTS_PER_PORTFOLIO (500) active pending payouts reports pendingTruncated: true", async () => {
  const database = await migratedDatabase();
  // A single held security is enough to route through the MAIN derivation
  // path (`identities.length > 0`) rather than the F5 zero-identities
  // early-return path -- see that dedicated F5 test below, which exercises
  // a DIFFERENT code path than this one (`app/owned-dividend-history.ts`'s
  // two separate `MAX_PENDING_PAYOUTS_PER_PORTFOLIO + 1`-bounded
  // `listActive` calls).
  seedSecurity(database, {
    securityId: "sec-held",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "HELD",
    currencyCode: "AUD",
  });
  const client = createSqliteSqlClient(database);
  const pendingRepo = createSharesightPendingPayoutsRepository(client);
  const MAX_PENDING_PAYOUTS_PER_PORTFOLIO = 500; // mirrors the private constant in app/owned-dividend-history.ts
  const observation = {
    sharesightInstrumentId: null,
    sharesightPayoutId: null,
    portfolioSecurityId: null,
    marketCode: "ASX",
    currencyCode: "AUD",
    exDate: null,
    grossAmountDecimal: "100",
    totalFrankingDecimal: null,
    residentWithholdingTaxDecimal: null,
    nonResidentWithholdingTaxDecimal: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
  };
  const rows = [];
  for (let i = 0; i < MAX_PENDING_PAYOUTS_PER_PORTFOLIO + 1; i++) {
    rows.push({
      ...observation,
      sharesightHoldingId: `holding-${i}`,
      symbol: `NEW${i}`,
      sourceReference: `sharesight-payout:sp-1:holding-${i}:2026-08-20`,
      paymentDate: "2026-08-20",
      totalCashDecimal: "10",
    });
  }
  await pendingRepo.upsertObserved("user-a", "portfolio-a", rows);

  const history = await loadOwnedDividendHistory(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-09-01T00:00:00.000Z"),
  );
  assert.equal(history.pendingTruncated, true);
  assert.equal(
    history.pendingPayoutCounts.pendingUnresolved,
    MAX_PENDING_PAYOUTS_PER_PORTFOLIO,
  );
});

test("BRK-022 slice 3, F5 correction round (RULING): a portfolio with NO held securities at all still counts its active pending payouts as pendingUnresolved, rather than never loading them", async () => {
  const database = await migratedDatabase();
  // Deliberately no `seedSecurity` call at all -- `identities.length === 0`,
  // exercising the loader's own early-return shortcut.
  const client = createSqliteSqlClient(database);
  const pendingRepo = createSharesightPendingPayoutsRepository(client);
  await pendingRepo.upsertObserved("user-a", "portfolio-a", [
    {
      portfolioSecurityId: null,
      sourceReference: "sharesight-payout:sp-1:holding-null:2026-08-20",
      sharesightHoldingId: "holding-x",
      sharesightInstrumentId: null,
      sharesightPayoutId: null,
      symbol: "NEW",
      marketCode: "ASX",
      currencyCode: "AUD",
      paymentDate: "2026-08-20",
      exDate: null,
      totalCashDecimal: "90",
      grossAmountDecimal: "90",
      totalFrankingDecimal: null,
      residentWithholdingTaxDecimal: null,
      nonResidentWithholdingTaxDecimal: null,
      fxRateToPortfolioDecimal: null,
      fxRateSource: null,
    },
  ]);

  const history = await loadOwnedDividendHistory(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-09-01T00:00:00.000Z"),
  );
  assert.equal(history.securities.length, 0);
  assert.equal(
    history.pendingPayoutCounts.pendingUnresolved,
    1,
    "the pending row cannot possibly attach to any held security -- disclosed, not silently dropped",
  );
  assert.equal(history.pendingPayoutCounts.pendingIncluded, 0);
  assert.equal(history.pendingTruncated, false);
});

test("BRK-022 slice 3 (DB): another owner's pending payout is never loaded, counted, or shown against this owner's own read", async () => {
  const database = await migratedDatabase();
  seedSecurity(database, {
    securityId: "sec-a",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    currencyCode: "AUD",
  });
  seedSecurity(database, {
    securityId: "sec-b",
    userId: "user-b",
    portfolioId: "portfolio-b",
    symbol: "ABC",
    currencyCode: "AUD",
  });
  const client = createSqliteSqlClient(database);
  const pendingRepo = createSharesightPendingPayoutsRepository(client);
  await pendingRepo.upsertObserved("user-b", "portfolio-b", [
    {
      portfolioSecurityId: "sec-b-ps",
      sourceReference: "sharesight-payout:sp-1:holding-b:2026-08-20",
      sharesightHoldingId: "holding-b",
      sharesightInstrumentId: null,
      sharesightPayoutId: null,
      symbol: "ABC",
      marketCode: "ASX",
      currencyCode: "AUD",
      paymentDate: "2026-08-20",
      exDate: null,
      totalCashDecimal: "90",
      grossAmountDecimal: "90",
      totalFrankingDecimal: null,
      residentWithholdingTaxDecimal: null,
      nonResidentWithholdingTaxDecimal: null,
      fxRateToPortfolioDecimal: null,
      fxRateSource: null,
    },
  ]);

  const historyA = await loadOwnedDividendHistory(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-09-01T00:00:00.000Z"),
  );
  assert.equal(historyA.pendingPayoutCounts.pendingIncluded, 0);
  assert.equal(historyA.pendingPayoutCounts.pendingUnresolved, 0);
  const secA = historyA.securities.find(
    (s) => s.portfolioSecurityId === "sec-a-ps",
  )!;
  assert.equal(secA.rows.length, 0);
});

// --- Identity suppression through a REAL committed record (stage -> commit,
// mirroring tests/brk-022-sync.test.ts's own parity-test recipe). ---------

function fakePayout(
  overrides: Partial<SharesightPayout> = {},
): SharesightPayout {
  return {
    id: "payout-1",
    portfolioId: "sp-1",
    holdingId: "holding-1",
    sharesightInstrumentId: null,
    symbol: "ABC",
    marketCode: "ASX",
    currencyCode: "AUD",
    paidOnDate: "2026-08-05",
    amountDecimal: "2.50",
    grossAmountDecimal: "3.57",
    frankedAmountDecimal: null,
    unfrankedAmountDecimal: null,
    frankingCreditsDecimal: "1.07",
    residentWithholdingTaxDecimal: null,
    nonResidentWithholdingTaxDecimal: null,
    goesExOnDate: null,
    state: null,
    confirmed: true,
    trust: null,
    nonTaxable: null,
    comments: null,
    exchangeRateDecimal: null,
    ...overrides,
  };
}

function fakePortfolio(
  overrides: Partial<SharesightPortfolio> = {},
): SharesightPortfolio {
  return {
    id: "sp-1",
    name: "My SS Portfolio",
    currencyCode: "AUD",
    inceptionDate: null,
    tzName: null,
    accessLevel: null,
    financialYearEnd: null,
    cgDiscount: null,
    countryCode: null,
    ownerName: null,
    taxEntityType: null,
    ...overrides,
  };
}

function fakeSharesightClient(fixtures: {
  portfolios?: SharesightPortfolio[];
  payouts?: SharesightPayout[];
}): SharesightClient {
  return {
    async listPortfolios() {
      return { ok: true, value: fixtures.portfolios ?? [] };
    },
    async getPortfolioHoldings() {
      return { ok: true, value: [] };
    },
    async listTrades() {
      return { ok: true, value: [] };
    },
    async listPayouts() {
      return { ok: true, value: fixtures.payouts ?? [] };
    },
    async listUserInstruments() {
      return { ok: true, value: [] };
    },
  };
}

const integrationOf = (client: SharesightClient) => ({
  enabled: true as const,
  client,
});

async function currentPreviewVersion(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<string> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch) throw new Error("expected batch to exist");
  const [rows, issues, mappings, portfolios, candidateRows] = await Promise.all(
    [
      staging.listRows(userId, batchId),
      staging.listIssues(userId, batchId),
      createOwnedImportMappingDecisionRepository(client).list(userId, batchId),
      createOwnedPortfolioRepository(client).list(userId),
      client.all<Record<string, unknown>>(
        `SELECT id, portfolio_id, source_symbol, source_exchange_alias,
              source_currency_code, security_id
         FROM portfolio_securities WHERE user_id = ?
        ORDER BY source_symbol ASC, id ASC`,
        [userId],
      ),
    ],
  );
  const review = buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    })),
    securityCandidates: candidateRows.map((row) => ({
      id: String(row.id),
      portfolioId: String(row.portfolio_id),
      sourceSymbol: String(row.source_symbol),
      sourceExchangeAlias:
        row.source_exchange_alias === null
          ? null
          : String(row.source_exchange_alias),
      sourceCurrencyCode: String(row.source_currency_code),
      securityId: row.security_id === null ? null : String(row.security_id),
    })),
  });
  return review.previewVersion;
}

async function commitBatch(
  client: SqlClient,
  batchId: string,
  idempotencyKey: string,
): Promise<void> {
  const batch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    batchId,
  );
  if (!batch) throw new Error("expected batch to exist");
  const previewVersion = await currentPreviewVersion(client, "user-a", batchId);
  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    batchId,
    { expectedVersion: batch.version, expectedPreviewVersion: previewVersion },
  );
  assert.equal(ready.ok, true, `expected ${batchId} to reach ready`);
  if (!ready.ok) return;
  const readyVersion = ready.review.batch.version;
  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", batchId);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: readyVersion,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey,
    confirmation: true,
    requestId: `${idempotencyKey}-request`,
  };
  let commitResult = await commitRepo.commit("user-a", batchId, commitInput);
  for (
    let attempt = 0;
    attempt < 10 && (!commitResult.ok || commitResult.status !== "committed");
    attempt += 1
  ) {
    assert.equal(commitResult.ok, true);
    commitResult = await commitRepo.commit("user-a", batchId, commitInput);
  }
  assert.equal(commitResult.ok, true);
  if (commitResult.ok) assert.equal(commitResult.status, "committed");
}

test("BRK-022 slice 3 (DB, identity suppression via a REAL committed record): once the same-identity payout stages and commits, the still-active pending row is suppressed and counted -- no double count in the derived history", async () => {
  const database = await migratedDatabase();
  database
    .prepare(
      `INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
       VALUES ('sec-abc', 'equity', 'AUD', 'ABC', 'active', '2026-08-01', '2026-08-01')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
       VALUES ('sec-abc-ps', 'user-a', 'portfolio-a', 'sec-abc', 'ABC', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01')`,
    )
    .run();
  const client = createSqliteSqlClient(database);
  const payout = fakePayout({
    id: null,
    holdingId: "holding-1",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2026-09-10",
  });
  const linked = await linkSharesightPortfolioWithContext(
    { client, userId: "user-a", requestId: "link-req" },
    "portfolio-a",
    { sharesightPortfolioId: "sp-1" },
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [payout],
        }),
      ),
    },
  );
  assert.equal(linked.ok, true);

  // Sync 1: future-dated -> a pending observation under the bare key.
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [payout],
        }),
      ),
      now: () => "2026-09-04T00:00:00.000Z",
    },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.pendingPayouts, 1);

  // Sync 2: now past its pay date -> stages a real row; commit it.
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [payout],
        }),
      ),
      now: () => "2026-09-20T00:00:00.000Z",
    },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.rowsStaged, 1);
  await commitBatch(client, second.batchId, "brk-022-read-path-commit");

  // The pending row is architecturally STILL active (withdrawal only fires
  // on absence, never on commit) -- the load-bearing property is that the
  // READ PATH suppresses it now that a committed twin exists.
  const pendingRepo = createSharesightPendingPayoutsRepository(client);
  const stillActive = await pendingRepo.listActive("user-a", "portfolio-a");
  assert.equal(
    stillActive.length,
    1,
    "the pending row is still active (not withdrawn by commit)",
  );

  const history = await loadOwnedDividendHistory(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-10-01T00:00:00.000Z"),
  );
  assert.equal(history.pendingPayoutCounts.pendingSuppressedByIdentity, 1);
  assert.equal(history.pendingPayoutCounts.pendingIncluded, 0);
  const sec = history.securities.find(
    (s) => s.portfolioSecurityId === "sec-abc-ps",
  )!;
  assert.equal(
    sec.rows.filter((row) => row.id.startsWith("imported:pending:")).length,
    0,
    "no separate standalone row for the suppressed pending fact",
  );
  assert.equal(
    sec.rows.filter((row) => row.announcedUnpaid).length,
    0,
    "no row at all carries announcedUnpaid once the committed record suppresses it",
  );
  // The committed record itself still shows, as a normal (non-announced) row.
  assert.equal(sec.rows.length, 1);
  assert.equal(sec.rows[0]!.announcedUnpaid, false);
});

// ---------------------------------------------------------------------------
// Section F -- UI: Income landing note + disclosure, multi-year paid-only,
// dividend-list "announced (Sharesight)" text.
// ---------------------------------------------------------------------------

function renderComponent(
  componentName: string,
  componentPath: string,
  props: unknown,
): string {
  const componentUrl = new URL(componentPath, import.meta.url).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ${componentName} } from ${JSON.stringify(componentUrl)};
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(createElement(${componentName}, props)),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

const MINIMAL_CURRENT_FY_ROW = {
  endingYear: 2027,
  label: "FY27",
  window: { startDate: "2026-07-01", endDate: "2027-06-30" },
  dividendSource: "fy_to_date",
  dividendGrossDecimal: "300.00",
  dividendCashDecimal: "240.00",
  dividendFrankingKnownDecimal: "60.00",
  dividendFrankingIncomplete: false,
  includedSecurityCount: 1,
  excludedSecurities: [],
  portfolioValueDecimal: "10000.00",
  valueStatus: "available",
  effectiveYieldPercentDecimal: "3.00",
  method: "financial-year-to-date total (not a full-year figure)",
  dividendUnpaidGrossDecimal: "50.00",
  dividendUnpaidCashDecimal: "50.00",
  dividendUnpaidFrankingKnownDecimal: null,
  dividendUnpaidCount: 1,
};

const MINIMAL_ESTIMATE = {
  ok: true,
  row: {
    endingYear: 2027,
    label: "FY27",
    status: "ok",
    dividendGrossDecimal: "900.00",
    dividendCashDecimal: "720.00",
    dividendFrankingKnownDecimal: "180.00",
    dividendFrankingIncomplete: false,
    dividendAmountIncomplete: false,
    excludedSecurities: [],
    partialTtmSecurities: [],
    method: "financial-year-to-date actuals plus an evidence-based projection",
  },
};

const MINIMAL_TRAILING = {
  windowFromDate: "2025-08-13",
  windowToDate: "2026-08-13",
  status: "ok",
  dividendGrossDecimal: "1250.00",
  dividendCashDecimal: "1000.00",
  dividendFrankingKnownDecimal: "250.00",
  dividendFrankingIncomplete: false,
  dividendAmountIncomplete: false,
  includedSecurityCount: 1,
  excludedSecurities: [],
};

const MINIMAL_PROJECTION = {
  status: "ok",
  baseCurrencyCode: "AUD",
  today: "2026-08-13",
  currentPortfolioValueDecimal: "10000.00",
  portfolioValueStatus: "available",
  portfolioValueCoverage: null,
  assumptionGrid: [],
  aggregateYield: {
    status: "ok",
    effectiveYieldPercentDecimal: "4.5",
    effectiveFrankingMixPercentDecimal: "1.5",
    includedValueDecimal: "10000.00",
    includedCount: 1,
    excluded: [],
    method: "value-weighted average of every held security's resolved yield",
  },
  portfolioValueGrowth: {
    source: "none",
    growthPercentDecimal: "0",
    method: "no growth assumed",
  },
  portfolioDividendGrowth: {
    source: "none",
    growthPercentDecimal: "0",
    method: "no growth assumed",
  },
  multiYear: { ok: false, reason: "portfolio_value_unavailable" },
  multiYearBaselineInput: null,
  currentFinancialYear: { ok: true, row: MINIMAL_CURRENT_FY_ROW },
  currentFinancialYearEstimate: MINIMAL_ESTIMATE,
  trailingTwelveMonthActual: MINIMAL_TRAILING,
  pastFinancialYears: { ok: true, rows: [] },
  breakdown: {
    status: "ok",
    currencyCode: "AUD",
    totalGrossDecimal: "600.00",
    totalCashDecimal: "480.00",
    totalFrankingKnownDecimal: "120.00",
    totalFrankingIncomplete: false,
    averagePerMonthDecimal: "50.00",
    averagePerWeekDecimal: "11.54",
    incomePercentOfValueDecimal: "6.00",
    incomePercentOfValueStatus: "available",
    includedSecurityCount: 1,
    excludedSecurities: [],
    partialTtmSecurities: [],
    method: "sum of every held security's 12-month baseline forecast",
  },
  financialYearStartMonth: 7,
  pendingUnresolvedPayoutCount: 2,
  // F4/F7 correction round: zero by default so every pre-existing test
  // fixture above stays byte-identical (no new disclosure renders) --
  // overridden to non-zero in the dedicated F4/F7 tests below.
  pendingSuppressedByProximityCount: 0,
  pendingTruncated: false,
};

test("BRK-022 slice 3 (UI): the FY (so far) row renders a non-colour '*$x unpaid' note when dividendUnpaidCount > 0", () => {
  const html = renderComponent(
    "IncomeLanding",
    "../app/components/income-landing.tsx",
    {
      projection: MINIMAL_PROJECTION,
      portfolioId: "portfolio-a",
      multiYearHref: "/portfolio/portfolio-a/income/multi-year",
      assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
      dividendsHref: "/portfolio/portfolio-a/income/dividends",
    },
  );
  const rowMatch = html.match(
    /<tr[^>]*class="income-row-current-fy"[^>]*>[\s\S]*?<\/tr>/,
  );
  assert.ok(rowMatch, "expected the current-FY row to render");
  assert.match(rowMatch![0], /\*\$50\.00 unpaid/);
});

test("BRK-022 slice 3 (UI): a non-zero pendingUnresolvedPayoutCount renders the 'could not be matched to a holding' disclosure below the past-FY table", () => {
  const html = renderComponent(
    "IncomeLanding",
    "../app/components/income-landing.tsx",
    {
      projection: MINIMAL_PROJECTION,
      portfolioId: "portfolio-a",
      multiYearHref: "/portfolio/portfolio-a/income/multi-year",
      assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
      dividendsHref: "/portfolio/portfolio-a/income/dividends",
    },
  );
  assert.match(html, /2 announced dividends could not be matched to a holding/);
});

test("BRK-022 slice 3 (UI): when dividendUnpaidCount is zero, no unpaid note renders (no regression for the ordinary FY so-far row)", () => {
  const html = renderComponent(
    "IncomeLanding",
    "../app/components/income-landing.tsx",
    {
      projection: {
        ...MINIMAL_PROJECTION,
        currentFinancialYear: {
          ok: true,
          row: {
            ...MINIMAL_CURRENT_FY_ROW,
            dividendUnpaidCount: 0,
            dividendUnpaidGrossDecimal: null,
          },
        },
        pendingUnresolvedPayoutCount: 0,
      },
      portfolioId: "portfolio-a",
      multiYearHref: "/portfolio/portfolio-a/income/multi-year",
      assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
      dividendsHref: "/portfolio/portfolio-a/income/dividends",
    },
  );
  assert.doesNotMatch(html, /unpaid/);
  assert.doesNotMatch(html, /could not be matched to a holding/);
});

test("BRK-022 slice 3, F4 correction round: a non-zero pendingSuppressedByProximityCount renders the 'matched a received record within 7 days' disclosure", () => {
  const html = renderComponent(
    "IncomeLanding",
    "../app/components/income-landing.tsx",
    {
      projection: {
        ...MINIMAL_PROJECTION,
        pendingSuppressedByProximityCount: 3,
      },
      portfolioId: "portfolio-a",
      multiYearHref: "/portfolio/portfolio-a/income/multi-year",
      assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
      dividendsHref: "/portfolio/portfolio-a/income/dividends",
    },
  );
  assert.match(
    html,
    /3 announced dividends matched a received record within 7 days and are not shown separately/,
  );
});

test("BRK-022 slice 3, F7 correction round: pendingTruncated renders a disclosure that some announced dividends are not shown", () => {
  const html = renderComponent(
    "IncomeLanding",
    "../app/components/income-landing.tsx",
    {
      projection: {
        ...MINIMAL_PROJECTION,
        pendingTruncated: true,
      },
      portfolioId: "portfolio-a",
      multiYearHref: "/portfolio/portfolio-a/income/multi-year",
      assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
      dividendsHref: "/portfolio/portfolio-a/income/dividends",
    },
  );
  assert.match(html, /Some announced dividends are not shown/);
});

test("BRK-022 slice 3, F4/F7 correction round: neither disclosure renders when both are zero/false (no regression)", () => {
  const html = renderComponent(
    "IncomeLanding",
    "../app/components/income-landing.tsx",
    {
      projection: MINIMAL_PROJECTION,
      portfolioId: "portfolio-a",
      multiYearHref: "/portfolio/portfolio-a/income/multi-year",
      assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
      dividendsHref: "/portfolio/portfolio-a/income/dividends",
    },
  );
  assert.doesNotMatch(html, /matched a received record within 7 days/);
  assert.doesNotMatch(html, /Some announced dividends are not shown/);
});

test("BRK-022 slice 3, F6 correction round: a past-FY row with a non-zero dividendUnpaidCount renders the same '*$x unpaid' note as the current-FY row", () => {
  const html = renderComponent(
    "IncomeLanding",
    "../app/components/income-landing.tsx",
    {
      projection: {
        ...MINIMAL_PROJECTION,
        pastFinancialYears: {
          ok: true,
          rows: [
            {
              endingYear: 2026,
              label: "FY26",
              window: { startDate: "2025-07-01", endDate: "2026-06-30" },
              dividendSource: "actual",
              dividendGrossDecimal: "500.00",
              dividendCashDecimal: "400.00",
              dividendFrankingKnownDecimal: "100.00",
              dividendFrankingIncomplete: false,
              includedSecurityCount: 1,
              excludedSecurities: [],
              portfolioValueDecimal: "9000.00",
              valueStatus: "available",
              effectiveYieldPercentDecimal: "5.00",
              method: "actual",
              dividendUnpaidGrossDecimal: "30.00",
              dividendUnpaidCashDecimal: "30.00",
              dividendUnpaidFrankingKnownDecimal: null,
              dividendUnpaidCount: 1,
            },
          ],
        },
      },
      portfolioId: "portfolio-a",
      multiYearHref: "/portfolio/portfolio-a/income/multi-year",
      assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
      dividendsHref: "/portfolio/portfolio-a/income/dividends",
    },
  );
  assert.match(html, /\*\$30\.00 unpaid/);
});

test("BRK-022 slice 3 (UI): the dividend list renders 'announced (Sharesight)' alongside 'not paid' for an announcedUnpaid row, and plain 'not paid' for an ordinary declared-pending one", () => {
  const rows: OwnedDividendListRow[] = [
    listRow({
      id: "announced-row",
      paymentDate: "2026-09-01",
      notPaid: true,
      announcedUnpaid: true,
      cashDecimal: "50",
      grossDecimal: "50",
    }),
    listRow({
      id: "declared-row",
      paymentDate: "2026-09-05",
      notPaid: true,
      announcedUnpaid: false,
      cashDecimal: "30",
      grossDecimal: "30",
    }),
  ];
  const html = renderComponent(
    "OwnedDividendList",
    "../app/components/owned-dividend-list.tsx",
    {
      portfolioId: "portfolio-a",
      baseCurrencyCode: "AUD",
      today: "2026-08-13",
      rows,
      truncated: false,
      totalCount: rows.length,
    },
  );
  assert.match(html, /not paid[\s\S]{0,80}· announced \(Sharesight\)/);
  const declaredRowHtml = html.match(
    /<tr>(?:(?!<\/tr>)[\s\S])*declared-row[\s\S]*?<\/tr>/,
  );
  // The row itself doesn't literally contain its own id in markup, so
  // instead assert there is exactly ONE "announced (Sharesight)" occurrence
  // (only the announced row gets it).
  const occurrences = (html.match(/announced \(Sharesight\)/g) ?? []).length;
  assert.equal(occurrences, 1);
  void declaredRowHtml;
});

test("BRK-022 slice 3, B1 correction round 2 (Orchestrator ruling, option 2): the DIV-011 fallback standalone '(to date)' row (multiYear degraded) keeps its OWN gross/cash/franking/yield as the full FY-to-date figures (internally consistent, matching income-landing.tsx's FY (so far) row), discloses the unpaid subset via a '*$x unpaid' note on the gross cell, and separately reports the PAID-only figure through the same 'received so far this FY' slot the merged-forecast path uses", () => {
  function renderMultiYearWithRouter(props: Record<string, unknown>): string {
    const componentUrl = new URL(
      "../app/components/income-multi-year.tsx",
      import.meta.url,
    ).href;
    const script = `
      import { createElement } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
      import { IncomeMultiYear } from ${JSON.stringify(componentUrl)};
      const routerStub = { push(){}, replace(){}, back(){}, forward(){}, refresh(){}, prefetch(){} };
      const props = ${JSON.stringify(props)};
      process.stdout.write(
        renderToStaticMarkup(
          createElement(
            AppRouterContext.Provider,
            { value: routerStub },
            createElement(IncomeMultiYear, props),
          ),
        ),
      );
    `;
    return execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf8" },
    );
  }

  // multiYear itself is degraded -- no forward forecast at all -- so the
  // component falls back to `mapCurrentRow`'s standalone "(to date)" row
  // rather than merging onto a forecast row.
  //
  // Round-1 fixture: gross $300.00 paid + $50.00 announced-but-unpaid (FY
  // total $300.00); cash $240.00, franking $60.00, yield 3.00% (all straight
  // off `MINIMAL_CURRENT_FY_ROW`, unmodified by round 1 or round 2) --
  // 3.00% is consistent with the FULL $300.00 gross against the $10,000.00
  // portfolio value (300/10000 = 3%), NOT with the paid-only $250.00 figure
  // (which would be 2.5%) -- this is exactly the inconsistency round 1 left
  // behind (B1) and round 2 must not reintroduce.
  const html = renderMultiYearWithRouter({
    portfolioId: "portfolio-a",
    assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
    dividendsHref: "/portfolio/portfolio-a/income/dividends",
    baseCurrencyCode: "AUD",
    pastFinancialYears: { ok: true, rows: [] },
    currentFinancialYear: {
      ok: true,
      row: {
        ...MINIMAL_CURRENT_FY_ROW,
        dividendGrossDecimal: "300.00",
        dividendUnpaidGrossDecimal: "50.00",
        dividendUnpaidCount: 1,
      },
    },
    multiYear: { ok: false, reason: "no_yield_coverage" },
    multiYearBaselineInput: null,
    portfolioValueGrowthPercentDecimal: "10",
    portfolioDividendGrowthPercentDecimal: "5",
    financialYearStartMonth: 7,
    yearsBack: 0,
    yearsForward: 1,
  });

  // The table has exactly one data row in this fixture (pastFinancialYears
  // is empty and multiYear is degraded), so the whole <tbody> row is the
  // degraded "(to date)" row under test.
  const rowMatch = html.match(/<tbody>[\s\S]*?<\/tbody>/);
  assert.ok(rowMatch, "expected the table body to render");
  const rowHtml = rowMatch![0];

  // Gross cell: the FULL FY-to-date figure ($300.00), not the paid-only
  // subset -- with the announced-but-unpaid subset disclosed via the "*$x
  // unpaid" note, exactly like income-landing.tsx's FY (so far) row.
  assert.match(rowHtml, /\$300\.00/);
  assert.match(rowHtml, /\*\$50\.00 unpaid/);
  // Yield cell: 3%, consistent with the full $300.00 gross figure above --
  // NOT 2.5% (which 250/10,000 -- the paid-only figure -- would produce).
  assert.match(rowHtml, /3(\.00)?%/);

  // The PAID-only figure ($300.00 - $50.00 = $250.00) is reported through
  // the SAME "received so far this FY" slot `mergeCurrentFinancialYear`
  // uses on the merged-forecast path, so both paths read identically.
  assert.match(html, /\$250\.00 received so far this FY/);

  // The row-detail dialog reuses this exact same `DisplayRow` object
  // (`selectedRow`, set from the clicked row -- see
  // `IncomeMultiYear`'s `onClick` handler) for its own gross/cash/franking/
  // yield figures, unfiltered -- see `mapCurrentRow`
  // (`app/components/income-multi-year.tsx`), which sources
  // `grossDecimal`/`cashDecimal`/`frankingDecimal`/`yieldPercentDecimal`
  // directly and unconditionally from `row.dividendGrossDecimal`/
  // `dividendCashDecimal`/`dividendFrankingKnownDecimal`/
  // `effectiveYieldPercentDecimal` (never derived/filtered per-field), so
  // the gross/yield assertions above -- the two of those four fields this
  // fixture actually varies from a plain pass-through -- already exercise
  // that path. This repo's render tests use `renderToStaticMarkup` only
  // (no jsdom/interactive-DOM layer -- see tests/div-013.test.ts's
  // documented constraint), so a click that opens the dialog itself cannot
  // be simulated to assert its rendered cash/franking text directly.
});

test("BRK-022 slice 3 (UI): income-multi-year's 'received so far this FY' figure is PAID-ONLY -- it subtracts the unpaid subtotal, never silently growing", () => {
  const ROUTER_STUB_IMPORT = `
    import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
    const routerStub = { push(){}, replace(){}, back(){}, forward(){}, refresh(){}, prefetch(){} };
  `;
  function renderMultiYearWithRouter(props: Record<string, unknown>): string {
    const componentUrl = new URL(
      "../app/components/income-multi-year.tsx",
      import.meta.url,
    ).href;
    const script = `
      import { createElement } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { IncomeMultiYear } from ${JSON.stringify(componentUrl)};
      ${ROUTER_STUB_IMPORT}
      const props = ${JSON.stringify(props)};
      process.stdout.write(
        renderToStaticMarkup(
          createElement(
            AppRouterContext.Provider,
            { value: routerStub },
            createElement(IncomeMultiYear, props),
          ),
        ),
      );
    `;
    return execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf8" },
    );
  }

  // Real `MultiYearProjectionInput`/`projectMultiYearIncome` (mirrors
  // `tests/div-013.test.ts`'s `baseAssumptions`/`baseline` fixture) rather
  // than a hand-typed `multiYear`/`multiYearBaselineInput` -- the component
  // re-runs `projectMultiYearIncomeWhatIf` against `multiYearBaselineInput`
  // on mount, which rejects a malformed assumptions shape and falls back to
  // the DIV-011 standalone "(to date)" row, silently defeating this test.
  const multiYearAssumptions: MultiYearProjectionAssumptions = {
    currentPortfolioValueDecimal: "10000",
    currentPortfolioValueStatus: "available",
    baseForecastGrossDecimal: "300", // year 1 = current FY, matches dividendGrossDecimal below
    baseForecastCashDecimal: "240",
    baseYieldIncludesPartialTtm: false,
    baseForecastFrankingIncomplete: false,
    baseExcludedSecurityCount: 0,
    valueGrowthPercentDecimal: "10",
    valueGrowthSource: "portfolio_assumption",
    dividendGrowthPercentDecimal: "5",
    dividendGrowthSource: "portfolio_assumption",
  };
  const multiYearBaselineInput: MultiYearProjectionInput = {
    assumptions: multiYearAssumptions,
    yearsForward: 1,
    startEndingYear: 2026, // year 1's own endingYear is 2027, matching the current FY row below
  };
  const multiYear = projectMultiYearIncome(multiYearBaselineInput);
  assert.equal(
    multiYear.ok,
    true,
    "fixture setup: base projection must succeed",
  );
  const html = renderMultiYearWithRouter({
    portfolioId: "portfolio-a",
    assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
    dividendsHref: "/portfolio/portfolio-a/income/dividends",
    baseCurrencyCode: "AUD",
    pastFinancialYears: { ok: true, rows: [] },
    currentFinancialYear: {
      ok: true,
      row: {
        ...MINIMAL_CURRENT_FY_ROW,
        dividendGrossDecimal: "300.00",
        dividendUnpaidGrossDecimal: "50.00",
        dividendUnpaidCount: 1,
      },
    },
    multiYear,
    multiYearBaselineInput,
    portfolioValueGrowthPercentDecimal: "10",
    portfolioDividendGrowthPercentDecimal: "5",
    financialYearStartMonth: 7,
    yearsBack: 0,
    yearsForward: 1,
  });
  // Paid-only: 300.00 - 50.00 = 250.00, never the raw 300.00 gross figure.
  assert.match(html, /\$250\.00 received so far this FY/);
  assert.doesNotMatch(html, /\$300\.00 received so far this FY/);
});

// ---------------------------------------------------------------------------
// BRK-022 polish round: three small follow-ups from the prior review round.
// ---------------------------------------------------------------------------

function renderMultiYearWithRouter(props: Record<string, unknown>): string {
  const componentUrl = new URL(
    "../app/components/income-multi-year.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
    import { IncomeMultiYear } from ${JSON.stringify(componentUrl)};
    const routerStub = { push(){}, replace(){}, back(){}, forward(){}, refresh(){}, prefetch(){} };
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(IncomeMultiYear, props),
        ),
      ),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

test("BRK-022 polish round: the DIV-011 fallback '(to date)' row does NOT print the 'received so far this FY' figure a second time when there is no real unpaid subset (dividendUnpaidCount 0, gross null)", () => {
  const html = renderMultiYearWithRouter({
    portfolioId: "portfolio-a",
    assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
    dividendsHref: "/portfolio/portfolio-a/income/dividends",
    baseCurrencyCode: "AUD",
    pastFinancialYears: { ok: true, rows: [] },
    currentFinancialYear: {
      ok: true,
      row: {
        ...MINIMAL_CURRENT_FY_ROW,
        dividendGrossDecimal: "300.00",
        dividendUnpaidGrossDecimal: null,
        dividendUnpaidCount: 0,
      },
    },
    multiYear: { ok: false, reason: "no_yield_coverage" },
    multiYearBaselineInput: null,
    portfolioValueGrowthPercentDecimal: "10",
    portfolioDividendGrowthPercentDecimal: "5",
    financialYearStartMonth: 7,
    yearsBack: 0,
    yearsForward: 1,
  });
  // The gross figure still renders once, as normal.
  assert.match(html, /\$300\.00/);
  // But NOT a second time via the "received so far this FY" slot -- with
  // nothing unpaid, that figure would be numerically identical to the gross
  // figure above, i.e. a duplicated fact rather than a new one.
  assert.doesNotMatch(html, /received so far this FY/);
});

test("BRK-022 polish round: the DIV-011 fallback '(to date)' row also suppresses the duplicate figure when dividendUnpaidCount is non-zero but the unpaid gross is an explicit '0.00' (nothing distinct to disclose)", () => {
  const html = renderMultiYearWithRouter({
    portfolioId: "portfolio-a",
    assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
    dividendsHref: "/portfolio/portfolio-a/income/dividends",
    baseCurrencyCode: "AUD",
    pastFinancialYears: { ok: true, rows: [] },
    currentFinancialYear: {
      ok: true,
      row: {
        ...MINIMAL_CURRENT_FY_ROW,
        dividendGrossDecimal: "300.00",
        dividendUnpaidGrossDecimal: "0.00",
        dividendUnpaidCount: 1,
      },
    },
    multiYear: { ok: false, reason: "no_yield_coverage" },
    multiYearBaselineInput: null,
    portfolioValueGrowthPercentDecimal: "10",
    portfolioDividendGrowthPercentDecimal: "5",
    financialYearStartMonth: 7,
    yearsBack: 0,
    yearsForward: 1,
  });
  assert.match(html, /\$300\.00/);
  assert.doesNotMatch(html, /received so far this FY/);
});

test("BRK-022 polish round: the row-detail dialog discloses 'Not yet paid (included above)' when the selected row has a non-zero unpaidCount (source-shape pin -- click-to-open dialogs can't be simulated with renderToStaticMarkup, see the B1 test above)", async () => {
  const component = await readFile(
    new URL("../app/components/income-multi-year.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /selectedRow\.unpaidCount > 0[\s\S]{0,200}Not yet paid \(included above\)[\s\S]{0,300}selectedRow\.unpaidGrossDecimal/,
  );
});
