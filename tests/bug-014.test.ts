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
// BUG-014 correction round (B1, BLOCKING): the TOTALS-mode verbatim
// passthrough. `computeDividendCashTotal`'s totals-mode branch
// (`totalCashDecimal !== null`) returns that field UNPARSED -- unlike the
// per-share-mode branch above (which always calls `parseDecimal`), nothing
// in round-1's code ever validated it, so a malformed TOTALS-mode value
// (unlike a malformed per-share-mode value) sailed through as
// `malformed: false` and later threw the FIRST time it was actually
// compared (`cashTotalsWithinTolerance`'s `parseDecimalResult`). Fixed by
// `safeComputeDividendCashTotalDiagnosed`'s explicit validation of that
// verbatim value.
//
// CORRECTION ROUND 3 (reviewer F1): round 2 validated it against
// `parseDecimalResult`'s WIDER 96-scale "result" bound, on the reasoning
// that a transported total is a result rather than a fresh input. That was
// wrong about where the value ENDS UP: a staged totals-mode amount is
// PERSISTED verbatim in `dividend_manual_records.total_cash_decimal` and
// read back through `parseDecimal` (scale 24), so anything past 24 cannot
// survive a round trip. The bound here is now `parseDecimal`'s, matching
// both the read path and `db/repositories/dividends.ts`'s insert boundary --
// so `OVER_SCALE_DECIMAL` (25 digits) now warns in TOTALS mode too, not just
// `OVER_RESULT_SCALE_DECIMAL` (97). A per-share-mode COMPUTED product keeps
// the wider bound (two 24-scale operands legitimately multiply out to 48) --
// pinned by its own test at the end of this section.
// ---------------------------------------------------------------------------

// Past even `parseDecimalResult`'s WIDER "result" scale bound (96
// fractional digits, `DECIMAL_LIMITS.resultScale`) -- 97 fractional digits
// exceeds it, unlike `OVER_SCALE_DECIMAL` above (25 digits), which is
// over `parseDecimal`'s narrower 24-digit "input" bound but well within
// `parseDecimalResult`'s.
const OVER_RESULT_SCALE_DECIMAL = `0.${"1".repeat(97)}`;

// The band round 2 waved through as clean: past `parseDecimal`'s 24-digit
// "input" bound (so it can never be stored or read back) but well inside
// `parseDecimalResult`'s 96.
const OVER_INPUT_SCALE_TOTAL_DECIMAL = `0.${"1".repeat(30)}`;

test("a staged dividend row with a non-canonical TOTALS-mode totalCashDecimal ('2.50 ', trailing space) never throws, and surfaces a visible per-row warning instead of being reported as clean", () => {
  const row = dividendRow({
    rowId: "row-totals-noncanonical",
    shape: "totals",
  });
  const malformedRow: ImportReconciliationRow = {
    ...row,
    normalized: { ...row.normalized, totalCashDecimal: "2.50 " },
  };
  assert.doesNotThrow(() => {
    const preview = createImportReconciliationPreview({
      rows: [malformedRow],
      portfolios: PORTFOLIOS,
      securityCandidates: SECURITY_CANDIDATES,
      reconciliationCandidates: [candidate({ totalCashDecimal: "2.50" })],
    });
    const warning = preview.issues.find(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE",
    );
    assert.ok(
      warning,
      "a malformed TOTALS-mode value must be reclassified as malformed, not silently reported as clean (the B1 regression)",
    );
    assert.equal(warning!.rowId, "row-totals-noncanonical");
    assert.equal(
      preview.proposedReconciliations.length,
      0,
      "a row whose own total could not be validated must never be proposed as a match",
    );
  });
});

test("a staged dividend row with an over-96-scale TOTALS-mode totalCashDecimal never throws, and surfaces a visible per-row warning", () => {
  const row = dividendRow({ rowId: "row-totals-overscale", shape: "totals" });
  const malformedRow: ImportReconciliationRow = {
    ...row,
    normalized: {
      ...row.normalized,
      totalCashDecimal: OVER_RESULT_SCALE_DECIMAL,
    },
  };
  assert.doesNotThrow(() => {
    const preview = createImportReconciliationPreview({
      rows: [malformedRow],
      portfolios: PORTFOLIOS,
      securityCandidates: SECURITY_CANDIDATES,
      reconciliationCandidates: [],
    });
    const warning = preview.issues.find(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE",
    );
    assert.ok(warning);
    assert.equal(warning!.rowId, "row-totals-overscale");
  });
});

test("a reconciliation candidate with a non-canonical TOTALS-mode total_cash_decimal ('2.50 ', trailing space) never throws, and surfaces a visible batch-level warning instead of being reported as clean", () => {
  const row = dividendRow({ rowId: "row-1", shape: "totals" });
  assert.doesNotThrow(() => {
    const preview = createImportReconciliationPreview({
      rows: [row],
      portfolios: PORTFOLIOS,
      securityCandidates: SECURITY_CANDIDATES,
      reconciliationCandidates: [
        candidate({
          id: "manual-totals-noncanonical",
          totalCashDecimal: "2.50 ",
          sharesDecimal: null,
          dividendPerShareDecimal: null,
        }),
      ],
    });
    const warning = preview.issues.find(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE",
    );
    assert.ok(
      warning,
      "a malformed TOTALS-mode stored value must be reclassified as malformed, not silently reported as clean (the B1 regression)",
    );
    assert.equal(warning!.sourceKey, "manual-totals-noncanonical");
    assert.equal(
      preview.proposedReconciliations.length,
      0,
      "the incoming row must never be matched against a candidate whose total could not be validated",
    );
  });
});

test("a reconciliation candidate with an over-96-scale TOTALS-mode total_cash_decimal never throws, and surfaces the same warning", () => {
  const row = dividendRow({ rowId: "row-2", shape: "totals" });
  assert.doesNotThrow(() => {
    const preview = createImportReconciliationPreview({
      rows: [row],
      portfolios: PORTFOLIOS,
      securityCandidates: SECURITY_CANDIDATES,
      reconciliationCandidates: [
        candidate({
          id: "manual-totals-overscale",
          totalCashDecimal: OVER_RESULT_SCALE_DECIMAL,
          sharesDecimal: null,
          dividendPerShareDecimal: null,
        }),
      ],
    });
    const warning = preview.issues.find(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE",
    );
    assert.ok(warning);
    assert.equal(warning!.sourceKey, "manual-totals-overscale");
  });
});

test("the candidate amount-unavailable warning names the security symbol and payment date when the caller supplies one, so the owner can find the record without decoding sourceKey", () => {
  const row = dividendRow({ rowId: "row-1" });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    reconciliationCandidates: [
      candidate({
        id: "manual-labelled",
        paymentDate: "2026-08-05",
        totalCashDecimal: "2.50 ",
        sharesDecimal: null,
        dividendPerShareDecimal: null,
        securitySymbol: "ABC",
      }),
    ],
  });
  const warning = preview.issues.find(
    (issue) =>
      issue.code === "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE",
  );
  assert.ok(warning);
  assert.match(warning!.message, /ABC/);
  assert.match(warning!.message, /2026-08-05/);
});

// ---------------------------------------------------------------------------
// Correction round 3 (reviewer F1): the 25-to-96-fractional-digit band --
// past `parseDecimal`'s 24 "input" bound (so it can never be stored and read
// back) but inside `parseDecimalResult`'s 96, which is exactly the band round
// 2's totals-mode validation reported as CLEAN. It must warn at preview, the
// same as any other amount this system cannot carry.
// ---------------------------------------------------------------------------

test("correction round 3: a staged dividend row with a 30-fractional-digit TOTALS-mode totalCashDecimal (inside parseDecimalResult's 96 bound, past parseDecimal's 24) surfaces the per-row warning", () => {
  const row = dividendRow({ rowId: "row-totals-30", shape: "totals" });
  const preview = createImportReconciliationPreview({
    rows: [
      {
        ...row,
        normalized: {
          ...row.normalized,
          totalCashDecimal: OVER_INPUT_SCALE_TOTAL_DECIMAL,
        },
      },
    ],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    reconciliationCandidates: [],
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE",
  );
  assert.ok(
    warning,
    "a total this system cannot store or read back must not be reported as a clean, comparable amount",
  );
  assert.equal(warning!.rowId, "row-totals-30");
});

test("correction round 3: a reconciliation candidate with a 30-fractional-digit TOTALS-mode total_cash_decimal surfaces the batch-level warning", () => {
  const row = dividendRow({ rowId: "row-3", shape: "totals" });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    reconciliationCandidates: [
      candidate({
        id: "manual-totals-30",
        totalCashDecimal: OVER_INPUT_SCALE_TOTAL_DECIMAL,
        sharesDecimal: null,
        dividendPerShareDecimal: null,
      }),
    ],
  });
  const warning = preview.issues.find(
    (issue) =>
      issue.code === "DIVIDEND_RECONCILIATION_CANDIDATE_AMOUNT_UNAVAILABLE",
  );
  assert.ok(warning);
  assert.equal(warning!.sourceKey, "manual-totals-30");
});

test("correction round 3 (no over-tightening): a PER-SHARE-mode row whose two 24-scale operands multiply out to a 48-scale product is still clean -- the narrower bound applies to a STORED totals value, never to a computed product", () => {
  const row = dividendRow({ rowId: "row-pershare-48" });
  const preview = createImportReconciliationPreview({
    rows: [
      {
        ...row,
        normalized: {
          ...row.normalized,
          sharesOwned: `1.${"1".repeat(24)}`,
          costPerShare: `0.${"1".repeat(24)}`,
        },
      },
    ],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    reconciliationCandidates: [],
  });
  assert.equal(
    preview.issues.some(
      (issue) =>
        issue.code === "DIVIDEND_RECONCILIATION_ROW_AMOUNT_UNAVAILABLE",
    ),
    false,
    "both operands are within parseDecimal's own bound, so their exact product is a legitimate comparable amount",
  );
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
