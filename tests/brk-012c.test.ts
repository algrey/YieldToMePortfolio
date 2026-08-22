/**
 * BRK-012C — the delayed-price cache + 10-minute read gate: this is the
 * slice that finally shows Sharesight prices in the holdings view.
 *
 * Covers: the `sharesight_delayed_prices` cache/lease repository
 * (`db/repositories/sharesight-delayed-price-cache.ts`); the per-owner
 * watermark read/write (`db/repositories/sharesight-price-refresh.ts`); the
 * four-gate read service (`app/sharesight-price-gate-service.ts`); the
 * wired-in `app/owned-holdings.ts` read path (lifted exclusion, gate call,
 * "Delayed (Sharesight)" labelling); the migration chain (new table, new
 * lease columns, purge-lock triggers, export/purge classification); and
 * that the historical/snapshot EOD path is untouched.
 *
 * Review round (2026-08-20, FAIL -- three blockers, all fixed and
 * re-drilled here):
 *   B1: staleness is now a PER-OWNER watermark fact, not a per-security
 *   cache scan -- a held-but-Sharesight-unmatched security can never have a
 *   cache row, which previously made the gate report "stale" on EVERY
 *   load of any mixed portfolio.
 *   B2: `loadSharesightDelayedPriceCache`'s `IN (...)` clause is now
 *   chunked (<=50 ids/statement); a fetch failure now stamps the shared
 *   watermark for observability instead of relying on the silent catch
 *   alone.
 *   B3 (daily-movement honesty) is covered in `tests/ui-003.test.ts`
 *   (that is where the original, now-corrected assertion lived) plus a
 *   source-text check here that the honest label actually renders.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/sql-client.ts";
import {
  claimSharesightPriceGateLease,
  hasEnabledSharesightLink,
  loadSharesightDelayedPriceCache,
  releaseSharesightPriceGateLease,
  upsertSharesightDelayedPriceCache,
} from "../db/repositories/sharesight-delayed-price-cache.ts";
import {
  loadSharesightPriceRefreshWatermark,
  recordSharesightPriceRefreshWatermark,
} from "../db/repositories/sharesight-price-refresh.ts";
import { ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS } from "../db/repositories/account-lifecycle.ts";
import {
  ensureSharesightPriceFreshness,
  isSharesightPriceWatermarkStale,
  SHARESIGHT_PRICE_GATE_MAX_AGE_MS,
} from "../app/sharesight-price-gate-service.ts";
import { loadOwnedHoldings } from "../app/owned-holdings.ts";
import type {
  SharesightClient,
  SharesightResult,
  SharesightUserInstrument,
} from "../domain/sharesight/index.ts";
import type { SharesightIntegrationConfig } from "../worker/sharesight-config.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  return db;
}

/**
 * Two owners, one AUD-denominated security each (avoids FX entirely, so
 * assertions can focus on the price gate/selection), both with an ENABLED
 * Sharesight link and a completed/ready projection so `loadOwnedHoldings`
 * reads all the way through.
 */
async function gateFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('owner-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1),
           ('owner-b', 'active', 'b@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'owner-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1),
           ('portfolio-b', 'owner-b', 'B', 'B portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-b', 'Beta', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('holding-a', 'owner-a', 'portfolio-a', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('holding-b', 'owner-b', 'portfolio-b', 'security-b', 'DEF', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
    INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, valid_to, source)
    VALUES ('ident-a', 'security-a', 'sharesight_instrument', '101', '2026-08-01', NULL, 'sharesight'),
           ('ident-b', 'security-b', 'sharesight_instrument', '202', '2026-08-01', NULL, 'sharesight');
    INSERT INTO sharesight_sync_state (
      id, user_id, portfolio_id, sharesight_portfolio_id, enabled,
      last_synced_at, last_trade_watermark, created_at, updated_at, version
    ) VALUES
      ('sync-a', 'owner-a', 'portfolio-a', 'sp-a', 1, NULL, NULL, '2026-08-01', '2026-08-01', 1),
      ('sync-b', 'owner-b', 'portfolio-b', 'sp-b', 1, NULL, NULL, '2026-08-01', '2026-08-01', 1);
    INSERT INTO calculation_runs (id, user_id, portfolio_id, range_from, range_to, calculation_version, reason, ledger_high_water_start, ledger_high_water_end, idempotency_key, created_at, updated_at, status)
    VALUES ('run-a', 'owner-a', 'portfolio-a', '2026-08-20', '2026-08-20', 1, 'test', '1', '1', 'run-a', '2026-08-20', '2026-08-20', 'completed'),
           ('run-b', 'owner-b', 'portfolio-b', '2026-08-20', '2026-08-20', 1, 'test', '1', '1', 'run-b', '2026-08-20', '2026-08-20', 'completed');
    INSERT INTO projection_publications (user_id, portfolio_id, calculation_run_id, calculation_version, ledger_high_water, published_at)
    VALUES ('owner-a', 'portfolio-a', 'run-a', 1, '1', '2026-08-20T01:00:00Z'),
           ('owner-b', 'portfolio-b', 'run-b', 1, '1', '2026-08-20T01:00:00Z');
    INSERT INTO holding_projections (id, user_id, portfolio_id, portfolio_security_id, quantity_decimal, native_open_basis_decimal, base_open_basis_decimal, average_base_cost_decimal, completeness, status, last_ledger_high_water, calculation_run_id, calculation_version, rebuilt_at)
    VALUES ('projection-a', 'owner-a', 'portfolio-a', 'holding-a', '2', '10', '10', '5', 'complete', 'ready', '1', 'run-a', 1, '2026-08-20T01:00:00Z'),
           ('projection-b', 'owner-b', 'portfolio-b', 'holding-b', '2', '10', '10', '5', 'complete', 'ready', '1', 'run-b', 1, '2026-08-20T01:00:00Z');
  `);
  return db;
}

/** Adds a THIRD held security for owner-a with NO `sharesight_instrument`
 * identifier -- Sharesight can structurally never match it. This is the
 * exact B1 pin fixture: a mixed portfolio (one matched, one unmatched
 * security). */
function addUnmatchedSecurity(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-unmatched', 'Gamma', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('holding-unmatched', 'owner-a', 'portfolio-a', 'security-unmatched', 'GHI', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
    INSERT INTO holding_projections (id, user_id, portfolio_id, portfolio_security_id, quantity_decimal, native_open_basis_decimal, base_open_basis_decimal, average_base_cost_decimal, completeness, status, last_ledger_high_water, calculation_run_id, calculation_version, rebuilt_at)
    VALUES ('projection-unmatched', 'owner-a', 'portfolio-a', 'holding-unmatched', '1', '1', '1', '1', 'complete', 'ready', '1', 'run-a', 1, '2026-08-20T01:00:00Z');
  `);
}

/** One owner, `count` held securities, ALL Sharesight-matched -- for the
 * B2 bind-parameter budget drill. */
async function manySecuritiesFixture(count: number): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('owner-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'owner-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO sharesight_sync_state (id, user_id, portfolio_id, sharesight_portfolio_id, enabled, last_synced_at, last_trade_watermark, created_at, updated_at, version)
    VALUES ('sync-a', 'owner-a', 'portfolio-a', 'sp-a', 1, NULL, NULL, '2026-08-01', '2026-08-01', 1);
    INSERT INTO calculation_runs (id, user_id, portfolio_id, range_from, range_to, calculation_version, reason, ledger_high_water_start, ledger_high_water_end, idempotency_key, created_at, updated_at, status)
    VALUES ('run-a', 'owner-a', 'portfolio-a', '2026-08-20', '2026-08-20', 1, 'test', '1', '1', 'run-a', '2026-08-20', '2026-08-20', 'completed');
    INSERT INTO projection_publications (user_id, portfolio_id, calculation_run_id, calculation_version, ledger_high_water, published_at)
    VALUES ('owner-a', 'portfolio-a', 'run-a', 1, '1', '2026-08-20T01:00:00Z');
  `);
  const insertSecurity = db.prepare(
    `INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
     VALUES (?, ?, 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01')`,
  );
  const insertMembership = db.prepare(
    `INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
     VALUES (?, 'owner-a', 'portfolio-a', ?, ?, 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01')`,
  );
  const insertIdentifier = db.prepare(
    `INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, valid_to, source)
     VALUES (?, ?, 'sharesight_instrument', ?, '2026-08-01', NULL, 'sharesight')`,
  );
  const insertProjection = db.prepare(
    `INSERT INTO holding_projections (id, user_id, portfolio_id, portfolio_security_id, quantity_decimal, native_open_basis_decimal, base_open_basis_decimal, average_base_cost_decimal, completeness, status, last_ledger_high_water, calculation_run_id, calculation_version, rebuilt_at)
     VALUES (?, 'owner-a', 'portfolio-a', ?, '1', '1', '1', '1', 'complete', 'ready', '1', 'run-a', 1, '2026-08-20T01:00:00Z')`,
  );
  for (let index = 0; index < count; index += 1) {
    const securityId = `security-${index}`;
    insertSecurity.run(securityId, `Security ${index}`);
    insertMembership.run(`holding-${index}`, securityId, `SYM${index}`);
    insertIdentifier.run(`ident-${index}`, securityId, String(1000 + index));
    insertProjection.run(`projection-${index}`, `holding-${index}`);
  }
  return db;
}

function fakeSharesightClient(
  result: SharesightResult<SharesightUserInstrument[]>,
): { client: SharesightClient; state: { callCount: number } } {
  const state = { callCount: 0 };
  const client: SharesightClient = {
    async listPortfolios() {
      return { ok: true, value: [] };
    },
    async getPortfolioHoldings() {
      return { ok: true, value: [] };
    },
    async listTrades() {
      return { ok: true, value: [] };
    },
    async listPayouts() {
      return { ok: true, value: [] };
    },
    async listUserInstruments() {
      state.callCount += 1;
      return result;
    },
  };
  return { client, state };
}

function integrationOf(fake: {
  client: SharesightClient;
}): SharesightIntegrationConfig {
  return { enabled: true, client: fake.client };
}

const NOT_CONFIGURED: SharesightIntegrationConfig = {
  enabled: false,
  reason: "not_configured",
};

function instrument(
  overrides: Partial<SharesightUserInstrument> = {},
): SharesightUserInstrument {
  return {
    id: "101",
    code: "ABC",
    marketCode: "ASX",
    currencyCode: "AUD",
    currentPriceDecimal: "12.34",
    currentPriceUpdatedAt: "2026-08-20T16:10:03+10:00",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) Repository: db/repositories/sharesight-delayed-price-cache.ts +
//     db/repositories/sharesight-price-refresh.ts's watermark read
// ---------------------------------------------------------------------------

test("BRK-012C gate boundary: isSharesightPriceWatermarkStale -- 9m59s is fresh, 10m01s is stale, no attempt ever recorded is stale", () => {
  const lastAttemptAt = "2026-08-20T05:00:00.000Z";
  const justUnder = new Date(
    Date.parse(lastAttemptAt) + 9 * 60_000 + 59_000,
  ).toISOString();
  const justOver = new Date(
    Date.parse(lastAttemptAt) + 10 * 60_000 + 1_000,
  ).toISOString();
  assert.equal(
    isSharesightPriceWatermarkStale(
      lastAttemptAt,
      justUnder,
      SHARESIGHT_PRICE_GATE_MAX_AGE_MS,
    ),
    false,
  );
  assert.equal(
    isSharesightPriceWatermarkStale(
      lastAttemptAt,
      justOver,
      SHARESIGHT_PRICE_GATE_MAX_AGE_MS,
    ),
    true,
  );
  assert.equal(
    isSharesightPriceWatermarkStale(
      null,
      justUnder,
      SHARESIGHT_PRICE_GATE_MAX_AGE_MS,
    ),
    true,
  );
});

test("BRK-012C repository: loadSharesightPriceRefreshWatermark reads the shared BRK-012B watermark, owner-scoped, null when never attempted", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  assert.equal(
    await loadSharesightPriceRefreshWatermark(client, "owner-a"),
    null,
  );
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "owner-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-20T06:00:00.000Z",
  });
  assert.equal(
    await loadSharesightPriceRefreshWatermark(client, "owner-a"),
    "2026-08-20T06:00:00.000Z",
  );
  // Owner-scoped -- owner-b's own watermark is untouched.
  assert.equal(
    await loadSharesightPriceRefreshWatermark(client, "owner-b"),
    null,
  );
});

test("BRK-012C repository (B2 fix): loadSharesightDelayedPriceCache chunks a 60-id request into multiple <=50-id statements, still returns every row", async () => {
  const db = await manySecuritiesFixture(60);
  const client = createSqliteSqlClient(db);
  const candidates = Array.from({ length: 60 }, (_, index) => ({
    securityId: `security-${index}`,
    instrumentCode: `SYM${index}`,
    marketCode: "ASX",
    currencyCode: "AUD",
    closeDecimal: "1.00",
    marketDate: "2026-08-20",
    marketTimezone: "+10:00",
    observationAt: "2026-08-20T05:00:00.000Z",
  }));
  await upsertSharesightDelayedPriceCache(client, {
    userId: "owner-a",
    candidates,
    now: "2026-08-20T05:00:00.000Z",
  });
  let queryCount = 0;
  let maxParams = 0;
  const countingClient = {
    ...client,
    all: async <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      queryCount += 1;
      maxParams = Math.max(maxParams, params.length);
      return client.all<T>(sql, params);
    },
  };
  const securityIds = candidates.map((candidate) => candidate.securityId);
  const cache = await loadSharesightDelayedPriceCache(
    countingClient,
    "owner-a",
    securityIds,
  );
  assert.equal(cache.size, 60);
  // 60 ids at <=50/chunk must be at least 2 chunked queries, each with at
  // most 51 bind params (1 userId + <=50 ids) -- the B2 fix.
  assert.equal(queryCount, 2);
  assert.ok(maxParams <= 51, `expected maxParams <= 51, got ${maxParams}`);
});

test("BRK-012C repository: loadSharesightDelayedPriceCache is owner-scoped -- owner-a never sees owner-b's cache row", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  await upsertSharesightDelayedPriceCache(client, {
    userId: "owner-a",
    candidates: [
      {
        securityId: "security-a",
        instrumentCode: "ABC",
        marketCode: "ASX",
        currencyCode: "AUD",
        closeDecimal: "5.10",
        marketDate: "2026-08-20",
        marketTimezone: "+10:00",
        observationAt: "2026-08-20T06:10:03.000Z",
      },
    ],
    now: "2026-08-20T06:15:00.000Z",
  });
  const ownerACache = await loadSharesightDelayedPriceCache(client, "owner-a", [
    "security-a",
  ]);
  assert.equal(ownerACache.size, 1);
  assert.equal(ownerACache.get("security-a")?.priceDecimal, "5.10");
  const ownerBCache = await loadSharesightDelayedPriceCache(client, "owner-b", [
    "security-a",
  ]);
  assert.equal(ownerBCache.size, 0);
});

test("BRK-012C repository: upsertSharesightDelayedPriceCache overwrites the prior row entirely on re-fetch, never accumulates", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const candidate = (price: string, at: string) => ({
    securityId: "security-a",
    instrumentCode: "ABC",
    marketCode: "ASX",
    currencyCode: "AUD",
    closeDecimal: price,
    marketDate: "2026-08-20",
    marketTimezone: "+10:00",
    observationAt: at,
  });
  await upsertSharesightDelayedPriceCache(client, {
    userId: "owner-a",
    candidates: [candidate("5.00", "2026-08-20T04:00:00.000Z")],
    now: "2026-08-20T04:05:00.000Z",
  });
  await upsertSharesightDelayedPriceCache(client, {
    userId: "owner-a",
    candidates: [candidate("5.25", "2026-08-20T06:10:03.000Z")],
    now: "2026-08-20T06:15:00.000Z",
  });
  const rows = db
    .prepare(`SELECT price_decimal, fetched_at FROM sharesight_delayed_prices`)
    .all();
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...(rows[0] as Record<string, unknown>) },
    { price_decimal: "5.25", fetched_at: "2026-08-20T06:15:00.000Z" },
  );
});

test("BRK-012C repository: claimSharesightPriceGateLease is single-flight -- a second claim before release/expiry fails, a claim after expiry succeeds", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const first = await claimSharesightPriceGateLease(client, {
    userId: "owner-a",
    leaseOwner: "lease-1",
    now: "2026-08-20T06:00:00.000Z",
    leaseDurationMs: 60_000,
  });
  assert.equal(first, true);
  const second = await claimSharesightPriceGateLease(client, {
    userId: "owner-a",
    leaseOwner: "lease-2",
    now: "2026-08-20T06:00:30.000Z",
    leaseDurationMs: 60_000,
  });
  assert.equal(second, false, "the lease is still held by lease-1");
  const afterExpiry = await claimSharesightPriceGateLease(client, {
    userId: "owner-a",
    leaseOwner: "lease-3",
    now: "2026-08-20T06:01:01.000Z",
    leaseDurationMs: 60_000,
  });
  assert.equal(afterExpiry, true, "lease-1's lease has expired by now");
  await releaseSharesightPriceGateLease(client, {
    userId: "owner-a",
    leaseOwner: "lease-3",
    now: "2026-08-20T06:01:05.000Z",
  });
  const row = db
    .prepare(
      `SELECT price_refresh_lease_owner, price_refresh_lease_expires_at FROM sharesight_sync_state WHERE id = 'sync-a'`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...row },
    { price_refresh_lease_owner: null, price_refresh_lease_expires_at: null },
  );
});

test("BRK-012C repository: claimSharesightPriceGateLease never claims for an owner with no enabled link", async () => {
  const db = await gateFixture();
  db.exec(`UPDATE sharesight_sync_state SET enabled = 0 WHERE id = 'sync-a'`);
  const client = createSqliteSqlClient(db);
  const claimed = await claimSharesightPriceGateLease(client, {
    userId: "owner-a",
    leaseOwner: "lease-1",
    now: "2026-08-20T06:00:00.000Z",
    leaseDurationMs: 60_000,
  });
  assert.equal(claimed, false);
});

test("BRK-012C repository: a lease claimed for owner-a never blocks owner-b's own claim", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const ownerA = await claimSharesightPriceGateLease(client, {
    userId: "owner-a",
    leaseOwner: "lease-a",
    now: "2026-08-20T06:00:00.000Z",
    leaseDurationMs: 60_000,
  });
  const ownerB = await claimSharesightPriceGateLease(client, {
    userId: "owner-b",
    leaseOwner: "lease-b",
    now: "2026-08-20T06:00:00.000Z",
    leaseDurationMs: 60_000,
  });
  assert.equal(ownerA, true);
  assert.equal(ownerB, true);
});

test("BRK-012C repository: hasEnabledSharesightLink reflects only THIS owner's enabled link", async () => {
  const db = await gateFixture();
  db.exec(`UPDATE sharesight_sync_state SET enabled = 0 WHERE id = 'sync-b'`);
  const client = createSqliteSqlClient(db);
  assert.equal(await hasEnabledSharesightLink(client, "owner-a"), true);
  assert.equal(await hasEnabledSharesightLink(client, "owner-b"), false);
});

// ---------------------------------------------------------------------------
// (2) Service: app/sharesight-price-gate-service.ts
// ---------------------------------------------------------------------------

test("BRK-012C gate: no Sharesight credentials configured -- zero DB reads, zero fetch, action not_configured", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    { integration: NOT_CONFIGURED, now: () => "2026-08-20T06:00:00.000Z" },
  );
  assert.deepEqual(result, { ok: true, action: "not_configured" });
});

test("BRK-012C gate: credentials configured but this owner has no enabled link -- zero fetch, action not_linked", async () => {
  const db = await gateFixture();
  db.exec(`UPDATE sharesight_sync_state SET enabled = 0 WHERE id = 'sync-a'`);
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({ ok: true, value: [] });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    { integration: integrationOf(fake), now: () => "2026-08-20T06:00:00.000Z" },
  );
  assert.deepEqual(result, { ok: true, action: "not_linked" });
  assert.equal(fake.state.callCount, 0);
});

test("BRK-012C gate: no held securities is a no-op -- action no_holdings, zero fetch", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({ ok: true, value: [] });
  const result = await ensureSharesightPriceFreshness(client, "owner-a", [], {
    integration: integrationOf(fake),
  });
  assert.deepEqual(result, { ok: true, action: "no_holdings" });
  assert.equal(fake.state.callCount, 0);
});

test("BRK-012C gate: a missing watermark triggers exactly one refresh -- cache AND price_observations both written, watermark stamped", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({ ok: true, value: [instrument()] });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-20T06:00:00.000Z",
      leaseOwner: () => "lease-1",
    },
  );
  assert.equal(fake.state.callCount, 1);
  assert.deepEqual(result, {
    ok: true,
    action: "refreshed",
    matchedCount: 1,
    cacheWritten: 1,
    observationsWritten: 1,
  });
  const cacheRow = db
    .prepare(
      `SELECT price_decimal, currency_code, fetched_at FROM sharesight_delayed_prices WHERE user_id = 'owner-a'`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...cacheRow },
    {
      price_decimal: "12.34",
      currency_code: "AUD",
      fetched_at: "2026-08-20T06:00:00.000Z",
    },
  );
  const observationRow = db
    .prepare(
      `SELECT close_decimal, provider_id, interval FROM price_observations WHERE security_id = 'security-a'`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...observationRow },
    { close_decimal: "12.34", provider_id: "sharesight", interval: "delayed" },
  );
  assert.equal(
    await loadSharesightPriceRefreshWatermark(client, "owner-a"),
    "2026-08-20T06:00:00.000Z",
  );
});

test("BRK-012C gate (B1 pin): a fresh watermark (9m59s old) serves cache-only -- ZERO Sharesight requests", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "owner-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-20T05:50:01.000Z",
  });
  const fake = fakeSharesightClient({ ok: true, value: [instrument()] });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      // 9m59s after the watermark above.
      now: () => "2026-08-20T06:00:00.000Z",
    },
  );
  assert.deepEqual(result, { ok: true, action: "cache_fresh" });
  assert.equal(fake.state.callCount, 0);
});

test("BRK-012C gate: a 10m01s-old watermark triggers a refresh", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "owner-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-20T05:49:59.000Z",
  });
  const fake = fakeSharesightClient({
    ok: true,
    value: [instrument({ currentPriceDecimal: "13.00" })],
  });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      // 10m01s after the watermark above.
      now: () => "2026-08-20T06:00:00.000Z",
      leaseOwner: () => "lease-1",
    },
  );
  assert.equal(fake.state.callCount, 1);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.action, "refreshed");
});

test("BRK-012C gate (B1 pin, reviewer's exact drill): a MIXED portfolio (one matched security, one Sharesight will NEVER match) still makes exactly ONE fetch across two loads inside the window", async () => {
  const db = await gateFixture();
  addUnmatchedSecurity(db);
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({ ok: true, value: [instrument()] });
  const heldSecurityIds = ["security-a", "security-unmatched"];
  const first = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    heldSecurityIds,
    {
      integration: integrationOf(fake),
      now: () => "2026-08-20T06:00:00.000Z",
      leaseOwner: () => "lease-1",
    },
  );
  assert.equal(first.ok, true);
  if (first.ok) assert.equal(first.action, "refreshed");
  assert.equal(fake.state.callCount, 1);
  // A SECOND load, moments later, still inside the window -- the
  // unmatched security has (and will always have) no cache row, but the
  // watermark is per-owner, not per-security, so this must NOT re-fetch.
  const second = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    heldSecurityIds,
    {
      integration: integrationOf(fake),
      now: () => "2026-08-20T06:05:00.000Z",
    },
  );
  assert.deepEqual(second, { ok: true, action: "cache_fresh" });
  assert.equal(fake.state.callCount, 1, "still exactly one fetch total");
});

test("BRK-012C gate (B1 pin, reviewer's exact drill): three simulated call sites in one window (holdings, income projection, dividend assumptions) still make <=1 fetch total", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({ ok: true, value: [instrument()] });
  const options = {
    integration: integrationOf(fake),
    now: () => "2026-08-20T06:00:00.000Z",
    leaseOwner: () => "lease-1",
  };
  // `app/owned-holdings.ts`, `app/owned-income-projection.ts`, and
  // `app/owned-dividend-assumptions.ts` each independently call
  // `loadOwnedHoldings` -> `ensureSharesightPriceFreshness`; simulated here
  // as three sequential calls within the same short window.
  await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    options,
  );
  await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    options,
  );
  await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    options,
  );
  assert.equal(fake.state.callCount, 1);
});

test("BRK-012C gate (B2 fix, folding reviewer follow-up 1): a fetch failure stamps the watermark for observability, and holds the window closed against a retry", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({
    ok: false,
    error: { kind: "timeout", message: "upstream timed out", retryable: true },
  });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-20T06:00:00.000Z",
      leaseOwner: () => "lease-1",
    },
  );
  assert.deepEqual(result, {
    ok: false,
    action: "fetch_failed",
    errorKind: "timeout",
  });
  const watermarkRow = db
    .prepare(
      `SELECT last_price_refresh_status, last_price_refresh_error_kind FROM sharesight_sync_state WHERE id = 'sync-a'`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...watermarkRow },
    {
      last_price_refresh_status: "failed",
      last_price_refresh_error_kind: "timeout",
    },
  );
  // The lease was released despite the failure -- a later request can retry.
  const syncRow = db
    .prepare(
      `SELECT price_refresh_lease_owner FROM sharesight_sync_state WHERE id = 'sync-a'`,
    )
    .get() as { price_refresh_lease_owner: string | null };
  assert.equal(syncRow.price_refresh_lease_owner, null);
  // A SECOND load moments later, still inside the window -- the FAILED
  // attempt itself stamped the watermark, so this must NOT retry
  // (the ruling: "a broken fetch can't hammer Sharesight every render").
  const second = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-20T06:02:00.000Z",
    },
  );
  assert.deepEqual(second, { ok: true, action: "cache_fresh" });
  assert.equal(fake.state.callCount, 1, "still exactly one fetch total");
});

test("BRK-012C gate: single-flight -- two near-simultaneous stale loads for the SAME owner produce exactly one Sharesight fetch", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({ ok: true, value: [instrument()] });
  const options = {
    integration: integrationOf(fake),
    now: () => "2026-08-20T06:00:00.000Z",
    leaseOwner: (() => {
      let count = 0;
      return () => `lease-${(count += 1)}`;
    })(),
  };
  const [first, second] = await Promise.all([
    ensureSharesightPriceFreshness(client, "owner-a", ["security-a"], options),
    ensureSharesightPriceFreshness(client, "owner-a", ["security-a"], options),
  ]);
  assert.equal(fake.state.callCount, 1);
  const actions = [first.action, second.action].sort();
  assert.deepEqual(actions, ["lease_contended", "refreshed"]);
});

test("BRK-012C gate: cross-user isolation -- owner-a's refresh never writes owner-b's cache/watermark, and owner-b's own gate call is unaffected", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({
    ok: true,
    value: [instrument({ id: "101" }), instrument({ id: "202", code: "DEF" })],
  });
  await ensureSharesightPriceFreshness(client, "owner-a", ["security-a"], {
    integration: integrationOf(fake),
    now: () => "2026-08-20T06:00:00.000Z",
    leaseOwner: () => "lease-a",
  });
  assert.equal(fake.state.callCount, 1);
  assert.equal(
    await loadSharesightPriceRefreshWatermark(client, "owner-b"),
    null,
  );
  const ownerBCacheBefore = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sharesight_delayed_prices WHERE user_id = 'owner-b'`,
    )
    .get() as { n: number };
  assert.equal(ownerBCacheBefore.n, 0);

  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-b",
    ["security-b"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-20T06:00:01.000Z",
      leaseOwner: () => "lease-b",
    },
  );
  assert.equal(fake.state.callCount, 2);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.action, "refreshed");
  const ownerBCache = await loadSharesightDelayedPriceCache(client, "owner-b", [
    "security-b",
  ]);
  assert.equal(ownerBCache.size, 1);
  const ownerACacheForB = await loadSharesightDelayedPriceCache(
    client,
    "owner-a",
    ["security-b"],
  );
  assert.equal(ownerACacheForB.size, 0);
});

// ---------------------------------------------------------------------------
// (2b) MKT-015: pre-refresh cache backfill -- day-change must not go dark
// just because cron never fired (local dev has no cron) or the app wasn't
// opened on a given day.
// ---------------------------------------------------------------------------

test("MKT-015 (already-working pin): a Friday quote fetched on Saturday accretes Friday's OWN row -- no backfill mechanism involved, just the existing plan-derived write", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  // Saturday: nothing has traded since Friday's close, so Sharesight's
  // `current_price` still honestly reports Friday's own timestamp.
  const fake = fakeSharesightClient({
    ok: true,
    value: [
      instrument({
        currentPriceUpdatedAt: "2026-08-21T16:10:00+10:00",
        currentPriceDecimal: "12.00",
      }),
    ],
  });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-22T00:00:00.000Z", // Saturday
      leaseOwner: () => "lease-1",
    },
  );
  assert.equal(result.ok, true);
  if (result.ok && result.action === "refreshed") {
    assert.equal(
      result.observationsWritten,
      1,
      "no backfill -- no prior cache row existed",
    );
  } else {
    assert.fail("expected a refresh");
  }
  const rows = db
    .prepare(
      `SELECT market_date, close_decimal FROM price_observations WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all()
    .map((row) => ({ ...(row as Record<string, unknown>) })) as Array<{
    market_date: string;
    close_decimal: string;
  }>;
  assert.deepEqual(rows, [
    { market_date: "2026-08-21", close_decimal: "12.00" },
  ]);
});

test("MKT-015 ordering fix: a Monday-morning first read backfills Friday's still-cached row BEFORE the cache is overwritten with Monday's quote", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  // Simulate the gap this task fixes: the owner's app was never opened, and
  // no cron ran (local dev), across the whole weekend. The delayed-price
  // cache still honestly holds Friday's last-known quote, but (for
  // whatever reason -- a missed cron tick, a partial write, or simply
  // nobody having read since) `price_observations` never got a Friday row.
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'ASX', 'ABC', '2026-08-01', 'candidate');
    INSERT INTO sharesight_delayed_prices (id, user_id, security_id, price_decimal, currency_code, quote_at, market_date, market_timezone, fetched_at, provider_id, created_at, updated_at)
      VALUES ('cache-a', 'owner-a', 'security-a', '12.00', 'AUD', '2026-08-21T06:10:00.000Z', '2026-08-21', '+10:00', '2026-08-21T06:15:00.000Z', 'sharesight', '2026-08-21T06:15:00.000Z', '2026-08-21T06:15:00.000Z');
  `);
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "owner-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-21T06:15:00.000Z",
  });
  // No price_observations row for security-a at all yet -- the gap.
  assert.equal(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM price_observations WHERE security_id = 'security-a'`,
        )
        .get() as { n: number }
    ).n,
    0,
  );

  // Monday morning: the first read of the new week. Sharesight's feed has
  // already moved on to Monday's own quote.
  const fake = fakeSharesightClient({
    ok: true,
    value: [
      instrument({
        currentPriceUpdatedAt: "2026-08-24T10:05:00+10:00",
        currentPriceDecimal: "13.50",
      }),
    ],
  });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-24T00:10:00.000Z",
      leaseOwner: () => "lease-1",
    },
  );
  assert.equal(result.ok, true);
  if (result.ok && result.action === "refreshed") {
    assert.equal(result.matchedCount, 1);
    assert.equal(result.cacheWritten, 1);
    // 1 fresh (Monday) + 1 backfilled (Friday, from the pre-refresh cache).
    assert.equal(result.observationsWritten, 2);
  } else {
    assert.fail("expected a refresh");
  }

  const rows = db
    .prepare(
      `SELECT market_date, close_decimal, currency_code FROM price_observations WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all()
    .map((row) => ({ ...(row as Record<string, unknown>) })) as Array<{
    market_date: string;
    close_decimal: string;
    currency_code: string;
  }>;
  assert.deepEqual(rows, [
    { market_date: "2026-08-21", close_decimal: "12.00", currency_code: "AUD" },
    { market_date: "2026-08-24", close_decimal: "13.50", currency_code: "AUD" },
  ]);

  // The cache now holds Monday's quote -- the overwrite happened, but only
  // AFTER Friday's row was safely converged into price_observations.
  const cacheRow = db
    .prepare(
      `SELECT price_decimal, quote_at FROM sharesight_delayed_prices WHERE user_id = 'owner-a'`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...cacheRow },
    { price_decimal: "13.50", quote_at: "2026-08-24T00:05:00.000Z" },
  );
});

test("MKT-015 idempotent re-read: a later same-day refresh never duplicates the already-backfilled prior day's row", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'ASX', 'ABC', '2026-08-01', 'candidate');
    -- State AFTER a first Monday-morning refresh already backfilled Friday
    -- and wrote Monday's own row -- see the ordering-fix test above.
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at)
    VALUES
      ('price-fri','sharesight','user','owner-a','owner-a','mapping-sharesight-a','security-a','delayed','2026-08-21T06:10:00.000Z','2026-08-21','+10:00','AUD','12.00',NULL,'raw','observed','2026-08-24T00:10:00.000Z'),
      ('price-mon','sharesight','user','owner-a','owner-a','mapping-sharesight-a','security-a','delayed','2026-08-24T00:05:00.000Z','2026-08-24','+10:00','AUD','13.50',NULL,'raw','observed','2026-08-24T00:10:00.000Z');
    INSERT INTO sharesight_delayed_prices (id, user_id, security_id, price_decimal, currency_code, quote_at, market_date, market_timezone, fetched_at, provider_id, created_at, updated_at)
      VALUES ('cache-a', 'owner-a', 'security-a', '13.50', 'AUD', '2026-08-24T00:05:00.000Z', '2026-08-24', '+10:00', '2026-08-24T00:10:00.000Z', 'sharesight', '2026-08-24T00:10:00.000Z', '2026-08-24T00:10:00.000Z');
  `);
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "owner-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-24T00:10:00.000Z",
  });

  // A later refresh the SAME Monday, prices converging toward the close.
  const fake = fakeSharesightClient({
    ok: true,
    value: [
      instrument({
        currentPriceUpdatedAt: "2026-08-24T10:15:00+10:00",
        currentPriceDecimal: "13.60",
      }),
    ],
  });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-24T00:20:01.000Z",
      leaseOwner: () => "lease-2",
    },
  );
  assert.equal(result.ok, true);
  if (result.ok && result.action === "refreshed") {
    // The pre-refresh cache's OWN market date (Monday) matches the fresh
    // fetch's market date (also Monday) -- no rollover, so no backfill
    // candidate is produced this time.
    assert.equal(result.observationsWritten, 1);
  } else {
    assert.fail("expected a refresh");
  }

  const rows = db
    .prepare(
      `SELECT market_date, close_decimal FROM price_observations WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all()
    .map((row) => ({ ...(row as Record<string, unknown>) })) as Array<{
    market_date: string;
    close_decimal: string;
  }>;
  // Still exactly two rows -- Friday's untouched, Monday's converged to the
  // latest price. Never a third, duplicate Friday row.
  assert.deepEqual(rows, [
    { market_date: "2026-08-21", close_decimal: "12.00" },
    { market_date: "2026-08-24", close_decimal: "13.60" },
  ]);
});

test("MKT-015 honesty: a genuinely-missed multi-day gap backfills ONLY the single date the cache still evidences -- the days between stay honestly missing, never invented", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  // The cache's last write was Wednesday -- Thursday, Friday, and the
  // weekend were never observed by anything (no cron, app never opened).
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'ASX', 'ABC', '2026-08-01', 'candidate');
    INSERT INTO sharesight_delayed_prices (id, user_id, security_id, price_decimal, currency_code, quote_at, market_date, market_timezone, fetched_at, provider_id, created_at, updated_at)
      VALUES ('cache-a', 'owner-a', 'security-a', '11.00', 'AUD', '2026-08-19T06:00:00.000Z', '2026-08-19', '+10:00', '2026-08-19T06:05:00.000Z', 'sharesight', '2026-08-19T06:05:00.000Z', '2026-08-19T06:05:00.000Z');
  `);
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "owner-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-19T06:05:00.000Z",
  });

  const fake = fakeSharesightClient({
    ok: true,
    value: [
      instrument({
        currentPriceUpdatedAt: "2026-08-24T10:05:00+10:00",
        currentPriceDecimal: "13.50",
      }),
    ],
  });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-24T00:10:00.000Z",
      leaseOwner: () => "lease-1",
    },
  );
  assert.equal(result.ok, true);
  if (result.ok && result.action === "refreshed") {
    assert.equal(result.observationsWritten, 2);
  } else {
    assert.fail("expected a refresh");
  }

  const rows = db
    .prepare(
      `SELECT market_date FROM price_observations WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all()
    .map((row) => ({ ...(row as Record<string, unknown>) })) as Array<{
    market_date: string;
  }>;
  // ONLY Wednesday (the single date the cache still evidenced) and Monday
  // (the fresh fetch) exist -- Thursday/Friday/weekend were never
  // observed by anything and stay honestly absent, never fabricated.
  assert.deepEqual(rows, [
    { market_date: "2026-08-19" },
    { market_date: "2026-08-24" },
  ]);
});

test("MKT-015 review round (B1, BLOCKING): an AEDT +11:00 morning quote backfills the REAL prior trading day, never the UTC-shifted wrong one", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  // Monday 2026-08-24, 10:30am AEDT (+11:00) -- UTC-converts to Sunday
  // 2026-08-23T23:30:00Z. The OLD, buggy code re-derived the backfill date
  // by slicing THIS UTC instant, producing "2026-08-23" (Sunday -- not even
  // a trading day, a fabricated date Sharesight never quoted). The stored
  // `market_date` column (migration 0052) instead carries the CORRECT,
  // originally-derived date verbatim: "2026-08-24" (Monday).
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'ASX', 'ABC', '2026-08-01', 'candidate');
    INSERT INTO sharesight_delayed_prices (id, user_id, security_id, price_decimal, currency_code, quote_at, market_date, market_timezone, fetched_at, provider_id, created_at, updated_at)
      VALUES ('cache-a', 'owner-a', 'security-a', '12.00', 'AUD', '2026-08-23T23:30:00.000Z', '2026-08-24', '+11:00', '2026-08-24T00:00:00.000Z', 'sharesight', '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
  `);
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "owner-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-24T00:00:00.000Z",
  });

  // Wednesday 2026-08-26, 10:15am AEDT -- the next read, several days later
  // (nobody opened the app Monday or Tuesday either).
  const fake = fakeSharesightClient({
    ok: true,
    value: [
      instrument({
        currentPriceUpdatedAt: "2026-08-26T10:15:00+11:00",
        currentPriceDecimal: "14.20",
      }),
    ],
  });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-26T00:00:00.000Z",
      leaseOwner: () => "lease-1",
    },
  );
  assert.equal(result.ok, true);
  if (result.ok && result.action === "refreshed") {
    assert.equal(result.observationsWritten, 2);
  } else {
    assert.fail("expected a refresh");
  }

  const rows = db
    .prepare(
      `SELECT market_date, close_decimal, market_timezone FROM price_observations WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all()
    .map((row) => ({ ...(row as Record<string, unknown>) })) as Array<{
    market_date: string;
    close_decimal: string;
    market_timezone: string;
  }>;
  assert.deepEqual(rows, [
    {
      market_date: "2026-08-24",
      close_decimal: "12.00",
      market_timezone: "+11:00",
    },
    {
      market_date: "2026-08-26",
      close_decimal: "14.20",
      market_timezone: "+11:00",
    },
  ]);
  // Pin the fix negatively too: the wrong, UTC-shifted date the old bug
  // would have fabricated must never appear.
  const wrongDateRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM price_observations WHERE security_id = 'security-a' AND market_date = '2026-08-23'`,
    )
    .get() as { n: number };
  assert.equal(wrongDateRow.n, 0);
});

test("MKT-015 review round (B1, BLOCKING): a same-day +11:00 re-read produces ZERO backfill candidates -- the old bug would have fired a spurious one", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  // The cache's stored market_date and the fresh fetch's market_date are
  // the SAME trading day ("2026-08-24") even though their UTC-converted
  // instants fall on DIFFERENT UTC calendar dates (23:35 UTC the day
  // before vs. 23:45 UTC the day before) -- exactly the shape that would
  // have fooled the OLD UTC-slicing logic into treating this as a rollover
  // and firing a spurious backfill onto a fabricated date.
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'ASX', 'ABC', '2026-08-01', 'candidate');
    INSERT INTO sharesight_delayed_prices (id, user_id, security_id, price_decimal, currency_code, quote_at, market_date, market_timezone, fetched_at, provider_id, created_at, updated_at)
      VALUES ('cache-a', 'owner-a', 'security-a', '13.00', 'AUD', '2026-08-23T23:35:00.000Z', '2026-08-24', '+11:00', '2026-08-24T00:00:00.000Z', 'sharesight', '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z');
  `);
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "owner-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-24T00:00:00.000Z",
  });

  const fake = fakeSharesightClient({
    ok: true,
    value: [
      instrument({
        currentPriceUpdatedAt: "2026-08-24T10:45:00+11:00",
        currentPriceDecimal: "13.10",
      }),
    ],
  });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-24T00:15:00.000Z",
      leaseOwner: () => "lease-1",
    },
  );
  assert.equal(result.ok, true);
  if (result.ok && result.action === "refreshed") {
    assert.equal(
      result.observationsWritten,
      1,
      "cached market_date === fresh market_date -- zero backfill candidates",
    );
  } else {
    assert.fail("expected a refresh");
  }

  const rows = db
    .prepare(
      `SELECT market_date, close_decimal FROM price_observations WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all()
    .map((row) => ({ ...(row as Record<string, unknown>) })) as Array<{
    market_date: string;
    close_decimal: string;
  }>;
  // Exactly ONE row -- converged to the later same-day price, never a
  // spurious second row for a neighbouring UTC date.
  assert.deepEqual(rows, [
    { market_date: "2026-08-24", close_decimal: "13.10" },
  ]);
});

test("MKT-015 review round (B3, BLOCKING): a backfill candidate built from a stale cache snapshot never downgrades a prior-day row that already holds a LATER observation", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  // price_observations already holds a MORE RECENT write for Monday
  // (2026-08-24) than the gate's own (stale) cache row -- e.g. the hourly
  // cron wrote it independently, after this gate's cache was last
  // refreshed.
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'ASX', 'ABC', '2026-08-01', 'candidate');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at)
    VALUES ('price-mon','sharesight','user','owner-a','owner-a','mapping-sharesight-a','security-a','delayed','2026-08-24T05:00:00.000Z','2026-08-24','+10:00','AUD','12.50',NULL,'raw','observed','2026-08-24T05:00:00.000Z');
    INSERT INTO sharesight_delayed_prices (id, user_id, security_id, price_decimal, currency_code, quote_at, market_date, market_timezone, fetched_at, provider_id, created_at, updated_at)
      VALUES ('cache-a', 'owner-a', 'security-a', '12.00', 'AUD', '2026-08-24T00:05:00.000Z', '2026-08-24', '+10:00', '2026-08-24T00:10:00.000Z', 'sharesight', '2026-08-24T00:10:00.000Z', '2026-08-24T00:10:00.000Z');
  `);
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "owner-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-24T00:10:00.000Z",
  });

  // Tuesday's first read -- rolls over from the stale cached Monday row.
  const fake = fakeSharesightClient({
    ok: true,
    value: [
      instrument({
        currentPriceUpdatedAt: "2026-08-25T10:05:00+10:00",
        currentPriceDecimal: "14.00",
      }),
    ],
  });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-25T00:10:00.000Z",
      leaseOwner: () => "lease-1",
    },
  );
  assert.equal(result.ok, true);
  if (result.ok && result.action === "refreshed") {
    // The fresh Tuesday write counts; the guarded backfill write is
    // SKIPPED (its RETURNING reports zero rows -- see
    // `upsertSharesightPriceObservations`'s `noDowngrade` doc comment).
    assert.equal(result.observationsWritten, 1);
  } else {
    assert.fail("expected a refresh");
  }

  const rows = db
    .prepare(
      `SELECT market_date, close_decimal, observation_at FROM price_observations WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all()
    .map((row) => ({ ...(row as Record<string, unknown>) })) as Array<{
    market_date: string;
    close_decimal: string;
    observation_at: string;
  }>;
  assert.deepEqual(rows, [
    {
      // NOT downgraded -- Monday's row keeps its already-later, more
      // authoritative observation, never overwritten by the stale cache's
      // earlier snapshot.
      market_date: "2026-08-24",
      close_decimal: "12.50",
      observation_at: "2026-08-24T05:00:00.000Z",
    },
    {
      market_date: "2026-08-25",
      close_decimal: "14.00",
      observation_at: "2026-08-25T00:05:00.000Z",
    },
  ]);
});

test("MKT-015 review round (BLOCKING): a legacy cache row with NULL market_date (written before migration 0052) is skipped honestly, never approximated -- self-heals on the very next refresh", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'ASX', 'ABC', '2026-08-01', 'candidate');
    -- A cache row exactly as a pre-migration-0052 write would have left it:
    -- market_date/market_timezone both NULL.
    INSERT INTO sharesight_delayed_prices (id, user_id, security_id, price_decimal, currency_code, quote_at, market_date, market_timezone, fetched_at, provider_id, created_at, updated_at)
      VALUES ('cache-a', 'owner-a', 'security-a', '12.00', 'AUD', '2026-08-21T06:10:00.000Z', NULL, NULL, '2026-08-21T06:15:00.000Z', 'sharesight', '2026-08-21T06:15:00.000Z', '2026-08-21T06:15:00.000Z');
  `);
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "owner-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-21T06:15:00.000Z",
  });

  const fake = fakeSharesightClient({
    ok: true,
    value: [
      instrument({
        currentPriceUpdatedAt: "2026-08-24T10:05:00+10:00",
        currentPriceDecimal: "13.50",
      }),
    ],
  });
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-24T00:10:00.000Z",
      leaseOwner: () => "lease-1",
    },
  );
  assert.equal(result.ok, true);
  if (result.ok && result.action === "refreshed") {
    assert.equal(
      result.observationsWritten,
      1,
      "a NULL-market-date cache row is skipped, never re-derived from quote_at",
    );
  } else {
    assert.fail("expected a refresh");
  }

  const rows = db
    .prepare(
      `SELECT market_date, close_decimal FROM price_observations WHERE security_id = 'security-a' ORDER BY market_date`,
    )
    .all()
    .map((row) => ({ ...(row as Record<string, unknown>) })) as Array<{
    market_date: string;
    close_decimal: string;
  }>;
  // Only the fresh Monday row -- Friday (which the legacy row's OWN
  // quote_at happens to fall on) is never guessed at, honestly missing.
  assert.deepEqual(rows, [
    { market_date: "2026-08-24", close_decimal: "13.50" },
  ]);

  // Self-heals: the cache row is now fully repopulated for next time.
  const cacheRow = db
    .prepare(
      `SELECT market_date, market_timezone FROM sharesight_delayed_prices WHERE user_id = 'owner-a'`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...cacheRow },
    { market_date: "2026-08-24", market_timezone: "+10:00" },
  );
});

// ---------------------------------------------------------------------------
// (3) app/owned-holdings.ts integration
// ---------------------------------------------------------------------------

test("BRK-012C owned-holdings: a missing watermark on load triggers the gate, and the freshly-accreted Sharesight price feeds the holding, labelled Delayed (Sharesight)", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({
    ok: true,
    // Quote timestamp must be AT OR BEFORE the request's "now" (06:00:00Z)
    // -- the existing selection machinery's no-look-ahead rule rejects an
    // observation_at in the future relative to the read, exactly as it
    // would for any other provider.
    value: [
      instrument({
        currentPriceDecimal: "20.00",
        currentPriceUpdatedAt: "2026-08-20T15:55:00+10:00",
      }),
    ],
  });
  const result = await loadOwnedHoldings(
    client,
    "owner-a",
    "portfolio-a",
    new Date("2026-08-20T06:00:00.000Z"),
    { integration: integrationOf(fake), leaseOwner: () => "lease-1" },
  );
  assert.equal(fake.state.callCount, 1);
  assert.equal(result.rows[0]?.nativePrice, "20.00");
  assert.equal(result.rows[0]?.nativeValue.value, "40");
  assert.match(result.rows[0]?.explanation ?? "", /Delayed \(Sharesight\)/);
  assert.doesNotMatch(result.rows[0]?.explanation ?? "", /\blive\b/i);
});

test("BRK-012C owned-holdings (B1 pin, reviewer's exact drill): three loadOwnedHoldings call sites in one workspace render still make <=1 fetch total", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({
    ok: true,
    value: [
      instrument({
        currentPriceDecimal: "20.00",
        currentPriceUpdatedAt: "2026-08-20T15:55:00+10:00",
      }),
    ],
  });
  const gateOptions = {
    integration: integrationOf(fake),
    leaseOwner: () => "lease-1",
  };
  const now = new Date("2026-08-20T06:00:00.000Z");
  // `app/owned-holdings.ts`, `app/owned-income-projection.ts`, and
  // `app/owned-dividend-assumptions.ts` each call `loadOwnedHoldings`
  // independently -- simulated here as three sequential calls.
  await loadOwnedHoldings(client, "owner-a", "portfolio-a", now, gateOptions);
  await loadOwnedHoldings(client, "owner-a", "portfolio-a", now, gateOptions);
  await loadOwnedHoldings(client, "owner-a", "portfolio-a", now, gateOptions);
  assert.equal(fake.state.callCount, 1);
});

test("BRK-012C owned-holdings (B2 budget drill): a 150-security portfolio through the gate-enabled read path keeps every query's bind params bounded", async () => {
  const db = await manySecuritiesFixture(150);
  const baseClient = createSqliteSqlClient(db);
  let maxParams = 0;
  const countingClient = {
    ...baseClient,
    all: async <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      maxParams = Math.max(maxParams, params.length);
      return baseClient.all<T>(sql, params);
    },
    get: async <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      maxParams = Math.max(maxParams, params.length);
      return baseClient.get<T>(sql, params);
    },
  };
  const instruments = Array.from({ length: 150 }, (_, index) =>
    instrument({
      id: String(1000 + index),
      code: `SYM${index}`,
      currentPriceUpdatedAt: "2026-08-20T15:55:00+10:00",
    }),
  );
  const fake = fakeSharesightClient({ ok: true, value: instruments });
  const result = await loadOwnedHoldings(
    countingClient,
    "owner-a",
    "portfolio-a",
    new Date("2026-08-20T06:00:00.000Z"),
    // No watermark seeded -- the gate is ENABLED and actually runs.
    { integration: integrationOf(fake), leaseOwner: () => "lease-1" },
  );
  assert.equal(fake.state.callCount, 1);
  assert.equal(result.rows.length, 150);
  assert.ok(maxParams <= 100, `expected maxParams <= 100, got ${maxParams}`);
});

test("BRK-012C owned-holdings: within the 10-minute window, loading holdings makes ZERO Sharesight requests", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  // Pre-populate the per-owner watermark AND the matching price_observations
  // accretion row a real gate refresh would have produced 5 minutes ago.
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "owner-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-20T05:55:00.000Z",
  });
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'ASX', 'ABC', '2026-08-01', 'candidate');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at)
    VALUES ('price-sharesight-a','sharesight','user','owner-a','owner-a','mapping-sharesight-a','security-a','delayed','2026-08-20T05:55:00.000Z','2026-08-20','+10:00','AUD','20.00',NULL,'raw','observed','2026-08-20T05:55:00.000Z');
  `);
  const fake = fakeSharesightClient({ ok: true, value: [instrument()] });
  const result = await loadOwnedHoldings(
    client,
    "owner-a",
    "portfolio-a",
    // 5 minutes after the watermark -- well inside the 10-minute window.
    new Date("2026-08-20T06:00:00.000Z"),
    { integration: integrationOf(fake) },
  );
  assert.equal(fake.state.callCount, 0);
  assert.equal(result.rows[0]?.nativePrice, "20.00");
});

test("BRK-012C owned-holdings: a fetch failure never blocks the page -- holdings still render from whatever data already exists", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({
    ok: false,
    error: {
      kind: "transient_upstream",
      message: "upstream unavailable",
      retryable: true,
    },
  });
  const result = await loadOwnedHoldings(
    client,
    "owner-a",
    "portfolio-a",
    new Date("2026-08-20T06:00:00.000Z"),
    { integration: integrationOf(fake), leaseOwner: () => "lease-1" },
  );
  // No Sharesight/EOD price exists at all in this fixture -- the gate's
  // failure must not throw or otherwise block the read; the row honestly
  // reports Price unavailable exactly as it would with no gate at all.
  assert.equal(result.status, "partial");
  assert.equal(result.rows[0]?.nativeValue.status, "unavailable");
  assert.equal(result.rows[0]?.nativeValue.reason, "missing_price");
});

test("BRK-012C owned-holdings: Price unavailable is unchanged when Sharesight is not configured at all", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedHoldings(
    client,
    "owner-a",
    "portfolio-a",
    new Date("2026-08-20T06:00:00.000Z"),
    { integration: NOT_CONFIGURED },
  );
  assert.equal(result.rows[0]?.nativeValue.status, "unavailable");
  assert.equal(result.rows[0]?.nativeValue.reason, "missing_price");
});

test("BRK-012C owned-holdings: cross-user isolation -- owner-b's holdings load never surfaces owner-a's Sharesight price", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({
    ok: true,
    value: [instrument({ id: "101", currentPriceDecimal: "20.00" })],
  });
  await loadOwnedHoldings(
    client,
    "owner-a",
    "portfolio-a",
    new Date("2026-08-20T06:00:00.000Z"),
    { integration: integrationOf(fake), leaseOwner: () => "lease-a" },
  );
  const ownerBResult = await loadOwnedHoldings(
    client,
    "owner-b",
    "portfolio-b",
    new Date("2026-08-20T06:00:01.000Z"),
    { integration: integrationOf(fake), leaseOwner: () => "lease-b" },
  );
  // owner-b's own security (id '202') was never in the fake response, so
  // owner-b's holding stays honestly unpriced -- never owner-a's '20.00'.
  assert.equal(ownerBResult.rows[0]?.nativeValue.status, "unavailable");
});

test("BRK-012C owned-holdings: pinned end-to-end -- current-value selection reads price_observations (the accretion write), not the cache table directly", async () => {
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  // A cache row alone, with NO matching price_observations row, must never
  // feed a current value -- pins the documented design decision (the cache
  // is an audit store; price_observations is the actual valuation input
  // `domain/market-data/selection.ts` reads).
  await upsertSharesightDelayedPriceCache(client, {
    userId: "owner-a",
    candidates: [
      {
        securityId: "security-a",
        instrumentCode: "ABC",
        marketCode: "ASX",
        currencyCode: "AUD",
        closeDecimal: "999.99",
        marketDate: "2026-08-20",
        marketTimezone: "+10:00",
        observationAt: "2026-08-20T05:55:00.000Z",
      },
    ],
    now: "2026-08-20T05:55:00.000Z",
  });
  const result = await loadOwnedHoldings(
    client,
    "owner-a",
    "portfolio-a",
    new Date("2026-08-20T06:00:00.000Z"),
    // Sharesight not configured -- the gate never runs at all here, so the
    // ONLY Sharesight data anywhere is the cache row (no price_observations
    // row exists); the holding must read as unavailable, never '999.99'.
    { integration: NOT_CONFIGURED },
  );
  assert.equal(result.rows[0]?.nativeValue.status, "unavailable");
  assert.notEqual(result.rows[0]?.nativePrice, "999.99");
});

/** Strips `//`-prefixed comment LINES before a "live" grep -- a doc comment
 * honestly DOCUMENTING the "never label live" rule (e.g. "NEVER 'live'")
 * legitimately contains the word; only non-comment code (string literals
 * that could actually reach a user) must never contain it. */
function stripLineComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("BRK-012C: the word 'live' never describes Sharesight price data in any actual (non-comment) code", async () => {
  const [holdings, gate, cacheRepo, refreshRepo, shell] = await Promise.all([
    readFile(new URL("../app/owned-holdings.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/sharesight-price-gate-service.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL(
        "../db/repositories/sharesight-delayed-price-cache.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../db/repositories/sharesight-price-refresh.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../app/components/portfolio-shell.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.doesNotMatch(stripLineComments(holdings), /\blive\b/i);
  assert.doesNotMatch(stripLineComments(gate), /\blive\b/i);
  assert.doesNotMatch(stripLineComments(cacheRepo), /\blive\b/i);
  assert.doesNotMatch(stripLineComments(refreshRepo), /\blive\b/i);
  // Two known, unrelated, pre-existing exceptions stripped before the
  // check: `aria-live="polite"` (a real ARIA attribute elsewhere in this
  // large shared file) and the Quotes tab's own pre-existing HONEST
  // negation ("no quote is presented as live") -- both predate BRK-012C
  // and are the SAME kind of negation this rule requires, not a violation
  // of it. Everything else must still never call Sharesight data "live".
  assert.doesNotMatch(
    stripLineComments(shell)
      .replace(/aria-live/g, "")
      .replace(/no quote is presented as live\.?/gi, ""),
    /\blive\b/i,
  );
  assert.match(holdings, /Delayed \(Sharesight\)/);
  // B3 fix: the honest cross-basis daily-movement label actually renders.
  // UI-023 moved the shared value formatters (including this label) out of
  // the shell into owned-holding-format.tsx; the shell still renders it
  // through that import, and the extracted module obeys the same
  // never-say-live rule.
  const format = await readFile(
    new URL("../app/owned-holding-format.tsx", import.meta.url),
    "utf8",
  );
  assert.match(format, /Movement unavailable \(price basis changed\)/);
  assert.doesNotMatch(stripLineComments(format), /\blive\b/i);
  assert.match(shell, /from "\.\.\/owned-holding-format"/);
});

// ---------------------------------------------------------------------------
// (4) Migration chain + export/purge classification
// ---------------------------------------------------------------------------

test("BRK-012C migration: sharesight_delayed_prices exists with its unique/owner index and purge-lock triggers", async () => {
  const db = await migratedDatabase();
  const indexes = db
    .prepare(`PRAGMA index_list('sharesight_delayed_prices')`)
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((name) => !name.startsWith("sqlite_"))
    .sort();
  assert.deepEqual(indexes, [
    "sharesight_delayed_prices_user_idx",
    "sharesight_delayed_prices_user_security_unique",
  ]);
  const triggers = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sharesight_delayed_prices' ORDER BY name`,
    )
    .all()
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(triggers, [
    "account_purge_lock_sharesight_delayed_prices_delete",
    "account_purge_lock_sharesight_delayed_prices_insert",
    "account_purge_lock_sharesight_delayed_prices_update",
  ]);
});

test("BRK-012C migration: sharesight_sync_state gained the two lease columns, nullable, no rebuild (its purge-lock triggers survive)", async () => {
  const db = await migratedDatabase();
  const columns = db
    .prepare(`PRAGMA table_info('sharesight_sync_state')`)
    .all()
    .map((row) => (row as { name: string }).name);
  assert.ok(columns.includes("price_refresh_lease_owner"));
  assert.ok(columns.includes("price_refresh_lease_expires_at"));
  const triggers = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sharesight_sync_state' ORDER BY name`,
    )
    .all()
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(triggers, [
    "account_purge_lock_sharesight_sync_state_delete",
    "account_purge_lock_sharesight_sync_state_insert",
    "account_purge_lock_sharesight_sync_state_update",
  ]);
});

test("MKT-015 migration 0052: sharesight_delayed_prices gained market_date/market_timezone columns, nullable, no rebuild (its unique/owner index and purge-lock triggers survive byte-identical)", async () => {
  const db = await migratedDatabase();
  const columns = db
    .prepare(`PRAGMA table_info('sharesight_delayed_prices')`)
    .all()
    .map((row) => (row as { name: string; notnull: number }).name);
  assert.ok(columns.includes("market_date"));
  assert.ok(columns.includes("market_timezone"));
  const marketDateColumn = db
    .prepare(`PRAGMA table_info('sharesight_delayed_prices')`)
    .all()
    .find((row) => (row as { name: string }).name === "market_date") as {
    notnull: number;
  };
  assert.equal(marketDateColumn.notnull, 0, "market_date must be nullable");
  // Same index/trigger set as the table-creation migration test above --
  // migration 0052 is a plain `ALTER TABLE ... ADD COLUMN` (verified: no
  // drizzle-kit table rebuild happened), so there is no drop-and-recreate
  // hazard for the hand-appended purge-lock triggers or indexes to survive.
  const indexes = db
    .prepare(`PRAGMA index_list('sharesight_delayed_prices')`)
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((name) => !name.startsWith("sqlite_"))
    .sort();
  assert.deepEqual(indexes, [
    "sharesight_delayed_prices_user_idx",
    "sharesight_delayed_prices_user_security_unique",
  ]);
  const triggers = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'sharesight_delayed_prices' ORDER BY name`,
    )
    .all()
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(triggers, [
    "account_purge_lock_sharesight_delayed_prices_delete",
    "account_purge_lock_sharesight_delayed_prices_insert",
    "account_purge_lock_sharesight_delayed_prices_update",
  ]);
});

test("BRK-012C export/purge: sharesight_delayed_prices is classified owned, user-keyed", () => {
  const classification =
    ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS.sharesight_delayed_prices;
  assert.ok(classification, "must be classified before an export job can run");
  assert.equal(classification.classification, "owned");
  assert.equal(classification.ownerColumn, "user_id");
});

test("BRK-012C export/purge: sharesight_delayed_prices appears in the purge FK-order list (source-text check -- the const is not exported)", async () => {
  const source = await readFile(
    new URL("../db/repositories/account-lifecycle.ts", import.meta.url),
    "utf8",
  );
  const purgeOrderSection = source.slice(
    source.indexOf("const PURGE_TABLES_IN_FK_ORDER"),
    source.indexOf(
      "] as const;",
      source.indexOf("const PURGE_TABLES_IN_FK_ORDER"),
    ),
  );
  assert.match(purgeOrderSection, /"sharesight_delayed_prices"/);
});

// ---------------------------------------------------------------------------
// (5) app/sharesight-price-refresh-service.ts (cron) follow-up 2
// ---------------------------------------------------------------------------

test("BRK-012C follow-up 2: the hourly cron ALSO upserts the delayed-price cache, and its watermark write resets the read gate's own clock", async () => {
  const { runSharesightPriceRefresh } =
    await import("../app/sharesight-price-refresh-service.ts");
  const db = await gateFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({ ok: true, value: [instrument()] });
  await runSharesightPriceRefresh({
    client,
    sharesightClient: fake.client,
    now: () => "2026-08-20T05:30:00.000Z",
  });
  const cacheRow = db
    .prepare(
      `SELECT price_decimal FROM sharesight_delayed_prices WHERE user_id = 'owner-a' AND security_id = 'security-a'`,
    )
    .get() as { price_decimal: string } | undefined;
  assert.equal(cacheRow?.price_decimal, "12.34");
  // The read gate, moments later, sees the cron's own watermark write as
  // fresh and makes zero Sharesight requests of its own.
  const result = await ensureSharesightPriceFreshness(
    client,
    "owner-a",
    ["security-a"],
    {
      integration: integrationOf(fake),
      now: () => "2026-08-20T05:35:00.000Z",
    },
  );
  assert.deepEqual(result, { ok: true, action: "cache_fresh" });
  assert.equal(fake.state.callCount, 1, "only the cron's own call happened");
});
