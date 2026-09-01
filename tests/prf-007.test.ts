// PRF-007 Finding A: a commit whose committed rows are ALL dividend
// receipts (the exact shape of a routine Sharesight payout sync) must
// invalidate/requeue derived state on the same terms a trade-bearing commit
// does. Before the fix, `db/repositories/import-commit.ts`'s `finalize`
// resolved the affected-portfolio set with `JOIN transactions t ON t.id =
// r.commit_transaction_id` -- the dividend commit path writes a
// `dividend_manual_records.id` into `commit_transaction_id`, which matches
// no `transactions.id`, so a dividend-only commit's `affected` set was
// always empty: no `projection`-pipeline `calculation_runs` row queued, and
// an empty `rebuildJobIds` returned to the caller
// (`app/import-accept-service.ts`'s `advanceCalculationRunsForCommit` then
// never runs). TASKS.md's PRF-007 Finding A names this queueing gap as a
// HYPOTHESIS for the owner's "still had the old values" report on
// `/income` after a Sharesight sync -- review round B3 (2026-09-01):
// that causal link is NOT established by the code. `/income` reads
// dividends LIVE (`app/owned-income-projection.ts` ->
// `app/owned-dividend-history.ts` -> `createDividendManualRecordRepository`
// `.list(...)`), and neither `db/repositories/projections.ts` nor
// `domain/snapshots/historical-portfolio-value.ts` /
// `domain/dividends/shares-held.ts` consume `dividend_manual_records` at
// all, so a newly queued (or previously missing) projection run cannot
// change any dividend figure `/income` renders. The queueing gap fixed
// here is real and worth fixing regardless, but it is NOT confirmed to be
// the cause of the owner's reported symptom -- that remains open (see
// TASKS.md's Findings B/C for the still-live 1102 hypotheses).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import { advanceCalculationRuns } from "../app/calculation-executor-service.ts";
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

test("PRF-007 Finding A / Orchestrator ruling F1: a dividend-only commit queues exactly one projection run over the combined receipt range, but issues NO value-history invalidation (a dividend receipt cannot make a stored value-history row wrong)", async () => {
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
  // F1: neither of these stored value-history rows may be touched by a
  // dividend-only commit -- one sits on/after the earliest receipt date,
  // one strictly before it, and BOTH must survive untouched.
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
      `SELECT portfolio_id, range_from, range_to, pipeline, reason, ledger_high_water_start
       FROM calculation_runs WHERE user_id = 'user-a' AND reason = 'import_commit'`,
    )
    .all() as Array<Record<string, unknown>>;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.portfolio_id, "portfolio-a");
  assert.equal(jobs[0]?.pipeline, "projection");
  // F1: the queued run's OWN range_from/range_to still combine both commit
  // kinds -- per docs/ARCHITECTURE.md's CALC-004 entry the projection
  // pipeline rebuilds the full ledger regardless of range_*, so the wider
  // run range costs nothing.
  assert.equal(
    jobs[0]?.range_from,
    "2026-08-05",
    "range_from is the earliest committed receipt's payment date",
  );
  assert.equal(jobs[0]?.range_to, "2026-08-10");
  // Review B1: portfolio-a has ZERO posted/reversed transactions -- the
  // correlated ledger_high_water subquery genuinely returns NULL, which
  // must land as the established '' sentinel, never the literal string
  // "null".
  assert.equal(
    jobs[0]?.ledger_high_water_start,
    "",
    "a genuinely absent ledger high-water must be the '' sentinel, never the string \"null\"",
  );

  const remainingHistory = database
    .prepare(
      `SELECT id FROM portfolio_value_history WHERE portfolio_id = 'portfolio-a' ORDER BY id`,
    )
    .all() as Array<{ id: string }>;
  assert.deepEqual(
    remainingHistory.map((row) => row.id),
    ["pvh-before", "pvh-in-range"],
    "F1: a dividend-only commit must invalidate NOTHING -- both rows survive untouched",
  );
});

test("PRF-007 review B1: a dividend-only commit's queued run resolves a REAL transaction id via the existing CALC-003 self-heal once the portfolio has one, and publishes it -- never left as '' or the string \"null\"", async () => {
  const database = await migratedDatabase();
  stageRow(database, "user-a", "batch-a", "row-1", 2, dividendRow());
  const client = createSqliteSqlClient(database);
  const result = await commitBatch(client, "user-a", "batch-a", "prf-007-b1");
  assert.equal(result.rebuildJobIds.length, 1);
  const queuedRunId = result.rebuildJobIds[0]!;

  const queued = database
    .prepare(
      `SELECT ledger_high_water_start, status FROM calculation_runs WHERE id = ?`,
    )
    .get(queuedRunId) as { ledger_high_water_start: string; status: string };
  assert.equal(queued.ledger_high_water_start, "");
  assert.equal(queued.status, "queued");

  // A REAL trade transaction lands in the portfolio AFTER the dividend-only
  // commit queued its run (e.g. a later Sharesight trade sync, or a manual
  // ledger post) -- the queued run's own ledger_high_water_start is still
  // '' at this point; it was never retroactively updated.
  database
    .prepare(
      `INSERT INTO transactions (
         id, user_id, portfolio_id, portfolio_security_id, type, status,
         trade_at, local_trade_date, quantity_decimal, unit_price_decimal,
         currency_code, gross_amount_decimal, fee_amount_decimal, tax_amount_decimal,
         source_type, created_by_user_id, calculation_version, created_at
       ) VALUES ('later-trade', 'user-a', 'portfolio-a', 'membership-a', 'buy', 'posted',
         '2026-08-20T00:00:00.000Z', '2026-08-20', '5', '10', 'AUD', '50', '0', '0',
         'manual', 'user-a', 1, '2026-08-20T00:00:00.000Z')`,
    )
    .run();

  const advanced = await advanceCalculationRuns(
    { client, now: () => "2026-08-20T01:00:00Z" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 100_000 },
  );
  assert.equal(advanced.completed, 1);

  const completedRun = database
    .prepare(
      `SELECT status, ledger_high_water_start FROM calculation_runs WHERE id = ?`,
    )
    .get(queuedRunId) as { status: string; ledger_high_water_start: string };
  assert.equal(completedRun.status, "completed");
  assert.equal(
    completedRun.ledger_high_water_start,
    "later-trade",
    "the CALC-003 B4 self-heal resolved and persisted the real transaction id, never left as ''",
  );

  const publication = database
    .prepare(
      `SELECT ledger_high_water FROM projection_publications WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a'`,
    )
    .get() as { ledger_high_water: string } | undefined;
  assert.equal(publication?.ledger_high_water, "later-trade");
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
  seedValueHistory(
    database,
    "user-a",
    "portfolio-a",
    "2026-08-01",
    "pvh-on-trade-date",
  );
  seedValueHistory(
    database,
    "user-a",
    "portfolio-a",
    "2026-07-31",
    "pvh-before",
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

  // F1: the trade's own date drives the value-history invalidation exactly
  // as it always did -- the coincident dividend date changes nothing here.
  const remainingHistory = database
    .prepare(
      `SELECT id FROM portfolio_value_history WHERE portfolio_id = 'portfolio-a' ORDER BY id`,
    )
    .all() as Array<{ id: string }>;
  assert.deepEqual(
    remainingHistory.map((row) => row.id),
    ["pvh-before"],
  );

  const manualRepo = createDividendManualRecordRepository(client);
  assert.equal((await manualRepo.list("user-a", "portfolio-a")).length, 1);
});

test("PRF-007 / Orchestrator ruling F1: a mixed trade+dividend commit widens the queued run's range_from/range_to to include an out-of-range dividend date, but its value-history DELETE stays pinned to the TRADE's own date, unaffected by the earlier dividend date", async () => {
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
  // Three probes around the two dates: strictly before the dividend date
  // (must survive regardless), BETWEEN the dividend date and the trade
  // date (F1's critical case -- an old-query-naive fix would wrongly
  // invalidate this since it falls within the COMBINED range_from/range_to,
  // but nothing this commit did can make it wrong), and on the trade's own
  // date (must be invalidated, exactly like any trade commit).
  seedValueHistory(
    database,
    "user-a",
    "portfolio-a",
    "2026-07-31",
    "pvh-before-both",
  );
  seedValueHistory(
    database,
    "user-a",
    "portfolio-a",
    "2026-08-05",
    "pvh-between-dividend-and-trade",
  );
  seedValueHistory(
    database,
    "user-a",
    "portfolio-a",
    "2026-08-10",
    "pvh-on-trade-date",
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
  // The queued run's OWN range still combines both kinds (F1: costs
  // nothing -- the projection pipeline rebuilds the full ledger regardless
  // of range_from/range_to).
  assert.equal(
    jobs[0]?.range_from,
    "2026-08-01",
    "range_from now reflects the earlier dividend receipt date, not just the trade date",
  );
  assert.equal(jobs[0]?.range_to, "2026-08-10");

  // F1's actual point: the value-history DELETE must be scoped to the
  // trade's own date (2026-08-10), never the wider combined range_from
  // (2026-08-01) -- the row strictly between the two dates must survive.
  const remainingHistory = database
    .prepare(
      `SELECT id FROM portfolio_value_history WHERE portfolio_id = 'portfolio-a' ORDER BY id`,
    )
    .all() as Array<{ id: string }>;
  assert.deepEqual(
    remainingHistory.map((row) => row.id),
    ["pvh-before-both", "pvh-between-dividend-and-trade"],
    "only the row ON/AFTER the trade's own date was invalidated; the dividend's earlier date must never widen the DELETE",
  );
});
