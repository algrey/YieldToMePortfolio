import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createOwnedImportStagingRepository,
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  parseStrictVersionedCsvImport,
  SUPPORTED_IMPORT_HEADER,
  SUPPORTED_IMPORT_PARSER_VERSION,
} from "../domain/imports/index.ts";

const IMPORT_FORMAT = "strict-versioned-csv";

async function loadMigrationSql(): Promise<string> {
  const migrationFiles = (
    await readdir(new URL("../drizzle", import.meta.url))
  ).filter((file) => file.endsWith(".sql"));

  assert.ok(migrationFiles.length > 0, "expected a generated migration");

  const migrations = await Promise.all(
    migrationFiles
      .sort()
      .map((file) =>
        readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
      ),
  );

  return migrations.join("\n");
}

function createMigratedDatabase(sql: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(sql);
  return database;
}

function createRecordedSqlClient(database: DatabaseSync) {
  const baseClient = createSqliteSqlClient(database);
  const statements: string[] = [];

  return {
    statements,
    async all<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T[]> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return await baseClient.all<T>(sql, params);
    },
    async get<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T | undefined> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return await baseClient.get<T>(sql, params);
    },
    async run(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<{ changes: number; lastInsertRowId: number }> {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return await baseClient.run(sql, params);
    },
    async batch(batchStatements: Parameters<typeof baseClient.batch>[0]) {
      for (const statement of batchStatements) {
        statements.push(statement.sql.replace(/\s+/g, " ").trim());
      }
      return await baseClient.batch(batchStatements);
    },
  };
}

function seedReferenceData(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES
      ('AUD', 36, 'Australian dollar', 2, 1),
      ('USD', 840, 'US dollar', 2, 1);

    INSERT INTO users (
      id, status, display_name, primary_email, locale, timezone,
      terms_accepted_at, last_seen_at, created_at, updated_at, version
    )
    VALUES
      ('user-a', 'active', 'Alice', 'alice@example.com', 'en-AU', 'Australia/Sydney',
       NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('user-b', 'active', 'Bob', 'bob@example.com', 'en-AU', 'Australia/Sydney',
       NULL, NULL, '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);

    INSERT INTO user_settings (
      user_id, home_currency_code, timezone, default_holding_currency_view,
      created_at, updated_at, version
    )
    VALUES
      ('user-a', 'AUD', 'Australia/Sydney', 'native', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('user-b', 'USD', 'Australia/Sydney', 'native', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);

    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone, accounting_method,
      history_complete_from, status, created_at, updated_at, version
    )
    VALUES
      ('portfolio-a', 'user-a', 'A', 'Alice Portfolio', 'AUD', 'Australia/Sydney', 'fifo', NULL, 'active', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1),
      ('portfolio-b', 'user-b', 'B', 'Bob Portfolio', 'USD', 'Australia/Sydney', 'fifo', NULL, 'active', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', 1);
  `);
}

function makeCsv(rows: string[]): string {
  return [SUPPORTED_IMPORT_HEADER.join(","), ...rows].join("\n");
}

test("stages parsed batches, preserves rows and issues, and supports duplicate uploads", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const client = createRecordedSqlClient(database);
  const repository = createOwnedImportStagingRepository(
    client,
    () => "2026-07-29T12:00:00Z",
  );

  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD",,,,,,,,,,`,
    `"2","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"note"`,
  ]);
  const parseResult = await parseStrictVersionedCsvImport(csv);
  assert.equal(parseResult.ok, true);
  if (!parseResult.ok) {
    return;
  }

  const firstUpload = await repository.startUpload("user-a", {
    parserFormat: IMPORT_FORMAT,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "sample.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: parseResult.fileFingerprint,
    targetPortfolioId: "portfolio-a",
  });
  assert.equal(firstUpload.ok, true);
  assert.equal(firstUpload.reused, false);
  assert.equal(firstUpload.batch.status, "uploaded");

  const staged = await repository.recordParseResult(
    "user-a",
    firstUpload.batch.id,
    {
      expectedVersion: firstUpload.batch.version,
      parseResult,
    },
  );
  assert.equal(staged.ok, true);
  if (!staged.ok) {
    return;
  }

  assert.equal(staged.batch.status, "parsed");
  assert.equal(staged.rowsInserted, 2);
  assert.equal(staged.issuesInserted, 0);

  const rows = await repository.listRows("user-a", firstUpload.batch.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.validationStatus, "valid");
  assert.equal(rows[0]?.targetPortfolioId, null);
  assert.equal(rows[0]?.targetPortfolioSecurityId, null);

  const issues = await repository.listIssues("user-a", firstUpload.batch.id);
  assert.equal(issues.length, 0);

  const duplicateUpload = await repository.startUpload("user-a", {
    parserFormat: IMPORT_FORMAT,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "sample.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: parseResult.fileFingerprint,
    targetPortfolioId: "portfolio-a",
  });
  assert.equal(duplicateUpload.ok, true);
  assert.equal(duplicateUpload.reused, true);
  assert.equal(duplicateUpload.batch.id, firstUpload.batch.id);
  assert.equal(duplicateUpload.batch.status, "parsed");

  const transitioned = await repository.transitionStatus(
    "user-a",
    firstUpload.batch.id,
    {
      expectedVersion: staged.batch.version,
      nextStatus: "needs_mapping",
    },
  );
  assert.equal(transitioned.ok, true);
  if (!transitioned.ok) {
    return;
  }

  assert.equal(transitioned.batch.status, "needs_mapping");

  const staleTransition = await repository.transitionStatus(
    "user-a",
    firstUpload.batch.id,
    {
      expectedVersion: staged.batch.version,
      nextStatus: "ready",
    },
  );
  assert.equal(staleTransition.ok, false);
  if (staleTransition.ok) {
    return;
  }
  assert.equal(staleTransition.reason, "version_conflict");

  assert.equal(
    (
      database.prepare("SELECT count(*) AS count FROM portfolios").get() as {
        count: number;
      }
    ).count,
    2,
  );

  const recordedStatements = client.statements.join("\n");
  assert.match(
    recordedStatements,
    /FROM import_batches WHERE id = \? AND user_id = \? LIMIT 1/i,
  );
  assert.match(
    recordedStatements,
    /FROM import_rows WHERE user_id = \? AND batch_id = \?/i,
  );
  assert.match(
    recordedStatements,
    /FROM import_issues WHERE user_id = \? AND batch_id = \?/i,
  );
});

test("persists invalid batches and issue evidence without mutating owned facts", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const client = createSqliteSqlClient(database);
  const repository = createOwnedImportStagingRepository(
    client,
    () => "2026-07-29T13:00:00Z",
  );

  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Hold",,,"bad row"`,
  ]);
  const parseResult = await parseStrictVersionedCsvImport(csv);
  assert.equal(parseResult.ok, true);
  if (!parseResult.ok) {
    return;
  }

  const upload = await repository.startUpload("user-a", {
    parserFormat: IMPORT_FORMAT,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "invalid.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: parseResult.fileFingerprint,
  });
  assert.equal(upload.ok, true);

  const staged = await repository.recordParseResult("user-a", upload.batch.id, {
    expectedVersion: upload.batch.version,
    parseResult,
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) {
    return;
  }

  assert.equal(staged.batch.status, "invalid");
  assert.equal(staged.rowsInserted, 1);
  assert.equal(staged.issuesInserted, 1);
  assert.equal(staged.batch.failureCategory, "validation_error");

  const batch = await repository.get("user-a", upload.batch.id);
  assert.ok(batch);
  assert.equal(batch?.status, "invalid");

  const rows = await repository.listRows("user-a", upload.batch.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.rowClass, "unsupported");
  assert.equal(rows[0]?.validationStatus, "invalid");
  assert.equal(rows[0]?.errorCount, 1);

  const issues = await repository.listIssues("user-a", upload.batch.id);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.rowId, rows[0]?.id);
  assert.equal(issues[0]?.severity, "error");
  assert.equal(issues[0]?.code, "ROW_UNCLASSIFIED");

  assert.equal(
    (
      database.prepare("SELECT count(*) AS count FROM portfolios").get() as {
        count: number;
      }
    ).count,
    2,
  );
});

test("persists parser failure issues at batch scope", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const client = createSqliteSqlClient(database);
  const repository = createOwnedImportStagingRepository(
    client,
    () => "2026-07-29T13:30:00Z",
  );

  const parseResult = await parseStrictVersionedCsvImport(
    [
      "Id,Symbol,Name,Display Symbol,Exchange,Portfolio,Currency,Shares Owned,Cost Per Share,Commission,Transaction Date,Transaction Time,Purchase Exchange Rate,Type,Accounting,Accounting Execution Ids,Extra",
      `"1","ABC","Alpha",,"ASX","Main","AUD",,,,,,,,,,`,
    ].join("\n"),
  );
  assert.equal(parseResult.ok, false);
  if (parseResult.ok) {
    return;
  }

  const csv = [
    "Id,Symbol,Name,Display Symbol,Exchange,Portfolio,Currency,Shares Owned,Cost Per Share,Commission,Transaction Date,Transaction Time,Purchase Exchange Rate,Type,Accounting,Accounting Execution Ids,Extra",
    `"1","ABC","Alpha",,"ASX","Main","AUD",,,,,,,,,,`,
  ].join("\n");

  const upload = await repository.startUpload("user-a", {
    parserFormat: IMPORT_FORMAT,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "header-mismatch.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: parseResult.fileFingerprint,
  });
  assert.equal(upload.ok, true);

  const staged = await repository.recordParseResult("user-a", upload.batch.id, {
    expectedVersion: upload.batch.version,
    parseResult,
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) {
    return;
  }

  assert.equal(staged.batch.status, "invalid");
  assert.equal(staged.rowsInserted, 0);
  assert.equal(staged.issuesInserted, 1);

  const issues = await repository.listIssues("user-a", upload.batch.id);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.rowId, null);
  assert.equal(issues[0]?.physicalRowNumber, null);
  assert.equal(issues[0]?.code, "HEADER_MISMATCH");
});

test("denies cross-user access and enforces row bounds with foreign keys enabled", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const repository = createOwnedImportStagingRepository(
    createSqliteSqlClient(database),
    () => "2026-07-29T14:00:00Z",
  );

  const csv = makeCsv([`"1","ABC","Alpha",,"ASX","Main","AUD",,,,,,,,,,`]);
  const parseResult = await parseStrictVersionedCsvImport(csv);
  assert.equal(parseResult.ok, true);
  if (!parseResult.ok) {
    return;
  }

  const upload = await repository.startUpload("user-a", {
    parserFormat: IMPORT_FORMAT,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "row-bound.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: parseResult.fileFingerprint,
  });
  assert.equal(upload.ok, true);

  const crossUserBatch = await repository.get("user-b", upload.batch.id);
  assert.equal(crossUserBatch, null);

  const ownedHistory = await repository.listBatches("user-a");
  assert.equal(
    ownedHistory.some((batch) => batch.id === upload.batch.id),
    true,
  );
  const crossUserHistory = await repository.listBatches("user-b");
  assert.deepEqual(crossUserHistory, []);

  const crossUserRows = await repository.listRows("user-b", upload.batch.id);
  assert.deepEqual(crossUserRows, []);

  assert.throws(() => {
    database.exec(`
      INSERT INTO import_rows (
        id, user_id, batch_id, physical_row_number, row_class,
        original_fields_json, validation_status, commit_status,
        created_at, updated_at, version
      )
      VALUES (
        'bad-cross-user', 'user-b', '${upload.batch.id}', 2, 'blank',
        '[]', 'staged', 'staged', '2026-07-29T14:00:00Z', '2026-07-29T14:00:00Z', 1
      );
    `);
  }, /FOREIGN KEY constraint failed/);

  assert.throws(() => {
    database.exec(`
      INSERT INTO import_rows (
        id, user_id, batch_id, physical_row_number, row_class,
        original_fields_json, validation_status, commit_status,
        created_at, updated_at, version
      )
      VALUES (
        'bad-row-bound', 'user-a', '${upload.batch.id}', 1, 'blank',
        '[]', 'staged', 'staged', '2026-07-29T14:00:00Z', '2026-07-29T14:00:00Z', 1
      );
    `);
  }, /CHECK constraint failed: import_rows_physical_row_number_check/);
});

// QA-003 B4(a): a stale `expectedVersion` must leave `persistParsedResult`'s
// atomic batch untouched — the version/status pre-check rejects it before
// any write is attempted, and the same batch remains retryable with the
// correct version afterward.
test("stale expectedVersion on recordParseResult persists nothing and stays retryable", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const client = createSqliteSqlClient(database);
  const repository = createOwnedImportStagingRepository(
    client,
    () => "2026-07-29T15:00:00Z",
  );

  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"note"`,
  ]);
  const parseResult = await parseStrictVersionedCsvImport(csv);
  assert.equal(parseResult.ok, true);
  if (!parseResult.ok) {
    return;
  }

  const upload = await repository.startUpload("user-a", {
    parserFormat: IMPORT_FORMAT,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "stale-version.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: parseResult.fileFingerprint,
    targetPortfolioId: "portfolio-a",
  });
  assert.equal(upload.ok, true);
  if (!upload.ok) {
    return;
  }

  const staleResult = await repository.recordParseResult(
    "user-a",
    upload.batch.id,
    { expectedVersion: upload.batch.version + 1, parseResult },
  );
  assert.equal(staleResult.ok, false);
  if (staleResult.ok) {
    return;
  }
  assert.equal(staleResult.reason, "version_conflict");

  const rows = await repository.listRows("user-a", upload.batch.id);
  assert.equal(rows.length, 0);
  const issues = await repository.listIssues("user-a", upload.batch.id);
  assert.equal(issues.length, 0);

  const unchangedBatch = await repository.get("user-a", upload.batch.id);
  assert.ok(unchangedBatch);
  assert.equal(unchangedBatch?.status, "uploaded");
  assert.equal(unchangedBatch?.version, upload.batch.version);

  const retried = await repository.recordParseResult(
    "user-a",
    upload.batch.id,
    { expectedVersion: upload.batch.version, parseResult },
  );
  assert.equal(retried.ok, true);
});

// QA-003 B4(c): if any statement in `persistParsedResult`'s single atomic
// `batch()` call fails, D1/`node:sqlite`'s batch() semantics roll back every
// statement in that call — so nothing persists, not even the earlier
// statements that would otherwise have succeeded. Simulated here by
// wrapping the client to append one statement that is guaranteed to
// violate a NOT NULL constraint after the real statements.
test("a mid-batch statement failure persists nothing via batch() atomicity", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const baseClient = createSqliteSqlClient(database);
  const injectingClient: SqlClient = {
    ...baseClient,
    async batch(statements) {
      return await baseClient.batch([
        ...statements,
        {
          sql: "INSERT INTO import_rows (id) VALUES ('mid-batch-injected-failure')",
          params: [],
        },
      ]);
    },
  };
  const repository = createOwnedImportStagingRepository(
    injectingClient,
    () => "2026-07-29T15:30:00Z",
  );

  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"note"`,
  ]);
  const parseResult = await parseStrictVersionedCsvImport(csv);
  assert.equal(parseResult.ok, true);
  if (!parseResult.ok) {
    return;
  }

  const upload = await repository.startUpload("user-a", {
    parserFormat: IMPORT_FORMAT,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "mid-batch-failure.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: parseResult.fileFingerprint,
    targetPortfolioId: "portfolio-a",
  });
  assert.equal(upload.ok, true);
  if (!upload.ok) {
    return;
  }

  const recorded = await repository.recordParseResult(
    "user-a",
    upload.batch.id,
    { expectedVersion: upload.batch.version, parseResult },
  );
  assert.equal(recorded.ok, false);
  if (recorded.ok) {
    return;
  }
  assert.equal(recorded.reason, "atomic_failure");

  const verifyRepository = createOwnedImportStagingRepository(baseClient);
  const rows = await verifyRepository.listRows("user-a", upload.batch.id);
  assert.equal(rows.length, 0);
  const issues = await verifyRepository.listIssues("user-a", upload.batch.id);
  assert.equal(issues.length, 0);
  const unchangedBatch = await verifyRepository.get("user-a", upload.batch.id);
  assert.ok(unchangedBatch);
  assert.equal(unchangedBatch?.status, "uploaded");
  assert.equal(unchangedBatch?.version, upload.batch.version);
});

const PARSE_RESULT_PRECHECK_SQL =
  "SELECT id, status, version FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1";

/**
 * Wraps `baseClient` so that the FIRST time `persistParsedResult`'s
 * version/status pre-check `get()` runs, a concurrent writer's
 * `uploaded -> failed` transition (its own version bump) is applied to the
 * real database strictly AFTER that pre-check read returns but BEFORE the
 * repository's `batch()` call executes. This reproduces the exact race the
 * PRE-state guard must reject: by the time the guarded inserts and the
 * closing UPDATE run, `import_batches` is already one version ahead of
 * what the caller observed.
 */
function createConcurrentBumpClient(
  baseClient: SqlClient,
  batchId: string,
): SqlClient {
  let injected = false;
  return {
    ...baseClient,
    async get<T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<T | undefined> {
      const result = await baseClient.get<T>(sql, params);
      if (
        !injected &&
        sql.replace(/\s+/g, " ").trim() === PARSE_RESULT_PRECHECK_SQL
      ) {
        injected = true;
        await baseClient.run(
          `UPDATE import_batches
           SET status = 'failed', failure_category = 'concurrent_writer',
               updated_at = ?, version = version + 1
           WHERE id = ?`,
          ["2026-07-29T15:00:01Z", batchId],
        );
      }
      return result;
    },
  };
}

// QA-003 B1/B2: a concurrent writer's version bump landing strictly between
// `persistParsedResult`'s pre-check read and its atomic `batch()` call must
// make the ENTIRE call a no-op — zero rows, zero issues, `version_conflict`
// — for the parsed-rows (success) path. Guarding the child inserts on the
// version the closing UPDATE would bump *to* (rather than the PRE-state
// version/status the caller actually observed) let this exact race persist
// ghost rows into a batch whose state this call never wrote; this test
// exercises the real guard the way the stale-`expectedVersion` tests above
// cannot, since those are rejected by the pre-check before any batch is
// issued.
test("a concurrent uploaded->failed bump between the pre-check and the atomic batch blocks every guarded insert (parsed rows)", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const baseClient = createSqliteSqlClient(database);
  const setupRepository = createOwnedImportStagingRepository(baseClient);

  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"note"`,
  ]);
  const parseResult = await parseStrictVersionedCsvImport(csv);
  assert.equal(parseResult.ok, true);
  if (!parseResult.ok) {
    return;
  }

  const upload = await setupRepository.startUpload("user-a", {
    parserFormat: IMPORT_FORMAT,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "concurrent-bump-rows.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: parseResult.fileFingerprint,
    targetPortfolioId: "portfolio-a",
  });
  assert.equal(upload.ok, true);
  if (!upload.ok) {
    return;
  }

  const injectingClient = createConcurrentBumpClient(
    baseClient,
    upload.batch.id,
  );
  const repository = createOwnedImportStagingRepository(
    injectingClient,
    () => "2026-07-29T15:00:00Z",
  );

  const recorded = await repository.recordParseResult(
    "user-a",
    upload.batch.id,
    { expectedVersion: upload.batch.version, parseResult },
  );
  assert.equal(recorded.ok, false);
  if (recorded.ok) {
    return;
  }
  assert.equal(recorded.reason, "version_conflict");

  const verifyRepository = createOwnedImportStagingRepository(baseClient);
  const rows = await verifyRepository.listRows("user-a", upload.batch.id);
  assert.equal(rows.length, 0);
  const issues = await verifyRepository.listIssues("user-a", upload.batch.id);
  assert.equal(issues.length, 0);

  const finalBatch = await verifyRepository.get("user-a", upload.batch.id);
  assert.ok(finalBatch);
  assert.equal(finalBatch?.status, "failed");
  assert.equal(finalBatch?.failureCategory, "concurrent_writer");
  assert.equal(finalBatch?.version, upload.batch.version + 1);
});

// QA-003 B1/B2: same race as above, exercised against the parse-FAILURE
// (batch-level issues) path — this path has no unique-index safety net at
// all, so an unguarded/mis-guarded insert here would silently persist
// issue rows into a batch a concurrent writer already moved on from.
test("a concurrent uploaded->failed bump between the pre-check and the atomic batch blocks every guarded insert (parse-failure issues)", async () => {
  const database = createMigratedDatabase(await loadMigrationSql());
  seedReferenceData(database);
  const baseClient = createSqliteSqlClient(database);
  const setupRepository = createOwnedImportStagingRepository(baseClient);

  const csv = [
    "Id,Symbol,Name,Display Symbol,Exchange,Portfolio,Currency,Shares Owned,Cost Per Share,Commission,Transaction Date,Transaction Time,Purchase Exchange Rate,Type,Accounting,Accounting Execution Ids,Extra",
    `"1","ABC","Alpha",,"ASX","Main","AUD",,,,,,,,,,`,
  ].join("\n");
  const parseResult = await parseStrictVersionedCsvImport(csv);
  assert.equal(parseResult.ok, false);
  if (parseResult.ok) {
    return;
  }

  const upload = await setupRepository.startUpload("user-a", {
    parserFormat: IMPORT_FORMAT,
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "concurrent-bump-issues.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: parseResult.fileFingerprint,
  });
  assert.equal(upload.ok, true);
  if (!upload.ok) {
    return;
  }

  const injectingClient = createConcurrentBumpClient(
    baseClient,
    upload.batch.id,
  );
  const repository = createOwnedImportStagingRepository(
    injectingClient,
    () => "2026-07-29T15:00:00Z",
  );

  const recorded = await repository.recordParseResult(
    "user-a",
    upload.batch.id,
    { expectedVersion: upload.batch.version, parseResult },
  );
  assert.equal(recorded.ok, false);
  if (recorded.ok) {
    return;
  }
  assert.equal(recorded.reason, "version_conflict");

  const verifyRepository = createOwnedImportStagingRepository(baseClient);
  const rows = await verifyRepository.listRows("user-a", upload.batch.id);
  assert.equal(rows.length, 0);
  const issues = await verifyRepository.listIssues("user-a", upload.batch.id);
  assert.equal(issues.length, 0);

  const finalBatch = await verifyRepository.get("user-a", upload.batch.id);
  assert.ok(finalBatch);
  assert.equal(finalBatch?.status, "failed");
  assert.equal(finalBatch?.failureCategory, "concurrent_writer");
  assert.equal(finalBatch?.version, upload.batch.version + 1);
});
