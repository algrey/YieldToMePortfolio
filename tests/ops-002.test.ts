import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  verifyRestoredDatabase,
  type RestoreEvidence,
} from "../scripts/ops-002-restore-drill.ts";

const MIGRATION_DIRECTORY = new URL("../drizzle/", import.meta.url);

async function migrationSql(): Promise<string> {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(MIGRATION_DIRECTORY))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  return (
    await Promise.all(
      files.map((file) =>
        readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");
}

function fixtureSeedSql(): string {
  return `
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (
      id, status, primary_email, timezone, created_at, updated_at, version
    ) VALUES
      ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
      ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone,
      accounting_method, status, created_at, updated_at, version
    ) VALUES
      ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1),
      ('portfolio-b', 'user-b', 'B', 'Bob', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO transactions (
      id, user_id, portfolio_id, type, status, trade_at, local_trade_date,
      currency_code, gross_amount_decimal, fee_amount_decimal,
      tax_amount_decimal, source_type, created_by_user_id,
      calculation_version, created_at
    ) VALUES (
      'transaction-a', 'user-a', 'portfolio-a', 'cash_deposit', 'posted',
      '2026-08-03T00:00:00Z', '2026-08-03', 'AUD', '100.00', '0', '0',
      'manual', 'user-a', 1, '2026-08-03T00:00:00Z'
    );
    INSERT INTO portfolio_daily_snapshots (
      id, user_id, portfolio_id, snapshot_date, base_currency_code,
      total_value_decimal, cost_basis_decimal, coverage_json, completeness,
      status, ledger_high_water, calculation_version, rebuilt_at
    ) VALUES (
      'snapshot-a', 'user-a', 'portfolio-a', '2026-08-03', 'AUD',
      '100.00', '100.00', '{}', 'complete', 'ready', 'ledger-1', 1,
      '2026-08-03T00:01:00Z'
    );
    INSERT INTO calculation_runs (
      id, user_id, portfolio_id, range_from, range_to, calculation_version,
      reason, status, attempt, ledger_high_water_start,
      processed_snapshot_count, processed_holding_count, idempotency_key,
      created_at, updated_at
    ) VALUES (
      'run-a', 'user-a', 'portfolio-a', '2026-08-03', '2026-08-03', 1,
      'transaction_change', 'completed', 1, 'ledger-1', 1, 0, 'run-1',
      '2026-08-03T00:01:00Z', '2026-08-03T00:01:00Z'
    );
    INSERT INTO audit_events (
      id, actor_user_id, target_owner_user_id, action, target_type,
      target_id, request_id, result, metadata_json, occurred_at
    ) VALUES (
      'audit-a', 'user-a', 'user-a', 'restore.fixture', 'test',
      'fixture', 'request-a', 'success', '{}', '2026-08-03T00:01:00Z'
    );
  `;
}

async function createSqlFixture(directory: string): Promise<string> {
  const path = join(directory, "source.sql");
  await writeFile(path, `${await migrationSql()}\n${fixtureSeedSql()}`);
  return path;
}

async function createSqliteCopy(
  sqlPath: string,
  directory: string,
): Promise<string> {
  const source = new DatabaseSync(":memory:");
  source.exec(await readFile(sqlPath, "utf8"));
  const sqlitePath = join(directory, "restored.sqlite");
  const serialized = (
    source as DatabaseSync & { serialize: () => Uint8Array }
  ).serialize();
  await writeFile(sqlitePath, serialized);
  source.close();
  return sqlitePath;
}

test("verifies a restored SQL export and emits non-payload evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yieldtome-ops-002-"));
  try {
    const sourcePath = await createSqlFixture(directory);
    const result = await verifyRestoredDatabase(sourcePath, {
      migrationDirectory: new URL("../drizzle", import.meta.url).pathname,
      requiredTables: [
        "portfolios",
        "transactions",
        "portfolio_daily_snapshots",
        "calculation_runs",
        "audit_events",
      ],
      now: "2026-08-03T01:00:00Z",
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.evidence.foreignKeysEnabled, true);
    assert.equal(result.evidence.applicationSmoke.ok, true);
    assert.equal(result.evidence.applicationSmoke.portfolioCount, 2);
    assert.equal(result.evidence.applicationSmoke.calculationRunCount, 1);
    assert.equal(result.evidence.tables.transactions.rowCount, 1);
    assert.equal(
      result.evidence.ownershipCounts["transactions.user_id"]?.["user-a"],
      1,
    );
    assert.equal(JSON.stringify(result.evidence).includes("100.00"), false);
    assert.equal(
      JSON.stringify(result.evidence).includes("transaction-a"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("matches restored SQLite evidence and rejects a tampered restore", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yieldtome-ops-002-"));
  try {
    const sourcePath = await createSqlFixture(directory);
    const sourceResult = await verifyRestoredDatabase(sourcePath, {
      migrationDirectory: new URL("../drizzle", import.meta.url).pathname,
      requiredTables: [
        "portfolios",
        "portfolio_daily_snapshots",
        "calculation_runs",
      ],
      now: "2026-08-03T01:00:00Z",
    });
    assert.equal(sourceResult.ok, true);
    if (!sourceResult.ok) return;

    const restoredPath = await createSqliteCopy(sourcePath, directory);
    const matching = await verifyRestoredDatabase(restoredPath, {
      migrationDirectory: new URL("../drizzle", import.meta.url).pathname,
      requiredTables: [
        "portfolios",
        "portfolio_daily_snapshots",
        "calculation_runs",
      ],
      expectedEvidence: sourceResult.evidence as RestoreEvidence,
      now: "2026-08-03T01:01:00Z",
    });
    assert.equal(matching.ok, true);

    const tampered = new DatabaseSync(restoredPath);
    tampered.exec(
      "UPDATE transactions SET gross_amount_decimal = '999.00' WHERE id = 'transaction-a'",
    );
    const serialized = (
      tampered as DatabaseSync & { serialize: () => Uint8Array }
    ).serialize();
    await writeFile(restoredPath, serialized);
    tampered.close();

    const rejected = await verifyRestoredDatabase(restoredPath, {
      migrationDirectory: new URL("../drizzle", import.meta.url).pathname,
      requiredTables: [
        "portfolios",
        "portfolio_daily_snapshots",
        "calculation_runs",
      ],
      expectedEvidence: sourceResult.evidence as RestoreEvidence,
      now: "2026-08-03T01:02:00Z",
    });
    assert.equal(rejected.ok, false);
    if (rejected.ok) return;
    assert.equal(
      rejected.errors.some((error) => error.includes("transactions")),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
