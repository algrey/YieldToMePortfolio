/**
 * BUG-013 -- preview-time cross-route dividend duplicate warning
 * (`DIVIDEND_MATCHES_EXISTING_ENTRY`). This is BUG-011's defect
 * (`tests/bug-011.test.ts`), unfixed, on dividends. A dividend's
 * `source_reference` is a route-specific fingerprint (a Sharesight payout
 * identity key for one route, a sha256 over CSV fields for the other) that
 * can never collide across routes, so the exact-string dedupe in
 * `db/repositories/import-commit.ts` can never catch the same real
 * distribution imported once by CSV and once by Sharesight sync. This suite
 * covers the non-blocking, decision-surface warning added at
 * `domain/imports/reconciliation.ts` to surface that gap before commit,
 * without ever auto-skipping (mirrors BUG-011's binding production-evidence
 * constraint: a genuinely repeated real distribution must stay importable).
 *
 * ALSO confirmed as part of this task's investigation and covered here:
 * `existingDividendEntries` was previously loaded with `import_batch_id IS
 * NULL` (owner-typed records only), making EVERY import-sourced dividend
 * record invisible to this check (and to the pre-existing
 * `DIVIDEND_NEAR_EXISTING_ENTRY` proximity check) regardless of route -- see
 * `tests/imp-004a.test.ts`'s DB-level BUG-013 tests for that filter-fix
 * coverage (this file covers the pure reconciliation function and the cap
 * decision only, matching `tests/bug-011.test.ts`'s own split).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createImportReconciliationPreview } from "../domain/imports/reconciliation.ts";
import type {
  ImportPreviewExistingDividendEntry,
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
  capExistingDividendRows,
  MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
} from "../app/import-dividend-duplicate-check.ts";
import { MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK } from "../app/import-trade-duplicate-check.ts";
import { capSuppressionReferenceRows } from "../app/import-suppression-cap.ts";

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

// Builds an incoming dividend row. `shape: "per-share"` mirrors a CSV row
// (sharesOwned/costPerShare set, totalCashDecimal absent); `shape: "totals"`
// mirrors a Sharesight-sync-staged row (totalCashDecimal set,
// sharesOwned/costPerShare null) -- both routes stage through the SAME
// reconciliation preview, so this fixture proves the check is genuinely
// route-agnostic on the INCOMING side too, mirroring BUG-011's "order 1"/
// "order 2" pair.
function dividendRow(input: {
  rowId: string;
  shape?: "per-share" | "totals";
  paymentDate?: string;
  sharesOwned?: string;
  costPerShare?: string;
  frankingPerShare?: string | null;
  totalCashDecimal?: string;
  totalFrankingDecimal?: string | null;
  currency?: string;
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
    currency: input.currency ?? "AUD",
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
    frankingPerShare:
      shape === "per-share" ? (input.frankingPerShare ?? null) : null,
    totalCashDecimal:
      shape === "totals" ? (input.totalCashDecimal ?? "2.50") : null,
    totalFrankingDecimal:
      shape === "totals" ? (input.totalFrankingDecimal ?? null) : null,
  };
  return {
    id: input.rowId,
    physicalRowNumber: 2,
    rowClass: "transaction",
    normalized,
    fingerprint: `fp-${input.rowId}`,
  };
}

const EXISTING_PER_SHARE: ImportPreviewExistingDividendEntry = {
  portfolioSecurityId: "membership-1",
  paymentDate: "2026-08-05",
  cashTotalDecimal: "2.50",
  frankingTotalDecimal: null,
  currencyCode: null,
};

const EXISTING_TOTALS: ImportPreviewExistingDividendEntry = {
  portfolioSecurityId: "membership-1",
  paymentDate: "2026-08-05",
  cashTotalDecimal: "2.50",
  frankingTotalDecimal: null,
  currencyCode: null,
};

// ---------------------------------------------------------------------------
// Cross-route detection, both orders.
// ---------------------------------------------------------------------------

test("cross-route detection, order 1 (CSV already posted as a manual record, Sharesight-shaped totals row arrives second): raises DIVIDEND_MATCHES_EXISTING_ENTRY as a warning, never blocking readiness", () => {
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-1", shape: "totals" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [EXISTING_PER_SHARE],
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
  );
  assert.ok(warning, "expected a cross-route dividend match warning");
  assert.equal(warning!.severity, "warning");
  assert.equal(preview.ready, true, "a warning must never block readiness");
});

test("cross-route detection, order 2 (Sharesight totals already posted, CSV-shaped per-share row arrives second): the SAME warning fires regardless of which route committed first", () => {
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-2", shape: "per-share" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [EXISTING_TOTALS],
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
  );
  assert.ok(warning, "expected the warning regardless of route order");
  assert.equal(warning!.severity, "warning");
  assert.equal(preview.ready, true);
});

// ---------------------------------------------------------------------------
// Decimal-string normalization and tolerance.
// ---------------------------------------------------------------------------

test("decimal-string normalization: an existing cash total of '2.50' matches an incoming total of exactly '2.5' -- never compared as JS binary floats", () => {
  const preview = createImportReconciliationPreview({
    rows: [
      dividendRow({
        rowId: "row-3",
        shape: "totals",
        totalCashDecimal: "2.5",
      }),
    ],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [EXISTING_PER_SHARE], // cashTotalDecimal: "2.50"
  });
  assert.ok(
    preview.issues.some(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
  );
});

test("decimal-string normalization: a genuinely different cash total does not match -- a true negative, not a false positive", () => {
  const preview = createImportReconciliationPreview({
    rows: [
      dividendRow({
        rowId: "row-4",
        shape: "totals",
        totalCashDecimal: "9.99",
      }),
    ],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [EXISTING_PER_SHARE],
  });
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Advisory only -- a genuine repeat distribution stays importable.
// ---------------------------------------------------------------------------

test("a genuine same-date repeat distribution (two real payments sharing security/date/amount) still imports on confirmation -- the warning never becomes a block", () => {
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-5", shape: "totals" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [EXISTING_PER_SHARE],
  });
  assert.ok(
    preview.issues.some(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
  );
  assert.equal(
    preview.ready,
    true,
    "advisory only -- must never gate readiness, so the row still commits on confirmation",
  );
  assert.equal(preview.counts.dividendCreates, 1);
});

// ---------------------------------------------------------------------------
// Non-matches.
// ---------------------------------------------------------------------------

test("no matching existing entry: no warning fires", () => {
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-6" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [],
  });
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    undefined,
  );
});

test("a matching entry for a DIFFERENT security does not warn", () => {
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-7" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [
      { ...EXISTING_PER_SHARE, portfolioSecurityId: "some-other-membership" },
    ],
  });
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    undefined,
  );
});

test("a matching entry on a DIFFERENT payment date does not warn -- exact date match, not a proximity window (that is DIV-004's separate job)", () => {
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-8", paymentDate: "2026-08-06" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [EXISTING_PER_SHARE], // paymentDate: "2026-08-05"
  });
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    undefined,
  );
});

test("a trade row (not a dividend) never raises DIVIDEND_MATCHES_EXISTING_ENTRY even against a matching existingDividendEntries entry", () => {
  const tradeRow: ImportReconciliationRow = {
    id: "row-9",
    physicalRowNumber: 2,
    rowClass: "transaction",
    fingerprint: "fp-row-9",
    normalized: {
      ...dividendRow({ rowId: "row-9" }).normalized,
      type: "buy",
      sharesOwned: "5",
      costPerShare: "0.50",
    },
  };
  const preview = createImportReconciliationPreview({
    rows: [tradeRow],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [EXISTING_PER_SHARE],
  });
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// Review round, RULING 1 (the most material follow-up): a row already bound
// for a commit-time exact-`source_reference` SKIP needs no advisory warning
// at all -- it is guaranteed noise, since commit will discard the row
// regardless of what it economically matches. Measured on an owner-shaped
// fixture (18 securities x 7 quarterly payouts = 126 already-committed
// records, re-staged as a full re-sync): 0 warnings before this fix, 252
// after (DIVIDEND_NEAR_EXISTING_ENTRY + DIVIDEND_MATCHES_EXISTING_ENTRY, one
// of EACH on every row). Cross-route detection must be UNWEAKENED: a
// genuinely new row that matches an existing record by economics (a
// DIFFERENT computed fingerprint/source_reference -- the whole reason this
// task exists) still warns.
// ---------------------------------------------------------------------------

test("a row already bound for a commit-time exact source_reference skip raises NEITHER dividend advisory warning, even though it also matches an existing record economically", () => {
  const row = dividendRow({ rowId: "row-19", shape: "totals" });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [EXISTING_PER_SHARE],
    // This row's own commit-time source_reference (`portfolio-1::import-
    // fingerprint:${row.fingerprint}`, per `sourceReferenceKey` in
    // reconciliation.ts) is ALREADY present -- exactly what an already-
    // fully-committed full re-sync looks like.
    existingDividendSourceReferences: new Set([
      `portfolio-1::import-fingerprint:${row.fingerprint}`,
    ]),
  });
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    undefined,
    "the economic-identity check must be suppressed for a row commit will skip anyway",
  );
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
    ),
    undefined,
    "DIV-004's proximity check must ALSO be suppressed for the same row",
  );
  assert.equal(preview.ready, true);
});

test("a row whose fingerprint is NOT in existingDividendSourceReferences still raises both warnings -- suppression is scoped to THIS row's own identity, not a blanket disable", () => {
  const row = dividendRow({ rowId: "row-20", shape: "totals" });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [EXISTING_PER_SHARE],
    // A DIFFERENT fingerprint entirely -- the genuinely cross-route case
    // this task exists to detect must stay fully detected.
    existingDividendSourceReferences: new Set([
      "portfolio-1::import-fingerprint:some-other-row-fingerprint",
    ]),
  });
  assert.ok(
    preview.issues.some(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    "cross-route detection must be unweakened",
  );
  assert.ok(
    preview.issues.some(
      (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
    ),
  );
});

test("with no existingDividendSourceReferences supplied at all (the ready-service/commit-revalidation shape), both warnings behave exactly as before this ruling", () => {
  const row = dividendRow({ rowId: "row-21", shape: "totals" });
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [EXISTING_PER_SHARE],
  });
  assert.ok(
    preview.issues.some(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
  );
});

// PRF-009 CORRECTION ROUND B1 (BLOCKING, 2026-09-03): this test previously
// exercised `capSuppressionReferenceRows`'s fail-open overflow degrade
// (empty Set) against the dividend route, on the premise that
// `existingDividendSourceReferences` was a pure suppression set like its
// trade twin. That premise was wrong -- the dividend query is now
// deliberately UNBOUNDED (see the source-pin test below), so this scenario
// can no longer occur via `loadReview` for dividends; the equivalent
// no-set-supplied case is already covered by "with no
// existingDividendSourceReferences supplied at all" above. Replaced with the
// test the correction actually requires: `existingDividendSourceReferences`
// is a COMPARISON set (DIV-016C) that must correctly exclude a dedupe-bound
// row from the reconciliation matching pool (`freshRows`) regardless of how
// large the set is -- there is no size past which membership testing
// degrades, unlike a capped comparison set (`capExistingDividendRows`) or
// the trade suppression set's fail-open cap.
test("DIV-016C B1 (PRF-009 correction): a dedupe-bound dividend row with a matching manual candidate yields DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE (never PROPOSED), even when existingDividendSourceReferences is far larger than the old (removed) cap", () => {
  const row = dividendRow({ rowId: "row-22", shape: "totals" });
  const ownKey = `portfolio-1::import-fingerprint:${row.fingerprint}`;
  // One more than the old MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK
  // (5,000) boundary that used to trigger `capSuppressionReferenceRows`'s
  // fail-open overflow for this set -- proving the domain split has no
  // hidden size dependency now that the cap is gone.
  const largeSet = new Set<string>([ownKey]);
  for (let i = 0; i <= MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK; i++) {
    largeSet.add(`portfolio-1::import-fingerprint:filler-${i}`);
  }
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    reconciliationCandidates: [
      {
        id: "manual-1",
        portfolioSecurityId: "membership-1",
        paymentDate: "2026-08-05",
        totalCashDecimal: "2.50",
        sharesDecimal: null,
        dividendPerShareDecimal: null,
      },
    ],
    existingDividendSourceReferences: largeSet,
  });
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_RECONCILIATION_PROPOSED",
    ),
    undefined,
    "must NEVER promise a reconciliation for a row that will dedupe-skip, no matter the set size",
  );
  const duplicateWarning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE",
  );
  assert.ok(duplicateWarning, "expected the honest already-imported warning");
  assert.equal(preview.proposedReconciliations.length, 0);
  assert.equal(preview.ready, true);
});

// ---------------------------------------------------------------------------
// Franking/FX discrepancy: surfaced, never used to decide the match.
// ---------------------------------------------------------------------------

test("franking discrepancy: a match with disagreeing franking totals surfaces a note in the message, but still fires and stays advisory", () => {
  const preview = createImportReconciliationPreview({
    rows: [
      dividendRow({
        rowId: "row-10",
        shape: "totals",
        totalFrankingDecimal: "1.00",
      }),
    ],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [
      { ...EXISTING_PER_SHARE, frankingTotalDecimal: "0.10" },
    ],
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
  );
  assert.ok(warning, "a franking difference must not suppress the match");
  assert.match(warning!.message, /franking credits differ/);
  assert.equal(preview.ready, true);
});

test("franking presence mismatch: franking recorded on only one side surfaces a note, without claiming a numeric disagreement", () => {
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-11", shape: "totals" })], // no totalFrankingDecimal
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [
      { ...EXISTING_PER_SHARE, frankingTotalDecimal: "0.10" },
    ],
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
  );
  assert.ok(warning);
  assert.match(warning!.message, /recorded on only one of the two records/);
});

test("matching franking on both sides raises no franking note at all", () => {
  const preview = createImportReconciliationPreview({
    rows: [
      dividendRow({
        rowId: "row-12",
        shape: "totals",
        totalFrankingDecimal: "0.10",
      }),
    ],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [
      { ...EXISTING_PER_SHARE, frankingTotalDecimal: "0.10" },
    ],
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
  );
  assert.ok(warning);
  assert.doesNotMatch(warning!.message, /franking/);
});

test("currency/FX disclosure: an existing entry recorded with a foreign-currency conversion is disclosed by name, never used to decide the match", () => {
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-13", shape: "totals" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [{ ...EXISTING_PER_SHARE, currencyCode: "USD" }],
  });
  const warning = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
  );
  assert.ok(warning);
  assert.match(warning!.message, /foreign-currency conversion \(USD\)/);
});

// ---------------------------------------------------------------------------
// Safety: malformed/absent decimal fields never throw (F4-style guard).
// ---------------------------------------------------------------------------

test("an incoming per-share row missing frankingPerShare entirely (as a 17-column-header row staged before that column existed would deserialize) still matches on cash total alone, never throws", () => {
  const row = dividendRow({ rowId: "row-14", shape: "per-share" });
  const legacyNormalized = { ...row.normalized } as Record<string, unknown>;
  // Simulate a `normalized_fields_json` blob persisted before this column
  // existed in the schema -- genuinely `undefined` at runtime, not `null`,
  // despite `NormalizedImportRow.frankingPerShare` being declared
  // `string | null` (non-optional). `totalCashDecimal`/`sharesOwned`/
  // `costPerShare` are base fields present since the original schema and
  // stay untouched here -- this isolates the guard around the FRANKING
  // computation specifically.
  //
  // BUG-014 UPDATE: at the time this test was written, DIV-016 part C's own
  // `dividendReconciliationRowsAll` cash-total computation further down this
  // same function was UNGUARDED BY DESIGN, and an identical `undefined`
  // `sharesOwned` there would have thrown out of the whole preview -- this
  // fixture deliberately avoided tripping it. That site (and its DB-sourced
  // sibling over `reconciliationCandidates`) is now guarded the same way;
  // real coverage for exactly that previously-unguarded throw shape (plus
  // the DB-sourced non-canonical/over-scale variants) lives in
  // `tests/bug-014.test.ts`.
  delete legacyNormalized.frankingPerShare;
  const legacyRow: ImportReconciliationRow = {
    ...row,
    normalized: legacyNormalized as unknown as NormalizedImportRow,
  };
  assert.doesNotThrow(() => {
    const preview = createImportReconciliationPreview({
      rows: [legacyRow],
      portfolios: PORTFOLIOS,
      securityCandidates: SECURITY_CANDIDATES,
      existingDividendEntries: [EXISTING_PER_SHARE],
    });
    const warning = preview.issues.find(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    );
    assert.ok(
      warning,
      "a missing franking field must not suppress the cash-total match",
    );
    assert.doesNotMatch(
      warning!.message,
      /franking/,
      "both sides resolve to 'franking unknown' -- no discrepancy to report",
    );
  });
});

test("an unparseable existing-entry cash total (e.g. a corrupt/non-canonical DB value) is treated as NOT matching, never throws", () => {
  // Review round (ruling 3) CORRECTION: the original fixture here was
  // "-2.50" with a comment claiming "leading '-' rejected" -- that was
  // FALSE. `domain/calculations/decimal.ts`'s `DECIMAL_PATTERN` is
  // `/^-?(0|[1-9]\d*)(?:\.(\d+))?$/` and accepts a leading '-' (only
  // negative zero is separately rejected); the test passed solely because
  // -2.50 vs 2.50 falls outside `cashTotalsWithinTolerance`'s 1% band, which
  // is a TRUE NEGATIVE via the tolerance check, not the `catch` branch --
  // `safeCashTotalsWithinTolerance`'s guard had zero coverage from this
  // test, before or after this fix (confirmed: it passes identically
  // against the pre-fix commit too). "1." genuinely fails the pattern (a
  // trailing '.' with no fraction digit) and reaches the `catch`.
  const malformedExisting: ImportPreviewExistingDividendEntry[] = [
    { ...EXISTING_PER_SHARE, cashTotalDecimal: "1." },
  ];
  assert.doesNotThrow(() => {
    const preview = createImportReconciliationPreview({
      rows: [dividendRow({ rowId: "row-15", shape: "totals" })],
      portfolios: PORTFOLIOS,
      securityCandidates: SECURITY_CANDIDATES,
      existingDividendEntries: malformedExisting,
    });
    assert.equal(
      preview.issues.find(
        (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
      ),
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// The "check unavailable" degrade path (mirrors BUG-011 F2).
// ---------------------------------------------------------------------------

test("existingDividendEntriesUnavailable raises a visible, info-severity DIVIDEND_DUPLICATE_CHECK_UNAVAILABLE disclosure -- the degrade is never silent", () => {
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-16" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntriesUnavailable: true,
  });
  const disclosure = preview.issues.find(
    (issue) => issue.code === "DIVIDEND_DUPLICATE_CHECK_UNAVAILABLE",
  );
  assert.ok(disclosure, "expected a visible disclosure of the degraded check");
  assert.equal(disclosure!.severity, "info");
  assert.equal(disclosure!.rowId, undefined, "batch-level, not row-linked");
  assert.equal(
    preview.ready,
    true,
    "the degraded-check disclosure must never block readiness",
  );
});

test("without existingDividendEntriesUnavailable, no disclosure fires (the normal, non-degraded case)", () => {
  const preview = createImportReconciliationPreview({
    rows: [dividendRow({ rowId: "row-17" })],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [EXISTING_PER_SHARE],
  });
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_DUPLICATE_CHECK_UNAVAILABLE",
    ),
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
  return {
    id: "row-1",
    physicalRowNumber: 2,
    rowClass: "transaction",
    normalizedFields: dividendRow({ rowId: "row-1", shape: "totals" })
      .normalized,
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

test("DIVIDEND_MATCHES_EXISTING_ENTRY is advisory display evidence excluded from previewVersion hashing, mirroring TRADE_NEAR_EXISTING_ENTRY's precedent", () => {
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
    existingDividendEntries: [EXISTING_PER_SHARE],
  });
  assert.ok(
    withExisting.preview.issues.some(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    "sanity check: the warning actually fired with existingDividendEntries supplied",
  );
  assert.equal(
    withoutExisting.previewVersion,
    withExisting.previewVersion,
    "a caller that never supplies existingDividendEntries (ready-service, security-verification-service, commit revalidation) must compute the IDENTICAL previewVersion as the page-preview path that does",
  );
});

test("DIVIDEND_DUPLICATE_CHECK_UNAVAILABLE is advisory display evidence excluded from previewVersion hashing, for the same reason", () => {
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
    existingDividendEntriesUnavailable: true,
  });
  assert.ok(
    withSignal.preview.issues.some(
      (issue) => issue.code === "DIVIDEND_DUPLICATE_CHECK_UNAVAILABLE",
    ),
    "sanity check: the disclosure actually fired",
  );
  assert.equal(withoutSignal.previewVersion, withSignal.previewVersion);
});

// ---------------------------------------------------------------------------
// `capExistingDividendRows` -- the real cap/degrade boundary. This is a
// direct alias of `capExistingTradeRows` (`tests/bug-011.test.ts` already
// tests that function's own boundary behaviour exhaustively) -- these tests
// exist to pin the ALIAS and the dividend-specific constant, not to
// re-prove the generic cap logic.
// ---------------------------------------------------------------------------

test("capExistingDividendRows: at or below the cap, every row passes through unmodified and unavailable is false", () => {
  const rows = [1, 2, 3];
  assert.deepEqual(capExistingDividendRows(rows, 3), {
    entries: rows,
    unavailable: false,
  });
});

test("capExistingDividendRows: exactly one row OVER the cap degrades to empty entries and unavailable true", () => {
  const rows = [1, 2, 3, 4];
  assert.deepEqual(capExistingDividendRows(rows, 3), {
    entries: [],
    unavailable: true,
  });
});

test("capExistingDividendRows: the real MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK boundary behaves the same way -- at the cap is fine, one row over degrades", () => {
  const atCap = new Array<number>(
    MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
  ).fill(0);
  assert.equal(
    capExistingDividendRows(
      atCap,
      MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
    ).unavailable,
    false,
  );
  const overCap = new Array<number>(
    MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK + 1,
  ).fill(0);
  assert.equal(
    capExistingDividendRows(
      overCap,
      MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
    ).unavailable,
    true,
  );
});

// ---------------------------------------------------------------------------
// Source pin: `app/import-actions.ts` cannot be imported directly by this
// test runner (`next/headers`, transitively via `getAuthenticatedSqlContext`),
// so its WIRING is pinned by source text instead of a live call, matching
// `tests/bug-011.test.ts`'s established remedy for the identical constraint.
// ---------------------------------------------------------------------------

test("source pin: loadReview's dividend_manual_records query is widened off import_batch_id IS NULL, carries the amount/franking/currency columns, and applies the MAX + 1 cap via the shared capExistingDividendRows", async () => {
  const source = await readFile(
    new URL("../app/import-actions.ts", import.meta.url),
    "utf8",
  );
  // The confirmed root-cause filter fix: the WIDENED query selects the
  // amount/franking/currency columns and is scoped ONLY by
  // superseded_by_record_id, with no import_batch_id restriction. The
  // LIMIT/bind pair is checked in the SAME regex as its own query's SQL
  // text (review round, ruling 4) -- the manual and receipt queries bind an
  // IDENTICAL-looking `[userId, MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK
  // + 1]` array, so a regex matching that bind alone (anywhere in the file)
  // would still pass if ONE of the two queries were mutated to a bare `MAX`
  // (the exact off-by-one BUG-011's F2 exists to prevent) as long as the
  // OTHER, untouched query's occurrence still satisfied it -- silently
  // catching nothing. Anchoring the bind to its OWN query's preceding SQL
  // makes each pin fail independently.
  assert.match(
    source,
    /SELECT portfolio_security_id, payment_date, shares_decimal,\s*\n\s*dividend_per_share_decimal, franking_credit_per_share_decimal,\s*\n\s*total_cash_decimal, total_franking_decimal, currency_code\s*\n\s*FROM dividend_manual_records\s*\n\s*WHERE user_id = \? AND superseded_by_record_id IS NULL\s*\n\s*LIMIT \?`,\s*\n\s*\[userId, MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK \+ 1\],/,
  );
  assert.match(
    source,
    /SELECT portfolio_security_id, payment_date FROM dividend_receipts\s*\n\s*WHERE user_id = \?\s*\n\s*LIMIT \?`,\s*\n\s*\[userId, MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK \+ 1\],/,
  );
  // The cap/degrade DECISION delegated to the shared, directly tested pure
  // function, using the SAME constant, for EACH query's own rows array.
  assert.match(
    source,
    /capExistingDividendRows\(\s*existingManualRows,\s*MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,\s*\)/,
  );
  assert.match(
    source,
    /capExistingDividendRows\(\s*existingReceiptRows,\s*MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,\s*\)/,
  );
});

test("source pin: DIV-016 part C's OWN reconciliation-candidates query is left unchanged (still import_batch_id IS NULL) -- this task must not disturb that distinct, correct business rule", async () => {
  const source = await readFile(
    new URL("../app/import-actions.ts", import.meta.url),
    "utf8",
  );
  // BUG-014 correction round (follow-up): this query now also LEFT JOINs
  // `portfolio_securities` for a display-only security symbol label (see
  // `ImportPreviewDividendReconciliationCandidate.securitySymbol`'s doc
  // comment) -- the regex is updated for the new column list/JOIN, but the
  // SAME `import_batch_id IS NULL` / `superseded_by_record_id IS NULL`
  // predicate this test exists to pin is still required, unchanged.
  assert.match(
    source,
    /SELECT dmr\.id AS id, dmr\.portfolio_security_id AS portfolio_security_id,\s*\n\s*dmr\.payment_date AS payment_date, dmr\.shares_decimal AS shares_decimal,\s*\n\s*dmr\.dividend_per_share_decimal AS dividend_per_share_decimal,\s*\n\s*dmr\.total_cash_decimal AS total_cash_decimal,\s*\n\s*COALESCE\(ps\.display_symbol, ps\.source_symbol\) AS security_symbol\s*\n\s*FROM dividend_manual_records dmr\s*\n\s*LEFT JOIN portfolio_securities ps ON ps\.id = dmr\.portfolio_security_id\s*\n\s*WHERE dmr\.user_id = \? AND dmr\.import_batch_id IS NULL\s*\n\s*AND dmr\.superseded_by_record_id IS NULL/,
  );
});

// ---------------------------------------------------------------------------
// PRF-009 follow-up ("fail-open cap"): the trade suppression-set query
// feeding `existingTradeSourceReferences` was recorded by BUG-013's review
// as a non-blocking follow-up -- it was deliberately left UNBOUNDED. Bounded
// now with a FAIL-OPEN cap: unlike this file's comparison-set caps above
// (`capExistingDividendRows`/`capExistingTradeRows`, which fail CLOSED
// because a truncated comparison set risks a silent false negative), a
// truncated pure SUPPRESSION set can only ever add noise, never hide a
// duplicate -- see `capSuppressionReferenceRows`'s own doc comment
// (`app/import-suppression-cap.ts`).
//
// PRF-009 CORRECTION ROUND B1 (BLOCKING, 2026-09-03): the dividend twin
// query (`existingSourceReferenceRows`, feeding
// `existingDividendSourceReferences`) was ALSO capped this way in the
// original PRF-009 pass, on the wrong premise that it too was a pure
// suppression set. It is not -- see the source-pin test below and
// `app/import-actions.ts`'s own corrected doc comment -- so the cap was
// REMOVED for the dividend query only; `capSuppressionReferenceRows` is now
// used for `existingTradeSourceReferences` alone.
// ---------------------------------------------------------------------------

test("capSuppressionReferenceRows: at or below the cap, every row passes through unmodified and overflowed is false", () => {
  const rows = [1, 2, 3];
  assert.deepEqual(capSuppressionReferenceRows(rows, 3), {
    rows,
    overflowed: false,
  });
  assert.deepEqual(capSuppressionReferenceRows(rows, 5), {
    rows,
    overflowed: false,
  });
  assert.deepEqual(capSuppressionReferenceRows([], 0), {
    rows: [],
    overflowed: false,
  });
});

test("capSuppressionReferenceRows: exactly one row OVER the cap degrades to an EMPTY set (fail-open), not a truncated one -- the exact length > max boundary", () => {
  const rows = [1, 2, 3, 4];
  assert.deepEqual(capSuppressionReferenceRows(rows, 3), {
    rows: [],
    overflowed: true,
  });
});

test("capSuppressionReferenceRows: the real dividend and trade MAX boundaries (5,000) behave the same way -- at the cap is fine, one row over degrades to empty", () => {
  for (const max of [
    MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
    MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,
  ]) {
    const atCap = new Array<number>(max).fill(0);
    assert.equal(capSuppressionReferenceRows(atCap, max).overflowed, false);
    const overCap = new Array<number>(max + 1).fill(0);
    const result = capSuppressionReferenceRows(overCap, max);
    assert.equal(result.overflowed, true);
    assert.deepEqual(result.rows, []);
  }
});

test("source pin: loadReview's trade suppression-set query is bounded with LIMIT MAX + 1 and delegates the fail-open cap/degrade decision to the shared capSuppressionReferenceRows, with a structured warn log on overflow naming the batch", async () => {
  const source = await readFile(
    new URL("../app/import-actions.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /SELECT portfolio_id, source_reference FROM transactions\s*\n\s*WHERE user_id = \? AND source_type = 'csv_import' AND source_reference IS NOT NULL\s*\n\s*LIMIT \?`,\s*\n\s*\[userId, MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK \+ 1\],/,
  );
  // The cap/degrade DECISION is delegated to the shared pure function for
  // the trade route only.
  assert.match(
    source,
    /capSuppressionReferenceRows\(\s*existingTradeSourceReferenceRows,\s*MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,\s*\)/,
  );
  // Overflow is never silent: a structured warn log names the batch.
  assert.match(source, /action: "import\.preview\.trade_suppression_overflow"/);
  assert.match(
    source,
    /level: "warn",\s*\n\s*event: "import\.preview",\s*\n\s*action: "import\.preview\.trade_suppression_overflow"/,
  );
});

// PRF-009 CORRECTION ROUND B1 (BLOCKING, 2026-09-03): source pin proving the
// dividend twin query is deliberately NOT capped -- no `LIMIT` clause, no
// `MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK` bind param, and never
// routed through `capSuppressionReferenceRows`. Mirrors this file's other
// "deliberately left unbounded" source pins (e.g. the pre-BUG-013 comment
// trail above) so a future change re-introducing the cap here is caught,
// not silently reintroducing the false-PROPOSED risk this correction fixed.
test("source pin: loadReview's dividend suppression-set (comparison-set) query has NO LIMIT and is never passed through capSuppressionReferenceRows", async () => {
  const source = await readFile(
    new URL("../app/import-actions.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /SELECT portfolio_id, source_reference FROM dividend_manual_records\s*\n\s*WHERE user_id = \? AND source_reference IS NOT NULL`,\s*\n\s*\[userId\],/,
    "the dividend query must be unbounded -- no LIMIT clause",
  );
  assert.doesNotMatch(
    source,
    /capSuppressionReferenceRows\(\s*existingSourceReferenceRows,/,
    "the dividend set must never be capped -- it is a comparison set (DIV-016C), not a pure suppression set",
  );
  assert.doesNotMatch(
    source,
    /action: "import\.preview\.dividend_suppression_overflow"/,
    "no overflow path exists for the uncapped dividend set",
  );
});
