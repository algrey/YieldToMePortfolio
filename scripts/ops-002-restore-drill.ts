import { createHash } from "node:crypto";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
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

function tableEvidence(
  database: DatabaseSync,
  tableName: string,
): TableEvidence {
  const columns = tableColumns(database, tableName);
  const rows = database
    .prepare(`SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY rowid`)
    .all() as Array<Record<string, unknown>>;
  const serializedRows = rows
    .map((row) => canonicalRow(columns, row))
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
      database.exec(contents);
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
    schemaSha256: schemaSha256(database),
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
} {
  let inputPath: string | null = null;
  let outputPath: string | null = null;
  let migrationDirectory = DEFAULT_MIGRATION_DIRECTORY;
  let expectedEvidencePath: string | null = null;
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
    } else if (argument === "--help") {
      console.log(
        "Usage: node --experimental-strip-types scripts/ops-002-restore-drill.ts --input <sqlite-or-sql> [--output <evidence.json>] [--expected-evidence <evidence.json>] [--require-table <name>]...",
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

  if (args.outputPath) {
    await writeFile(
      args.outputPath,
      `${JSON.stringify(result.evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
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
