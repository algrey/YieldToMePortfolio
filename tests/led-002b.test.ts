import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createCalculationRunRepository,
  createOwnedProjectionRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";

async function createMigratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const migrationFiles = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const migrationFile of migrationFiles) {
    database.exec(
      await readFile(
        new URL(`../drizzle/${migrationFile}`, import.meta.url),
        "utf8",
      ),
    );
  }
  return database;
}

function seedLedger(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES
      ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
      ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone,
      accounting_method, status, created_at, updated_at, version
    ) VALUES
      ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1),
      ('portfolio-b', 'user-b', 'B', 'Bob', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolio_securities (
      id, user_id, portfolio_id, source_symbol, source_currency_code,
      status, created_at, updated_at
    ) VALUES
      ('membership-a', 'user-a', 'portfolio-a', 'ABC', 'AUD', 'unresolved', '2026-08-03', '2026-08-03'),
      ('membership-b', 'user-b', 'portfolio-b', 'ABC', 'AUD', 'unresolved', '2026-08-03', '2026-08-03');
  `);
}

function insertTransaction(
  database: DatabaseSync,
  values: {
    id: string;
    userId?: string;
    portfolioId?: string;
    portfolioSecurityId?: string | null;
    type: string;
    status?: string;
    tradeAt: string;
    quantityDecimal?: string | null;
    unitPriceDecimal?: string | null;
    grossAmountDecimal?: string | null;
    feeAmountDecimal?: string;
    taxAmountDecimal?: string;
    fxRateToBaseDecimal?: string | null;
    reversesTransactionId?: string | null;
  },
): void {
  const userId = values.userId ?? "user-a";
  const portfolioId = values.portfolioId ?? "portfolio-a";
  database
    .prepare(
      `INSERT INTO transactions (
        id, user_id, portfolio_id, portfolio_security_id, type, status,
        trade_at, local_trade_date, quantity_decimal, unit_price_decimal,
        currency_code, gross_amount_decimal, fee_amount_decimal,
        tax_amount_decimal, fx_rate_to_base_decimal, source_type,
        reverses_transaction_id,
        created_by_user_id, calculation_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUD', ?, ?, ?, ?, 'manual', ?, ?, 1, ?)`,
    )
    .run(
      values.id,
      userId,
      portfolioId,
      values.portfolioSecurityId === undefined
        ? "membership-a"
        : values.portfolioSecurityId,
      values.type,
      values.status ?? "posted",
      values.tradeAt,
      values.tradeAt.slice(0, 10),
      values.quantityDecimal ?? null,
      values.unitPriceDecimal ?? null,
      values.grossAmountDecimal ?? null,
      values.feeAmountDecimal ?? "0",
      values.taxAmountDecimal ?? "0",
      values.fxRateToBaseDecimal ?? null,
      values.reversesTransactionId ?? null,
      userId,
      values.tradeAt,
    );
}

async function startRun(
  database: DatabaseSync,
  input: {
    id: string;
    version: number;
    highWater: string;
    worker: string;
    now: string;
  },
) {
  const client = createSqliteSqlClient(database);
  const runs = createCalculationRunRepository(client);
  const requested = await runs.request("user-a", {
    id: input.id,
    portfolioId: "portfolio-a",
    rangeFrom: "2026-01-01",
    rangeTo: "2026-12-31",
    calculationVersion: input.version,
    reason: "transaction_change",
    invalidationSource: input.highWater,
    ledgerHighWaterStart: input.highWater,
    idempotencyKey: `rebuild-${input.id}`,
    now: input.now,
  });
  const claimed = await runs.claim(
    "user-a",
    "portfolio-a",
    requested.id,
    input.worker,
    "2026-08-04T00:00:00Z",
    input.now,
  );
  assert.equal(claimed.ok, true);
  return { client, runId: requested.id };
}

async function rebuildToCompletion(
  repository: ReturnType<typeof createOwnedProjectionRepository>,
  userId: string,
  input: Parameters<
    ReturnType<typeof createOwnedProjectionRepository>["rebuild"]
  >[1],
  maxChunks = 10_000,
) {
  for (let chunk = 0; chunk < maxChunks; chunk += 1) {
    const result = await repository.rebuild(userId, input);
    if (!result.ok || result.completed) return result;
  }
  throw new Error("projection_rebuild_did_not_complete");
}

test("owned projection rebuild publishes FIFO lots atomically and rejects stale work", async () => {
  const database = await createMigratedDatabase();
  seedLedger(database);
  insertTransaction(database, {
    id: "buy-1",
    type: "buy",
    tradeAt: "2026-01-01T00:00:00Z",
    quantityDecimal: "10",
    unitPriceDecimal: "20",
    grossAmountDecimal: "200",
    feeAmountDecimal: "10",
    fxRateToBaseDecimal: "1",
  });
  insertTransaction(database, {
    id: "buy-2",
    type: "buy",
    tradeAt: "2026-01-02T00:00:00Z",
    quantityDecimal: "5",
    unitPriceDecimal: "24",
    grossAmountDecimal: "120",
    feeAmountDecimal: "5",
    fxRateToBaseDecimal: "1",
  });
  insertTransaction(database, {
    id: "sell-1",
    type: "sell",
    tradeAt: "2026-01-03T00:00:00Z",
    quantityDecimal: "12",
    unitPriceDecimal: "30",
    grossAmountDecimal: "360",
    feeAmountDecimal: "6",
    fxRateToBaseDecimal: "1",
  });

  const first = await startRun(database, {
    id: "run-1",
    version: 1,
    highWater: "sell-1",
    worker: "worker-1",
    now: "2026-08-03T01:00:00Z",
  });
  const projections = createOwnedProjectionRepository(first.client);
  assert.deepEqual(
    await projections.rebuild("user-b", {
      portfolioId: "portfolio-a",
      calculationRunId: first.runId,
      leaseOwner: "worker-1",
      currentLedgerHighWater: "sell-1",
      now: "2026-08-03T01:01:00Z",
    }),
    { ok: false, reason: "not_found" },
  );
  assert.deepEqual(
    await projections.rebuild("user-a", {
      portfolioId: "portfolio-b",
      calculationRunId: first.runId,
      leaseOwner: "worker-1",
      currentLedgerHighWater: "sell-1",
      now: "2026-08-03T01:01:00Z",
    }),
    { ok: false, reason: "not_found" },
  );
  const published = await rebuildToCompletion(projections, "user-a", {
    portfolioId: "portfolio-a",
    calculationRunId: first.runId,
    leaseOwner: "worker-1",
    currentLedgerHighWater: "sell-1",
    now: "2026-08-03T01:05:00Z",
  });
  assert.equal(published.ok, true);
  if (!published.ok) return;
  assert.deepEqual(
    {
      lots: published.lotCount,
      allocations: published.allocationCount,
      holdings: published.holdingCount,
      reconciliation: published.reconciliation,
    },
    {
      lots: 2,
      allocations: 2,
      holdings: 1,
      reconciliation: {
        holdingQuantityEqualsOpenLots: true,
        allocationQuantityEqualsSales: true,
      },
    },
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT opening_transaction_id AS id, open_quantity_decimal, native_basis_decimal,
                base_basis_decimal, status
         FROM tax_lots ORDER BY opening_transaction_id`,
      )
      .all()
      .map((row) => Object.assign({}, row)),
    [
      {
        id: "buy-1",
        open_quantity_decimal: "0",
        native_basis_decimal: "0",
        base_basis_decimal: "0",
        status: "closed",
      },
      {
        id: "buy-2",
        open_quantity_decimal: "3",
        native_basis_decimal: "75",
        base_basis_decimal: "75",
        status: "open",
      },
    ],
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT allocation.sell_transaction_id,
                lot.opening_transaction_id AS tax_lot_id,
                allocation.allocation_sequence,
                matched_quantity_decimal
         FROM lot_allocations allocation
         JOIN tax_lots lot ON lot.id = allocation.tax_lot_id
         ORDER BY allocation_sequence`,
      )
      .all()
      .map((row) => Object.assign({}, row)),
    [
      {
        sell_transaction_id: "sell-1",
        tax_lot_id: "buy-1",
        allocation_sequence: 1,
        matched_quantity_decimal: "10",
      },
      {
        sell_transaction_id: "sell-1",
        tax_lot_id: "buy-2",
        allocation_sequence: 2,
        matched_quantity_decimal: "2",
      },
    ],
  );
  assert.deepEqual(
    Object.assign(
      {},
      database
        .prepare(
          `SELECT quantity_decimal, native_open_basis_decimal,
                  base_open_basis_decimal, average_base_cost_decimal,
                  completeness, last_ledger_high_water
           FROM holding_projections`,
        )
        .get(),
    ),
    {
      quantity_decimal: "3",
      native_open_basis_decimal: "75",
      base_open_basis_decimal: "75",
      average_base_cost_decimal: "25",
      completeness: "complete",
      last_ledger_high_water: "sell-1",
    },
  );

  const retry = await projections.rebuild("user-a", {
    portfolioId: "portfolio-a",
    calculationRunId: first.runId,
    leaseOwner: "worker-1",
    currentLedgerHighWater: "sell-1",
    now: "2026-08-03T01:10:00Z",
  });
  assert.equal(retry.ok, true);
  if (retry.ok) assert.equal(retry.idempotent, true);

  const stale = await startRun(database, {
    id: "run-stale",
    version: 2,
    highWater: "sell-1",
    worker: "worker-stale",
    now: "2026-08-03T02:00:00Z",
  });
  const staleResult = await createOwnedProjectionRepository(
    stale.client,
  ).rebuild("user-a", {
    portfolioId: "portfolio-a",
    calculationRunId: stale.runId,
    leaseOwner: "worker-stale",
    currentLedgerHighWater: "newer-ledger-high-water",
    now: "2026-08-03T02:05:00Z",
  });
  assert.deepEqual(staleResult, { ok: false, reason: "stale_ledger" });
  assert.equal(
    (
      database
        .prepare("SELECT status FROM calculation_runs WHERE id = 'run-stale'")
        .get() as { status: string }
    ).status,
    "running",
  );
  assert.equal(
    (
      database
        .prepare("SELECT count(*) AS count FROM holding_projections")
        .get() as { count: number }
    ).count,
    1,
  );

  insertTransaction(database, {
    id: "buy-incomplete",
    type: "buy",
    tradeAt: "2026-01-04T00:00:00Z",
    quantityDecimal: "1",
    unitPriceDecimal: "10",
    grossAmountDecimal: "10",
    feeAmountDecimal: "0",
    portfolioSecurityId: "membership-a",
  });
  const incomplete = await startRun(database, {
    id: "run-incomplete",
    version: 3,
    highWater: "buy-incomplete",
    worker: "worker-incomplete",
    now: "2026-08-03T03:00:00Z",
  });
  const incompleteResult = await rebuildToCompletion(
    createOwnedProjectionRepository(incomplete.client),
    "user-a",
    {
      portfolioId: "portfolio-a",
      calculationRunId: incomplete.runId,
      leaseOwner: "worker-incomplete",
      currentLedgerHighWater: "buy-incomplete",
      now: "2026-08-03T03:05:00Z",
    },
  );
  assert.equal(incompleteResult.ok, true);
  assert.deepEqual(
    Object.assign(
      {},
      database
        .prepare(
          `SELECT projection.quantity_decimal,
                  projection.base_open_basis_decimal, projection.completeness
           FROM holding_projections projection
           JOIN projection_publications publication
             ON publication.calculation_run_id = projection.calculation_run_id
            AND publication.portfolio_id = projection.portfolio_id`,
        )
        .get(),
    ),
    {
      quantity_decimal: "4",
      base_open_basis_decimal: null,
      completeness: "incomplete",
    },
  );

  database.exec(
    `UPDATE transactions SET status = 'reversed' WHERE id = 'sell-1';`,
  );
  insertTransaction(database, {
    id: "reverse-sell-1",
    type: "sell",
    tradeAt: "2026-01-05T00:00:00Z",
    quantityDecimal: "12",
    unitPriceDecimal: "30",
    grossAmountDecimal: "360",
    feeAmountDecimal: "6",
    reversesTransactionId: "sell-1",
  });
  const reversed = await startRun(database, {
    id: "run-reversed",
    version: 4,
    highWater: "reverse-sell-1",
    worker: "worker-reversed",
    now: "2026-08-03T04:00:00Z",
  });
  const reversedResult = await rebuildToCompletion(
    createOwnedProjectionRepository(reversed.client),
    "user-a",
    {
      portfolioId: "portfolio-a",
      calculationRunId: reversed.runId,
      leaseOwner: "worker-reversed",
      currentLedgerHighWater: "reverse-sell-1",
      now: "2026-08-03T04:05:00Z",
    },
  );
  assert.equal(reversedResult.ok, true);
  assert.equal(
    (
      database
        .prepare(
          `SELECT count(*) AS count
           FROM lot_allocations allocation
           JOIN projection_publications publication
             ON publication.calculation_run_id = allocation.calculation_run_id
            AND publication.portfolio_id = allocation.portfolio_id`,
        )
        .get() as { count: number }
    ).count,
    0,
  );
  assert.equal(
    (
      database
        .prepare(
          `SELECT projection.quantity_decimal
           FROM holding_projections projection
           JOIN projection_publications publication
             ON publication.calculation_run_id = projection.calculation_run_id
            AND publication.portfolio_id = projection.portfolio_id`,
        )
        .get() as { quantity_decimal: string }
    ).quantity_decimal,
    "16",
  );

  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO holding_projections (
          id, user_id, portfolio_id, portfolio_security_id, quantity_decimal,
          completeness, status, last_ledger_high_water, calculation_run_id,
          calculation_version, rebuilt_at
        ) VALUES ('cross-owner', 'user-b', 'portfolio-b', 'membership-a',
                   '1', 'complete', 'ready', 'x', 'run-stale', 2, '2026-08-03')`,
      )
      .run();
  }, /FOREIGN KEY constraint failed/);
});

test("high-volume rebuild keeps ledger reads and D1 batches bounded", async () => {
  const database = await createMigratedDatabase();
  seedLedger(database);
  const membershipInsert = database.prepare(
    `INSERT INTO portfolio_securities (
       id, user_id, portfolio_id, source_symbol, source_currency_code,
       status, created_at, updated_at
     ) VALUES (?, 'user-a', 'portfolio-a', ?, 'AUD', 'unresolved',
               '2026-08-03', '2026-08-03')`,
  );
  for (let index = 0; index < 150; index += 1) {
    const suffix = index.toString().padStart(3, "0");
    const membershipId = `membership-${suffix}`;
    membershipInsert.run(membershipId, `S${suffix}`);
    insertTransaction(database, {
      id: `buy-volume-${suffix}`,
      portfolioSecurityId: membershipId,
      type: "buy",
      tradeAt: `2026-01-01T00:${Math.floor(index / 60)
        .toString()
        .padStart(2, "0")}:${(index % 60).toString().padStart(2, "0")}Z`,
      quantityDecimal: "1",
      unitPriceDecimal: "10",
      grossAmountDecimal: "10",
      fxRateToBaseDecimal: "1",
    });
  }

  const run = await startRun(database, {
    id: "run-volume",
    version: 10,
    highWater: "buy-volume-149",
    worker: "worker-volume",
    now: "2026-08-03T05:00:00Z",
  });
  let maximumBatchStatements = 0;
  let maximumBatchParameters = 0;
  let maximumLedgerRows = 0;
  const instrumentedClient = {
    ...run.client,
    async all<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> {
      const rows = await run.client.all<T>(sql, params);
      if (sql.includes("FROM transactions t")) {
        maximumLedgerRows = Math.max(maximumLedgerRows, rows.length);
      }
      return rows;
    },
    async batch(
      statements: Parameters<NonNullable<typeof run.client.batch>>[0],
    ) {
      maximumBatchStatements = Math.max(
        maximumBatchStatements,
        statements.length,
      );
      for (const statement of statements) {
        maximumBatchParameters = Math.max(
          maximumBatchParameters,
          statement.params?.length ?? 0,
        );
      }
      return run.client.batch!(statements);
    },
  };
  const result = await rebuildToCompletion(
    createOwnedProjectionRepository(instrumentedClient, {
      maxLedgerEventsPerSecurity: 2,
      maxOutputStatementsPerChunk: 3,
    }),
    "user-a",
    {
      portfolioId: "portfolio-a",
      calculationRunId: run.runId,
      leaseOwner: "worker-volume",
      currentLedgerHighWater: "buy-volume-149",
      now: "2026-08-03T05:05:00Z",
    },
  );
  assert.equal(result.ok && result.completed, true);
  assert.equal(maximumLedgerRows, 1);
  assert.ok(maximumBatchStatements <= 4);
  assert.ok(maximumBatchParameters <= 100);
  assert.equal(
    (
      database
        .prepare(
          `SELECT count(*) AS count
           FROM holding_projections projection
           JOIN projection_publications publication
             ON publication.calculation_run_id = projection.calculation_run_id
            AND publication.portfolio_id = projection.portfolio_id`,
        )
        .get() as { count: number }
    ).count,
    150,
  );
});

test("an injected chunk failure leaves its checkpoint unchanged and resumes", async () => {
  const database = await createMigratedDatabase();
  seedLedger(database);
  for (let index = 0; index < 30; index += 1) {
    const suffix = index.toString().padStart(2, "0");
    insertTransaction(database, {
      id: `buy-resume-${suffix}`,
      type: "buy",
      tradeAt: `2026-02-01T00:00:${suffix}Z`,
      quantityDecimal: "1",
      unitPriceDecimal: "10",
      grossAmountDecimal: "10",
      fxRateToBaseDecimal: "1",
    });
  }
  const run = await startRun(database, {
    id: "run-resume",
    version: 11,
    highWater: "buy-resume-29",
    worker: "worker-resume",
    now: "2026-08-03T06:00:00Z",
  });
  let batchCall = 0;
  let failureInjected = false;
  const failingClient = {
    ...run.client,
    async batch(
      statements: Parameters<NonNullable<typeof run.client.batch>>[0],
    ) {
      batchCall += 1;
      if (batchCall === 3 && !failureInjected) {
        failureInjected = true;
        throw new Error("injected_chunk_failure");
      }
      return run.client.batch!(statements);
    },
  };
  const repository = createOwnedProjectionRepository(failingClient, {
    maxLedgerEventsPerSecurity: 40,
    maxOutputStatementsPerChunk: 4,
  });
  const input = {
    portfolioId: "portfolio-a",
    calculationRunId: run.runId,
    leaseOwner: "worker-resume",
    currentLedgerHighWater: "buy-resume-29",
    now: "2026-08-03T06:05:00Z",
  };
  assert.equal((await repository.rebuild("user-a", input)).ok, true);
  assert.equal((await repository.rebuild("user-a", input)).ok, true);
  const beforeFailure = Object.assign(
    {},
    database
      .prepare(
        `SELECT projection_active_security_id, projection_output_offset
         FROM calculation_runs WHERE id = 'run-resume'`,
      )
      .get(),
  );
  const lotCountBeforeFailure = (
    database
      .prepare(
        `SELECT count(*) AS count FROM tax_lots
         WHERE calculation_run_id = 'run-resume'`,
      )
      .get() as { count: number }
  ).count;
  assert.deepEqual(await repository.rebuild("user-a", input), {
    ok: false,
    reason: "atomic_failure",
  });
  assert.deepEqual(
    Object.assign(
      {},
      database
        .prepare(
          `SELECT projection_active_security_id, projection_output_offset
           FROM calculation_runs WHERE id = 'run-resume'`,
        )
        .get(),
    ),
    beforeFailure,
  );
  assert.equal(
    (
      database
        .prepare(
          `SELECT count(*) AS count FROM tax_lots
           WHERE calculation_run_id = 'run-resume'`,
        )
        .get() as { count: number }
    ).count,
    lotCountBeforeFailure,
  );

  const resumed = await rebuildToCompletion(repository, "user-a", input);
  assert.equal(resumed.ok && resumed.completed, true);
  assert.equal(resumed.ok ? resumed.lotCount : -1, 30);
  assert.equal(
    (
      database
        .prepare(
          `SELECT quantity_decimal FROM holding_projections
           WHERE calculation_run_id = 'run-resume'`,
        )
        .get() as { quantity_decimal: string }
    ).quantity_decimal,
    "30",
  );
});
