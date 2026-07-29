import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createCalculationRunRepository,
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

function seedPortfolio(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (
      id, status, primary_email, timezone, created_at, updated_at, version
    ) VALUES
      ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 1),
      ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 1);
    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone,
      accounting_method, status, created_at, updated_at, version
    ) VALUES
      ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 1),
      ('portfolio-b', 'user-b', 'B', 'Bob', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', 1);
    INSERT INTO portfolio_securities (
      id, user_id, portfolio_id, source_symbol, source_currency_code,
      status, created_at, updated_at
    ) VALUES ('membership-a', 'user-a', 'portfolio-a', 'ABC', 'AUD', 'unresolved', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z');
  `);
}

function insertPortfolioSnapshot(
  database: DatabaseSync,
  overrides: Record<string, string | number> = {},
): void {
  const values = {
    id: "snapshot-a-v1",
    user_id: "user-a",
    portfolio_id: "portfolio-a",
    snapshot_date: "2026-07-29",
    base_currency_code: "AUD",
    coverage_json: "{}",
    completeness: "complete",
    status: "ready",
    ledger_high_water: "ledger-100",
    calculation_version: 1,
    rebuilt_at: "2026-07-30T00:00:00Z",
    ...overrides,
  };
  database
    .prepare(
      `
        INSERT INTO portfolio_daily_snapshots (
          id, user_id, portfolio_id, snapshot_date, base_currency_code,
          coverage_json, completeness, status, ledger_high_water,
          calculation_version, rebuilt_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      values.id,
      values.user_id,
      values.portfolio_id,
      values.snapshot_date,
      values.base_currency_code,
      values.coverage_json,
      values.completeness,
      values.status,
      values.ledger_high_water,
      values.calculation_version,
      values.rebuilt_at,
    );
}

test("snapshots keep calculation versions isolated and holding links are owner-scoped", async () => {
  const database = await createMigratedDatabase();
  seedPortfolio(database);
  insertPortfolioSnapshot(database);
  insertPortfolioSnapshot(database, {
    id: "snapshot-a-v2",
    calculation_version: 2,
  });

  assert.throws(
    () => insertPortfolioSnapshot(database),
    /UNIQUE constraint failed/,
  );

  database
    .prepare(
      `
        INSERT INTO holding_daily_snapshots (
          id, user_id, portfolio_id, portfolio_security_id,
          portfolio_snapshot_id, snapshot_date, quantity_decimal,
          completeness, status, calculation_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
      "holding-a-v1",
      "user-a",
      "portfolio-a",
      "membership-a",
      "snapshot-a-v1",
      "2026-07-29",
      "10",
      "complete",
      "ready",
      1,
    );

  assert.throws(() => {
    database
      .prepare(
        `
          INSERT INTO holding_daily_snapshots (
            id, user_id, portfolio_id, portfolio_security_id,
            portfolio_snapshot_id, snapshot_date, quantity_decimal,
            completeness, status, calculation_version
          ) VALUES ('holding-mixed', 'user-a', 'portfolio-a', 'membership-a',
                    'snapshot-a-v1', '2026-07-29', '10', 'complete', 'ready', 2)
        `,
      )
      .run();
  }, /FOREIGN KEY constraint failed/);

  assert.throws(() => {
    database
      .prepare(
        `
          INSERT INTO holding_daily_snapshots (
            id, user_id, portfolio_id, portfolio_security_id,
            portfolio_snapshot_id, snapshot_date, quantity_decimal,
            completeness, status, calculation_version
          ) VALUES ('holding-cross-owner', 'user-b', 'portfolio-b', 'membership-a',
                    'snapshot-a-v1', '2026-07-29', '10', 'complete', 'ready', 1)
        `,
      )
      .run();
  }, /FOREIGN KEY constraint failed/);
});

test("calculation runs are idempotent, leased, and reject stale ledger completion", async () => {
  const database = await createMigratedDatabase();
  seedPortfolio(database);
  const runs = createCalculationRunRepository(createSqliteSqlClient(database));

  const first = await runs.request("user-a", {
    id: "run-a-1",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-07-01",
    rangeTo: "2026-07-29",
    calculationVersion: 1,
    reason: "transaction_change",
    ledgerHighWaterStart: "ledger-100",
    idempotencyKey: "rebuild-1",
    now: "2026-07-30T00:00:00Z",
  });
  const retry = await runs.request("user-a", {
    id: "run-a-retry",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-07-01",
    rangeTo: "2026-07-29",
    calculationVersion: 1,
    reason: "retry",
    ledgerHighWaterStart: "ledger-100",
    idempotencyKey: "rebuild-1",
    now: "2026-07-30T00:01:00Z",
  });
  assert.equal(retry.id, first.id);

  const claimed = await runs.claim(
    "user-a",
    "portfolio-a",
    first.id,
    "worker-1",
    "2026-07-30T00:10:00Z",
    "2026-07-30T00:05:00Z",
  );
  assert.equal(claimed.ok, true);
  const concurrentClaim = await runs.claim(
    "user-a",
    "portfolio-a",
    first.id,
    "worker-2",
    "2026-07-30T00:11:00Z",
    "2026-07-30T00:06:00Z",
  );
  assert.deepEqual(concurrentClaim, { ok: false, reason: "not-claimable" });

  const staleCompletion = await runs.complete(
    "user-a",
    "portfolio-a",
    first.id,
    "worker-1",
    "ledger-101",
    "2026-07-30T00:07:00Z",
    1,
    1,
  );
  assert.deepEqual(staleCompletion, { ok: false, reason: "stale-ledger" });

  const validRequest = await runs.request("user-a", {
    id: "run-a-2",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-07-01",
    rangeTo: "2026-07-29",
    calculationVersion: 1,
    reason: "retry_after_change",
    ledgerHighWaterStart: "ledger-101",
    idempotencyKey: "rebuild-2",
    now: "2026-07-30T00:08:00Z",
  });
  const validClaim = await runs.claim(
    "user-a",
    "portfolio-a",
    validRequest.id,
    "worker-3",
    "2026-07-30T00:20:00Z",
    "2026-07-30T00:09:00Z",
  );
  assert.equal(validClaim.ok, true);
  const completed = await runs.complete(
    "user-a",
    "portfolio-a",
    validRequest.id,
    "worker-3",
    "ledger-101",
    "2026-07-30T00:10:00Z",
    2,
    3,
  );
  assert.equal(completed.ok, true);
  if (completed.ok) {
    assert.equal(completed.run.status, "completed");
    assert.equal(completed.run.ledgerHighWaterEnd, "ledger-101");
    assert.equal(completed.run.processedHoldingCount, 3);
  }

  assert.deepEqual(
    await runs.claim(
      "user-b",
      "portfolio-a",
      validRequest.id,
      "worker-b",
      "2026-07-30T00:20:00Z",
      "2026-07-30T00:11:00Z",
    ),
    { ok: false, reason: "not-claimable" },
  );
});
