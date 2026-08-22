// WLT-001 -- Quotes tab becomes a watch list (owner-directed, 2026-08-22).
// Covers: migration/purge-lock triggers, repository add/remove/reorder
// idempotency and ownership isolation, the day-change decimal fixtures
// (incl. missing previous close -> em-dash, never zero), currency-pair
// rows, the time-vs-date line rule, the no-portfolio (user-scoped) state,
// rendered two-line columns, and route CSRF.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createOwnedSecurityVerificationRepository,
  createOwnedWatchlistRepository,
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import { loadOwnedWatchlist } from "../app/owned-watchlist.ts";
import { watchlistExplanation } from "../app/watchlist-contract.ts";
import {
  addWatchlistCurrencyPairWithContext,
  addWatchlistSecurityWithContext,
  removeWatchlistEntryWithContext,
  reorderWatchlistWithContext,
  searchWatchlistSecuritiesWithContext,
  type WatchlistActionContext,
} from "../app/watchlist-actions.ts";
import { POST as securitiesPost } from "../app/api/watchlist/securities/route.ts";
import { DELETE as entriesDelete } from "../app/api/watchlist/entries/route.ts";
import { POST as reorderPost } from "../app/api/watchlist/reorder/route.ts";
import type {
  MarketDataProvider,
  ProviderCapabilities,
} from "../domain/market-data/index.ts";

const NO_CAPABILITIES: ProviderCapabilities = {
  exchanges: [],
  intervals: [],
  supportsRawPrices: false,
  supportsAdjustedPrices: false,
  supportsFx: false,
  supportsDividends: false,
  supportsSplits: false,
  supportsFundamentals: false,
};

function stubProvider(
  searchSecurities: MarketDataProvider["searchSecurities"],
): MarketDataProvider {
  return {
    capabilities: () => NO_CAPABILITIES,
    searchSecurities,
    getDailyPrices: async () => ({ ok: true, value: [] }),
    getLatestObservation: async () => ({ ok: true, value: null }),
    getFxRates: async () => ({ ok: true, value: [] }),
    getDividendEvents: async () => ({ ok: true, value: [] }),
    getSplitEvents: async () => ({ ok: true, value: [] }),
  };
}

/** Always answers with exactly one candidate matching the request. */
function echoingProvider(): MarketDataProvider {
  return stubProvider(async (query) => ({
    ok: true,
    value: [
      {
        securityId: null,
        mappingId: null,
        symbol: query.text,
        exchangeId: query.exchangeId ?? "NASDAQ",
        currencyCode: query.currencyCode ?? "USD",
        name: `${query.text} Inc.`,
        confidence: "high",
        assetType: "equity",
      },
    ],
  }));
}

/**
 * WLT-001 review (B2a): like `echoingProvider`, but `getLatestObservation`
 * also answers with a real observation -- for pinning the best-effort
 * priming fetch `app/watchlist-actions.ts`'s `primeWatchlistSecurityPrice`
 * performs on add.
 */
function pricingProvider(): MarketDataProvider {
  const provider = echoingProvider();
  return {
    ...provider,
    getLatestObservation: async (request) => ({
      ok: true,
      value: {
        kind: "price",
        providerId: "yahoo-compatible",
        providerRevisionId: null,
        mappingId: request.mappingId,
        securityId: request.securityId,
        scope: { kind: "deployment", userId: null },
        interval: "delayed",
        observationAt: "2026-08-03T05:00:00Z",
        marketDate: "2026-08-03",
        marketTimezone: "America/New_York",
        currencyCode: "USD",
        closeDecimal: "12.34",
        previousCloseDecimal: "12.00",
        adjustmentState: "raw",
        adjustmentFactor: null,
        quality: "observed",
        delayedMinutes: 20,
        ingestedAt: "2026-08-03T05:01:00Z",
        payloadSha256: null,
      },
    }),
  };
}

/**
 * WLT-001 review round 2 (B2a collision test): a `yahoo-compatible`/
 * `delayed` observation at a caller-chosen `observationAt`/`closeDecimal`,
 * for the SAME (mapping, market_date) an existing MKT-011A rollup row
 * already occupies -- exercises `primeWatchlistSecurityPrice`'s partial-
 * index `ON CONFLICT` converge path.
 */
function providerWithObservation(
  observationAt: string,
  closeDecimal: string,
): MarketDataProvider {
  const provider = echoingProvider();
  return {
    ...provider,
    searchSecurities: async () => ({
      ok: true,
      value: [
        {
          securityId: null,
          mappingId: null,
          symbol: "AAA.AX",
          exchangeId: "ASX",
          currencyCode: "AUD",
          name: "Security A",
          confidence: "high",
          assetType: "equity",
        },
      ],
    }),
    getLatestObservation: async (request) => ({
      ok: true,
      value: {
        kind: "price",
        providerId: "yahoo-compatible",
        providerRevisionId: null,
        mappingId: request.mappingId,
        securityId: request.securityId,
        scope: { kind: "deployment", userId: null },
        interval: "delayed",
        observationAt,
        marketDate: "2026-08-03",
        marketTimezone: "Australia/Sydney",
        currencyCode: "AUD",
        closeDecimal,
        previousCloseDecimal: "41.90",
        adjustmentState: "raw",
        adjustmentFactor: null,
        quality: "observed",
        delayedMinutes: 20,
        ingestedAt: observationAt,
        payloadSha256: null,
      },
    }),
  };
}

async function loadMigrationSql(): Promise<string> {
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  const contents = await Promise.all(
    files.map((file) =>
      readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    ),
  );
  return contents.join("\n");
}

async function database(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(await loadMigrationSql());
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1),
           ('GBP', 826, 'British pound', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, created_at, updated_at)
    VALUES ('security-a', 'equity', 'AUD', 'Security A', '2026-08-03', '2026-08-03'),
           ('security-b', 'equity', 'USD', 'Security B', '2026-08-03', '2026-08-03');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
    VALUES ('mapping-a', 'security-a', 'yahoo-compatible', 'ASX', 'AAA.AX', '2026-01-01', 'verified'),
           ('mapping-b', 'security-b', 'yahoo-compatible', 'NYSE', 'BBB', '2026-01-01', 'verified');
  `);
  return db;
}

function insertPrice(
  db: DatabaseSync,
  input: {
    id: string;
    securityId: string;
    mappingId: string;
    marketDate: string;
    observationAt: string;
    closeDecimal: string;
    previousCloseDecimal: string | null;
    currencyCode?: string;
  },
) {
  db.prepare(
    `INSERT INTO price_observations (
      id, provider_id, access_scope, scope_user_id, scope_key, mapping_id,
      security_id, interval, observation_at, market_date, market_timezone,
      currency_code, close_decimal, previous_close_decimal, adjustment_state,
      quality, delayed_minutes, ingested_at
    ) VALUES (
      ?, 'yahoo-compatible', 'deployment', NULL, 'deployment', ?, ?, 'delayed',
      ?, ?, 'Australia/Sydney', ?, ?, ?, 'raw', 'observed', 20, ?
    )`,
  ).run(
    input.id,
    input.mappingId,
    input.securityId,
    input.observationAt,
    input.marketDate,
    input.currencyCode ?? "AUD",
    input.closeDecimal,
    input.previousCloseDecimal,
    input.observationAt,
  );
}

function insertFx(
  db: DatabaseSync,
  input: {
    id: string;
    base: string;
    quote: string;
    marketDate: string;
    observedAt: string;
    rateDecimal: string;
  },
) {
  db.prepare(
    `INSERT INTO fx_rate_observations (
      id, provider_id, access_scope, scope_user_id, scope_key,
      base_currency_code, quote_currency_code, rate_decimal, interval,
      observed_at, market_date, quality, ingested_at
    ) VALUES (?, 'yahoo-compatible', 'deployment', NULL, 'deployment', ?, ?, ?, 'delayed', ?, ?, 'observed', ?)`,
  ).run(
    input.id,
    input.base,
    input.quote,
    input.rateDecimal,
    input.observedAt,
    input.marketDate,
    input.observedAt,
  );
}

function actionContext(
  client: SqlClient,
  userId: string,
): WatchlistActionContext {
  return { client, userId, requestId: `request-${userId}` };
}

// ---------------------------------------------------------------------------
// Migration + purge-lock triggers
// ---------------------------------------------------------------------------

test("WLT-001 migration: watchlist_entries exists with its shape check, partial-unique indexes, and purge-lock triggers", async () => {
  const db = await database();
  const triggers = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'watchlist_entries' ORDER BY name",
    )
    .all() as { name: string }[];
  assert.deepEqual(
    triggers.map((row) => row.name),
    [
      "account_purge_lock_watchlist_entries_delete",
      "account_purge_lock_watchlist_entries_insert",
      "account_purge_lock_watchlist_entries_update",
    ],
  );
  db.close();
});

test("WLT-001 migration: the purge-lock trigger actually fires -- an in-flight purge job blocks a watchlist insert", async () => {
  const db = await database();
  db.exec(`
    INSERT INTO account_purge_jobs (
      id, owner_user_id, deletion_request_id, deletion_key_digest,
      export_job_id, manifest_digest, status, phase, eligible_at,
      confirmed_at, created_at, updated_at
    ) VALUES (
      'purge-a', 'user-a', 'request-a', 'key-digest', 'export-a',
      'manifest-a', 'running', 'validate_source', '2026-08-03', '2026-08-03',
      '2026-08-03', '2026-08-03'
    );
  `);
  assert.throws(() => {
    db.prepare(
      `INSERT INTO watchlist_entries (id, user_id, kind, security_id, display_order, created_at, version)
       VALUES ('entry-locked', 'user-a', 'security', 'security-a', 0, '2026-08-03', 1)`,
    ).run();
  }, /account_purge_source_locked/);
  db.close();
});

test("WLT-001 schema: the shape CHECK rejects a row with both a security and a currency pair, or neither", async () => {
  const db = await database();
  assert.throws(() => {
    db.prepare(
      `INSERT INTO watchlist_entries (id, user_id, kind, security_id, base_currency_code, quote_currency_code, display_order, created_at, version)
       VALUES ('bad-a', 'user-a', 'security', 'security-a', 'AUD', 'USD', 0, '2026-08-03', 1)`,
    ).run();
  }, /CHECK constraint failed/);
  assert.throws(() => {
    db.prepare(
      `INSERT INTO watchlist_entries (id, user_id, kind, display_order, created_at, version)
       VALUES ('bad-b', 'user-a', 'currency_pair', 0, '2026-08-03', 1)`,
    ).run();
  }, /CHECK constraint failed/);
  db.close();
});

// ---------------------------------------------------------------------------
// Repository: add/remove/reorder idempotency and ownership isolation
// ---------------------------------------------------------------------------

test("WLT-001 repository: addSecurity is idempotent (a repeat add returns the same pre-existing entry, never a duplicate row)", async () => {
  const db = await database();
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  const first = await repo.addSecurity("user-a", "security-a", "req-1");
  assert.equal(first.ok, true);
  const second = await repo.addSecurity("user-a", "security-a", "req-2");
  assert.equal(second.ok, true);
  if (first.ok && second.ok) assert.equal(first.entry.id, second.entry.id);
  const count = db
    .prepare(
      "SELECT COUNT(*) AS count FROM watchlist_entries WHERE user_id = 'user-a'",
    )
    .get() as { count: number };
  assert.equal(count.count, 1);
  db.close();
});

test("WLT-001 repository (B5, BLOCKING): a repeated idempotent add writes exactly ONE audit row, never one per no-op attempt (reviewer's 4-attempts/5-audit-rows repro, inverted)", async () => {
  const db = await database();
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  // 4 attempts to add the SAME security: 1 real insert, 3 idempotent no-ops.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await repo.addSecurity(
      "user-a",
      "security-a",
      `req-${attempt}`,
    );
    assert.equal(result.ok, true);
  }
  const entryCount = db
    .prepare(
      "SELECT COUNT(*) AS count FROM watchlist_entries WHERE user_id = 'user-a'",
    )
    .get() as { count: number };
  assert.equal(entryCount.count, 1, "expected exactly one watchlist entry");
  const auditCount = db
    .prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'watchlist.add_security' AND target_owner_user_id = 'user-a'",
    )
    .get() as { count: number };
  assert.equal(
    auditCount.count,
    1,
    "expected exactly one audit row -- the 3 suppressed no-op inserts must never audit a 'success' that wrote nothing",
  );
  db.close();
});

test("WLT-001 repository (B5): the same idempotency guarantee holds for addCurrencyPair", async () => {
  const db = await database();
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await repo.addCurrencyPair(
      "user-a",
      "AUD",
      "USD",
      `req-${attempt}`,
    );
    assert.equal(result.ok, true);
  }
  const auditCount = db
    .prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'watchlist.add_currency_pair' AND target_owner_user_id = 'user-a'",
    )
    .get() as { count: number };
  assert.equal(auditCount.count, 1);
  db.close();
});

test("WLT-001 repository: addCurrencyPair is idempotent and rejects a same-currency pair", async () => {
  const db = await database();
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  const same = await repo.addCurrencyPair("user-a", "AUD", "AUD", "req-1");
  assert.equal(same.ok, false);
  const first = await repo.addCurrencyPair("user-a", "AUD", "USD", "req-2");
  const second = await repo.addCurrencyPair("user-a", "AUD", "USD", "req-3");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) assert.equal(first.entry.id, second.entry.id);
  const unknown = await repo.addCurrencyPair("user-a", "AUD", "ZZZ", "req-4");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason, "not_found");
  db.close();
});

test("WLT-001 repository: remove is version-guarded; a repeat remove of the same id resolves not_found, never an error", async () => {
  const db = await database();
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  const added = await repo.addSecurity("user-a", "security-a", "req-1");
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const staleRemove = await repo.remove("user-a", added.entry.id, 99, "req-2");
  assert.equal(staleRemove.ok, false);
  if (!staleRemove.ok) assert.equal(staleRemove.reason, "conflict");
  const removed = await repo.remove(
    "user-a",
    added.entry.id,
    added.entry.version,
    "req-3",
  );
  assert.equal(removed.ok, true);
  const repeat = await repo.remove(
    "user-a",
    added.entry.id,
    added.entry.version,
    "req-4",
  );
  assert.equal(repeat.ok, false);
  if (!repeat.ok) assert.equal(repeat.reason, "not_found");
  db.close();
});

test("WLT-001 repository: reorder is idempotent and rejects a stale/mismatched id set as a conflict", async () => {
  const db = await database();
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  const a = await repo.addSecurity("user-a", "security-a", "req-1");
  const b = await repo.addSecurity("user-a", "security-b", "req-2");
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  const reordered = await repo.reorder(
    "user-a",
    [b.entry.id, a.entry.id],
    "req-3",
  );
  assert.equal(reordered.ok, true);
  if (reordered.ok) {
    assert.deepEqual(
      reordered.entries.map((entry) => entry.id),
      [b.entry.id, a.entry.id],
    );
  }
  // Re-applying the SAME order is a safe no-op re-application.
  const again = await repo.reorder("user-a", [b.entry.id, a.entry.id], "req-4");
  assert.equal(again.ok, true);
  const stale = await repo.reorder("user-a", [a.entry.id], "req-5");
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, "conflict");
  db.close();
});

test("WLT-001 ownership isolation: cross-user cannot see or mutate another owner's watchlist", async () => {
  const db = await database();
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  const ownerEntry = await repo.addSecurity("user-a", "security-a", "req-1");
  assert.equal(ownerEntry.ok, true);
  if (!ownerEntry.ok) return;

  // Sees nothing.
  const otherList = await repo.list("user-b");
  assert.deepEqual(otherList, []);

  // Cannot remove it.
  const otherRemove = await repo.remove(
    "user-b",
    ownerEntry.entry.id,
    ownerEntry.entry.version,
    "req-2",
  );
  assert.equal(otherRemove.ok, false);
  if (!otherRemove.ok) assert.equal(otherRemove.reason, "not_found");

  // Cannot reorder it away.
  const otherReorder = await repo.reorder(
    "user-b",
    [ownerEntry.entry.id],
    "req-3",
  );
  assert.equal(otherReorder.ok, false);
  if (!otherReorder.ok) assert.equal(otherReorder.reason, "conflict");

  // The owner's own entry is untouched.
  const ownerList = await repo.list("user-a");
  assert.equal(ownerList.length, 1);
  db.close();
});

// ---------------------------------------------------------------------------
// Quote loading: day-change decimals, currency pairs, time-vs-date rule
// ---------------------------------------------------------------------------

test("WLT-001 quotes: a security with previous_close_decimal renders an exact signed change/percent", async () => {
  const db = await database();
  insertPrice(db, {
    id: "price-a",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "42.10",
    previousCloseDecimal: "41.90",
  });
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  const added = await repo.addSecurity("user-a", "security-a", "req-1");
  assert.equal(added.ok, true);
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.price, "AUD 42.10");
  assert.equal(rows[0]?.change, "+0.20");
  assert.equal(rows[0]?.percent, "+0.48%");
  assert.equal(rows[0]?.tone, "positive");
  db.close();
});

test("WLT-001 quotes: missing previous_close_decimal renders the honest em-dash state, never zero", async () => {
  const db = await database();
  insertPrice(db, {
    id: "price-a",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "42.10",
    previousCloseDecimal: null,
  });
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows[0]?.change, "—");
  assert.equal(rows[0]?.percent, "—");
  assert.notEqual(rows[0]?.change, "0.00");
  assert.notEqual(rows[0]?.change, "+0.00");
  db.close();
});

test("WLT-001 quotes review (F1, BLOCKING): a zero previous_close_decimal is treated as NO usable baseline -- change AND percent BOTH degrade to em-dash (never a fabricated 'change' with no matching percent), and the whole tab never aborts into a false provider-error", async () => {
  const db = await database();
  insertPrice(db, {
    id: "price-a",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "42.10",
    previousCloseDecimal: "0",
  });
  // A second, ordinary security must still load correctly alongside the
  // malformed one -- proof the whole call did not abort.
  insertPrice(db, {
    id: "price-b",
    securityId: "security-b",
    mappingId: "mapping-b",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "10.00",
    previousCloseDecimal: "9.00",
    currencyCode: "USD",
  });
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  await repo.addSecurity("user-a", "security-b", "req-2");
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows.length, 2);
  const zeroPreviousRow = rows.find((row) => row.targetKey === "security-a");
  assert.equal(zeroPreviousRow?.percent, "—");
  assert.equal(
    zeroPreviousRow?.change,
    "—",
    "F1: change must degrade alongside percent, never fabricate 'close - 0' as a real movement",
  );
  assert.notEqual(zeroPreviousRow?.change, "+42.10");
  const ordinaryRow = rows.find((row) => row.targetKey === "security-b");
  assert.equal(ordinaryRow?.percent, "+11.11%");
  db.close();
});

test("WLT-001 quotes review round 3 (B7, BLOCKING): a malformed previous_close_decimal ('abc', never expected from a validated write but not DB-CHECK-enforced) degrades ONLY that row's change/percent to em-dash -- the loader never throws out of the .map() and the whole tab never falls to a false provider-error", async () => {
  const db = await database();
  insertPrice(db, {
    id: "price-a",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "42.10",
    previousCloseDecimal: null,
  });
  // Simulate a hand-run write bypassing this codebase's own validated
  // insert path -- `price_observations.previous_close_decimal` carries no
  // DB CHECK enforcing decimal shape (same documented trade-off as
  // MKT-011A's `daily_capture_interval_minutes`).
  db.exec(
    `UPDATE price_observations SET previous_close_decimal = 'abc' WHERE id = 'price-a'`,
  );
  // A second, ordinary security must still load correctly alongside the
  // malformed one -- proof the whole call did not abort.
  insertPrice(db, {
    id: "price-b",
    securityId: "security-b",
    mappingId: "mapping-b",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "10.00",
    previousCloseDecimal: "9.00",
    currencyCode: "USD",
  });
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  await repo.addSecurity("user-a", "security-b", "req-2");
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows.length, 2, "loader must return both rows, never throw");
  const malformedRow = rows.find((row) => row.targetKey === "security-a");
  assert.equal(malformedRow?.change, "—");
  assert.equal(malformedRow?.percent, "—");
  assert.equal(malformedRow?.price, "AUD 42.10");
  const ordinaryRow2 = rows.find((row) => row.targetKey === "security-b");
  assert.equal(ordinaryRow2?.change, "+1.00");
  assert.equal(ordinaryRow2?.percent, "+11.11%");
  db.close();
});

test("WLT-001 quotes review round 3 (B7, BLOCKING): a malformed close_decimal ('abc') degrades ONLY that row to the honest unavailable state -- sibling rows still price correctly and the loader never throws", async () => {
  const db = await database();
  insertPrice(db, {
    id: "price-a",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "42.10",
    previousCloseDecimal: "41.90",
  });
  db.exec(
    `UPDATE price_observations SET close_decimal = 'abc' WHERE id = 'price-a'`,
  );
  insertPrice(db, {
    id: "price-b",
    securityId: "security-b",
    mappingId: "mapping-b",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "10.00",
    previousCloseDecimal: "9.00",
    currencyCode: "USD",
  });
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  await repo.addSecurity("user-a", "security-b", "req-2");
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows.length, 2, "loader must return both rows, never throw");
  const malformedRow = rows.find((row) => row.targetKey === "security-a");
  assert.equal(malformedRow?.price, "unavailable");
  assert.equal(malformedRow?.state, "unavailable");
  assert.equal(malformedRow?.change, "—");
  assert.equal(malformedRow?.percent, "—");
  const ordinaryRow2 = rows.find((row) => row.targetKey === "security-b");
  assert.equal(ordinaryRow2?.price, "USD 10.00");
  assert.equal(ordinaryRow2?.change, "+1.00");
  db.close();
});

test("WLT-001 quotes review (fold): a change that rounds to a display zero (2dp) while its percent is genuinely non-zero renders the trimmed exact digits, never a fake '0.00'; tone reflects the TRUE sign, never a string '-' sniff", async () => {
  const db = await database();
  insertPrice(db, {
    id: "price-a",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "0.0009",
    previousCloseDecimal: "0.001",
  });
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  // close - previous = -0.0001 -- rounds to "0.00" at 2dp, but the percent
  // (-10%) is genuinely non-zero, so the trimmed exact digits render
  // instead of a fake "0.00".
  assert.equal(rows[0]?.change, "−0.0001");
  assert.notEqual(rows[0]?.change, "0.00");
  assert.notEqual(rows[0]?.change, "-0.00");
  assert.equal(rows[0]?.tone, "negative");
  db.close();
});

test("WLT-001 quotes review (F2, BLOCKING): a percent that rounds to a display zero (2dp) while genuinely non-zero renders its OWN trimmed exact digits, independently of whether the change itself also rounds to zero", async () => {
  const db = await database();
  // change = 100003 - 100000 = 3.00 (a real, non-fake-zero change at 2dp).
  // percent = 3 / 100000 * 100 = 0.003% -- rounds to "0.00%" at 2dp but is
  // genuinely non-zero, so it must render its own trimmed digits even
  // though `change` needed no such fallback here.
  insertPrice(db, {
    id: "price-a",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "100003",
    previousCloseDecimal: "100000",
  });
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows[0]?.change, "+3.00");
  assert.equal(rows[0]?.percent, "+0.003%");
  assert.notEqual(rows[0]?.percent, "+0.00%");
  assert.notEqual(rows[0]?.percent, "0.00%");
  db.close();
});

test("WLT-001 quotes review (fold): an EXACTLY zero change (or a percent that is also zero) still renders the plain '0.00', never a fake '+0.00' sign, and classifies flat/neutral", async () => {
  const db = await database();
  insertPrice(db, {
    id: "price-a",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "42.10",
    previousCloseDecimal: "42.10",
  });
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows[0]?.change, "0.00");
  assert.notEqual(rows[0]?.change, "+0.00");
  assert.equal(rows[0]?.tone, "neutral");
  db.close();
});

test("WLT-001 quotes: a security with no usable observation renders 'unavailable' and an em-dash change, never zero (WLT-001 review B6: owner's one-off Price-unavailable -> unavailable wording, AGENTS.md)", async () => {
  const db = await database();
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows[0]?.price, "unavailable");
  assert.equal(rows[0]?.state, "unavailable");
  assert.equal(rows[0]?.change, "—");
  db.close();
});

test("WLT-001 quotes: a currency-pair row renders the bare rate and ALWAYS an em-dash change (FxObservation carries no previous-rate field)", async () => {
  const db = await database();
  insertFx(db, {
    id: "fx-a",
    base: "AUD",
    quote: "USD",
    marketDate: "2026-08-03",
    observedAt: "2026-08-03T05:00:00Z",
    rateDecimal: "0.6543",
  });
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addCurrencyPair("user-a", "AUD", "USD", "req-1");
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "currency_pair");
  assert.equal(rows[0]?.symbol, "AUD/USD");
  assert.equal(rows[0]?.price, "0.6543 USD");
  assert.equal(rows[0]?.change, "—");
  assert.equal(rows[0]?.percent, "—");
  db.close();
});

test("WLT-001 quotes: time-vs-date line -- market-local time when the observation's market date is today, else the date", async () => {
  const db = await database();
  // Australia/Sydney is UTC+10 in August (no DST) -- 05:00Z is 15:00 local.
  insertPrice(db, {
    id: "price-today",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "42.10",
    previousCloseDecimal: "41.90",
  });
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  const todayRows = await loadOwnedWatchlist(
    createSqliteSqlClient(db),
    "user-a",
    // "now" is also 2026-08-03 in Australia/Sydney (08:00Z = 18:00 local).
    { now: new Date("2026-08-03T08:00:00Z") },
  );
  assert.equal(todayRows[0]?.timeLine, "15:00");

  const db2 = await database();
  insertPrice(db2, {
    id: "price-stale",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-01",
    observationAt: "2026-08-01T05:00:00Z",
    closeDecimal: "42.10",
    previousCloseDecimal: "41.90",
  });
  const repo2 = createOwnedWatchlistRepository(createSqliteSqlClient(db2));
  await repo2.addSecurity("user-a", "security-a", "req-1");
  const staleRows = await loadOwnedWatchlist(
    createSqliteSqlClient(db2),
    "user-a",
    { now: new Date("2026-08-03T08:00:00Z") },
  );
  assert.equal(staleRows[0]?.timeLine, "2026-08-01");
  db.close();
  db2.close();
});

test("WLT-001 quotes: the watchlist works with zero portfolios -- loadOwnedWatchlist needs only a userId, no portfolioId", async () => {
  const db = await database();
  insertPrice(db, {
    id: "price-a",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T05:00:00Z",
    closeDecimal: "42.10",
    previousCloseDecimal: "41.90",
  });
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  // No `portfolios` row exists for user-a at all -- the loader still reads.
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM portfolios")
    .get() as { count: number };
  assert.equal(count.count, 0);
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows.length, 1);
  db.close();
});

test("WLT-001 quotes: an empty watchlist renders zero rows honestly (no fabricated entries)", async () => {
  const db = await database();
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.deepEqual(rows, []);
  db.close();
});

test("WLT-001 quotes: watchlistExplanation carries full provenance and never claims a price is available when unavailable", async () => {
  const db = await database();
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  const explanation = watchlistExplanation(rows[0]!);
  assert.match(explanation, /^unavailable:/);
  db.close();
});

// ---------------------------------------------------------------------------
// B2b: MKT-011A's Yahoo capture candidate resolution includes watch-only
// securities with a verified mapping, deduplicated against held securities.
// ---------------------------------------------------------------------------

test("WLT-001 (B2b, BLOCKING): resolveScopedYahooCaptureSecurities includes a watch-only security with a verified mapping (no portfolio membership at all)", async () => {
  const db = await database();
  const { resolveScopedYahooCaptureSecurities } =
    await import("../db/repositories/intraday-price-capture.ts");
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  // No portfolio_securities row exists for user-a at all.
  const heldCount = db
    .prepare("SELECT COUNT(*) AS count FROM portfolio_securities")
    .get() as { count: number };
  assert.equal(heldCount.count, 0);

  const candidates = await resolveScopedYahooCaptureSecurities(
    createSqliteSqlClient(db),
    "user-a",
  );
  assert.deepEqual(
    candidates.map((c) => c.securityId),
    ["security-a"],
  );
  assert.equal(candidates[0]?.mappingId, "mapping-a");
  db.close();
});

test("WLT-001 (B2b): a security that is BOTH held and watched is captured once, not twice", async () => {
  const db = await database();
  const { resolveScopedYahooCaptureSecurities } =
    await import("../db/repositories/intraday-price-capture.ts");
  db.exec(`
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('holding-a', 'user-a', 'portfolio-a', 'security-a', 'AAA', 'AUD', 'held', '2026-08-03', '2026-08-03');
  `);
  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  await repo.addSecurity("user-a", "security-a", "req-1");
  const candidates = await resolveScopedYahooCaptureSecurities(
    createSqliteSqlClient(db),
    "user-a",
  );
  assert.deepEqual(
    candidates.map((c) => c.securityId),
    ["security-a"],
  );
  db.close();
});

// ---------------------------------------------------------------------------
// B4: never a fake zero -- the holdings row's average native cost (2dp) and
// whole-unless-fractional quantity display, `app/owned-holding-format.tsx`.
// Executed via the `tsx`-loader subprocess (like `renderWatchlist` below):
// the module is a `.tsx` file (one JSX-returning export,
// `ownedHoldingPercent`), which plain `node --experimental-strip-types`
// cannot parse even to import an unrelated pure-string export from it.
// ---------------------------------------------------------------------------

function formatOwnedHoldingValues(): {
  averageNativeCostFractional: string;
  averageNativeCostUltraTiny: string;
  quantityFractional: string;
  quantityWhole: string;
} {
  const moduleUrl = new URL("../app/owned-holding-format.tsx", import.meta.url)
    .href;
  const script = `
    import { ownedHoldingDecimalNeverFakeZero, ownedHoldingTrimmed } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify({
      averageNativeCostFractional: ownedHoldingDecimalNeverFakeZero("0.0034", 2),
      averageNativeCostUltraTiny: ownedHoldingDecimalNeverFakeZero("0.0000001", 2),
      quantityFractional: ownedHoldingTrimmed("0.5"),
      quantityWhole: ownedHoldingTrimmed("150.00000000"),
    }));
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

test("WLT-001 (B4, BLOCKING): a genuinely non-zero average cost never renders as a fake '0.00'; quantity is whole-unless-fractional", () => {
  const result = formatOwnedHoldingValues();
  // 0.0034 at 2dp rounds to "0.00" -- a KNOWN non-zero value must never
  // display as all-zeros; falls back to its trimmed exact digits.
  assert.equal(result.averageNativeCostFractional, "0.0034");
  // A genuinely fractional quantity (e.g. a DRP fractional share) keeps its
  // real digits, never rounded away to a misleading whole number.
  assert.equal(result.quantityFractional, "0.5");
  // An INTEGRAL quantity renders with no decimal places at all.
  assert.equal(result.quantityWhole, "150");
});

test("WLT-001 (UI-028 review round 2 fold, BLOCKING): even ownedHoldingTrimmed's own 6dp default would render 0.0000001 as a fake '0' -- falls through to the full exact stored precision instead", () => {
  const result = formatOwnedHoldingValues();
  assert.equal(result.averageNativeCostUltraTiny, "0.0000001");
  assert.notEqual(result.averageNativeCostUltraTiny, "0");
  assert.notEqual(result.averageNativeCostUltraTiny, "0.00");
  assert.notEqual(result.averageNativeCostUltraTiny, "0.000000");
});

// ---------------------------------------------------------------------------
// Actions: search/add/remove/reorder validation and honest provider-disabled
// degrade
// ---------------------------------------------------------------------------

test("WLT-001 actions: search degrades honestly (503, explicit message) when the market-data provider is disabled -- never a dead control", async () => {
  const db = await database();
  db.exec(
    `UPDATE market_data_providers SET status = 'disabled' WHERE id = 'yahoo-compatible'`,
  );
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const result = await searchWatchlistSecuritiesWithContext(context, {
    text: "AAA",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 503);
    assert.match(result.message, /disabled/i);
  }
  db.close();
});

test("WLT-001 actions: search rejects an empty query with 400", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const result = await searchWatchlistSecuritiesWithContext(context, {
    text: "",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 400);
  db.close();
});

test("WLT-001 actions: search returns provider candidates when enabled (injected provider, since node --test never has a Worker env)", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const result = await searchWatchlistSecuritiesWithContext(
    context,
    { text: "AAA" },
    { provider: echoingProvider() },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.symbol, "AAA");
  }
  db.close();
});

test("WLT-001 actions: addWatchlistSecurity resolves via the shared securities master and records interest only (no portfolio_securities row)", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const result = await addWatchlistSecurityWithContext(
    context,
    { symbol: "NEWCO", currencyCode: "USD" },
    { provider: echoingProvider() },
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.entry.kind, "security");
    const published = await db
      .prepare(
        "SELECT id FROM securities WHERE primary_currency_code = 'USD' AND canonical_name = 'NEWCO Inc.'",
      )
      .get();
    assert.ok(published, "expected the security to be published");
  }
  const positionCount = db
    .prepare("SELECT COUNT(*) AS count FROM portfolio_securities")
    .get() as { count: number };
  assert.equal(
    positionCount.count,
    0,
    "adding to the watchlist must never create a position",
  );
  db.close();
});

test("WLT-001 actions: addWatchlistSecurity re-resolves a security that ALREADY exists via publishOnly rather than duplicating the shared master", async () => {
  const db = await database();
  const publishRepo = createOwnedSecurityVerificationRepository(
    createSqliteSqlClient(db),
  );
  const first = await publishRepo.publishOnly("user-a", "yahoo-compatible", {
    providerSymbol: "AAA",
    providerExchange: "NASDAQ",
    currencyCode: "USD",
    name: "AAA Inc.",
    assetType: "equity",
  });
  assert.equal(first.ok, true);
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const result = await addWatchlistSecurityWithContext(
    context,
    { symbol: "AAA", currencyCode: "USD" },
    { provider: echoingProvider() },
  );
  assert.equal(result.ok, true);
  const count = db
    .prepare(
      "SELECT COUNT(*) AS count FROM securities WHERE primary_currency_code = 'USD' AND canonical_name = 'AAA Inc.'",
    )
    .get() as { count: number };
  assert.equal(count.count, 1);
  db.close();
});

test("WLT-001 actions (B2a, BLOCKING): adding a security primes a first best-effort price so the row does not sit 'unavailable' until an unrelated refresh", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const result = await addWatchlistSecurityWithContext(
    context,
    { symbol: "NEWCO", currencyCode: "USD" },
    { provider: pricingProvider() },
  );
  assert.equal(result.ok, true);
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.price, "USD 12.34");
  assert.notEqual(rows[0]?.state, "unavailable");
  db.close();
});

test("WLT-001 actions (B2a): the priming fetch is best-effort -- a provider failure never blocks or fails the add", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const failingProvider: MarketDataProvider = {
    ...echoingProvider(),
    getLatestObservation: async () => ({
      ok: false,
      error: { kind: "transient_upstream", message: "boom", retryable: true },
    }),
  };
  const result = await addWatchlistSecurityWithContext(
    context,
    { symbol: "NEWCO", currencyCode: "USD" },
    { provider: failingProvider },
  );
  assert.equal(
    result.ok,
    true,
    "the add itself must never fail on a priming error",
  );
  const rows = await loadOwnedWatchlist(createSqliteSqlClient(db), "user-a", {
    now: new Date("2026-08-03T08:00:00Z"),
  });
  assert.equal(rows[0]?.state, "unavailable");
  db.close();
});

test("WLT-001 actions (B2a review round 2, BLOCKING): priming converges onto an existing same-day MKT-011A rollup row instead of throwing on the partial index -- a NEWER prime updates the row", async () => {
  const db = await database();
  // Simulates an MKT-011A rollup that already ran earlier today for
  // security-a/mapping-a -- the exact same-day `yahoo-compatible`/`delayed`
  // row the round-1 prime shape collided with and silently lost.
  insertPrice(db, {
    id: "price-existing",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T06:25:00Z",
    closeDecimal: "40.00",
    previousCloseDecimal: "39.50",
  });
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const result = await addWatchlistSecurityWithContext(
    context,
    { symbol: "AAA.AX", exchangeAlias: "ASX", currencyCode: "AUD" },
    {
      provider: providerWithObservation("2026-08-03T09:00:00Z", "42.10"),
    },
  );
  assert.equal(result.ok, true, "the add must not throw/fail on the collision");
  const priceRow = db
    .prepare(
      "SELECT COUNT(*) AS count FROM price_observations WHERE mapping_id = 'mapping-a' AND market_date = '2026-08-03'",
    )
    .get() as { count: number };
  assert.equal(
    priceRow.count,
    1,
    "expected the two writers to converge onto ONE row",
  );
  const converged = db
    .prepare(
      "SELECT close_decimal, observation_at FROM price_observations WHERE mapping_id = 'mapping-a' AND market_date = '2026-08-03'",
    )
    .get() as { close_decimal: string; observation_at: string };
  assert.equal(
    converged.close_decimal,
    "42.10",
    "expected the NEWER prime to win",
  );
  assert.equal(converged.observation_at, "2026-08-03T09:00:00Z");
  db.close();
});

test("WLT-001 actions (B2a review round 2, BLOCKING): an OLDER prime never downgrades an existing newer same-day row", async () => {
  const db = await database();
  insertPrice(db, {
    id: "price-existing",
    securityId: "security-a",
    mappingId: "mapping-a",
    marketDate: "2026-08-03",
    observationAt: "2026-08-03T06:25:00Z",
    closeDecimal: "40.00",
    previousCloseDecimal: "39.50",
  });
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const result = await addWatchlistSecurityWithContext(
    context,
    { symbol: "AAA.AX", exchangeAlias: "ASX", currencyCode: "AUD" },
    {
      // Older than the existing 06:25Z row.
      provider: providerWithObservation("2026-08-03T05:00:00Z", "38.00"),
    },
  );
  assert.equal(result.ok, true);
  const converged = db
    .prepare(
      "SELECT close_decimal, observation_at FROM price_observations WHERE mapping_id = 'mapping-a' AND market_date = '2026-08-03'",
    )
    .get() as { close_decimal: string; observation_at: string };
  assert.equal(
    converged.close_decimal,
    "40.00",
    "expected the OLDER prime to be a no-op -- no downgrade",
  );
  assert.equal(converged.observation_at, "2026-08-03T06:25:00Z");
  const rowCount = db
    .prepare(
      "SELECT COUNT(*) AS count FROM price_observations WHERE mapping_id = 'mapping-a' AND market_date = '2026-08-03'",
    )
    .get() as { count: number };
  assert.equal(rowCount.count, 1);
  db.close();
});

test("WLT-001 actions: addWatchlistCurrencyPair validates two distinct 3-letter codes present in the currencies table", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const malformed = await addWatchlistCurrencyPairWithContext(context, {
    baseCurrencyCode: "AU",
    quoteCurrencyCode: "USD",
  });
  assert.equal(malformed.ok, false);
  const same = await addWatchlistCurrencyPairWithContext(context, {
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "AUD",
  });
  assert.equal(same.ok, false);
  const unknown = await addWatchlistCurrencyPairWithContext(context, {
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "ZZZ",
  });
  assert.equal(unknown.ok, false);
  const ok = await addWatchlistCurrencyPairWithContext(context, {
    baseCurrencyCode: "AUD",
    quoteCurrencyCode: "USD",
  });
  assert.equal(ok.ok, true);
  db.close();
});

test("WLT-001 actions: removeWatchlistEntry requires an id and version, and reports a stale version as a conflict", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const missing = await removeWatchlistEntryWithContext(context, {});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.status, 400);

  const repo = createOwnedWatchlistRepository(createSqliteSqlClient(db));
  const added = await repo.addSecurity("user-a", "security-a", "req-1");
  assert.equal(added.ok, true);
  if (!added.ok) return;
  const stale = await removeWatchlistEntryWithContext(context, {
    id: added.entry.id,
    expectedVersion: added.entry.version + 5,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.status, 409);
  const removed = await removeWatchlistEntryWithContext(context, {
    id: added.entry.id,
    expectedVersion: added.entry.version,
  });
  assert.equal(removed.ok, true);
  db.close();
});

test("WLT-001 actions: reorderWatchlist rejects a malformed/empty id list with 400", async () => {
  const db = await database();
  const context = actionContext(createSqliteSqlClient(db), "user-a");
  const empty = await reorderWatchlistWithContext(context, {
    orderedIds: [],
  });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.status, 400);
  const malformed = await reorderWatchlistWithContext(context, {
    orderedIds: [1, 2],
  });
  assert.equal(malformed.ok, false);
  db.close();
});

// ---------------------------------------------------------------------------
// Route CSRF
// ---------------------------------------------------------------------------

test("WLT-001 routes: mutation endpoints reject cross-site browser requests", async () => {
  for (const handler of [securitiesPost, entriesDelete, reorderPost]) {
    const response = await handler(
      new Request("https://yieldtome.example/api/watchlist/test", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Cross-site mutation/i);
  }
});

// ---------------------------------------------------------------------------
// Rendered two-line columns + no-portfolio state
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

function renderWatchlist(ownedWorkspace: Record<string, unknown>): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, {
            activeSection: "quotes",
            ownedWorkspace: ${JSON.stringify(ownedWorkspace)},
          }),
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

const FIXTURE_ROW = {
  entryId: "entry-a",
  version: 1,
  kind: "security",
  targetKey: "security-a",
  symbol: "AAA",
  name: "Security A",
  price: "AUD 42.10",
  timeLine: "15:00",
  change: "+0.20",
  percent: "+0.48%",
  tone: "positive",
  state: "current",
  provenance: {
    source: "provider",
    providerId: "yahoo-compatible",
    observationAt: "2026-08-03T05:00:00Z",
    delayedMinutes: 20,
    scope: "deployment",
    quality: "observed",
    fallbackReason: "Best validated observation selected.",
  },
  sort: { ticker: "AAA", price: "4210", change: "20" },
};

test("WLT-001 rendering: a populated watchlist renders three columns, two lines per row (ticker/name, price/time, change/percent)", () => {
  const html = renderWatchlist({
    status: "ready",
    activePortfolio: {
      id: "portfolio-a",
      name: "Fixture",
      homeCurrencyCode: "AUD",
      baseCurrencyCode: "AUD",
      timezone: "Australia/Sydney",
      accountingMethod: "fifo",
      status: "active",
      version: 1,
    },
    portfolios: [],
    quotes: [FIXTURE_ROW],
    quoteViewState: "populated",
  });
  // Column 1: ticker over company name.
  assert.match(html, /class="row-primary symbol">AAA</);
  assert.match(html, /class="row-secondary ellipsis">Security A</);
  // Column 2: last price over time-of-last-price.
  assert.match(html, /class="row-primary numeric">AUD 42\.10</);
  assert.match(html, /class="row-secondary numeric">15:00</);
  // Column 3: day change over percent change.
  assert.match(html, />\+0\.20</);
  assert.match(html, />\+0\.48%</);
  // Row/remove/move affordances present.
  assert.match(html, /Remove AAA from your watchlist/);
});

test("WLT-001 rendering: an em-dash change never renders as zero", () => {
  const html = renderWatchlist({
    status: "ready",
    activePortfolio: {
      id: "portfolio-a",
      name: "Fixture",
      homeCurrencyCode: "AUD",
      baseCurrencyCode: "AUD",
      timezone: "Australia/Sydney",
      accountingMethod: "fifo",
      status: "active",
      version: 1,
    },
    portfolios: [],
    quotes: [
      {
        ...FIXTURE_ROW,
        change: "—",
        percent: "—",
        tone: "neutral",
      },
    ],
    quoteViewState: "populated",
  });
  assert.match(html, />—</);
  assert.doesNotMatch(html, />0\.00</);
  assert.doesNotMatch(html, />\+0\.00</);
});

test("WLT-001 rendering (B1, BLOCKING): the watchlist renders in the server's STORED display_order by default, never re-sorted -- a row array deliberately out of alphabetical order stays in that array order", () => {
  const html = renderWatchlist({
    status: "ready",
    activePortfolio: {
      id: "portfolio-a",
      name: "Fixture",
      homeCurrencyCode: "AUD",
      baseCurrencyCode: "AUD",
      timezone: "Australia/Sydney",
      accountingMethod: "fifo",
      status: "active",
      version: 1,
    },
    portfolios: [],
    // Stored order is ZZZ then AAA -- alphabetically this would be REVERSED
    // if the tab defaulted to a ticker sort (the old, now-review-fixed
    // behaviour). The rendered order must match the array, not the
    // alphabet.
    quotes: [
      { ...FIXTURE_ROW, entryId: "entry-zzz", symbol: "ZZZ", name: "Zed Co" },
      { ...FIXTURE_ROW, entryId: "entry-aaa", symbol: "AAA", name: "Alpha Co" },
    ],
    quoteViewState: "populated",
  });
  const zzzIndex = html.indexOf('class="row-primary symbol">ZZZ<');
  const aaaIndex = html.indexOf('class="row-primary symbol">AAA<');
  assert.ok(zzzIndex >= 0 && aaaIndex >= 0, "expected both rows to render");
  assert.ok(
    zzzIndex < aaaIndex,
    "expected the STORED order (ZZZ before AAA), not an alphabetical sort",
  );
});

test("WLT-001 rendering (B1): Move up/down are enabled (not disabled) in the DEFAULT stored-order view -- the reorder affordance actually works until a column sort is opted into", () => {
  const html = renderWatchlist({
    status: "ready",
    activePortfolio: {
      id: "portfolio-a",
      name: "Fixture",
      homeCurrencyCode: "AUD",
      baseCurrencyCode: "AUD",
      timezone: "Australia/Sydney",
      accountingMethod: "fifo",
      status: "active",
      version: 1,
    },
    portfolios: [],
    quotes: [
      { ...FIXTURE_ROW, entryId: "entry-a", symbol: "AAA" },
      { ...FIXTURE_ROW, entryId: "entry-b", symbol: "BBB" },
    ],
    quoteViewState: "populated",
  });
  // AAA is first (Move up disabled at the top boundary; Move down enabled).
  assert.match(html, /disabled="" aria-label="Move AAA up"/);
  assert.doesNotMatch(html, /disabled="" aria-label="Move AAA down"/);
  // BBB is second (Move down disabled at the bottom boundary; Move up enabled).
  assert.doesNotMatch(html, /disabled="" aria-label="Move BBB up"/);
  assert.match(html, /disabled="" aria-label="Move BBB down"/);
});

test("WLT-001 source (B1, BLOCKING): moveEntry computes the submitted order from the STORED `rows` array, never from the displayed `sortedRows`", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "async function moveEntry(row: WatchlistRow, offset: -1 | 1) {",
  );
  assert.ok(start >= 0, "expected to find moveEntry");
  const end = source.indexOf("\n  return (", start);
  const moveEntrySource = source.slice(start, end);
  // Reads the row's position from the stored-order map, never sortedRows.
  assert.match(moveEntrySource, /storedIndexByEntryId\.get\(row\.entryId\)/);
  assert.match(moveEntrySource, /const reordered = \[\.\.\.rows\];/);
  assert.doesNotMatch(moveEntrySource, /sortedRows/);
});

test("WLT-001 source (B1, BLOCKING): sortKey starts null (stored order, no column sort active) and Move up/down are disabled -- with a title explaining why -- whenever a non-default sort is active", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const \[sortKey, setSortKey\] = useState<QuoteSort \| null>\(null\);/,
  );
  assert.match(source, /const customOrderActive = sortKey === null;/);
  assert.match(
    source,
    /const moveDisabledTitle = customOrderActive\s*\n\s*\? undefined\s*\n\s*: "Clear the column sort to reorder the watchlist\.";/,
  );
  // Both Move buttons are gated on `!customOrderActive` and carry the title.
  const moveUpMatches = source.match(
    /disabled=\{\s*mutationsDisabled \|\|\s*\n\s*!customOrderActive \|\|\s*\n\s*storedIndex === 0\s*\}\s*\n\s*title=\{moveDisabledTitle\}/,
  );
  assert.ok(
    moveUpMatches,
    "expected Move up gated on !customOrderActive with a title",
  );
  const moveDownMatches = source.match(
    /disabled=\{\s*mutationsDisabled \|\|\s*\n\s*!customOrderActive \|\|\s*\n\s*storedIndex === rows\.length - 1\s*\}\s*\n\s*title=\{moveDisabledTitle\}/,
  );
  assert.ok(
    moveDownMatches,
    "expected Move down gated on !customOrderActive with a title",
  );
});

test("WLT-001 rendering: the watchlist renders with NO active portfolio at all (user-scoped, not portfolio-scoped)", () => {
  const html = renderWatchlist({
    status: "empty",
    activePortfolio: null,
    portfolios: [],
    quotes: [FIXTURE_ROW],
    quoteViewState: "populated",
  });
  assert.match(html, /class="row-primary symbol">AAA</);
  // Does NOT show the generic "No portfolios yet" panel on this tab.
  assert.doesNotMatch(html, /No portfolios yet/);
});

test("WLT-001 rendering: an empty watchlist with no portfolio renders an honest empty state with the add affordance, not the generic 'No portfolios yet' panel", () => {
  const html = renderWatchlist({
    status: "empty",
    activePortfolio: null,
    portfolios: [],
    quotes: [],
    quoteViewState: "empty",
  });
  assert.match(html, /No watch entries yet/);
  assert.match(html, /Add a stock/);
  assert.match(html, /Add a currency pair/);
  assert.doesNotMatch(html, /No portfolios yet/);
});
