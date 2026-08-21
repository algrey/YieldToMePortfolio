// Local development helper: reset and migrate the Miniflare-backed D1 database
// that `vinext dev` uses, then seed reference currencies so JIT user
// provisioning (default home currency AUD) can succeed.
//
// This is a developer convenience for local testing only. It applies the
// reviewed Drizzle migrations in `drizzle/` directly with `node:sqlite`, which
// honours the in-file `PRAGMA foreign_keys=OFF` used by table-rebuild
// migrations (unlike `wrangler d1 execute`, which wraps files in a transaction
// where that pragma is a no-op).
//
// Safety model (see scripts/setup-local-db-lib.mjs for the decision logic):
//   - Bare invocation: refuses to touch a database that holds real owner
//     data (portfolios/transactions/import_batches/dividend_manual_records)
//     unless --force is passed. An empty/absent database proceeds with no
//     friction.
//   - --force: wipes and does a full migrate+seed, exactly like the old
//     unconditional behaviour, but backs up the existing file first when it
//     held any user data.
//   - --apply-pending: migrates a NON-empty database in place, without
//     wiping, using a local-only bookkeeping table to track which
//     drizzle/*.sql files have already run.
//
// The CLI shell below is intentionally thin: table/landmark/pending-set
// decisions live in scripts/setup-local-db-lib.mjs so they can be unit
// tested against temp sqlite files (tests/setup-local-db.test.mjs) without
// touching real Miniflare D1 state.

import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyMigrations,
  backupPaths,
  computePendingMigrations,
  countUserData,
  decideGuard,
  ensureBookkeepingTable,
  formatBackupTimestamp,
  planApplyPending,
  recordMigrationApplied,
  seedCurrencyRows,
} from "./setup-local-db-lib.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const applyPending = args.includes("--apply-pending");

if (force && applyPending) {
  console.error(
    "--force and --apply-pending are mutually exclusive: pick a genuine reset (--force) or an in-place migration (--apply-pending), not both.",
  );
  process.exit(1);
}

const repoRoot = new URL("..", import.meta.url).pathname;
const d1Dir = join(
  repoRoot,
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
);
const drizzleDir = join(repoRoot, "drizzle");

if (!existsSync(d1Dir)) {
  console.error(
    `D1 state directory not found: ${d1Dir}\nStart the dev server once (npm run dev) to create it, then rerun.`,
  );
  process.exit(1);
}

// The data file is the non-metadata *.sqlite in the D1 object directory.
const dbFile = readdirSync(d1Dir).find(
  (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
);
if (!dbFile) {
  console.error(
    `No D1 database file found in ${d1Dir}. Start the dev server once, then rerun.`,
  );
  process.exit(1);
}

const dbPath = join(d1Dir, dbFile);

function listMigrationFiles() {
  return readdirSync(drizzleDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

// ISO 4217 reference rows used by JIT provisioning, portfolio creation, and the
// example CSV import. Minor-unit digits: JPY=0, others=2.
const CURRENCIES = [
  ["AUD", 36, "Australian dollar", 2],
  ["USD", 840, "US dollar", 2],
  ["GBP", 826, "Pound sterling", 2],
  ["EUR", 978, "Euro", 2],
  ["NZD", 554, "New Zealand dollar", 2],
  ["CAD", 124, "Canadian dollar", 2],
  ["HKD", 344, "Hong Kong dollar", 2],
  ["SGD", 702, "Singapore dollar", 2],
  ["CHF", 756, "Swiss franc", 2],
  ["JPY", 392, "Yen", 0],
];

function seedCurrencies(database) {
  const inserted = seedCurrencyRows(database, CURRENCIES);
  const skipped = CURRENCIES.length - inserted;
  console.log(
    skipped === 0
      ? `Seeded ${inserted} currencies.`
      : `Seeded ${inserted} new currencies (${skipped} already present).`,
  );
}

function readMigrationEntries(files) {
  return files.map((file) => ({
    name: file,
    sql: readFileSync(join(drizzleDir, file), "utf8"),
  }));
}

function finish(database, note) {
  const tableCount = database
    .prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .get();
  console.log(`Tables present: ${tableCount.n}`);
  database.close();
  console.log(note ? `Local D1 ready. ${note}` : "Local D1 ready.");
}

function readCountsReadOnly() {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return countUserData(database);
  } finally {
    database.close();
  }
}

function runFullReset(guard) {
  let backupNote = null;
  if (force && guard.total > 0) {
    const timestamp = formatBackupTimestamp();
    const paths = backupPaths(dbPath, timestamp);
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = `${dbPath}${suffix}`;
      if (existsSync(src)) copyFileSync(src, paths[suffix]);
    }
    console.log(`Backed up existing database (had user data) to: ${paths[""]}`);
    backupNote = `Backup of previous data: ${paths[""]}`;
  }

  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) rmSync(path);
  }
  console.log(`Reset D1 database file: ${dbFile}`);

  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");

  // Bookkeeping is created first and each migration is recorded inside the
  // apply loop as it succeeds, so even a mid-chain failure leaves the
  // succeeded prefix recorded and --apply-pending can resume precisely --
  // never landmark-guessing against a partially applied chain.
  ensureBookkeepingTable(database);
  const migrationFiles = listMigrationFiles();
  const result = applyMigrations(
    database,
    readMigrationEntries(migrationFiles),
  );
  if (result.failure) {
    console.error(
      `Migration ${result.failure.name} failed partway through the full migrate: ${result.failure.message}`,
    );
    console.error(
      `The freshly reset database is in a partial state (${result.applied.length} migration(s) recorded as applied). Re-run with --apply-pending to resume, or re-run this script to wipe and retry.`,
    );
    database.close();
    process.exit(1);
  }
  console.log(`Applied ${migrationFiles.length} migrations.`);

  seedCurrencies(database);

  finish(database, backupNote);
}

function runApplyPending() {
  const migrationFiles = listMigrationFiles();

  // Decision pass on a READ-ONLY connection: a refused run must perform
  // zero writes -- no WAL header flip, no bookkeeping-table creation.
  const readOnlyDatabase = new DatabaseSync(dbPath, { readOnly: true });
  let plan;
  try {
    plan = planApplyPending(readOnlyDatabase, migrationFiles);
  } finally {
    readOnlyDatabase.close();
  }

  if (plan.status === "refuse") {
    console.error(
      "Cannot determine which migrations are already applied: the database has application tables but matches none of this script's known structural landmarks.",
    );
    console.error(
      "scripts/setup-local-db-lib.mjs's BACKFILL_LANDMARKS only covers recent migration generations, growing only when a local database survives across a gap of several generations without ever running --apply-pending in between.",
    );
    console.error(
      "Re-run with --force to wipe and start clean (a backup is taken automatically first), or extend BACKFILL_LANDMARKS to recognize this database's actual state.",
    );
    process.exit(1);
  }

  const database = new DatabaseSync(dbPath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  ensureBookkeepingTable(database);

  if (plan.backfill) {
    const appliedAt = new Date().toISOString();
    for (const name of plan.backfill.names) {
      recordMigrationApplied(database, name, appliedAt);
    }
    console.log(
      `Backfilled migration bookkeeping through ${plan.backfill.cutoff.throughFile} (matched: ${plan.backfill.cutoff.landmark.describe}).`,
    );
  }

  const pending = computePendingMigrations(migrationFiles, plan.appliedNames);
  if (pending.length === 0) {
    console.log("No pending migrations. Local D1 already up to date.");
  } else {
    const result = applyMigrations(database, readMigrationEntries(pending));
    if (result.failure) {
      console.error(
        `migration ${result.failure.name} failed partway; the database is in a partial state — re-run with --force (backs up first)`,
      );
      console.error(`Underlying error: ${result.failure.message}`);
      console.error(
        `Migrations recorded as applied before the failure: ${
          result.applied.length === 0 ? "none" : result.applied.join(", ")
        }`,
      );
      database.close();
      process.exit(1);
    }
    console.log(
      `Applied ${pending.length} pending migration(s): ${pending.join(", ")}`,
    );
  }

  // Currencies aren't a drizzle migration. Seeding is idempotent
  // (INSERT OR IGNORE), so always run it: currencies added to CURRENCIES
  // later still reach pre-existing databases.
  seedCurrencies(database);

  finish(database, null);
}

const counts = readCountsReadOnly();
const guard = decideGuard(counts, { force });

if (applyPending) {
  runApplyPending();
} else if (guard.blocked) {
  console.error("Refusing to wipe local D1: it contains user data.");
  console.error("");
  for (const line of guard.lines) console.error(line);
  console.error("");
  console.error(
    "Re-run with --force to wipe, or use --apply-pending to migrate in place.",
  );
  process.exit(1);
} else {
  runFullReset(guard);
}
