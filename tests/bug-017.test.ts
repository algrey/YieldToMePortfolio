// BUG-017: `loadOwnedHoldings`/`loadOwnedCapitalGains` validated a
// projection publication for INTERNAL consistency only (run completed,
// version match, ledger-high-water match) -- never whether the ledger has
// moved PAST it. A ledger post/import commit/reversal queues a
// `calculation_runs` row; if nothing advances it (post-commit budget
// exhausted, the run `failed`, cron down) the publication silently served
// stale figures with no signal. This suite pins the fix: a zero-extra-
// statement pending check folded into the SAME publication query, a
// bounded read-time self-heal for "queued"/"running" only, and a distinct
// "failed" honesty state for a terminally-failed newer run nothing will
// retry -- see `app/owned-holdings-contract.ts`'s `ProjectionPendingState`
// doc comment and `app/owned-holdings.ts`'s `PENDING_RUN_STATUS_SUBQUERY`
// for the full design.
//
// Backend fixtures/helpers mirror `tests/calc-003.test.ts`'s established
// pattern (`migratedDatabase`/`insertTransaction`/`queueLedgerMutationRun`)
// exactly, duplicated locally since those helpers are module-private
// there.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { advanceCalculationRuns } from "../app/calculation-executor-service.ts";
import { loadOwnedHoldings } from "../app/owned-holdings.ts";
import { loadOwnedCapitalGains } from "../app/owned-capital-gains.ts";
import {
  createCalculationRunRepository,
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";

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
      ) VALUES (?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, 'AUD', ?, '0', '0', '1', 'manual', ?, 1, ?)`,
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
      values.userId ?? "user-a",
      values.tradeAt,
    );
}

// Mirrors `tests/calc-003.test.ts`'s own helper of the same name exactly.
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

// ---------------------------------------------------------------------------
// (a) queued run + existing publication -> self-heal runs, completes, flag
//     clears, figures reflect the new ledger.
// ---------------------------------------------------------------------------

test("BUG-017 (a): a queued newer run self-heals inside a single loadOwnedHoldings call and the pending flag clears", async () => {
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
    id: "run-1",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  const first = await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );
  assert.equal(first.completed, 1);
  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 1);

  // The exact BUG-017 scenario: a second ledger mutation queues a fresh
  // run, but nothing (no trigger 1/3) ever advances it before the read.
  insertTransaction(database, {
    id: "buy-2",
    type: "buy",
    tradeAt: "2026-01-02T00:00:00Z",
    quantityDecimal: "4",
    unitPriceDecimal: "10",
    grossAmountDecimal: "40",
  });
  await queueLedgerMutationRun(client, {
    id: "run-2",
    ledgerHighWater: "buy-2",
    localDate: "2026-01-02",
    now: "2026-08-19T00:00:00Z",
  });

  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-19T02:00:00Z"),
  );
  assert.deepEqual(holdings.projectionPending, { pending: false });
  assert.equal(holdings.rows[0]?.quantity, "7");
  // Still exactly one publication row -- the self-heal republished IN
  // PLACE, not a second row.
  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 1);
});

// ---------------------------------------------------------------------------
// (b) queued/running + self-heal makes no progress (lease held by another
//     worker) -> flag stays true, existing publication still served, no
//     throw.
// ---------------------------------------------------------------------------

test("BUG-017 (b): a running run whose lease is held by another worker leaves the flag pending, serves the existing publication, and never throws", async () => {
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
    id: "run-1",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );

  insertTransaction(database, {
    id: "buy-2",
    type: "buy",
    tradeAt: "2026-01-02T00:00:00Z",
    quantityDecimal: "4",
    unitPriceDecimal: "10",
    grossAmountDecimal: "40",
  });
  await queueLedgerMutationRun(client, {
    id: "run-2",
    ledgerHighWater: "buy-2",
    localDate: "2026-01-02",
    now: "2026-08-19T00:00:00Z",
  });
  // Simulate a concurrent invocation already holding run-2's lease,
  // unexpired -- `nextClaimable` only reclaims a `running` row once its
  // lease has expired, so this self-heal attempt can make zero progress.
  database.exec(`
    UPDATE calculation_runs SET status = 'running', lease_owner = 'other-worker',
      lease_expires_at = '2026-08-19T03:00:00Z'
    WHERE id = 'run-2'
  `);

  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-19T02:00:00Z"),
  );
  assert.deepEqual(holdings.projectionPending, {
    pending: true,
    reason: "running",
  });
  // The EXISTING (run-1) publication is still served -- honest but stale.
  assert.equal(holdings.rows[0]?.quantity, "3");

  const run = await client.get<Record<string, unknown>>(
    `SELECT status, lease_owner FROM calculation_runs WHERE id = 'run-2'`,
  );
  assert.equal(run?.status, "running");
  assert.equal(run?.lease_owner, "other-worker");
});

// ---------------------------------------------------------------------------
// (c) a terminally-failed run (not superseded) is a DISTINCT "failed"
//     state, and self-heal is never attempted for it.
// ---------------------------------------------------------------------------

test("BUG-017 (c): a terminally-failed newer run is a distinct 'failed' pending reason and self-heal is never attempted for it", async () => {
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
    id: "run-1",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );

  insertTransaction(database, {
    id: "buy-2",
    type: "buy",
    tradeAt: "2026-01-02T00:00:00Z",
    quantityDecimal: "4",
    unitPriceDecimal: "10",
    grossAmountDecimal: "40",
  });
  await queueLedgerMutationRun(client, {
    id: "run-2",
    ledgerHighWater: "buy-2",
    localDate: "2026-01-02",
    now: "2026-08-19T00:00:00Z",
  });
  // A genuinely poisoned run the executor already gave up on (mirrors
  // `db/repositories/calculation-runs.ts`'s `fail()` terminal outcome) --
  // nothing will ever retry it short of a fresh ledger mutation queuing an
  // entirely new run.
  database.exec(`
    UPDATE calculation_runs SET status = 'failed', failure_category = 'oversell', attempt = 3
    WHERE id = 'run-2'
  `);

  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-19T02:00:00Z"),
  );
  assert.deepEqual(holdings.projectionPending, {
    pending: true,
    reason: "failed",
  });
  assert.equal(holdings.rows[0]?.quantity, "3");

  // `attempt` only ever increments on a real `claim()` -- unchanged proves
  // self-heal never even tried to claim this run.
  const run = await client.get<Record<string, unknown>>(
    `SELECT attempt FROM calculation_runs WHERE id = 'run-2'`,
  );
  assert.equal(run?.attempt, 3);
});

// ---------------------------------------------------------------------------
// A superseded (not genuinely failed) older run must never taint
// `projectionPending` once the run that superseded it has published --
// the exact case the `failure_category <> 'superseded_by_newer_run'`
// exclusion exists for.
// ---------------------------------------------------------------------------

test("BUG-017: a run superseded by a newer, now-published run is excluded -- it never masks the portfolio as permanently 'failed'", async () => {
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

  // Mirrors "CALC-003 coalescing": one invocation supersedes run-old and
  // completes+publishes run-new.
  await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );
  const oldRun = await client.get<Record<string, unknown>>(
    `SELECT status, failure_category FROM calculation_runs WHERE id = 'run-old'`,
  );
  assert.equal(oldRun?.status, "failed");
  assert.equal(oldRun?.failure_category, "superseded_by_newer_run");

  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-18T02:00:00Z"),
  );
  assert.deepEqual(holdings.projectionPending, { pending: false });
  assert.equal(holdings.rows[0]?.quantity, "5");
});

// ---------------------------------------------------------------------------
// Round 2 (review B1, BLOCKING): the round-1 candidate set never compared
// a candidate run against the PUBLISHED run -- only against its own
// status -- so a terminally failed OLD run kept masking a fully current
// portfolio as "recalculation failed" forever, even after a LATER run
// completed and published. Reviewer-reproduced sequence, pinned here:
// run-1 completed -> run-2 failed (`oversell`) -> run-3 queued, advanced,
// completed and published. Covers BOTH directions the fix must get right:
// while run-2's failure is still the newest terminal state, the flag must
// correctly report pending/failed (the fix must not swallow a genuine
// newer failure); once run-3 completes and publishes, the flag must clear
// (the fix must stop a stale older failure from masking a newer success).
// ---------------------------------------------------------------------------

test("BUG-017 B1 regression: a terminally-failed run is excluded once a LATER run completes and publishes, but still reports pending/failed beforehand", async () => {
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
    id: "run-1",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );
  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 1);

  // A genuinely poisoned run, newer than the published run-1.
  insertTransaction(database, {
    id: "buy-2",
    type: "buy",
    tradeAt: "2026-01-02T00:00:00Z",
    quantityDecimal: "4",
    unitPriceDecimal: "10",
    grossAmountDecimal: "40",
  });
  await queueLedgerMutationRun(client, {
    id: "run-2",
    ledgerHighWater: "buy-2",
    localDate: "2026-01-02",
    now: "2026-08-19T00:00:00Z",
  });
  database.exec(`
    UPDATE calculation_runs SET status = 'failed', failure_category = 'oversell', attempt = 3
    WHERE id = 'run-2'
  `);

  // (inverse direction) While run-2's failure is the newest terminal
  // state and nothing newer has published, the flag must still say so --
  // the fix must not over-correct into silently ignoring a genuine
  // pending failure.
  const stillFailed = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-19T02:00:00Z"),
  );
  assert.deepEqual(stillFailed.projectionPending, {
    pending: true,
    reason: "failed",
  });

  // A THIRD, later ledger mutation queues a fresh run; it is claimable
  // and unrelated to run-2's poisoned state, so a self-heal (or an
  // explicit advance, as here, mirroring "cron eventually runs") carries
  // it to completion and publication.
  insertTransaction(database, {
    id: "buy-3",
    type: "buy",
    tradeAt: "2026-01-03T00:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "10",
    grossAmountDecimal: "50",
  });
  await queueLedgerMutationRun(client, {
    id: "run-3",
    ledgerHighWater: "buy-3",
    localDate: "2026-01-03",
    now: "2026-08-20T00:00:00Z",
  });
  const third = await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );
  assert.equal(third.completed, 1);
  assert.equal(await publicationCount(client, "user-a", "portfolio-a"), 1);

  // (main B1 fix) run-3 is now the published run; run-2's stale terminal
  // failure -- OLDER than the now-published run -- must no longer surface
  // at all. Before the fix this stayed `{ pending: true, reason: "failed"
  // }` forever, on a fully current portfolio.
  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-20T02:00:00Z"),
  );
  assert.deepEqual(holdings.projectionPending, { pending: false });
  assert.equal(holdings.rows[0]?.quantity, "12");
});

// ---------------------------------------------------------------------------
// (f) ownership: another owner's queued run never flags this owner's
//     portfolio.
// ---------------------------------------------------------------------------

test("BUG-017 (f): another user's queued run never flags this user's own up-to-date portfolio as pending", async () => {
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
    id: "run-1",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );

  // A different user/portfolio's own queued run, created AFTER user-a's
  // publication -- must never leak across the ownership boundary.
  await queueLedgerMutationRun(client, {
    id: "run-other-owner",
    userId: "user-b",
    portfolioId: "portfolio-b",
    ledgerHighWater: "unrelated-tx",
    localDate: "2026-01-05",
    now: "2026-08-20T00:00:00Z",
  });

  const holdings = await loadOwnedHoldings(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-20T02:00:00Z"),
  );
  assert.deepEqual(holdings.projectionPending, { pending: false });
});

// ---------------------------------------------------------------------------
// F2 (TASKS.md Risks line: "a run permanently stuck ... log it"): a
// warn-level structured log fires exactly once, carrying the pending run's
// own identity for diagnosis, whenever a read ends up serving a
// possibly-stale publication. Uses the SAME console.log capture pattern
// `tests/imp-003b.test.ts` established for `emitStructuredLog`'s default
// sink (monkey-patch, collect, restore in `finally`).
// ---------------------------------------------------------------------------

test("BUG-017 F2: a terminally-failed pending state emits one warn-level structured log naming the stuck run", async () => {
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
    id: "run-1",
    ledgerHighWater: "buy-1",
    localDate: "2026-01-01",
    now: "2026-08-18T00:00:00Z",
  });
  await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );
  insertTransaction(database, {
    id: "buy-2",
    type: "buy",
    tradeAt: "2026-01-02T00:00:00Z",
    quantityDecimal: "4",
    unitPriceDecimal: "10",
    grossAmountDecimal: "40",
  });
  await queueLedgerMutationRun(client, {
    id: "run-2",
    ledgerHighWater: "buy-2",
    localDate: "2026-01-02",
    now: "2026-08-19T00:00:00Z",
  });
  database.exec(`
    UPDATE calculation_runs SET status = 'failed', failure_category = 'oversell', attempt = 3
    WHERE id = 'run-2'
  `);

  const logLines: string[] = [];
  const originalLog = console.log;
  console.log = (line: unknown) => {
    logLines.push(String(line));
  };
  try {
    await loadOwnedHoldings(
      client,
      "user-a",
      "portfolio-a",
      new Date("2026-08-19T02:00:00Z"),
    );
  } finally {
    console.log = originalLog;
  }

  const stuckLines = logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.action === "owned_holdings.stuck");
  assert.equal(stuckLines.length, 1);
  const event = stuckLines[0]!;
  assert.equal(event.level, "warn");
  assert.equal(event.event, "projection.pending");
  assert.equal(event.result, "failure");
  const metadata = event.metadata as Record<string, unknown>;
  // `portfolioId` is redacted by `domain/observability/redaction.ts`'s
  // `SENSITIVE_KEY` pattern before it reaches the sink -- this is the same
  // app-wide behaviour every other structured log already gets, not a gap
  // in this log call.
  assert.equal(metadata.portfolioId, "[REDACTED]");
  assert.equal(metadata.reason, "failed");
  assert.equal(metadata.pendingRunId, "run-2");
  assert.equal(metadata.pendingRunStatus, "failed");
  assert.equal(metadata.pendingRunFailureCategory, "oversell");
});

// ---------------------------------------------------------------------------
// Parity: `owned-capital-gains.ts` shares the identical mechanism (self-
// heal for queued/running, distinct "failed" for terminal, ownership
// scoped by the same subquery).
// ---------------------------------------------------------------------------

test("BUG-017 parity (owned-capital-gains): a queued newer run self-heals inside loadOwnedCapitalGains and the flag clears", async () => {
  const database = await migratedDatabase();
  insertTransaction(database, {
    id: "buy-1",
    type: "buy",
    tradeAt: "2024-01-01T00:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "sell-1",
    type: "sell",
    tradeAt: "2026-01-15T00:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-1",
    ledgerHighWater: "sell-1",
    localDate: "2026-01-15",
    now: "2026-08-18T00:00:00Z",
  });
  const first = await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );
  assert.equal(first.completed, 1);

  const beforeSecondSell = await loadOwnedCapitalGains(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-18T02:00:00Z"),
  );
  assert.deepEqual(beforeSecondSell.projectionPending, { pending: false });
  assert.equal(beforeSecondSell.disposalCount, 1);

  // A second disposal queues a fresh run; nothing advances it before the
  // read.
  insertTransaction(database, {
    id: "sell-2",
    type: "sell",
    tradeAt: "2026-02-01T00:00:00Z",
    quantityDecimal: "3",
    unitPriceDecimal: "25",
    grossAmountDecimal: "75",
  });
  await queueLedgerMutationRun(client, {
    id: "run-2",
    ledgerHighWater: "sell-2",
    localDate: "2026-02-01",
    now: "2026-08-19T00:00:00Z",
  });

  const history = await loadOwnedCapitalGains(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-19T02:00:00Z"),
  );
  assert.deepEqual(history.projectionPending, { pending: false });
  assert.equal(history.disposalCount, 2);
});

test("BUG-017 parity (owned-capital-gains): a terminally-failed newer run is a distinct 'failed' reason, existing disposals still served, never thrown", async () => {
  const database = await migratedDatabase();
  insertTransaction(database, {
    id: "buy-1",
    type: "buy",
    tradeAt: "2024-01-01T00:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "sell-1",
    type: "sell",
    tradeAt: "2026-01-15T00:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-1",
    ledgerHighWater: "sell-1",
    localDate: "2026-01-15",
    now: "2026-08-18T00:00:00Z",
  });
  await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );

  insertTransaction(database, {
    id: "sell-2",
    type: "sell",
    tradeAt: "2026-02-01T00:00:00Z",
    quantityDecimal: "3",
    unitPriceDecimal: "25",
    grossAmountDecimal: "75",
  });
  await queueLedgerMutationRun(client, {
    id: "run-2",
    ledgerHighWater: "sell-2",
    localDate: "2026-02-01",
    now: "2026-08-19T00:00:00Z",
  });
  database.exec(`
    UPDATE calculation_runs SET status = 'failed', failure_category = 'oversell', attempt = 2
    WHERE id = 'run-2'
  `);

  const history = await loadOwnedCapitalGains(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-19T02:00:00Z"),
  );
  assert.deepEqual(history.projectionPending, {
    pending: true,
    reason: "failed",
  });
  assert.equal(history.disposalCount, 1);

  const run = await client.get<Record<string, unknown>>(
    `SELECT attempt FROM calculation_runs WHERE id = 'run-2'`,
  );
  assert.equal(run?.attempt, 2);
});

test("BUG-017 B1 regression parity (owned-capital-gains): a terminally-failed run is excluded once a LATER run completes and publishes, but still reports pending/failed beforehand", async () => {
  const database = await migratedDatabase();
  insertTransaction(database, {
    id: "buy-1",
    type: "buy",
    tradeAt: "2024-01-01T00:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "sell-1",
    type: "sell",
    tradeAt: "2026-01-15T00:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-1",
    ledgerHighWater: "sell-1",
    localDate: "2026-01-15",
    now: "2026-08-18T00:00:00Z",
  });
  await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );

  insertTransaction(database, {
    id: "sell-2",
    type: "sell",
    tradeAt: "2026-02-01T00:00:00Z",
    quantityDecimal: "3",
    unitPriceDecimal: "25",
    grossAmountDecimal: "75",
  });
  await queueLedgerMutationRun(client, {
    id: "run-2",
    ledgerHighWater: "sell-2",
    localDate: "2026-02-01",
    now: "2026-08-19T00:00:00Z",
  });
  database.exec(`
    UPDATE calculation_runs SET status = 'failed', failure_category = 'oversell', attempt = 2
    WHERE id = 'run-2'
  `);

  // (inverse direction) still the newest terminal state -- must still
  // report pending/failed.
  const stillFailed = await loadOwnedCapitalGains(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-19T02:00:00Z"),
  );
  assert.deepEqual(stillFailed.projectionPending, {
    pending: true,
    reason: "failed",
  });

  // A later, unrelated disposal queues a fresh run that completes and
  // publishes.
  insertTransaction(database, {
    id: "sell-3",
    type: "sell",
    tradeAt: "2026-03-01T00:00:00Z",
    quantityDecimal: "2",
    unitPriceDecimal: "30",
    grossAmountDecimal: "60",
  });
  await queueLedgerMutationRun(client, {
    id: "run-3",
    ledgerHighWater: "sell-3",
    localDate: "2026-03-01",
    now: "2026-08-20T00:00:00Z",
  });
  const third = await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );
  assert.equal(third.completed, 1);

  // (main B1 fix) run-3 is now published; run-2's stale terminal failure
  // -- older than the now-published run -- must no longer surface.
  const history = await loadOwnedCapitalGains(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-20T02:00:00Z"),
  );
  assert.deepEqual(history.projectionPending, { pending: false });
  assert.equal(history.disposalCount, 3);
});

test("BUG-017 F2 parity (owned-capital-gains): a terminally-failed pending state emits one warn-level structured log naming the stuck run", async () => {
  const database = await migratedDatabase();
  insertTransaction(database, {
    id: "buy-1",
    type: "buy",
    tradeAt: "2024-01-01T00:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "10",
    grossAmountDecimal: "100",
  });
  insertTransaction(database, {
    id: "sell-1",
    type: "sell",
    tradeAt: "2026-01-15T00:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "20",
    grossAmountDecimal: "100",
  });
  const client = createSqliteSqlClient(database);
  await queueLedgerMutationRun(client, {
    id: "run-1",
    ledgerHighWater: "sell-1",
    localDate: "2026-01-15",
    now: "2026-08-18T00:00:00Z",
  });
  await advanceCalculationRuns(
    { client },
    { userId: "user-a", portfolioId: "portfolio-a", budget: 200 },
  );
  insertTransaction(database, {
    id: "sell-2",
    type: "sell",
    tradeAt: "2026-02-01T00:00:00Z",
    quantityDecimal: "3",
    unitPriceDecimal: "25",
    grossAmountDecimal: "75",
  });
  await queueLedgerMutationRun(client, {
    id: "run-2",
    ledgerHighWater: "sell-2",
    localDate: "2026-02-01",
    now: "2026-08-19T00:00:00Z",
  });
  database.exec(`
    UPDATE calculation_runs SET status = 'failed', failure_category = 'oversell', attempt = 2
    WHERE id = 'run-2'
  `);

  const logLines: string[] = [];
  const originalLog = console.log;
  console.log = (line: unknown) => {
    logLines.push(String(line));
  };
  try {
    await loadOwnedCapitalGains(
      client,
      "user-a",
      "portfolio-a",
      new Date("2026-08-19T02:00:00Z"),
    );
  } finally {
    console.log = originalLog;
  }

  const stuckLines = logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.action === "owned_capital_gains.stuck");
  assert.equal(stuckLines.length, 1);
  const metadata = stuckLines[0]!.metadata as Record<string, unknown>;
  assert.equal(metadata.reason, "failed");
  assert.equal(metadata.pendingRunId, "run-2");
  assert.equal(metadata.pendingRunFailureCategory, "oversell");
});

// ---------------------------------------------------------------------------
// (e) rendered markup: the honest status line appears only when the flag
//     is set, on all three named surfaces (Holdings, Overview, Capital
//     gains). Uses the same `tsx`-loader child-process render trick
//     `tests/ui-047.test.ts`/`tests/ui-032.test.ts`/`tests/cgt-001b.test.ts`
//     already use for these "use client" components.
// ---------------------------------------------------------------------------

const ROUTER_STUB_IMPORT = `
  import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
  const routerStub = {
    push() {},
    replace() {},
    back() {},
    forward() {},
    refresh() {},
    prefetch() {},
  };
`;

const ONE_HELD_ROW = JSON.stringify([
  {
    id: "row-a",
    securityId: "security-a",
    symbol: "ABC",
    name: "ABC Holdings",
    exchange: "ASX",
    currencyCode: "AUD",
    quantity: "10",
    averageNativeCost: "9.00",
    nativeBasis: {
      status: "available",
      currencyCode: "AUD",
      value: "8000",
      reason: null,
    },
    homeBasis: {
      status: "available",
      currencyCode: "AUD",
      value: "8000",
      reason: null,
    },
    nativePrice: "1000.00",
    nativeValue: {
      status: "available",
      currencyCode: "AUD",
      value: "10000",
      reason: null,
    },
    homePrice: {
      status: "available",
      currencyCode: "AUD",
      value: "1000.00",
      reason: null,
    },
    homeValue: {
      status: "available",
      currencyCode: "AUD",
      value: "10000",
      reason: null,
    },
    dailyMovement: {
      status: "available",
      currencyCode: "AUD",
      value: "150",
      reason: null,
    },
    dailyPercent: {
      status: "available",
      currencyCode: "%",
      value: "1.52",
      reason: null,
    },
    unrealisedGain: {
      status: "available",
      currencyCode: "AUD",
      value: "2000",
      reason: null,
    },
    unrealisedPercent: {
      status: "available",
      currencyCode: "%",
      value: "25",
      reason: null,
    },
    dailyTone: "positive",
    gainTone: "positive",
    priceState: "current",
    actionStatus: "none",
    explanation: "Fixture explanation.",
    sort: { ticker: "ABC", value: "10000", daily: "1.52", gain: "25" },
  },
]);

function renderHoldingsScreen(projectionPendingJson: string | null): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    const ownedWorkspace = {
      status: "ready",
      homeCurrencyCode: "AUD",
      holdingCurrencyView: "native",
      activePortfolio: {
        id: "portfolio-a",
        name: "Fixture Portfolio",
        homeCurrencyCode: "AUD",
        baseCurrencyCode: "AUD",
        timezone: "Australia/Sydney",
        accountingMethod: "fifo",
        status: "active",
        version: 1,
      },
      portfolios: [
        { id: "portfolio-a", name: "Fixture Portfolio", homeCurrencyCode: "AUD", status: "active", version: 1 },
      ],
      holdings: ${ONE_HELD_ROW},
      holdingsViewState: "complete",
      ${projectionPendingJson === null ? "" : `holdingsProjectionPending: ${projectionPendingJson},`}
    };

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, { activeSection: "holdings", ownedWorkspace }),
        ),
      ),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

test("BUG-017 (e) render: the Holdings screen shows the recalculating notice when projectionPending is set", () => {
  const html = renderHoldingsScreen(
    JSON.stringify({ pending: true, reason: "queued" }),
  );
  assert.match(
    html,
    /Recalculating after your latest ledger change — figures may not yet reflect it\./,
  );
  // F3: the notice must be an announced live region, not merely visible
  // text -- matches the established `.unavailable`/`role="status"`
  // advisory convention this file's other notices already use.
  assert.match(
    html,
    /<p class="unavailable" role="status">Recalculating after your latest ledger change/,
  );
});

test("BUG-017 (e) render: the Holdings screen shows the distinct failed-recalculation notice for reason 'failed'", () => {
  const html = renderHoldingsScreen(
    JSON.stringify({ pending: true, reason: "failed" }),
  );
  assert.match(
    html,
    /The last recalculation failed — figures reflect the previous successful calculation\./,
  );
  assert.match(
    html,
    /<p class="unavailable" role="status">The last recalculation failed/,
  );
  assert.doesNotMatch(html, /Recalculating after your latest ledger change/);
});

test("BUG-017 (e) render: the Holdings screen shows no notice when projectionPending is absent or false", () => {
  const htmlAbsent = renderHoldingsScreen(null);
  assert.doesNotMatch(
    htmlAbsent,
    /Recalculating after your latest ledger change/,
  );
  assert.doesNotMatch(htmlAbsent, /The last recalculation failed/);

  const htmlFalse = renderHoldingsScreen(JSON.stringify({ pending: false }));
  assert.doesNotMatch(
    htmlFalse,
    /Recalculating after your latest ledger change/,
  );
  assert.doesNotMatch(htmlFalse, /The last recalculation failed/);
});

function renderOverviewScreen(projectionPendingJson: string | null): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    const ownedWorkspace = {
      status: "ready",
      homeCurrencyCode: "AUD",
      activePortfolio: {
        id: "portfolio-a",
        name: "Fixture Portfolio",
        homeCurrencyCode: "AUD",
        baseCurrencyCode: "AUD",
        timezone: "Australia/Sydney",
        accountingMethod: "fifo",
        status: "active",
        version: 1,
      },
      portfolios: [
        { id: "portfolio-a", name: "Fixture Portfolio", homeCurrencyCode: "AUD", status: "active", version: 1 },
      ],
      overview: {
        status: "complete",
        currencyCode: "AUD",
        current: {
          date: "2026-08-01",
          value: "AUD 492,306.46",
          securities: "AUD 1,321,205.37",
          cash: "AUD 500.00",
          cost: "AUD 800.00",
          unrealised: "+AUD 100.00",
          realised: "+AUD 0.00",
          daily: "+AUD 5.00",
          valueDecimal: "492306.46",
          completeness: "complete",
          barHeight: "80%",
        },
        history: [],
        coverage: {
          pricedHoldingCount: 1,
          nonZeroHoldingCount: 1,
          convertedCashAccountCount: 1,
          nonZeroCashAccountCount: 1,
          totalHoldingCount: 1,
          excluded: [],
          issues: [],
          marketDataStates: [],
        },
        allocation: { status: "complete", rows: [] },
      },
      ${projectionPendingJson === null ? "" : `holdingsProjectionPending: ${projectionPendingJson},`}
    };

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, { activeSection: "overview", ownedWorkspace }),
        ),
      ),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

test("BUG-017 (e) render: the Overview screen shows the recalculating notice when holdingsProjectionPending is set", () => {
  const html = renderOverviewScreen(
    JSON.stringify({ pending: true, reason: "running" }),
  );
  assert.match(
    html,
    /Recalculating after your latest ledger change — figures may not yet reflect it\./,
  );
  // F3: same announced-live-region requirement as the Holdings screen.
  assert.match(
    html,
    /<p class="unavailable" role="status">Recalculating after your latest ledger change/,
  );
});

test("BUG-017 (e) render: the Overview screen shows no notice when holdingsProjectionPending is absent", () => {
  const html = renderOverviewScreen(null);
  assert.doesNotMatch(html, /Recalculating after your latest ledger change/);
  assert.doesNotMatch(html, /The last recalculation failed/);
});

function renderGainsScreen(projectionPendingJson: string | null): string {
  const componentUrl = new URL(
    "../app/components/capital-gains-screen.tsx",
    import.meta.url,
  ).href;
  const history = {
    today: "2026-08-14",
    financialYearStartMonth: 7,
    baseCurrencyCode: "AUD",
    disposalCount: 0,
    fyTotals: [],
    historyCompleteFrom: null,
    earliestTradeDate: null,
    ...(projectionPendingJson === null
      ? {}
      : { projectionPending: JSON.parse(projectionPendingJson) }),
  };
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { CapitalGainsScreen } from ${JSON.stringify(componentUrl)};
    const props = ${JSON.stringify({
      portfolioId: "portfolio-a",
      holdingsHref: "/portfolio/portfolio-a/holdings",
      result: { status: "ok", history },
    })};
    process.stdout.write(
      renderToStaticMarkup(createElement(CapitalGainsScreen, props)),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

test("BUG-017 (e) render: the Capital gains screen shows the recalculating notice when projectionPending is set (empty-disposals branch)", () => {
  const html = renderGainsScreen(
    JSON.stringify({ pending: true, reason: "queued" }),
  );
  assert.match(
    html,
    /Recalculating after your latest ledger change — figures may not yet reflect it\./,
  );
  // F3: same announced-live-region requirement as the other two surfaces.
  assert.match(
    html,
    /<p class="unavailable" role="status">Recalculating after your latest ledger change/,
  );
});

test("BUG-017 (e) render: the Capital gains screen shows no notice when projectionPending is false", () => {
  const html = renderGainsScreen(JSON.stringify({ pending: false }));
  assert.doesNotMatch(html, /Recalculating after your latest ledger change/);
  assert.doesNotMatch(html, /The last recalculation failed/);
});

// F3: `capital-gains-screen.tsx:~548`'s POPULATED branch
// (`disposalCount > 0`) was uncovered -- every existing gains render test
// above exercises only the `disposalCount === 0` empty-state branch's OWN
// `ProjectionPendingNotice` call at `:507`. This drives the real,
// populated FY-table path with one disposal so the `:548` call site (and
// the FY table it sits above) is actually rendered.
function renderGainsScreenPopulated(projectionPendingJson: string): string {
  const componentUrl = new URL(
    "../app/components/capital-gains-screen.tsx",
    import.meta.url,
  ).href;
  const fyTotal = {
    endingYear: 2026,
    label: "FY26",
    window: { startDate: "2025-07-01", endDate: "2026-06-30" },
    rows: [],
    disposalCount: 1,
    excludedIncompleteCount: 0,
    excludedIncompleteSecurityNames: [],
    partialCoverage: false,
    totalDiscountableGainsGrossDecimal: "1000.00",
    totalNonDiscountableGainsGrossDecimal: "0",
    totalLossesDecimal: "0",
    lossAppliedToNonDiscountableDecimal: "0",
    lossAppliedToDiscountableDecimal: "0",
    remainingNonDiscountableAfterLossDecimal: "0",
    remainingDiscountableAfterLossDecimal: "1000.00",
    discountRateDecimal: "0.50",
    discountAppliedDecimal: "500.00",
    netCapitalGainEstimateDecimal: "500.00",
    unabsorbedLossDecimal: "0",
  };
  const history = {
    today: "2026-08-14",
    financialYearStartMonth: 7,
    baseCurrencyCode: "AUD",
    disposalCount: 1,
    fyTotals: [fyTotal],
    historyCompleteFrom: "2025-07-01",
    earliestTradeDate: "2025-08-01",
    projectionPending: JSON.parse(projectionPendingJson),
  };
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { CapitalGainsScreen } from ${JSON.stringify(componentUrl)};
    const props = ${JSON.stringify({
      portfolioId: "portfolio-a",
      holdingsHref: "/portfolio/portfolio-a/holdings",
      result: { status: "ok", history },
    })};
    process.stdout.write(
      renderToStaticMarkup(createElement(CapitalGainsScreen, props)),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

test("BUG-017 (e) render: the Capital gains screen shows the recalculating notice on the POPULATED (disposalCount > 0) branch", () => {
  const html = renderGainsScreenPopulated(
    JSON.stringify({ pending: true, reason: "queued" }),
  );
  assert.match(
    html,
    /Recalculating after your latest ledger change — figures may not yet reflect it\./,
  );
  assert.match(
    html,
    /<p class="unavailable" role="status">Recalculating after your latest ledger change/,
  );
  // Proves this is genuinely the populated branch, not a fallback to the
  // empty-state short-circuit.
  assert.doesNotMatch(html, /No disposals yet/);
});

test("BUG-017 (e) render: the Capital gains screen shows no notice on the POPULATED branch when projectionPending is false", () => {
  const html = renderGainsScreenPopulated(JSON.stringify({ pending: false }));
  assert.doesNotMatch(html, /Recalculating after your latest ledger change/);
  assert.doesNotMatch(html, /The last recalculation failed/);
  assert.doesNotMatch(html, /No disposals yet/);
});
