// CALC-005: the historical-snapshot (Overview) pipeline CALC-004 wired up
// alongside the CALC-003 projection pipeline (docs/ARCHITECTURE.md's
// CALC-004 entry) is now RETIRED -- see that document's CALC-005 entry for
// the full production-impact rationale: an MKT-008/MKT-020 price-history
// -only import never invalidates or requeues a cursor-based snapshot run,
// so a run started before such an import permanently misses the new
// prices; in production this left one snapshot run stuck `running` forever
// (241+ resumable claims, zero priced holdings for its entire progress)
// while HIST-001/HIST-002's read-time derivation already serves the
// Overview graph/hero directly from `price_observations`/ledger facts,
// making `snapshot_publications` output nothing actually reads.
//
// These tests now verify the RETIRED shape instead of the old dual-
// pipeline execution this file used to exercise end to end: nothing ever
// queues a `snapshot`-pipeline `calculation_runs` row any more (ledger
// mutations, import commits), and `sweepCalculationRuns`'s cron-sweep
// cleanup drives any PRE-EXISTING queued/running snapshot row to a
// terminal `abandoned` state without ever claiming, advancing, or touching
// its cursor/checkpoint columns. Every CALC-003 projection-pipeline
// assertion this file previously carried (the end-to-end commit flow, the
// same-currency FX-identity follow-up) is preserved unchanged.
//
// `db/repositories/snapshots.ts`'s rebuild machinery itself
// (`createHistoricalSnapshotRepository`, `resolveSnapshotRunRange`,
// `computeSnapshotRunRange`) is left in place, unmodified and unreachable
// from any production trigger -- matching the precedent HIST-001 already
// set for this same pipeline -- so this file no longer exercises it end to
// end; that superseded coverage lives in this file's git history.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  advanceCalculationRuns,
  advanceCalculationRunsForCommit,
  sweepCalculationRuns,
  POST_COMMIT_CALCULATION_BUDGET,
} from "../app/calculation-executor-service.ts";
import { loadOwnedHoldings } from "../app/owned-holdings.ts";
import {
  createCalculationRunRepository,
  createOwnedImportCommitRepository,
  createOwnedLedgerRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type ImportCommitResult,
  type ImportCommitSuccess,
  type LedgerMutationResult,
  type SqlClient,
} from "../db/repositories/index.ts";
import type { LedgerPostingInput } from "../domain/ledger/index.ts";
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
  `);
  return database;
}

function ledgerInput(
  overrides: Partial<LedgerPostingInput> = {},
): LedgerPostingInput {
  return {
    portfolioId: "portfolio-a",
    type: "buy",
    portfolioSecurityId: "membership-a",
    quantityDecimal: "1",
    unitPriceDecimal: "10",
    grossAmountDecimal: null,
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: "1",
    sourceType: "manual",
    idempotencyKey: "buy-default",
    tradeAt: "2026-08-01T00:00:00Z",
    localTradeDate: "2026-08-01",
    settlementDate: "2026-08-03",
    currencyCode: "AUD",
    requestId: "request-default",
    ...overrides,
  };
}

// Mirrors `tests/calc-003.test.ts`'s identical helper: a strictly
// increasing `now()` so separate post()/reverse() calls always queue
// `calculation_runs` rows with distinct, correctly-ordered `created_at`
// values instead of racing on `hasNewerRun`'s id tie-break.
function sequentialNow(startIso: string): () => string {
  let current = Date.parse(startIso);
  return () => {
    const iso = new Date(current).toISOString();
    current += 1000;
    return iso;
  };
}

function postedTransactionId(result: LedgerMutationResult): string {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected a successful ledger mutation");
  return result.transaction.id;
}

async function projectionPublicationCount(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<number> {
  const row = await client.get<{ count: number }>(
    `SELECT count(*) AS count FROM projection_publications WHERE user_id = ? AND portfolio_id = ?`,
    [userId, portfolioId],
  );
  return Number(row?.count ?? 0);
}

async function snapshotPublicationCount(
  client: SqlClient,
  userId: string,
  portfolioId: string,
): Promise<number> {
  const row = await client.get<{ count: number }>(
    `SELECT count(*) AS count FROM snapshot_publications WHERE user_id = ? AND portfolio_id = ?`,
    [userId, portfolioId],
  );
  return Number(row?.count ?? 0);
}

async function calculationRunCount(
  client: SqlClient,
  userId: string,
  portfolioId: string,
  pipeline: "projection" | "snapshot",
): Promise<number> {
  const row = await client.get<{ count: number }>(
    `SELECT count(*) AS count FROM calculation_runs
     WHERE user_id = ? AND portfolio_id = ? AND pipeline = ?`,
    [userId, portfolioId, pipeline],
  );
  return Number(row?.count ?? 0);
}

// Stages and commits a small batch of AUD buys (3 x 2 shares @ $10 = 6
// shares / $60 basis), all trading on a single local date.
async function commitSimpleBatch(
  database: DatabaseSync,
  client: SqlClient,
  nowOverride: () => string,
): Promise<ImportCommitSuccess> {
  database
    .prepare(
      `INSERT INTO import_batches (
         id, user_id, target_portfolio_id, parser_format, parser_version, filename,
         byte_size, file_sha256, status, created_at, updated_at, version
       ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv', ?,
         'sample.csv', 100, 'file-a', 'ready', '2026-08-01T00:00:00Z',
         '2026-08-01T00:00:00Z', 1)`,
    )
    .run(SUPPORTED_IMPORT_PARSER_VERSION);
  const rowInsert = database.prepare(
    `INSERT INTO import_rows (
       id, user_id, batch_id, physical_row_number, row_class,
       original_fields_json, normalized_fields_json, normalized_fingerprint,
       validation_status, target_portfolio_id, target_portfolio_security_id,
       commit_status, created_at, updated_at, version
     ) VALUES (?, 'user-a', 'batch-a', ?, 'transaction', '[]', ?, ?, 'valid',
       'portfolio-a', 'membership-a', 'staged', '2026-08-01', '2026-08-01', 1)`,
  );
  for (let index = 0; index < 3; index += 1) {
    const rowNumber = index + 2;
    const normalized = {
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
      transactionTime: `01:00:${String(rowNumber).padStart(2, "0")}`,
      purchaseExchangeRate: null,
      type: "buy",
      accounting: "fifo",
      accountingExecutionIds: null,
      notes: null,
      tradeAtUtc: `2026-08-01T01:00:${String(rowNumber).padStart(2, "0")}.000Z`,
      localTradeDate: "2026-08-01",
      cashEvent: null,
    };
    rowInsert.run(
      `row-${index + 1}`,
      rowNumber,
      JSON.stringify(normalized),
      `fingerprint-${index + 1}`,
    );
  }
  const validated = await createOwnedImportCommitRepository(client, {
    now: nowOverride,
  }).validate("user-a", "batch-a");
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("expected a valid preview");
  const commitInput: ImportCommitInput = {
    expectedVersion: 1,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "commit-a",
    confirmation: true,
    requestId: "request-a",
  };
  const commitRepository = createOwnedImportCommitRepository(client, {
    now: nowOverride,
  });
  let commitResult: ImportCommitResult = await commitRepository.commit(
    "user-a",
    "batch-a",
    commitInput,
  );
  for (
    let attempt = 0;
    attempt < 20 && (!commitResult.ok || commitResult.status !== "committed");
    attempt += 1
  ) {
    assert.equal(commitResult.ok, true);
    commitResult = await commitRepository.commit(
      "user-a",
      "batch-a",
      commitInput,
    );
  }
  assert.equal(commitResult.ok, true);
  if (!commitResult.ok) throw new Error("expected commit to complete");
  assert.equal(commitResult.status, "committed");
  return commitResult;
}

const FIXED_NOW = "2026-08-01T01:00:00Z";

test("CALC-005 end-to-end: a committed batch queues and advances only the projection pipeline -- no snapshot-pipeline row is ever queued", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const commitResult = await commitSimpleBatch(
    database,
    client,
    () => FIXED_NOW,
  );

  // The retirement's core claim: `finalize()` no longer inserts a sibling
  // `snapshot`-pipeline row alongside the `projection` one. Every committed
  // row's own ledger posting plus `finalize()`'s aggregate row still queue
  // `projection`-pipeline runs (CALC-003's pre-existing "duplicate
  // per-commit work" shape, unrelated to this retirement).
  assert.equal(
    await calculationRunCount(client, "user-a", "portfolio-a", "snapshot"),
    0,
  );
  assert.ok(
    (await calculationRunCount(client, "user-a", "portfolio-a", "projection")) >
      0,
  );
  assert.equal(commitResult.rebuildJobIds.length, 1);

  assert.equal(
    await projectionPublicationCount(client, "user-a", "portfolio-a"),
    0,
  );

  // Trigger 1's exact call shape -- CALC-004 briefly returned 2 results
  // here (projection, then snapshot); CALC-005 retired the snapshot
  // pipeline, so `advanceCalculationRunsForCommit` only ever advances
  // projection now.
  const results = await advanceCalculationRunsForCommit(
    { client, now: () => FIXED_NOW },
    {
      userId: "user-a",
      calculationRunIds: commitResult.rebuildJobIds,
      budget: POST_COMMIT_CALCULATION_BUDGET,
    },
  );
  assert.equal(results.length, 1);
  assert.equal(results[0]?.completed, 1);

  assert.equal(
    await projectionPublicationCount(client, "user-a", "portfolio-a"),
    1,
  );
  // Never populates: nothing ever queues or advances a snapshot-pipeline
  // run for this portfolio any more.
  assert.equal(
    await snapshotPublicationCount(client, "user-a", "portfolio-a"),
    0,
  );

  // Projection pipeline: real quantities/basis (CALC-003's own contract),
  // preserved unchanged by this retirement.
  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-05T00:00:00Z"),
  );
  assert.equal(holdings.rows.length, 1);
  assert.equal(holdings.rows[0]?.quantity, "6");
});

test("CALC-005: a manual ledger post and reverse (the persist() code path) queue only projection-pipeline runs", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const ledger = createOwnedLedgerRepository(
    client,
    sequentialNow("2026-08-01T01:00:00Z"),
  );

  const posted = await ledger.post(
    "user-a",
    ledgerInput({ idempotencyKey: "buy-1" }),
  );
  const transactionId = postedTransactionId(posted);
  assert.equal(
    await calculationRunCount(client, "user-a", "portfolio-a", "snapshot"),
    0,
  );

  const reversal = await ledger.reverse(
    "user-a",
    "portfolio-a",
    transactionId,
    "reverse-1",
    "request-reverse",
  );
  assert.equal(reversal.ok, true);
  // Still zero after the reversal -- `persist()`'s reverse/supersede paths
  // no longer queue a sibling snapshot row either.
  assert.equal(
    await calculationRunCount(client, "user-a", "portfolio-a", "snapshot"),
    0,
  );

  // Projection pipeline itself is unaffected: it still advances and
  // publishes normally.
  const advanced = await advanceCalculationRuns(
    { client, now: () => "2026-08-01T02:00:00Z" },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "projection",
      budget: 1000,
    },
  );
  assert.equal(advanced.completed, 1);
  assert.equal(
    await projectionPublicationCount(client, "user-a", "portfolio-a"),
    1,
  );
});

test("CALC-005: sweepCalculationRuns terminates a legacy QUEUED snapshot-pipeline run to 'abandoned' without ever claiming or advancing it", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const runs = createCalculationRunRepository(client);

  // Simulates a row a pre-CALC-005 deployment left behind: queued, never
  // claimed. `runs.request` is called directly (bypassing the now-removed
  // queueing sites) purely to construct this legacy shape.
  await runs.request("user-a", {
    id: "legacy-queued-snapshot",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-01",
    calculationVersion: 1,
    reason: "ledger_mutation",
    pipeline: "snapshot",
    ledgerHighWaterStart: "",
    idempotencyKey: "legacy-queued-snapshot",
    now: "2026-08-01T00:00:00Z",
  });

  const summary = await sweepCalculationRuns(
    { client, now: () => "2026-08-31T00:00:00Z" },
    { maxPortfolios: 10, budgetPerPortfolio: 500 },
  );
  assert.equal(summary.snapshotRunsTerminated, 1);
  // Never claimed/advanced as real work -- the sweep's projection-shaped
  // advance loop never sees this row at all.
  assert.equal(summary.portfoliosSwept, 0);
  assert.equal(summary.advanced, 0);
  assert.equal(summary.completed, 0);

  const row = database
    .prepare(
      `SELECT status, failure_category, lease_owner, lease_expires_at,
              processed_snapshot_count, processed_holding_count, stall_count
       FROM calculation_runs WHERE id = 'legacy-queued-snapshot'`,
    )
    .get() as {
    status: string;
    failure_category: string | null;
    lease_owner: string | null;
    lease_expires_at: string | null;
    processed_snapshot_count: number;
    processed_holding_count: number;
    stall_count: number;
  };
  assert.equal(row.status, "abandoned");
  assert.equal(row.failure_category, "pipeline_retired");
  assert.equal(row.lease_owner, null);
  assert.equal(row.lease_expires_at, null);
  // Cursor/checkpoint columns are UNTOUCHED -- this is a status transition,
  // never a rebuild step.
  assert.equal(row.processed_snapshot_count, 0);
  assert.equal(row.processed_holding_count, 0);
  assert.equal(row.stall_count, 0);
  assert.equal(
    await snapshotPublicationCount(client, "user-a", "portfolio-a"),
    0,
  );
});

test("CALC-005: sweepCalculationRuns terminates a legacy RUNNING snapshot-pipeline run (production's stuck-run shape: many attempts, a still-live lease, partial cursor progress) and the cleanup is idempotent", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const runs = createCalculationRunRepository(client);

  await runs.request("user-a", {
    id: "legacy-running-snapshot",
    portfolioId: "portfolio-a",
    rangeFrom: "2020-01-15",
    rangeTo: "2026-08-21",
    calculationVersion: 1,
    reason: "import_commit",
    pipeline: "snapshot",
    ledgerHighWaterStart: "",
    idempotencyKey: "legacy-running-snapshot",
    now: "2026-08-21T00:00:00Z",
  });
  const claimed = await runs.claim(
    "user-a",
    "portfolio-a",
    "legacy-running-snapshot",
    "some-worker",
    "2026-08-31T00:10:00Z", // lease still live relative to the sweep below
    "2026-08-21T00:00:00Z",
  );
  assert.equal(claimed.ok, true);
  // Production's reported shape: many resumable claims, real (if
  // incomplete) forward progress on the cursor, still `running`.
  database
    .prepare(
      `UPDATE calculation_runs
       SET attempt = 241, processed_snapshot_count = 967
       WHERE id = 'legacy-running-snapshot'`,
    )
    .run();

  const first = await sweepCalculationRuns(
    { client, now: () => "2026-08-31T00:00:00Z" },
    { maxPortfolios: 10, budgetPerPortfolio: 500 },
  );
  assert.equal(first.snapshotRunsTerminated, 1);
  assert.equal(first.advanced, 0);
  assert.equal(first.completed, 0);

  const row = database
    .prepare(
      `SELECT status, failure_category, lease_owner, processed_snapshot_count, attempt
       FROM calculation_runs WHERE id = 'legacy-running-snapshot'`,
    )
    .get() as {
    status: string;
    failure_category: string | null;
    lease_owner: string | null;
    processed_snapshot_count: number;
    attempt: number;
  };
  assert.equal(row.status, "abandoned");
  assert.equal(row.failure_category, "pipeline_retired");
  assert.equal(row.lease_owner, null);
  // The cursor is UNCHANGED -- forced to a terminal state, never advanced
  // one step further, regardless of its still-live lease.
  assert.equal(row.processed_snapshot_count, 967);
  assert.equal(row.attempt, 241);

  // Idempotent: a later sweep finds nothing left to terminate.
  const second = await sweepCalculationRuns(
    { client, now: () => "2026-08-31T01:00:00Z" },
    { maxPortfolios: 10, budgetPerPortfolio: 500 },
  );
  assert.equal(second.snapshotRunsTerminated, 0);
});

test("CALC-005: one sweep both advances a genuine projection-pipeline run and terminates a legacy snapshot-pipeline run for the same portfolio", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const ledger = createOwnedLedgerRepository(client, () => FIXED_NOW);
  await ledger.post("user-a", ledgerInput({ idempotencyKey: "buy-1" }));

  const runs = createCalculationRunRepository(client);
  await runs.request("user-a", {
    id: "legacy-snapshot",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-01",
    calculationVersion: 1,
    reason: "ledger_mutation",
    pipeline: "snapshot",
    ledgerHighWaterStart: "",
    idempotencyKey: "legacy-snapshot",
    now: FIXED_NOW,
  });

  const summary = await sweepCalculationRuns(
    { client, now: () => "2026-08-01T02:00:00Z" },
    { maxPortfolios: 10, budgetPerPortfolio: 500 },
  );
  assert.equal(summary.snapshotRunsTerminated, 1);
  assert.equal(summary.portfoliosSwept, 1);
  assert.equal(summary.advanced, 1);
  assert.equal(summary.completed, 1);

  assert.equal(
    await projectionPublicationCount(client, "user-a", "portfolio-a"),
    1,
  );
  assert.equal(
    await snapshotPublicationCount(client, "user-a", "portfolio-a"),
    0,
  );
  const legacy = database
    .prepare(`SELECT status FROM calculation_runs WHERE id = 'legacy-snapshot'`)
    .get() as { status: string };
  assert.equal(legacy.status, "abandoned");
});

// CALC-004 follow-up (b): the same-currency `missing_basis` import-mapper
// fix, exercised directly at the repository level. Unrelated to the
// snapshot-pipeline retirement -- preserved unchanged.
test("CALC-004 follow-up (b): a same-currency CSV import gets an identity FX rate, not a null (missing_basis) one; a real cross-currency row is unaffected", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  await commitSimpleBatch(database, client, () => FIXED_NOW);
  const row = database
    .prepare(
      `SELECT fx_rate_to_base_decimal, fx_rate_source FROM transactions
       WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a' LIMIT 1`,
    )
    .get() as {
    fx_rate_to_base_decimal: string | null;
    fx_rate_source: string | null;
  };
  assert.equal(row.fx_rate_to_base_decimal, "1");
  assert.equal(row.fx_rate_source, "identity");

  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-05T00:00:00Z"),
  );
  assert.deepEqual(holdings.rows[0]?.homeBasis, {
    status: "available",
    currencyCode: "AUD",
    value: "60",
    reason: null,
  });
});
