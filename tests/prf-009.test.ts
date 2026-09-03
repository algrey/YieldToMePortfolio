// PRF-009 correction round B2 (BLOCKING, 2026-09-03): neither of PRF-009's
// two `+`-prefixed unary-plus no-index hints (SQLite's documented technique
// to disable an index without changing query semantics) had a test that
// would actually fail if the hint were removed:
//
//  - `db/repositories/import-commit.ts`'s `finalize` (~line 1032):
//    `WHERE +r.user_id = ? AND r.batch_id = ? ...` -- without the hint the
//    planner drives the query from `import_rows_user_normalized_fingerprint_
//    idx (user_id=?)`, a user-wide range covering every `import_rows` row
//    this owner has EVER committed (see the query's own doc comment), the
//    exact regression PRF-009 exists to fix.
//  - `app/import-actions.ts`'s BUG-011 cross-route trade-duplicate query
//    (`+reverses_transaction_id IS NULL`) -- covered by
//    `tests/bug-011.test.ts`'s widened F-a source pin (now `\+` mandatory,
//    not `\+?`).
//
// This file covers the FIRST hint with a live `EXPLAIN QUERY PLAN` test,
// mirroring `tests/imp-003b.test.ts`'s `capturingClient`/`EXPLAIN QUERY
// PLAN` pattern for `affectedPortfolioIdsForBatch`'s identical `+source_row.
// user_id` hint (BUG-016 round-4). Fails pre-hint (confirmed by temporarily
// reverting the source): the plan reverts to a seek on
// `import_rows_user_normalized_fingerprint_idx` instead of the batch-scoped
// `import_rows_batch_physical_row_unique (batch_id=?)`.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createOwnedImportCommitRepository,
  createSqliteSqlClient,
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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-03', '2026-08-03');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'AUD', 'held', '2026-08-03', '2026-08-03');
  `);
  return database;
}

function normalized(
  rowNumber: number,
  overrides: Record<string, unknown> = {},
) {
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
    ...overrides,
  };
}

function stageBatch(
  database: DatabaseSync,
  batchId: string,
  rowCount: number,
): void {
  database
    .prepare(
      `INSERT INTO import_batches (
         id, user_id, target_portfolio_id, parser_format, parser_version, filename,
         byte_size, file_sha256, status, created_at, updated_at, version
       ) VALUES (?, 'user-a', 'portfolio-a', 'strict-versioned-csv',
         '${SUPPORTED_IMPORT_PARSER_VERSION}', 'sample.csv', 100, ?, 'ready',
         '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z', 1)`,
    )
    .run(batchId, `file-${batchId}`);
  const insert = database.prepare(
    `INSERT INTO import_rows (
       id, user_id, batch_id, physical_row_number, row_class,
       original_fields_json, normalized_fields_json, normalized_fingerprint,
       validation_status, target_portfolio_id, target_portfolio_security_id,
       commit_status, created_at, updated_at, version
     ) VALUES (?, 'user-a', ?, ?, 'transaction', '[]', ?, ?, 'valid',
       'portfolio-a', 'membership-a', 'staged', '2026-08-03', '2026-08-03', 1)`,
  );
  for (let index = 0; index < rowCount; index += 1) {
    const rowNumber = index + 2;
    insert.run(
      `row-${batchId}-${index + 1}`,
      batchId,
      rowNumber,
      JSON.stringify(normalized(rowNumber)),
      `fingerprint-${batchId}-${index + 1}`,
    );
  }
}

async function commitBatch(client: SqlClient, batchId: string): Promise<void> {
  const repository = createOwnedImportCommitRepository(client);
  const validated = await repository.validate("user-a", batchId);
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("expected the import to validate");
  const input: ImportCommitInput = {
    expectedVersion: 1,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: `commit-${batchId}`,
    confirmation: true,
    requestId: `request-${batchId}`,
  };
  let result = await repository.commit("user-a", batchId, input);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (result.ok && result.status === "committed") break;
    assert.equal(result.ok, true);
    result = await repository.commit("user-a", batchId, input);
  }
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected the import to commit");
  assert.equal(result.status, "committed");
}

/** Captures every `all`/`get` call's exact SQL/params -- lets a test re-run
 * `EXPLAIN QUERY PLAN` on precisely what the real code path just executed
 * (the `tests/prf-002.test.ts` `stageCensusClient` / `tests/imp-003b.test.ts`
 * `capturingClient` convention), rather than a hand-copied literal that
 * could drift from the source. */
function capturingClient(base: SqlClient): {
  client: SqlClient;
  calls: Array<{ sql: string; params: readonly unknown[] | undefined }>;
} {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> =
    [];
  const client: SqlClient = {
    async all(sql, params) {
      calls.push({ sql, params });
      return base.all(sql, params);
    },
    async get(sql, params) {
      calls.push({ sql, params });
      return base.get(sql, params);
    },
    run: (sql, params) => base.run(sql, params),
    batch: (statements) => base.batch!(statements),
  };
  return { client, calls };
}

test("PRF-009 correction B2: finalize's +r.user_id hint keeps the affected-portfolio query on the batch-scoped seek, not the user-wide fingerprint index", async () => {
  const database = await migratedDatabase();
  // Prior, already-committed batches for the SAME user -- seeds real
  // user-wide `import_rows` history (200 rows across 40 batches) so a
  // hint-less planner would have something to prefer over the batch-scoped
  // index, exactly mirroring `tests/imp-003b.test.ts`'s analogous BUG-016 (b)
  // fixture for `affectedPortfolioIdsForBatch`.
  const priorClient = createSqliteSqlClient(database);
  for (let batch = 0; batch < 40; batch += 1) {
    stageBatch(database, `batch-old-${batch}`, 5);
    await commitBatch(priorClient, `batch-old-${batch}`);
  }
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM import_rows WHERE user_id = 'user-a' AND commit_status = 'committed'",
        )
        .get() as { count: number }
    ).count,
    200,
    "prior committed history must be seeded before the batch under test",
  );

  stageBatch(database, "batch-under-test", 5);
  const { client, calls } = capturingClient(createSqliteSqlClient(database));
  await commitBatch(client, "batch-under-test");

  const finalizeCall = calls.find((call) =>
    call.sql.includes("SELECT combined.portfolio_id AS portfolio_id"),
  );
  assert.ok(
    finalizeCall,
    "expected finalize's affected-portfolio query to have run",
  );

  const plan = database
    .prepare(`EXPLAIN QUERY PLAN ${finalizeCall!.sql}`)
    .all(...((finalizeCall!.params ?? []) as never[])) as Array<{
    detail: string;
  }>;
  const details = plan.map((row) => row.detail);
  assert.ok(
    details.some((detail) =>
      /SEARCH r USING INDEX import_rows_batch_physical_row_unique \(batch_id=\?\)/.test(
        detail,
      ),
    ),
    `expected a batch-scoped seek, got: ${JSON.stringify(details)}`,
  );
  assert.ok(
    !details.some((detail) =>
      detail.includes("import_rows_user_normalized_fingerprint_idx"),
    ),
    `must not fall back to the user-wide index, got: ${JSON.stringify(details)}`,
  );

  // Mutation check: removing the hint on the SAME captured SQL/params must
  // NOT keep the batch-scoped plan -- this is the regression the hint exists
  // to prevent.
  const unhinted = finalizeCall!.sql.replace(
    "WHERE +r.user_id = ?",
    "WHERE r.user_id = ?",
  );
  assert.notEqual(unhinted, finalizeCall!.sql);
  const unhintedPlan = database
    .prepare(`EXPLAIN QUERY PLAN ${unhinted}`)
    .all(...((finalizeCall!.params ?? []) as never[])) as Array<{
    detail: string;
  }>;
  assert.ok(
    !unhintedPlan.some((row) =>
      /USING INDEX import_rows_batch_physical_row_unique \(batch_id=\?\)/.test(
        row.detail,
      ),
    ),
    `expected removing the hint to give up the batch-scoped seek, got: ${JSON.stringify(unhintedPlan.map((row) => row.detail))}`,
  );
});
