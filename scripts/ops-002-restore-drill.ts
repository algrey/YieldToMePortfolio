import { createHash } from "node:crypto";
import { access, chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATION_DIRECTORY = resolve(SCRIPT_DIRECTORY, "../drizzle");
const DEFAULT_REQUIRED_TABLES = [
  "portfolios",
  "portfolio_daily_snapshots",
  "calculation_runs",
] as const;

export type TableEvidence = Readonly<{
  rowCount: number;
  sha256: string;
}>;

export type RestoreEvidence = Readonly<{
  formatVersion: 1;
  generatedAt: string;
  migrationFiles: readonly {
    name: string;
    sha256: string;
  }[];
  expectedTables: readonly string[];
  actualTables: readonly string[];
  foreignKeysEnabled: boolean;
  integrityCheck: "ok" | "failed";
  schemaSha256: string;
  tables: Readonly<Record<string, TableEvidence>>;
  ownershipCounts: Readonly<Record<string, Readonly<Record<string, number>>>>;
  representativeTables: Readonly<Record<string, TableEvidence>>;
  applicationSmoke: ApplicationSmokeEvidence;
}>;

export type ApplicationSmokeEvidence = Readonly<{
  ok: boolean;
  checks: Readonly<Record<string, "passed" | "skipped">>;
  errors: readonly string[];
  portfolioCount: number;
  calculationRunCount: number;
  snapshotCount: number;
}>;

export type RestoreVerificationResult =
  | { ok: true; evidence: RestoreEvidence }
  | { ok: false; errors: readonly string[]; evidence: RestoreEvidence };

type MigrationEvidence = Readonly<{
  files: readonly { name: string; contents: string; sha256: string }[];
  schemaSql: string;
}>;

type DatabaseInput = {
  database: DatabaseSync;
  close: () => void;
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function canonicalValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { blob: Buffer.from(value).toString("hex") };
  }
  if (typeof value === "bigint") {
    return { bigint: value.toString() };
  }
  return value;
}

function canonicalRow(
  columns: readonly string[],
  row: Record<string, unknown>,
): string {
  return JSON.stringify(columns.map((column) => canonicalValue(row[column])));
}

function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String((row as { name: string }).name));
}

function schemaRows(database: DatabaseSync): Array<Record<string, unknown>> {
  return database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<Record<string, unknown>>;
}

function schemaSha256(database: DatabaseSync): string {
  return sha256(JSON.stringify(schemaRows(database)));
}

function tableColumns(database: DatabaseSync, tableName: string): string[] {
  return database
    .prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
    .all()
    .sort(
      (left, right) =>
        Number((left as { cid: number }).cid) -
        Number((right as { cid: number }).cid),
    )
    .map((row) => String((row as { name: string }).name));
}

type ForeignKeyColumn = Readonly<{
  id: number;
  table: string;
  from: string;
  to: string;
}>;

function foreignKeys(
  database: DatabaseSync,
  tableName: string,
): ForeignKeyColumn[] {
  return database
    .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`)
    .all()
    .map((row) => {
      const value = row as Record<string, unknown>;
      return {
        id: Number(value.id),
        table: String(value.table),
        from: String(value.from),
        to: String(value.to),
      };
    });
}

function dependencyOrderedTables(database: DatabaseSync): string[] {
  const tables = tableNames(database);
  const tableSet = new Set(tables);
  const pending = new Set(tables);
  const ordered: string[] = [];

  while (pending.size > 0) {
    const ready = [...pending].filter((tableName) =>
      foreignKeys(database, tableName).every(
        (foreignKey) =>
          foreignKey.table === tableName ||
          !tableSet.has(foreignKey.table) ||
          !pending.has(foreignKey.table),
      ),
    );
    if (ready.length === 0) {
      throw new Error(
        "cross-table foreign-key cycle prevents ordered D1 import",
      );
    }
    for (const tableName of ready.sort()) {
      pending.delete(tableName);
      ordered.push(tableName);
    }
  }
  return ordered;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString("hex")}'`;
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function dependencyOrderedRows(
  database: DatabaseSync,
  tableName: string,
  columns: readonly string[],
): Array<Record<string, unknown>> {
  const statement = database.prepare(
    `SELECT * FROM ${quoteIdentifier(tableName)}`,
  );
  statement.setReadBigInts(true);
  const rows = (statement.all() as Array<Record<string, unknown>>).sort(
    (left, right) =>
      canonicalRow(columns, left).localeCompare(canonicalRow(columns, right)),
  );
  const selfForeignKeys = Object.values(
    Object.groupBy(
      foreignKeys(database, tableName).filter(
        (foreignKey) => foreignKey.table === tableName,
      ),
      (foreignKey) => String(foreignKey.id),
    ),
  ).filter((group): group is ForeignKeyColumn[] => Boolean(group));
  if (selfForeignKeys.length === 0) return rows;

  const pending = [...rows];
  const ordered: Array<Record<string, unknown>> = [];
  while (pending.length > 0) {
    const readyIndex = pending.findIndex((row) =>
      selfForeignKeys.every((group) => {
        const childValues = group.map((foreignKey) => row[foreignKey.from]);
        if (
          childValues.some((value) => value === null || value === undefined)
        ) {
          return true;
        }
        const parent = rows.find((candidate) =>
          group.every(
            (foreignKey, index) =>
              candidate[foreignKey.to] === childValues[index],
          ),
        );
        return !parent || parent === row || ordered.includes(parent);
      }),
    );
    if (readyIndex < 0) {
      throw new Error(
        `self-referencing row cycle prevents ordered D1 import for ${tableName}`,
      );
    }
    ordered.push(pending.splice(readyIndex, 1)[0]);
  }
  return ordered;
}

export async function writeD1DataImport(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  const input = await openDatabaseInput(inputPath);
  try {
    const statements = dependencyOrderedTables(input.database).flatMap(
      (tableName) => {
        const columns = tableColumns(input.database, tableName);
        // MKT-007: `market_data_providers` now carries a static
        // reference-data row (id 'yahoo-compatible') seeded by the
        // migration chain itself, not by any user action. The documented
        // restore procedure this drill exercises applies migrations to the
        // target FIRST (so the target already has that row) and then
        // replays this full data export -- which, dumped from a
        // migrated source, also contains that same row. Plain INSERT would
        // make every restore fail on this one migration-owned row, so it
        // alone uses OR IGNORE; every other (user-owned/ledger) table keeps
        // a strict INSERT. NOTE this is coarser than "tolerates an
        // already-present match": OR IGNORE swallows ANY constraint
        // violation on this table during replay, not only an identical
        // duplicate of the migration-seeded row -- e.g. a genuinely
        // divergent row that happens to collide on `id` or `code` would
        // also be silently dropped here rather than raising. That gap is
        // covered, not eliminated: `verifyRestoredDatabase`'s per-table
        // row-count/sha256 digest comparison against `expectedEvidence`
        // (see `tableEvidence` below) still runs over the RESTORED
        // database's actual `market_data_providers` contents afterward, so
        // a divergence this INSERT silently dropped still fails the drill
        // via the digest mismatch rather than going unnoticed.
        const insertVerb =
          tableName === "market_data_providers" ? "INSERT OR IGNORE" : "INSERT";
        return dependencyOrderedRows(input.database, tableName, columns).map(
          (row) =>
            `${insertVerb} INTO ${quoteIdentifier(tableName)} (${columns
              .map(quoteIdentifier)
              .join(", ")}) VALUES (${columns
              .map((column) => sqlLiteral(row[column]))
              .join(", ")});`,
        );
      },
    );
    await writeFile(outputPath, `${statements.join("\n")}\n`, { mode: 0o600 });
    await chmod(outputPath, 0o600);
  } finally {
    input.close();
  }
}

function tableEvidence(
  database: DatabaseSync,
  tableName: string,
): TableEvidence {
  const columns = tableColumns(database, tableName);
  const statement = database.prepare(
    `SELECT * FROM ${quoteIdentifier(tableName)}`,
  );
  statement.setReadBigInts(true);
  const rows = statement.all() as Array<Record<string, unknown>>;
  const serializedRows = rows
    .map((row) => canonicalRow(columns, row))
    .sort()
    .join("\n");
  return {
    rowCount: rows.length,
    sha256: sha256(`${rows.length}\n${serializedRows}`),
  };
}

function ownershipCounts(
  database: DatabaseSync,
  tableName: string,
  column: string,
): Readonly<Record<string, number>> {
  const rows = database
    .prepare(
      `SELECT ${quoteIdentifier(column)} AS owner_id, COUNT(*) AS row_count
       FROM ${quoteIdentifier(tableName)}
       WHERE ${quoteIdentifier(column)} IS NOT NULL
       GROUP BY ${quoteIdentifier(column)}
       ORDER BY ${quoteIdentifier(column)}`,
    )
    .all() as Array<{ owner_id: string; row_count: number }>;
  return Object.fromEntries(
    rows.map((row) => [String(row.owner_id), Number(row.row_count)]),
  );
}

function count(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { count: number } | undefined;
  return Number(row?.count ?? 0);
}

function applicationSmoke(database: DatabaseSync): ApplicationSmokeEvidence {
  const errors: string[] = [];
  const checks: Record<string, "passed" | "skipped"> = {};
  const tables = new Set(tableNames(database));

  const integrity = database
    .prepare("PRAGMA integrity_check")
    .all()
    .map((row) => String((row as { integrity_check: string }).integrity_check));
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    errors.push("sqlite integrity_check did not return ok");
  } else {
    checks.integrity = "passed";
  }

  const foreignKeyViolations = database
    .prepare("PRAGMA foreign_key_check")
    .all();
  if (foreignKeyViolations.length > 0) {
    errors.push("foreign_key_check reported violations");
  } else {
    checks.foreignKeys = "passed";
  }

  if (tables.has("users") && tables.has("portfolios")) {
    const orphanedPortfolios = count(
      database,
      `SELECT COUNT(*) AS count
       FROM portfolios AS p
       LEFT JOIN users AS u ON u.id = p.user_id
       WHERE u.id IS NULL`,
    );
    if (orphanedPortfolios > 0) {
      errors.push("portfolio ownership smoke check failed");
    } else {
      checks.portfolioOwnership = "passed";
    }
  } else {
    checks.portfolioOwnership = "skipped";
  }

  if (tables.has("users") && tables.has("transactions")) {
    const orphanedTransactions = count(
      database,
      `SELECT COUNT(*) AS count
       FROM transactions AS t
       LEFT JOIN users AS u ON u.id = t.user_id
       LEFT JOIN portfolios AS p ON p.id = t.portfolio_id AND p.user_id = t.user_id
       WHERE u.id IS NULL OR p.id IS NULL`,
    );
    if (orphanedTransactions > 0) {
      errors.push("transaction ownership smoke check failed");
    } else {
      checks.transactionOwnership = "passed";
    }
  } else {
    checks.transactionOwnership = "skipped";
  }

  if (tables.has("users") && tables.has("portfolio_daily_snapshots")) {
    const orphanedSnapshots = count(
      database,
      `SELECT COUNT(*) AS count
       FROM portfolio_daily_snapshots AS s
       LEFT JOIN portfolios AS p ON p.id = s.portfolio_id AND p.user_id = s.user_id
       WHERE p.id IS NULL`,
    );
    if (orphanedSnapshots > 0) {
      errors.push("snapshot ownership smoke check failed");
    } else {
      checks.snapshotOwnership = "passed";
    }
  } else {
    checks.snapshotOwnership = "skipped";
  }

  if (tables.has("users") && tables.has("calculation_runs")) {
    const orphanedRuns = count(
      database,
      `SELECT COUNT(*) AS count
       FROM calculation_runs AS r
       LEFT JOIN portfolios AS p ON p.id = r.portfolio_id AND p.user_id = r.user_id
       WHERE p.id IS NULL`,
    );
    if (orphanedRuns > 0) {
      errors.push("calculation ownership smoke check failed");
    } else {
      checks.calculationOwnership = "passed";
    }
  } else {
    checks.calculationOwnership = "skipped";
  }

  return {
    ok: errors.length === 0,
    checks,
    errors,
    portfolioCount: tables.has("portfolios")
      ? count(database, "SELECT COUNT(*) AS count FROM portfolios")
      : 0,
    calculationRunCount: tables.has("calculation_runs")
      ? count(database, "SELECT COUNT(*) AS count FROM calculation_runs")
      : 0,
    snapshotCount: tables.has("portfolio_daily_snapshots")
      ? count(
          database,
          "SELECT COUNT(*) AS count FROM portfolio_daily_snapshots",
        )
      : 0,
  };
}

async function readMigrationEvidence(
  migrationDirectory: string,
): Promise<MigrationEvidence> {
  const files = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error("no migration SQL files found");
  }

  const entries = await Promise.all(
    files.map(async (name) => {
      const contents = await readFile(join(migrationDirectory, name), "utf8");
      return { name, contents, sha256: sha256(contents) };
    }),
  );
  return {
    files: entries,
    schemaSql: entries.map((entry) => entry.contents).join("\n"),
  };
}

function openDatabaseInput(inputPath: string): Promise<DatabaseInput> {
  if (inputPath.toLowerCase().endsWith(".sql")) {
    return readFile(inputPath, "utf8").then((contents) => {
      const database = new DatabaseSync(":memory:");
      // D1 exports interleave each table's data with its CREATE TABLE statement.
      // Parent tables can therefore appear after child rows; import the dump with
      // enforcement disabled, then verify all relationships after it is complete.
      database.exec("PRAGMA foreign_keys = OFF;");
      database.exec(contents);
      database.exec("PRAGMA foreign_keys = ON;");
      return { database, close: () => database.close() };
    });
  }

  return access(inputPath).then(() => {
    const database = new DatabaseSync(inputPath);
    return { database, close: () => database.close() };
  });
}

function compareExpectedEvidence(
  expected: RestoreEvidence,
  actual: RestoreEvidence,
): string[] {
  const errors: string[] = [];
  if (expected.schemaSha256 !== actual.schemaSha256) {
    errors.push("schema checksum differs from the source evidence");
  }

  for (const tableName of expected.expectedTables) {
    const expectedTable = expected.tables[tableName];
    const actualTable = actual.tables[tableName];
    if (!expectedTable || !actualTable) {
      errors.push(`table evidence is missing for ${tableName}`);
      continue;
    }
    if (
      expectedTable.rowCount !== actualTable.rowCount ||
      expectedTable.sha256 !== actualTable.sha256
    ) {
      errors.push(`table checksum or count differs for ${tableName}`);
    }
  }

  if (
    JSON.stringify(expected.ownershipCounts) !==
    JSON.stringify(actual.ownershipCounts)
  ) {
    errors.push("ownership counts differ from the source evidence");
  }
  if (
    JSON.stringify(expected.migrationFiles) !==
    JSON.stringify(actual.migrationFiles)
  ) {
    errors.push("migration file checksums differ from the source evidence");
  }
  return errors;
}

export async function verifyRestoredDatabase(
  inputPath: string,
  options: Readonly<{
    migrationDirectory?: string;
    requiredTables?: readonly string[];
    expectedEvidence?: RestoreEvidence;
    now?: string;
  }> = {},
): Promise<RestoreVerificationResult> {
  const migrationDirectory =
    options.migrationDirectory ?? DEFAULT_MIGRATION_DIRECTORY;
  const requiredTables = options.requiredTables ?? DEFAULT_REQUIRED_TABLES;
  const migrationEvidence = await readMigrationEvidence(migrationDirectory);
  const expectedSchema = new DatabaseSync(":memory:");
  expectedSchema.exec("PRAGMA foreign_keys = ON;");
  expectedSchema.exec(migrationEvidence.schemaSql);

  const input = await openDatabaseInput(inputPath);
  const database = input.database;
  database.exec("PRAGMA foreign_keys = ON;");
  const actualTables = tableNames(database);
  const expectedTables = tableNames(expectedSchema);
  const errors: string[] = [];
  const expectedSchemaSha256 = schemaSha256(expectedSchema);

  const missingTables = expectedTables.filter(
    (tableName) => !actualTables.includes(tableName),
  );
  const unexpectedTables = actualTables.filter(
    (tableName) => !expectedTables.includes(tableName),
  );
  if (missingTables.length > 0) {
    errors.push(`missing tables: ${missingTables.join(", ")}`);
  }
  if (unexpectedTables.length > 0) {
    errors.push(`unexpected tables: ${unexpectedTables.join(", ")}`);
  }

  const integrity = database
    .prepare("PRAGMA integrity_check")
    .all()
    .map((row) => String((row as { integrity_check: string }).integrity_check));
  const foreignKeysEnabled =
    Number(
      (
        database.prepare("PRAGMA foreign_keys").get() as {
          foreign_keys: number;
        }
      ).foreign_keys,
    ) === 1;
  if (!foreignKeysEnabled) {
    errors.push("foreign key enforcement is disabled");
  }
  if (integrity.length !== 1 || integrity[0] !== "ok") {
    errors.push("sqlite integrity_check did not return ok");
  }
  const actualSchemaSha256 = schemaSha256(database);
  if (actualSchemaSha256 !== expectedSchemaSha256) {
    errors.push("schema checksum differs from checked-in migrations");
  }

  const tables = Object.fromEntries(
    actualTables.map((tableName) => [
      tableName,
      tableEvidence(database, tableName),
    ]),
  );
  const ownership = Object.fromEntries(
    actualTables.flatMap((tableName) => {
      const columns = tableColumns(database, tableName);
      return ["user_id", "target_owner_user_id"]
        .filter((column) => columns.includes(column))
        .map((column) => [
          `${tableName}.${column}`,
          ownershipCounts(database, tableName, column),
        ]);
    }),
  );
  const representativeTables = Object.fromEntries(
    requiredTables.map((tableName) => {
      const evidence = tables[tableName];
      if (!evidence) {
        errors.push(`required representative table is missing: ${tableName}`);
        return [tableName, { rowCount: 0, sha256: "" }];
      }
      if (evidence.rowCount === 0) {
        errors.push(`required representative table is empty: ${tableName}`);
      }
      return [tableName, evidence];
    }),
  );
  const smoke = applicationSmoke(database);
  errors.push(...smoke.errors);

  const evidence: RestoreEvidence = {
    formatVersion: 1,
    generatedAt: options.now ?? new Date().toISOString(),
    migrationFiles: migrationEvidence.files.map(
      ({ name, sha256: fileHash }) => ({
        name,
        sha256: fileHash,
      }),
    ),
    expectedTables,
    actualTables,
    foreignKeysEnabled,
    integrityCheck:
      integrity.length === 1 && integrity[0] === "ok" ? "ok" : "failed",
    schemaSha256: actualSchemaSha256,
    tables,
    ownershipCounts: ownership,
    representativeTables,
    applicationSmoke: smoke,
  };

  if (options.expectedEvidence) {
    errors.push(...compareExpectedEvidence(options.expectedEvidence, evidence));
  }

  input.close();
  expectedSchema.close();
  return errors.length === 0
    ? { ok: true, evidence }
    : { ok: false, errors, evidence };
}

function parseArguments(argv: readonly string[]): {
  inputPath: string;
  outputPath: string | null;
  migrationDirectory: string;
  requiredTables: string[];
  expectedEvidencePath: string | null;
  d1DataOutputPath: string | null;
} {
  let inputPath: string | null = null;
  let outputPath: string | null = null;
  let migrationDirectory = DEFAULT_MIGRATION_DIRECTORY;
  let expectedEvidencePath: string | null = null;
  let d1DataOutputPath: string | null = null;
  const requiredTables: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--input" && value) {
      inputPath = resolve(value);
      index += 1;
    } else if (argument === "--output" && value) {
      outputPath = resolve(value);
      index += 1;
    } else if (argument === "--migration-dir" && value) {
      migrationDirectory = resolve(value);
      index += 1;
    } else if (argument === "--require-table" && value) {
      requiredTables.push(value);
      index += 1;
    } else if (argument === "--expected-evidence" && value) {
      expectedEvidencePath = resolve(value);
      index += 1;
    } else if (argument === "--d1-data-output" && value) {
      d1DataOutputPath = resolve(value);
      index += 1;
    } else if (argument === "--help") {
      console.log(
        "Usage: node --experimental-strip-types scripts/ops-002-restore-drill.ts --input <sqlite-or-sql> [--output <evidence.json>] [--expected-evidence <evidence.json>] [--d1-data-output <data.sql>] [--require-table <name>]...",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }

  if (!inputPath) {
    throw new Error("--input is required");
  }
  return {
    inputPath,
    outputPath,
    migrationDirectory,
    requiredTables:
      requiredTables.length > 0 ? requiredTables : [...DEFAULT_REQUIRED_TABLES],
    expectedEvidencePath,
    d1DataOutputPath,
  };
}

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const expectedEvidence = args.expectedEvidencePath
    ? (JSON.parse(
        await readFile(args.expectedEvidencePath, "utf8"),
      ) as RestoreEvidence)
    : undefined;
  const result = await verifyRestoredDatabase(args.inputPath, {
    migrationDirectory: args.migrationDirectory,
    requiredTables: args.requiredTables,
    expectedEvidence,
  });

  if (result.ok && args.d1DataOutputPath) {
    await writeD1DataImport(args.inputPath, args.d1DataOutputPath);
  }

  if (args.outputPath) {
    await writeFile(
      args.outputPath,
      `${JSON.stringify(result.evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    await chmod(args.outputPath, 0o600);
  }

  if (!result.ok) {
    console.error(`OPS-002 restore drill failed: ${result.errors.join("; ")}`);
    process.exitCode = 1;
    return result;
  }

  console.log(
    JSON.stringify({
      ok: true,
      schemaSha256: result.evidence.schemaSha256,
      tableCount: result.evidence.actualTables.length,
      portfolioCount: result.evidence.applicationSmoke.portfolioCount,
      calculationRunCount: result.evidence.applicationSmoke.calculationRunCount,
      snapshotCount: result.evidence.applicationSmoke.snapshotCount,
    }),
  );
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
