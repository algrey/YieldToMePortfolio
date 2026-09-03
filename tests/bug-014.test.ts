/**
 * BUG-014 -- two unguarded `computeDividendCashTotal` calls in
 * `domain/imports/reconciliation.ts` (DIV-016 part C's reconciliation
 * disclosure) could 500 the entire `/import` review page:
 *
 *  - the STAGED-row site (`dividendReconciliationRowsAll`): a row whose
 *    `normalized_fields_json` genuinely lacks `sharesOwned` deserializes to
 *    `undefined`, which is `!== null` and so sails past the `=== null`
 *    guards, throwing `Invalid decimal string.` straight out of the pure
 *    preview function.
 *  - the DB-SOURCED candidate site (`reconciliationCandidates`, from
 *    `dividend_manual_records`): exposed to a corrupt/non-canonical stored
 *    decimal, or one whose scale exceeds `parseDecimal`'s 24-digit bound
 *    even though `db/repositories/dividends.ts`'s `isDecimalString` does
 *    not enforce that bound at write time.
 *
 * Both are fixed the same way BUG-013 fixed its own unguarded call
 * (`safeComputeDividendCashTotal`/`safeCashTotalsWithinTolerance`, reused
 * here via `safeComputeDividendCashTotalDiagnosed`): an unparseable value is
 * "cannot compare", never fabricated as zero, the affected row/candidate
 * still renders, and a new visible warning surfaces WHY (distinct from the
 * pre-existing, silent, EXPECTED `null` when a row simply never carried
 * enough data at all).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createImportReconciliationPreview } from "../domain/imports/reconciliation.ts";
import type {
  ImportPreviewDividendReconciliationCandidate,
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

// Mirrors tests/bug-013.test.ts's own `dividendRow` fixture (same shape,
// same resolution against PORTFOLIOS/SECURITY_CANDIDATES above) -- kept
// local rather than imported since it is not exported from that file.
function dividendRow(input: {
  rowId: string;
  shape?: "per-share" | "totals";
  paymentDate?: string;
  sharesOwned?: string;
  costPerShare?: string;
}): ImportReconciliationRow {
  const paymentDate = input.paymentDate ?? "2026-08-05";
  const shape = input.shape ?? "per-share";
  const normalized: NormalizedImportRow = {
    id: input.rowId,
    symbol: "ABC",
    name: null,
    displaySymbol: null,
    exchange: null,
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: shape === "per-share" ? (input.sharesOwned ?? "5") : null,
    costPerShare: shape === "per-share" ? (input.costPerShare ?? "0.50") : null,
    commission: null,
    transactionDate: paymentDate,
    transactionTime: null,
    purchaseExchangeRate: null,
    type: "dividend",
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: `${paymentDate}T00:00:00Z`,
    localTradeDate: paymentDate,
    cashEvent: null,
    frankingPerShare: null,
    totalCashDecimal: shape === "totals" ? "2.50" : null,
    totalFrankingDecimal: null,
  };
  return {
    id: input.rowId,
    physicalRowNumber: 2,
    rowClass: "transaction",
    normalized,
    fingerprint: `fp-${input.rowId}`,
  };
}

function candidate(
  overrides: Partial<ImportPreviewDividendReconciliationCandidate> = {},
): ImportPreviewDividendReconciliationCandidate {
  return {
    id: "manual-1",
    portfolioSecurityId: "membership-1",
    paymentDate: "2026-08-05",
    totalCashDecimal: null,
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
    ...overrides,
  };
}

// An over-scale decimal: `domain/calculations/decimal.ts`'s
// `DECIMAL_LIMITS.inputScale` is 24, so 25 fractional digits exceeds
// `parseDecimal`'s bound even though it is a syntactically well-formed
// decimal string -- exactly the "isDecimalString does not bound scale, but
// parseDecimal does" gap this task's DB-sourced site is exposed to.
const OVER_SCALE_DECIMAL = `0.${"1".repeat(25)}`;

// ---------------------------------------------------------------------------
// Site 1: the staged-row site (dividendReconciliationRowsAll).
// ---------------------------------------------------------------------------

test("a staged dividend row with undefined sharesOwned (legacy normalized_fields_json missing the field) never throws, and surfaces a visible per-row warning instead of vanishing silently", () => {
  const row = dividendRow({ rowId: "row-undefined-shares" });
  const legacyNormalized = { ...row.normalized } as Record<string, unknown>;
  // Genuinely `undefined` at runtime (not `null`), mirroring how a
  // `normalized_fields_json` blob predating this field would deserialize --
  // despite `NormalizedImportRow.sharesOwned` being declared `string | null`
  // (non-optional).
  delete legacyNormalized.sharesOwned;
  const legacyRow: ImportReconciliationRow = {
    ...row,
    normalized: legacyNormalized as unknown as NormalizedImportRow,
  };
  assert.doesNotThrow(() => {
    const preview = createImportReconciliationPreview({
      rows: [legacyRow],
      portfolios: PORTFOLIOS,
      securityCandidates: SECURITY_CANDIDATES,
      reconciliationCandidates: [candidate()],
    });
    const warning = preview.issues.find(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE",
    );
    assert.ok(warning, "expected a visible warning, not a silent drop");
    assert.equal(warning!.severity, "warning");
    assert.equal(warning!.rowId, "row-undefined-shares");
    assert.equal(
      preview.proposedReconciliations.length,
      0,
      "a row with no comparable total must never be proposed as a match",
    );
    assert.equal(
      preview.ready,
      true,
      "an unparseable amount is advisory, never blocking",
    );
    assert.doesNotMatch(
      warning!.message,
      /\$?0(\.0+)?\b/,
      "must never describe the unavailable amount as zero",
    );
  });
});

test("a staged dividend row with genuinely absent (strictly null) shares/cost fields raises NO warning -- the pre-existing, silent, expected case is unchanged", () => {
  const row = dividendRow({ rowId: "row-genuinely-empty", shape: "per-share" });
  const normalized: NormalizedImportRow = {
    ...row.normalized,
    sharesOwned: null,
    costPerShare: null,
  };
  const preview = createImportReconciliationPreview({
    rows: [{ ...row, normalized }],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    reconciliationCandidates: [candidate()],
  });
  assert.equal(
    preview.issues.find(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE",
    ),
    undefined,
    "genuinely missing data is not malformed data -- must stay silent exactly as before this fix",
  );
});

test("well-formed staged rows are byte-identical: a malformed row raises its own warning without disturbing a sibling well-formed row's normal DIV-016C matching", () => {
  const malformedRow = dividendRow({ rowId: "row-malformed" });
  const legacyNormalized = { ...malformedRow.normalized } as Record<
    string,
    unknown
  >;
  delete legacyNormalized.sharesOwned;
  const malformed: ImportReconciliationRow = {
    ...malformedRow,
    normalized: legacyNormalized as unknown as NormalizedImportRow,
  };
  const wellFormedRow = dividendRow({
    rowId: "row-well-formed",
    sharesOwned: "10",
    costPerShare: "0.5",
  });
  const preview = createImportReconciliationPreview({
    rows: [malformed, wellFormedRow],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    reconciliationCandidates: [candidate({ totalCashDecimal: "5.00" })],
  });
  assert.ok(
    preview.issues.some(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE" &&
        issue.rowId === "row-malformed",
    ),
  );
  const proposed = preview.proposedReconciliations.find(
    (match) => match.rowId === "row-well-formed",
  );
  assert.ok(
    proposed,
    "the well-formed sibling row must still reconcile normally -- DIV-016C behaviour for well-formed rows is unchanged",
  );
  assert.equal(proposed!.manualRecordId, "manual-1");
});

// ---------------------------------------------------------------------------
// Site 2: the DB-sourced reconciliationCandidates site.
// ---------------------------------------------------------------------------

test("a reconciliation candidate with a non-canonical stored decimal ('0.50 ', trailing space) never throws, and surfaces a visible batch-level warning", () => {
  const row = dividendRow({ rowId: "row-1" });
  assert.doesNotThrow(() => {
    const preview = createImportReconciliationPreview({
      rows: [row],
      portfolios: PORTFOLIOS,
      securityCandidates: SECURITY_CANDIDATES,
      reconciliationCandidates: [
        candidate({
          id: "manual-noncanonical",
          totalCashDecimal: null,
          sharesDecimal: "10",
          dividendPerShareDecimal: "0.50 ",
        }),
      ],
    });
    const warning = preview.issues.find(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE",
    );
    assert.ok(warning, "expected a visible warning, not a silent drop");
    assert.equal(warning!.severity, "warning");
    assert.equal(warning!.rowId, undefined, "batch-level, not row-linked");
    assert.equal(warning!.sourceKey, "manual-noncanonical");
    assert.equal(
      preview.proposedReconciliations.length,
      0,
      "the incoming row must never be matched against a candidate whose total could not be read",
    );
    assert.doesNotMatch(warning!.message, /\$?0(\.0+)?\b/);
  });
});

test("a reconciliation candidate with an over-scale stored decimal (25 fractional digits, past parseDecimal's 24-digit bound) never throws, and surfaces the same warning", () => {
  const row = dividendRow({ rowId: "row-2" });
  assert.doesNotThrow(() => {
    const preview = createImportReconciliationPreview({
      rows: [row],
      portfolios: PORTFOLIOS,
      securityCandidates: SECURITY_CANDIDATES,
      reconciliationCandidates: [
        candidate({
          id: "manual-overscale",
          totalCashDecimal: null,
          sharesDecimal: "10",
          dividendPerShareDecimal: OVER_SCALE_DECIMAL,
        }),
      ],
    });
    const warning = preview.issues.find(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE",
    );
    assert.ok(warning);
    assert.equal(warning!.sourceKey, "manual-overscale");
  });
});

test("a genuinely incomplete candidate (all three amount fields strictly null) raises NO warning -- unchanged silent 'no data' case", () => {
  const row = dividendRow({ rowId: "row-3" });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    reconciliationCandidates: [
      candidate({
        id: "manual-empty",
        totalCashDecimal: null,
        sharesDecimal: null,
        dividendPerShareDecimal: null,
      }),
    ],
  });
  assert.equal(
    preview.issues.find(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE",
    ),
    undefined,
  );
});

test("a malformed candidate does not poison a sibling well-formed candidate's normal matching for a different row", () => {
  // This row is itself well-formed; it merely shares a payment date with
  // the MALFORMED candidate below, to prove the malformed candidate does
  // not corrupt or block matching elsewhere in the same batch.
  const rowNearMalformedCandidate = dividendRow({ rowId: "row-a" });
  const wellFormedRow = dividendRow({
    rowId: "row-b",
    paymentDate: "2026-09-01",
    sharesOwned: "10",
    costPerShare: "0.5",
  });
  const preview = createImportReconciliationPreview({
    rows: [rowNearMalformedCandidate, wellFormedRow],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    reconciliationCandidates: [
      candidate({
        id: "manual-bad",
        paymentDate: "2026-08-05",
        totalCashDecimal: null,
        sharesDecimal: "10",
        dividendPerShareDecimal: "0.50 ",
      }),
      candidate({
        id: "manual-good",
        paymentDate: "2026-09-01",
        totalCashDecimal: "5.00",
      }),
    ],
  });
  assert.ok(
    preview.issues.some(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE",
    ),
  );
  const proposed = preview.proposedReconciliations.find(
    (match) => match.rowId === "row-b",
  );
  assert.ok(
    proposed,
    "the well-formed row/candidate pair must still reconcile despite the sibling candidate's corrupt data",
  );
  assert.equal(proposed!.manualRecordId, "manual-good");
});

// ---------------------------------------------------------------------------
// Both sites together: the review page still renders end to end.
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

function reviewRow(
  row: ImportReconciliationRow,
  overrides: Partial<ImportReviewRow> = {},
): ImportReviewRow {
  return {
    id: row.id,
    physicalRowNumber: row.physicalRowNumber,
    rowClass: row.rowClass,
    normalizedFields: row.normalized,
    normalizedFingerprint: row.fingerprint,
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

test("BUG-014: the review page (buildImportReview) still renders with both a malformed staged row AND a malformed DB candidate present at once -- no 500, every other row unaffected", () => {
  const malformedRow = dividendRow({ rowId: "row-malformed" });
  const legacyNormalized = { ...malformedRow.normalized } as Record<
    string,
    unknown
  >;
  delete legacyNormalized.sharesOwned;
  const malformed: ImportReconciliationRow = {
    ...malformedRow,
    normalized: legacyNormalized as unknown as NormalizedImportRow,
  };
  const wellFormedRow = dividendRow({
    rowId: "row-well-formed",
    paymentDate: "2026-09-10",
    sharesOwned: "10",
    costPerShare: "0.5",
  });

  assert.doesNotThrow(() => {
    const built = buildImportReview({
      batch: BATCH,
      rows: [reviewRow(malformed), reviewRow(wellFormedRow)],
      issues: [],
      mappings: [],
      portfolios: PORTFOLIOS,
      securityCandidates: SECURITY_CANDIDATES,
      reconciliationCandidates: [
        candidate({
          id: "manual-noncanonical",
          paymentDate: "2026-08-05",
          totalCashDecimal: null,
          sharesDecimal: "10",
          dividendPerShareDecimal: "0.50 ",
        }),
        candidate({
          id: "manual-good",
          paymentDate: "2026-09-10",
          totalCashDecimal: "5.00",
        }),
      ],
    });

    assert.ok(
      typeof built.previewVersion === "string" &&
        built.previewVersion.length > 0,
      "the review must still produce a renderable previewVersion",
    );
    assert.ok(
      built.preview.issues.some(
        (issue) =>
          issue.code === "DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE",
      ),
    );
    assert.ok(
      built.preview.issues.some(
        (issue) =>
          issue.code === "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE",
      ),
    );
    const wellFormedMatch = built.preview.proposedReconciliations.find(
      (match) => match.rowId === "row-well-formed",
    );
    assert.ok(
      wellFormedMatch,
      "the well-formed row is unaffected by the two malformed values elsewhere in the same batch",
    );
    assert.equal(built.preview.ready, true);
  });
});

// ---------------------------------------------------------------------------
// previewVersion hashing.
// ---------------------------------------------------------------------------

test("DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE is advisory display evidence excluded from previewVersion hashing, mirroring DIVIDEND_RECONCILIATION_PROPOSED's precedent (it depends on the page-only-supplied reconciliationCandidates)", () => {
  const row = dividendRow({ rowId: "row-1" });
  const withoutCandidates = buildImportReview({
    batch: BATCH,
    rows: [reviewRow(row)],
    issues: [],
    mappings: [],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
  });
  const withMalformedCandidate = buildImportReview({
    batch: BATCH,
    rows: [reviewRow(row)],
    issues: [],
    mappings: [],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    reconciliationCandidates: [candidate({ dividendPerShareDecimal: "0.50 " })],
  });
  assert.ok(
    withMalformedCandidate.preview.issues.some(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE",
    ),
    "sanity check: the warning actually fired with reconciliationCandidates supplied",
  );
  assert.equal(
    withoutCandidates.previewVersion,
    withMalformedCandidate.previewVersion,
    "a caller that never supplies reconciliationCandidates (ready-service, security-verification-service, commit revalidation) must compute the IDENTICAL previewVersion as the page-preview path that does",
  );
});

test("DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE is rows-derived, NOT a page-only signal -- it is included in previewVersion identically whether or not reconciliationCandidates is supplied", () => {
  const malformedRow = dividendRow({ rowId: "row-undefined-shares" });
  const legacyNormalized = { ...malformedRow.normalized } as Record<
    string,
    unknown
  >;
  delete legacyNormalized.sharesOwned;
  const malformed: ImportReconciliationRow = {
    ...malformedRow,
    normalized: legacyNormalized as unknown as NormalizedImportRow,
  };
  const withoutCandidates = buildImportReview({
    batch: BATCH,
    rows: [reviewRow(malformed)],
    issues: [],
    mappings: [],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
  });
  const withCandidates = buildImportReview({
    batch: BATCH,
    rows: [reviewRow(malformed)],
    issues: [],
    mappings: [],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    reconciliationCandidates: [candidate()],
  });
  for (const built of [withoutCandidates, withCandidates]) {
    assert.ok(
      built.preview.issues.some(
        (issue) =>
          issue.code === "DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE",
      ),
      "the row-level warning fires regardless of whether reconciliationCandidates is supplied",
    );
  }
  assert.equal(
    withoutCandidates.previewVersion,
    withCandidates.previewVersion,
    "supplying reconciliationCandidates must not change previewVersion when the row-level warning is the only difference in issues -- it is derived purely from evidence.rows",
  );
});
