/** DIV-001 -- dividend events, receipts, and forecasts. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import { loadOwnedDividendHistory } from "../app/owned-dividend-history.ts";
import {
  deriveSharesHeldAtDate,
  type LedgerQuantityFact,
} from "../domain/dividends/shares-held.ts";
import {
  resolveFrankingPerShare,
  computeDefaultFrankingCredit,
} from "../domain/dividends/franking.ts";
import { fyWindowForDate } from "../domain/dividends/fy-window.ts";
import {
  deriveDividendHistoryForSecurity,
  type DividendManualRecordFact,
  type DividendReceiptFact,
  type ProviderDividendEventFact,
} from "../domain/dividends/history.ts";
import type { EventOverrideFact } from "../domain/dividends/event-override-resolution.ts";
import {
  computeFyDividendTotals,
  computeLifetimeDividendTotals,
} from "../domain/dividends/aggregations.ts";
import { computeSecurityDividendForecast } from "../domain/dividends/forecast.ts";
import {
  addDecimal,
  formatDecimalExact,
  parseDecimal,
} from "../domain/calculations/decimal.ts";

// ---------------------------------------------------------------------------
// Shares-held-at-date
// ---------------------------------------------------------------------------

function tx(
  overrides: Partial<LedgerQuantityFact> & { id: string },
): LedgerQuantityFact {
  const localTradeDate = overrides.localTradeDate ?? "2024-01-01";
  return {
    type: "buy",
    status: "posted",
    localTradeDate,
    // Defaults to midnight of `localTradeDate` unless the test needs a
    // distinct same-day ordering (override explicitly).
    tradeAt: `${localTradeDate}T00:00:00Z`,
    quantityDecimal: "1",
    unitPriceDecimal: null,
    reversesTransactionId: null,
    ...overrides,
  };
}

test("shares-at-date sums buys/sells up to and including the as-of date", () => {
  const transactions = [
    tx({
      id: "b1",
      type: "buy",
      localTradeDate: "2024-01-01",
      quantityDecimal: "100",
    }),
    tx({
      id: "s1",
      type: "sell",
      localTradeDate: "2024-06-01",
      quantityDecimal: "40",
    }),
  ];
  assert.equal(deriveSharesHeldAtDate(transactions, "2023-12-31"), "0");
  assert.equal(deriveSharesHeldAtDate(transactions, "2024-01-01"), "100");
  assert.equal(deriveSharesHeldAtDate(transactions, "2024-05-31"), "100");
  assert.equal(deriveSharesHeldAtDate(transactions, "2024-06-01"), "60");
});

test("a full exit yields zero for every later date, with no separate 'no history' state", () => {
  const transactions = [
    tx({
      id: "b1",
      type: "buy",
      localTradeDate: "2024-01-01",
      quantityDecimal: "100",
    }),
    tx({
      id: "s1",
      type: "sell",
      localTradeDate: "2024-03-01",
      quantityDecimal: "100",
    }),
  ];
  assert.equal(deriveSharesHeldAtDate(transactions, "2024-02-01"), "100");
  assert.equal(deriveSharesHeldAtDate(transactions, "2024-03-01"), "0");
  assert.equal(deriveSharesHeldAtDate(transactions, "2025-01-01"), "0");
});

test("a reversed transaction and its reversal record both contribute zero", () => {
  const transactions = [
    tx({
      id: "b1",
      type: "buy",
      status: "reversed",
      localTradeDate: "2024-01-01",
      quantityDecimal: "100",
    }),
    tx({
      id: "r1",
      type: "buy",
      status: "posted",
      localTradeDate: "2024-01-01",
      quantityDecimal: "100",
      reversesTransactionId: "b1",
    }),
    tx({
      id: "b2",
      type: "buy",
      localTradeDate: "2024-02-01",
      quantityDecimal: "25",
    }),
  ];
  assert.equal(deriveSharesHeldAtDate(transactions, "2024-06-01"), "25");
});

test("B7: a 2:1 split doubles shares held at an ex-date AFTER the split, but has no effect at an ex-date BEFORE it", () => {
  const transactions = [
    tx({
      id: "b1",
      type: "buy",
      localTradeDate: "2024-01-01",
      quantityDecimal: "100",
    }),
    tx({
      id: "sp1",
      type: "split",
      localTradeDate: "2024-04-01",
      quantityDecimal: "2", // numerator
      unitPriceDecimal: "1", // denominator
    }),
  ];
  assert.equal(deriveSharesHeldAtDate(transactions, "2024-03-31"), "100");
  assert.equal(deriveSharesHeldAtDate(transactions, "2024-04-01"), "200");
  assert.equal(deriveSharesHeldAtDate(transactions, "2024-12-31"), "200");
});

test("B7: a split applies to shares bought before it, and a later buy is unaffected by an earlier split", () => {
  const transactions = [
    tx({
      id: "b1",
      type: "buy",
      localTradeDate: "2024-01-01",
      quantityDecimal: "100",
    }),
    tx({
      id: "sp1",
      type: "split",
      localTradeDate: "2024-04-01",
      quantityDecimal: "3", // 3:1 split
      unitPriceDecimal: "1",
    }),
    tx({
      id: "b2",
      type: "buy",
      localTradeDate: "2024-05-01",
      quantityDecimal: "50",
    }),
  ];
  // 100 pre-split shares become 300; the 50 bought after the split are not
  // further multiplied.
  assert.equal(deriveSharesHeldAtDate(transactions, "2024-12-31"), "350");
});

test("follow-up: same-day buy+split order is resolved by trade_at, not an arbitrary id tiebreak", () => {
  // Buy happens BEFORE the split on the same calendar day: the 100 shares
  // should be caught by the split (100 -> 200).
  const buyThenSplit = [
    tx({
      id: "b1",
      type: "buy",
      localTradeDate: "2024-04-01",
      tradeAt: "2024-04-01T09:00:00Z",
      quantityDecimal: "100",
    }),
    tx({
      id: "sp1",
      type: "split",
      localTradeDate: "2024-04-01",
      tradeAt: "2024-04-01T16:00:00Z",
      quantityDecimal: "2",
      unitPriceDecimal: "1",
    }),
  ];
  assert.equal(deriveSharesHeldAtDate(buyThenSplit, "2024-04-01"), "200");

  // Split happens BEFORE the buy on the same calendar day: the split
  // applies to whatever was held before (0), then the 100 shares are
  // bought afterward, unaffected.
  const splitThenBuy = [
    tx({
      id: "sp1",
      type: "split",
      localTradeDate: "2024-04-01",
      tradeAt: "2024-04-01T09:00:00Z",
      quantityDecimal: "2",
      unitPriceDecimal: "1",
    }),
    tx({
      id: "b1",
      type: "buy",
      localTradeDate: "2024-04-01",
      tradeAt: "2024-04-01T16:00:00Z",
      quantityDecimal: "100",
    }),
  ];
  assert.equal(deriveSharesHeldAtDate(splitThenBuy, "2024-04-01"), "100");
});

test("decimal exactness: fractional shares sum without binary-float drift", () => {
  const transactions = [
    tx({ id: "b1", localTradeDate: "2024-01-01", quantityDecimal: "0.1" }),
    tx({ id: "b2", localTradeDate: "2024-01-02", quantityDecimal: "0.2" }),
  ];
  assert.equal(deriveSharesHeldAtDate(transactions, "2024-12-31"), "0.3");
});

// ---------------------------------------------------------------------------
// Franking resolution chain
// ---------------------------------------------------------------------------

test("franking chain: override wins outright over the default", () => {
  const result = resolveFrankingPerShare("0.42", "50", "1.00");
  assert.deepEqual(result, { source: "override", perShareDecimal: "0.42" });
});

test("franking chain: default grosses up the franked-proportion % into an ATO franking credit at the 30% company tax rate", () => {
  // Fully franked (100%) at the standard 30% company tax rate: credit =
  // dividend x 3/7 ~= 42.857% of the cash dividend -- matching the owner's
  // approved wireframe's "franking if not known: 42.86%" figure.
  const fullyFranked = resolveFrankingPerShare(null, "100", "1.00");
  assert.equal(fullyFranked.source, "default");
  assert.equal(fullyFranked.perShareDecimal, "0.428571428571428571428571");

  // Half franked: half of the fully-franked credit.
  const halfFranked = resolveFrankingPerShare(null, "50", "1.00");
  assert.equal(halfFranked.source, "default");
  assert.equal(halfFranked.perShareDecimal, "0.214285714285714285714286");
});

test("franking chain: no override and no default is unknown, never a silent zero", () => {
  const result = resolveFrankingPerShare(null, null, "1.00");
  assert.deepEqual(result, { source: "unknown", perShareDecimal: null });
});

// ---------------------------------------------------------------------------
// FY window for an arbitrary historical date
// ---------------------------------------------------------------------------

test("fyWindowForDate: July start month, boundary dates on either side of the FY line", () => {
  const juneEnd = fyWindowForDate("2024-06-30", 7);
  assert.equal(juneEnd.ok, true);
  if (juneEnd.ok) {
    assert.equal(juneEnd.label, "FY24");
    assert.equal(juneEnd.window.startDate, "2023-07-01");
    assert.equal(juneEnd.window.endDate, "2024-06-30");
  }
  const julyStart = fyWindowForDate("2024-07-01", 7);
  assert.equal(julyStart.ok, true);
  if (julyStart.ok) {
    assert.equal(julyStart.label, "FY25");
    assert.equal(julyStart.window.startDate, "2024-07-01");
  }
});

test("fyWindowForDate: a January start month produces plain calendar-year windows", () => {
  const result = fyWindowForDate("2024-06-15", 1);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.label, "FY24");
    assert.equal(result.window.startDate, "2024-01-01");
    assert.equal(result.window.endDate, "2024-12-31");
  }
});

test("fyWindowForDate rejects an out-of-range start month", () => {
  const result = fyWindowForDate("2024-06-15", 13);
  assert.deepEqual(result, { ok: false, reason: "invalid_start_month" });
});

// ---------------------------------------------------------------------------
// deriveDividendHistoryForSecurity -- precedence, lineage, exclusion, dedupe
// ---------------------------------------------------------------------------

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

const HOLDING_TX: LedgerQuantityFact[] = [
  tx({ id: "b1", localTradeDate: "2023-01-01", quantityDecimal: "10" }),
];

test("BINDING: an override on a superseded event lineage still wins over the corrected provider value", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", status: "superseded", grossPerShareDecimal: "1.00" }),
    event({ id: "e2", supersedesEventId: "e1", grossPerShareDecimal: "1.25" }),
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
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides,
    receipts: [],
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  const [row] = rows;
  // Row is keyed to the CURRENT active event (e2), not the superseded one.
  assert.equal(row!.dividendEventId, "e2");
  assert.equal(row!.source, "edited");
  // The override's value wins, not the corrected provider value (1.25).
  assert.equal(row!.dividendPerShareDecimal, "2.00");
  assert.equal(row!.sharesDecimal, "10");
  assert.equal(row!.cashDecimal, "20");
});

test("a naive current-active-only lookup would have missed the lineage override (regression guard)", () => {
  // Sanity check the fixture actually exercises the lineage: an override
  // keyed to a NON-active (superseded) event id, resolved purely via
  // `resolveEventOverrideForLineage`'s walk, not a direct id match.
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", status: "superseded" }),
    event({ id: "e2", supersedesEventId: "e1" }),
  ];
  assert.notEqual(events[0]!.id, events[1]!.id);
});

test("exclude flag: the row is still returned (retrievable) but omitted from lifetime totals", () => {
  const events: ProviderDividendEventFact[] = [event({ id: "e1" })];
  const overrides: EventOverrideFact[] = [
    {
      dividendEventId: "e1",
      sharesDecimal: null,
      dividendPerShareDecimal: null,
      frankingCreditPerShareDecimal: null,
      exclude: true,
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides,
    receipts: [],
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.excluded, true);
  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(totals.receivedCashDecimal, "0");
  assert.equal(totals.excludedCount, 1);
  assert.equal(totals.rowCount, 1);
});

test("B3: excluding a duplicate provider event does not destroy the owner's manual record (exact reviewer repro)", () => {
  // Owner recorded a manual $500 dividend; the provider later ingests the
  // same event; the owner excludes the provider's (duplicate) event.
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2024-03-10",
      paymentDate: null,
      grossPerShareDecimal: "50",
    }),
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
    {
      id: "m1",
      paymentDate: "2024-03-12", // within the proximity window of e1
      sharesDecimal: "10",
      dividendPerShareDecimal: "50",
      frankingCreditPerShareDecimal: null,
    },
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
  // Two rows: the excluded provider event (contributes nothing to totals)
  // and the manual record, resurfaced as its own standalone row.
  assert.equal(rows.length, 2);
  const excludedRow = rows.find((row) => row.dividendEventId === "e1");
  const manualRow = rows.find((row) => row.id === "manual:m1");
  assert.ok(excludedRow);
  assert.equal(excludedRow!.excluded, true);
  assert.ok(manualRow, "the manual record must resurface, not vanish");
  assert.equal(manualRow!.source, "manual");
  assert.equal(manualRow!.cashDecimal, "500");
  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(
    totals.receivedCashDecimal,
    "500",
    "the manual $500 must still count toward lifetime totals",
  );
});

test("B3: a receipt attached to an excluded event also resurfaces rather than vanishing", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-03-10", paymentDate: null }),
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
    {
      id: "r1",
      dividendEventId: "e1",
      sharesDecimal: "10",
      dividendPerShareDecimal: "1.00",
      frankingPerShareDecimal: null,
      currencyCode: "AUD",
      paymentDate: "2024-03-15",
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides,
    receipts,
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 2);
  const receiptRow = rows.find((row) => row.id === "receipt:r1");
  assert.ok(receiptRow, "the receipt must resurface, not vanish");
  assert.equal(receiptRow!.excluded, false);
  assert.equal(receiptRow!.cashDecimal, "10");
});

test("BLOCKING (round 3): an excluded event with BOTH a receipt and a manual record resurfaces as exactly ONE row, not two -- exact reviewer repro (received 500, not 1000)", () => {
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2024-03-01",
      paymentDate: null,
      grossPerShareDecimal: "0.50",
    }),
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
    {
      id: "r1",
      dividendEventId: "e1",
      sharesDecimal: "1000",
      dividendPerShareDecimal: "0.50",
      frankingPerShareDecimal: null,
      currencyCode: "AUD",
      paymentDate: "2024-03-05",
    },
  ];
  const manualRecords: DividendManualRecordFact[] = [
    {
      id: "m1",
      paymentDate: "2024-03-04",
      sharesDecimal: "1000",
      dividendPerShareDecimal: "0.50",
      frankingCreditPerShareDecimal: null,
    },
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
  // Exactly two rows: the excluded provider-event row (contributes
  // nothing) and ONE resurfaced owner-fact row -- never a separate manual
  // row AND a separate receipt row for the same real $500 dividend.
  assert.equal(rows.length, 2);
  const excludedRow = rows.find((row) => row.source === "edited");
  const resurfacedRows = rows.filter((row) => row.source !== "edited");
  assert.ok(excludedRow);
  assert.equal(excludedRow!.excluded, true);
  assert.equal(
    resurfacedRows.length,
    1,
    "manual and receipt must collapse to one row",
  );
  const resurfaced = resurfacedRows[0]!;
  // Manual wins per B5 precedence; the receipt is consumed, not duplicated,
  // its values visible as `dominatedReceipt`.
  assert.equal(resurfaced.source, "manual");
  assert.equal(resurfaced.id, "manual:m1");
  assert.equal(resurfaced.dividendEventId, "e1");
  assert.equal(resurfaced.cashDecimal, "500");
  assert.ok(resurfaced.dominatedReceipt);
  assert.equal(resurfaced.dominatedReceipt!.sharesDecimal, "1000");
  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(
    totals.receivedCashDecimal,
    "500",
    "one real $500 dividend must count once, not twice",
  );
});

test("follow-up: a receipt attached to a CANCELLED (never-active) event resurfaces as a standalone row", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-03-10", status: "cancelled" }),
  ];
  const receipts: DividendReceiptFact[] = [
    {
      id: "r1",
      dividendEventId: "e1",
      sharesDecimal: "10",
      dividendPerShareDecimal: "2.00",
      frankingPerShareDecimal: null,
      currencyCode: "AUD",
      paymentDate: "2024-03-20",
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts,
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  // The cancelled event never enters `activeEvents` at all, so the only row
  // is the resurfaced orphan receipt.
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "receipt:r1");
  assert.equal(rows[0]!.cashDecimal, "20");
});

test("B4: global nearest-wins proximity matching (interim + special 3 days apart; manual belongs to the special, not the nearer-processed interim)", () => {
  const events: ProviderDividendEventFact[] = [
    // Interim dividend: processed first in ascending-date order under the
    // old per-event-greedy algorithm, which wrongly grabbed the manual
    // record for itself even though the special dividend is the true
    // closest match.
    event({
      id: "interim",
      kind: "cash",
      exDate: "2024-03-01",
      paymentDate: null,
      grossPerShareDecimal: "50",
    }),
    event({
      id: "special",
      kind: "special",
      exDate: "2024-03-04",
      paymentDate: null,
      grossPerShareDecimal: "40",
    }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    {
      // 3 days after the special (closest), 6 days after the interim.
      id: "m1",
      paymentDate: "2024-03-07",
      sharesDecimal: "10",
      dividendPerShareDecimal: "90", // the manual's own (correct) amount
      frankingCreditPerShareDecimal: null,
    },
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
  assert.equal(rows.length, 2);
  const interimRow = rows.find((row) => row.dividendEventId === "interim");
  const specialRow = rows.find((row) => row.dividendEventId === "special");
  assert.ok(interimRow);
  assert.ok(specialRow);
  // The manual record attaches to the SPECIAL event (globally closest),
  // not the interim (which a per-event-greedy pass in ascending-date order
  // would have wrongly claimed first).
  assert.equal(interimRow!.source, "auto");
  assert.equal(interimRow!.cashDecimal, "500"); // 10 shares x 50
  assert.equal(specialRow!.source, "manual");
  assert.equal(specialRow!.cashDecimal, "900"); // 10 shares x 90 (the manual's own value)
  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(totals.receivedCashDecimal, "1400"); // 500 + 900, matching the reviewer's expected total
});

test("follow-up: null gross_per_share_decimal on a winning auto row is an explicit unknown-amount row, never a fabricated 0", () => {
  const events: ProviderDividendEventFact[] = [
    // Defensive/malformed input: a 'paid' event whose amount is null (the
    // DB CHECK constraint prevents this for real data, but the domain
    // function must still behave honestly if it ever happens).
    event({ id: "e1", grossPerShareDecimal: null }),
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
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.dividendPerShareDecimal, null);
  assert.equal(rows[0]!.cashDecimal, null);
  assert.equal(rows[0]!.grossDecimal, null);
  assert.equal(rows[0]!.amountUnknown, true);
  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(totals.receivedCashDecimal, "0");
  assert.equal(totals.unknownAmountCount, 1);
});

test("follow-up: multiple receipts attached to one lineage use the latest and disclose the rest via additionalReceiptsCount", () => {
  const events: ProviderDividendEventFact[] = [event({ id: "e1" })];
  const receipts: DividendReceiptFact[] = [
    {
      id: "r1",
      dividendEventId: "e1",
      sharesDecimal: "10",
      dividendPerShareDecimal: "1.00",
      frankingPerShareDecimal: null,
      currencyCode: "AUD",
      paymentDate: "2024-03-10",
    },
    {
      id: "r2",
      dividendEventId: "e1",
      sharesDecimal: "10",
      dividendPerShareDecimal: "1.10", // corrected/latest
      frankingPerShareDecimal: null,
      currencyCode: "AUD",
      paymentDate: "2024-03-20",
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts,
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.dividendPerShareDecimal, "1.10");
  assert.equal(rows[0]!.additionalReceiptsCount, 1);
});

test("follow-up: an overridden row still surfaces the provider's original per-share amount for a detail view", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", grossPerShareDecimal: "1.00" }),
  ];
  const overrides: EventOverrideFact[] = [
    {
      dividendEventId: "e1",
      sharesDecimal: null,
      dividendPerShareDecimal: "1.50",
      frankingCreditPerShareDecimal: null,
      exclude: false,
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides,
    receipts: [],
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows[0]!.dividendPerShareDecimal, "1.50");
  assert.equal(rows[0]!.providerGrossPerShareDecimal, "1.00");
});

test("follow-up: mixed-currency rows return an explicit mixed_currency state instead of blending under one label", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", currencyCode: "AUD" }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    {
      id: "m1",
      paymentDate: "2024-08-01",
      sharesDecimal: "5",
      dividendPerShareDecimal: "1.00",
      frankingCreditPerShareDecimal: null,
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "USD", // owner typed a manual record in a different currency
    events,
    overrides: [],
    receipts: [],
    manualRecords,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  const lifetimeAud = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(lifetimeAud.status, "mixed_currency");
  assert.equal(lifetimeAud.receivedCashDecimal, null);
  assert.equal(lifetimeAud.rowCount, rows.length);
  const fyResult = computeFyDividendTotals(rows, [], 7);
  assert.deepEqual(fyResult, { ok: false, reason: "mixed_currency" });
});

test("receipt precedence: an imported receipt tied to the event wins over auto-derivation", () => {
  const events: ProviderDividendEventFact[] = [event({ id: "e1" })];
  const receipts: DividendReceiptFact[] = [
    {
      id: "r1",
      dividendEventId: "e1",
      sharesDecimal: "8",
      dividendPerShareDecimal: "0.9",
      frankingPerShareDecimal: "0.1",
      currencyCode: "AUD",
      paymentDate: "2024-03-15",
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts,
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "receipt");
  assert.equal(rows[0]!.sharesDecimal, "8");
  assert.equal(rows[0]!.dividendPerShareDecimal, "0.9");
  assert.equal(rows[0]!.franking.perShareDecimal, "0.1");
});

test("manual/receipt vs event proximity dedupe: inside the window wins, one row only", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-03-10", paymentDate: null }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    {
      id: "m1",
      paymentDate: "2024-03-17", // exactly 7 days after exDate -- inside the window
      sharesDecimal: "10",
      dividendPerShareDecimal: "1.00",
      frankingCreditPerShareDecimal: null,
    },
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
  assert.equal(rows[0]!.dividendEventId, "e1");
});

test("manual/receipt vs event proximity dedupe: outside the window becomes its own standalone row", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-03-10", paymentDate: null }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    {
      id: "m1",
      paymentDate: "2024-03-18", // 8 days after exDate -- outside the window
      sharesDecimal: "10",
      dividendPerShareDecimal: "1.00",
      frankingCreditPerShareDecimal: null,
    },
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
  assert.equal(rows.length, 2);
  const eventRow = rows.find((row) => row.dividendEventId === "e1");
  const manualRow = rows.find((row) => row.dividendEventId === null);
  assert.ok(eventRow);
  assert.ok(manualRow);
  assert.equal(eventRow!.source, "auto");
  assert.equal(manualRow!.source, "manual");
});

test("B5 (Orchestrator ruling): a manual record duplicating a RECEIPT-covered event WINS the row -- manual > receipt -- but the receipt is still consumed (no duplicate row), its values visible as secondary", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-03-10", paymentDate: null }),
  ];
  const receipts: DividendReceiptFact[] = [
    {
      id: "r1",
      dividendEventId: "e1",
      sharesDecimal: "8", // deliberately different from the manual record's own values
      dividendPerShareDecimal: "0.9",
      frankingPerShareDecimal: "0.05",
      currencyCode: "AUD",
      paymentDate: "2024-03-15",
    },
  ];
  const manualRecords: DividendManualRecordFact[] = [
    {
      id: "m1",
      paymentDate: "2024-03-15", // same real-world dividend, entered twice
      sharesDecimal: "10",
      dividendPerShareDecimal: "1.00",
      frankingCreditPerShareDecimal: null,
    },
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
  // Exactly one row -- the double-count guard still holds -- but the
  // manual record's OWN values win it (TASKS.md precedence: manual/override
  // > imported receipt > auto-derived).
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "manual");
  assert.equal(rows[0]!.sharesDecimal, "10");
  assert.equal(rows[0]!.dividendPerShareDecimal, "1.00");
  // The outranked receipt is consumed (not a duplicate row) but its values
  // remain visible as secondary information.
  assert.deepEqual(rows[0]!.dominatedReceipt, {
    sharesDecimal: "8",
    dividendPerShareDecimal: "0.9",
    frankingPerShareDecimal: "0.05",
    paymentDate: "2024-03-15",
  });
});

test("declared-pending events are separated from lifetime-received totals into a pending bucket", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-01-01", status: "paid" }),
    event({ id: "e2", exDate: "2099-01-01", status: "declared" }),
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
    today: "2024-06-01",
  });
  assert.equal(rows.length, 2);
  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(totals.receivedCashDecimal, "10");
  assert.equal(totals.pendingCashDecimal, "10");
  assert.equal(totals.pendingCount, 1);
});

test("status='paid' is never treated as receipt evidence -- lifecycle status is independent of row source", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-01-01", status: "paid" }),
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
    today: "2024-06-01",
  });
  assert.equal(rows[0]!.status, "ex_date_passed");
  // Auto-derived, no receipt/manual evidence -- never conflated with "paid".
  assert.equal(rows[0]!.source, "auto");
});

// ---------------------------------------------------------------------------
// Per-FY attribution
// ---------------------------------------------------------------------------

test("per-FY attribution: dated (receipt/manual) rows win over the ex-date estimate fallback for their own year", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2023-06-25", paymentDate: null }), // FY23 by ex-date
  ];
  const receipts: DividendReceiptFact[] = [
    // Actually paid just after the FY boundary -- FY24, not FY23.
    {
      id: "r1",
      dividendEventId: "e1",
      sharesDecimal: "10",
      dividendPerShareDecimal: "1.00",
      frankingPerShareDecimal: null,
      currencyCode: "AUD",
      paymentDate: "2023-07-05",
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts,
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  const result = computeFyDividendTotals(rows, [], 7);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const fy24 = result.totals.find((total) => total.endingYear === 2024);
  const fy23 = result.totals.find((total) => total.endingYear === 2023);
  assert.ok(fy24, "FY24 (payment-date attributed) present");
  assert.equal(fy24!.source, "actual");
  assert.equal(fy24!.cashDecimal, "10");
  assert.equal(fy23, undefined, "no FY23 total fabricated from the ex-date");
});

test("B2: a single payment-dated row in a FY no longer discards every other row in that same year (reviewer repro: 4 events FY24, one receipt)", () => {
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2023-08-01",
      paymentDate: null,
      grossPerShareDecimal: "50", // 10 shares x 50 = 500 auto-derived
    }),
    event({
      id: "e2",
      exDate: "2023-10-01",
      paymentDate: null,
      grossPerShareDecimal: "50",
    }),
    event({
      id: "e3",
      exDate: "2024-01-01",
      paymentDate: null,
      grossPerShareDecimal: "50",
    }),
    // The 4th event has an actual receipt with a real payment date.
    event({ id: "e4", exDate: "2024-04-01", paymentDate: null }),
  ];
  const receipts: DividendReceiptFact[] = [
    {
      id: "r1",
      dividendEventId: "e4",
      sharesDecimal: "10",
      dividendPerShareDecimal: "50",
      frankingPerShareDecimal: null,
      currencyCode: "AUD",
      paymentDate: "2024-04-15",
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts,
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  const lifetime = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(lifetime.receivedCashDecimal, "2000");
  const result = computeFyDividendTotals(rows, [], 7);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const fy24 = result.totals.find((total) => total.endingYear === 2024);
  assert.ok(fy24);
  // All 4 events fall in FY24 (Jul 2023 - Jun 2024); the bug previously
  // discarded the 3 auto-derived (undated) rows once ANY dated row existed
  // for the year, reporting only the receipt's 500 instead of the full
  // 2000.
  assert.equal(fy24!.cashDecimal, "2000");
  assert.equal(fy24!.rowCount, 4);
  assert.equal(fy24!.source, "partially_estimated");
});

test("per-FY attribution: undated auto rows fall back to ex-date, labelled provider_estimate", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2023-08-01", paymentDate: null }),
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
    today: "2024-06-01",
  });
  const result = computeFyDividendTotals(rows, [], 7);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const fy24 = result.totals.find((total) => total.endingYear === 2024);
  assert.ok(fy24);
  assert.equal(fy24!.source, "provider_estimate");
  assert.equal(fy24!.cashDecimal, "10");
});

test("per-FY attribution respects a non-July start month", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-02-15", paymentDate: null }),
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
    today: "2024-06-01",
  });
  const result = computeFyDividendTotals(rows, [], 1); // January start = calendar year
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.totals.length, 1);
  assert.equal(result.totals[0]!.endingYear, 2024);
  assert.equal(result.totals[0]!.label, "FY24");
});

test("FY override precedence: an owner correction wins outright over the derived sum for that year", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2023-08-01", paymentDate: "2023-08-15" }),
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
    today: "2024-06-01",
  });
  const result = computeFyDividendTotals(
    rows,
    [
      {
        endingYear: 2024,
        grossedAmountDecimal: "999.99",
        frankingAmountDecimal: "1.11",
      },
    ],
    7,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const fy24 = result.totals.find((total) => total.endingYear === 2024);
  assert.ok(fy24);
  assert.equal(fy24!.source, "fy_override");
  // B6 fix: `grossed_amount_decimal` is cash+franking combined, so
  // `cashDecimal` here is normalised to `grossed - franking` (998.88), not
  // the raw grossed figure -- otherwise a consumer computing cash+franking
  // to get gross would double-count the franking portion. Every tier's
  // `cashDecimal` means the same thing: net of franking.
  assert.equal(fy24!.cashDecimal, "998.88");
  assert.equal(fy24!.frankingKnownDecimal, "1.11");
});

test("B6: FY-override cash+franking recombine to the original grossed amount, matching every other tier's convention", () => {
  const result = computeFyDividendTotals(
    [],
    [
      {
        endingYear: 2024,
        grossedAmountDecimal: "100",
        frankingAmountDecimal: "30",
      },
    ],
    7,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const fy24 = result.totals[0]!;
  assert.equal(fy24.cashDecimal, "70");
  assert.equal(fy24.frankingKnownDecimal, "30");
  assert.equal(
    formatDecimalExact(
      addDecimal(
        parseDecimal(fy24.cashDecimal!),
        parseDecimal(fy24.frankingKnownDecimal!),
      ),
    ),
    "100",
  );
});

test("B6: an FY-override with unknown franking leaves cash as the raw grossed amount (nothing known to subtract) and flags franking unknown", () => {
  const result = computeFyDividendTotals(
    [],
    [
      {
        endingYear: 2024,
        grossedAmountDecimal: "100",
        frankingAmountDecimal: null,
      },
    ],
    7,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const fy24 = result.totals[0]!;
  assert.equal(fy24.cashDecimal, "100");
  assert.equal(fy24.frankingKnownDecimal, null);
  assert.equal(fy24.frankingUnknownCount, 1);
});

// ---------------------------------------------------------------------------
// 12-month baseline forecast
// ---------------------------------------------------------------------------

test("forecast: a declared-unpaid event within the window is near-certain, using current holdings", () => {
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2024-08-01",
      status: "declared",
      grossPerShareDecimal: "0.5",
    }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps1",
      securityCurrencyCode: "AUD",
      events,
      overrides: [],
      receipts: [],
      manualRecords: [],
      transactions: HOLDING_TX,
      defaultFrankingPercentDecimal: null,
      today: "2024-06-01",
    }),
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(forecast.declaredEventCount, 1);
  assert.equal(forecast.declaredCashDecimal, "5");
});

test("follow-up: a stable payer with no declared coverage forecasts exactly the TTM annual figure, not a 366/365 over-count", () => {
  const ttmEvents = [
    {
      exDate: "2023-08-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "50", // 10 shares x 50 = 500
      kind: "cash" as const,
      status: "paid" as const,
    },
    {
      exDate: "2024-02-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "50",
      kind: "cash" as const,
      status: "paid" as const,
    },
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: [], // no declared events at all -- fully uncovered window
    ttmEvents,
    transactions: HOLDING_TX, // 10 shares held
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(forecast.status, "declared_plus_ttm");
  assert.equal(forecast.declaredCashDecimal, "0");
  // TTM annual = 10 shares x (50 + 50) = 1000. With zero declared coverage
  // the whole window is uncovered, so the total must be EXACTLY 1000 -- the
  // pre-fix 366-inclusive-day window produced 1002.74 instead.
  assert.equal(forecast.uncoveredCashDecimal, "1000");
  assert.equal(forecast.totalCashDecimal, "1000");
});

test("forecast: insufficient TTM history is disclosed, never silently zeroed, when there is no declared coverage either", () => {
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: [],
    ttmEvents: [], // no trailing history at all
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(forecast.status, "insufficient_history");
  assert.equal(forecast.totalCashDecimal, null);
  assert.equal(forecast.uncoveredReason, "insufficient_history");
});

test("forecast: no current holding forecasts an explicit, honest zero (not 'unavailable')", () => {
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: [],
    ttmEvents: [],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(forecast.status, "no_current_holding");
  assert.equal(forecast.totalCashDecimal, "0");
});

test("forecast: declared-plus-TTM combines near-certain declared events with a prorated TTM tail, without double counting", () => {
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2024-08-01",
      status: "declared",
      grossPerShareDecimal: "1.00",
    }),
  ];
  const ttmEvents = [
    {
      exDate: "2023-08-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "1.00",
      kind: "cash" as const,
      status: "paid" as const,
    },
    {
      exDate: "2024-02-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "1.00",
      kind: "cash" as const,
      status: "paid" as const,
    },
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps1",
      securityCurrencyCode: "AUD",
      events,
      overrides: [],
      receipts: [],
      manualRecords: [],
      transactions: HOLDING_TX,
      defaultFrankingPercentDecimal: null,
      today: "2024-06-01",
    }),
    ttmEvents,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(forecast.status, "declared_plus_ttm");
  assert.equal(forecast.declaredCashDecimal, "10");
  // Uncovered tail is a prorated fraction of the TTM annual figure -- strictly
  // positive but less than the full TTM annual cash (10 shares x 2.00 AUD/share TTM = 20 AUD).
  assert.ok(forecast.uncoveredCashDecimal !== null);
  assert.ok(Number(forecast.uncoveredCashDecimal) > 0);
  assert.ok(Number(forecast.uncoveredCashDecimal) < 20);
  // Never double-counted: total = declared + uncovered, exactly (decimal, not float).
  assert.equal(
    forecast.totalCashDecimal,
    formatDecimalExact(
      addDecimal(
        parseDecimal(forecast.declaredCashDecimal),
        parseDecimal(forecast.uncoveredCashDecimal!),
      ),
    ),
  );
});

test("B1 (reviewer economic fixture): a stable semiannual payer's forecast never exceeds roughly one trailing year of income, even stacked with a near-term declared event", () => {
  // Trailing year: two $500 payments (semiannual), TTM annual = 1000.
  const ttmEvents = [
    {
      exDate: "2023-08-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "50", // 10 shares x 50 = 500
      kind: "cash" as const,
      status: "paid" as const,
    },
    {
      exDate: "2024-02-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "50",
      kind: "cash" as const,
      status: "paid" as const,
    },
  ];
  // One declared event due soon (30 days out): the next semiannual payment,
  // already counted once in the trailing year's cadence.
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2024-07-01",
      status: "declared",
      grossPerShareDecimal: "50",
    }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps1",
      securityCurrencyCode: "AUD",
      events,
      overrides: [],
      receipts: [],
      manualRecords: [],
      transactions: HOLDING_TX,
      defaultFrankingPercentDecimal: null,
      today: "2024-06-01",
    }),
    ttmEvents,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });
  assert.equal(forecast.declaredCashDecimal, "500");
  // The old (broken) formula stacked the declared 500 on top of a
  // near-full-year TTM tail and returned ~1472 -- MORE than the trailing
  // year's entire 1000 income. The fixed formula must never exceed the TTM
  // annual figure for a stable payer.
  assert.ok(Number(forecast.totalCashDecimal) <= 1000);
  assert.ok(Number(forecast.totalCashDecimal) > 500); // still more than just the declared amount
  assert.notEqual(forecast.totalCashDecimal, "1472");
});

test("forecast: both the declared and uncovered-tail franking use the ATO gross-up formula, not the literal percentage", () => {
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2024-08-01",
      status: "declared",
      grossPerShareDecimal: "1.00",
    }),
  ];
  const ttmEvents = [
    {
      exDate: "2023-08-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "1.00",
      kind: "cash" as const,
      status: "paid" as const,
    },
    {
      exDate: "2024-02-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "1.00",
      kind: "cash" as const,
      status: "paid" as const,
    },
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps1",
      securityCurrencyCode: "AUD",
      events,
      overrides: [],
      receipts: [],
      manualRecords: [],
      transactions: HOLDING_TX,
      defaultFrankingPercentDecimal: "100", // fully franked
      today: "2024-06-01",
    }),
    ttmEvents,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: "100",
    today: "2024-06-01",
  });
  // Declared: 10 shares x 1.00/share cash = 10 cash; fully-franked credit = 10 x 3/7.
  assert.equal(forecast.declaredCashDecimal, "10");
  // The row-level chain rounds the PER-SHARE credit to 24dp and then sums
  // across shares, so it can differ from rounding a single TOTAL-cash
  // computation in the last decimal place -- both are correct to well
  // beyond any real precision need, so this compares numerically rather
  // than asserting byte-identical strings.
  assert.ok(
    Math.abs(
      Number(forecast.declaredFrankingKnownDecimal) -
        Number(computeDefaultFrankingCredit("10", "100")),
    ) < 1e-15,
  );
  // The literal-percentage bug would have produced a credit EQUAL to cash
  // (10) for a 100%-franked dividend; the correct gross-up is materially
  // smaller (~42.857% of cash), never as large as the cash itself.
  assert.ok(Number(forecast.declaredFrankingKnownDecimal) < 10);
  // Uncovered tail: same formula applied to the prorated cash estimate.
  assert.equal(
    forecast.uncoveredFrankingKnownDecimal,
    computeDefaultFrankingCredit(forecast.uncoveredCashDecimal!, "100"),
  );
});

// ---------------------------------------------------------------------------
// Service layer: owner-scoped, cross-user isolation
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  return db;
}

async function serviceFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01'),
      ('b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1),
      ('b','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pb','b','B','B portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s','equity','AUD','Shared Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa','a','pa','s','S','AUD','held','2026-08-01','2026-08-01'),
      ('psb','b','pb','s','S','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO market_data_providers(id,code,name,capabilities_json,rate_limit_json) VALUES('p','p','Provider','{}','{}');
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de','s','p','cash','paid','2026-03-01','AUD','1','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z','2026-03-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('txa','a','pa','psa','buy','posted','2026-01-01T00:00:00Z','2026-01-01','10','5','AUD','50','0','0','manual','a',1,'2026-01-01'),
      ('txb','b','pb','psb','buy','posted','2026-01-01T00:00:00Z','2026-01-01','5','5','AUD','25','0','0','manual','b',1,'2026-01-01');
  `);
  return db;
}

test("service layer: an owned portfolio's dividend history includes only that owner's holdings", async () => {
  const db = await serviceFixture();
  const client = createSqliteSqlClient(db);
  const historyA = await loadOwnedDividendHistory(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(historyA.securities.length, 1);
  assert.equal(historyA.securities[0]!.portfolioSecurityId, "psa");
  assert.equal(historyA.securities[0]!.rows.length, 1);
  assert.equal(historyA.securities[0]!.rows[0]!.sharesDecimal, "10");
});

test("service layer: cross-user access to another owner's portfolio is rejected", async () => {
  const db = await serviceFixture();
  const client = createSqliteSqlClient(db);
  await assert.rejects(
    () =>
      loadOwnedDividendHistory(
        client,
        "a",
        "pb",
        new Date("2026-08-13T00:00:00Z"),
      ),
    /not_owned/,
  );
});

test("service layer: no usable events and no receipts is an explicit empty state, not a fabricated total", async () => {
  const db = await serviceFixture();
  db.exec(`
    DELETE FROM dividend_events;
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES('s2','equity','AUD','No Dividends Co','2026-08-01','2026-08-01');
    UPDATE portfolio_securities SET security_id = 's2' WHERE id = 'psa';
  `);
  const client = createSqliteSqlClient(db);
  const history = await loadOwnedDividendHistory(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(history.securities[0]!.rows.length, 0);
  assert.equal(history.securities[0]!.lifetimeTotals.rowCount, 0);
  assert.equal(history.securities[0]!.lifetimeTotals.receivedCashDecimal, "0");
});

test("follow-up: one security's mixed-currency FY totals degrade to an explicit unavailable state without failing the whole portfolio load", async () => {
  const db = await serviceFixture();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('USD',840,'US dollar',2);
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES('s3','equity','AUD','Mixed Currency Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa3','a','pa','s3','S3','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('txa3','a','pa','psa3','buy','posted','2026-01-01T00:00:00Z','2026-01-01','10','5','AUD','50','0','0','manual','a',1,'2026-01-01');
    -- Two dividend events for the same security disagree on currency (USD
    -- vs AUD) -- the schema does not constrain an event's currency to match
    -- the security's own, and a provider correction/reissue could
    -- legitimately disagree with an earlier one. This produces two rows
    -- with two different currencies, which both aggregation functions
    -- detect as an internal mismatch.
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de3','s3','p','cash','paid','2026-03-01','USD','1','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z','2026-03-01'),
      ('de3b','s3','p','cash','paid','2026-04-01','AUD','1','2026-04-01T00:00:00Z','2026-04-01T00:00:00Z','2026-04-01');
  `);
  const client = createSqliteSqlClient(db);
  const history = await loadOwnedDividendHistory(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
  );
  // The whole portfolio load succeeds despite one security's data problem.
  assert.equal(history.securities.length, 2);
  const original = history.securities.find(
    (security) => security.portfolioSecurityId === "psa",
  );
  const mixedCurrency = history.securities.find(
    (security) => security.portfolioSecurityId === "psa3",
  );
  assert.ok(original, "the unrelated security still loads normally");
  assert.equal(original!.lifetimeTotals.status, "ok");
  assert.equal(original!.fyTotalsStatus, "ok");
  assert.ok(mixedCurrency);
  // The receipt's own currency (USD) differs from the security's own
  // currency (AUD) -- an explicit mixed-currency state, not a thrown error
  // or a silently blended total.
  assert.equal(mixedCurrency!.lifetimeTotals.status, "mixed_currency");
  assert.equal(mixedCurrency!.fyTotalsStatus, "mixed_currency");
  assert.deepEqual(mixedCurrency!.fyTotals, []);
});
