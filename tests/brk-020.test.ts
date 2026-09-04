// BRK-020 -- the gap BUG-018's own investigation disclosed: `import_batches`'
// file-level dedup key (`import_batches_user_file_parser_unique` on
// `(user_id, file_sha256, parser_format, parser_version)`) was a FULL unique
// index, so `startUpload`'s `ON CONFLICT ... DO NOTHING` resolved a re-upload/
// re-sync whose content hash matched a REVERSED batch to that terminal batch
// (`reused: true`, rows already `commit_status = 'reversed'`, nothing
// committable). A Sharesight re-sync after reversing a batch with NOTHING else
// changed in the account (the realistic case) hashes byte-identically and was
// therefore permanently stuck; the CSV route's `supersedesBatchId` escape hatch
// had the same hole for an identical corrected file (its existing test only
// passes because it uploads a DIFFERENT hash).
//
// Fix: the index is narrowed to a PARTIAL unique index `WHERE status <>
// 'reversed'` (`db/schema.ts`, migration
// `0062_brk_020_reversed_batch_file_key_partial_index.sql`), `startUpload`'s
// `ON CONFLICT` target repeats that predicate (SQLite's partial-index matching
// rule), and its duplicate-lookup fallback filters the same way so it can never
// hand back a reversed batch as the "existing" one.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import {
  commitPortfolioBundleImport,
  exportPortfolioBundle,
  fingerprintBundle,
} from "../app/portfolio-bundle-service.ts";
import {
  linkSharesightPortfolioWithContext,
  runSharesightSyncWithContext,
} from "../app/sharesight-sync-service.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  PORTFOLIO_BUNDLE_PARSER_FORMAT,
  PORTFOLIO_BUNDLE_SCHEMA_VERSION,
} from "../domain/exports/portfolio-bundle.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION } from "../domain/imports/index.ts";
import type {
  SharesightClient,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
} from "../domain/sharesight/index.ts";

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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-09-03', '2026-09-03', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-09-03', '2026-09-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-09-03', '2026-09-03', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-09-03', '2026-09-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-09-03', '2026-09-03', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-09-03', '2026-09-03', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-09-03', '2026-09-03');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-09-03', '2026-09-03');
  `);
  return database;
}

const CSV_UPLOAD = {
  targetPortfolioId: "portfolio-a",
  parserFormat: "strict-versioned-csv",
  parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
  filename: "ledger.csv",
  byteSize: 100,
  fileSha256: "sha-identical",
} as const;

function markReversed(database: DatabaseSync, batchId: string): void {
  database
    .prepare(
      `UPDATE import_batches
          SET status = 'reversed', reversed_at = '2026-09-03T00:00:00Z',
              version = version + 1
        WHERE id = ?`,
    )
    .run(batchId);
}

function batchStatus(database: DatabaseSync, batchId: string): string {
  return (
    database
      .prepare("SELECT status FROM import_batches WHERE id = ?")
      .get(batchId) as { status: string }
  ).status;
}

test("BRK-020 regression: startUpload with a file key identical to a REVERSED batch mints a fresh batch instead of reusing the terminal one; live-batch dedupe is unchanged; the fallback lookup never returns the reversed row -- fails pre-fix", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const staging = createOwnedImportStagingRepository(client);

  const first = await staging.startUpload("user-a", CSV_UPLOAD);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.reused, false);

  // Dedupe of a LIVE batch is untouched: the identical upload resolves to
  // the same batch.
  const duplicateWhileLive = await staging.startUpload("user-a", CSV_UPLOAD);
  assert.equal(duplicateWhileLive.ok, true);
  if (!duplicateWhileLive.ok) return;
  assert.equal(duplicateWhileLive.reused, true);
  assert.equal(duplicateWhileLive.batch.id, first.batch.id);

  markReversed(database, first.batch.id);

  // The stuck shape: identical key, existing batch is terminal ('reversed').
  const afterReversal = await staging.startUpload("user-a", CSV_UPLOAD);
  assert.equal(afterReversal.ok, true);
  if (!afterReversal.ok) return;
  assert.equal(
    afterReversal.reused,
    false,
    "an upload colliding only with a reversed batch must mint a new batch",
  );
  assert.notEqual(afterReversal.batch.id, first.batch.id);
  assert.equal(afterReversal.batch.status, "uploaded");
  assert.equal(afterReversal.batch.targetPortfolioId, "portfolio-a");
  assert.equal(batchStatus(database, first.batch.id), "reversed");

  // With a reversed AND a live batch both holding the key, the duplicate
  // lookup must resolve to the LIVE one -- never the reversed row.
  const duplicateAfterReversal = await staging.startUpload(
    "user-a",
    CSV_UPLOAD,
  );
  assert.equal(duplicateAfterReversal.ok, true);
  if (!duplicateAfterReversal.ok) return;
  assert.equal(duplicateAfterReversal.reused, true);
  assert.equal(duplicateAfterReversal.batch.id, afterReversal.batch.id);

  // Reverse again: a third generation is minted, and all three reversed/live
  // rows coexist under the same key.
  markReversed(database, afterReversal.batch.id);
  const third = await staging.startUpload("user-a", CSV_UPLOAD);
  assert.equal(third.ok, true);
  if (!third.ok) return;
  assert.equal(third.reused, false);
  assert.notEqual(third.batch.id, first.batch.id);
  assert.notEqual(third.batch.id, afterReversal.batch.id);
  const keyRows = database
    .prepare(
      `SELECT count(*) AS count FROM import_batches
        WHERE user_id = 'user-a' AND file_sha256 = ? AND parser_format = ? AND parser_version = ?`,
    )
    .get(
      CSV_UPLOAD.fileSha256,
      CSV_UPLOAD.parserFormat,
      CSV_UPLOAD.parserVersion,
    ) as { count: number };
  assert.equal(keyRows.count, 3);
});

test("BRK-020: the partial unique index itself -- a second NON-reversed row on the same (user_id, file_sha256, parser_format, parser_version) is rejected, one is permitted once the first is reversed, and the predicate is present in the stored index SQL (raw SQL, bypassing the application layer)", async () => {
  const database = await migratedDatabase();
  const insert = (id: string, status: string) =>
    database
      .prepare(
        `INSERT INTO import_batches (
           id, user_id, target_portfolio_id, parser_format, parser_version, filename,
           byte_size, file_sha256, status, created_at, updated_at, version
         ) VALUES (?, 'user-a', 'portfolio-a', 'strict-versioned-csv', ?, 'f.csv',
           1, 'sha-raw', ?, '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z', 1)`,
      )
      .run(id, SUPPORTED_IMPORT_PARSER_VERSION, status);

  insert("raw-1", "committed");
  assert.throws(
    () => insert("raw-2", "uploaded"),
    /UNIQUE constraint failed/,
    "a live batch must still occupy the key",
  );
  // A batch mid-reversal is NOT terminal and must still occupy the key.
  database
    .prepare(
      "UPDATE import_batches SET status = 'reversing' WHERE id = 'raw-1'",
    )
    .run();
  assert.throws(() => insert("raw-2", "uploaded"), /UNIQUE constraint failed/);
  database
    .prepare("UPDATE import_batches SET status = 'reversed' WHERE id = 'raw-1'")
    .run();
  insert("raw-2", "uploaded");
  assert.throws(
    () => insert("raw-3", "uploaded"),
    /UNIQUE constraint failed/,
    "the new live batch occupies the key in turn",
  );

  const indexSql = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'import_batches_user_file_parser_unique'",
    )
    .get() as { sql: string };
  assert.match(indexSql.sql, /WHERE .*status.* <> 'reversed'/);
});

test("BRK-020: ownership isolation -- another owner's LIVE batch with the identical file hash neither dedupes nor blocks this owner's upload", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const staging = createOwnedImportStagingRepository(client);
  const other = await staging.startUpload("user-b", {
    ...CSV_UPLOAD,
    targetPortfolioId: "portfolio-b",
  });
  assert.equal(other.ok, true);
  if (!other.ok) return;
  const mine = await staging.startUpload("user-a", CSV_UPLOAD);
  assert.equal(mine.ok, true);
  if (!mine.ok) return;
  assert.equal(mine.reused, false);
  assert.notEqual(mine.batch.id, other.batch.id);
  assert.equal(mine.batch.userId, "user-a");
});

test("BRK-020: a corrected CSV upload with IDENTICAL content that supersedes a reversed batch now mints the successor (the supersedesBatchId path used to collide on the full index too)", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const staging = createOwnedImportStagingRepository(client);
  const original = await staging.startUpload("user-a", CSV_UPLOAD);
  assert.equal(original.ok, true);
  if (!original.ok) return;
  markReversed(database, original.batch.id);

  const corrected = await staging.startUpload("user-a", {
    ...CSV_UPLOAD,
    supersedesBatchId: original.batch.id,
  });
  assert.equal(corrected.ok, true);
  if (!corrected.ok) return;
  assert.equal(corrected.reused, false);
  assert.notEqual(corrected.batch.id, original.batch.id);
  assert.equal(corrected.batch.supersedesBatchId, original.batch.id);
  assert.equal(corrected.batch.targetPortfolioId, "portfolio-a");
  assert.equal(corrected.batch.fileSha256, CSV_UPLOAD.fileSha256);
});

// `FIND_EXISTING_BATCH_SQL` is the exact query `findExistingBatch`
// (app/portfolio-bundle-service.ts) runs post-fix. This is a PIN, not a
// pre/post-fix differential (it never imports the app module, so it can't
// observe a regression there) -- it exists to (a) prove the ORDER BY
// tiebreak resolves correctly in isolation, independent of physical row
// order, and (b) capture the query's EXPLAIN QUERY PLAN so a change that
// makes the plan materially worse is visible here. The differential proof
// that the REAL function is fixed is the next test, which calls
// `commitPortfolioBundleImport` and fails pre-fix.
const FIND_EXISTING_BATCH_SQL = `SELECT id, status, target_portfolio_id FROM import_batches
     WHERE user_id = ? AND file_sha256 = ? AND parser_format = ? AND parser_version = ?
     ORDER BY CASE WHEN status <> 'reversed' THEN 0 ELSE 1 END, updated_at DESC
     LIMIT 1`;

test("BRK-020 F1 (pin): findExistingBatch's query resolves to the LIVE row over a REVERSED row sharing the same key regardless of insertion order or recency, and its EXPLAIN QUERY PLAN against the REAL migrated schema is an owner-scoped index seek plus a temp B-tree sort (not a regression into an unindexed scan or a scan of an unrelated table)", async () => {
  // Built with the file's own `migratedDatabase()` helper -- against the
  // REAL schema, `import_batches_owner_status_updated_at_idx` (user_id,
  // status, updated_at) covers this query's `user_id = ?` predicate, so the
  // planner seeks that index rather than scanning the table; only the
  // ORDER BY's tiebreak still needs a temp B-tree. A hand-rolled, index-free
  // `CREATE TABLE import_batches` (as this test previously used) records
  // the OPPOSITE of production and would miss a real regression in either
  // direction.
  const database = await migratedDatabase();
  const insert = (id: string, status: string, updatedAt: string): void => {
    database
      .prepare(
        `INSERT INTO import_batches (
           id, user_id, target_portfolio_id, parser_format, parser_version, filename,
           byte_size, file_sha256, status, created_at, updated_at, version
         ) VALUES (?, 'user-a', NULL, 'portfolio-bundle-json', '1', 'b.json',
           1, 'sha-bundle', ?, '2026-09-03T00:00:00Z', ?, 1)`,
      )
      .run(id, status, updatedAt);
  };
  // Reversed row inserted FIRST -- lower rowid -- and given the LATER
  // `updated_at` too, so the assertion cannot pass by accident of either
  // ordering: only "prefer non-reversed" can produce the right answer.
  insert("rev-old", "reversed", "2026-09-03T02:00:00Z");
  insert("live-new", "failed", "2026-09-03T01:00:00Z");

  const row = database
    .prepare(FIND_EXISTING_BATCH_SQL)
    .get("user-a", "sha-bundle", "portfolio-bundle-json", "1") as {
    id: string;
    status: string;
  };
  assert.equal(
    row.id,
    "live-new",
    "the live (non-reversed) row must win regardless of insertion order or recency",
  );
  assert.equal(row.status, "failed");

  const plan = database
    .prepare(`EXPLAIN QUERY PLAN ${FIND_EXISTING_BATCH_SQL}`)
    .all("user-a", "sha-bundle", "portfolio-bundle-json", "1") as Array<{
    detail: string;
  }>;
  const planText = plan.map((step) => step.detail).join(" | ");
  // Real plan (verified against the migrated schema): the planner seeks
  // `import_batches_owner_status_updated_at_idx` on `user_id = ?` -- that
  // index does not cover `file_sha256`/`parser_format`/`parser_version`, so
  // those are filtered in the VM -- then sorts the owner's matching rows in
  // a temp B-tree for the ORDER BY tiebreak. This is an owner-bounded index
  // seek followed by a temp sort of that owner's matching rows, not a
  // table scan; acceptable at this table's per-owner size. Recorded here so
  // a regression that makes this materially worse (e.g. a scan of an
  // unrelated table, or losing the index seek) is visible in the plan text.
  assert.match(
    planText,
    /SEARCH import_batches USING INDEX import_batches_owner_status_updated_at_idx \(user_id=\?\)/i,
  );
  assert.match(planText, /USE TEMP B-TREE FOR ORDER BY/i);
});

test("BRK-020 F1: commitPortfolioBundleImport reuses the LIVE ('reversing') batch sharing the bundle's fingerprint, never the REVERSED one under the same key -- fails pre-fix (findExistingBatch picks the reversed row, so the reuse UPDATE tries to make TWO non-reversed rows share the partial-unique key and throws 'UNIQUE constraint failed', where it should instead complete and leave the reversed row untouched)", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const exported = await exportPortfolioBundle(
    { client, userId: "user-a", requestId: randomUUID() },
    "portfolio-a",
  );
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const bundle = exported.bundle;
  const fingerprint = await fingerprintBundle(bundle);

  const insertBatch = (id: string, status: string): void => {
    database
      .prepare(
        `INSERT INTO import_batches (
           id, user_id, target_portfolio_id, parser_format, parser_version, filename,
           byte_size, file_sha256, status, created_at, updated_at, version
         ) VALUES (?, 'user-a', NULL, ?, ?, 'b.json', 1, ?, ?,
           '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z', 1)`,
      )
      .run(
        id,
        PORTFOLIO_BUNDLE_PARSER_FORMAT,
        String(PORTFOLIO_BUNDLE_SCHEMA_VERSION),
        fingerprint,
        status,
      );
  };
  // `rev-old` is a terminal reversed generation of this bundle's restore;
  // `live-new` is a SECOND, still-live generation that is itself mid-reversal
  // ('reversing' -- BRK-020's own schema comment: "A batch mid-reversal
  // ('reversing') still occupies the key"). 'reversing' sorts AFTER
  // 'reversed' in `import_batches_owner_status_updated_at_idx` (the index
  // the planner actually picks for this query, per this test file's own
  // EXPLAIN QUERY PLAN check above), which is exactly the "plan luck" the
  // Reviewer flagged: a live status that happens to sort before 'reversed'
  // (e.g. 'committed', 'failed') masks the bug; 'reversing' does not.
  insertBatch("rev-old", "reversed");
  insertBatch("live-new", "reversing");

  const result = await commitPortfolioBundleImport(
    { client, userId: "user-a", requestId: randomUUID() },
    bundle,
    "b.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : (result as { message: string }).message,
  );
  if (!result.ok) return;

  const revStatus = database
    .prepare("SELECT status FROM import_batches WHERE id = 'rev-old'")
    .get() as { status: string };
  assert.equal(
    revStatus.status,
    "reversed",
    "the reversed audit row must never be rewritten",
  );

  const liveStatus = database
    .prepare("SELECT status FROM import_batches WHERE id = 'live-new'")
    .get() as { status: string };
  assert.equal(
    liveStatus.status,
    "committed",
    "the live batch, not the reversed one, must be the one reused and committed",
  );
});

test("BRK-020 B3 (pin, not a regression test): with ONLY reversed rows sharing the bundle's fingerprint key (no live row at all), commitPortfolioBundleImport reuses and resets the most recently updated REVERSED row rather than minting a fresh batch -- this is this module's pre-existing, deliberate bundle-restore semantics (findExistingBatch's own comment and docs/ARCHITECTURE.md's BRK-020 entry), not a bug; this test exists only to make that outcome visible so a future change cannot silently alter it", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const exported = await exportPortfolioBundle(
    { client, userId: "user-a", requestId: randomUUID() },
    "portfolio-a",
  );
  assert.equal(exported.ok, true);
  if (!exported.ok) return;
  const bundle = exported.bundle;
  const fingerprint = await fingerprintBundle(bundle);

  const insertBatch = (id: string, status: string, updatedAt: string): void => {
    database
      .prepare(
        `INSERT INTO import_batches (
           id, user_id, target_portfolio_id, parser_format, parser_version, filename,
           byte_size, file_sha256, status, created_at, updated_at, version
         ) VALUES (?, 'user-a', 'portfolio-a', ?, ?, 'b.json', 1, ?, ?,
           '2026-09-03T00:00:00Z', ?, 1)`,
      )
      .run(
        id,
        PORTFOLIO_BUNDLE_PARSER_FORMAT,
        String(PORTFOLIO_BUNDLE_SCHEMA_VERSION),
        fingerprint,
        status,
        updatedAt,
      );
  };
  // Two reversed generations: `rev-newer` carries the later `updated_at`.
  // Without the `ORDER BY`, the owner index visits `updated_at` ascending and
  // returns `rev-older` (measured in review), so this fixture distinguishes
  // the tiebreak from the pre-fix plan.
  insertBatch("rev-newer", "reversed", "2026-09-03T02:00:00Z");
  insertBatch("rev-older", "reversed", "2026-09-03T01:00:00Z");

  const result = await commitPortfolioBundleImport(
    { client, userId: "user-a", requestId: randomUUID() },
    bundle,
    "b.json",
    JSON.stringify(bundle).length,
  );
  assert.equal(
    result.ok,
    true,
    result.ok ? "" : (result as { message: string }).message,
  );
  if (!result.ok) return;

  const rows = database
    .prepare(
      "SELECT id, status FROM import_batches WHERE user_id = 'user-a' AND file_sha256 = ?",
    )
    .all(fingerprint) as { id: string; status: string }[];
  assert.equal(
    rows.length,
    2,
    "no third batch row should be minted -- the newest reversed row is reused in place",
  );
  const newer = rows.find((row) => row.id === "rev-newer");
  const older = rows.find((row) => row.id === "rev-older");
  assert.equal(
    newer?.status,
    "committed",
    "the most recently updated reversed row is reused-and-reset through committing to committed",
  );
  assert.equal(
    older?.status,
    "reversed",
    "the older reversed generation is left untouched",
  );
});

// ---------------------------------------------------------------------------
// Sharesight fixtures -- mirrors tests/bug-018.test.ts.
// ---------------------------------------------------------------------------

function fakeTrade(overrides: Partial<SharesightTrade> = {}): SharesightTrade {
  return {
    id: "trade-1",
    portfolioId: "sp-1",
    holdingId: "holding-1",
    instrumentCode: "ABC",
    marketCode: "ASX",
    sharesightInstrumentId: null,
    instrumentName: null,
    isin: null,
    transactionType: "buy",
    transactionDate: "2026-08-01",
    currencyCode: "AUD",
    quantityDecimal: "5",
    priceDecimal: "10",
    valueDecimal: "50",
    brokerageDecimal: null,
    brokerageCurrencyCode: null,
    exchangeRateDecimal: null,
    exchangeRatePair: null,
    state: null,
    uniqueIdentifier: null,
    paidOnDate: null,
    descriptionCode: null,
    sourceCategory: null,
    comments: null,
    ...overrides,
  };
}

function fakePortfolio(): SharesightPortfolio {
  return {
    id: "sp-1",
    name: "My SS Portfolio",
    currencyCode: "AUD",
    inceptionDate: null,
    tzName: null,
    accessLevel: null,
    financialYearEnd: null,
    cgDiscount: null,
    countryCode: null,
    ownerName: null,
    taxEntityType: null,
  };
}

function fakeSharesightClient(trades: SharesightTrade[]): SharesightClient {
  return {
    async listPortfolios() {
      return { ok: true, value: [fakePortfolio()] };
    },
    async getPortfolioHoldings() {
      return { ok: true, value: [] };
    },
    async listTrades() {
      return { ok: true, value: trades } as SharesightResult<SharesightTrade[]>;
    },
    async listPayouts() {
      return { ok: true, value: [] };
    },
    async listUserInstruments() {
      return { ok: true, value: [] };
    },
  };
}

async function previewVersion(
  client: SqlClient,
  batchId: string,
): Promise<string> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get("user-a", batchId);
  if (!batch) throw new Error("expected batch to exist");
  const [rows, issues, mappings, portfolios, candidateRows] = await Promise.all(
    [
      staging.listRows("user-a", batchId),
      staging.listIssues("user-a", batchId),
      createOwnedImportMappingDecisionRepository(client).list(
        "user-a",
        batchId,
      ),
      createOwnedPortfolioRepository(client).list("user-a"),
      client.all<Record<string, unknown>>(
        `SELECT id, portfolio_id, source_symbol, source_exchange_alias,
                source_currency_code, security_id
           FROM portfolio_securities WHERE user_id = ?
          ORDER BY source_symbol ASC, id ASC`,
        ["user-a"],
      ),
    ],
  );
  const review = buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    })),
    securityCandidates: candidateRows.map((row) => ({
      id: String(row.id),
      portfolioId: String(row.portfolio_id),
      sourceSymbol: String(row.source_symbol),
      sourceExchangeAlias:
        row.source_exchange_alias === null
          ? null
          : String(row.source_exchange_alias),
      sourceCurrencyCode: String(row.source_currency_code),
      securityId: row.security_id === null ? null : String(row.security_id),
    })),
  });
  return review.previewVersion;
}

async function commitBatch(client: SqlClient, batchId: string): Promise<void> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get("user-a", batchId);
  if (!batch) throw new Error("expected batch to exist");
  const version = await previewVersion(client, batchId);
  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    batchId,
    { expectedVersion: batch.version, expectedPreviewVersion: version },
  );
  assert.equal(ready.ok, true, `expected ${batchId} to reach ready`);
  if (!ready.ok) return;
  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", batchId);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const input: ImportCommitInput = {
    expectedVersion: ready.review.batch.version,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: `${batchId}-commit`,
    confirmation: true,
    requestId: `${batchId}-commit-request`,
  };
  let result = await commitRepo.commit("user-a", batchId, input);
  for (
    let attempt = 0;
    attempt < 10 && (!result.ok || result.status !== "committed");
    attempt += 1
  ) {
    assert.equal(result.ok, true);
    result = await commitRepo.commit("user-a", batchId, input);
  }
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "committed");
}

test("BRK-020 regression (the disclosed stuck shape): Sharesight sync -> accept -> reverse -> re-sync with BYTE-IDENTICAL fetched content mints a fresh, committable batch rather than reusing the reversed one, and accepting it posts the trade again -- fails pre-fix", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const sharesight = fakeSharesightClient([fakeTrade()]);
  const integration = {
    integration: { enabled: true as const, client: sharesight },
  };

  const linked = await linkSharesightPortfolioWithContext(
    { client, userId: "user-a", requestId: "link-req" },
    "portfolio-a",
    { sharesightPortfolioId: "sp-1" },
    integration,
  );
  assert.equal(linked.ok, true);

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    integration,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.reused, false);
  assert.equal(first.newRows, 1);
  await commitBatch(client, first.batchId);
  const original = database
    .prepare(
      "SELECT id FROM transactions WHERE user_id = 'user-a' AND source_reference = 'import-fingerprint:sharesight-trade:trade-1' AND status = 'posted'",
    )
    .get() as { id: string };
  assert.ok(original);

  const batchRow = database
    .prepare("SELECT version FROM import_batches WHERE id = ?")
    .get(first.batchId) as { version: number };
  const reversed = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    first.batchId,
    {
      expectedVersion: batchRow.version,
      idempotencyKey: "reverse-sharesight",
      confirmation: true,
      requestId: "request-reversal",
    },
  );
  assert.equal(reversed.ok, true);
  if (reversed.ok) assert.equal(reversed.status, "reversed");
  assert.equal(batchStatus(database, first.batchId), "reversed");

  // Same client, same single trade, nothing else changed in the account:
  // the fetch digest is byte-identical to the first sync's.
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    integration,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.notEqual(
    second.batchId,
    first.batchId,
    "BRK-020: the re-sync must not resolve to the reversed batch",
  );
  assert.equal(second.reused, false);
  assert.notEqual(second.batchStatus, "reversed");
  assert.equal(second.newRows, 1);
  assert.equal(second.alreadyImportedRows, 0);

  const [firstBatch, secondBatch] = ["first", "second"].map(
    (_, index) =>
      database
        .prepare("SELECT file_sha256, status FROM import_batches WHERE id = ?")
        .get(index === 0 ? first.batchId : second.batchId) as {
        file_sha256: string;
        status: string;
      },
  );
  assert.ok(firstBatch && secondBatch);
  assert.equal(
    secondBatch.file_sha256,
    firstBatch.file_sha256,
    "proves the collision shape: both batches share the identical content digest",
  );
  assert.equal(firstBatch.status, "reversed");
  const stagedRows = database
    .prepare(
      "SELECT commit_status FROM import_rows WHERE batch_id = ? AND row_class = 'transaction'",
    )
    .all(second.batchId) as { commit_status: string }[];
  assert.equal(stagedRows.length, 1);
  assert.equal(stagedRows[0]?.commit_status, "staged");

  await commitBatch(client, second.batchId);
  const reposted = database
    .prepare(
      "SELECT id, reverses_transaction_id FROM transactions WHERE user_id = 'user-a' AND source_reference = 'import-fingerprint:sharesight-trade:trade-1' AND status = 'posted'",
    )
    .get() as { id: string; reverses_transaction_id: string | null };
  assert.ok(
    reposted,
    "accepting the identical-content re-sync must post the trade as a new transaction",
  );
  assert.notEqual(reposted.id, original.id);
  assert.equal(reposted.reverses_transaction_id, null);
  assert.equal(
    (
      database
        .prepare("SELECT status FROM transactions WHERE id = ?")
        .get(original.id) as { status: string }
    ).status,
    "reversed",
  );
});

// ---------------------------------------------------------------------------
// BRK-020 B1 (2026-09-04 owner ruling): `failed` keeps occupying the
// `import_batches_user_file_parser_unique` key exactly as it does today --
// the index predicate stays `WHERE status <> 'reversed'`, no migration --
// because every write of `import_batches.status = 'failed'` lives in
// `app/portfolio-bundle-service.ts`'s bundle-restore path (whose own reader,
// `findExistingBatch`, reuses-and-resets any non-committed row, `failed`
// included, so it can never get stuck occupying the key). CSV/Sharesight
// staging never drives a batch to `failed` today (see docs/DATA_MODEL.md's
// BRK-020 entry). This is a PIN, not a bug-reproducing regression test: it
// exists so that a future writer of `import_batches.status = 'failed'` for
// a NON-bundle `parser_format` fails loudly here and forces the `failed`/
// index-predicate decision to be revisited, rather than silently
// reproducing the stuck-key hazard BRK-020 fixed for `reversed`.
// ---------------------------------------------------------------------------

async function collectTsFiles(dir: URL, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      await collectTsFiles(new URL(`${entry.name}/`, dir), out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(fileURLToPath(new URL(entry.name, dir)));
    }
  }
}

test("BRK-020 B1 (pin): every assignment of import_batches.status = 'failed' lives in app/portfolio-bundle-service.ts, and every transitionStatus(...) call site (the CSV/Sharesight staging path) passes only a known non-failed nextStatus literal -- a new writer, a reordered SET clause, or a 'failed' nextStatus literal must fail this test and force the failed/index-predicate decision (docs/DATA_MODEL.md) to be revisited", async () => {
  const files: string[] = [];
  await collectTsFiles(new URL("../app/", import.meta.url), files);
  await collectTsFiles(new URL("../db/", import.meta.url), files);
  await collectTsFiles(new URL("../domain/", import.meta.url), files);
  await collectTsFiles(new URL("../worker/", import.meta.url), files);

  const contentsByFile = new Map<string, string>();
  for (const file of files) {
    contentsByFile.set(file, await readFile(file, "utf8"));
  }

  const lineOf = (contents: string, index: number): number =>
    contents.slice(0, index).split("\n").length;

  // (b) Order-insensitive: capture each `UPDATE import_batches SET ...`
  // statement's whole SET clause (up to its WHERE) and search it for a
  // `status = 'failed'` assignment ANYWHERE in the list, not only as the
  // first (and not tied to a particular `updated_at`/`status` ordering).
  const updateStatementPattern =
    /UPDATE\s+import_batches\s+SET\s+([\s\S]*?)\bWHERE\b/gi;
  const failedAssignmentPattern = /status\s*=\s*'failed'/i;
  const writerMatches: Array<{ file: string; line: number }> = [];
  for (const [file, contents] of contentsByFile) {
    for (const match of contents.matchAll(updateStatementPattern)) {
      if (failedAssignmentPattern.test(match[1] ?? "")) {
        writerMatches.push({
          file,
          line: lineOf(contents, match.index ?? 0),
        });
      }
    }
  }

  const otherWriters = writerMatches.filter(
    (m) => !m.file.endsWith("/app/portfolio-bundle-service.ts"),
  );
  assert.deepEqual(
    otherWriters,
    [],
    "a new writer of import_batches.status = 'failed' outside app/portfolio-bundle-service.ts means the `failed`/`WHERE status <> 'reversed'` decision in docs/DATA_MODEL.md must be revisited",
  );

  const bundleServiceWriters = writerMatches.filter((m) =>
    m.file.endsWith("/app/portfolio-bundle-service.ts"),
  );
  const bundleServiceLines = bundleServiceWriters
    .map((m) => m.line)
    .sort((a, b) => a - b);
  assert.equal(
    bundleServiceWriters.length,
    3,
    `expected exactly three known writers in app/portfolio-bundle-service.ts, found ${bundleServiceWriters.length} (at line(s) ${bundleServiceLines.join(", ") || "none"}); a changed count is also a signal to re-verify the decision's premises and, if genuine, update docs/DATA_MODEL.md's B1 paragraph to cite the new line numbers`,
  );

  // (c) Every `transitionStatus(...)` CALL SITE -- matched with a leading
  // `.` so this never matches the method's own definition
  // (`async transitionStatus(` in db/repositories/import-staging.ts, which
  // has no receiver before it) -- must pass a `nextStatus` literal drawn
  // from the known non-`failed` set. A new call site, or one passing
  // `"failed"`, must fail loudly here rather than silently reproducing the
  // stuck-key hazard BRK-020 fixed for `reversed`.
  const knownNonFailedNextStatuses = new Set(["ready", "needs_mapping"]);
  const callSitePattern = /\.transitionStatus\(/g;
  const nextStatusPattern = /nextStatus\s*:\s*["']([A-Za-z_]+)["']/;
  const callSites: Array<{
    file: string;
    line: number;
    nextStatus: string | null;
  }> = [];
  for (const [file, contents] of contentsByFile) {
    for (const match of contents.matchAll(callSitePattern)) {
      const startIndex = match.index ?? 0;
      const window = contents.slice(startIndex, startIndex + 500);
      const nextStatusMatch = nextStatusPattern.exec(window);
      callSites.push({
        file,
        line: lineOf(contents, startIndex),
        nextStatus: nextStatusMatch ? nextStatusMatch[1] : null,
      });
    }
  }

  assert.ok(
    callSites.length >= 2,
    `expected at least the two known transitionStatus call sites, found ${callSites.length}`,
  );
  for (const site of callSites) {
    assert.ok(
      site.nextStatus !== null,
      `${site.file}:${site.line} calls transitionStatus but no nextStatus literal could be found within 500 characters -- widen the search window or inspect this call site manually`,
    );
    assert.ok(
      knownNonFailedNextStatuses.has(site.nextStatus!),
      site.nextStatus === "failed"
        ? `${site.file}:${site.line} calls transitionStatus with nextStatus: "failed" -- the failed/index-predicate decision in docs/DATA_MODEL.md must be revisited`
        : `${site.file}:${site.line} calls transitionStatus with an unrecognized nextStatus literal ${JSON.stringify(site.nextStatus)} -- add it to the known set here only after confirming it cannot reach 'failed' for a non-bundle parser_format, per docs/DATA_MODEL.md's B1 decision`,
    );
  }
});
