/**
 * EXP-002 -- full-system backup and restore (owner-directed). See
 * TASKS.md's "### EXP-002" entry and `docs/BACKUP_FORMAT.md`'s system-
 * artifact section. Covers: `domain/exports/system-backup.ts` (structural
 * validation: schema version, account settings, watchlist entries, nested
 * portfolio bundles reusing EXP-001's UNCHANGED validator, size ceiling);
 * `db/repositories/system-backup.ts` (account settings read/overwrite,
 * watchlist read/restore incl. ticker-match security resolution, the
 * fresh-account precondition); `app/system-backup-service.ts` (export
 * assembly, preview, commit orchestration, per-portfolio failure isolation,
 * idempotent retry, price-history reuse of MKT-008's own machinery).
 *
 * Fixture/context helpers duplicated from tests/exp-001.test.ts, matching
 * this codebase's established per-test-file convention (no shared
 * migratedDatabase()/fixture() module).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import { createOwnedLedgerRepository } from "../db/repositories/ledger.ts";
import {
  validateSystemBackup,
  MAX_SYSTEM_BACKUP_PORTFOLIOS,
  SYSTEM_BACKUP_SCHEMA_VERSION,
  type SystemBackupV1,
} from "../domain/exports/system-backup.ts";
import {
  commitSystemBackupImport,
  exportSystemBackup,
  exportSystemBackupCore,
  previewSystemBackupImport,
  type SystemBackupServiceContext,
} from "../app/system-backup-service.ts";
import { fingerprintBundle } from "../app/portfolio-bundle-service.ts";
import { countUnrelatedPortfolios } from "../db/repositories/system-backup.ts";
import { PRICE_BACKUP_FORMAT_VERSION } from "../domain/market-data/price-backup-csv.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { loadOwnerPriceExportRowsPage } from "../db/repositories/price-uploads.ts";
import { systemBackupCoreExportResponseShape } from "../app/api/system-backup/export/response-shape.ts";
import {
  EMPTY_RESTORE_PROGRESS,
  isResumeCursorValid,
  parseStoredRestoreProgress,
  restoreProgressStorageKey,
} from "../app/system-backup-restore-progress.ts";

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
 * Owner account "a": two portfolios (pa, pb), a watchlist (one security --
 * ticker-matches pa's own held security, so restore resolves it via the
 * same-ticker global match; one currency pair), non-default account
 * settings (so the restore-overwrite is provable against a target account's
 * DEFAULTS), and one price-history observation (owner-import provenance,
 * mirroring `tests/mkt-008.test.ts`'s direct-insert fixture pattern).
 */
async function fixture(): Promise<{ db: DatabaseSync; client: SqlClient }> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES
      ('AUD',36,'Australian dollar',2),('USD',840,'US dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    -- Non-default settings -- proves restore OVERWRITES a target's own
    -- (default) settings rather than leaving them untouched.
    INSERT INTO user_settings(user_id,home_currency_code,timezone,default_holding_currency_view,financial_year_start_month,price_source_preference,daily_capture_source,daily_capture_interval_minutes,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney','home',4,'yahoo_anonymous','yahoo_anonymous',30,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','Portfolio A','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pb','a','B','Portfolio B','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s1','equity','AUD','Alpha Co','2026-08-01','2026-08-01'),
      ('s2','equity','AUD','Beta Co','2026-08-01','2026-08-01'),
      -- A security nobody holds anywhere -- the watch-only-security-skip
      -- probe (never restored, never created out of thin air).
      ('s3','equity','AUD','Gamma Co (watch only)','2026-08-01','2026-08-01');
    INSERT INTO security_identifiers(id,security_id,scheme,value,valid_from,source) VALUES
      ('si1','s1','ticker','ALPHA','2026-08-01','owner_attested'),
      ('si2','s2','ticker','BETA','2026-08-01','owner_attested'),
      ('si3','s3','ticker','GAMMA','2026-08-01','owner_attested');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa1','a','pa','s1','ALPHA','AUD','held','2026-08-01','2026-08-01'),
      ('psb1','a','pb','s2','BETA','AUD','held','2026-08-01','2026-08-01');

    -- Watchlist: security psa1's OWN security (s1, ticker match) + a
    -- currency pair. A watch-only security (s3, GAMMA) is deliberately
    -- NOT on the watchlist here -- see the standalone skip-probe test below
    -- for that case (it needs a security with NO matching ticker anywhere
    -- restorable, which this shared fixture's own s3 already models via
    -- absence from every portfolio).
    INSERT INTO watchlist_entries(id,user_id,kind,security_id,display_order,created_at,version) VALUES
      ('we1','a','security','s1',0,'2026-08-01T00:00:00.000Z',1);
    INSERT INTO watchlist_entries(id,user_id,kind,base_currency_code,quote_currency_code,display_order,created_at,version) VALUES
      ('we2','a','currency_pair','USD','AUD',1,'2026-08-01T00:00:00.000Z',1);

    -- One price-history observation for s1 (owner-import provenance),
    -- mirroring tests/mkt-008.test.ts's direct-insert fixture shape.
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-a-s1', 's1', 'owner-import', 'ASX', 'ALPHA', '2026-01-01', 'candidate');
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
      VALUES ('price-a-s1', 'owner-import', 'user', 'a', 'a', 'mapping-a-s1', 's1', 'eod', '2026-08-20T06:00:00Z', '2026-08-20', '+10:00', 'AUD', '12.34', 'raw', 'observed', '2026-08-20T06:01:00Z');
  `);
  const client = createSqliteSqlClient(db);
  const ledger = createOwnedLedgerRepository(client);
  const post1 = await ledger.post("a", {
    portfolioId: "pa",
    type: "buy",
    portfolioSecurityId: "psa1",
    quantityDecimal: "100",
    unitPriceDecimal: "5",
    grossAmountDecimal: "500",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey: randomUUID(),
    tradeAt: "2026-01-01T00:00:00.000Z",
    localTradeDate: "2026-01-01",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });
  assert.equal(post1.ok, true);
  if (!post1.ok) throw new Error("fixture post1 failed");
  const reversal = await ledger.reverse(
    "a",
    "pa",
    post1.transaction.id,
    randomUUID(),
    randomUUID(),
  );
  assert.equal(reversal.ok, true);
  const post2 = await ledger.post("a", {
    portfolioId: "pa",
    type: "buy",
    portfolioSecurityId: "psa1",
    quantityDecimal: "50",
    unitPriceDecimal: "6",
    grossAmountDecimal: "300",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey: randomUUID(),
    tradeAt: "2026-02-01T00:00:00.000Z",
    localTradeDate: "2026-02-01",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });
  assert.equal(post2.ok, true);
  const postB = await ledger.post("a", {
    portfolioId: "pb",
    type: "buy",
    portfolioSecurityId: "psb1",
    quantityDecimal: "20",
    unitPriceDecimal: "10",
    grossAmountDecimal: "200",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey: randomUUID(),
    tradeAt: "2026-01-15T00:00:00.000Z",
    localTradeDate: "2026-01-15",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: randomUUID(),
  });
  assert.equal(postB.ok, true);

  return { db, client };
}

/** Seeds a bare, portfolio-less target account (a fresh account precondition
 * candidate) with DEFAULT settings. */
function seedFreshAccount(db: DatabaseSync, userId: string): void {
  db.exec(`
    INSERT OR IGNORE INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES
      ('AUD',36,'Australian dollar',2),('USD',840,'US dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('${userId}','active','${userId}@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('${userId}','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
  `);
}

function ctxFor(client: SqlClient, userId: string): SystemBackupServiceContext {
  return { client, userId, requestId: randomUUID() };
}

test("validateSystemBackup: schema-version mismatch, malformed shape, and over-cap portfolio count fail closed", () => {
  assert.equal(validateSystemBackup(null).ok, false);
  assert.equal(validateSystemBackup({}).ok, false);
  assert.equal(
    validateSystemBackup({
      schemaVersion: 2,
      exportedAt: "2026-01-01T00:00:00.000Z",
    }).ok,
    false,
  );
  const oversized = {
    schemaVersion: SYSTEM_BACKUP_SCHEMA_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    account: {
      homeCurrencyCode: "AUD",
      timezone: "Australia/Sydney",
      defaultHoldingCurrencyView: "native",
      financialYearStartMonth: 7,
      priceSourcePreference: "sharesight_delayed",
      dailyCaptureSource: "sharesight",
      dailyCaptureIntervalMinutes: 60,
    },
    watchlistEntries: [],
    portfolios: Array.from(
      { length: MAX_SYSTEM_BACKUP_PORTFOLIOS + 1 },
      () => ({}),
    ),
    priceBackupCsv: "",
  };
  const result = validateSystemBackup(oversized);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /200/);
});

test("Free-plan export core omits the expensive price section while bounded price pages preserve its rows", async () => {
  const { client } = await fixture();
  const core = await exportSystemBackupCore(ctxFor(client, "a"));
  assert.equal(core.ok, true);
  if (!core.ok) return;
  assert.equal(core.backup.priceBackupCsv, "");
  assert.equal(core.backup.portfolios.length, 2);
  assert.equal(core.backup.watchlistEntries.length, 2);

  const first = await loadOwnerPriceExportRowsPage(client, "a", 0, 1);
  const after = await loadOwnerPriceExportRowsPage(client, "a", 1, 1);
  assert.equal(first.length, 1);
  assert.equal(first[0]?.providerSymbol, "ALPHA");
  assert.equal(first[0]?.priceDecimal, "12.34");
  assert.deepEqual(after, []);
});

test("Free-plan browser flow assembles export pages and restores resumable price chunks without uploading the full price CSV", async () => {
  const source = await readFile(
    new URL("../app/components/system-backup-panel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const PRICE_RESTORE_CHUNK_ROWS = 200/);
  assert.match(source, /coreBackup: \{ \.\.\.backup, priceBackupCsv: "" \}/);
  assert.match(source, /\/api\/system-backup\/export\?mode=core/);
  assert.match(source, /mode=prices&offset=/);
  assert.match(source, /\/api\/market-data\/price-uploads\/backup\/confirm/);
  // B3 fix: the resume-cursor key/parse/validate logic moved to the
  // dependency-free `system-backup-restore-progress.ts` sibling (see the
  // "B3:" tests above for direct behavioural coverage of that logic) --
  // pin only the WIRING here, i.e. that the panel actually imports and uses
  // it, mirroring `tests/div-013.test.ts`'s identical split.
  assert.match(source, /from "\.\.\/system-backup-restore-progress\.ts"/);
  assert.match(source, /verifyResumeCursorBatches/);
  assert.match(source, /retry after 00:00 UTC/);
});

test("export -> restore into a fresh account (full flow)", async () => {
  const { db, client } = await fixture();
  const exported = await exportSystemBackup(ctxFor(client, "a"));
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const backup: SystemBackupV1 = exported.backup;
  assert.equal(backup.portfolios.length, 2);
  assert.equal(backup.watchlistEntries.length, 2);
  assert.match(backup.priceBackupCsv, /ALPHA/);
  assert.equal(backup.account.defaultHoldingCurrencyView, "home");
  assert.equal(backup.account.priceSourcePreference, "yahoo_anonymous");

  seedFreshAccount(db, "b");

  const preview = await previewSystemBackupImport(ctxFor(client, "b"), backup);
  assert.equal(preview.ok, true);
  if (preview.ok) {
    assert.equal(preview.preview.precondition.fresh, true);
    assert.equal(preview.preview.portfolios.length, 2);
    assert.equal(preview.preview.watchlistCounts.currencyPairs, 1);
    assert.equal(preview.preview.watchlistCounts.securities, 1);
    assert.equal(preview.preview.priceBackup.rowCount, 1);
  }

  const commit1 = await commitSystemBackupImport(
    ctxFor(client, "b"),
    backup,
    "system-backup.json",
  );
  assert.equal(commit1.ok, true);
  if (!commit1.ok) return;
  assert.equal(commit1.result.portfolios.length, 2);
  assert.equal(
    commit1.result.portfolios.every((p) => !p.idempotent),
    true,
  );
  assert.equal(commit1.result.watchlist.pairsAdded, 1);
  assert.equal(commit1.result.watchlist.securitiesAdded, 1);
  assert.equal(commit1.result.watchlist.securitiesSkipped, 0);
  assert.ok(commit1.result.priceBackup);
  assert.equal(commit1.result.priceBackup?.written, 1);

  // Settings overwritten to the backup's own recorded values (b's own
  // defaults are gone).
  const settingsRow = await client.get<Record<string, unknown>>(
    "SELECT default_holding_currency_view, price_source_preference, daily_capture_source, daily_capture_interval_minutes, financial_year_start_month FROM user_settings WHERE user_id = 'b'",
    [],
  );
  assert.equal(settingsRow?.default_holding_currency_view, "home");
  assert.equal(settingsRow?.price_source_preference, "yahoo_anonymous");
  assert.equal(settingsRow?.daily_capture_source, "yahoo_anonymous");
  assert.equal(settingsRow?.daily_capture_interval_minutes, 30);
  assert.equal(settingsRow?.financial_year_start_month, 4);

  // Portfolios: 2 created, transaction counts match the source (pa: 3
  // rows -- buy/reversal/buy; pb: 1 row).
  const txCountRows = await client.all<{ portfolio_id: string; n: number }>(
    "SELECT portfolio_id, COUNT(*) AS n FROM transactions WHERE user_id = 'b' GROUP BY portfolio_id",
    [],
  );
  const totalTx = txCountRows.reduce((sum, row) => sum + Number(row.n), 0);
  assert.equal(totalTx, 4);

  // Watchlist security resolved to the SAME security portfolio A's own
  // restored ALPHA holding resolved to (ticker match) -- never a duplicate
  // `securities` row.
  const watchSecurityId = await client.get<{ security_id: string }>(
    "SELECT security_id FROM watchlist_entries WHERE user_id = 'b' AND kind = 'security'",
    [],
  );
  const heldSecurityId = await client.get<{ security_id: string }>(
    `SELECT ps.security_id FROM portfolio_securities ps
     JOIN portfolios p ON p.id = ps.portfolio_id
     WHERE ps.user_id = 'b' AND p.code = 'A'`,
    [],
  );
  assert.ok(watchSecurityId);
  assert.ok(heldSecurityId);
  assert.equal(watchSecurityId?.security_id, heldSecurityId?.security_id);

  // Price history restored for the newly-resolved security.
  const priceRows = await client.all<Record<string, unknown>>(
    "SELECT close_decimal FROM price_observations WHERE scope_user_id = 'b'",
    [],
  );
  assert.equal(priceRows.length, 1);
  assert.equal(priceRows[0]?.close_decimal, "12.34");

  // --- Idempotent re-restore: same backup, same account -- no duplicates.
  const commit2 = await commitSystemBackupImport(
    ctxFor(client, "b"),
    backup,
    "system-backup.json",
  );
  assert.equal(commit2.ok, true);
  if (!commit2.ok) return;
  assert.equal(
    commit2.result.portfolios.every((p) => p.idempotent),
    true,
  );
  assert.deepEqual(
    commit2.result.portfolios.map((p) => p.portfolioId).sort(),
    commit1.result.portfolios.map((p) => p.portfolioId).sort(),
  );
  const portfolioCountAfterRetry = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM portfolios WHERE user_id = 'b'",
    [],
  );
  assert.equal(portfolioCountAfterRetry?.n, 2);
  const watchlistCountAfterRetry = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM watchlist_entries WHERE user_id = 'b'",
    [],
  );
  assert.equal(watchlistCountAfterRetry?.n, 2);
  const priceCountAfterRetry = await client.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM price_observations WHERE scope_user_id = 'b'",
    [],
  );
  assert.equal(priceCountAfterRetry?.n, 1);
});

test("precondition: restore into an account with an unrelated pre-existing portfolio is rejected, no writes occur", async () => {
  const { client } = await fixture();
  const exported = await exportSystemBackup(ctxFor(client, "a"));
  assert.equal(exported.ok, true);
  if (!exported.ok) return;

  const { db, client: clientB } = await fixture();
  seedFreshAccount(db, "c");
  db.exec(`
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('unrelated','c','U','Unrelated portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
  `);

  const preview = await previewSystemBackupImport(
    ctxFor(clientB, "c"),
    exported.backup,
  );
  assert.equal(preview.ok, true);
  if (preview.ok) {
    assert.equal(preview.preview.precondition.fresh, false);
    assert.equal(preview.preview.precondition.unrelatedPortfolioCount, 1);
  }

  const commit = await commitSystemBackupImport(
    ctxFor(clientB, "c"),
    exported.backup,
    "system-backup.json",
  );
  assert.equal(commit.ok, false);
  if (commit.ok) return;
  assert.equal(commit.status, 409);
  assert.match(commit.message, /fresh account/);

  // No writes occurred: settings untouched, no new portfolios.
  const settingsRow = await clientB.get<Record<string, unknown>>(
    "SELECT financial_year_start_month FROM user_settings WHERE user_id = 'c'",
    [],
  );
  assert.equal(settingsRow?.financial_year_start_month, 7);
  const portfolioCount = await clientB.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM portfolios WHERE user_id = 'c'",
    [],
  );
  assert.equal(portfolioCount?.n, 1);
});

test("export: account settings not found (cross-user/unknown-account probe) fails closed", async () => {
  const { client } = await fixture();
  const result = await exportSystemBackup(ctxFor(client, "nonexistent-user"));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
});

test("per-portfolio failure isolation: a bad second portfolio does not half-restore silently, and the good one stays idempotent on retry", async () => {
  const { client } = await fixture();
  const exported = await exportSystemBackup(ctxFor(client, "a"));
  assert.equal(exported.ok, true);
  if (!exported.ok) return;

  // Corrupt the SECOND nested bundle's base currency so it structurally
  // validates but is rejected at COMMIT time by EXP-001's own currency
  // precondition (unchanged, reused as-is).
  const backup: SystemBackupV1 = {
    ...exported.backup,
    portfolios: exported.backup.portfolios.map((bundle, index) =>
      index === 1
        ? {
            ...bundle,
            portfolio: { ...bundle.portfolio, baseCurrencyCode: "USD" },
          }
        : bundle,
    ),
  };

  const { db } = await fixture();
  seedFreshAccount(db, "d");
  const clientD = createSqliteSqlClient(db);

  const commit1 = await commitSystemBackupImport(
    ctxFor(clientD, "d"),
    backup,
    "system-backup.json",
  );
  assert.equal(commit1.ok, false);
  if (commit1.ok) return;
  assert.match(commit1.message, /#2/);
  assert.match(commit1.message, /1 of 2/);

  const countAfterFirst = await clientD.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM portfolios WHERE user_id = 'd'",
    [],
  );
  assert.equal(countAfterFirst?.n, 1);

  // Retry the identical (still-corrupt) backup: the first portfolio stays
  // idempotent (no duplicate), the second still fails the same way.
  const commit2 = await commitSystemBackupImport(
    ctxFor(clientD, "d"),
    backup,
    "system-backup.json",
  );
  assert.equal(commit2.ok, false);
  const countAfterSecond = await clientD.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM portfolios WHERE user_id = 'd'",
    [],
  );
  assert.equal(countAfterSecond?.n, 1);
});

test("a watch-only security with no matching ticker anywhere is skipped, never fabricated", async () => {
  const { db, client } = await fixture();
  // Add a THIRD watchlist entry for GAMMA (s3) -- never held in any
  // portfolio, so it has no restorable identity in this v1.
  db.exec(`
    INSERT INTO watchlist_entries(id,user_id,kind,security_id,display_order,created_at,version) VALUES
      ('we3','a','security','s3',2,'2026-08-01T00:00:00.000Z',1);
  `);
  const exported = await exportSystemBackup(ctxFor(client, "a"));
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  assert.equal(exported.backup.watchlistEntries.length, 3);

  // A genuinely SEPARATE, empty database -- `securities`/`security_
  // identifiers` are shared/deployment-wide tables, so restoring into the
  // SAME physical db `fixture()` used would find GAMMA's pre-existing row
  // regardless of this test's premise. A real fresh-deployment restore
  // starts from an empty shared master too.
  const freshDb = await migratedDatabase();
  seedFreshAccount(freshDb, "e");
  const freshClient = createSqliteSqlClient(freshDb);
  const commit = await commitSystemBackupImport(
    ctxFor(freshClient, "e"),
    exported.backup,
    "system-backup.json",
  );
  assert.equal(commit.ok, true);
  if (!commit.ok) return;
  assert.equal(commit.result.watchlist.securitiesAdded, 1);
  assert.equal(commit.result.watchlist.securitiesSkipped, 1);
  const watchlistCount = await freshClient.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM watchlist_entries WHERE user_id = 'e'",
    [],
  );
  assert.equal(watchlistCount?.n, 2); // 1 security + 1 pair; GAMMA skipped
});

// ---------------------------------------------------------------------------
// B1 ruling (reviewer, 2026-08-27): retries must actually work. The
// realistic migration-restore failure is an INTERRUPTION mid-replay (e.g. a
// Worker timeout, or an oversell error surfacing partway through a
// portfolio's transaction replay) -- NOT a permanently-broken bundle. This
// test seeds the DB state a genuine interruption would leave behind (a
// `failed` `import_batches` row for portfolio B's own fingerprint, whose
// `target_portfolio_id` points at a PARTIALLY-replayed leftover portfolio --
// exactly what `commitPortfolioBundleImport` itself would leave if replay
// had halted right after creating the portfolio, e.g. on an oversell it
// hits partway through a longer transaction list) DIRECTLY via SQL, rather
// than by submitting an inherently-unreplayable bundle: replaying the SAME
// bundle content into a FRESH portfolio (this design's own retry strategy,
// per B1's own ruling -- "the retry's fresh portfolio replaces it cleanly")
// is deterministic, so a bundle that oversells on attempt 1 would oversell
// identically on every subsequent attempt with IDENTICAL content -- the
// interruption itself, not the bundle's data, is what a real retry needs to
// recover from. This directly exercises: (1) rule 1's ANY-status
// relatedness (the leftover's `failed` batch keeps it "related" so the
// precondition does not itself block the retry), (2) the leftover being
// archived automatically BEFORE the retry replaces it, (3) the retry then
// succeeding cleanly, (4) a further idempotent run, and (5) the archived
// remnant never tripping the precondition afterward.
// ---------------------------------------------------------------------------
test("B1: a portfolio with a leftover partial-replay remnant from an interrupted attempt is archived automatically, the retry succeeds, and a third run is idempotent", async () => {
  const { client } = await fixture();
  const exported = await exportSystemBackup(ctxFor(client, "a"));
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const backup = exported.backup;
  const bundleB = backup.portfolios.find((p) => p.portfolio.code === "B");
  assert.ok(bundleB);
  const fingerprintB = await fingerprintBundle(bundleB);

  const { db, client: clientG } = await fixture();
  seedFreshAccount(db, "g");
  // Directly seed the "interrupted mid-replay" leftover: a partially
  // created portfolio B (no transactions replayed at all is the simplest
  // faithful shape -- `commitPortfolioBundleImport` sets
  // `target_portfolio_id` immediately after `portfolios.create()`, BEFORE
  // any transaction replay begins) plus a `failed` `import_batches` row for
  // bundle B's own fingerprint pointing at it.
  const leftoverPortfolioId = "leftover-b";
  const batchId = "batch-leftover-b";
  db.exec(`
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('${leftoverPortfolioId}','g','B','Portfolio B','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO import_batches(id,user_id,target_portfolio_id,parser_format,parser_version,filename,byte_size,file_sha256,status,created_at,updated_at) VALUES
      ('${batchId}','g','${leftoverPortfolioId}','portfolio-bundle-json','1','system-backup.json',100,'${fingerprintB}','failed','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z');
  `);

  // Sanity: the leftover, though not yet committed, is "related" (rule 1)
  // and does not itself trip the precondition -- the retry is expected to
  // proceed, not be rejected as "not a fresh account".
  const fingerprints = await Promise.all(
    backup.portfolios.map((bundle) => fingerprintBundle(bundle)),
  );
  const unrelatedBeforeRetry = await countUnrelatedPortfolios(
    clientG,
    "g",
    fingerprints,
  );
  assert.equal(unrelatedBeforeRetry, 0);

  const commit1 = await commitSystemBackupImport(
    ctxFor(clientG, "g"),
    backup,
    "system-backup.json",
  );
  assert.equal(commit1.ok, true);
  if (!commit1.ok) return;
  assert.equal(
    commit1.result.portfolios.every((p) => !p.idempotent),
    true,
  );

  // The leftover is now archived; exactly one ACTIVE portfolio exists for
  // this retry's own result id (the new one the successful retry created --
  // note `portfolios_user_id_code_unique` is unconditional, not
  // status-scoped, so the archived leftover STILL holds the original code
  // "B" forever; the new portfolio's `create()` call collides and falls
  // back to EXP-001's own pre-existing "-restored" suffix retry, per its
  // documented collision handling -- a real, honest, minor cosmetic
  // consequence of archiving-not-deleting the leftover, not a defect).
  const leftoverRow = await clientG.get<{ status: string }>(
    "SELECT status FROM portfolios WHERE id = ?",
    [leftoverPortfolioId],
  );
  assert.equal(leftoverRow?.status, "archived");
  // Index-based, not code-based -- the persisted code is honestly reported
  // (see `commitSystemBackupImport`'s own comment) but is now
  // "B-restored" (or similar), not "B", precisely BECAUSE the archived
  // leftover still holds "B" -- array order is still the backup's own
  // portfolio order, so `[1]` is unambiguously portfolio B's result.
  const newPortfolioId = commit1.result.portfolios[1]?.portfolioId;
  assert.ok(newPortfolioId);
  assert.notEqual(commit1.result.portfolios[1]?.code, "B");
  assert.notEqual(newPortfolioId, leftoverPortfolioId);
  const newPortfolioRow = await clientG.get<{ status: string }>(
    "SELECT status FROM portfolios WHERE id = ?",
    [newPortfolioId],
  );
  assert.equal(newPortfolioRow?.status, "active");
  const activePortfolioCount = await clientG.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM portfolios WHERE user_id = 'g' AND status = 'active'",
    [],
  );
  assert.equal(activePortfolioCount?.n, 2); // A, new active B (whatever its code)
  const totalPortfolioCount = await clientG.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM portfolios WHERE user_id = 'g'",
    [],
  );
  assert.equal(totalPortfolioCount?.n, 3); // A, archived leftover B, new active B

  // The archived remnant does not itself trip the precondition on a later
  // (idempotent) run.
  const unrelatedAfterRetry = await countUnrelatedPortfolios(
    clientG,
    "g",
    fingerprints,
  );
  assert.equal(unrelatedAfterRetry, 0);

  // Third run: fully idempotent, no new portfolios, no duplicate leftover.
  const commit2 = await commitSystemBackupImport(
    ctxFor(clientG, "g"),
    backup,
    "system-backup.json",
  );
  assert.equal(commit2.ok, true);
  if (!commit2.ok) return;
  assert.equal(
    commit2.result.portfolios.every((p) => p.idempotent),
    true,
  );
  const totalAfterThirdRun = await clientG.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM portfolios WHERE user_id = 'g'",
    [],
  );
  assert.equal(totalAfterThirdRun?.n, 3);
});

// ---------------------------------------------------------------------------
// B2 ruling (reviewer, 2026-08-27): archived portfolios are DATA, not
// noise -- exported and restored with archived status preserved.
// ---------------------------------------------------------------------------
test("B2: an archived portfolio is exported and round-trips archived, not silently resurrected active", async () => {
  const { db, client } = await fixture();
  db.exec(`UPDATE portfolios SET status = 'archived' WHERE id = 'pb'`);

  const exported = await exportSystemBackup(ctxFor(client, "a"));
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const bundleA = exported.backup.portfolios.find(
    (p) => p.portfolio.code === "A",
  );
  const bundleB = exported.backup.portfolios.find(
    (p) => p.portfolio.code === "B",
  );
  assert.equal(bundleA?.portfolio.status, "active");
  assert.equal(bundleB?.portfolio.status, "archived");

  seedFreshAccount(db, "h");
  const commit = await commitSystemBackupImport(
    ctxFor(client, "h"),
    exported.backup,
    "system-backup.json",
  );
  assert.equal(commit.ok, true);
  if (!commit.ok) return;

  const statusRows = await client.all<{ code: string; status: string }>(
    "SELECT code, status FROM portfolios WHERE user_id = 'h' ORDER BY code",
    [],
  );
  assert.deepEqual(
    statusRows.map((row) => ({ code: row.code, status: row.status })),
    [
      { code: "A", status: "active" },
      { code: "B", status: "archived" },
    ],
  );
});

// ---------------------------------------------------------------------------
// S3 fold: a price section with rows in the file but ZERO of them resolve
// to a restored security must not 409 a restore whose other pieces (account
// settings, watchlist, every portfolio) already committed successfully --
// the SAME "no usable price history is a legitimate outcome" reasoning the
// empty-CSV case already applies.
// ---------------------------------------------------------------------------
test("S3: a price section whose rows all fail to resolve does not fail an otherwise-successful restore", async () => {
  const { client } = await fixture();
  const exported = await exportSystemBackup(ctxFor(client, "a"));
  assert.equal(exported.ok, true);
  if (!exported.ok) return;

  // Append one well-formed row for a ticker ("ZZZZ") that will never exist
  // anywhere in the fresh target account.
  const extraRow = [
    PRICE_BACKUP_FORMAT_VERSION,
    "owner-import",
    "unit-test",
    "ZZZZ",
    "ASX",
    "AUD",
    "2026-08-20",
    "1.00",
    "2026-08-20T06:00:00.000Z",
    "+10:00",
    "eod",
    "observed",
    "raw",
    "",
  ].join(",");
  const backup: SystemBackupV1 = {
    ...exported.backup,
    priceBackupCsv: exported.backup.priceBackupCsv + extraRow + "\r\n",
  };

  const { db } = await fixture();
  seedFreshAccount(db, "i");
  const freshClient = createSqliteSqlClient(db);
  const commit = await commitSystemBackupImport(
    ctxFor(freshClient, "i"),
    backup,
    "system-backup.json",
  );
  assert.equal(commit.ok, true);
  if (!commit.ok) return;
  // The ORIGINAL resolvable row (ALPHA) still resolves and gets written --
  // only the injected unresolvable one is honestly reported as unresolved.
  assert.equal(commit.result.priceBackup?.written, 1);
  assert.equal(commit.result.priceBackup?.unresolvedRowCount, 1);
  assert.equal(commit.result.priceBackup?.note, null);
});

test("S3: a price section whose EVERY row fails to resolve still succeeds, honestly reporting zero written", async () => {
  const { client } = await fixture();
  const exported = await exportSystemBackup(ctxFor(client, "a"));
  assert.equal(exported.ok, true);
  if (!exported.ok) return;

  const unresolvableRow = [
    PRICE_BACKUP_FORMAT_VERSION,
    "owner-import",
    "unit-test",
    "ZZZZ",
    "ASX",
    "AUD",
    "2026-08-20",
    "1.00",
    "2026-08-20T06:00:00.000Z",
    "+10:00",
    "eod",
    "observed",
    "raw",
    "",
  ].join(",");
  const headerLine = exported.backup.priceBackupCsv.split("\r\n")[0]!;
  const backup: SystemBackupV1 = {
    ...exported.backup,
    priceBackupCsv: `${headerLine}\r\n${unresolvableRow}\r\n`,
  };

  const { db } = await fixture();
  seedFreshAccount(db, "j");
  const freshClient = createSqliteSqlClient(db);
  const commit = await commitSystemBackupImport(
    ctxFor(freshClient, "j"),
    backup,
    "system-backup.json",
  );
  assert.equal(commit.ok, true);
  if (!commit.ok) return;
  assert.equal(commit.result.priceBackup?.written, 0);
  assert.equal(commit.result.priceBackup?.unresolvedRowCount, 1);
  assert.ok(commit.result.priceBackup?.note);
});

// ---------------------------------------------------------------------------
// Review corrections (BLOCKING, 2026-08-28) to commit 7616f75 "EXP-003: make
// system backup free-plan resumable". Behavioural tests (not source-regex)
// per the reviewer's own instruction -- `app/api/system-backup/export/
// route.ts` and `app/components/system-backup-panel.tsx` cannot be imported
// directly under the plain Node test runner (the former transitively pulls
// in `next/headers` via `system-backup-actions.ts` -> `portfolio-actions.ts`;
// the latter is a `.tsx` file, an "Unknown file extension" under this
// runner), so the exact logic each bug lived in was extracted into a plain,
// dependency-free `.ts` sibling module purely so it could be exercised
// directly -- mirroring `tests/div-013.test.ts`'s identical, pre-existing
// pattern for this same constraint.
// ---------------------------------------------------------------------------

test("B1: mode=core success response is the {ok:true, backup} envelope the panel's fetchJson requires, not the bare backup object", async () => {
  const { client } = await fixture();
  const exported = await exportSystemBackupCore(ctxFor(client, "a"));
  assert.equal(exported.ok, true);
  if (!exported.ok) return;

  const shape = systemBackupCoreExportResponseShape(exported);
  assert.equal(shape.status, 200);
  // Mirrors the panel's OWN discriminator (`fetchJson` in
  // `system-backup-panel.tsx`): parse the body exactly as the browser would
  // after it crosses the wire, then check it against the `{ok:true} & T`
  // shape `fetchJson` requires before it will ever hand a `backup` back to
  // the caller.
  const wireBody = JSON.parse(JSON.stringify(shape.body)) as
    { ok: true; backup: SystemBackupV1 } | { ok: false; message: string };
  assert.equal(wireBody.ok, true);
  if (!wireBody.ok) return;
  assert.deepEqual(wireBody.backup, exported.backup);
});

test("B1: mode=core failure still carries its own status/message, not silently swallowed", () => {
  const shape = systemBackupCoreExportResponseShape({
    ok: false,
    status: 404,
    message: "Account settings were not found.",
  });
  assert.equal(shape.status, 404);
  const wireBody = JSON.parse(JSON.stringify(shape.body)) as
    { ok: true; backup: SystemBackupV1 } | { ok: false; message: string };
  assert.equal(wireBody.ok, false);
  if (wireBody.ok) return;
  assert.equal(wireBody.message, "Account settings were not found.");
});

test("B3: a fresh cursor (nothing claimed yet) is vacuously valid; a cursor whose claimed batch still exists is valid; one whose claimed batch is gone is invalid", () => {
  assert.equal(isResumeCursorValid([], new Set()), true);
  assert.equal(
    isResumeCursorValid(
      ["batch-1", "batch-2"],
      new Set(["batch-1", "batch-2", "batch-3"]),
    ),
    true,
  );
  // The exact B3 failure scenario: a resume claims parts 0..1 wrote
  // batch-1/batch-2, but this deployment/database (fresh, or after the
  // owner undid the earlier restore) has no record of batch-2 -- discard
  // the whole cursor, never trust it partially.
  assert.equal(
    isResumeCursorValid(["batch-1", "batch-2"], new Set(["batch-1"])),
    false,
  );
});

test("B3: parseStoredRestoreProgress discards a pre-B3 cursor with no batchIds (unverifiable, not merely unverified) and any malformed/absent value, resetting to zero", () => {
  assert.deepEqual(parseStoredRestoreProgress(null), EMPTY_RESTORE_PROGRESS);
  assert.deepEqual(
    parseStoredRestoreProgress("not json"),
    EMPTY_RESTORE_PROGRESS,
  );
  assert.deepEqual(
    parseStoredRestoreProgress(
      JSON.stringify({
        nextChunk: 3,
        written: 600,
        unresolvedRowCount: 0,
        unchangedCount: 0,
        // No `batchIds` -- a cursor written before this fix.
      }),
    ),
    EMPTY_RESTORE_PROGRESS,
  );
  const validCursor = {
    nextChunk: 2,
    written: 400,
    unresolvedRowCount: 0,
    unchangedCount: 0,
    batchIds: ["batch-1", "batch-2"],
  };
  assert.deepEqual(
    parseStoredRestoreProgress(JSON.stringify(validCursor)),
    validCursor,
  );
});

test("B3: the storage key stays scoped to the file digest (unchanged), never data-bearing itself", () => {
  assert.equal(
    restoreProgressStorageKey("abc123"),
    "yieldtome-system-restore-v1:abc123",
  );
});
