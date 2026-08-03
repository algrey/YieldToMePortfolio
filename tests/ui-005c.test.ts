import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createImportBatchHistoryGet } from "../app/import-history-route.ts";
import { loadImportBatchHistoryWithContext } from "../app/import-history-service.ts";
import {
  createSqliteSqlClient,
  IMPORT_HISTORY_LIMITS,
} from "../db/repositories/index.ts";

async function historyDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const file of (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    database.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, total_rows, transaction_rows,
      commit_idempotency_key, commit_high_water_row, created_at, updated_at, version
    ) VALUES (
      'batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv', '1',
      'large.csv', 1000, 'hash-a', 'committing', 55, 55,
      'resume-key-a', 21, '2026-08-03T00:00:00Z', '2026-08-03T00:01:00Z', 4
    );
  `);
  const rowInsert = database.prepare(`
    INSERT INTO import_rows (
      id, user_id, batch_id, physical_row_number, row_class,
      original_fields_json, normalized_fields_json, validation_status,
      target_portfolio_id, commit_status, created_at, updated_at, version
    ) VALUES (?, 'user-a', 'batch-a', ?, 'transaction', '[]', NULL, 'valid',
      'portfolio-a', ?, '2026-08-03', '2026-08-03', 1)
  `);
  const issueInsert = database.prepare(`
    INSERT INTO import_issues (
      id, user_id, batch_id, row_id, physical_row_number, severity, code,
      message, created_at, updated_at, version
    ) VALUES (?, 'user-a', 'batch-a', ?, ?, 'info', 'HISTORY_NOTE',
      'Retained import evidence', '2026-08-03', '2026-08-03', 1)
  `);
  const mappingInsert = database.prepare(`
    INSERT INTO import_mapping_decisions (
      id, user_id, batch_id, kind, source_key, normalized_source_value,
      target_value, scope, confidence, source, created_at, updated_at, version
    ) VALUES (?, 'user-a', 'batch-a', 'currency', ?, ?, 'AUD', 'row',
      'user', 'user', '2026-08-03', '2026-08-03', 1)
  `);
  const auditInsert = database.prepare(`
    INSERT INTO audit_events (
      id, actor_user_id, target_owner_user_id, action, target_type, target_id,
      request_id, result, metadata_json, occurred_at
    ) VALUES (?, 'user-a', 'user-a', 'import.chunk', 'import_batch', 'batch-a',
      ?, 'success', '{}', ?)
  `);
  for (let index = 0; index < 55; index += 1) {
    const rowNumber = index + 2;
    rowInsert.run(
      `row-${String(index).padStart(2, "0")}`,
      rowNumber,
      index < 20 ? "committed" : "staged",
    );
    issueInsert.run(
      `issue-${String(index).padStart(2, "0")}`,
      `row-${String(index).padStart(2, "0")}`,
      rowNumber,
    );
    mappingInsert.run(
      `mapping-${String(index).padStart(2, "0")}`,
      `currency-${String(index).padStart(2, "0")}`,
      `currency-${String(index).padStart(2, "0")}`,
    );
    auditInsert.run(
      `audit-${String(index).padStart(2, "0")}`,
      `request-${index}`,
      `2026-08-03T00:${String(index).padStart(2, "0")}:00Z`,
    );
  }
  return database;
}

test("history detail is owner-scoped, bounded, and exposes durable resume progress", async () => {
  const database = await historyDatabase();
  const client = createSqliteSqlClient(database);
  const first = await loadImportBatchHistoryWithContext(
    { client, userId: "user-a" },
    "batch-a",
  );
  assert.ok(first);
  assert.equal(first.rows.length, IMPORT_HISTORY_LIMITS.detailPageSize);
  assert.equal(first.issues.length, IMPORT_HISTORY_LIMITS.detailPageSize);
  assert.equal(first.mappings.length, IMPORT_HISTORY_LIMITS.detailPageSize);
  assert.equal(first.audit.length, IMPORT_HISTORY_LIMITS.detailPageSize);
  assert.equal(first.pagination.hasMore, true);
  assert.equal(first.pagination.nextOffset, 50);
  assert.deepEqual(first.progress, {
    highWaterRow: 21,
    idempotencyKey: "resume-key-a",
    committedRows: 20,
    skippedRows: 0,
    remainingRows: 35,
  });

  const second = await loadImportBatchHistoryWithContext(
    { client, userId: "user-a" },
    "batch-a",
    50,
  );
  assert.ok(second);
  assert.equal(second.rows.length, 5);
  assert.equal(second.issues.length, 5);
  assert.equal(second.mappings.length, 5);
  assert.equal(second.audit.length, 5);
  assert.equal(second.pagination.hasMore, false);
  assert.equal(second.pagination.nextOffset, null);

  assert.equal(
    await loadImportBatchHistoryWithContext(
      { client, userId: "user-b" },
      "batch-a",
    ),
    null,
  );
});

test("history endpoint preserves owner failures, no-store responses, and page bounds", async () => {
  const database = await historyDatabase();
  const client = createSqliteSqlClient(database);
  const route = createImportBatchHistoryGet(async (batchId, offset) => {
    const detail = await loadImportBatchHistoryWithContext(
      { client, userId: "user-a" },
      batchId,
      offset,
    );
    return detail
      ? { ok: true as const, detail }
      : { ok: false as const, status: 404 as const, message: "Not found." };
  });
  const response = await route(
    new Request("https://example.test/api/import/history/batch-a?offset=50"),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const payload = (await response.json()) as {
    ok: true;
    detail: { rows: unknown[]; pagination: { hasMore: boolean } };
  };
  assert.equal(payload.detail.rows.length, 5);
  assert.equal(payload.detail.pagination.hasMore, false);

  const hidden = await route(
    new Request("https://example.test/api/import/history/not-owned"),
    { params: Promise.resolve({ batchId: "not-owned" }) },
  );
  assert.equal(hidden.status, 404);

  const invalid = await route(
    new Request(
      `https://example.test/api/import/history/batch-a?offset=${IMPORT_HISTORY_LIMITS.maxDetailOffset + 1}`,
    ),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(invalid.status, 400);

  const unavailable = createImportBatchHistoryGet(async () => ({
    ok: false as const,
    status: 503 as const,
    message: "Temporarily unavailable.",
  }));
  const failed = await unavailable(
    new Request("https://example.test/api/import/history/batch-a"),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), {
    ok: false,
    status: 503,
    message: "Temporarily unavailable.",
  });
});

test("reloaded commit progress renders as resumable with mobile-operable controls", async () => {
  const componentUrl = new URL(
    "../app/components/import-history-detail.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ImportHistoryDetailPanel } from ${JSON.stringify(componentUrl)};
    const detail = {
      batch: { id: "batch-a", filename: "large.csv", status: "committing", version: 4,
        targetPortfolioId: "portfolio-a", totalRows: 55, transactionRows: 55,
        errorCount: 0, warningCount: 0, createdAt: "2026-08-03T00:00:00Z",
        updatedAt: "2026-08-03T00:01:00Z", parsedAt: "2026-08-03T00:00:30Z",
        committedAt: null, reversedAt: null, supersedesBatchId: null },
      rows: [], issues: [], mappings: [], audit: [],
      progress: { highWaterRow: 21, idempotencyKey: "resume-key-a", committedRows: 20,
        skippedRows: 0, remainingRows: 35 },
      pagination: { offset: 0, limit: 50, hasMore: true, nextOffset: 50,
        rowsHaveMore: true, issuesHaveMore: false, mappingsHaveMore: false, auditHaveMore: false },
    };
    process.stdout.write(renderToStaticMarkup(createElement(ImportHistoryDetailPanel,
      { detail, pending: false, onLoadMore() {}, onResume() {} })));
  `;
  const html = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  assert.match(html, /role="status"/);
  assert.match(html, /resumable after physical row 21/);
  assert.match(html, /35 remain/);
  assert.match(html, />Resume this commit</);
  assert.match(html, />Load more evidence</);
  assert.match(html, /<dt>Reversed<\/dt>/);

  const [review, styles] = await Promise.all([
    readFile(
      new URL("../app/components/import-review.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(
    review,
    /idempotencyKey: historyDetail\.progress\.idempotencyKey/,
  );
  assert.match(review, /loadHistoryDetail\([\s\S]*pagination\.nextOffset/);
  assert.match(
    styles,
    /\.history-commit-progress button,[\s\S]*min-height: 44px/,
  );
  assert.match(styles, /\.history-commit-progress button,[\s\S]*width: 100%/);
  assert.match(styles, /\.import-history-table-wrap[\s\S]*overflow-x: auto/);
});
