// CALC-004: drives the historical-snapshot (Overview) pipeline to
// publication alongside the CALC-003 projection pipeline, from the SAME
// triggers, without either pipeline foreclosing the other. These tests
// exercise `app/calculation-executor-service.ts`'s pipeline-scoped
// generalisation and `db/repositories/snapshots.ts`'s
// `resolveSnapshotRunRange`/`computeSnapshotRunRange` end to end against a
// migrated sqlite database -- not the pure snapshot-rebuild mechanics
// already covered by `tests/calc-002-repository.test.ts`.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  advanceCalculationRuns,
  advanceCalculationRunsForCommit,
  POST_COMMIT_CALCULATION_BUDGET,
  POST_COMMIT_SNAPSHOT_CALCULATION_BUDGET,
  READ_TIME_SNAPSHOT_CALCULATION_BUDGET,
} from "../app/calculation-executor-service.ts";
import { loadOwnedHoldings } from "../app/owned-holdings.ts";
import {
  createCalculationRunRepository,
  createHistoricalSnapshotRepository,
  createOwnedImportCommitRepository,
  createOwnedLedgerRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type ImportCommitResult,
  type ImportCommitSuccess,
  type LedgerMutationResult,
  type SqlClient,
} from "../db/repositories/index.ts";
import type { SqlStatement } from "../db/repositories/sql-client.ts";
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

// Mirrors `tests/calc-003.test.ts`'s identical instrumented-client
// technique: counts every real D1 statement (`get`/`all`/`run`, plus every
// statement inside a `batch()` call).
function countingSqlClient(client: SqlClient): {
  wrapped: SqlClient;
  count: () => number;
} {
  let statements = 0;
  const wrapped: SqlClient = {
    async all<T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      statements += 1;
      return client.all<T>(sql, params);
    },
    async get<T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T | undefined> {
      statements += 1;
      return client.get<T>(sql, params);
    },
    async run(sql: string, params?: readonly unknown[]) {
      statements += 1;
      return client.run(sql, params);
    },
    async batch(batchStatements: readonly SqlStatement[]) {
      statements += batchStatements.length;
      return client.batch(batchStatements);
    },
  };
  return { wrapped, count: () => statements };
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

// Stages and commits a small batch of AUD buys (3 x 2 shares @ $10 = 6
// shares / $60 basis), all trading on a single local date, so both the
// projection AND snapshot pipelines have a tiny, deterministic amount of
// work (the snapshot pipeline's date range runs from the earliest trade
// date to `nowOverride`'s LOCAL date -- keeping both on the same day keeps
// the range to exactly one day rather than depending on wall-clock "today").
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

// 2026-08-01T01:00:00Z is 2026-08-01T11:00:00+10:00 in Australia/Sydney
// (no DST in August) -- safely inside the same local calendar date as the
// fixture's trades, so `resolveSnapshotRunRange` requests exactly ONE day
// (2026-08-01 to 2026-08-01), keeping these tests fast and deterministic
// regardless of the real wall-clock date the suite happens to run on.
const FIXED_NOW = "2026-08-01T01:00:00Z";

test("CALC-004 end-to-end: a committed batch drives BOTH the projection and snapshot pipelines to publication, neither foreclosing the other", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const commitResult = await commitSimpleBatch(
    database,
    client,
    () => FIXED_NOW,
  );

  // Nothing executes either queued pipeline yet.
  assert.equal(
    await projectionPublicationCount(client, "user-a", "portfolio-a"),
    0,
  );
  assert.equal(
    await snapshotPublicationCount(client, "user-a", "portfolio-a"),
    0,
  );

  // Trigger 1's exact call shape -- both pipelines' default budgets.
  const results = await advanceCalculationRunsForCommit(
    { client, now: () => FIXED_NOW },
    {
      userId: "user-a",
      calculationRunIds: commitResult.rebuildJobIds,
      budget: POST_COMMIT_CALCULATION_BUDGET,
      snapshotBudget: POST_COMMIT_SNAPSHOT_CALCULATION_BUDGET,
    },
  );
  assert.equal(results.length, 2);
  // results[0] is the projection-pipeline advance, results[1] the
  // snapshot-pipeline advance -- BOTH must complete from the SAME commit,
  // the core structural risk this task's architecture decision addresses
  // (a shared-row model would let whichever pipeline finished first
  // foreclose the other; separate rows must not).
  assert.equal(results[0]?.completed, 1);
  assert.equal(results[1]?.completed, 1);

  assert.equal(
    await projectionPublicationCount(client, "user-a", "portfolio-a"),
    1,
  );
  assert.equal(
    await snapshotPublicationCount(client, "user-a", "portfolio-a"),
    1,
  );

  // Projection pipeline: real quantities/basis (CALC-003's own contract).
  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-05T00:00:00Z"),
  );
  assert.equal(holdings.rows.length, 1);
  assert.equal(holdings.rows[0]?.quantity, "6");

  // Snapshot pipeline: a populated Overview -- publication exists, series
  // covers exactly the requested one-day range, and the fixture math
  // (6 shares, no price observation seeded, no `history_complete_from`
  // attested on the fixture portfolio) surfaces as a real, non-empty,
  // honestly-incomplete point rather than an empty or fabricated series.
  const overview = await createHistoricalSnapshotRepository(
    client,
  ).loadPublishedOverview("user-a", "portfolio-a");
  assert.ok(overview !== null);
  if (overview === null) return;
  assert.equal(overview.current.date, "2026-08-01");
  assert.equal(overview.history.length, 1);
  assert.equal(overview.history[0]?.date, "2026-08-01");
  // No `history_complete_from` marker on the fixture portfolio and no
  // price observation seeded -- `domain/snapshots/history.ts` correctly
  // reports `incomplete` (never a fabricated total), but quantity itself
  // IS known and carried through to the allocation, proving the pipeline
  // ran and published real facts rather than an empty/failed state.
  assert.equal(overview.current.completeness, "incomplete");
  assert.equal(overview.current.totalValueDecimal, null);
  assert.equal(overview.allocation.length, 1);
  assert.equal(overview.allocation[0]?.quantityDecimal, "6");
});

test("CALC-004 budget enforcement (snapshot pipeline): a bounded budget pauses resumably, and a later full-budget invocation completes", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  await commitSimpleBatch(database, client, () => FIXED_NOW);

  const measured = countingSqlClient(client);
  const tiny = await advanceCalculationRuns(
    { client: measured.wrapped, now: () => FIXED_NOW },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "snapshot",
      budget: 5,
    },
  );
  assert.equal(tiny.completed, 0);
  assert.equal(tiny.remaining, true);
  assert.equal(
    await snapshotPublicationCount(client, "user-a", "portfolio-a"),
    0,
  );
  assert.ok(
    measured.count() < 40,
    `expected a tiny budget to overshoot only slightly, measured ${measured.count()}`,
  );

  // A later invocation with the real exported budget completes outright.
  const full = await advanceCalculationRuns(
    { client, now: () => FIXED_NOW },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "snapshot",
      budget: POST_COMMIT_SNAPSHOT_CALCULATION_BUDGET,
    },
  );
  assert.equal(full.completed, 1);
  assert.equal(full.remaining, false);
  assert.equal(
    await snapshotPublicationCount(client, "user-a", "portfolio-a"),
    1,
  );
});

// Mirrors `tests/calc-003.test.ts`'s identical pattern: simulate an
// externally-held live lease via a DIRECT `runs.claim()` call (not a
// budget-starved `advanceCalculationRuns` call -- a run that exhausts its
// budget mid-run RELEASES its lease immediately, per the B5b fix, so it can
// never itself model a genuinely still-held lease across two invocations).
test("CALC-004 lease contention: a snapshot run already claimed by another worker is left untouched", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  await commitSimpleBatch(database, client, () => FIXED_NOW);

  // `commitSimpleBatch` queues MULTIPLE snapshot rows (one per committed
  // row's own `ledger_mutation`, plus `finalize`'s aggregate
  // `import_commit` row -- CALC-003's documented "duplicate per-commit
  // work" quirk, doubled across pipelines) -- the LATEST one (by
  // insertion order) is the only one `hasNewerRun`'s coalescing will ever
  // let complete, so that is the one to contend over.
  const runIdRow = database
    .prepare(
      `SELECT id FROM calculation_runs WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a' AND pipeline = 'snapshot'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get() as { id: string };
  const runs = createCalculationRunRepository(client);
  const externalClaim = await runs.claim(
    "user-a",
    "portfolio-a",
    runIdRow.id,
    "external-worker",
    "2026-08-01T01:05:00Z",
    FIXED_NOW,
  );
  assert.equal(externalClaim.ok, true);

  // A concurrent worker sees the lease still live and claims nothing -- it
  // does not fail, steal, or duplicate the run.
  const loser = await advanceCalculationRuns(
    { client, now: () => FIXED_NOW, leaseOwner: () => "worker-2" },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "snapshot",
      budget: 1000,
    },
  );
  assert.equal(loser.advanced, 0);
  assert.equal(loser.completed, 0);
  assert.equal(loser.remaining, true);

  const run = await client.get<Record<string, unknown>>(
    `SELECT lease_owner, status FROM calculation_runs WHERE id = ?`,
    [runIdRow.id],
  );
  assert.equal(run?.lease_owner, "external-worker");
  assert.equal(run?.status, "running");
});

test("CALC-004 cross-user denial: advancing another user's portfolio id finds nothing claimable for the snapshot pipeline", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  await commitSimpleBatch(database, client, () => FIXED_NOW);

  // user-b has no queued work at all; portfolio-a's real run belongs to
  // user-a and must never be reachable by requesting it under user-b.
  const denied = await advanceCalculationRuns(
    { client, now: () => FIXED_NOW },
    {
      userId: "user-b",
      portfolioId: "portfolio-a",
      pipeline: "snapshot",
      budget: 1000,
    },
  );
  assert.equal(denied.advanced, 0);
  assert.equal(denied.completed, 0);
  assert.equal(
    await snapshotPublicationCount(client, "user-a", "portfolio-a"),
    0,
  );

  // The real owner's advance still succeeds afterwards -- cross-user
  // denial did not corrupt or consume the run.
  const owned = await advanceCalculationRuns(
    { client, now: () => FIXED_NOW },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "snapshot",
      budget: 1000,
    },
  );
  assert.equal(owned.completed, 1);
});

// CALC-004 mirror of CALC-003's B1 regression, exercised through the
// SNAPSHOT pipeline: reversing a NON-LATEST transaction must still advance
// and publish the reversal's effect, never silently stay stale. This
// specifically probes `hasNewerRun`'s pipeline scoping
// (`db/repositories/calculation-runs.ts`) -- the commit above already
// queued a projection run AND a snapshot run for the same portfolio; if
// `hasNewerRun`/`supersedeStaleQueuedRuns` were not pipeline-scoped, the
// snapshot pipeline's own coalescing could be confused by the (unrelated)
// projection pipeline's rows, or vice versa.
test("CALC-004 reversal staleness mirrors CALC-003 for the snapshot pipeline: reversing a non-latest transaction still advances and publishes", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  // Both trades post/queue BEFORE the fixed "now" used below (a realistic
  // "recording past trades today" shape) -- `resolveSnapshotRunRange`'s
  // `rangeTo` is queue-time "today" in the portfolio's timezone, so keeping
  // every queue-time `now()` call within the SAME calendar day
  // (2026-08-01, well after both trade dates) keeps every queued
  // snapshot row's requested range identical and this test's date
  // assertions stable regardless of exactly how many `now()` calls each
  // ledger operation makes internally.
  const ledger = createOwnedLedgerRepository(
    client,
    sequentialNow("2026-08-01T01:00:00Z"),
  );

  const earlier = await ledger.post(
    "user-a",
    ledgerInput({
      quantityDecimal: "5",
      tradeAt: "2026-07-30T01:00:00Z",
      localTradeDate: "2026-07-30",
      idempotencyKey: "buy-early",
    }),
  );
  const earlierId = postedTransactionId(earlier);
  const later = await ledger.post(
    "user-a",
    ledgerInput({
      quantityDecimal: "3",
      tradeAt: "2026-07-31T01:00:00Z",
      localTradeDate: "2026-07-31",
      idempotencyKey: "buy-late",
    }),
  );
  postedTransactionId(later);

  // Drain both pipelines' queues (coalescing correctly skips the
  // now-superseded first run in each pipeline; only the run queued by
  // `later` -- the actual latest -- completes).
  const nowAfterPosts = () => "2026-08-01T02:00:00Z";
  const projectionInitial = await advanceCalculationRuns(
    { client, now: nowAfterPosts },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "projection",
      budget: 100_000,
    },
  );
  assert.equal(projectionInitial.completed, 1);
  const snapshotInitial = await advanceCalculationRuns(
    { client, now: nowAfterPosts },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "snapshot",
      budget: 100_000,
    },
  );
  assert.equal(snapshotInitial.completed, 1);

  let holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-03T00:00:00Z"),
  );
  assert.equal(holdings.rows[0]?.quantity, "8");
  let overview = await createHistoricalSnapshotRepository(
    client,
  ).loadPublishedOverview("user-a", "portfolio-a");
  assert.ok(overview !== null);
  assert.equal(overview?.current.date, "2026-08-01");
  const allocationBefore = overview?.allocation[0]?.quantityDecimal;
  assert.equal(allocationBefore, "8");

  // Reverse the EARLIER (non-latest) transaction.
  const reversal = await ledger.reverse(
    "user-a",
    "portfolio-a",
    earlierId,
    "reverse-early",
    "request-reverse",
  );
  assert.equal(reversal.ok, true);

  const nowAfterReversal = () => "2026-08-01T03:00:00Z";
  const projectionAfter = await advanceCalculationRuns(
    { client, now: nowAfterReversal },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "projection",
      budget: 100_000,
    },
  );
  assert.equal(projectionAfter.completed, 1);
  assert.equal(projectionAfter.remaining, false);
  const snapshotAfter = await advanceCalculationRuns(
    { client, now: nowAfterReversal },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "snapshot",
      budget: 100_000,
    },
  );
  assert.equal(snapshotAfter.completed, 1);
  assert.equal(snapshotAfter.remaining, false);

  holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-03T00:00:00Z"),
  );
  // 5 reversed away, 3 remains -- not the stale "8".
  assert.equal(holdings.rows[0]?.quantity, "3");
  overview = await createHistoricalSnapshotRepository(
    client,
  ).loadPublishedOverview("user-a", "portfolio-a");
  assert.ok(overview !== null);
  assert.equal(overview?.allocation[0]?.quantityDecimal, "3");
});

// CALC-004 review-round B1 fix: a run that transient-fails/never-progresses
// on EVERY claim must not block a portfolio's queue forever -- but the
// backstop must key off CONSECUTIVE ZERO-PROGRESS claims (`stall_count`),
// never the raw `attempt` counter, which also increments on ordinary,
// expected multi-claim resumption (see the companion test below, which
// proves a run legitimately needing far more than the old flawed
// threshold still completes). Simulated directly against the repository by
// hand-advancing `stall_count`/`stall_checkpoint` to stand in for
// `MAX_STALL_CLAIMS - 1` real claim cycles that each observed the
// identical (never-advanced) checkpoint.
test("CALC-004 stall-backstop: a run stuck at an unchanging checkpoint is failed terminally and the queue unblocks for a later run", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const runs = createCalculationRunRepository(client);

  // A run queued normally (checkpoint columns all start at their zero
  // defaults: `0:0:0:0::` per `checkpointFingerprint`), then hand-advanced
  // to stand in for 4 real claims that each observed that SAME
  // never-moved fingerprint -- one more identical observation reaches
  // `MAX_STALL_CLAIMS = 5`.
  await runs.request("user-a", {
    id: "run-poisoned",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-01",
    calculationVersion: 1,
    reason: "ledger_mutation",
    pipeline: "snapshot",
    ledgerHighWaterStart: "nonexistent-transaction-id",
    idempotencyKey: "poisoned-run",
    now: "2026-08-01T00:00:00Z",
  });
  database
    .prepare(
      `UPDATE calculation_runs SET stall_count = 4, stall_checkpoint = '0:0:0:0::' WHERE id = 'run-poisoned'`,
    )
    .run();

  const result = await advanceCalculationRuns(
    { client, now: () => "2026-08-01T01:00:00Z" },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "snapshot",
      budget: 1000,
    },
  );
  assert.equal(result.advanced, 1);
  assert.equal(result.completed, 0);
  assert.equal(result.remaining, false);

  const poisoned = database
    .prepare(
      `SELECT status, failure_category, stall_count FROM calculation_runs WHERE id = 'run-poisoned'`,
    )
    .get() as {
    status: string;
    failure_category: string | null;
    stall_count: number;
  };
  assert.equal(poisoned.status, "failed");
  assert.equal(poisoned.failure_category, "stall_limit_exceeded");
  assert.equal(poisoned.stall_count, 5);

  // The poisoned run's presence did not consume the portfolio's queue
  // permanently -- a fresh, healthy run queued afterwards claims and
  // completes normally.
  await runs.request("user-a", {
    id: "run-healthy",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-01",
    calculationVersion: 1,
    reason: "ledger_mutation",
    pipeline: "snapshot",
    ledgerHighWaterStart: "",
    idempotencyKey: "healthy-run",
    now: "2026-08-01T02:00:00Z",
  });
  const healthy = await advanceCalculationRuns(
    { client, now: () => "2026-08-01T03:00:00Z" },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "snapshot",
      budget: 1000,
    },
  );
  assert.equal(healthy.advanced, 1);
  assert.equal(healthy.completed, 1);
  assert.equal(
    await snapshotPublicationCount(client, "user-a", "portfolio-a"),
    1,
  );
});

// CALC-004 review-round B1 REQUIRED regression (reviewer F1): the whole
// point of `stall_count` (over the flawed `attempt`-counting backstop) is
// that a run legitimately needing MANY MORE than `MAX_STALL_CLAIMS = 5`
// claims -- because it is making real, if slow, forward progress every
// time -- must still complete and publish, never be terminated as
// "poisoned". A 400-day range at the measured ~20-21 statements/day, 1
// security cost needs on the order of ~55-60 read-time-budget
// (150-statement) claims -- comfortably past 20 -- simulating repeated
// visits to the Overview page with no post-commit/cron help at all.
test("CALC-004 stall-backstop does not false-positive: a snapshot range needing far more than 20 claims at the read-time budget still completes and publishes", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const ledger = createOwnedLedgerRepository(
    client,
    () => "2026-08-01T01:00:00Z",
  );
  const posted = await ledger.post(
    "user-a",
    ledgerInput({
      quantityDecimal: "5",
      tradeAt: "2026-08-01T01:00:00Z",
      localTradeDate: "2026-08-01",
      idempotencyKey: "buy-anchor",
    }),
  );
  const transactionId = postedTransactionId(posted);

  const runs = createCalculationRunRepository(client);
  const rangeFrom = "2026-08-01";
  const rangeTo = "2027-09-05"; // 400 days after rangeFrom
  await runs.request("user-a", {
    id: "run-long-range",
    portfolioId: "portfolio-a",
    rangeFrom,
    rangeTo,
    calculationVersion: 1,
    reason: "ledger_mutation",
    pipeline: "snapshot",
    ledgerHighWaterStart: transactionId,
    idempotencyKey: "long-range-run",
    now: "2026-08-01T01:00:00Z",
  });

  let claims = 0;
  let result = await advanceCalculationRuns(
    { client, now: () => "2026-08-01T02:00:00Z" },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      pipeline: "snapshot",
      budget: READ_TIME_SNAPSHOT_CALCULATION_BUDGET,
    },
  );
  claims += 1;
  // Safety cap so a real regression (e.g. the flawed attempt-based
  // backstop reintroduced) fails the test outright instead of looping
  // forever, while comfortably exceeding the expected ~55-60 claims.
  while (result.completed === 0 && claims < 200) {
    result = await advanceCalculationRuns(
      { client, now: () => "2026-08-01T02:00:00Z" },
      {
        userId: "user-a",
        portfolioId: "portfolio-a",
        pipeline: "snapshot",
        budget: READ_TIME_SNAPSHOT_CALCULATION_BUDGET,
      },
    );
    claims += 1;
  }

  console.log(
    `CALC-004 B1 drill: 400-day range completed in ${claims} read-time-budget (${READ_TIME_SNAPSHOT_CALCULATION_BUDGET}-statement) claims`,
  );
  assert.equal(result.completed, 1);
  assert.equal(result.remaining, false);
  assert.ok(
    claims > 20,
    `expected this scenario to genuinely need more than 20 claims (needed ${claims}) -- otherwise this test does not exercise the reviewer-required >20-claim case`,
  );
  const run = database
    .prepare(
      `SELECT status, stall_count FROM calculation_runs WHERE id = 'run-long-range'`,
    )
    .get() as { status: string; stall_count: number };
  assert.equal(run.status, "completed");
  assert.equal(run.stall_count, 0);
  assert.equal(
    await snapshotPublicationCount(client, "user-a", "portfolio-a"),
    1,
  );
});

// CALC-004 follow-up (b): the same-currency `missing_basis` import-mapper
// fix, exercised directly at the repository level (the end-to-end test
// above also exercises it implicitly via `nativeBasis`/`homeBasis`, but
// this isolates the exact fix with a cross-currency control case).
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
