/**
 * BRK-022 slice 1 — `sharesight_pending_payouts` schema/migration and its
 * repository (`db/repositories/sharesight-pending-payouts.ts`). Covers the
 * upsert-observed/withdraw/list-active cycle this slice reserves; slices 2
 * (sync wiring) and 3 (read path/UI) are separate, later tasks.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSharesightPendingPayoutsRepository,
  type PendingPayoutObservationInput,
} from "../db/repositories/sharesight-pending-payouts.ts";
import {
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/sql-client.ts";

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files)
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  return db;
}

/** Two owners, one portfolio each, one `unresolved` portfolio_securities
 * candidate row for owner 'a' (FK-targetable, no resolved security needed
 * for these repository tests). */
async function ownedFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01'),
      ('b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pa2','a','A2','A second portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pb','b','B','B portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('ps-a','a','pa',NULL,'BHP','AUD','unresolved','2026-08-01','2026-08-01');
  `);
  return db;
}

function payout(
  overrides: Partial<PendingPayoutObservationInput> = {},
): PendingPayoutObservationInput {
  return {
    portfolioSecurityId: null,
    sourceReference: "sharesight-payout:pa:holding-1:2026-09-15",
    sharesightHoldingId: "holding-1",
    sharesightInstrumentId: "instrument-1",
    sharesightPayoutId: null,
    symbol: "BHP",
    marketCode: "ASX",
    currencyCode: "AUD",
    paymentDate: "2026-09-15",
    exDate: "2026-08-20",
    totalCashDecimal: "150.00",
    grossAmountDecimal: "150.00",
    totalFrankingDecimal: "64.29",
    residentWithholdingTaxDecimal: null,
    nonResidentWithholdingTaxDecimal: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Migration shape: unique/index shape and all three purge-lock triggers.
// ---------------------------------------------------------------------------

test("migration creates sharesight_pending_payouts with its unique/index shape and all three purge-lock triggers", async () => {
  const db = await migratedDatabase();
  const indexNames = db
    .prepare("PRAGMA index_list('sharesight_pending_payouts')")
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((name) => !name.startsWith("sqlite_"))
    .sort();
  assert.deepEqual(indexNames, [
    "sharesight_pending_payouts_owner_portfolio_security_idx",
    "sharesight_pending_payouts_owner_portfolio_source_reference_unique",
    "sharesight_pending_payouts_owner_portfolio_withdrawn_idx",
  ]);
  const triggerNames = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='sharesight_pending_payouts' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(triggerNames, [
    "account_purge_lock_sharesight_pending_payouts_delete",
    "account_purge_lock_sharesight_pending_payouts_insert",
    "account_purge_lock_sharesight_pending_payouts_update",
  ]);
});

test("schema rejects a foreign (cross-owner/cross-portfolio) portfolio_security_id", async () => {
  const db = await ownedFixture();
  assert.throws(() => {
    db.exec(`
      INSERT INTO sharesight_pending_payouts (
        id, user_id, portfolio_id, portfolio_security_id, source_reference,
        sharesight_holding_id, symbol, market_code, currency_code,
        payment_date, total_cash_decimal, gross_amount_decimal,
        first_observed_at, last_observed_at, created_at, updated_at
      ) VALUES (
        'row-1', 'a', 'pa2', 'ps-a', 'sharesight-payout:pa2:holding-1:2026-09-15',
        'holding-1', 'BHP', 'ASX', 'AUD',
        '2026-09-15', '150.00', '150.00',
        '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
      );
    `);
  }, /FOREIGN KEY constraint failed/);
});

test("schema rejects an fx rate with no fx rate source (provenance CHECK)", async () => {
  const db = await ownedFixture();
  assert.throws(() => {
    db.exec(`
      INSERT INTO sharesight_pending_payouts (
        id, user_id, portfolio_id, source_reference,
        sharesight_holding_id, symbol, market_code, currency_code,
        payment_date, total_cash_decimal, gross_amount_decimal,
        fx_rate_to_portfolio_decimal,
        first_observed_at, last_observed_at, created_at, updated_at
      ) VALUES (
        'row-1', 'a', 'pa', 'sharesight-payout:pa:holding-1:2026-09-15',
        'holding-1', 'BHP', 'ASX', 'AUD',
        '2026-09-15', '150.00', '150.00',
        '1.35',
        '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'
      );
    `);
  }, /CHECK constraint failed: sharesight_pending_payouts_fx_provenance_check/);
});

// ---------------------------------------------------------------------------
// Repository: upsertObserved.
// ---------------------------------------------------------------------------

test("upsertObserved inserts a new row with first_observed_at = last_observed_at, then an identical re-observe is idempotent (still one row, first_observed_at unchanged, last_observed_at advanced)", async () => {
  const db = await ownedFixture();
  let clock = "2026-09-01T00:00:00.000Z";
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => clock,
  );

  const first = await repo.upsertObserved("a", "pa", [payout()]);
  assert.deepEqual(first, { ok: true, inserted: 1, updated: 0 });

  const afterFirst = await repo.listActive("a", "pa");
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0].firstObservedAt, clock);
  assert.equal(afterFirst[0].lastObservedAt, clock);
  const rowId = afterFirst[0].id;

  clock = "2026-09-02T00:00:00.000Z";
  const second = await repo.upsertObserved("a", "pa", [payout()]);
  assert.deepEqual(second, { ok: true, inserted: 0, updated: 1 });

  const afterSecond = await repo.listActive("a", "pa");
  assert.equal(afterSecond.length, 1);
  assert.equal(afterSecond[0].id, rowId);
  assert.equal(afterSecond[0].firstObservedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(afterSecond[0].lastObservedAt, clock);
});

test("upsertObserved refreshes every value column on a re-observe with changed values", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  await repo.upsertObserved("a", "pa", [
    payout({ totalCashDecimal: "150.00" }),
  ]);
  await repo.upsertObserved("a", "pa", [
    payout({ totalCashDecimal: "175.50", totalFrankingDecimal: "75.21" }),
  ]);

  const rows = await repo.listActive("a", "pa");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalCashDecimal, "175.50");
  assert.equal(rows[0].totalFrankingDecimal, "75.21");
});

test("upsertObserved accepts a batch and reports insert/update counts per call", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  await repo.upsertObserved("a", "pa", [
    payout({ sourceReference: "sharesight-payout:pa:holding-1:2026-09-15" }),
  ]);
  const result = await repo.upsertObserved("a", "pa", [
    payout({ sourceReference: "sharesight-payout:pa:holding-1:2026-09-15" }),
    payout({ sourceReference: "sharesight-payout:pa:holding-2:2026-09-20" }),
  ]);
  assert.deepEqual(result, { ok: true, inserted: 1, updated: 1 });
  assert.equal((await repo.listActive("a", "pa")).length, 2);
});

test("upsertObserved rejects an invalid decimal input, writes nothing, and returns a typed failure", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  const result = await repo.upsertObserved("a", "pa", [
    payout({ totalCashDecimal: "1".repeat(120) }),
  ]);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid_input");
    if (result.reason === "invalid_input")
      assert.equal(result.field, "payouts[0].totalCashDecimal");
  }
  assert.equal((await repo.listActive("a", "pa")).length, 0);
});

// Review round correction (F3, 2026-09-04): this used to assert that a
// zero-amount payout was REJECTED ("form-invalid, not merely over-bound").
// That was wrong -- Sharesight can genuinely announce a `"0"` payout, and
// this table's write is validated WHOLESALE (see `upsertObserved`'s doc
// comment), so rejecting a zero-amount row would have blocked recording
// (and, via the caller's skipped withdrawal call, withdrawal) for every
// OTHER pending payout in the same sync, not just this one. `"0"` is now
// accepted for both `totalCashDecimal` and `grossAmountDecimal`; a genuinely
// negative value is still rejected (unrepresentable for a payout).
test("upsertObserved accepts a zero totalCashDecimal/grossAmountDecimal but rejects a negative one", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  const zero = await repo.upsertObserved("a", "pa", [
    payout({ totalCashDecimal: "0", grossAmountDecimal: "0" }),
  ]);
  assert.deepEqual(zero, { ok: true, inserted: 1, updated: 0 });
  const [row] = await repo.listActive("a", "pa");
  assert.equal(row?.totalCashDecimal, "0");
  assert.equal(row?.grossAmountDecimal, "0");

  const negative = await repo.upsertObserved("a", "pa", [
    payout({
      sourceReference: "sharesight-payout:pa:holding-negative:2026-09-25",
      totalCashDecimal: "-1.00",
    }),
  ]);
  assert.equal(negative.ok, false);
  if (!negative.ok && negative.reason === "invalid_input")
    assert.equal(negative.field, "payouts[0].totalCashDecimal");
});

test("upsertObserved rejects a fx rate present without a fx rate source", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  const result = await repo.upsertObserved("a", "pa", [
    payout({ fxRateToPortfolioDecimal: "1.35", fxRateSource: null }),
  ]);
  assert.equal(result.ok, false);
  if (!result.ok && result.reason === "invalid_input")
    assert.equal(result.field, "payouts[0].fxRateSource");
});

test("upsertObserved fails atomically on a foreign portfolio_security_id, writing nothing", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  // 'ps-a' belongs to portfolio 'pa', not 'pa2'.
  const result = await repo.upsertObserved("a", "pa2", [
    payout({
      sourceReference: "sharesight-payout:pa2:holding-1:2026-09-15",
      portfolioSecurityId: "ps-a",
    }),
  ]);
  assert.deepEqual(result, { ok: false, reason: "atomic_failure" });
  assert.equal((await repo.listActive("a", "pa2")).length, 0);
});

test("same source_reference in two different portfolios is two independent rows", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  await repo.upsertObserved("a", "pa", [
    payout({
      sourceReference: "sharesight-payout:shared:holding-1:2026-09-15",
    }),
  ]);
  await repo.upsertObserved("a", "pa2", [
    payout({
      sourceReference: "sharesight-payout:shared:holding-1:2026-09-15",
    }),
  ]);
  assert.equal((await repo.listActive("a", "pa")).length, 1);
  assert.equal((await repo.listActive("a", "pa2")).length, 1);
});

test("a cross-owner call cannot overwrite another owner's row via a colliding source_reference (B1 review fix)", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  const sharedReference = "sharesight-payout:shared:holding-1:2026-09-15";
  await repo.upsertObserved("a", "pa", [
    payout({ sourceReference: sharedReference, totalCashDecimal: "150.00" }),
  ]);
  const originalRow = (await repo.listActive("a", "pa"))[0];

  // Colliding source_reference under B's OWN, different portfolio never
  // touches A's row -- the unique key includes portfolio_id, so it doesn't
  // even match.
  const differentPortfolio = await repo.upsertObserved("b", "pb", [
    payout({ sourceReference: sharedReference, totalCashDecimal: "999.99" }),
  ]);
  assert.deepEqual(differentPortfolio, { ok: true, inserted: 1, updated: 0 });
  assert.deepEqual((await repo.listActive("a", "pa"))[0], originalRow);

  // The actual attack: B passes A's own portfolio_id. Before this fix, the
  // unique index and the ON CONFLICT target were (portfolio_id,
  // source_reference) only, so this matched A's row on conflict regardless
  // of user_id and silently overwrote it. user_id is now part of both, so
  // this falls through to the INSERT path instead, where the
  // (portfolio_id, user_id) FK to portfolios rejects it (portfolio 'pa'
  // belongs to user 'a', not 'b') -- a typed atomic_failure, and A's row is
  // untouched.
  const asOwnersPortfolio = await repo.upsertObserved("b", "pa", [
    payout({ sourceReference: sharedReference, totalCashDecimal: "1.00" }),
  ]);
  assert.deepEqual(asOwnersPortfolio, {
    ok: false,
    reason: "atomic_failure",
  });
  assert.deepEqual((await repo.listActive("a", "pa"))[0], originalRow);
});

test("upsertObserved de-dupes a duplicate sourceReference within one call (last occurrence wins), never double-writing or inflating counts", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  const result = await repo.upsertObserved("a", "pa", [
    payout({
      sourceReference: "sharesight-payout:pa:holding-1:2026-09-15",
      totalCashDecimal: "100.00",
    }),
    payout({
      sourceReference: "sharesight-payout:pa:holding-1:2026-09-15",
      totalCashDecimal: "200.00",
    }),
  ]);
  assert.deepEqual(result, { ok: true, inserted: 1, updated: 0 });
  const rows = await repo.listActive("a", "pa");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totalCashDecimal, "200.00");
});

test("upsertObserved chunks its INSERT batch at REFERENCE_CHUNK_SIZE without miscounting across chunks, and its client.batch() calls are pinned at exactly [50, 50, 20] for 120 rows", async () => {
  const db = await ownedFixture();
  const baseClient = createSqliteSqlClient(db);
  // Census wrapper (mirrors tests/brk-012c.test.ts's counting-client
  // pattern): records the STATEMENT COUNT of every client.batch() call so
  // this test pins the chunk SIZES themselves, not merely the aggregate
  // inserted count -- a chunk-size regression (e.g. one chunk of 120
  // instead of three of 50/50/20) would previously slip through unnoticed.
  const batchCallSizes: number[] = [];
  const censusClient: SqlClient = {
    ...baseClient,
    batch: async (statements) => {
      batchCallSizes.push(statements.length);
      return baseClient.batch(statements);
    },
  };
  const repo = createSharesightPendingPayoutsRepository(
    censusClient,
    () => "2026-09-01T00:00:00.000Z",
  );
  // 120 rows crosses the module's 50-statement chunk boundary twice (two
  // full chunks plus a 20-row remainder), exercising the loop of
  // client.batch() calls.
  const inputs = Array.from({ length: 120 }, (_, index) =>
    payout({
      sourceReference: `sharesight-payout:pa:holding-${index}:2026-09-15`,
      sharesightHoldingId: `holding-${index}`,
    }),
  );
  const result = await repo.upsertObserved("a", "pa", inputs);
  assert.deepEqual(result, { ok: true, inserted: 120, updated: 0 });
  assert.equal((await repo.listActive("a", "pa")).length, 120);
  assert.deepEqual(batchCallSizes, [50, 50, 20]);
});

test("upsertObserved rejects an empty userId with the field: 'userId' label, writing nothing", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  const result = await repo.upsertObserved("", "pa", [payout()]);
  assert.deepEqual(result, {
    ok: false,
    reason: "invalid_input",
    field: "userId",
  });
});

// ---------------------------------------------------------------------------
// Repository: markWithdrawnNotObserved.
// ---------------------------------------------------------------------------

test("markWithdrawnNotObserved on a full window withdraws every active row not in the observed set, including a null-ex_date row", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  await repo.upsertObserved("a", "pa", [
    payout({
      sourceReference: "sharesight-payout:pa:holding-1:2026-09-15",
      exDate: "2026-08-20",
    }),
    payout({
      sourceReference: "sharesight-payout:pa:holding-2:2026-09-20",
      exDate: null,
    }),
  ]);

  const result = await repo.markWithdrawnNotObserved("a", "pa", [], {
    kind: "full",
  });
  assert.deepEqual(result, { ok: true, withdrawn: 2 });
  assert.equal((await repo.listActive("a", "pa")).length, 0);
});

test("markWithdrawnNotObserved on a narrowed window withdraws only rows the window covered (ex_date >= sinceDate), never a null-ex_date row", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  await repo.upsertObserved("a", "pa", [
    payout({
      sourceReference: "sharesight-payout:pa:holding-1:2026-09-15",
      exDate: "2026-08-25", // covered: >= sinceDate
    }),
    payout({
      sourceReference: "sharesight-payout:pa:holding-2:2026-09-20",
      exDate: "2026-08-10", // NOT covered: before sinceDate
    }),
    payout({
      sourceReference: "sharesight-payout:pa:holding-3:2026-09-25",
      exDate: null, // NOT covered: a narrowed window never claims a null-ex_date row
    }),
  ]);

  const result = await repo.markWithdrawnNotObserved("a", "pa", [], {
    kind: "narrowed",
    sinceDate: "2026-08-20",
  });
  assert.deepEqual(result, { ok: true, withdrawn: 1 });

  const active = await repo.listActive("a", "pa");
  assert.deepEqual(active.map((row) => row.sourceReference).sort(), [
    "sharesight-payout:pa:holding-2:2026-09-20",
    "sharesight-payout:pa:holding-3:2026-09-25",
  ]);
});

test("markWithdrawnNotObserved leaves an observed row active", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  await repo.upsertObserved("a", "pa", [
    payout({ sourceReference: "sharesight-payout:pa:holding-1:2026-09-15" }),
  ]);
  const result = await repo.markWithdrawnNotObserved(
    "a",
    "pa",
    ["sharesight-payout:pa:holding-1:2026-09-15"],
    { kind: "full" },
  );
  assert.deepEqual(result, { ok: true, withdrawn: 0 });
  assert.equal((await repo.listActive("a", "pa")).length, 1);
});

test("re-observing a withdrawn row clears withdrawn_at", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  await repo.upsertObserved("a", "pa", [payout()]);
  await repo.markWithdrawnNotObserved("a", "pa", [], { kind: "full" });
  assert.equal((await repo.listActive("a", "pa")).length, 0);

  await repo.upsertObserved("a", "pa", [payout()]);
  const active = await repo.listActive("a", "pa");
  assert.equal(active.length, 1);
  assert.equal(active[0].withdrawnAt, null);
});

// ---------------------------------------------------------------------------
// Repository: listActive isolation.
// ---------------------------------------------------------------------------

test("listActive excludes withdrawn rows and rows belonging to another owner or portfolio", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  await repo.upsertObserved("a", "pa", [
    payout({ sourceReference: "sharesight-payout:pa:holding-1:2026-09-15" }),
  ]);
  await repo.upsertObserved("a", "pa2", [
    payout({ sourceReference: "sharesight-payout:pa2:holding-1:2026-09-15" }),
  ]);
  await repo.upsertObserved("b", "pb", [
    payout({ sourceReference: "sharesight-payout:pb:holding-1:2026-09-15" }),
  ]);
  await repo.markWithdrawnNotObserved("a", "pa", [], { kind: "full" });

  assert.equal((await repo.listActive("a", "pa")).length, 0);
  assert.equal((await repo.listActive("a", "pa2")).length, 1);
  assert.equal((await repo.listActive("b", "pb")).length, 1);
});

test("markWithdrawnNotObserved is scoped to one owner's one portfolio: user B's active row survives a call against user A's portfolio", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  await repo.upsertObserved("a", "pa", [
    payout({ sourceReference: "sharesight-payout:pa:holding-1:2026-09-15" }),
  ]);
  await repo.upsertObserved("b", "pb", [
    payout({ sourceReference: "sharesight-payout:pb:holding-1:2026-09-15" }),
  ]);

  await repo.markWithdrawnNotObserved("a", "pa", [], { kind: "full" });

  assert.equal((await repo.listActive("a", "pa")).length, 0);
  assert.equal((await repo.listActive("b", "pb")).length, 1);
});

// ---------------------------------------------------------------------------
// F7 correction round (BRK-022 slice 3 review): listActive's optional
// `limit` -- caps the read so app/owned-dividend-history.ts's
// MAX_PENDING_PAYOUTS_PER_PORTFOLIO cap can be enforced with a bounded
// query rather than reading the whole table unbounded.
// ---------------------------------------------------------------------------

test("listActive with a limit returns only that many rows, ordered by payment_date then symbol (the earliest-due rows survive); omitting limit stays unbounded", async () => {
  const db = await ownedFixture();
  const repo = createSharesightPendingPayoutsRepository(
    createSqliteSqlClient(db),
    () => "2026-09-01T00:00:00.000Z",
  );
  await repo.upsertObserved("a", "pa", [
    payout({
      sourceReference: "sharesight-payout:pa:holding-1:2026-09-15",
      paymentDate: "2026-09-15",
      symbol: "BHP",
    }),
    payout({
      sourceReference: "sharesight-payout:pa:holding-1:2026-09-10",
      paymentDate: "2026-09-10",
      symbol: "CBA",
    }),
    payout({
      sourceReference: "sharesight-payout:pa:holding-1:2026-09-20",
      paymentDate: "2026-09-20",
      symbol: "WES",
    }),
  ]);

  const unbounded = await repo.listActive("a", "pa");
  assert.equal(unbounded.length, 3);

  const limited = await repo.listActive("a", "pa", 2);
  assert.equal(limited.length, 2);
  // ORDER BY payment_date, symbol -- the two earliest-due rows survive.
  assert.deepEqual(
    limited.map((row) => row.paymentDate),
    ["2026-09-10", "2026-09-15"],
  );
});
