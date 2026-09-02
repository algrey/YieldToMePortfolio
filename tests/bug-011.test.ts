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
