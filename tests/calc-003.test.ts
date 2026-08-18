// CALC-003: production wiring for the CALC-002/LED-002B resumable
// calculation-run machinery. These tests exercise the bounded executor
// (`app/calculation-executor-service.ts`) and its three triggers end to
// end against a migrated sqlite database -- not the pure repository-level
// mechanics already covered by `tests/calc-002-repository.test.ts` and
// `tests/led-002b.test.ts` (this executor reuses those unmodified).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  advanceCalculationRuns,
  advanceCalculationRunsForCommit,
  POST_COMMIT_CALCULATION_BUDGET,
  sweepCalculationRuns,
} from "../app/calculation-executor-service.ts";
import { loadOwnedHoldings } from "../app/owned-holdings.ts";
import {
  createCalculationRunRepository,
  createOwnedImportCommitRepository,
  createOwnedLedgerRepository,
  createOwnedManualOverrideRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type ImportCommitResult,
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

function insertTransaction(
  database: DatabaseSync,
  values: {
    id: string;
    userId?: string;
    portfolioId?: string;
    portfolioSecurityId?: string;
    type: string;
    tradeAt: string;
    quantityDecimal: string;
    unitPriceDecimal: string;
    grossAmountDecimal: string;
    feeAmountDecimal?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO transactions (
        id, user_id, portfolio_id, portfolio_security_id, type, status,
        trade_at, local_trade_date, quantity_decimal, unit_price_decimal,
        currency_code, gross_amount_decimal, fee_amount_decimal,
        tax_amount_decimal, fx_rate_to_base_decimal, source_type,
        created_by_user_id, calculation_version, created_at
      ) VALUES (?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, 'AUD', ?, ?, '0', '1', 'manual', ?, 1, ?)`,
    )
    .run(
      values.id,
      values.userId ?? "user-a",
      values.portfolioId ?? "portfolio-a",
      values.portfolioSecurityId ?? "membership-a",
      values.type,
      values.tradeAt,
      values.tradeAt.slice(0, 10),
      values.quantityDecimal,
      values.unitPriceDecimal,
      values.grossAmountDecimal,
      values.feeAmountDecimal ?? "0",
      values.userId ?? "user-a",
      values.tradeAt,
    );
}

// Mirrors `db/repositories/ledger.ts`'s own queueing convention exactly
// (see its `calculation_runs` INSERT in `buildLedgerPostingStatements`):
// `ledger_high_water_start` is the id of the transaction that was current
// when the run was queued.
async function queueLedgerMutationRun(
  client: SqlClient,
  input: {
    id: string;
    userId?: string;
    portfolioId?: string;
    ledgerHighWater: string;
    localDate: string;
    now: string;
  },
) {
  const runs = createCalculationRunRepository(client);
  return runs.request(input.userId ?? "user-a", {
    id: input.id,
    portfolioId: input.portfolioId ?? "portfolio-a",
    rangeFrom: input.localDate,
    rangeTo: input.localDate,
    calculationVersion: 1,
    reason: "ledger_mutation",
    invalidationSource: input.ledgerHighWater,
    ledgerHighWaterStart: input.ledgerHighWater,
    idempotencyKey: `ledger:${input.id}`,
    now: input.now,
  });
}

// CALC-003 review-round B2 fix: mirrors the reviewer's own instrumented-
// client technique (and `led-002b.test.ts`'s established pattern) --
// counts every real D1 statement (`get`/`all`/`run` calls, plus every
// statement inside a `batch()` call) so the budget tests below measure the
// ACTUAL cost the executor's `countingClient` wrapper also tracks, instead
// of assuming a fixed per-chunk cost.
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

async function publicationCount(
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

test("CALC-003 end-to-end: a committed batch's queued runs are advanced, published, and read back with real quantities/basis", async () => {
  const database = await migratedDatabase();
  database
    .prepare(
      `INSERT INTO import_batches (
         id, user_id, target_portfolio_id, parser_format, parser_version, filename,
         byte_size, file_sha256, status, created_at, updated_at, version
       ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv', ?,
         'sample.csv', 100, 'file-a', 'ready', '2026-08-03T00:00:00Z',
         '2026-08-03T00:00:00Z', 1)`,
    )
    .run(SUPPORTED_IMPORT_PARSER_VERSION);
  const rowInsert = database.prepare(
    `INSERT INTO import_rows (
       id, user_id, batch_id, physical_row_number, row_class,
       original_fields_json, normalized_fields_json, normalized_fingerprint,
       validation_status, target_portfolio_id, target_portfolio_security_id,
       commit_status, created_at, updated_at, version
     ) VALUES (?, 'user-a', 'batch-a', ?, 'transaction', '[]', ?, ?, 'valid',
       'portfolio-a', 'membership-a', 'staged', '2026-08-03', '2026-08-03', 1)`,
  );
  // 3 buys of 2 shares @ $10, zero commission -- 6 shares / $60 basis.
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
    rowInsert.run(
      `row-${index + 1}`,
      rowNumber,
      JSON.stringify(normalized),
      `fingerprint-${index + 1}`,
    );
  }
  const client = createSqliteSqlClient(database);
  const validated = await createOwnedImportCommitRepository(client).validate(
    "user-a",
    "batch-a",
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: 1,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "commit-a",
    confirmation: true,
    requestId: "request-a",
  };
  const commitRepository = createOwnedImportCommitRepository(client);
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
  if (!commitResult.ok) return;
  assert.equal(commitResult.status, "committed");
  assert.equal(commitResult.rebuildJobIds.length, 1);

  // Nothing executes the queued run yet -- this is the CALC-003 bug
  // reproduction (queued forever, never advanced).
  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 0);

  // Trigger 1's exact call shape.
  const results = await advanceCalculationRunsForCommit(
    { client },
    {
      userId: "user-a",
      calculationRunIds: commitResult.rebuildJobIds,
      budget: 50,
    },
  );
  // 2, not the 1 this test asserted pre-CALC-004: `advanceCalculationRunsForCommit`
  // now advances BOTH pipelines (projection, then snapshot) per distinct
  // affected portfolio -- see that function's doc comment. Still exactly 1
  // portfolio here (not the 4 queued runs' worth of results): EVERY
  // committed row's own ledger posting (`db/repositories/ledger.ts`)
  // independently queues its own 'ledger_mutation' run (per pipeline) in
  // addition to `finalize()`'s aggregate 'import_commit' run (per
  // pipeline, `db/repositories/import-commit.ts`) -- pre-existing,
  // out-of-scope-for-this-task behaviour this test documents rather than
  // papers over. `hasNewerRun`'s run-creation-order coalescing (review-round
  // B1 fix, now pipeline-scoped) means only the run with the LATEST
  // `created_at` for the portfolio+pipeline ever completes -- here that's
  // each pipeline's `finalize()` import_commit run, queued after all three
  // individual row postings -- and every older run (the 3 ledger_mutation
  // ones, per pipeline) fails fast as `superseded_by_newer_run` without
  // attempting a rebuild.
  assert.equal(results.length, 2);
  assert.equal(results[0]?.completed, 1); // projection pipeline
  assert.equal(results[0]?.remaining, false);
  // results[1] is the snapshot-pipeline advance -- not asserted further
  // here (this test's date range runs from the fixture's fixed trade date
  // to REAL wall-clock "today", since `commit()` does not take a `now`
  // override, so its completion is environment/date-dependent at this
  // budget). `tests/calc-004.test.ts` exercises the snapshot pipeline's
  // completion/publication deterministically with an overridden `now`.
  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 1);

  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-05T00:00:00Z"),
  );
  assert.equal(holdings.status, "partial"); // no price/FX observations seeded
  assert.equal(holdings.rows.length, 1);
  // The real quantity/native-basis math the executor's published projection
  // carries through to the read side -- 3 committed buys of 2 shares @ $10,
  // zero commission: 6 shares, $60 native cost basis.
  assert.equal(holdings.rows[0]?.quantity, "6");
  assert.deepEqual(holdings.rows[0]?.nativeBasis, {
    status: "available",
    currencyCode: "AUD",
    value: "60",
    reason: null,
  });
  // CALC-004 follow-up (b) fix (was CALC-003's documented gap): home basis
  // now correctly reports the identity-converted "60", not a fabricated
  // fraction and not the old `missing_basis`/`unavailable` state either.
  // Before this fix, `db/repositories/import-commit.ts`'s `resolveInput`
  // never populated `fx_rate_to_base_decimal` for a same-currency row (only
  // `purchaseExchangeRate`-carrying cross-currency rows got one), and
  // `domain/ledger/projections.ts`'s `basisStatus` treats a null FX rate as
  // `incomplete_fx` unconditionally -- so a home-currency CSV import's base
  // basis stayed "not yet known" despite the native cost being fully known.
  // `resolveInput` now sets `fxRate = "1"`/`fxRateSource = "identity"`
  // whenever the row's currency already equals the portfolio's base
  // currency, matching `domain/market-data/selection.ts`'s
  // `selectFxObservation` identity-conversion precedent.
  assert.deepEqual(holdings.rows[0]?.homeBasis, {
    status: "available",
    currencyCode: "AUD",
    value: "60",
    reason: null,
  });
});

// Seeds ONE security with `buyCount` separate buy transactions -- its own
// `tax_lots`/`holding_projections` output is `buyCount` lots + 1 holding,
// which for `buyCount` > `maxOutputStatementsPerChunk` (default 20) spans
// MULTIPLE chunks for this SINGLE security. This is the exact shape the
// CALC-003 review round's B2 finding reproduced: `projections.rebuild`'s
// per-chunk cost is LINEAR in a security's own output-row count (each
// chunk re-pays `buildSecurity`'s full per-security ledger read, not just
// the incremental output), not the flat ~9-statement/chunk figure a
// portfolio where every security finishes in one small chunk would suggest.
async function seedManyLotsSingleSecurity(
  database: DatabaseSync,
  buyCount: number,
): Promise<string> {
  let lastTransactionId = "";
  for (let index = 0; index < buyCount; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const txId = `buy-${suffix}`;
    insertTransaction(database, {
      id: txId,
      type: "buy",
      tradeAt: `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
      quantityDecimal: "1",
      unitPriceDecimal: "10",
      grossAmountDecimal: "10",
    });
    lastTransactionId = txId;
  }
  return lastTransactionId;
}

test("CALC-003 budget enforcement (review-round B2 fix): the budget is spent in real D1 statements, bounds a single security's own multi-chunk output, pauses resumably, and a later invocation with a full budget completes", async () => {
  const BUY_COUNT = 25; // > maxOutputStatementsPerChunk (20): forces 2+ chunks for this one security.

  // First, measure this exact scenario's REAL full-completion statement
  // cost on a throwaway database, with an instrumented client identical to
  // the executor's own -- this is what "budget in statements, not steps"
  // means: the budget below is derived from a MEASURED number, never a
  // guess. (Mirrors the CALC-003 review round's own repro method.)
  const probeDatabase = await migratedDatabase();
  const probeLastId = await seedManyLotsSingleSecurity(
    probeDatabase,
    BUY_COUNT,
  );
  const probeClient = createSqliteSqlClient(probeDatabase);
  await queueLedgerMutationRun(probeClient, {
    id: "run-probe",
    ledgerHighWater: probeLastId,
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  const probe = countingSqlClient(probeClient);
  const probeResult = await advanceCalculationRuns(
    { client: probe.wrapped, now: () => "2026-08-18T00:05:00Z" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 100_000 },
  );
  assert.equal(probeResult.completed, 1);
  const fullStatementCost = probe.count();
  // A meaningful lower bound proving this scenario genuinely spans
  // multiple chunks (a flat ~9-statement/chunk single-output-row model
  // would put a 25-lot security's total near 20-30, not comfortably past
  // one chunk's own ~27-statement worst case) -- the actual regression
  // guard for B2 is the overshoot assertion below, using this measured
  // total to derive a partial budget.
  assert.ok(
    fullStatementCost > 40,
    `expected a multi-chunk statement cost, measured ${fullStatementCost}`,
  );

  // Now the real test: an identically-shaped but FRESH database, given
  // roughly half the measured full cost as its budget.
  const database = await migratedDatabase();
  const lastTransactionId = await seedManyLotsSingleSecurity(
    database,
    BUY_COUNT,
  );
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-budget",
    ledgerHighWater: lastTransactionId,
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });

  const partialBudget = Math.floor(fullStatementCost / 2);
  const t0 = "2026-08-18T00:00:00Z";
  const measured = countingSqlClient(client);
  const first = await advanceCalculationRuns(
    { client: measured.wrapped, now: () => t0, leaseOwner: () => "worker-1" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: partialBudget },
  );
  assert.equal(first.advanced, 1);
  assert.equal(first.completed, 0);
  assert.equal(first.remaining, true);
  // The regression guard: the executor can only overshoot a requested
  // budget by (at most) one rebuild chunk's own worst-case cost -- never
  // the 992-statements-at-a-"budget-50" order-of-magnitude overshoot the
  // review round's repro found when the budget was counted in abstract
  // "steps" instead of real statements.
  assert.ok(
    measured.count() < partialBudget + 40,
    `expected bounded overshoot, budget=${partialBudget} used=${measured.count()}`,
  );

  const midRun = await client.get<Record<string, unknown>>(
    `SELECT status, lease_owner FROM calculation_runs WHERE id = 'run-budget'`,
  );
  assert.equal(midRun?.status, "running");
  assert.equal(midRun?.lease_owner, "worker-1");
  const lotRowsMidRun = await client.all(
    `SELECT id FROM tax_lots WHERE calculation_run_id = 'run-budget'`,
  );
  // Partial progress WITHIN the one security's own output -- some lots
  // flushed, not all `BUY_COUNT` of them, and no holding row yet (that is
  // only written once the security's lots are entirely flushed).
  assert.ok(
    lotRowsMidRun.length > 0 && lotRowsMidRun.length < BUY_COUNT,
    `expected partial lot output, got ${lotRowsMidRun.length} of ${BUY_COUNT}`,
  );

  // Second invocation, 5+ minutes later (past the lease) with a generous
  // budget -- resumes from the persisted cursor and finishes.
  const t1 = "2026-08-18T00:06:00Z";
  const second = await advanceCalculationRuns(
    { client, now: () => t1, leaseOwner: () => "worker-2" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 100_000 },
  );
  assert.equal(second.completed, 1);
  assert.equal(second.remaining, false);
  const lotRowsFinal = await client.all(
    `SELECT id FROM tax_lots WHERE calculation_run_id = 'run-budget'`,
  );
  assert.equal(lotRowsFinal.length, BUY_COUNT);
  const holdingRowsFinal = await client.all(
    `SELECT id FROM holding_projections WHERE calculation_run_id = 'run-budget'`,
  );
  assert.equal(holdingRowsFinal.length, 1);
  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 1);
});

test("CALC-003 exported budget constants keep comfortable headroom under D1's ~1000-statement-per-invocation assumption for the reviewer's reproduced worst-case shape (30 securities x 40 transactions each)", async () => {
  const database = await migratedDatabase();
  const membershipInsert = database.prepare(
    `INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
     VALUES (?, 'user-a', 'portfolio-a', ?, ?, 'AUD', 'held', '2026-08-03', '2026-08-03')`,
  );
  const securityInsert = database.prepare(
    `INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
     VALUES (?, ?, 'equity', 'AUD', 'active', '2026-08-03', '2026-08-03')`,
  );
  let lastTransactionId = "";
  const SECURITY_COUNT = 30;
  const TRANSACTIONS_PER_SECURITY = 40;
  for (let s = 0; s < SECURITY_COUNT; s += 1) {
    const securitySuffix = String(s).padStart(3, "0");
    securityInsert.run(
      `security-${securitySuffix}`,
      `Security ${securitySuffix}`,
    );
    membershipInsert.run(
      `membership-${securitySuffix}`,
      `security-${securitySuffix}`,
      `S${securitySuffix}`,
    );
    for (let t = 0; t < TRANSACTIONS_PER_SECURITY; t += 1) {
      const ordinal = s * TRANSACTIONS_PER_SECURITY + t;
      const txId = `buy-${securitySuffix}-${String(t).padStart(3, "0")}`;
      insertTransaction(database, {
        id: txId,
        portfolioSecurityId: `membership-${securitySuffix}`,
        type: "buy",
        tradeAt: `2026-01-01T${String(Math.floor(ordinal / 60)).padStart(2, "0")}:${String(ordinal % 60).padStart(2, "0")}:00Z`,
        quantityDecimal: "1",
        unitPriceDecimal: "10",
        grossAmountDecimal: "10",
      });
      lastTransactionId = txId;
    }
  }
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-worst-case",
    ledgerHighWater: lastTransactionId,
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });

  const measured = countingSqlClient(client);
  const result = await advanceCalculationRuns(
    { client: measured.wrapped, now: () => "2026-08-18T00:05:00Z" },
    {
      userId: "user-a",
      portfolioId: "portfolio-a",
      budget: POST_COMMIT_CALCULATION_BUDGET,
    },
  );
  // This portfolio is large enough that ONE invocation at the post-commit
  // budget cannot finish it outright (the reviewer's own repro measured
  // ~1800 total statements to fully complete it) -- that is expected and
  // correct: the resumable machinery spreads it across several
  // invocations (this trigger, then the read-time/cron backstop) rather
  // than ever risking one invocation blowing past D1's per-invocation
  // ceiling. The regression guard is that this ONE invocation stays
  // comfortably under 1000 statements.
  assert.equal(result.completed, 0);
  assert.equal(result.remaining, true);
  assert.ok(
    measured.count() < 1000,
    `expected < 1000 statements for one post-commit-budget invocation, measured ${measured.count()}`,
  );
  assert.ok(
    measured.count() < POST_COMMIT_CALCULATION_BUDGET + 40,
    `expected bounded overshoot over the ${POST_COMMIT_CALCULATION_BUDGET} budget, measured ${measured.count()}`,
  );
});

test("CALC-003 lease contention: a run already claimed by another worker is left untouched (loser no-ops)", async () => {
  const database = await migratedDatabase();
  insertTransaction(database, {
    id: "buy-1",
    type: "buy",
    tradeAt: "2026-01-01T00:00:00Z",
    quantityDecimal: "1",
    unitPriceDecimal: "10",
    grossAmountDecimal: "10",
  });
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-contended",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  const runs = createCalculationRunRepository(client);
  const firstClaim = await runs.claim(
    "user-a",
    "portfolio-a",
    "run-contended",
    "external-worker",
    "2026-08-18T00:05:00Z",
    "2026-08-18T00:00:00Z",
  );
  assert.equal(firstClaim.ok, true);

  const result = await advanceCalculationRuns(
    { client, now: () => "2026-08-18T00:00:30Z", leaseOwner: () => "worker-2" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 50 },
  );
  assert.equal(result.advanced, 0);
  assert.equal(result.completed, 0);
  assert.equal(result.remaining, true);

  const run = await client.get<Record<string, unknown>>(
    `SELECT lease_owner, status FROM calculation_runs WHERE id = 'run-contended'`,
  );
  assert.equal(run?.lease_owner, "external-worker");
  assert.equal(run?.status, "running");
});

test("CALC-003 cron sweep advances an abandoned run whose lease has expired", async () => {
  const database = await migratedDatabase();
  insertTransaction(database, {
    id: "buy-1",
    type: "buy",
    tradeAt: "2026-01-01T00:00:00Z",
    quantityDecimal: "1",
    unitPriceDecimal: "10",
    grossAmountDecimal: "10",
  });
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-abandoned",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  const runs = createCalculationRunRepository(client);
  const claimed = await runs.claim(
    "user-a",
    "portfolio-a",
    "run-abandoned",
    "crashed-worker",
    "2026-08-18T00:05:00Z", // lease already in the past relative to the sweep below
    "2026-08-18T00:00:00Z",
  );
  assert.equal(claimed.ok, true);

  const summary = await sweepCalculationRuns(
    { client, now: () => "2026-08-18T01:00:00Z" },
    { maxPortfolios: 10, budgetPerPortfolio: 50 },
  );
  assert.equal(summary.portfoliosSwept, 1);
  assert.equal(summary.completed, 1);
  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 1);
});

test("CALC-003 cross-user denial: advancing another user's portfolio id finds nothing claimable and leaves the real run untouched", async () => {
  const database = await migratedDatabase();
  insertTransaction(database, {
    id: "buy-1",
    type: "buy",
    tradeAt: "2026-01-01T00:00:00Z",
    quantityDecimal: "1",
    unitPriceDecimal: "10",
    grossAmountDecimal: "10",
  });
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-owned",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });

  const result = await advanceCalculationRuns(
    { client },
    { userId: "user-b", portfolioId: "portfolio-a", budget: 50 },
  );
  assert.equal(result.advanced, 0);
  assert.equal(result.completed, 0);
  assert.equal(result.remaining, false);

  const run = await client.get<Record<string, unknown>>(
    `SELECT status FROM calculation_runs WHERE id = 'run-owned'`,
  );
  assert.equal(run?.status, "queued");
});

test("CALC-003 failure path: a poisoned (oversell) run is failed explicitly and reads stay honest", async () => {
  const database = await migratedDatabase();
  // A lone sell with no prior buys can never resolve via FIFO -- an
  // "oversell" the ordinary posting path (`db/repositories/ledger.ts`)
  // would reject, simulating already-corrupted ledger data reaching the
  // calculation layer.
  insertTransaction(database, {
    id: "sell-1",
    type: "sell",
    tradeAt: "2026-01-01T00:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "10",
    grossAmountDecimal: "50",
  });
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-poisoned",
    ledgerHighWater: "sell-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });

  const result = await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 50 },
  );
  assert.equal(result.completed, 0);
  assert.equal(result.remaining, false);

  const run = await client.get<Record<string, unknown>>(
    `SELECT status, failure_category FROM calculation_runs WHERE id = 'run-poisoned'`,
  );
  assert.equal(run?.status, "failed");
  assert.equal(run?.failure_category, "oversell");
  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 0);

  // The read-time trigger (trigger 2) attempts to self-heal but finds
  // nothing claimable (the run is terminally failed) -- the read stays
  // honestly unavailable, never fabricated.
  await assert.rejects(() =>
    loadOwnedHoldings(
      client,
      "user-a",
      "portfolio-a",
      new Date("2026-08-18T02:00:00Z"),
    ),
  );
});

test("CALC-003 read-time trigger: the first owned-holdings read self-heals a queued run in a fresh environment", async () => {
  const database = await migratedDatabase();
  insertTransaction(database, {
    id: "buy-1",
    type: "buy",
    tradeAt: "2026-01-01T00:00:00Z",
    quantityDecimal: "3",
    unitPriceDecimal: "10",
    grossAmountDecimal: "30",
  });
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-read-time",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 0);

  // No trigger 1/3 ever ran -- only reading holdings, exactly like a fresh
  // local dev environment with no cron.
  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-18T02:00:00Z"),
  );
  assert.equal(holdings.rows.length, 1);
  assert.equal(holdings.rows[0]?.quantity, "3");
  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 1);
});

test("CALC-003 coalescing: a superseded run fails fast oldest-first while the current run publishes the full ledger", async () => {
  const database = await migratedDatabase();
  insertTransaction(database, {
    id: "buy-1",
    type: "buy",
    tradeAt: "2026-01-01T00:00:00Z",
    quantityDecimal: "3",
    unitPriceDecimal: "10",
    grossAmountDecimal: "30",
  });
  const client = createSqliteSqlClient(database);
  // The FIRST (older) run's snapshot is already stale by the time a SECOND
  // transaction posts and queues its own, newer run.
  await queueLedgerMutationRun(client, {
    id: "run-old",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  insertTransaction(database, {
    id: "buy-2",
    type: "buy",
    tradeAt: "2026-01-02T00:00:00Z",
    quantityDecimal: "2",
    unitPriceDecimal: "10",
    grossAmountDecimal: "20",
  });
  await queueLedgerMutationRun(client, {
    id: "run-new",
    ledgerHighWater: "buy-2",
    localDate: "2026-01-02",
    now: "2026-08-18T00:01:00Z",
  });

  const result = await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 50 },
  );
  // 1, not 2: the review-round B5a bulk-supersede pre-pass fails the
  // stale, still-`queued` "run-old" in ONE statement before the claim
  // loop even starts (see `supersedeStaleQueuedRuns`) -- it is never
  // individually claimed, so `advanced` only counts "run-new".
  assert.equal(result.advanced, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.remaining, false);

  const oldRun = await client.get<Record<string, unknown>>(
    `SELECT status, failure_category FROM calculation_runs WHERE id = 'run-old'`,
  );
  assert.equal(oldRun?.status, "failed");
  assert.equal(oldRun?.failure_category, "superseded_by_newer_run");
  const newRun = await client.get<Record<string, unknown>>(
    `SELECT status FROM calculation_runs WHERE id = 'run-new'`,
  );
  assert.equal(newRun?.status, "completed");

  const publication = await client.get<Record<string, unknown>>(
    `SELECT calculation_run_id FROM projection_publications WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a'`,
  );
  assert.equal(publication?.calculation_run_id, "run-new");

  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-18T02:00:00Z"),
  );
  // Every run rebuilds the FULL FIFO ledger regardless of its own range --
  // the completed (newer) run's publication reflects BOTH transactions.
  assert.equal(holdings.rows[0]?.quantity, "5");
});

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
    tradeAt: "2026-01-01T00:00:00Z",
    localTradeDate: "2026-01-01",
    settlementDate: "2026-01-03",
    currencyCode: "AUD",
    requestId: "request-default",
    ...overrides,
  };
}

// A strictly increasing `now()` for `createOwnedLedgerRepository`, so
// separate post()/reverse() calls in the same test always queue
// `calculation_runs` rows with distinct, correctly-ordered `created_at`
// values -- matching real wall-clock behaviour (never two ledger
// mutations sharing one instant). A fixed `now()` shared across multiple
// calls would give every queued run the SAME `created_at`, making
// `hasNewerRun`'s tie-break (`id`, a random UUID) decide "which one is
// newer" arbitrarily -- flaky by construction, not a real scenario.
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

// CALC-003 review-round B1 regression (BLOCKING): the reviewer reproduced
// a non-deterministic silent-staleness bug in the original coalescing
// check, which compared a claimed run's `ledgerHighWaterStart` against a
// separately recomputed "current ledger high water"
// (`MAX(transactions.trade_at)`). Reversing a transaction reuses the
// ORIGINAL transaction's `trade_at` -- so reversing a NON-LATEST
// transaction never changes that `MAX(trade_at)` value, permanently
// mismatching the reversal's own queued run and failing it as
// `superseded_by_newer_run` even though nothing genuinely newer existed.
// The fix (`hasNewerRun`, `db/repositories/calculation-runs.ts`) compares
// `calculation_runs` insertion order instead, which the reversal's run
// always wins (it is the latest-QUEUED run, regardless of its trade_at).
test("CALC-003 B1 regression: reversing a NON-LATEST transaction still advances and publishes the reversal, not a silently stale total", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const ledger = createOwnedLedgerRepository(
    client,
    sequentialNow("2026-08-18T00:00:00Z"),
  );

  const earlier = await ledger.post(
    "user-a",
    ledgerInput({
      quantityDecimal: "5",
      tradeAt: "2026-01-01T00:00:00Z",
      localTradeDate: "2026-01-01",
      idempotencyKey: "buy-early",
    }),
  );
  const earlierId = postedTransactionId(earlier);
  const later = await ledger.post(
    "user-a",
    ledgerInput({
      quantityDecimal: "3",
      tradeAt: "2026-01-02T00:00:00Z",
      localTradeDate: "2026-01-02",
      idempotencyKey: "buy-late",
    }),
  );
  postedTransactionId(later);

  // Drain the queue (coalescing correctly skips the now-superseded first
  // run; only the run queued by `later` -- the actual latest -- completes).
  const initial = await advanceCalculationRuns(
    { client, now: () => "2026-08-18T00:10:00Z" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 100_000 },
  );
  assert.equal(initial.completed, 1);
  let holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-18T02:00:00Z"),
  );
  assert.equal(holdings.rows[0]?.quantity, "8");

  // Reverse the EARLIER (non-latest) transaction -- the reversal's own
  // `trade_at` is the ORIGINAL 2026-01-01, still not the portfolio's
  // latest date (2026-01-02, from `later`).
  const reversal = await ledger.reverse(
    "user-a",
    "portfolio-a",
    earlierId,
    "reverse-early",
    "request-reverse",
  );
  assert.equal(reversal.ok, true);

  const afterReversal = await advanceCalculationRuns(
    { client, now: () => "2026-08-18T00:20:00Z" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 100_000 },
  );
  assert.equal(afterReversal.completed, 1);
  assert.equal(afterReversal.remaining, false);

  holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-18T02:00:00Z"),
  );
  // Only `later`'s 3 shares remain -- the reversal is reflected, never
  // silently stuck at the pre-reversal total of 8.
  assert.equal(holdings.rows[0]?.quantity, "3");
});

// CALC-003 review-round B1 regression (BLOCKING), backdated-post variant:
// the same false-positive staleness the reversal case above reproduces,
// but from a genuinely NEW (not reversed) transaction dated earlier than
// the portfolio's existing latest transaction.
test("CALC-003 B1 regression: a backdated post() still advances and its contribution is published, not silently dropped", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const ledger = createOwnedLedgerRepository(
    client,
    sequentialNow("2026-08-18T00:00:00Z"),
  );

  const later = await ledger.post(
    "user-a",
    ledgerInput({
      quantityDecimal: "5",
      tradeAt: "2026-01-05T00:00:00Z",
      localTradeDate: "2026-01-05",
      idempotencyKey: "buy-later-first",
    }),
  );
  postedTransactionId(later);
  const initial = await advanceCalculationRuns(
    { client, now: () => "2026-08-18T00:10:00Z" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 100_000 },
  );
  assert.equal(initial.completed, 1);
  let holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-18T02:00:00Z"),
  );
  assert.equal(holdings.rows[0]?.quantity, "5");

  // A BACKDATED post -- an earlier calendar date than the portfolio's
  // existing latest transaction. Its queued run is the latest-QUEUED run
  // overall (by `calculation_runs` insertion order), but a
  // `MAX(trade_at)`-based "current ledger high water" would still resolve
  // to `later`'s transaction, never matching this backdated run.
  const backdated = await ledger.post(
    "user-a",
    ledgerInput({
      quantityDecimal: "2",
      tradeAt: "2026-01-01T00:00:00Z",
      localTradeDate: "2026-01-01",
      idempotencyKey: "buy-backdated",
    }),
  );
  postedTransactionId(backdated);

  const afterBackdated = await advanceCalculationRuns(
    { client, now: () => "2026-08-18T00:20:00Z" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 100_000 },
  );
  assert.equal(afterBackdated.completed, 1);
  assert.equal(afterBackdated.remaining, false);

  holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-18T02:00:00Z"),
  );
  // The backdated buy's 2 shares are included -- 5 + 2, never silently
  // dropped/stuck at 5.
  assert.equal(holdings.rows[0]?.quantity, "7");
});

// CALC-003 review-round B1-adjacent / B4 regression: `db/repositories/
// market-data.ts`'s manual-override invalidation queues a `calculation_runs`
// row with `ledger_high_water_start = ''` (line ~253) -- pre-B1-fix, these
// sat queued forever. The B1 fix alone made them claim/advance/complete,
// but naively publishing with the run's OWN '' high-water broke every
// subsequent read: `owned-holdings.ts`/`owned-capital-gains.ts` both call
// `requiredText` on the published `ledger_high_water`, which REJECTS an
// empty string -- so saving a single price override on an otherwise-
// healthy portfolio (real transactions, an existing good publication)
// would overwrite that publication with a broken one and render the whole
// portfolio "unavailable", with nothing left claimable to self-heal (the
// reviewer's exact B4 repro). The B4 fix resolves and PERSISTS a real
// transaction id into the run's own `ledger_high_water_start` before
// advancing, so this test seeds a REAL prior transaction (not the trivial
// zero-transaction case, which the earlier version of this test used and
// which the reviewer flagged as locking the broken behaviour in) and reads
// all the way back through `loadOwnedHoldings` to prove it actually works,
// not just that the run's own status flips to `completed`.
test("CALC-003 B4 regression: a manual_override run on a portfolio with real transactions resolves a real high-water, publishes, and reads back through loadOwnedHoldings", async () => {
  const database = await migratedDatabase();
  insertTransaction(database, {
    id: "buy-1",
    type: "buy",
    tradeAt: "2026-01-01T00:00:00Z",
    quantityDecimal: "4",
    unitPriceDecimal: "10",
    grossAmountDecimal: "40",
  });
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-ledger",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  const initial = await advanceCalculationRuns(
    { client, now: () => "2026-08-18T00:05:00Z" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 100_000 },
  );
  assert.equal(initial.completed, 1);
  const beforeOverride = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-18T02:00:00Z"),
  );
  assert.equal(beforeOverride.rows[0]?.quantity, "4");

  const overrides = createOwnedManualOverrideRepository(
    client,
    () => "2026-08-18T00:10:00Z",
  );
  const saved = await overrides.save("user-a", {
    portfolioId: "portfolio-a",
    securityId: "security-a",
    type: "price",
    targetKey: "security-a",
    effectiveFrom: "2026-01-01",
    valueJson: JSON.stringify({ closeDecimal: "10", currencyCode: "AUD" }),
    reason: "manual price correction",
    requestId: "request-override",
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.notEqual(saved.invalidationId, null);

  const queuedRun = await client.get<Record<string, unknown>>(
    `SELECT reason, ledger_high_water_start, status FROM calculation_runs WHERE id = ?`,
    [saved.invalidationId],
  );
  assert.equal(queuedRun?.reason, "manual_override");
  assert.equal(queuedRun?.ledger_high_water_start, "");
  assert.equal(queuedRun?.status, "queued");

  const result = await advanceCalculationRuns(
    { client, now: () => "2026-08-18T00:15:00Z" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 100_000 },
  );
  assert.equal(result.completed, 1);
  assert.equal(result.remaining, false);

  const completedRun = await client.get<Record<string, unknown>>(
    `SELECT status, ledger_high_water_start FROM calculation_runs WHERE id = ?`,
    [saved.invalidationId],
  );
  assert.equal(completedRun?.status, "completed");
  // Resolved to the REAL transaction id, never left as ''.
  assert.equal(completedRun?.ledger_high_water_start, "buy-1");

  const publication = await client.get<Record<string, unknown>>(
    `SELECT ledger_high_water FROM projection_publications WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a'`,
  );
  assert.equal(publication?.ledger_high_water, "buy-1");
  assert.notEqual(publication?.ledger_high_water, "");

  // The actual regression proof: the portfolio reads back successfully,
  // not "unavailable" -- a healthy publication was never overwritten with
  // a broken one.
  const afterOverride = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-18T02:00:00Z"),
  );
  assert.equal(afterOverride.rows[0]?.quantity, "4");
});

// CALC-003 review-round B3 regression: `app/owned-holdings.ts`'s cash
// summation must honestly sum a real (negative) cash balance rather than
// throwing (the adjacent defect this task's first pass fixed via
// `signedSourceDecimal` -- see docs/ARCHITECTURE.md's dated CALC-003 note).
test("CALC-003 B3 regression: a negative cash_ledger_entries.signed_amount_decimal sums into the cash subtotal instead of throwing", async () => {
  const database = await migratedDatabase();
  database.exec(`
    UPDATE portfolio_securities SET status = 'hidden' WHERE id = 'membership-a';
    INSERT INTO cash_accounts (id, user_id, portfolio_id, currency_code, completeness, status)
    VALUES ('cash-a', 'user-a', 'portfolio-a', 'AUD', 'complete', 'active');
    INSERT INTO cash_ledger_entries (
      id, user_id, portfolio_id, cash_account_id, effective_at,
      local_effective_date, type, signed_amount_decimal, status, created_at
    ) VALUES (
      'cash-entry-a', 'user-a', 'portfolio-a', 'cash-a', '2026-08-01T00:00:00Z',
      '2026-08-01', 'cash_withdrawal', '-50', 'posted', '2026-08-01T00:00:00Z'
    );
  `);
  const client = createSqliteSqlClient(database);
  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-05T00:00:00Z"),
  );
  assert.equal(holdings.cash.cashSubtotal, "-50");
});

// CALC-003 review-round B5b regression: budget exhaustion mid-run must
// release the lease (not just leave the run resumable AFTER the full
// `LEASE_DURATION_MS` elapses) so the very next trigger -- e.g. a
// read-time page load moments later -- can claim and continue
// immediately, instead of seeing a cheap no-op for minutes.
test("CALC-003 B5b regression: budget exhaustion mid-run releases the lease so the very next invocation claims immediately", async () => {
  const database = await migratedDatabase();
  const lastTransactionId = await seedManyLotsSingleSecurity(database, 25);
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-release",
    ledgerHighWater: lastTransactionId,
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });

  const t0 = "2026-08-18T00:00:00Z";
  const first = await advanceCalculationRuns(
    { client, now: () => t0, leaseOwner: () => "worker-1" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 30 }, // stops mid-run (see the B2 budget test for why 25 lots needs >1 chunk)
  );
  assert.equal(first.completed, 0);
  assert.equal(first.remaining, true);

  const midRun = await client.get<Record<string, unknown>>(
    `SELECT status, lease_owner, lease_expires_at FROM calculation_runs WHERE id = 'run-release'`,
  );
  assert.equal(midRun?.status, "running");
  assert.equal(midRun?.lease_owner, "worker-1");
  // The lease was RELEASED, not merely left with its original ~5-minute
  // expiry -- its new expiry is no later than the instant it was released.
  assert.ok((midRun?.lease_expires_at as string) <= t0);

  // The very next invocation, at the SAME instant -- no lease wait at all.
  const second = await advanceCalculationRuns(
    { client, now: () => t0, leaseOwner: () => "worker-2" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 100_000 },
  );
  assert.equal(second.advanced, 1);
  assert.equal(second.completed, 1);
  assert.equal(second.remaining, false);
});

// CALC-003 review-round B5c (follow-up) regression: `projections.rebuild`/
// `publish` returning `stale_ledger`/`not_running` does not mean this
// run's OWN computation is poisoned -- it signals something external
// changed the row's state between this invocation's own chunk calls (a
// lease-expiry race, or -- as simulated here -- some other process
// changing the run's status). Marking it terminally `failed` in that case
// would strand an otherwise-healthy run until an unrelated future ledger
// mutation happened to queue a fresh one. This drives a run through its
// FIRST chunk for real, then externally corrupts its status (simulating
// the race) before the invocation's own follow-up chunk call, and asserts
// the executor never overwrites that external state with `failed`.
test("CALC-003 B5c regression: stale_ledger/not_running from rebuild/publish are left resumable, never marked terminally failed", async () => {
  const database = await migratedDatabase();
  // Small enough (6 output rows) that the whole security's output flushes
  // in the FIRST chunk -- the SECOND rebuild() call is the one that would
  // call publish(), which is the call this test intercepts ahead of.
  const lastTransactionId = await seedManyLotsSingleSecurity(database, 5);
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-raced",
    ledgerHighWater: lastTransactionId,
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });

  let batchCalls = 0;
  const faultInjectingClient: SqlClient = {
    all: client.all.bind(client),
    get: client.get.bind(client),
    run: client.run.bind(client),
    async batch(statements: readonly SqlStatement[]) {
      const result = await client.batch(statements);
      batchCalls += 1;
      if (batchCalls === 1) {
        // After the first chunk's checkpoint lands, corrupt status
        // externally -- projections.rebuild's very first check on the
        // NEXT call (`run.status !== "running"`) then returns
        // `not_running`, before ever reaching publish().
        await client.run(
          `UPDATE calculation_runs SET status = 'abandoned' WHERE id = 'run-raced'`,
        );
      }
      return result;
    },
  };

  const result = await advanceCalculationRuns(
    { client: faultInjectingClient, now: () => "2026-08-18T00:05:00Z" },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 100_000 },
  );
  assert.equal(result.completed, 0);

  const run = await client.get<Record<string, unknown>>(
    `SELECT status, failure_category FROM calculation_runs WHERE id = 'run-raced'`,
  );
  // NOT overwritten to 'failed' -- the externally-set state is left
  // exactly as it was, never clobbered with a misleading "this run's own
  // computation failed" terminal category.
  assert.equal(run?.status, "abandoned");
  assert.equal(run?.failure_category, null);
});

// CALC-003 review-round B5 (headline) regression: the ORIGINAL bug report
// ("Holdings/Overview empty after a real committed import") must actually
// be fixed at the owner's real scale, not just for the toy 1-3-row
// fixtures the first review round's end-to-end test used. A realistic
// import commits ONE `ledger_mutation` run PER committed row (100+ for a
// real batch) in addition to the aggregate `import_commit` run --
// superseding each individually would burn the whole post-commit budget
// on bookkeeping before ever reaching the run that matters (the B5 bug).
// This drives 120 rows across 12 distinct securities through the REAL
// commit machinery, advances with EXACTLY the production post-commit
// budget in ONE call (mirroring `app/import-commit-actions.ts`'s/
// `app/import-accept-service.ts`'s trigger 1 wiring), and asserts the
// portfolio is fully readable THE MOMENT that one call returns -- not
// after additional reads/invocations.
test("CALC-003 B5 regression: accepting 120 committed rows across 12 securities converges to readable holdings within ONE post-commit-budget invocation", async () => {
  const database = await migratedDatabase();
  // The base fixture's own `membership-a` is unrelated to this scenario --
  // hide it so `heldCount`/`holdings.rows` reflect only the 12 securities
  // this test actually commits rows for.
  database.exec(
    `UPDATE portfolio_securities SET status = 'hidden' WHERE id = 'membership-a';`,
  );
  const SECURITY_COUNT = 12;
  const ROWS_PER_SECURITY = 10;
  const membershipInsert = database.prepare(
    `INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
     VALUES (?, 'user-a', 'portfolio-a', ?, ?, 'AUD', 'held', '2026-08-03', '2026-08-03')`,
  );
  const securityInsert = database.prepare(
    `INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
     VALUES (?, ?, 'equity', 'AUD', 'active', '2026-08-03', '2026-08-03')`,
  );
  database
    .prepare(
      `INSERT INTO import_batches (
         id, user_id, target_portfolio_id, parser_format, parser_version, filename,
         byte_size, file_sha256, status, created_at, updated_at, version
       ) VALUES ('batch-large', 'user-a', 'portfolio-a', 'strict-versioned-csv', ?,
         'sample.csv', 100, 'file-large', 'ready', '2026-08-03T00:00:00Z',
         '2026-08-03T00:00:00Z', 1)`,
    )
    .run(SUPPORTED_IMPORT_PARSER_VERSION);
  const rowInsert = database.prepare(
    `INSERT INTO import_rows (
       id, user_id, batch_id, physical_row_number, row_class,
       original_fields_json, normalized_fields_json, normalized_fingerprint,
       validation_status, target_portfolio_id, target_portfolio_security_id,
       commit_status, created_at, updated_at, version
     ) VALUES (?, 'user-a', 'batch-large', ?, 'transaction', '[]', ?, ?, 'valid',
       'portfolio-a', ?, 'staged', '2026-08-03', '2026-08-03', 1)`,
  );
  let physicalRow = 2;
  for (let s = 0; s < SECURITY_COUNT; s += 1) {
    const securitySuffix = String(s).padStart(3, "0");
    securityInsert.run(
      `security-large-${securitySuffix}`,
      `Security ${securitySuffix}`,
    );
    membershipInsert.run(
      `membership-large-${securitySuffix}`,
      `security-large-${securitySuffix}`,
      `S${securitySuffix}`,
    );
    for (let r = 0; r < ROWS_PER_SECURITY; r += 1) {
      const ordinal = s * ROWS_PER_SECURITY + r;
      const normalized = {
        id: `source-${securitySuffix}-${r}`,
        symbol: `S${securitySuffix}`,
        name: `Security ${securitySuffix}`,
        displaySymbol: null,
        exchange: "ASX",
        portfolio: "Main",
        currency: "AUD",
        sharesOwned: "1",
        costPerShare: "10",
        commission: "0",
        transactionDate: "2026-08-01 GMT+1000",
        transactionTime: `${String(Math.floor(ordinal / 60)).padStart(2, "0")}:${String(ordinal % 60).padStart(2, "0")}:00`,
        purchaseExchangeRate: null,
        type: "buy",
        accounting: "fifo",
        accountingExecutionIds: null,
        notes: null,
        tradeAtUtc: `2026-08-01T${String(Math.floor(ordinal / 60)).padStart(2, "0")}:${String(ordinal % 60).padStart(2, "0")}:00.000Z`,
        localTradeDate: "2026-08-01",
        cashEvent: null,
      };
      rowInsert.run(
        `row-${securitySuffix}-${r}`,
        physicalRow,
        JSON.stringify(normalized),
        `fingerprint-${securitySuffix}-${r}`,
        `membership-large-${securitySuffix}`,
      );
      physicalRow += 1;
    }
  }

  const client = createSqliteSqlClient(database);
  const validated = await createOwnedImportCommitRepository(client).validate(
    "user-a",
    "batch-large",
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: 1,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "commit-large",
    confirmation: true,
    requestId: "request-large",
  };
  const commitRepository = createOwnedImportCommitRepository(client);
  let commitResult: ImportCommitResult = await commitRepository.commit(
    "user-a",
    "batch-large",
    commitInput,
  );
  for (
    let attempt = 0;
    attempt < 200 && (!commitResult.ok || commitResult.status !== "committed");
    attempt += 1
  ) {
    assert.equal(commitResult.ok, true);
    commitResult = await commitRepository.commit(
      "user-a",
      "batch-large",
      commitInput,
    );
  }
  assert.equal(commitResult.ok, true);
  if (!commitResult.ok) return;
  assert.equal(commitResult.status, "committed");
  assert.equal(commitResult.committedRows, SECURITY_COUNT * ROWS_PER_SECURITY);

  // Trigger 1's exact shape, ONE call, the exact production budget --
  // this is "the accept flow returning": nothing after this point advances
  // any further before the assertions below.
  const measured = countingSqlClient(client);
  const results = await advanceCalculationRunsForCommit(
    { client: measured.wrapped },
    {
      userId: "user-a",
      calculationRunIds: commitResult.rebuildJobIds,
      budget: POST_COMMIT_CALCULATION_BUDGET,
    },
  );
  // 2, not the 1 this test asserted pre-CALC-004 -- results[0] is the
  // projection-pipeline advance (asserted below, unchanged); results[1] is
  // the snapshot-pipeline advance, not asserted further here (its date
  // range runs to real wall-clock "today", so completion at this budget is
  // environment/date-dependent -- `tests/calc-004.test.ts` exercises the
  // snapshot pipeline's completion deterministically with an overridden
  // `now`). The combined-statement assertion below DOES include both
  // pipelines' real cost, confirming one synchronous post-commit request
  // for both pipelines together still stays under D1's ceiling.
  assert.equal(results.length, 2);
  assert.equal(results[0]?.completed, 1);
  assert.equal(results[0]?.remaining, false);
  assert.ok(
    measured.count() < 1000,
    `expected < 1000 statements, measured ${measured.count()}`,
  );

  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 1);
  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-05T00:00:00Z"),
  );
  assert.equal(holdings.rows.length, SECURITY_COUNT);
  for (const row of holdings.rows) {
    assert.equal(row.quantity, String(ROWS_PER_SECURITY));
  }
});
