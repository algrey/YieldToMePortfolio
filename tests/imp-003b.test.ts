import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createOwnedImportCommitRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedLedgerRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
} from "../db/repositories/index.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION } from "../domain/imports/index.ts";

async function migratedDatabase(): Promise<DatabaseSync> {
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
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-03', '2026-08-03');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'AUD', 'held', '2026-08-03', '2026-08-03');
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION}', 'sample.csv', 100, 'file-a', 'ready',
      '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z', 1);
  `);
  return database;
}

function normalized(rowNumber: number) {
  return {
    id: `source-${rowNumber}`,
    symbol: "ABC",
    name: "Alpha",
    displaySymbol: null,
    exchange: "ASX",
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: "2",
    costPerShare: "10",
    commission: "0",
    transactionDate: "2026-08-01 GMT+1000",
    transactionTime: `10:00:${String(rowNumber).padStart(2, "0")}`,
    purchaseExchangeRate: null,
    type: "buy",
    accounting: "fifo",
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: `2026-08-01T00:00:${String(rowNumber).padStart(2, "0")}.000Z`,
    localTradeDate: "2026-08-01",
    cashEvent: null,
  };
}

function stageRows(database: DatabaseSync, count: number): void {
  const insert = database.prepare(
    `INSERT INTO import_rows (
       id, user_id, batch_id, physical_row_number, row_class,
       original_fields_json, normalized_fields_json, normalized_fingerprint,
       validation_status, target_portfolio_id, target_portfolio_security_id,
       commit_status, created_at, updated_at, version
     ) VALUES (?, 'user-a', 'batch-a', ?, 'transaction', '[]', ?, ?, 'valid',
       'portfolio-a', 'membership-a', 'staged', '2026-08-03', '2026-08-03', 1)`,
  );
  for (let index = 0; index < count; index += 1) {
    const rowNumber = index + 2;
    insert.run(
      `row-${index + 1}`,
      rowNumber,
      JSON.stringify(normalized(rowNumber)),
      `fingerprint-${index + 1}`,
    );
  }
}

async function commitBatch(
  database: DatabaseSync,
  count: number,
): Promise<{ database: DatabaseSync; version: number }> {
  stageRows(database, count);
  const client = createSqliteSqlClient(database);
  const repository = createOwnedImportCommitRepository(client);
  const validated = await repository.validate("user-a", "batch-a");
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("expected the import to validate");
  const input: ImportCommitInput = {
    expectedVersion: 1,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "commit-a",
    confirmation: true,
    requestId: "request-a",
  };
  let result = await repository.commit("user-a", "batch-a", input);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (result.ok && result.status === "committed") break;
    assert.equal(result.ok, true);
    result = await repository.commit("user-a", "batch-a", input);
  }
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected the import to commit");
  assert.equal(result.status, "committed");
  const batch = database
    .prepare("SELECT version FROM import_batches WHERE id = 'batch-a'")
    .get() as { version: number };
  return { database, version: batch.version };
}

function reversalInput(expectedVersion: number, key = "reverse-a") {
  return {
    expectedVersion,
    idempotencyKey: key,
    confirmation: true,
    requestId: "request-reversal",
  };
}

test("clean reversal is compensating, auditable, and idempotent", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 2);
  database
    .prepare(
      `INSERT INTO import_mapping_decisions (
         id, user_id, batch_id, kind, source_key, normalized_source_value,
         target_id, target_value, scope, confidence, source, created_at,
         updated_at, version
       ) VALUES ('mapping-a', 'user-a', 'batch-a', 'portfolio', 'Main', 'main',
         'portfolio-a', NULL, 'batch', 'user', 'user', '2026-08-03',
         '2026-08-03', 1)`,
    )
    .run();
  const client = createSqliteSqlClient(database);
  const result = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "reversed");
  assert.equal(result.reversedTransactions, 2);
  assert.equal(result.remainingTransactions, 0);
  assert.equal(result.rebuildJobIds.length, 2);
  assert.deepEqual(
    database
      .prepare(
        "SELECT status, count(*) AS count FROM transactions GROUP BY status ORDER BY status",
      )
      .all()
      .map((row) => ({ status: String(row.status), count: Number(row.count) })),
    [
      { status: "posted", count: 2 },
      { status: "reversed", count: 2 },
    ],
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT COALESCE(SUM(CAST(signed_amount_decimal AS REAL)), 0) AS total FROM cash_ledger_entries",
        )
        .get() as { total: number }
    ).total,
    0,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM import_rows WHERE commit_status = 'reversed'",
        )
        .get() as { count: number }
    ).count,
    2,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM import_mapping_decisions WHERE user_id = 'user-a' AND batch_id = 'batch-a'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'import.reverse' AND target_id = 'batch-a'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
  const repeated = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(999),
  );
  assert.equal(repeated.ok, true);
  if (repeated.ok) assert.equal(repeated.idempotent, true);
});

test("later dependent sales block reversal with exact impact evidence", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 1);
  const client = createSqliteSqlClient(database);
  const sale = await createOwnedLedgerRepository(client).post("user-a", {
    portfolioId: "portfolio-a",
    type: "sell",
    portfolioSecurityId: "membership-a",
    quantityDecimal: "1",
    unitPriceDecimal: "12",
    grossAmountDecimal: "12",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    sourceReference: "manual-sale-1",
    idempotencyKey: "manual-sale-1",
    tradeAt: "2026-08-04T00:00:00.000Z",
    localTradeDate: "2026-08-04",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: "request-sale",
  });
  assert.equal(sale.ok, true);
  if (!sale.ok) return;
  const result = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version),
  );
  assert.deepEqual(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "dependent_facts");
    assert.equal(result.impacts?.length, 1);
    assert.equal(
      result.impacts?.[0]?.dependentTransactionId,
      sale.transaction.id,
    );
    assert.equal(result.impacts?.[0]?.dependentQuantityDecimal, "1");
    assert.equal(
      result.impacts?.[0]?.dependentTradeAt,
      "2026-08-04T00:00:00.000Z",
    );
  }
  assert.equal(
    (
      database
        .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
        .get() as { status: string }
    ).status,
    "committed",
  );
});

test("reversal resumes after a bounded failure and corrected upload supersedes only reversed batches", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 3);
  const client = createSqliteSqlClient(database);
  const failed = await createOwnedImportReversalRepository(client, {
    failAtTransaction: 0,
  }).reverse("user-a", "batch-a", reversalInput(version, "reverse-b"));
  assert.deepEqual(failed, {
    ok: false,
    reason: "injected_failure",
    resumable: true,
  });
  assert.equal(
    (
      database
        .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
        .get() as { status: string }
    ).status,
    "reversing",
  );
  const first = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version, "reverse-b"),
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.status, "reversing");
  assert.equal(first.remainingTransactions, 1);
  const completed = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version, "reverse-b"),
  );
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  assert.equal(completed.status, "reversed");

  const corrected = await createOwnedImportStagingRepository(
    client,
  ).startUpload("user-a", {
    targetPortfolioId: "portfolio-a",
    supersedesBatchId: "batch-a",
    parserFormat: "strict-versioned-csv",
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "corrected.csv",
    byteSize: 120,
    fileSha256: "file-corrected",
  });
  assert.equal(corrected.ok, true);
  if (!corrected.ok) return;
  assert.equal(corrected.batch.supersedesBatchId, "batch-a");
  assert.equal(corrected.batch.targetPortfolioId, "portfolio-a");
  const crossUser = await createOwnedImportStagingRepository(
    client,
  ).startUpload("user-b", {
    supersedesBatchId: "batch-a",
    parserFormat: "strict-versioned-csv",
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "wrong-owner.csv",
    byteSize: 120,
    fileSha256: "file-wrong-owner",
  });
  assert.deepEqual(crossUser, { ok: false, reason: "not_found" });
});
