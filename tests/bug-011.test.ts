/**
 * BUG-011 -- preview-time cross-route trade duplicate warning
 * (`TRADE_NEAR_EXISTING_ENTRY`). Trade dedupe at commit is keyed on
 * `source_reference` only, and CSV import (`import-fingerprint:<sha256>`)
 * and Sharesight sync (`import-fingerprint:sharesight-trade:<id>`) mint
 * structurally disjoint keys for the identical real trade, so the exact-
 * string check can never catch a cross-route re-import. This suite covers
 * the non-blocking, decision-surface warning added at
 * `domain/imports/reconciliation.ts` to surface that gap before commit,
 * without ever auto-skipping (production evidence: two GENUINELY DIFFERENT
 * trades share this exact identity -- one parcel filled in two lots).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createImportReconciliationPreview } from "../domain/imports/reconciliation.ts";
import type {
  ImportPreviewExistingTradeEntry,
  ImportPreviewPortfolio,
  ImportPreviewSecurityCandidate,
  ImportReconciliationRow,
} from "../domain/imports/reconciliation.ts";
import type { NormalizedImportRow } from "../domain/imports/strict-versioned-parser.ts";
import { buildImportReview } from "../domain/imports/review.ts";
import type {
  ImportReviewBatch,
  ImportReviewRow,
} from "../domain/imports/review.ts";
import {
  capExistingTradeRows,
  MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,
} from "../app/import-trade-duplicate-check.ts";

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

function tradeRow(input: {
  rowId: string;
  type?: NormalizedImportRow["type"];
  localTradeDate?: string;
  sharesOwned?: string;
  costPerShare?: string;
}): ImportReconciliationRow {
  const localTradeDate = input.localTradeDate ?? "2025-06-26";
  const normalized: NormalizedImportRow = {
    id: input.rowId,
    symbol: "ABC",
    name: null,
    displaySymbol: null,
    exchange: null,
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: input.sharesOwned ?? "100",
    costPerShare: input.costPerShare ?? "10.00",
    commission: null,
    transactionDate: localTradeDate,
    transactionTime: null,
    purchaseExchangeRate: null,
    type: input.type ?? "buy",
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

const EXISTING_TRADE: ImportPreviewExistingTradeEntry = {
  portfolioSecurityId: "membership-1",
  type: "buy",
  tradeDate: "2025-06-26",
  quantityDecimal: "100",
  priceDecimal: "10.00",
};

test("cross-route detection, order 1 (CSV already posted, Sharesight arrives second): an incoming trade matching an existing posted transaction raises TRADE_NEAR_EXISTING_ENTRY as a warning, never blocking readiness", () => {
  const preview = createImportReconciliationPreview({
    rows: [tradeRow({ rowId: "row-1" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [EXISTING_TRADE],
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY",
  );
  assert.ok(warning, "expected a cross-route duplicate warning");
  assert.equal(warning!.severity, "warning");
  assert.equal(
    preview.ready,
    true,
    "a decision-surface warning must never block readiness -- a genuine repeat trade must remain importable on confirmation",
  );
  assert.equal(
    preview.counts.transactionCreates,
    1,
    "the row is still counted as a normal create, never silently skipped",
  );
});

test("cross-route detection, order 2 (Sharesight already posted, CSV arrives second): the SAME warning fires regardless of which route committed first, since the check is route-agnostic economic identity", () => {
  // Simulates the reverse sequence: the "existing" posted trade came from
  // Sharesight sync, and the newly staged row is a CSV-imported one for the
  // identical economic identity. The check has no notion of "route" at all
  // (by design -- source_reference format is out of scope), so this is
  // symmetric with the order-1 test above.
  const preview = createImportReconciliationPreview({
    rows: [tradeRow({ rowId: "row-2", type: "sell", sharesOwned: "50" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    // Enough prior holdings that this sell is not itself an OVERSELL --
    // this test is about the cross-route warning, not oversell handling.
    existingQuantities: { "membership-1": "50" },
    existingTradeEntries: [
      {
        portfolioSecurityId: "membership-1",
        type: "sell",
        tradeDate: "2025-06-26",
        quantityDecimal: "50",
        priceDecimal: "10.00",
      },
    ],
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY",
  );
  assert.ok(warning);
  assert.equal(preview.ready, true);
});

test("decimal-string normalization: quantity/price differing only in trailing zeros ('100' vs '100.00'/'100.000', '10.00' vs '10.0') still match -- never compared as JS binary floats", () => {
  const preview = createImportReconciliationPreview({
    rows: [
      tradeRow({
        rowId: "row-3",
        sharesOwned: "100.000",
        costPerShare: "10.0",
      }),
    ],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [EXISTING_TRADE], // "100" / "10.00"
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY",
  );
  assert.ok(warning, "decimal-equal quantity/price must still match");
});

test("decimal-string normalization: a genuinely different quantity or price does not match -- a true negative, not a false positive", () => {
  const differentQuantity = createImportReconciliationPreview({
    rows: [tradeRow({ rowId: "row-4", sharesOwned: "100.01" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [EXISTING_TRADE],
  });
  assert.equal(
    differentQuantity.issues.find(
      (issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY",
    ),
    undefined,
  );

  const differentPrice = createImportReconciliationPreview({
    rows: [tradeRow({ rowId: "row-5", costPerShare: "10.01" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [EXISTING_TRADE],
  });
  assert.equal(
    differentPrice.issues.find(
      (issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY",
    ),
    undefined,
  );
});

test("a genuine same-day repeat trade (two real lots, same security/date/quantity/price) still imports on confirmation -- the warning never becomes a block, matching the production evidence of two legitimate 2025-06-26 fills", () => {
  // Mirrors the production collision: 104900/104908, same security, date,
  // quantity, price, distinct Sharesight ids -- one parcel filled in two
  // lots. The row must still be importable; only a visible warning is
  // acceptable.
  const preview = createImportReconciliationPreview({
    rows: [tradeRow({ rowId: "second-lot" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [EXISTING_TRADE],
  });
  assert.equal(preview.ready, true);
  assert.equal(preview.counts.transactionCreates, 1);
  assert.ok(
    preview.issues.some((issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY"),
  );
});

test("no matching existing trade: no warning fires", () => {
  const preview = createImportReconciliationPreview({
    rows: [tradeRow({ rowId: "row-6" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [],
  });
  assert.equal(
    preview.issues.find((issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY"),
    undefined,
  );
});

test("a matching entry for a DIFFERENT security does not warn", () => {
  const preview = createImportReconciliationPreview({
    rows: [tradeRow({ rowId: "row-7" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [
      { ...EXISTING_TRADE, portfolioSecurityId: "some-other-membership" },
    ],
  });
  assert.equal(
    preview.issues.find((issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY"),
    undefined,
  );
});

test("a matching entry of the OPPOSITE type (buy vs sell) does not warn -- type is part of economic identity", () => {
  const preview = createImportReconciliationPreview({
    rows: [tradeRow({ rowId: "row-8", type: "buy" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [{ ...EXISTING_TRADE, type: "sell" }],
  });
  assert.equal(
    preview.issues.find((issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY"),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// BUG-013 review round, RULING 1 (the most material follow-up, applied
// RETROACTIVELY to this ALREADY-LIVE check): a row already bound for a
// commit-time exact-`source_reference` SKIP raises no warning at all -- it
// is guaranteed noise, since commit will discard the row regardless of what
// it economically matches. The 2026-09-01 production batch staged 226
// trades and committed 0 (a full re-sync of an already-fully-committed
// account); every one of those 226 would have warned under the pre-fix
// behaviour. Cross-route detection must be UNWEAKENED: a genuinely new row
// that matches an existing record by economics (a DIFFERENT computed
// fingerprint/source_reference -- the whole reason this check exists) still
// warns.
// ---------------------------------------------------------------------------

test("a trade row already bound for a commit-time exact source_reference skip raises no warning, even though it also matches an existing transaction economically", () => {
  const row = tradeRow({ rowId: "row-30" });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [EXISTING_TRADE],
    // This row's own commit-time source_reference (`portfolio-1::import-
    // fingerprint:${row.fingerprint}`, per `sourceReferenceKey` in
    // reconciliation.ts) is ALREADY present -- exactly what an already-
    // fully-committed full re-sync looks like.
    existingTradeSourceReferences: new Set([
      `portfolio-1::import-fingerprint:${row.fingerprint}`,
    ]),
  });
  assert.equal(
    preview.issues.find((issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY"),
    undefined,
    "the check must be suppressed for a row commit will skip anyway",
  );
  assert.equal(preview.ready, true);
});

test("a trade row whose fingerprint is NOT in existingTradeSourceReferences still raises the warning -- suppression is scoped to THIS row's own identity, not a blanket disable", () => {
  const row = tradeRow({ rowId: "row-31" });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [EXISTING_TRADE],
    // A DIFFERENT fingerprint entirely -- the genuinely cross-route case
    // this check exists to detect must stay fully detected.
    existingTradeSourceReferences: new Set([
      "portfolio-1::import-fingerprint:some-other-row-fingerprint",
    ]),
  });
  assert.ok(
    preview.issues.some((issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY"),
    "cross-route detection must be unweakened",
  );
});

test("with no existingTradeSourceReferences supplied at all (the ready-service/commit-revalidation shape), the warning behaves exactly as before this ruling", () => {
  const row = tradeRow({ rowId: "row-32" });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [EXISTING_TRADE],
  });
  assert.ok(
    preview.issues.some((issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY"),
  );
});

test("a dividend row never raises TRADE_NEAR_EXISTING_ENTRY even against a matching existingTradeEntries entry", () => {
  const preview = createImportReconciliationPreview({
    rows: [
      tradeRow({
        rowId: "row-9",
        type: "dividend",
        sharesOwned: "100",
        costPerShare: "10.00",
      }),
    ],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [EXISTING_TRADE],
  });
  assert.equal(
    preview.issues.find((issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY"),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// previewVersion hashing: advisory display evidence, must not change the hash.
// ---------------------------------------------------------------------------

const BATCH: ImportReviewBatch = {
  id: "batch-1",
  filename: "test.csv",
  status: "parsed",
  version: 1,
  parserFormat: "strict-versioned-csv",
  parserVersion: "v1",
  targetPortfolioId: "portfolio-1",
  errorCount: 0,
};

function reviewRow(overrides: Partial<ImportReviewRow> = {}): ImportReviewRow {
  const localTradeDate = "2025-06-26";
  const normalizedFields: NormalizedImportRow = {
    id: "1",
    symbol: "ABC",
    name: null,
    displaySymbol: null,
    exchange: null,
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: "100",
    costPerShare: "10.00",
    commission: null,
    transactionDate: localTradeDate,
    transactionTime: null,
    purchaseExchangeRate: null,
    type: "buy",
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: `${localTradeDate}T00:00:00Z`,
    localTradeDate,
    cashEvent: null,
    frankingPerShare: null,
  };
  return {
    id: "row-1",
    physicalRowNumber: 2,
    rowClass: "transaction",
    normalizedFields,
    normalizedFingerprint: "fp-row-1",
    validationStatus: "valid",
    targetPortfolioId: "portfolio-1",
    targetPortfolioSecurityId: null,
    commitStatus: "staged",
    errorCount: 0,
    version: 1,
    excludedByOwnerAt: null,
    ...overrides,
  };
}

test("TRADE_NEAR_EXISTING_ENTRY is advisory display evidence excluded from previewVersion hashing, mirroring DIVIDEND_NEAR_EXISTING_ENTRY's B1-fix precedent", () => {
  const withoutExisting = buildImportReview({
    batch: BATCH,
    rows: [reviewRow()],
    issues: [],
    mappings: [],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
  });
  const withExisting = buildImportReview({
    batch: BATCH,
    rows: [reviewRow()],
    issues: [],
    mappings: [],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [EXISTING_TRADE],
  });
  assert.ok(
    withExisting.preview.issues.some(
      (issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY",
    ),
    "sanity check: the warning actually fired with existingTradeEntries supplied",
  );
  assert.equal(
    withoutExisting.previewVersion,
    withExisting.previewVersion,
    "a caller that never supplies existingTradeEntries (ready-service, security-verification-service, commit revalidation) must compute the IDENTICAL previewVersion as the page-preview path that does, or every one of those paths would 409 an affected batch's ready/commit with no recovery path",
  );
});

// ---------------------------------------------------------------------------
// Review round F2: the "check unavailable" degrade path.
// ---------------------------------------------------------------------------

test("F2: existingTradeEntriesUnavailable raises a visible, info-severity TRADE_DUPLICATE_CHECK_UNAVAILABLE disclosure -- the degrade is never silent", () => {
  const preview = createImportReconciliationPreview({
    rows: [tradeRow({ rowId: "row-10" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntriesUnavailable: true,
  });
  const disclosure = preview.issues.find(
    (issue) => issue.code === "TRADE_DUPLICATE_CHECK_UNAVAILABLE",
  );
  assert.ok(disclosure, "expected a visible disclosure of the degraded check");
  assert.equal(disclosure!.severity, "info");
  assert.equal(
    preview.ready,
    true,
    "the degraded-check disclosure must never block readiness",
  );
});

test("F2: existingTradeEntriesUnavailable is a batch-level disclosure, not tied to any one row (no rowId)", () => {
  const preview = createImportReconciliationPreview({
    rows: [tradeRow({ rowId: "row-11" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntriesUnavailable: true,
  });
  const disclosure = preview.issues.find(
    (issue) => issue.code === "TRADE_DUPLICATE_CHECK_UNAVAILABLE",
  );
  assert.equal(disclosure!.rowId, undefined);
});

test("F2: without existingTradeEntriesUnavailable, no disclosure fires (the normal, non-degraded case)", () => {
  const preview = createImportReconciliationPreview({
    rows: [tradeRow({ rowId: "row-12" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntries: [EXISTING_TRADE],
  });
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "TRADE_DUPLICATE_CHECK_UNAVAILABLE",
    ),
    undefined,
  );
});

test("TRADE_DUPLICATE_CHECK_UNAVAILABLE is advisory display evidence excluded from previewVersion hashing, for the same reason as TRADE_NEAR_EXISTING_ENTRY", () => {
  const withoutSignal = buildImportReview({
    batch: BATCH,
    rows: [reviewRow()],
    issues: [],
    mappings: [],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
  });
  const withSignal = buildImportReview({
    batch: BATCH,
    rows: [reviewRow()],
    issues: [],
    mappings: [],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingTradeEntriesUnavailable: true,
  });
  assert.ok(
    withSignal.preview.issues.some(
      (issue) => issue.code === "TRADE_DUPLICATE_CHECK_UNAVAILABLE",
    ),
    "sanity check: the disclosure actually fired",
  );
  assert.equal(withoutSignal.previewVersion, withSignal.previewVersion);
});

// ---------------------------------------------------------------------------
// Review round F4: decimalEqual must never throw on an unparseable value.
// ---------------------------------------------------------------------------

test("F4: an unparseable existing-entry decimal (e.g. a corrupt/non-canonical DB value) is treated as NOT equal, never throws -- the preview must not 500", () => {
  const malformedExisting: ImportPreviewExistingTradeEntry[] = [
    { ...EXISTING_TRADE, quantityDecimal: "-100" }, // decimal() rejects a leading '-'
  ];
  assert.doesNotThrow(() => {
    const preview = createImportReconciliationPreview({
      rows: [tradeRow({ rowId: "row-13" })],
      portfolios: PORTFOLIOS,
      securityCandidates: SECURITY_CANDIDATES,
      existingTradeEntries: malformedExisting,
    });
    assert.equal(
      preview.issues.find(
        (issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY",
      ),
      undefined,
      "an unparseable comparison value must never be treated as a match",
    );
  });
});

// ---------------------------------------------------------------------------
// Review round F-a: `capExistingTradeRows` -- the real cap/degrade boundary,
// unit-tested directly since `app/import-actions.ts` itself (the sole
// caller, `loadReview`) cannot be imported by this repo's plain Node test
// runner (it statically imports `getAuthenticatedSqlContext`, which pulls
// in `next/headers` transitively). Its WIRING into `loadReview` is pinned
// below via a source-text assertion, matching this repo's established
// remedy for exactly this constraint (see `tests/imp-003b.test.ts`'s
// `readFile` + `assert.match` pattern).
// ---------------------------------------------------------------------------

test("capExistingTradeRows: at or below the cap, every row passes through unmodified and unavailable is false", () => {
  const rows = [1, 2, 3];
  assert.deepEqual(capExistingTradeRows(rows, 3), {
    entries: rows,
    unavailable: false,
  });
  assert.deepEqual(capExistingTradeRows(rows, 5), {
    entries: rows,
    unavailable: false,
  });
  assert.deepEqual(capExistingTradeRows([], 0), {
    entries: [],
    unavailable: false,
  });
});

test("capExistingTradeRows: exactly one row OVER the cap degrades to empty entries and unavailable true -- the exact length > max boundary, not off-by-one", () => {
  const rows = [1, 2, 3, 4];
  assert.deepEqual(capExistingTradeRows(rows, 3), {
    entries: [],
    unavailable: true,
  });
});

test("capExistingTradeRows: the real MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK boundary (5,000) behaves the same way -- at the cap is fine, one row over degrades", () => {
  const atCap = new Array<number>(
    MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,
  ).fill(0);
  assert.equal(
    capExistingTradeRows(atCap, MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK)
      .unavailable,
    false,
  );
  const overCap = new Array<number>(
    MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK + 1,
  ).fill(0);
  assert.equal(
    capExistingTradeRows(
      overCap,
      MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,
    ).unavailable,
    true,
  );
});

test("F-a source pin: loadReview's existing-trade query excludes a reversal's compensating mirror row and applies the MAX + 1 cap via the shared pure capExistingTradeRows -- app/import-actions.ts cannot be imported directly by this test runner (next/headers, transitively), so its WIRING is pinned by source text instead of a live call", async () => {
  const source = await readFile(
    new URL("../app/import-actions.ts", import.meta.url),
    "utf8",
  );
  // F1: the compensating reversal mirror row (status='posted', own
  // reverses_transaction_id set) must be excluded.
  //
  // PRF-009 fold-in (b): widened to also pin `WHERE user_id = ? AND
  // status = 'posted'` and the `type IN (...)` clause in the SAME match --
  // mutating the file to drop user scoping (or the posted-status/buy-sell
  // filter) was previously caught by nothing here; ownership was only
  // mirror-covered. `\+?` tolerates PRF-009 fold-in (a)'s unary-plus
  // no-index hint on `reverses_transaction_id` (restores the `user_id`
  // index seek -- see that fold-in's own comment in app/import-actions.ts)
  // without requiring it, so this pin does not silently stop matching if
  // the hint is ever removed.
  assert.match(
    source,
    /WHERE user_id = \? AND status = 'posted'\s*\n\s*AND type IN \('buy', 'sell'\) AND \+?reverses_transaction_id IS NULL/,
  );
  // F2: the query caps at MAX + 1 rows...
  assert.match(
    source,
    /\[userId, MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK \+ 1\]/,
  );
  // ...and the cap/degrade DECISION is delegated to the shared, directly
  // tested pure function above, using the SAME constant the query's LIMIT
  // uses -- not a re-implemented or drifted threshold.
  assert.match(
    source,
    /capExistingTradeRows\(\s*existingTradeRows,\s*MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,\s*\)/,
  );
});
