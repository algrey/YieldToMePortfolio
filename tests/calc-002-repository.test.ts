import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createHistoricalSnapshotRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";

async function database(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active) VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version) VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, history_complete_from, status, created_at, updated_at, version)
      VALUES ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', '2026-08-01', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
      VALUES ('security-a', 'equity', 'AUD', 'Example', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO market_data_providers (id, code, name, status, capabilities_json, rate_limit_json)
      VALUES ('provider-a', 'fixture', 'Fixture', 'enabled', '{}', '{}');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-a', 'security-a', 'provider-a', 'XASX', 'ABC', '2026-01-01', 'verified');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
      VALUES ('holding-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'AUD', 'held', '2026-08-01', '2026-08-01');
    INSERT INTO transactions (id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at, local_trade_date, quantity_decimal, unit_price_decimal, currency_code, gross_amount_decimal, fee_amount_decimal, tax_amount_decimal, fx_rate_to_base_decimal, source_type, created_by_user_id, calculation_version, created_at)
      VALUES ('trade-a', 'user-a', 'portfolio-a', 'holding-a', 'buy', 'posted', '2026-08-01T01:00:00Z', '2026-08-01', '10', '10', 'AUD', '100', '0', '0', '1', 'manual', 'user-a', 1, '2026-08-01');
    INSERT INTO price_observations (id, provider_id, access_scope, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
      VALUES
      ('price-a', 'provider-a', 'deployment', 'deployment', 'mapping-a', 'security-a', 'eod', '2026-08-01T08:00:00Z', '2026-08-01', 'UTC', 'AUD', '10', 'raw', 'observed', '2026-08-01T09:00:00Z'),
      ('price-b', 'provider-a', 'deployment', 'deployment', 'mapping-a', 'security-a', 'eod', '2026-08-02T08:00:00Z', '2026-08-02', 'UTC', 'AUD', '11', 'raw', 'observed', '2026-08-02T09:00:00Z');
  `);
  return db;
}

test("CALC-002 rebuild is owner-scoped, bounded, resumable, and only completed runs publish chart points", async () => {
  const db = await database();
  const sql = createSqliteSqlClient(db);
  const repository = createHistoricalSnapshotRepository(sql, {
    maxHoldingRowsPerChunk: 1,
  });
  const run = await repository.request("user-a", {
    id: "run-a",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-02",
    calculationVersion: 7,
    reason: "historical_rebuild",
    ledgerHighWaterStart: "trade-a",
    idempotencyKey: "history-7",
    now: "2026-08-03T00:00:00Z",
  });
  assert.equal(
    (
      await repository.claim(
        "user-a",
        "portfolio-a",
        run.id,
        "worker-a",
        "2026-08-03T01:00:00Z",
        "2026-08-03T00:01:00Z",
      )
    ).ok,
    true,
  );
  assert.equal(
    (
      await repository.rebuild("user-b", {
        portfolioId: "portfolio-a",
        calculationRunId: run.id,
        leaseOwner: "worker-a",
        currentLedgerHighWater: "trade-a",
        now: "2026-08-03T00:02:00Z",
      })
    ).ok,
    false,
  );
  const first = await repository.rebuild("user-a", {
    portfolioId: "portfolio-a",
    calculationRunId: run.id,
    leaseOwner: "worker-a",
    currentLedgerHighWater: "trade-a",
    now: "2026-08-03T00:02:00Z",
  });
  assert.equal(first.ok && first.status, "progress");
  assert.equal(
    await repository.loadSeries(
      "user-a",
      "portfolio-a",
      "2026-08-01",
      "2026-08-02",
      7,
    ),
    null,
  );
  await repository.rebuild("user-a", {
    portfolioId: "portfolio-a",
    calculationRunId: run.id,
    leaseOwner: "worker-a",
    currentLedgerHighWater: "trade-a",
    now: "2026-08-03T00:03:00Z",
  });
  await repository.rebuild("user-a", {
    portfolioId: "portfolio-a",
    calculationRunId: run.id,
    leaseOwner: "worker-a",
    currentLedgerHighWater: "trade-a",
    now: "2026-08-03T00:04:00Z",
  });
  const series = await repository.loadSeries(
    "user-a",
    "portfolio-a",
    "2026-08-01",
    "2026-08-02",
    7,
  );
  assert.ok(series);
  assert.deepEqual(
    series?.points.map((point) => point.totalValueDecimal),
    ["100", "110"],
  );
  assert.equal(
    await repository.invalidateRange(
      "user-a",
      "portfolio-a",
      "2026-08-02",
      "2026-08-02",
      7,
    ),
    2,
  );
  assert.equal(
    (
      await repository.loadSeries(
        "user-a",
        "portfolio-a",
        "2026-08-01",
        "2026-08-02",
        7,
      )
    )?.points.length,
    1,
  );
});
