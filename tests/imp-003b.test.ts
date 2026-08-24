import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createImportReversalPost } from "../app/import-reversal-route.ts";
import { reverseImportWithContext } from "../app/import-reversal-service.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedLedgerRepository,
  createSqliteSqlClient,
  IMPORT_REVERSAL_LIMITS,
  type ImportCommitInput,
  type SqlClient,
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

test("equal-timestamp sales respect the stable ledger ordering", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 1);
  const client = createSqliteSqlClient(database);
  database
    .prepare(
      `INSERT INTO transactions (
         id, user_id, portfolio_id, portfolio_security_id, type, status,
         trade_at, local_trade_date, quantity_decimal, unit_price_decimal,
         currency_code, gross_amount_decimal, source_type, source_reference,
         created_by_user_id, calculation_version, created_at
       ) VALUES ('zz-sale-equal-time', 'user-a', 'portfolio-a', 'membership-a',
         'sell', 'posted', '2026-08-01T00:00:02.000Z', '2026-08-01',
         '1', '12', 'AUD', '12', 'manual', 'manual-sale-equal-time',
         'user-a', 1, '2026-08-01')`,
    )
    .run();
  const result = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "dependent_facts");
});

test("direct reversal denies another owner without changing the batch", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 1);
  const result = await createOwnedImportReversalRepository(
    createSqliteSqlClient(database),
  ).reverse("user-b", "batch-a", reversalInput(version, "wrong-owner"));
  assert.deepEqual(result, { ok: false, reason: "not_found" });
  assert.equal(
    (
      database
        .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
        .get() as { status: string }
    ).status,
    "committed",
  );
});

test("authenticated reversal action rejects malformed, unconfirmed, and stale requests", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 1);
  const context = {
    client: createSqliteSqlClient(database),
    userId: "user-a",
    requestId: "authenticated-request",
  };
  assert.deepEqual(await reverseImportWithContext(context, "batch-a", null), {
    ok: false,
    status: 400,
    message:
      "The batch version, confirmation, and idempotency key are required.",
  });
  assert.deepEqual(
    await reverseImportWithContext(context, "batch-a", {
      ...reversalInput(version),
      confirmation: false,
    }),
    {
      ok: false,
      status: 400,
      message: "Confirm the import reversal before continuing.",
      impacts: undefined,
    },
  );
  assert.deepEqual(
    await reverseImportWithContext(context, "batch-a", reversalInput(0)),
    {
      ok: false,
      status: 409,
      message: "This import changed. Reload it before reversing it.",
      impacts: undefined,
    },
  );
});

test("reversal route enforces CSRF before its authenticated action and returns private progress", async () => {
  let calls = 0;
  const rejectedPost = createImportReversalPost(async () => {
    calls += 1;
    throw new Error("cross-site request reached the action");
  });
  const rejected = await rejectedPost(
    new Request("https://yield.example/api/import/commit/batch-a/reverse", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(rejected.status, 403);
  assert.equal(calls, 0);

  const { database, version } = await commitBatch(await migratedDatabase(), 1);
  const authenticatedPost = createImportReversalPost((batchId, value) =>
    reverseImportWithContext(
      {
        client: createSqliteSqlClient(database),
        userId: "user-a",
        requestId: "route-request",
      },
      batchId,
      value,
    ),
  );
  const response = await authenticatedPost(
    new Request("https://yield.example/api/import/commit/batch-a/reverse", {
      method: "POST",
      headers: {
        origin: "https://yield.example",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify(reversalInput(version, "route-reversal")),
    }),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = (await response.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test("one reversal invocation stays within D1 query, statement, and parameter budgets", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 2);
  const base = createSqliteSqlClient(database);
  let queries = 0;
  let statements = 0;
  let largestAtomicUnit = 0;
  let largestParameterCount = 0;
  const client: SqlClient = {
    async all(sql, params) {
      queries += 1;
      largestParameterCount = Math.max(
        largestParameterCount,
        params?.length ?? 0,
      );
      return base.all(sql, params);
    },
    async get(sql, params) {
      queries += 1;
      largestParameterCount = Math.max(
        largestParameterCount,
        params?.length ?? 0,
      );
      return base.get(sql, params);
    },
    async run(sql, params) {
      queries += 1;
      statements += 1;
      largestParameterCount = Math.max(
        largestParameterCount,
        params?.length ?? 0,
      );
      return base.run(sql, params);
    },
    async batch(batchStatements) {
      queries += batchStatements.length;
      statements += batchStatements.length;
      largestAtomicUnit = Math.max(largestAtomicUnit, batchStatements.length);
      largestParameterCount = Math.max(
        largestParameterCount,
        ...batchStatements.map((statement) => statement.params?.length ?? 0),
      );
      return base.batch!(batchStatements);
    },
  };
  const result = await createOwnedImportReversalRepository(client, {
    chunkSize: IMPORT_REVERSAL_LIMITS.maxChunkSize,
  }).reverse("user-a", "batch-a", reversalInput(version, "budget-reversal"));
  assert.equal(result.ok, true);
  assert.ok(
    queries <= IMPORT_REVERSAL_LIMITS.maxQueriesPerInvocation,
    `${queries} D1 queries`,
  );
  assert.ok(
    statements <= IMPORT_REVERSAL_LIMITS.maxStatementsPerInvocation,
    `${statements} D1 statements`,
  );
  assert.ok(
    largestAtomicUnit <= IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit,
  );
  assert.ok(
    largestParameterCount <= IMPORT_REVERSAL_LIMITS.maxParametersPerStatement,
  );
  assert.throws(
    () =>
      createOwnedImportReversalRepository(base, {
        chunkSize: IMPORT_REVERSAL_LIMITS.maxChunkSize + 1,
      }),
    /invalid_import_reversal_chunk_size/,
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

// IMP-010B honest flip: the upload request body moved from
// `multipart/form-data` (read via `request.formData()`/`form.get(...)`) to
// browser-parsed JSON (read via `readJsonBody`/`supersedesBatchIdFromImportBody`
// -- see `app/import-request-body.ts`), since the server no longer reads a
// raw CSV file at all. The corrected-batch-reference forwarding this test
// pins is otherwise unchanged: `supersedesBatchId` is still read from the
// request and still forwarded as `supersedesBatchId || null` into
// `startUpload`.
test("corrected upload action forwards the superseded batch reference", async () => {
  const source = await readFile(
    new URL("../app/import-actions.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /supersedesBatchIdFromImportBody\(read\.body\)/);
  assert.match(source, /supersedesBatchId: supersedesBatchId \|\| null/);
});
