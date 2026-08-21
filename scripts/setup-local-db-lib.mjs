// Pure decision logic for scripts/setup-local-db.mjs, split out so it is
// importable and unit-testable against temp sqlite files without touching
// real Miniflare D1 state. Every function here takes an already-open
// `node:sqlite` DatabaseSync as input; none of them open/close/locate files
// themselves -- that I/O stays in the thin CLI script.

// The four tables that hold real owner data this script must never destroy
// without explicit consent. Deliberately excludes `users`: a bare
// JIT-provisioned user row with no portfolios/transactions/imports/dividend
// records is not data worth guarding -- it is recreated automatically on
// next sign-in.
export const GUARD_TABLES = [
  "portfolios",
  "transactions",
  "import_batches",
  "dividend_manual_records",
];

// Local-dev-only bookkeeping table this script itself creates and maintains
// to track which drizzle/*.sql files have been applied to a given Miniflare
// D1 file, so `--apply-pending` can migrate in place instead of wiping.
// Prefixed `_local_dev` and MUST stay out of db/schema.ts and every real
// migration: it is not part of the reviewed application schema, has no
// production meaning, and a real migration creating/depending on it would
// smuggle dev-only state into the schema drizzle-kit diffs against.
export const LOCAL_DEV_MIGRATIONS_TABLE = "_local_dev_migrations";

export function tableExists(database, name) {
  const row = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

// `table` must always be a literal from this module's own constant lists
// (GUARD_TABLES, landmark checks, LOCAL_DEV_MIGRATIONS_TABLE) -- never
// caller-supplied -- since PRAGMA/identifier positions cannot be bound
// parameters in sqlite.
export function columnExists(database, table, column) {
  if (!tableExists(database, table)) return false;
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all();
  return rows.some((row) => row.name === column);
}

export function countRows(database, table) {
  if (!tableExists(database, table)) return 0;
  return database.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
}

// True once at least one application table exists (anything beyond sqlite's
// own internal tables, D1's `_cf_METADATA` bookkeeping table, and our own
// migration bookkeeping table). A database with none of those is a genuine
// fresh start -- no guard friction, no backfill needed.
export function hasAnyAppTable(database) {
  const rows = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_METADATA' AND name != ?",
    )
    .all(LOCAL_DEV_MIGRATIONS_TABLE);
  return rows.length > 0;
}

export function countUserData(database) {
  const counts = {};
  for (const table of GUARD_TABLES) {
    counts[table] = countRows(database, table);
  }
  return counts;
}

// The loaded-gun guard: decides whether a bare (non---force) run may
// proceed to delete the database file. `force: true` always proceeds
// (the caller is responsible for backing up first when total > 0).
export function decideGuard(counts, { force }) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  if (force || total === 0) {
    return { blocked: false, total, lines: [] };
  }
  const lines = GUARD_TABLES.filter((table) => counts[table] > 0).map(
    (table) => `  ${table}: ${counts[table]}`,
  );
  return { blocked: true, total, lines };
}

// Structural landmarks used ONLY to backfill LOCAL_DEV_MIGRATIONS_TABLE for
// a database that predates it (created by an older setup-local-db.mjs, so
// it has real schema but no bookkeeping rows). Ordered newest-first; the
// first structural match wins, and everything at or before that migration
// is assumed applied -- safe because this script always applies migrations
// strictly in order, so a later structural landmark cannot exist without
// every earlier migration already having run.
//
// This list is intentionally small: it only needs enough recent landmarks
// to backfill databases that are plausibly still lying around locally, not
// a landmark per historical migration. It grows only when someone's local
// database survives across a gap of several migration generations without
// ever running --apply-pending in between (each successful run records
// every file it applies, so from then on backfill is never needed again for
// that database). `prefix` is the migration's leading number; the actual
// filename (suffix words) is resolved against the real drizzle/ directory
// listing at runtime, so renaming a migration's word-suffix doesn't break
// this list.
export const BACKFILL_LANDMARKS = [
  {
    prefix: "0046",
    describe: "price_upload_batches table (MKT-008)",
    matches: (db) => tableExists(db, "price_upload_batches"),
  },
  {
    prefix: "0045",
    describe: "sharesight_delayed_prices table (BRK-012C)",
    matches: (db) => tableExists(db, "sharesight_delayed_prices"),
  },
  {
    prefix: "0043",
    describe: "sharesight_sync_state.last_price_refresh_status column",
    matches: (db) =>
      columnExists(db, "sharesight_sync_state", "last_price_refresh_status"),
  },
  {
    prefix: "0042",
    describe: "dividend_manual_records.currency_code column (BRK-010)",
    matches: (db) =>
      columnExists(db, "dividend_manual_records", "currency_code"),
  },
  {
    prefix: "0041",
    describe: "calculation_runs.stall_count column",
    matches: (db) => columnExists(db, "calculation_runs", "stall_count"),
  },
  {
    prefix: "0040",
    describe: "calculation_runs.pipeline column (CALC-004)",
    matches: (db) => columnExists(db, "calculation_runs", "pipeline"),
  },
  {
    prefix: "0035",
    describe: "dividend_manual_records.total_cash_decimal column (BRK-005)",
    matches: (db) =>
      columnExists(db, "dividend_manual_records", "total_cash_decimal"),
  },
  {
    prefix: "0034",
    describe: "sharesight_sync_state table",
    matches: (db) => tableExists(db, "sharesight_sync_state"),
  },
];

function resolveLandmarkFile(migrationFiles, prefix) {
  return migrationFiles.find((name) => name.startsWith(`${prefix}_`));
}

// Decides, for a database with NO bookkeeping rows yet, what to backfill:
//   - "empty"   -- no application tables at all; nothing to backfill, every
//                  migration is genuinely pending.
//   - "matched" -- a landmark's structure is present; `throughFile` is the
//                  newest migration file safe to mark applied.
//   - "unknown" -- the database has application tables but matches no known
//                  landmark (older than the oldest landmark, or a partial/
//                  corrupt intermediate state). Refuse rather than guess.
export function detectBackfillCutoff(database, migrationFiles) {
  if (!hasAnyAppTable(database)) {
    return { status: "empty" };
  }
  for (const landmark of BACKFILL_LANDMARKS) {
    if (!landmark.matches(database)) continue;
    const throughFile = resolveLandmarkFile(migrationFiles, landmark.prefix);
    if (!throughFile) continue; // landmark's migration isn't in this checkout; keep looking
    return { status: "matched", throughFile, landmark };
  }
  return { status: "unknown" };
}

export function migrationsThroughFile(migrationFiles, throughFile) {
  const index = migrationFiles.indexOf(throughFile);
  if (index === -1) return [];
  return migrationFiles.slice(0, index + 1);
}

export function computePendingMigrations(migrationFiles, appliedNames) {
  return migrationFiles.filter((name) => !appliedNames.has(name));
}

// Full decision pass for --apply-pending, safe to run on a READ-ONLY
// connection: a refused run must perform zero writes (no WAL header flip,
// no bookkeeping-table creation). Returns:
//   - { status: "refuse" }  -- non-empty database, no bookkeeping rows, no
//                              landmark match; the caller must not write.
//   - { status: "proceed", appliedNames, backfill } -- `appliedNames` is the
//     set to diff pending migrations against; `backfill` is null or
//     { names, cutoff } that the caller must record once it reopens the
//     database for writing.
export function planApplyPending(database, migrationFiles) {
  const appliedNames = getAppliedMigrationNames(database);
  if (appliedNames.size > 0) {
    return { status: "proceed", appliedNames, backfill: null };
  }
  const cutoff = detectBackfillCutoff(database, migrationFiles);
  if (cutoff.status === "unknown") {
    return { status: "refuse" };
  }
  if (cutoff.status === "matched") {
    const names = migrationsThroughFile(migrationFiles, cutoff.throughFile);
    return {
      status: "proceed",
      appliedNames: new Set(names),
      backfill: { names, cutoff },
    };
  }
  // "empty": nothing to backfill; every migration is genuinely pending.
  return { status: "proceed", appliedNames, backfill: null };
}

// Applies migration entries ({ name, sql }) strictly in order, recording
// each in the bookkeeping table immediately after it succeeds. A mid-chain
// failure therefore leaves the succeeded prefix recorded, so a later
// --apply-pending resumes from the exact failure point instead of
// landmark-guessing against a partially applied chain. SQL errors are
// returned as a typed failure (never thrown) so the CLI can print
// prescribed guidance instead of a raw stack. The bookkeeping table must
// already exist.
export function applyMigrations(
  database,
  entries,
  appliedAt = new Date().toISOString(),
) {
  const applied = [];
  for (const { name, sql } of entries) {
    try {
      database.exec(sql);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { applied, failure: { name, message } };
    }
    recordMigrationApplied(database, name, appliedAt);
    applied.push(name);
  }
  return { applied, failure: null };
}

// Idempotent currency reference seeding (INSERT OR IGNORE): re-running
// against an already-seeded database succeeds without touching existing
// rows, and currencies added to the seed list later still reach
// pre-existing databases. Returns how many rows were actually inserted.
export function seedCurrencyRows(database, rows) {
  const insert = database.prepare(
    "INSERT OR IGNORE INTO currencies (code, numeric_code, name, minor_unit_digits, is_active) VALUES (?, ?, ?, ?, 1)",
  );
  let inserted = 0;
  for (const [code, numericCode, name, minorUnitDigits] of rows) {
    inserted += Number(
      insert.run(code, numericCode, name, minorUnitDigits).changes,
    );
  }
  return inserted;
}

export function ensureBookkeepingTable(database) {
  database.exec(
    `CREATE TABLE IF NOT EXISTS "${LOCAL_DEV_MIGRATIONS_TABLE}" (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );
}

export function getAppliedMigrationNames(database) {
  if (!tableExists(database, LOCAL_DEV_MIGRATIONS_TABLE)) return new Set();
  const rows = database
    .prepare(`SELECT name FROM "${LOCAL_DEV_MIGRATIONS_TABLE}"`)
    .all();
  return new Set(rows.map((row) => row.name));
}

export function recordMigrationApplied(
  database,
  name,
  appliedAt = new Date().toISOString(),
) {
  database
    .prepare(
      `INSERT INTO "${LOCAL_DEV_MIGRATIONS_TABLE}" (name, applied_at) VALUES (?, ?)`,
    )
    .run(name, appliedAt);
}

// Filesystem-safe timestamp for backup filenames (colons/periods in
// toISOString() are invalid/awkward in filenames on some filesystems).
export function formatBackupTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

// Backup destination for the sqlite file and its -wal/-shm siblings, keyed
// by the same suffix strings the CLI script already loops over.
export function backupPaths(dbPath, timestamp) {
  return {
    "": `${dbPath}.${timestamp}.backup`,
    "-wal": `${dbPath}-wal.${timestamp}.backup`,
    "-shm": `${dbPath}-shm.${timestamp}.backup`,
  };
}
