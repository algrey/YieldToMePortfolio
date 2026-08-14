/** DIV-005 -- transitive proximity chaining in dividend dedupe.
 *
 * Reviewer-reproduced gap (DIV-004 follow-up, promoted 2026-08-14): the
 * proximity collapse linked facts pairwise to EVENTS only, not
 * transitively. An owner fact anchored to an event E (within E's own
 * window) did not collapse with an imported row that was within the OWNER
 * FACT's window but outside E's -- exact repro: event pay 2024-03-20, owner
 * manual 2024-03-27 (7 days from the event, attaches), imported 2024-03-31
 * (4 days from the manual, 11 from the event) -- produced TWO rows (240
 * counted) instead of ONE (120 real). See domain/dividends/history.ts's
 * "DIV-005" comments for the fix (Round A: event-anchored single-hop
 * chaining; Round B: eventless transitive union-find).
 */
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

function event(
  overrides: Partial<ProviderDividendEventFact> & { id: string },
): ProviderDividendEventFact {
  return {
    kind: "cash",
    status: "paid",
    exDate: "2024-01-01",
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
    paymentDate: "2024-01-01",
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
    paymentDate: "2024-01-01",
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

test("exact reviewer repro: event 03-20 + owner manual 03-27 (attaches to event) + imported 03-31 (outside the event's window, inside the manual's) collapses to ONE row, manual wins, 120 not 240", () => {
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2024-03-13",
      paymentDate: "2024-03-20",
      grossPerShareDecimal: "0.50",
    }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-03-27", // 7 days from the event -- attaches directly (tier 2)
      dividendPerShareDecimal: "12.00",
    }),
    manual({
      id: "imp1",
      paymentDate: "2024-03-31", // 11 days from the event (outside), 4 from the manual (inside)
      dividendPerShareDecimal: "12.00",
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
  assert.equal(rows.length, 1, "must collapse to exactly one row, not two");
  const row = rows[0]!;
  assert.equal(row.source, "manual");
  assert.equal(row.dividendEventId, "e1");
  assert.equal(row.cashDecimal, "120");
  assert.ok(
    row.dominatedImported,
    "the imported row's evidence must remain visible",
  );
  assert.equal(row.dominatedImported!.paymentDate, "2024-03-31");
  assert.equal(row.dominatedImported!.dividendPerShareDecimal, "12.00");
});

test("excluded-event variant: the same shape resurfaces as ONE row (plus the excluded marker row), not two resurfaced rows", () => {
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2024-03-13",
      paymentDate: "2024-03-20",
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
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-03-27",
      dividendPerShareDecimal: "12.00",
    }),
    manual({
      id: "imp1",
      paymentDate: "2024-03-31",
      dividendPerShareDecimal: "12.00",
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
  assert.equal(
    rows.length,
    2,
    "the excluded marker row plus exactly one resurfaced row",
  );
  const excludedRow = rows.find((row) => row.source === "edited");
  const resurfacedRows = rows.filter((row) => row.source !== "edited");
  assert.ok(excludedRow);
  assert.equal(excludedRow!.excluded, true);
  assert.equal(resurfacedRows.length, 1);
  const resurfaced = resurfacedRows[0]!;
  assert.equal(resurfaced.source, "manual");
  assert.equal(resurfaced.cashDecimal, "120");
  assert.ok(resurfaced.dominatedImported);
  assert.equal(resurfaced.dominatedImported!.paymentDate, "2024-03-31");
});

test("receipt variant: an event-anchored receipt (attached by lineage, far from the event's own date) plus an imported row far from the event but close to the RECEIPT collapse to ONE row, receipt wins", () => {
  const events: ProviderDividendEventFact[] = [
    event({ id: "e1", exDate: "2024-01-01", grossPerShareDecimal: "0.50" }),
  ];
  const receipts: DividendReceiptFact[] = [
    receipt({
      id: "r1",
      dividendEventId: "e1",
      paymentDate: "2024-03-15", // far from the event's own ex-date; attached by FK/lineage regardless
      dividendPerShareDecimal: "12.00",
    }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "imp1",
      paymentDate: "2024-03-20", // 5 days from the receipt, ~79 from the event
      dividendPerShareDecimal: "12.00",
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
  const row = rows[0]!;
  assert.equal(row.source, "receipt");
  assert.equal(row.cashDecimal, "120");
  assert.ok(row.dominatedImported);
  assert.equal(row.dominatedImported!.paymentDate, "2024-03-20");
});

test("multi-event no-over-merge: an imported row within window of BOTH events' own manual anchors (but outside BOTH events' own direct windows) attaches only to the NEAREST anchor -- two events never collapse into one row", () => {
  const events: ProviderDividendEventFact[] = [
    // 19 days apart: far enough that neither event's OWN reference date can
    // directly match the bridging imported row below -- the only path to it
    // is via each event's winning manual anchor (Round A).
    event({
      id: "interim",
      exDate: "2024-01-01",
      grossPerShareDecimal: "0.20",
    }),
    event({
      id: "special",
      exDate: "2024-01-20",
      grossPerShareDecimal: "0.30",
    }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-01-04",
      dividendPerShareDecimal: "5.00",
    }), // 3 days from interim -- attaches to interim
    manual({
      id: "m2",
      paymentDate: "2024-01-17",
      dividendPerShareDecimal: "6.00",
    }), // 3 days from special -- attaches to special
    manual({
      id: "imp1",
      // 6 days from m1's own date, 7 from m2's, 9 from interim's own
      // reference date, 10 from special's -- reachable ONLY via chaining,
      // and nearer to m1's anchor than to m2's.
      paymentDate: "2024-01-10",
      dividendPerShareDecimal: "9.00",
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
  assert.equal(
    rows.length,
    2,
    "the two genuinely distinct dividends must never collapse into one row",
  );
  const interimRow = rows.find((row) => row.dividendEventId === "interim");
  const specialRow = rows.find((row) => row.dividendEventId === "special");
  assert.ok(interimRow);
  assert.ok(specialRow);
  assert.equal(interimRow!.source, "manual");
  assert.equal(specialRow!.source, "manual");
  assert.ok(
    interimRow!.dominatedImported,
    "the imported row chains to the NEAREST anchor (interim)",
  );
  assert.equal(interimRow!.dominatedImported!.paymentDate, "2024-01-10");
  assert.equal(
    specialRow!.dominatedImported,
    null,
    "special's row must not also claim the same imported row",
  );
});

test("long chain: manual -> imported -> receipt -> imported, each adjacent pair within the window but the ends 18 days apart (more than two windows), collapses to exactly ONE eventless row", () => {
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-01-01",
      dividendPerShareDecimal: "5.00",
    }), // day 0
    manual({
      id: "imp1",
      paymentDate: "2024-01-07", // day 6 -- 6 days from m1
      dividendPerShareDecimal: "5.00",
      importBatchId: "batch-1",
    }),
    manual({
      id: "imp2",
      paymentDate: "2024-01-19", // day 18 -- 6 days from the receipt below, 18 from m1
      dividendPerShareDecimal: "5.00",
      importBatchId: "batch-1",
    }),
  ];
  const receipts: DividendReceiptFact[] = [
    receipt({
      id: "r1",
      dividendEventId: "no-such-event", // orphan -- no matching event in this fixture
      paymentDate: "2024-01-13", // day 12 -- 6 days from imp1, 6 days from imp2
      dividendPerShareDecimal: "5.00",
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
  assert.equal(
    rows.length,
    1,
    "an eventless chain spanning more than two windows must still collapse fully, not cap at two hops",
  );
  const row = rows[0]!;
  assert.equal(row.source, "manual"); // highest tier present wins
  assert.equal(row.cashDecimal, "50");
  assert.ok(row.dominatedReceipt, "the orphan receipt must remain visible");
  assert.equal(row.dominatedReceipt!.paymentDate, "2024-01-13");
  assert.ok(row.dominatedImported, "the LATEST imported record is shown");
  assert.equal(row.dominatedImported!.paymentDate, "2024-01-19");
  assert.equal(
    row.additionalImportedCount,
    1,
    "the earlier imported record is not silently dropped -- disclosed via the count",
  );
});

test("determinism: the long-chain fixture produces byte-identical output regardless of input array order", () => {
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-01-01",
      dividendPerShareDecimal: "5.00",
    }),
    manual({
      id: "imp1",
      paymentDate: "2024-01-07",
      dividendPerShareDecimal: "5.00",
      importBatchId: "batch-1",
    }),
    manual({
      id: "imp2",
      paymentDate: "2024-01-19",
      dividendPerShareDecimal: "5.00",
      importBatchId: "batch-1",
    }),
  ];
  const receipts: DividendReceiptFact[] = [
    receipt({
      id: "r1",
      dividendEventId: "no-such-event",
      paymentDate: "2024-01-13",
      dividendPerShareDecimal: "5.00",
    }),
  ];
  const events: ProviderDividendEventFact[] = [
    event({
      id: "interim",
      exDate: "2024-05-01",
      grossPerShareDecimal: "0.20",
    }),
    event({
      id: "special",
      exDate: "2024-05-10",
      grossPerShareDecimal: "0.30",
    }),
  ];
  const multiEventManualRecords: DividendManualRecordFact[] = [
    manual({
      id: "em1",
      paymentDate: "2024-05-04",
      dividendPerShareDecimal: "5.00",
    }),
    manual({
      id: "em2",
      paymentDate: "2024-05-13",
      dividendPerShareDecimal: "6.00",
    }),
    manual({
      id: "eimp1",
      paymentDate: "2024-05-07",
      dividendPerShareDecimal: "9.00",
      importBatchId: "batch-2",
    }),
  ];

  function normalize(
    rows: ReturnType<typeof deriveDividendHistoryForSecurity>,
  ): string {
    return JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)));
  }

  const baseline = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts,
    manualRecords: [...manualRecords, ...multiEventManualRecords],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });

  const permuted = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [...events].reverse(),
    overrides: [],
    receipts: [...receipts].reverse(),
    manualRecords: [...multiEventManualRecords, ...manualRecords].reverse(),
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: "2024-06-01",
  });

  assert.equal(
    baseline.length,
    3,
    "sanity: one eventless row + two event rows",
  );
  assert.equal(normalize(permuted), normalize(baseline));
});

test("chaining never fires across an event fully suppressed by a winning NON-excluded override -- the override's row never shows chained evidence (an unmatched imported row still surfaces on its own, unrelated to the override, exactly as it did before DIV-005)", () => {
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2024-03-13",
      paymentDate: "2024-03-20",
      grossPerShareDecimal: "0.50",
    }),
  ];
  const overrides: EventOverrideFact[] = [
    {
      dividendEventId: "e1",
      sharesDecimal: null,
      dividendPerShareDecimal: "9.99",
      frankingCreditPerShareDecimal: null,
      exclude: false,
    },
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-03-27",
      dividendPerShareDecimal: "12.00",
    }),
    manual({
      id: "imp1",
      paymentDate: "2024-03-31",
      dividendPerShareDecimal: "12.00",
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
  // The override wins e1's row outright -- m1 (within the event's own
  // window) is consumed and stays hidden, exactly as pre-DIV-005. imp1 never
  // matched e1 directly (11 days away) and -- since the override suppresses
  // e1 as a chain anchor -- has nothing to chain to either, so it surfaces
  // as its own unrelated standalone row (unchanged from pre-DIV-005
  // behaviour: it would have done so before this fix too, since m1 was
  // never in the standalone pool for it to match against).
  assert.equal(rows.length, 2);
  const editedRow = rows.find((row) => row.source === "edited");
  const otherRow = rows.find((row) => row.source !== "edited");
  assert.ok(editedRow);
  assert.equal(editedRow!.dividendPerShareDecimal, "9.99");
  assert.equal(
    editedRow!.dominatedImported,
    null,
    "the override row must never show chained evidence",
  );
  assert.ok(otherRow);
  assert.equal(otherRow!.source, "imported");
  assert.equal(otherRow!.id, "imported:imp1");
});

// ---------------------------------------------------------------------------
// Review round 1 BLOCKING fixes.
// ---------------------------------------------------------------------------

test("B1 (review round 1, non-excluded): an event with a DIRECT imported match AND a second imported row reachable only via the manual bridge -- the second import must NOT be silently swallowed by the already-taken dominatedImported slot (HEAD shape: 2 rows/$250)", () => {
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2024-04-01",
      paymentDate: "2024-04-10",
      grossPerShareDecimal: "0.50",
    }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-04-13", // 3 days from e1 -- attaches directly
      dividendPerShareDecimal: "12.00",
    }),
    manual({
      id: "i1",
      paymentDate: "2024-04-12", // 2 days from e1 -- DIRECT imported match, becomes e1's dominatedImported
      dividendPerShareDecimal: "5.00",
      importBatchId: "batch-1",
    }),
    manual({
      // 8 days from e1 (outside e1's own window -- no direct match) but 5
      // days from m1 (inside the manual's window) -- reachable ONLY via
      // chaining. Round A must not consume this: e1 already has a direct
      // imported match (i1) and its dominatedImported slot is taken.
      id: "i2",
      paymentDate: "2024-04-18",
      dividendPerShareDecimal: "13.00",
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
  assert.equal(rows.length, 2, "i2 must resurface as its own row, not vanish");
  const e1Row = rows.find((row) => row.dividendEventId === "e1");
  const i2Row = rows.find((row) => row.dividendEventId === null);
  assert.ok(e1Row);
  assert.equal(e1Row!.source, "manual");
  assert.equal(e1Row!.cashDecimal, "120");
  assert.ok(
    e1Row!.dominatedImported,
    "e1's DIRECT imported match (i1) must remain shown",
  );
  assert.equal(e1Row!.dominatedImported!.paymentDate, "2024-04-12");
  assert.ok(i2Row, "i2 must resurface as its own standalone row");
  assert.equal(i2Row!.source, "imported");
  assert.equal(i2Row!.cashDecimal, "130");
  const total = rows.reduce(
    (sum, row) => sum + Number(row.cashDecimal ?? "0"),
    0,
  );
  assert.equal(total, 250);
});

test("B1 (review round 1, excluded variant): the same shape under an excluded event resurfaces as 3 rows/$250 (excluded marker + resurfaced manual row + i2's own row)", () => {
  const events: ProviderDividendEventFact[] = [
    event({
      id: "e1",
      exDate: "2024-04-01",
      paymentDate: "2024-04-10",
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
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-04-13",
      dividendPerShareDecimal: "12.00",
    }),
    manual({
      id: "i1",
      paymentDate: "2024-04-12",
      dividendPerShareDecimal: "5.00",
      importBatchId: "batch-1",
    }),
    manual({
      id: "i2",
      paymentDate: "2024-04-18",
      dividendPerShareDecimal: "13.00",
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
  assert.equal(rows.length, 3);
  const excludedRow = rows.find((row) => row.source === "edited");
  const resurfacedRow = rows.find(
    (row) => row.source === "manual" && row.dividendEventId === "e1",
  );
  const i2Row = rows.find((row) => row.dividendEventId === null);
  assert.ok(excludedRow);
  assert.equal(excludedRow!.excluded, true);
  assert.ok(resurfacedRow);
  assert.equal(resurfacedRow!.cashDecimal, "120");
  assert.ok(resurfacedRow!.dominatedImported);
  assert.equal(resurfacedRow!.dominatedImported!.paymentDate, "2024-04-12");
  assert.ok(i2Row);
  assert.equal(i2Row!.source, "imported");
  assert.equal(i2Row!.cashDecimal, "130");
  // The excluded marker row is deliberately left out of this sum -- it is
  // removed from every total by definition (its own $5 auto-derived amount
  // is display-only, never counted); 120 (resurfaced manual) + 130 (i2).
  const total = rows
    .filter((row) => !row.excluded)
    .reduce((sum, row) => sum + Number(row.cashDecimal ?? "0"), 0);
  assert.equal(total, 250);
});

test("B2 (review round 1): two independent standalone manual records bridged by ONE imported row must NOT collapse into one row -- each keeps its own row (HEAD shape: 2 rows/$110)", () => {
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-02-01",
      dividendPerShareDecimal: "5.00",
    }),
    manual({
      id: "m2",
      paymentDate: "2024-02-10",
      dividendPerShareDecimal: "6.00",
    }),
    manual({
      id: "bridge",
      paymentDate: "2024-02-05", // 4 days from m1, 5 days from m2 -- bridges both into one cluster
      dividendPerShareDecimal: "9.00",
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
  assert.equal(
    rows.length,
    2,
    "two independent owner assertions must never be silently merged into one",
  );
  const m1Row = rows.find((row) => row.id === "manual:m1");
  const m2Row = rows.find((row) => row.id === "manual:m2");
  assert.ok(m1Row, "m1 must keep its own row");
  assert.ok(m2Row, "m2 must keep its own row");
  assert.equal(m1Row!.cashDecimal, "50");
  assert.equal(m2Row!.cashDecimal, "60");
  // The bridging imported row attaches to its NEAREST owner fact (m1, 4
  // days vs m2's 5) rather than vanishing or double-counting.
  assert.ok(m1Row!.dominatedImported);
  assert.equal(m1Row!.dominatedImported!.paymentDate, "2024-02-05");
  assert.equal(m2Row!.dominatedImported, null);
  const total = rows.reduce(
    (sum, row) => sum + Number(row.cashDecimal ?? "0"),
    0,
  );
  assert.equal(total, 110);
});

test("B2 (review round 1): two independent orphan receipts bridged by ONE imported row must NOT collapse into one row -- each keeps its own row (2 rows/$110)", () => {
  const receipts: DividendReceiptFact[] = [
    receipt({
      id: "r1",
      dividendEventId: "missing-1",
      paymentDate: "2024-02-01",
      dividendPerShareDecimal: "5.00",
    }),
    receipt({
      id: "r2",
      dividendEventId: "missing-2",
      paymentDate: "2024-02-10",
      dividendPerShareDecimal: "6.00",
    }),
  ];
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "bridge",
      paymentDate: "2024-02-05",
      dividendPerShareDecimal: "9.00",
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
  assert.equal(
    rows.length,
    2,
    "two independent receipts must never be silently merged into one",
  );
  const r1Row = rows.find((row) => row.id === "receipt:r1");
  const r2Row = rows.find((row) => row.id === "receipt:r2");
  assert.ok(r1Row);
  assert.ok(r2Row);
  assert.equal(r1Row!.cashDecimal, "50");
  assert.equal(r2Row!.cashDecimal, "60");
  assert.ok(r1Row!.dominatedImported);
  assert.equal(r2Row!.dominatedImported, null);
  const total = rows.reduce(
    (sum, row) => sum + Number(row.cashDecimal ?? "0"),
    0,
  );
  assert.equal(total, 110);
});

test("B2 regression pin: a manual record and an orphan receipt with no shared imported bridge and outside each other's own window stay as two separate rows (unaffected by the partition fix)", () => {
  const manualRecords: DividendManualRecordFact[] = [
    manual({
      id: "m1",
      paymentDate: "2024-01-01",
      dividendPerShareDecimal: "5.00",
    }),
  ];
  const receipts: DividendReceiptFact[] = [
    receipt({
      id: "r1",
      dividendEventId: "missing-event",
      paymentDate: "2024-03-01", // far outside m1's window, no imported bridge either
      dividendPerShareDecimal: "6.00",
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
  assert.equal(rows.length, 2);
  const sources = rows.map((row) => row.source).sort();
  assert.deepEqual(sources, ["manual", "receipt"]);
});
