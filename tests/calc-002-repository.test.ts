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
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version) VALUES
      ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1),
      ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
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
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
      VALUES
      ('price-a', 'provider-a', 'deployment', NULL, 'deployment', 'mapping-a', 'security-a', 'eod', '2026-08-01T08:00:00Z', '2026-08-01', 'UTC', 'AUD', '10', 'raw', 'observed', '2026-08-01T09:00:00Z'),
      ('price-b', 'provider-a', 'deployment', NULL, 'deployment', 'mapping-a', 'security-a', 'eod', '2026-08-02T08:00:00Z', '2026-08-02', 'UTC', 'AUD', '11', 'raw', 'observed', '2026-08-02T09:00:00Z'),
      ('price-private-b', 'provider-a', 'user', 'user-b', 'user-b', 'mapping-a', 'security-a', 'eod', '2026-08-02T10:00:00Z', '2026-08-02', 'UTC', 'AUD', '999', 'raw', 'observed', '2026-08-02T11:00:00Z');
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
    marketDataCutoff: "2026-08-03T00:00:00Z",
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
  db.exec(`
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
      VALUES ('price-correction-after-cutoff', 'provider-a', 'deployment', NULL, 'deployment', 'mapping-a', 'security-a', 'eod', '2026-08-02T12:00:00Z', '2026-08-02', 'UTC', 'AUD', '999', 'raw', 'corrected', '2026-08-04T00:00:00Z');
  `);
  const replacement = await repository.request("user-a", {
    id: "run-a-replacement",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-02",
    calculationVersion: 7,
    reason: "same-version-correction",
    ledgerHighWaterStart: "trade-a",
    marketDataCutoff: "2026-08-03T00:00:00Z",
    idempotencyKey: "history-7-replacement",
    now: "2026-08-05T00:00:00Z",
  });
  assert.equal(
    (
      await repository.claim(
        "user-a",
        "portfolio-a",
        replacement.id,
        "worker-b",
        "2026-08-05T01:00:00Z",
        "2026-08-05T00:01:00Z",
      )
    ).ok,
    true,
  );
  const replacementFirst = await repository.rebuild("user-a", {
    portfolioId: "portfolio-a",
    calculationRunId: replacement.id,
    leaseOwner: "worker-b",
    currentLedgerHighWater: "trade-a",
    now: "2026-08-05T00:02:00Z",
  });
  assert.equal(replacementFirst.ok && replacementFirst.status, "progress");
  assert.equal(
    (
      await repository.rebuild("user-a", {
        portfolioId: "portfolio-a",
        calculationRunId: replacement.id,
        leaseOwner: "worker-wrong",
        currentLedgerHighWater: "trade-a",
        now: "2026-08-05T00:03:00Z",
      })
    ).ok,
    false,
  );
  assert.deepEqual(
    (
      await repository.loadSeries(
        "user-a",
        "portfolio-a",
        "2026-08-01",
        "2026-08-02",
        7,
      )
    )?.points.map((point) => point.totalValueDecimal),
    ["100", "110"],
  );
  const replacementComplete = await repository.rebuild("user-a", {
    portfolioId: "portfolio-a",
    calculationRunId: replacement.id,
    leaseOwner: "worker-b",
    currentLedgerHighWater: "trade-a",
    now: "2026-08-05T00:04:00Z",
  });
  assert.equal(
    replacementComplete.ok && replacementComplete.status,
    "completed",
  );
  const publishedRun = db
    .prepare(
      "SELECT calculation_run_id FROM snapshot_publications WHERE portfolio_id = 'portfolio-a' AND calculation_version = 7",
    )
    .get() as { calculation_run_id: string };
  assert.equal(publishedRun.calculation_run_id, "run-a-replacement");
  assert.deepEqual(
    (
      await repository.loadSeries(
        "user-a",
        "portfolio-a",
        "2026-08-01",
        "2026-08-02",
        7,
      )
    )?.points.map((point) => point.totalValueDecimal),
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
    4,
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

test("CALC-002 excludes another owner's scoped FX observations", async () => {
  const db = await database();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
      VALUES ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO cash_accounts (id, user_id, portfolio_id, currency_code, completeness, status)
      VALUES ('cash-usd', 'user-a', 'portfolio-a', 'USD', 'complete', 'active');
    INSERT INTO cash_ledger_entries (id, user_id, portfolio_id, cash_account_id, transaction_id, effective_at, local_effective_date, type, signed_amount_decimal, status, reverses_entry_id, created_at)
      VALUES ('cash-entry-usd', 'user-a', 'portfolio-a', 'cash-usd', NULL, '2026-08-01T01:00:00Z', '2026-08-01', 'cash_deposit', '10', 'posted', NULL, '2026-08-01T01:00:00Z');
    INSERT INTO fx_rate_observations (id, provider_id, access_scope, scope_user_id, scope_key, base_currency_code, quote_currency_code, rate_decimal, interval, observed_at, market_date, quality, ingested_at)
      VALUES ('fx-private-b', 'provider-a', 'user', 'user-b', 'user-b', 'AUD', 'USD', '0.5', 'eod', '2026-08-01T08:00:00Z', '2026-08-01', 'observed', '2026-08-01T09:00:00Z');
  `);
  const repository = createHistoricalSnapshotRepository(
    createSqliteSqlClient(db),
  );
  const run = await repository.request("user-a", {
    id: "run-private-fx",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-01",
    calculationVersion: 8,
    reason: "owner-scope-regression",
    ledgerHighWaterStart: "trade-a",
    idempotencyKey: "owner-scope-regression",
    now: "2026-08-03T00:00:00Z",
  });
  const claimed = await repository.claim(
    "user-a",
    "portfolio-a",
    run.id,
    "worker-a",
    "2026-08-03T01:00:00Z",
    "2026-08-03T00:01:00Z",
  );
  assert.equal(claimed.ok, true);
  const rebuilt = await repository.rebuild("user-a", {
    portfolioId: "portfolio-a",
    calculationRunId: run.id,
    leaseOwner: "worker-a",
    currentLedgerHighWater: "trade-a",
    now: "2026-08-03T00:02:00Z",
  });
  assert.equal(rebuilt.ok && rebuilt.status, "completed");
  const series = await repository.loadSeries(
    "user-a",
    "portfolio-a",
    "2026-08-01",
    "2026-08-01",
    8,
  );
  assert.equal(series?.points[0]?.cashValueDecimal, null);
  assert.equal(series?.points[0]?.totalValueDecimal, null);
  assert.deepEqual(series?.points[0]?.coverage.excludedCashAccountIds, [
    "cash-usd",
  ]);
});

test("CALC-002 rejects a fact set over the bounded rebuild budget before loading rows", async () => {
  const db = await database();
  const repository = createHistoricalSnapshotRepository(
    createSqliteSqlClient(db),
    {
      maxFacts: 1,
    },
  );
  const run = await repository.request("user-a", {
    id: "run-fact-limit",
    portfolioId: "portfolio-a",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-01",
    calculationVersion: 9,
    reason: "fact-limit",
    ledgerHighWaterStart: "trade-a",
    idempotencyKey: "fact-limit",
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
  assert.deepEqual(
    await repository.rebuild("user-a", {
      portfolioId: "portfolio-a",
      calculationRunId: run.id,
      leaseOwner: "worker-a",
      currentLedgerHighWater: "trade-a",
      now: "2026-08-03T00:02:00Z",
    }),
    { ok: false, reason: "build-failed" },
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM portfolio_daily_snapshots WHERE calculation_version = 9",
        )
        .get() as { count: number }
    ).count,
    0,
  );
});
