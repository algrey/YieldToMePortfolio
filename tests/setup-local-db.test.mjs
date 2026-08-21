import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  BACKFILL_LANDMARKS,
  GUARD_TABLES,
  LOCAL_DEV_MIGRATIONS_TABLE,
  applyMigrations,
  backupPaths,
  columnExists,
  computePendingMigrations,
  countRows,
  countUserData,
  decideGuard,
  detectBackfillCutoff,
  ensureBookkeepingTable,
  formatBackupTimestamp,
  getAppliedMigrationNames,
  hasAnyAppTable,
  migrationsThroughFile,
  planApplyPending,
  recordMigrationApplied,
  seedCurrencyRows,
  tableExists,
} from "../scripts/setup-local-db-lib.mjs";

const drizzleDirUrl = new URL("../drizzle/", import.meta.url);

async function listRealMigrationFiles() {
  return (await readdir(drizzleDirUrl))
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

async function createMigratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const migrationFiles = await listRealMigrationFiles();
  for (const file of migrationFiles) {
    database.exec(await readFile(new URL(file, drizzleDirUrl), "utf8"));
  }
  return { database, migrationFiles };
}

function seedMinimalOwnerData(database) {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits)
    VALUES ('AUD', 36, 'Australian dollar', 2);
    INSERT INTO users (
      id, status, primary_email, timezone, created_at, updated_at, version
    ) VALUES (
      'user-a', 'active', 'a@example.com', 'Australia/Sydney',
      '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z', 1
    );
    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone,
      created_at, updated_at, version
    ) VALUES (
      'portfolio-a', 'user-a', 'main', 'Portfolio A', 'AUD', 'Australia/Sydney',
      '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z', 1
    );
  `);
}

// -- Guard --------------------------------------------------------------

test("guard: bare run on empty database proceeds with no friction", () => {
  const database = new DatabaseSync(":memory:");
  const counts = countUserData(database);
  const guard = decideGuard(counts, { force: false });
  assert.equal(guard.blocked, false);
  assert.equal(guard.total, 0);
  database.close();
});

test("guard: bare run on database with user data is blocked and reports counts", async () => {
  const { database } = await createMigratedDatabase();
  seedMinimalOwnerData(database);

  const counts = countUserData(database);
  assert.equal(counts.portfolios, 1);
  assert.equal(counts.transactions, 0);

  const guard = decideGuard(counts, { force: false });
  assert.equal(guard.blocked, true);
  assert.equal(guard.total, 1);
  assert.deepEqual(guard.lines, ["  portfolios: 1"]);
  database.close();
});

test("guard: --force bypasses the block even with user data present", async () => {
  const { database } = await createMigratedDatabase();
  seedMinimalOwnerData(database);

  const counts = countUserData(database);
  const guard = decideGuard(counts, { force: true });
  assert.equal(guard.blocked, false);
  assert.equal(guard.total, 1);
  database.close();
});

test("countUserData tolerates missing tables (ancient/unmigrated database)", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE portfolios (id TEXT)");
  const counts = countUserData(database);
  assert.deepEqual(counts, {
    portfolios: 0,
    transactions: 0,
    import_batches: 0,
    dividend_manual_records: 0,
  });
  database.close();
});

test("GUARD_TABLES does not include users -- a bare JIT-provisioned user is not guarded data", () => {
  assert.ok(!GUARD_TABLES.includes("users"));
});

// -- Backfill landmarks ---------------------------------------------------

test("hasAnyAppTable is false for a brand-new database", () => {
  const database = new DatabaseSync(":memory:");
  assert.equal(hasAnyAppTable(database), false);
  database.close();
});

test("hasAnyAppTable ignores D1's _cf_METADATA and the bookkeeping table itself", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE _cf_METADATA (key TEXT)");
  ensureBookkeepingTable(database);
  assert.equal(hasAnyAppTable(database), false);
  database.close();
});

test("detectBackfillCutoff: empty database has nothing to backfill", () => {
  const database = new DatabaseSync(":memory:");
  const result = detectBackfillCutoff(database, ["0000_x.sql", "0001_y.sql"]);
  assert.equal(result.status, "empty");
  database.close();
});

test("detectBackfillCutoff: unrecognized non-empty state refuses", () => {
  const database = new DatabaseSync(":memory:");
  // Some application-shaped table exists, but nothing that matches a
  // known landmark (simulates a database far older than the oldest
  // landmark, or a partial/corrupt intermediate state).
  database.exec("CREATE TABLE some_unrelated_table (id TEXT)");
  const result = detectBackfillCutoff(database, ["0000_x.sql", "0001_y.sql"]);
  assert.equal(result.status, "unknown");
  database.close();
});

test("detectBackfillCutoff: matches the 0034 landmark (sharesight_sync_state table)", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE sharesight_sync_state (id TEXT)");
  const migrationFiles = [
    "0033_a.sql",
    "0034_fast_moon_knight.sql",
    "0035_b.sql",
  ];
  const result = detectBackfillCutoff(database, migrationFiles);
  assert.equal(result.status, "matched");
  assert.equal(result.throughFile, "0034_fast_moon_knight.sql");
});

test("detectBackfillCutoff: matches the 0035 landmark (dividend_manual_records.total_cash_decimal)", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(
    "CREATE TABLE dividend_manual_records (id TEXT, total_cash_decimal TEXT)",
  );
  const migrationFiles = [
    "0034_fast_moon_knight.sql",
    "0035_goofy_havok.sql",
    "0036_c.sql",
  ];
  const result = detectBackfillCutoff(database, migrationFiles);
  assert.equal(result.status, "matched");
  assert.equal(result.throughFile, "0035_goofy_havok.sql");
});

test("detectBackfillCutoff: newest matching landmark wins over an older one that also matches", () => {
  const database = new DatabaseSync(":memory:");
  // Both the 0034 and 0046 landmark structures are present -- a fully
  // migrated database. The newest (0046) landmark must win so nothing
  // downstream of it gets re-applied.
  database.exec("CREATE TABLE sharesight_sync_state (id TEXT)");
  database.exec("CREATE TABLE price_upload_batches (id TEXT)");
  const migrationFiles = [
    "0034_fast_moon_knight.sql",
    "0046_mkt_008_price_uploads.sql",
  ];
  const result = detectBackfillCutoff(database, migrationFiles);
  assert.equal(result.status, "matched");
  assert.equal(result.throughFile, "0046_mkt_008_price_uploads.sql");
});

test("detectBackfillCutoff against the real migration chain: every documented landmark matches its migration", async () => {
  const { database, migrationFiles } = await createMigratedDatabase();
  const result = detectBackfillCutoff(database, migrationFiles);
  assert.equal(result.status, "matched");
  // The real chain is fully migrated, so the newest landmark (0046) wins.
  assert.equal(result.landmark.prefix, "0046");
  database.close();
});

test("every BACKFILL_LANDMARKS entry resolves against the real drizzle/ directory", async () => {
  const migrationFiles = await listRealMigrationFiles();
  for (const landmark of BACKFILL_LANDMARKS) {
    const match = migrationFiles.find((name) =>
      name.startsWith(`${landmark.prefix}_`),
    );
    assert.ok(
      match,
      `landmark prefix ${landmark.prefix} has no matching file in drizzle/`,
    );
  }
});

test("migrationsThroughFile returns every file up to and including the cutoff", () => {
  const files = ["0000_a.sql", "0001_b.sql", "0002_c.sql", "0003_d.sql"];
  assert.deepEqual(migrationsThroughFile(files, "0002_c.sql"), [
    "0000_a.sql",
    "0001_b.sql",
    "0002_c.sql",
  ]);
});

test("migrationsThroughFile returns empty for an unknown file", () => {
  assert.deepEqual(migrationsThroughFile(["0000_a.sql"], "not_there.sql"), []);
});

// -- Pending-set computation from the bookkeeping table --------------------

test("computePendingMigrations returns files not present in the applied set, in order", () => {
  const files = ["0000_a.sql", "0001_b.sql", "0002_c.sql"];
  const applied = new Set(["0000_a.sql"]);
  assert.deepEqual(computePendingMigrations(files, applied), [
    "0001_b.sql",
    "0002_c.sql",
  ]);
});

test("getAppliedMigrationNames returns empty set when the bookkeeping table doesn't exist yet", () => {
  const database = new DatabaseSync(":memory:");
  assert.deepEqual(getAppliedMigrationNames(database), new Set());
  database.close();
});

test("ensureBookkeepingTable + recordMigrationApplied round-trip through getAppliedMigrationNames", () => {
  const database = new DatabaseSync(":memory:");
  ensureBookkeepingTable(database);
  ensureBookkeepingTable(database); // idempotent
  recordMigrationApplied(database, "0000_a.sql", "2026-08-21T00:00:00Z");
  recordMigrationApplied(database, "0001_b.sql", "2026-08-21T00:00:01Z");
  const applied = getAppliedMigrationNames(database);
  assert.deepEqual(applied, new Set(["0000_a.sql", "0001_b.sql"]));
  database.close();
});

// -- planApplyPending (write-free decision pass) ----------------------------

test("planApplyPending: unknown-state refusal performs zero writes -- runs on a read-only connection, file hash unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "setup-local-db-test-"));
  try {
    const dbPath = join(dir, "test.sqlite");
    const setup = new DatabaseSync(dbPath);
    // App-shaped table that matches no landmark -> unknown state.
    setup.exec("CREATE TABLE some_unrelated_table (id TEXT)");
    setup.close();
    const hashBefore = createHash("sha256")
      .update(await readFile(dbPath))
      .digest("hex");

    // The CLI runs the decision pass on a read-only connection; any write
    // attempt (bookkeeping table, WAL flip) would throw here.
    const readOnlyDb = new DatabaseSync(dbPath, { readOnly: true });
    const plan = planApplyPending(readOnlyDb, ["0000_x.sql", "0001_y.sql"]);
    readOnlyDb.close();
    assert.equal(plan.status, "refuse");

    const hashAfter = createHash("sha256")
      .update(await readFile(dbPath))
      .digest("hex");
    assert.equal(hashBefore, hashAfter);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("planApplyPending: existing bookkeeping rows proceed without backfill", () => {
  const database = new DatabaseSync(":memory:");
  ensureBookkeepingTable(database);
  recordMigrationApplied(database, "0000_a.sql", "2026-08-21T00:00:00Z");
  const plan = planApplyPending(database, ["0000_a.sql", "0001_b.sql"]);
  assert.equal(plan.status, "proceed");
  assert.equal(plan.backfill, null);
  assert.deepEqual(plan.appliedNames, new Set(["0000_a.sql"]));
  database.close();
});

test("planApplyPending: landmark match proceeds with backfill names for the caller to record", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE sharesight_sync_state (id TEXT)");
  const files = ["0033_a.sql", "0034_fast_moon_knight.sql", "0035_b.sql"];
  const plan = planApplyPending(database, files);
  assert.equal(plan.status, "proceed");
  assert.deepEqual(plan.backfill.names, [
    "0033_a.sql",
    "0034_fast_moon_knight.sql",
  ]);
  assert.deepEqual(
    plan.appliedNames,
    new Set(["0033_a.sql", "0034_fast_moon_knight.sql"]),
  );
  database.close();
});

test("planApplyPending: empty database proceeds with everything pending", () => {
  const database = new DatabaseSync(":memory:");
  const plan = planApplyPending(database, ["0000_a.sql"]);
  assert.equal(plan.status, "proceed");
  assert.equal(plan.backfill, null);
  assert.deepEqual(plan.appliedNames, new Set());
  database.close();
});

// -- applyMigrations (per-file bookkeeping, typed failure) -------------------

const FAILING_CHAIN = [
  { name: "0000_ok.sql", sql: "CREATE TABLE t0 (id TEXT);" },
  { name: "0001_bad.sql", sql: "CREATE TABLE t1 (id TEXT); THIS IS NOT SQL;" },
  { name: "0002_never.sql", sql: "CREATE TABLE t2 (id TEXT);" },
];

test("applyMigrations: success applies and records every entry in order", () => {
  const database = new DatabaseSync(":memory:");
  ensureBookkeepingTable(database);
  const result = applyMigrations(
    database,
    [
      { name: "0000_ok.sql", sql: "CREATE TABLE t0 (id TEXT);" },
      { name: "0001_ok.sql", sql: "CREATE TABLE t1 (id TEXT);" },
    ],
    "2026-08-21T00:00:00Z",
  );
  assert.equal(result.failure, null);
  assert.deepEqual(result.applied, ["0000_ok.sql", "0001_ok.sql"]);
  assert.deepEqual(
    getAppliedMigrationNames(database),
    new Set(["0000_ok.sql", "0001_ok.sql"]),
  );
  database.close();
});

test("applyMigrations: mid-chain failure records the succeeded prefix, returns a typed failure, and stops", () => {
  const database = new DatabaseSync(":memory:");
  ensureBookkeepingTable(database);
  const result = applyMigrations(
    database,
    FAILING_CHAIN,
    "2026-08-21T00:00:00Z",
  );
  assert.deepEqual(result.applied, ["0000_ok.sql"]);
  assert.equal(result.failure.name, "0001_bad.sql");
  assert.ok(result.failure.message.length > 0);
  // Succeeded prefix is recorded; the failed and unreached files are not.
  assert.deepEqual(
    getAppliedMigrationNames(database),
    new Set(["0000_ok.sql"]),
  );
  // The chain stopped: the file after the failure was never attempted.
  assert.equal(tableExists(database, "t2"), false);
  database.close();
});

test("applyMigrations: after a mid-chain failure, computePendingMigrations resumes from the failed file", () => {
  const database = new DatabaseSync(":memory:");
  ensureBookkeepingTable(database);
  applyMigrations(database, FAILING_CHAIN, "2026-08-21T00:00:00Z");
  const pending = computePendingMigrations(
    FAILING_CHAIN.map((entry) => entry.name),
    getAppliedMigrationNames(database),
  );
  assert.deepEqual(pending, ["0001_bad.sql", "0002_never.sql"]);
  database.close();
});

test("the CLI prints the prescribed partial-state guidance on --apply-pending failure", async () => {
  const cli = await readFile(
    new URL("../scripts/setup-local-db.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(
    cli.includes(
      "failed partway; the database is in a partial state — re-run with --force (backs up first)",
    ),
    "the CLI must print the prescribed guidance instead of a raw stack",
  );
});

// -- seedCurrencyRows (idempotent INSERT OR IGNORE) ---------------------------

test("seedCurrencyRows: adds only missing currencies to a pre-seeded database and never overwrites existing rows", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE currencies (
    code TEXT PRIMARY KEY,
    numeric_code INTEGER,
    name TEXT,
    minor_unit_digits INTEGER,
    is_active INTEGER
  )`);
  database.exec(
    "INSERT INTO currencies VALUES ('AUD', 36, 'Australian dollar (existing)', 2, 1)",
  );

  const rows = [
    ["AUD", 36, "Australian dollar", 2],
    ["USD", 840, "US dollar", 2],
  ];
  // Later addition (USD) reaches the pre-existing database; AUD is skipped.
  assert.equal(seedCurrencyRows(database, rows), 1);
  assert.equal(countRows(database, "currencies"), 2);
  const aud = database
    .prepare("SELECT name FROM currencies WHERE code = 'AUD'")
    .get();
  assert.equal(aud.name, "Australian dollar (existing)");
  // Re-run is a complete no-op.
  assert.equal(seedCurrencyRows(database, rows), 0);
  database.close();
});

// -- Backup naming ----------------------------------------------------------

test("formatBackupTimestamp produces a filesystem-safe string", () => {
  const timestamp = formatBackupTimestamp(new Date("2026-08-21T12:34:56.789Z"));
  assert.equal(timestamp, "2026-08-21T12-34-56-789Z");
  assert.ok(!timestamp.includes(":"));
});

test("backupPaths names the sqlite file plus -wal/-shm siblings consistently", () => {
  const paths = backupPaths("/tmp/db/foo.sqlite", "2026-08-21T00-00-00-000Z");
  assert.equal(paths[""], "/tmp/db/foo.sqlite.2026-08-21T00-00-00-000Z.backup");
  assert.equal(
    paths["-wal"],
    "/tmp/db/foo.sqlite-wal.2026-08-21T00-00-00-000Z.backup",
  );
  assert.equal(
    paths["-shm"],
    "/tmp/db/foo.sqlite-shm.2026-08-21T00-00-00-000Z.backup",
  );
});

// -- tableExists / columnExists ---------------------------------------------

test("tableExists / columnExists reflect real schema shape", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE t (id TEXT, name TEXT)");
  assert.equal(tableExists(database, "t"), true);
  assert.equal(tableExists(database, "missing"), false);
  assert.equal(columnExists(database, "t", "name"), true);
  assert.equal(columnExists(database, "t", "missing_column"), false);
  assert.equal(columnExists(database, "missing_table", "name"), false);
  database.close();
});

test("countRows tolerates a missing table", () => {
  const database = new DatabaseSync(":memory:");
  assert.equal(countRows(database, "does_not_exist"), 0);
  database.close();
});

// -- Bookkeeping table isolation from real schema ---------------------------

test("the local-dev bookkeeping table name never appears in db/schema.ts or any real migration", async () => {
  const schema = await readFile(
    new URL("../db/schema.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !schema.includes(LOCAL_DEV_MIGRATIONS_TABLE),
    "db/schema.ts must never define the local-dev-only bookkeeping table",
  );

  const migrationFiles = await listRealMigrationFiles();
  for (const file of migrationFiles) {
    const sql = await readFile(new URL(file, drizzleDirUrl), "utf8");
    assert.ok(
      !sql.includes(LOCAL_DEV_MIGRATIONS_TABLE),
      `${file} must never reference the local-dev-only bookkeeping table`,
    );
  }
});
