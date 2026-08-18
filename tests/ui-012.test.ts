/** UI-012 — Resume review from import history; legible history row summaries.
 *
 * Two owner-reported gaps in the import history area
 * (`app/components/import-history-detail.tsx`, `app/components/import-review.tsx`):
 *
 * 1. A batch in a pre-commit status (`parsed`/`needs_mapping`/`invalid`/
 *    `ready`) opened from history had no way back into the resolution
 *    cards/commit flow -- only a fresh upload or Sharesight sync reached
 *    them. `ImportHistoryDetailPanel`'s new "Open review" button (gated by
 *    the shared `isMutableExclusionStatus`, exported from
 *    `import-history-detail.tsx` and imported by `import-review.tsx` --
 *    review finding B2, one definition, no duplicate) and
 *    `import-review.tsx`'s `resumeReviewFromHistory` close that gap.
 * 2. The "Original rows" table hid every business fact behind a "View" JSON
 *    dropdown. `summarizeRow` derives Symbol/Type/Date/Quantity/
 *    Price-Amount/Currency straight from `row.normalizedFields`, falling
 *    back to "Not recorded" (never a fabricated zero) for anything absent.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

// ---------------------------------------------------------------------------
// Shared fixture: one row of each real staged shape this codebase produces
// (see `domain/sharesight-sync/transform.ts` and
// `domain/imports/strict-versioned-parser.ts`), plus a fully-blank row.
// ---------------------------------------------------------------------------

const csvTradeRow = {
  id: "row-trade",
  physicalRowNumber: 2,
  rowClass: "transaction",
  originalFields: ["", "ALPHA"],
  normalizedFields: {
    id: null,
    symbol: "ALPHA",
    name: null,
    displaySymbol: null,
    exchange: "XASX",
    portfolio: "Alice",
    currency: "AUD",
    sharesOwned: "10",
    costPerShare: "15.50",
    commission: "0",
    transactionDate: "2026-03-01",
    transactionTime: null,
    purchaseExchangeRate: null,
    type: "buy",
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: "2026-03-01T00:00:00.000Z",
    localTradeDate: "2026-03-01",
    cashEvent: null,
    frankingPerShare: null,
  },
  validationStatus: "valid",
  commitStatus: "staged",
  commitTransactionId: null,
  excludedByOwnerAt: null,
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
};

// Sharesight payout -> dividend row (BRK-005 totals-only shape): no
// sharesOwned/costPerShare, a totalCashDecimal instead.
const sharesightPayoutRow = {
  id: "row-payout",
  physicalRowNumber: 3,
  rowClass: "transaction",
  originalFields: ["42"],
  normalizedFields: {
    id: "42",
    symbol: "BETA",
    name: null,
    displaySymbol: null,
    exchange: "XNAS",
    portfolio: "Alice",
    currency: "USD",
    sharesOwned: null,
    costPerShare: null,
    commission: "0",
    transactionDate: null,
    transactionTime: null,
    purchaseExchangeRate: null,
    type: "dividend",
    accounting: null,
    accountingExecutionIds: null,
    notes: "Sharesight payout id 42 (confirmed there).",
    tradeAtUtc: "2026-03-05T00:00:00.000Z",
    localTradeDate: "2026-03-05",
    cashEvent: null,
    frankingPerShare: null,
    totalCashDecimal: "42.00",
    totalFrankingDecimal: "12.00",
  },
  validationStatus: "valid",
  commitStatus: "staged",
  commitTransactionId: null,
  excludedByOwnerAt: null,
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
};

// Legacy cash row (`domain/imports/strict-versioned-parser.ts`'s
// `normalizeRow`): the parser leaves `type` as "buy"/"sell" (the sign of
// the underlying cash movement) but encodes the REAL effect in `cashEvent`
// ("cash_deposit"/"cash_withdrawal"); `db/repositories/import-commit.ts`
// resolves the committed effect via `normalized.cashEvent ??
// normalized.type`. UI-012 review finding B1: the Type summary column must
// mirror that same precedence, or a cash deposit mislabels as "buy".
const cashDepositRow = {
  id: "row-cash",
  physicalRowNumber: 5,
  rowClass: "transaction",
  originalFields: ["", "AUD"],
  normalizedFields: {
    id: null,
    symbol: "AUD",
    name: null,
    displaySymbol: null,
    exchange: null,
    portfolio: "Alice",
    currency: "AUD",
    sharesOwned: "500",
    costPerShare: "1",
    commission: "0",
    transactionDate: "2026-03-02",
    transactionTime: null,
    purchaseExchangeRate: null,
    type: "buy",
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: "2026-03-02T00:00:00.000Z",
    localTradeDate: "2026-03-02",
    cashEvent: "cash_deposit",
    frankingPerShare: null,
  },
  validationStatus: "valid",
  commitStatus: "staged",
  commitTransactionId: null,
  excludedByOwnerAt: null,
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
};

const blankFieldsRow = {
  id: "row-blank",
  physicalRowNumber: 4,
  rowClass: "blank",
  originalFields: [],
  normalizedFields: null,
  validationStatus: "staged",
  commitStatus: "staged",
  commitTransactionId: null,
  excludedByOwnerAt: null,
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
};

function baseDetail(status: string, overrides: Record<string, unknown> = {}) {
  return {
    batch: {
      id: "batch-a",
      filename: "large.csv",
      status,
      version: 4,
      targetPortfolioId: "portfolio-a",
      totalRows: 3,
      transactionRows: 2,
      errorCount: 0,
      warningCount: 0,
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:01:00Z",
      parsedAt: "2026-08-03T00:00:30Z",
      committedAt: null,
      reversedAt: null,
      supersedesBatchId: null,
    },
    successorBatchId: null,
    rows: [csvTradeRow, sharesightPayoutRow, blankFieldsRow],
    issues: [],
    mappings: [],
    audit: [],
    progress: {
      highWaterRow: 0,
      idempotencyKey: null,
      committedRows: 0,
      skippedRows: 0,
      remainingRows: 0,
    },
    pagination: {
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
      rowsHaveMore: false,
      issuesHaveMore: false,
      mappingsHaveMore: false,
      auditHaveMore: false,
    },
    excludedRowCount: 0,
    ...overrides,
  };
}

function renderHistoryDetailPanel(detail: unknown): string {
  const componentUrl = new URL(
    "../app/components/import-history-detail.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ImportHistoryDetailPanel } from ${JSON.stringify(componentUrl)};
    const detail = ${JSON.stringify(detail)};
    process.stdout.write(renderToStaticMarkup(createElement(ImportHistoryDetailPanel, {
      detail,
      pending: false,
      onLoadMore() {},
      onResume() {},
      onResumeReview(_batchId) {},
      reversal: null,
      reversalPending: false,
      reversalRetryAvailable: false,
      successorPending: false,
      onReverse(_expectedVersion) {},
      onOpenSuccessor(_batchId) {},
      onStageSuccessor(_file) {},
    })));
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

// ---------------------------------------------------------------------------
// Part 1: resume-review affordance status gating.
// ---------------------------------------------------------------------------

for (const status of ["parsed", "needs_mapping", "invalid", "ready"]) {
  test(`UI-012: a "${status}" batch's history detail renders the "Open review" affordance`, () => {
    const html = renderHistoryDetailPanel(baseDetail(status));
    assert.match(html, />Open review</);
  });
}

// UI-013 review round B3c (BLOCKING correction): `committing` moved from
// the "no affordance" group to its own case below -- a batch stranded
// `committing` (the accept loop's own bounded cap reached, or a closed tab
// mid-loop) must stay reachable from import history so Accept Import can
// resume it, instead of the dead end `isMutableExclusionStatus` alone left.
// See `isResumableReviewStatus` in import-history-detail.tsx.
for (const status of [
  "uploaded",
  "committed",
  "reversing",
  "reversed",
  "failed",
]) {
  test(`UI-012: a "${status}" batch's history detail renders no "Open review" affordance`, () => {
    const html = renderHistoryDetailPanel(baseDetail(status));
    assert.doesNotMatch(html, />Open review</);
  });
}

test('UI-013 review round B3c: a "committing" batch\'s history detail DOES render the "Open review" affordance (widened from UI-012\'s original four statuses) so Accept Import can resume it', () => {
  const html = renderHistoryDetailPanel(baseDetail("committing"));
  assert.match(html, />Open review</);
});

test("UI-012: resumeReviewFromHistory in import-review.tsx arms the scroll ref before loading the batch's preview, and gates on isMutableExclusionStatus everywhere it is offered", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  const match = component.match(
    /function resumeReviewFromHistory\(batchId: string\) \{([\s\S]*?)\n {2}\}/,
  );
  assert.ok(match, "expected to find resumeReviewFromHistory in the source");
  assert.match(
    match![1]!,
    /pendingReviewScrollBatchIdRef\.current = batchId/,
    "must arm the scroll ref with the requested batch id",
  );
  assert.match(
    match![1]!,
    /loadReviewByBatchId\(batchId\)/,
    "must reuse the existing loadReviewByBatchId preview-loading path",
  );

  // The scroll-into-view effect only fires once the loaded review actually
  // matches the batch id that was requested (never any/every review load).
  assert.match(
    component,
    /pendingReviewScrollBatchIdRef\.current === review\.batch\.id/,
  );
  assert.match(component, /reviewSectionRef\.current\?\.scrollIntoView/);
  assert.match(
    component,
    /className="import-review-result"\s*\n\s*aria-labelledby="review-title"\s*\n\s*ref=\{reviewSectionRef\}/,
  );

  // Both the history-list-entry and detail-panel affordances call
  // resumeReviewFromHistory. UI-013 review round B3c widened the list
  // entry's gate from `isMutableExclusionStatus` to `isResumableReviewStatus`
  // (which also allows a `committing` batch -- see tests/ui-013.test.ts),
  // matching the detail panel's own `resumableReview` gate exactly.
  assert.match(
    component,
    /isResumableReviewStatus\(batch\.status\) \? \(\s*\n\s*<button[\s\S]*?resumeReviewFromHistory\(batch\.id\)/,
  );
  assert.match(
    component,
    /onResumeReview=\{\(batchId\) => resumeReviewFromHistory\(batchId\)\}/,
  );
});

test("UI-012: isMutableExclusionStatus (exported from import-history-detail.tsx, shared with import-review.tsx) accepts exactly the four pre-commit statuses", async () => {
  const component = await readFile(
    new URL("../app/components/import-history-detail.tsx", import.meta.url),
    "utf8",
  );
  const match = component.match(
    /export function isMutableExclusionStatus\(status: string\): boolean \{([\s\S]*?)\n\}/,
  );
  assert.ok(
    match,
    "expected to find an EXPORTED isMutableExclusionStatus in import-history-detail.tsx",
  );
  const isMutableExclusionStatus = new Function("status", match![1]!) as (
    status: string,
  ) => boolean;

  for (const status of ["parsed", "needs_mapping", "invalid", "ready"]) {
    assert.equal(isMutableExclusionStatus(status), true, status);
  }
  for (const status of [
    "uploaded",
    "committing",
    "committed",
    "reversing",
    "reversed",
    "failed",
  ]) {
    assert.equal(isMutableExclusionStatus(status), false, status);
  }
});

// ---------------------------------------------------------------------------
// Part 2: summary-column derivation.
// ---------------------------------------------------------------------------

test("UI-012: a CSV-shaped trade row's normalizedFields render as Symbol/Type/Date/Quantity/Price/Currency table cells", () => {
  const html = renderHistoryDetailPanel(
    baseDetail("parsed", { rows: [csvTradeRow] }),
  );
  for (const expected of [
    ">ALPHA<",
    ">buy<",
    ">2026-03-01<",
    ">10<",
    ">15.50<",
    ">AUD<",
  ]) {
    assert.match(
      html,
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("UI-012 review B1: a legacy cash row (type: 'buy', cashEvent: 'cash_deposit') renders its Type cell as 'cash_deposit', not the parser's raw buy/sell type", () => {
  const html = renderHistoryDetailPanel(
    baseDetail("parsed", { rows: [cashDepositRow] }),
  );
  assert.match(html, />cash_deposit</);
  // Must not fall back to the raw "buy" type anywhere in this row's cells.
  const rowHtml = html.slice(
    html.indexOf(">5<"),
    html.indexOf("</tr>", html.indexOf(">5<")),
  );
  assert.doesNotMatch(rowHtml, />buy</);
});

test("UI-012 review B1: summarizeRow's Type cell resolves cashEvent before type, mirroring import-commit.ts's normalized.cashEvent ?? normalized.type precedence", async () => {
  const component = await readFile(
    new URL("../app/components/import-history-detail.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /type: summaryCell\(firstRecordedValue\(fields\.cashEvent, fields\.type\)\)/,
  );
});

test("UI-012: a Sharesight-payout-shaped dividend row shows its totalCashDecimal as the amount and 'Not recorded' for the never-populated share count", () => {
  const html = renderHistoryDetailPanel(
    baseDetail("parsed", { rows: [sharesightPayoutRow] }),
  );
  assert.match(html, />BETA</);
  assert.match(html, />dividend</);
  assert.match(html, />2026-03-05</);
  assert.match(html, />42\.00</);
  assert.match(html, />USD</);
  // sharesOwned is null on every Sharesight payout row (BRK-005 totals-only
  // shape) -- must read "Not recorded", never a fabricated "0".
  const rowHtml = html.slice(
    html.indexOf(">BETA<"),
    html.indexOf(">BETA<") + 2000,
  );
  assert.match(rowHtml, />Not recorded</);
});

test("UI-012: a row with null normalizedFields (e.g. a blank source row) renders 'Not recorded' in every summary column, never 0 or blank", () => {
  const html = renderHistoryDetailPanel(
    baseDetail("parsed", { rows: [blankFieldsRow] }),
  );
  // The six summary columns (Symbol/Type/Date/Quantity/Price-Amount/
  // Currency) sit immediately after the "Transaction" (commitTransactionId)
  // column, which reads "None" for this uncommitted row -- assert exactly
  // six consecutive "Not recorded" cells follow it, before the "Original
  // fields"/"Normalized facts" dropdown columns begin.
  assert.match(html, /<td>None<\/td>\s*(?:<td>Not recorded<\/td>\s*){6}<td>/);
  assert.doesNotMatch(html, /<td>0<\/td>/);
});

test("UI-012: the summary table never renders a fabricated 0 for a genuinely missing quantity or amount", async () => {
  // Direct evaluation of the actual shipped summarizeRow function against a
  // Sharesight-payout-shaped input, mirroring the imp-008 pattern of
  // extracting and running the real function body rather than a re-implementation.
  const component = await readFile(
    new URL("../app/components/import-history-detail.tsx", import.meta.url),
    "utf8",
  );
  for (const helperName of [
    "asFieldRecord",
    "firstRecordedValue",
    "summaryCell",
    "summarizeRow",
  ]) {
    assert.match(
      component,
      new RegExp(`function ${helperName}\\(`),
      `expected ${helperName} to be defined in the source`,
    );
  }
  assert.match(
    component,
    /quantity: summaryCell\(firstRecordedValue\(fields\.sharesOwned\)\)/,
  );
  assert.match(
    component,
    /amount: summaryCell\(\s*\n\s*firstRecordedValue\(fields\.costPerShare, fields\.totalCashDecimal\),\s*\n\s*\)/,
  );
});

test("UI-012: the import-history table markup stays semantic (scoped column headers) with the new summary columns added", async () => {
  const component = await readFile(
    new URL("../app/components/import-history-detail.tsx", import.meta.url),
    "utf8",
  );
  for (const header of [
    "Symbol",
    "Type",
    "Date",
    "Quantity",
    "Price/Amount",
    "Currency",
  ]) {
    assert.match(
      component,
      new RegExp(`<th scope="col">${header.replace("/", "\\/")}</th>`),
    );
  }
});

// ---------------------------------------------------------------------------
// Review follow-ups: reduced-motion scroll, secondary/disabled button
// styling, and clearing the scroll-arm ref on a failed preview load.
// ---------------------------------------------------------------------------

test("UI-012 review follow-up: the resume-review scrollIntoView call omits an explicit 'behavior', so the global prefers-reduced-motion override (which forces CSS scroll-behavior: auto) still applies", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /reviewSectionRef\.current\?\.scrollIntoView\(\{ block: "start" \}\)/,
  );
  assert.doesNotMatch(
    component,
    /scrollIntoView\(\{\s*\n?\s*behavior:/,
    "an explicit `behavior` option overrides CSS scroll-behavior entirely, bypassing the reduced-motion override",
  );
});

test("UI-012 review follow-up: loadReviewByBatchId clears the armed scroll-request ref on a failed preview load", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  const match = component.match(
    /async function loadReviewByBatchId\(batchId: string\) \{([\s\S]*?)\n {2}\}/,
  );
  assert.ok(match, "expected to find loadReviewByBatchId in the source");
  const catchBlock = match![1]!.match(
    /\} catch \(error\) \{([\s\S]*?)\n {4}\}/,
  );
  assert.ok(catchBlock, "expected a catch block in loadReviewByBatchId");
  assert.match(
    catchBlock![1]!,
    /pendingReviewScrollBatchIdRef\.current = null/,
  );
});

test("UI-012 review follow-up: the history list entry's 'Open review' button has its own secondary/disabled styling, not the inherited primary batch-button block style", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const rule = styles.match(
    /\.import-history-list li \.history-open-review,\s*\n\.import-history-resume-review button \{([^}]*)\}/,
  );
  assert.ok(
    rule,
    "expected a .history-open-review rule scoped more specifically than .import-history-list button",
  );
  assert.match(rule![1]!, /width:\s*auto/);
  assert.match(rule![1]!, /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/);
  const disabledRule = styles.match(
    /\.import-history-list li \.history-open-review:disabled,\s*\n\.import-history-resume-review button:disabled \{([^}]*)\}/,
  );
  assert.ok(
    disabledRule,
    "expected an explicit :disabled rule for .history-open-review",
  );
  assert.match(disabledRule![1]!, /opacity:/);
});

test("UI-012 review follow-up: the detail-panel's own 'Open review' button (.import-history-resume-review) shares the list entry's secondary/disabled treatment instead of rendering bare UA button chrome", async () => {
  const [styles, component] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/import-history-detail.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(component, /<p className="import-history-resume-review">/);
  assert.match(
    styles,
    /\.import-history-resume-review button \{|\.import-history-resume-review button,/,
  );
  const rule = styles.match(
    /\.import-history-list li \.history-open-review,\s*\n\.import-history-resume-review button \{([^}]*)\}/,
  );
  assert.ok(
    rule,
    "expected the shared rule to include the detail-panel button",
  );
  assert.match(rule![1]!, /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/);
});

test("UI-012: .import-history-table-wrap still scrolls horizontally with the widened table", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(styles, /\.import-history-table-wrap[\s\S]*?overflow-x: auto/);
  const tableBlock = styles.match(/\.import-history-table\s*\{([^}]*)\}/);
  assert.ok(tableBlock, "expected an .import-history-table rule");
  assert.match(tableBlock![1]!, /min-width:\s*\d+px/);
});
