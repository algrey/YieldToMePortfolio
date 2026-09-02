/** DIV-004 -- imported-dividend tier separation and entry proximity warnings. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveDividendHistoryForSecurity,
  type DividendManualRecordFact,
  type DividendReceiptFact,
  type ProviderDividendEventFact,
} from "../domain/dividends/history.ts";
import type { EventOverrideFact } from "../domain/dividends/event-override-resolution.ts";
import type { LedgerQuantityFact } from "../domain/dividends/shares-held.ts";
import { computeLifetimeDividendTotals } from "../domain/dividends/aggregations.ts";
import { createImportReconciliationPreview } from "../domain/imports/reconciliation.ts";
import type {
  ImportPreviewExistingDividendEntry,
  ImportPreviewPortfolio,
  ImportPreviewSecurityCandidate,
  ImportReconciliationRow,
} from "../domain/imports/reconciliation.ts";
import type { NormalizedImportRow } from "../domain/imports/strict-versioned-parser.ts";

function event(
  overrides: Partial<ProviderDividendEventFact> & { id: string },
): ProviderDividendEventFact {
  return {
    kind: "cash",
    status: "paid",
    exDate: "2024-03-01",
    paymentDate: null,
    currencyCode: "AUD",
    grossPerShareDecimal: "1.00",
    supersedesEventId: null,
    ...overrides,
  };
}

function manual(
  overrides: Partial<DividendManualRecordFact> & { id: string },
): DividendManualRecordFact {
  return {
    paymentDate: "2024-03-04",
    sharesDecimal: "10",
    dividendPerShareDecimal: "1.00",
    frankingCreditPerShareDecimal: null,
    importBatchId: null,
    ...overrides,
  };
}

function receipt(
  overrides: Partial<DividendReceiptFact> & {
    id: string;
    dividendEventId: string;
  },
): DividendReceiptFact {
  return {
    sharesDecimal: "10",
    dividendPerShareDecimal: "1.00",
    frankingPerShareDecimal: null,
    currencyCode: "AUD",
    paymentDate: "2024-03-04",
    ...overrides,
  };
}

const HOLDING_TX: LedgerQuantityFact[] = [
  {
    id: "b1",
    type: "buy",
    status: "posted",
    localTradeDate: "2023-01-01",
    tradeAt: "2023-01-01T00:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "1",
    reversesTransactionId: null,
  },
];

// ---------------------------------------------------------------------------
// Tier matrix: imported vs each higher/lower tier, per event.
// ---------------------------------------------------------------------------

test("tier matrix: an owner-typed manual record beats an imported row for the same event -- imported retained as dominatedImported", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-03-01", grossPerShareDecimal: "1.00" }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-03-04",
      dividendPerShareDecimal: "1.05",
    }),
    manual({
      id: "imp1",
      paymentDate: "2024-03-05",
      dividendPerShareDecimal: "1.05",
      importBatchId: "batch-1",
    }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts: [],
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "manual");
  assert.ok(rows[0]!.dominatedImported);
  assert.equal(rows[0]!.dominatedImported!.dividendPerShareDecimal, "1.05");
});

test("tier matrix: a receipt beats an imported row for the same event -- imported retained as dominatedImported, receipt still available separately", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-03-01", grossPerShareDecimal: "1.00" }),
  ];
  const receipts: DividendReceiptFact[] = [
    receipt({ id: "r1", dividendEventId: "e1", paymentDate: "2024-03-03" }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "imp1",
      paymentDate: "2024-03-04",
      importBatchId: "batch-1",
    }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts,
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "receipt");
  assert.ok(rows[0]!.dominatedImported);
  assert.equal(rows[0]!.dominatedImported!.sharesDecimal, "10");
});

test("tier matrix: an override wins outright over an imported row -- the imported row's data is not shown (mirrors existing manual-vs-override behaviour)", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-03-01", grossPerShareDecimal: "1.00" }),
  ];
  const overrides: EventOverrideFact[] = [
    {
      dividendEventId: "e1",
      sharesDecimal: null,
      dividendPerShareDecimal: "2.00",
      frankingCreditPerShareDecimal: null,
      exclude: false,
    },
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({ id: "imp1", paymentDate: "2024-03-04", importBatchId: "batch-1" }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides,
    receipts: [],
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "edited");
  assert.equal(rows[0]!.dividendPerShareDecimal, "2.00");
});

test("tier matrix: an imported row beats plain auto-derivation when no owner-typed manual record or receipt is present", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-03-01", grossPerShareDecimal: "1.00" }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "imp1",
      paymentDate: "2024-03-04",
      dividendPerShareDecimal: "1.10",
      importBatchId: "batch-1",
    }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts: [],
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "imported");
  assert.equal(rows[0]!.dividendPerShareDecimal, "1.10");
  assert.equal(rows[0]!.dominatedReceipt, null);
  assert.equal(rows[0]!.dominatedImported, null);
});

// ---------------------------------------------------------------------------
// Standalone (no matching provider event) collapse.
// ---------------------------------------------------------------------------

test("standalone: an imported row duplicating a standalone owner-typed manual record collapses to ONE row, owner wins", () => {
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-05-01",
      dividendPerShareDecimal: "3.00",
    }),
    manual({
      id: "imp1",
      paymentDate: "2024-05-03",
      dividendPerShareDecimal: "3.00",
      importBatchId: "batch-1",
    }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "manual");
  assert.equal(rows[0]!.id, "manual:m1");
  assert.ok(rows[0]!.dominatedImported);
  assert.equal(rows[0]!.dominatedImported!.paymentDate, "2024-05-03");
  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(totals.receivedCashDecimal, "30");
});

test("standalone: an imported row duplicating a standalone receipt (no matching event) collapses to ONE row, receipt wins", () => {
  const receipts: DividendReceiptFact[] = [
    receipt({
      id: "r1",
      dividendEventId: "missing-event",
      paymentDate: "2024-05-01",
      dividendPerShareDecimal: "3.00",
    }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "imp1",
      paymentDate: "2024-05-02",
      dividendPerShareDecimal: "3.00",
      importBatchId: "batch-1",
    }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts,
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "receipt");
  assert.equal(rows[0]!.id, "receipt:r1");
  assert.ok(rows[0]!.dominatedImported);
});

test("standalone imported row unaffected: an imported row with no nearby event, owner-typed manual record, or receipt becomes its own standalone row", () => {
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "imp1",
      paymentDate: "2024-05-01",
      dividendPerShareDecimal: "2.50",
      importBatchId: "batch-1",
    }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "imported");
  assert.equal(rows[0]!.id, "imported:imp1");
  assert.equal(rows[0]!.dividendPerShareDecimal, "2.50");
});

test("standalone: an imported row further than the proximity window from a standalone owner manual record does NOT collapse -- both appear", () => {
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-05-01",
      dividendPerShareDecimal: "3.00",
    }),
    manual({
      id: "imp1",
      paymentDate: "2024-05-20", // 19 days later, well outside the 7-day window
      dividendPerShareDecimal: "3.00",
      importBatchId: "batch-1",
    }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 2);
  const sources = rows.map((row) => row.source).sort();
  assert.deepEqual(sources, ["imported", "manual"]);
});

// ---------------------------------------------------------------------------
// Excluded-event flow with imported records.
// ---------------------------------------------------------------------------

test("excluded event: an imported row attached to an excluded event with no owner manual record/receipt resurfaces as its own source:'imported' row", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-03-01", grossPerShareDecimal: "0.50" }),
  ];
  const overrides: EventOverrideFact[] = [
    {
      dividendEventId: "e1",
      sharesDecimal: null,
      dividendPerShareDecimal: null,
      frankingCreditPerShareDecimal: null,
      exclude: true,
    },
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "imp1",
      paymentDate: "2024-03-04",
      dividendPerShareDecimal: "0.50",
      importBatchId: "batch-1",
    }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides,
    receipts: [],
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 2);
  const excludedRow = rows.find((row) => row.source === "edited");
  const resurfaced = rows.find((row) => row.source !== "edited");
  assert.ok(excludedRow);
  assert.equal(excludedRow!.excluded, true);
  assert.ok(resurfaced);
  assert.equal(resurfaced!.source, "imported");
  assert.equal(resurfaced!.id, "imported:imp1");
});

test("excluded event: an owner manual record, a receipt, AND an imported row attached to the same excluded event still collapse to exactly ONE resurfaced row", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-03-01", grossPerShareDecimal: "0.50" }),
  ];
  const overrides: EventOverrideFact[] = [
    {
      dividendEventId: "e1",
      sharesDecimal: null,
      dividendPerShareDecimal: null,
      frankingCreditPerShareDecimal: null,
      exclude: true,
    },
  ];
  const receipts: DividendReceiptFact[] = [
    receipt({ id: "r1", dividendEventId: "e1", paymentDate: "2024-03-05" }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({ id: "m1", paymentDate: "2024-03-04" }),
    manual({ id: "imp1", paymentDate: "2024-03-06", importBatchId: "batch-1" }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides,
    receipts,
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 2);
  const excludedRow = rows.find((row) => row.source === "edited");
  const resurfacedRows = rows.filter((row) => row.source !== "edited");
  assert.ok(excludedRow);
  assert.equal(
    resurfacedRows.length,
    1,
    "all three owner facts must collapse to one row",
  );
  const resurfaced = resurfacedRows[0]!;
  assert.equal(resurfaced.source, "manual");
  assert.ok(resurfaced.dominatedReceipt);
  assert.ok(resurfaced.dominatedImported);
  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(
    totals.receivedCashDecimal,
    "10",
    "one real dividend must count once",
  );
});

// ---------------------------------------------------------------------------
// IMP-006 round-trip regression.
// ---------------------------------------------------------------------------

test("IMP-006 round-trip regression: a batch-imported manual record derives with source 'imported', not 'manual'", () => {
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "imported-row-1",
      paymentDate: "2026-08-01",
      sharesDecimal: "5",
      dividendPerShareDecimal: "0.5",
      importBatchId: "batch-a",
    }),
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "imported");
  assert.equal(rows[0]!.sharesDecimal, "5");
  assert.equal(rows[0]!.dividendPerShareDecimal, "0.5");

  // Reversal deletes the manual record entirely (DIV-001 already treats
  // `dividend_manual_records` as an owner-mutable/deletable fact) -- deriving
  // history with an empty manualRecords list (simulating post-reversal
  // state) removes the row, never leaving a phantom.
  const afterReversal = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  assert.equal(afterReversal.length, 0);
});

// ---------------------------------------------------------------------------
// Preview proximity warning (DIVIDEND_NEAR_EXISTING_ENTRY).
// ---------------------------------------------------------------------------

const PORTFOLIOS: ImportPreviewPortfolio[] = [
  {
    id: "portfolio-1",
    name: "Main",
    homeCurrencyCode: "AUD",
    historyCompleteFrom: "2020-01-01",
  },
];

const SECURITY_CANDIDATES: ImportPreviewSecurityCandidate[] = [
  {
    id: "membership-1",
    portfolioId: "portfolio-1",
    sourceSymbol: "ABC",
    sourceExchangeAlias: null,
    sourceCurrencyCode: "AUD",
    securityId: "security-1",
  },
];

function dividendRow(input: {
  rowId: string;
  localTradeDate?: string;
  type?: NormalizedImportRow["type"];
  costPerShare?: string;
}): ImportReconciliationRow {
  const localTradeDate = input.localTradeDate ?? "2024-03-04";
  const normalized: NormalizedImportRow = {
    id: input.rowId,
    symbol: "ABC",
    name: null,
    displaySymbol: null,
    exchange: null,
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: "10",
    costPerShare: input.costPerShare ?? "1.00",
    commission: null,
    transactionDate: localTradeDate,
    transactionTime: null,
    purchaseExchangeRate: null,
    type: input.type ?? "dividend",
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: `${localTradeDate}T00:00:00Z`,
    localTradeDate,
    cashEvent: null,
    frankingPerShare: null,
  };
  return {
    id: input.rowId,
    physicalRowNumber: 2,
    rowClass: "transaction",
    normalized,
    fingerprint: `fp-${input.rowId}`,
  };
}

test("preview warning: a dividend row within 7 days of an EXISTING owner-typed manual record raises DIVIDEND_NEAR_EXISTING_ENTRY (warning, not blocking)", () => {
  const existingDividendEntries: ImportPreviewExistingDividendEntry[] = [
    { portfolioSecurityId: "membership-1", paymentDate: "2024-03-01" },
  ];
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-1", localTradeDate: "2024-03-05" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries,
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
  );
  assert.ok(warning, "expected a near-existing-entry warning");
  assert.equal(warning!.severity, "warning");
  assert.equal(preview.ready, true, "a warning must never block readiness");
});

test("preview warning: with no existingDividendEntries supplied at all, no proximity warning fires (trivial no-data case)", () => {
  // BUG-013 CORRECTION: this test previously claimed "existingDividendEntries
  // only ever contains owner-typed manual records -- the caller never
  // includes previously-imported rows here" as a deliberate contract. That
  // claim was the confirmed root cause of a SILENT cross-route dividend
  // double-commit (see TASKS.md's BUG-013 entry): app/import-actions.ts's
  // `import_batch_id IS NULL` filter made a CSV-imported dividend invisible
  // to this same warning when the identical distribution later arrived via
  // Sharesight sync. That filter is now widened (see
  // `app/import-actions.ts`'s `loadReview`) to include every non-superseded
  // dividend_manual_records row regardless of route, and
  // `tests/bug-013.test.ts` covers the cross-route case directly. This test
  // now only documents the trivial case at the pure-function layer: an EMPTY
  // existingDividendEntries array (no data at all, not "imported rows
  // deliberately excluded") produces no warning.
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-1", localTradeDate: "2024-03-05" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [],
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
  );
  assert.equal(warning, undefined);
});

test("preview warning: a dividend row outside the 7-day window of an existing entry does not warn", () => {
  const existingDividendEntries: ImportPreviewExistingDividendEntry[] = [
    { portfolioSecurityId: "membership-1", paymentDate: "2024-03-01" },
  ];
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-1", localTradeDate: "2024-03-20" })], // 19 days later
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries,
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
  );
  assert.equal(warning, undefined);
});

test("preview warning: a nearby entry for a DIFFERENT security does not warn", () => {
  const existingDividendEntries: ImportPreviewExistingDividendEntry[] = [
    { portfolioSecurityId: "some-other-membership", paymentDate: "2024-03-01" },
  ];
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-1", localTradeDate: "2024-03-05" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries,
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
  );
  assert.equal(warning, undefined);
});

test("preview warning: a trade row (not a dividend) never raises DIVIDEND_NEAR_EXISTING_ENTRY even with a nearby existing dividend entry", () => {
  const existingDividendEntries: ImportPreviewExistingDividendEntry[] = [
    { portfolioSecurityId: "membership-1", paymentDate: "2024-03-01" },
  ];
  const preview = createImportReconciliationPreview({
    rows: [
      dividendRow({
        rowId: "row-1",
        localTradeDate: "2024-03-05",
        type: "buy",
        costPerShare: "10.00",
      }),
    ],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries,
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
  );
  assert.equal(warning, undefined);
});
