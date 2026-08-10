// Local development helper: reset and migrate the Miniflare-backed D1 database
// that `vinext dev` uses, then seed reference currencies so JIT user
// provisioning (default home currency AUD) can succeed.
//
// This is a developer convenience for local testing only. It applies the
// reviewed Drizzle migrations in `drizzle/` directly with `node:sqlite`, which
// honours the in-file `PRAGMA foreign_keys=OFF` used by table-rebuild
// migrations (unlike `wrangler d1 execute`, which wraps files in a transaction
// where that pragma is a no-op).

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
for (const suffix of ["", "-wal", "-shm"]) {
  const path = `${dbPath}${suffix}`;
  if (existsSync(path)) rmSync(path);
}
console.log(`Reset D1 database file: ${dbFile}`);

const database = new DatabaseSync(dbPath);
database.exec("PRAGMA journal_mode = WAL;");
database.exec("PRAGMA foreign_keys = ON;");

const migrationFiles = readdirSync(drizzleDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();
for (const file of migrationFiles) {
  database.exec(readFileSync(join(drizzleDir, file), "utf8"));
}
console.log(`Applied ${migrationFiles.length} migrations.`);

// ISO 4217 reference rows used by JIT provisioning, portfolio creation, and the
// example CSV import. Minor-unit digits: JPY=0, others=2.
const currencies = [
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
const insert = database.prepare(
  "INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active) VALUES (?, ?, ?, ?, 1)",
);
for (const [code, numericCode, name, minorUnitDigits] of currencies) {
  insert.run(code, numericCode, name, minorUnitDigits);
}
console.log(`Seeded ${currencies.length} currencies.`);

const tableCount = database
  .prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )
  .get();
console.log(`Tables present: ${tableCount.n}`);
database.close();
console.log("Local D1 ready.");
