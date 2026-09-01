// PRF-007 Finding A: a commit whose committed rows are ALL dividend
// receipts (the exact shape of a routine Sharesight payout sync) must
// invalidate/requeue derived state on the same terms a trade-bearing commit
// does. Before the fix, `db/repositories/import-commit.ts`'s `finalize`
// resolved the affected-portfolio set with `JOIN transactions t ON t.id =
// r.commit_transaction_id` -- the dividend commit path writes a
// `dividend_manual_records.id` into `commit_transaction_id`, which matches
// no `transactions.id`, so a dividend-only commit's `affected` set was
// always empty: no `portfolio_value_history` invalidation, no queued
// `projection`-pipeline `calculation_runs` row, and an empty
// `rebuildJobIds` returned to the caller (`app/import-accept-service.ts`'s
// `advanceCalculationRunsForCommit` then never runs). This is the owner's
// "still had the old values" report on `/income` after a Sharesight sync.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import {
  createDividendManualRecordRepository,
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type ImportCommitResult,
  type SqlClient,
} from "../db/repositories/index.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS } from "../domain/imports/index.ts";

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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-13', '2026-08-13', 1),
           ('portfolio-b', 'user-b', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-13', '2026-08-13', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-13', '2026-08-13'),
           ('security-b', 'Beta', 'equity', 'AUD', 'active', '2026-08-13', '2026-08-13');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-13', '2026-08-13'),
           ('membership-b', 'user-b', 'portfolio-b', 'security-b', 'ABC', 'ASX', 'AUD', 'held', '2026-08-13', '2026-08-13');
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES
      ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv', '${SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS}', 'sample.csv', 100, 'file-a', 'parsed', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 1),
      ('batch-b', 'user-a', 'portfolio-a', 'strict-versioned-csv', '${SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS}', 'sample-b.csv', 100, 'file-b', 'parsed', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 1),
      ('batch-c', 'user-b', 'portfolio-b', 'strict-versioned-csv', '${SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS}', 'sample-c.csv', 100, 'file-c', 'parsed', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 1);
  `);
  return database;
}

function buyRow(
  overrides: Partial<{
    id: string;
    localTradeDate: string;
    tradeAtUtc: string;
    transactionDate: string;
  }> = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? "trade-1",
    symbol: "ABC",
    name: "Alpha",
    displaySymbol: null,
    exchange: "ASX",
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: "5",
    costPerShare: "10",
    commission: "0",
    transactionDate: overrides.transactionDate ?? "2026-08-01 GMT+1000",
    transactionTime: "10:00:00",
    purchaseExchangeRate: null,
    type: "buy",
    accounting: "fifo",
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: overrides.tradeAtUtc ?? "2026-08-01T00:00:00.000Z",
    localTradeDate: overrides.localTradeDate ?? "2026-08-01",
    cashEvent: null,
    frankingPerShare: null,
  };
}

function dividendRow(
  overrides: Partial<{
    id: string;
    paymentDate: string;
    localTradeDate: string;
  }> = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? "div-1",
    symbol: "ABC",
    name: "Alpha",
    displaySymbol: null,
    exchange: "ASX",
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: "5",
    costPerShare: "0.5",
    commission: "0",
    transactionDate: overrides.paymentDate ?? "2026-08-05 GMT+1000",
    transactionTime: null,
    purchaseExchangeRate: null,
    type: "dividend",
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: "2026-08-04T14:00:00.000Z",
    localTradeDate: overrides.localTradeDate ?? "2026-08-05",
    cashEvent: null,
    frankingPerShare: "0.21",
  };
}

function stageRow(
  database: DatabaseSync,
  userId: string,
  batchId: string,
  rowId: string,
  physicalRowNumber: number,
  normalized: Record<string, unknown>,
  fingerprint?: string,
): void {
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, commit_status, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, 'transaction', '[]', ?, ?, 'valid',
         NULL, 'staged', '2026-08-13', '2026-08-13', 1)`,
    )
    .run(
      rowId,
      userId,
      batchId,
      physicalRowNumber,
      JSON.stringify(normalized),
      fingerprint ?? `fingerprint-${batchId}-${rowId}`,
    );
}

async function currentPreviewVersion(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<string> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch) throw new Error("expected batch to exist");
  const [rows, issues, mappings, portfolios, candidateRows] = await Promise.all(
    [
      staging.listRows(userId, batchId),
      staging.listIssues(userId, batchId),
      createOwnedImportMappingDecisionRepository(client).list(userId, batchId),
      createOwnedPortfolioRepository(client).list(userId),
      client.all<Record<string, unknown>>(
        `SELECT id, portfolio_id, source_symbol, source_exchange_alias,
                source_currency_code, security_id
           FROM portfolio_securities WHERE user_id = ?
          ORDER BY source_symbol ASC, id ASC`,
        [userId],
      ),
    ],
  );
  const review = buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    })),
    securityCandidates: candidateRows.map((row) => ({
      id: String(row.id),
      portfolioId: String(row.portfolio_id),
      sourceSymbol: String(row.source_symbol),
      sourceExchangeAlias:
        row.source_exchange_alias === null
          ? null
          : String(row.source_exchange_alias),
      sourceCurrencyCode: String(row.source_currency_code),
      securityId: row.security_id === null ? null : String(row.security_id),
    })),
  });
  return review.previewVersion;
}

async function commitBatch(
  client: SqlClient,
  userId: string,
  batchId: string,
  idempotencyKey: string,
): Promise<Extract<ImportCommitResult, { ok: true }>> {
  const previewVersion = await currentPreviewVersion(client, userId, batchId);
  const ready = await markImportReadyWithContext({ client, userId }, batchId, {
    expectedVersion: 1,
    expectedPreviewVersion: previewVersion,
  });
  assert.equal(ready.ok, true, `expected ${batchId} to reach ready`);
  if (!ready.ok) throw new Error("not ready");
  const readyVersion = ready.review.batch.version;
  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate(userId, batchId);
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("validation failed");
  const commitInput: ImportCommitInput = {
    expectedVersion: readyVersion,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey,
    confirmation: true,
    requestId: `${idempotencyKey}-request`,
  };
  let commitResult = await commitRepo.commit(userId, batchId, commitInput);
  for (
    let attempt = 0;
    attempt < 10 && (!commitResult.ok || commitResult.status !== "committed");
    attempt += 1
  ) {
    assert.equal(commitResult.ok, true);
    commitResult = await commitRepo.commit(userId, batchId, commitInput);
  }
  assert.equal(commitResult.ok, true);
  if (!commitResult.ok) throw new Error("commit did not complete");
  assert.equal(commitResult.status, "committed");
  return commitResult;
}

function seedValueHistory(
  database: DatabaseSync,
  userId: string,
  portfolioId: string,
  valueDate: string,
  id: string,
): void {
  database
    .prepare(
      `INSERT INTO portfolio_value_history (
         id, user_id, portfolio_id, value_date, value_decimal, completeness,
         held_security_count, priced_security_count, computed_at
       ) VALUES (?, ?, ?, ?, '100', 'complete', 1, 1, '2026-08-13T00:00:00Z')`,
    )
    .run(id, userId, portfolioId, valueDate);
}

// ---------------------------------------------------------------------------
// FINDING A: dividend-only commit invalidation/queueing
// ---------------------------------------------------------------------------

test("PRF-007 Finding A: the OLD transactions-only join drops every row of a dividend-only commit -- documents the exact defect being fixed", async () => {
  const database = await migratedDatabase();
  stageRow(database, "user-a", "batch-a", "row-1", 2, dividendRow());
  const client = createSqliteSqlClient(database);
  await commitBatch(client, "user-a", "batch-a", "prf-007-repro");

  // The row committed (a dividend_manual_records id was written into
  // commit_transaction_id)...
  const committedRow = database
    .prepare(
      `SELECT commit_status, commit_transaction_id FROM import_rows WHERE id = 'row-1'`,
    )
    .get() as { commit_status: string; commit_transaction_id: string };
  assert.equal(committedRow.commit_status, "committed");
  assert.ok(committedRow.commit_transaction_id);

  // ...but the OLD query (`JOIN transactions t ON t.id = r.commit_transaction_id`)
  // matches nothing for it, because that id belongs to
  // `dividend_manual_records`, not `transactions`. This is FINDING A's root
  // cause, reproduced directly against the post-commit database state.
  const oldQueryResult = database
    .prepare(
      `SELECT t.portfolio_id
       FROM import_rows r
       JOIN transactions t ON t.id = r.commit_transaction_id AND t.user_id = r.user_id
       WHERE r.user_id = 'user-a' AND r.batch_id = 'batch-a' AND r.commit_status = 'committed'`,
    )
    .all();
  assert.deepEqual(
    oldQueryResult,
    [],
    "the pre-fix affected-portfolio query returns zero rows for a dividend-only commit",
  );
});

test("PRF-007 Finding A: a dividend-only commit now queues exactly one projection run per affected portfolio and invalidates value history from the earliest committed receipt date", async () => {
  const database = await migratedDatabase();
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-1",
    2,
    dividendRow({
      paymentDate: "2026-08-10 GMT+1000",
      localTradeDate: "2026-08-10",
    }),
  );
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-2",
    3,
    dividendRow({
      id: "div-2",
      paymentDate: "2026-08-05 GMT+1000",
      localTradeDate: "2026-08-05",
    }),
  );
  // A stored value-history row on/after the earliest committed receipt date
  // must be invalidated; one strictly BEFORE it must survive untouched.
  seedValueHistory(
    database,
    "user-a",
    "portfolio-a",
    "2026-08-05",
    "pvh-in-range",
  );
  seedValueHistory(
    database,
    "user-a",
    "portfolio-a",
    "2026-08-04",
    "pvh-before",
  );

  const client = createSqliteSqlClient(database);
  const result = await commitBatch(client, "user-a", "batch-a", "prf-007-a");

  assert.equal(result.committedRows, 2);
  assert.equal(
    result.rebuildJobIds.length,
    1,
    "one projection run queued for the single affected portfolio",
  );

  const jobs = database
    .prepare(
      `SELECT portfolio_id, range_from, range_to, pipeline, reason
       FROM calculation_runs WHERE user_id = 'user-a' AND reason = 'import_commit'`,
    )
    .all() as Array<Record<string, unknown>>;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.portfolio_id, "portfolio-a");
  assert.equal(jobs[0]?.pipeline, "projection");
  assert.equal(
    jobs[0]?.range_from,
    "2026-08-05",
    "range_from is the earliest committed receipt's payment date",
  );
  assert.equal(jobs[0]?.range_to, "2026-08-10");

  const remainingHistory = database
    .prepare(
      `SELECT id FROM portfolio_value_history WHERE portfolio_id = 'portfolio-a' ORDER BY id`,
    )
    .all() as Array<{ id: string }>;
  assert.deepEqual(
    remainingHistory.map((row) => row.id),
    ["pvh-before"],
    "the >= range_from row was invalidated; the row before it was not",
  );
});

test("PRF-007: an all-duplicate re-sync commit (every row skips) still queues nothing -- correct, unchanged", async () => {
  const database = await migratedDatabase();
  const shared = dividendRow();
  stageRow(database, "user-a", "batch-a", "row-dup-a", 2, shared, "shared-fp");
  stageRow(database, "user-a", "batch-b", "row-dup-b", 2, shared, "shared-fp");
  const client = createSqliteSqlClient(database);

  const first = await commitBatch(client, "user-a", "batch-a", "prf-007-dup-a");
  assert.equal(first.rebuildJobIds.length, 1);

  const second = await commitBatch(
    client,
    "user-a",
    "batch-b",
    "prf-007-dup-b",
  );
  assert.equal(
    second.rebuildJobIds.length,
    0,
    "every row in batch-b skipped as an already-imported duplicate -- nothing changed, nothing queued",
  );
  const rowB = database
    .prepare(`SELECT commit_status FROM import_rows WHERE id = 'row-dup-b'`)
    .get() as { commit_status: string };
  assert.equal(rowB.commit_status, "skipped");
});

test("PRF-007: ownership isolation on the widened affected-portfolio query -- a dividend-only commit never touches another owner's portfolio", async () => {
  const database = await migratedDatabase();
  stageRow(database, "user-a", "batch-a", "row-own-a", 2, dividendRow());
  stageRow(
    database,
    "user-b",
    "batch-c",
    "row-own-b",
    2,
    dividendRow({
      id: "div-b",
    }),
  );
  const client = createSqliteSqlClient(database);

  const resultA = await commitBatch(
    client,
    "user-a",
    "batch-a",
    "prf-007-own-a",
  );
  const resultB = await commitBatch(
    client,
    "user-b",
    "batch-c",
    "prf-007-own-b",
  );

  assert.equal(resultA.rebuildJobIds.length, 1);
  assert.equal(resultB.rebuildJobIds.length, 1);

  const jobsA = database
    .prepare(
      `SELECT portfolio_id FROM calculation_runs WHERE user_id = 'user-a' AND reason = 'import_commit'`,
    )
    .all() as Array<{ portfolio_id: string }>;
  assert.deepEqual(
    jobsA.map((row) => row.portfolio_id),
    ["portfolio-a"],
  );

  const jobsB = database
    .prepare(
      `SELECT portfolio_id FROM calculation_runs WHERE user_id = 'user-b' AND reason = 'import_commit'`,
    )
    .all() as Array<{ portfolio_id: string }>;
  assert.deepEqual(
    jobsB.map((row) => row.portfolio_id),
    ["portfolio-b"],
  );

  // Cross-user isolation is by construction here (each user's batch/rows
  // only ever reference their own user_id), but assert directly that
  // user-a's queued run never names user-b's portfolio and vice versa.
  assert.equal(
    jobsA.some((row) => row.portfolio_id === "portfolio-b"),
    false,
  );
  assert.equal(
    jobsB.some((row) => row.portfolio_id === "portfolio-a"),
    false,
  );
});

// ---------------------------------------------------------------------------
// Trade-bearing commit behaviour: byte-identical, never changed by this fix
// ---------------------------------------------------------------------------

test("PRF-007: a trade-only commit's affected-portfolio resolution is byte-identical to the OLD transactions-only query", async () => {
  const database = await migratedDatabase();
  stageRow(database, "user-a", "batch-a", "row-1", 2, buyRow());
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-2",
    3,
    buyRow({
      id: "trade-2",
      localTradeDate: "2026-08-03",
      tradeAtUtc: "2026-08-03T00:00:00.000Z",
      transactionDate: "2026-08-03 GMT+1000",
    }),
  );
  const client = createSqliteSqlClient(database);
  const result = await commitBatch(
    client,
    "user-a",
    "batch-a",
    "prf-007-trade-only",
  );
  assert.equal(result.committedRows, 2);

  // The NEW code's persisted result for this trade-only commit...
  const persisted = database
    .prepare(
      `SELECT portfolio_id, range_from, range_to, ledger_high_water_start
       FROM calculation_runs WHERE user_id = 'user-a' AND reason = 'import_commit'
       ORDER BY portfolio_id`,
    )
    .all() as Array<Record<string, unknown>>;
  assert.equal(persisted.length, 1);

  // ...must equal what the OLD (pre-PRF-007) transactions-only query would
  // have computed from the exact same committed rows -- proving the fix
  // never changes trade-bearing commit behaviour.
  const oldQueryResult = database
    .prepare(
      `SELECT t.portfolio_id, MIN(t.local_trade_date) AS range_from,
              MAX(t.local_trade_date) AS range_to, COUNT(*) AS committed_count,
              (SELECT latest.id FROM transactions latest
               WHERE latest.user_id = 'user-a' AND latest.portfolio_id = t.portfolio_id
                 AND latest.status IN ('posted', 'reversed')
               ORDER BY latest.trade_at DESC, latest.id DESC LIMIT 1) AS ledger_high_water
       FROM import_rows r
       JOIN transactions t ON t.id = r.commit_transaction_id AND t.user_id = r.user_id
       WHERE r.user_id = 'user-a' AND r.batch_id = 'batch-a' AND r.commit_status = 'committed'
       GROUP BY t.portfolio_id
       ORDER BY t.portfolio_id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  assert.equal(oldQueryResult.length, 1);
  assert.equal(persisted[0]?.portfolio_id, oldQueryResult[0]?.portfolio_id);
  assert.equal(persisted[0]?.range_from, oldQueryResult[0]?.range_from);
  assert.equal(persisted[0]?.range_to, oldQueryResult[0]?.range_to);
  assert.equal(
    persisted[0]?.ledger_high_water_start,
    oldQueryResult[0]?.ledger_high_water,
  );
});

test("PRF-007: a mixed trade+dividend commit (dividend paid inside the trade's own date span) is unchanged -- same portfolio, same range, one job", async () => {
  const database = await migratedDatabase();
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-1",
    2,
    buyRow({
      id: "trade-mixed",
      localTradeDate: "2026-08-01",
      tradeAtUtc: "2026-08-01T00:00:00.000Z",
    }),
  );
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-2",
    3,
    dividendRow({
      id: "div-mixed",
      paymentDate: "2026-08-01 GMT+1000",
      localTradeDate: "2026-08-01",
    }),
  );
  const client = createSqliteSqlClient(database);
  const result = await commitBatch(
    client,
    "user-a",
    "batch-a",
    "prf-007-mixed",
  );
  assert.equal(result.committedRows, 2);
  assert.equal(result.rebuildJobIds.length, 1);

  const jobs = database
    .prepare(
      `SELECT portfolio_id, range_from, range_to
       FROM calculation_runs WHERE user_id = 'user-a' AND reason = 'import_commit'`,
    )
    .all() as Array<Record<string, unknown>>;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.portfolio_id, "portfolio-a");
  assert.equal(jobs[0]?.range_from, "2026-08-01");
  assert.equal(jobs[0]?.range_to, "2026-08-01");

  const manualRepo = createDividendManualRecordRepository(client);
  assert.equal((await manualRepo.list("user-a", "portfolio-a")).length, 1);
});

test("PRF-007: a mixed trade+dividend commit widens range_from/range_to to include an out-of-range dividend date (correct, not a regression)", async () => {
  const database = await migratedDatabase();
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-1",
    2,
    buyRow({
      id: "trade-wide",
      localTradeDate: "2026-08-10",
      tradeAtUtc: "2026-08-10T00:00:00.000Z",
      transactionDate: "2026-08-10 GMT+1000",
    }),
  );
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-2",
    3,
    dividendRow({
      id: "div-wide",
      paymentDate: "2026-08-01 GMT+1000",
      localTradeDate: "2026-08-01",
    }),
  );
  const client = createSqliteSqlClient(database);
  const result = await commitBatch(client, "user-a", "batch-a", "prf-007-wide");
  assert.equal(result.rebuildJobIds.length, 1);

  const jobs = database
    .prepare(
      `SELECT range_from, range_to FROM calculation_runs
       WHERE user_id = 'user-a' AND reason = 'import_commit'`,
    )
    .all() as Array<Record<string, unknown>>;
  assert.equal(jobs.length, 1);
  assert.equal(
    jobs[0]?.range_from,
    "2026-08-01",
    "range_from now reflects the earlier dividend receipt date, not just the trade date",
  );
  assert.equal(jobs[0]?.range_to, "2026-08-10");
});
