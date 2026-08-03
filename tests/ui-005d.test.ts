import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("import reversal UI keeps confirmation, impact, progress, and successor boundaries", async () => {
  const [detail, review, service, styles, uiSpec] = await Promise.all([
    readFile(
      new URL("../app/components/import-history-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/import-review.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/import-history-service.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../docs/UI_SPEC.md", import.meta.url), "utf8"),
  ]);
  assert.match(detail, /I confirm this exact batch reversal/);
  assert.match(detail, /dependent facts/);
  assert.match(detail, /Open corrected successor batch/);
  assert.match(detail, /source rows[\s\S]*normalized/);
  assert.match(detail, /dependentTradeAt\.slice\(0, 10\)/);
  assert.match(review, /crypto\.randomUUID\(\)/);
  assert.match(
    review,
    /\/api\/import\/commit\/\$\{historyDetail\.batch\.id\}\/reverse/,
  );
  assert.match(review, /idempotencyKey/);
  assert.match(review, /form\.set\("supersedesBatchId", supersededBatchId\)/);
  assert.match(review, /loadHistoryDetail\(result\.review\.batch\.id\)/);
  assert.match(
    review,
    /key=\{`\$\{historyDetail\.batch\.id\}:\$\{historyDetail\.batch\.version\}`\}/,
  );
  assert.match(service, /supersedes_batch_id/);
  assert.match(service, /successorBatchId/);
  assert.match(styles, /\.import-reversal-button[\s\S]*min-height: 44px/);
  assert.match(styles, /\.import-reversal-blocked/);
  assert.match(uiSpec, /Import reversal is an explicit confirmed operation/);
});

test("reversal detail renders blocked impacts and preserves source evidence", () => {
  const componentUrl = new URL(
    "../app/components/import-history-detail.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ImportHistoryDetailPanel } from ${JSON.stringify(componentUrl)};
    const detail = {
      batch: { id: "batch-a", filename: "source.csv", status: "committed", version: 4,
        targetPortfolioId: "portfolio-a", totalRows: 2, transactionRows: 2,
        errorCount: 0, warningCount: 0, createdAt: "2026-08-03T00:00:00Z",
        updatedAt: "2026-08-03T00:01:00Z", parsedAt: "2026-08-03T00:00:30Z",
        committedAt: "2026-08-03T00:02:00Z", reversedAt: null, supersedesBatchId: null },
      successorBatchId: "batch-corrected",
      rows: [{ id: "row-a", physicalRowNumber: 2, rowClass: "transaction", validationStatus: "valid", commitStatus: "committed", commitTransactionId: "tx-a", originalFields: ["raw"], normalizedFields: { type: "buy" }, errorCount: 0, warningCount: 0, infoCount: 0 }],
      issues: [], mappings: [], audit: [],
      progress: { highWaterRow: 2, idempotencyKey: null, committedRows: 2, skippedRows: 0, remainingRows: 0 },
      pagination: { offset: 0, limit: 50, hasMore: false, nextOffset: null, rowsHaveMore: false, issuesHaveMore: false, mappingsHaveMore: false, auditHaveMore: false }
    };
    const reversal = { ok: false, message: "blocked", impacts: [{ sourceTransactionId: "tx-a", dependentTransactionId: "tx-b", portfolioId: "portfolio-a", portfolioSecurityId: "membership-a", dependentTradeAt: "2026-08-04T10:00:00Z", dependentQuantityDecimal: "1" }] };
    process.stdout.write(renderToStaticMarkup(createElement(ImportHistoryDetailPanel, {
      detail, pending: false, onLoadMore() {}, onResume() {}, reversal,
      reversalPending: false, reversalRetryAvailable: false,
      successorPending: false, onReverse() {}, onOpenSuccessor() {},
      onStageSuccessor() {}
    })));
  `;
  const html = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  assert.match(html, /Reversal blocked by dependent facts/);
  assert.match(html, /business date 2026-08-04/);
  assert.match(html, /Exact dependent trade time/);
  assert.match(html, /Immutable source rows/);
  assert.match(html, /Open corrected successor batch/);
});

test("reversed import renders an operable corrected-successor upload", () => {
  const componentUrl = new URL(
    "../app/components/import-history-detail.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ImportHistoryDetailPanel } from ${JSON.stringify(componentUrl)};
    const detail = {
      batch: { id: "batch-a", filename: "source.csv", status: "reversed", version: 6,
        targetPortfolioId: "portfolio-a", totalRows: 1, transactionRows: 1,
        errorCount: 0, warningCount: 0, createdAt: "2026-08-03T00:00:00Z",
        updatedAt: "2026-08-04T00:01:00Z", parsedAt: "2026-08-03T00:00:30Z",
        committedAt: "2026-08-03T00:02:00Z", reversedAt: "2026-08-04T00:00:00Z",
        supersedesBatchId: null },
      successorBatchId: null,
      rows: [], issues: [], mappings: [], audit: [],
      progress: { highWaterRow: 2, idempotencyKey: null, committedRows: 1,
        skippedRows: 0, remainingRows: 0 },
      pagination: { offset: 0, limit: 50, hasMore: false, nextOffset: null,
        rowsHaveMore: false, issuesHaveMore: false, mappingsHaveMore: false,
        auditHaveMore: false }
    };
    process.stdout.write(renderToStaticMarkup(createElement(ImportHistoryDetailPanel, {
      detail, pending: false, onLoadMore() {}, onResume() {}, reversal: null,
      reversalPending: false, reversalRetryAvailable: false,
      successorPending: false, onReverse() {}, onOpenSuccessor() {},
      onStageSuccessor() {}
    })));
  `;
  const html = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  assert.match(html, /This committed import is reversed/);
  assert.match(html, /name="correctedFile"/);
  assert.match(html, /accept="\.csv,text\/csv"/);
  assert.match(html, />Stage corrected successor</);
});
