import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { rejectCrossSiteMutation } from "../app/mutation-request.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION } from "../domain/imports/index.ts";
import {
  createCalculationRunRepository,
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedLedgerRepository,
  createSqliteSqlClient,
  IMPORT_COMMIT_LIMITS,
  type ImportCommitInput,
  type ImportCommitResult,
  type SqlClient,
} from "../db/repositories/index.ts";

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
  database
    .prepare(
      `INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
       VALUES ('AUD', 36, 'Australian dollar', 2, 1)`,
    )
    .run();
  database.exec(`
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1),
           ('portfolio-b', 'user-a', 'B', 'Second', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-03', '2026-08-03'),
           ('security-b', 'Beta', 'equity', 'AUD', 'active', '2026-08-03', '2026-08-03');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'AUD', 'held', '2026-08-03', '2026-08-03'),
           ('membership-b', 'user-a', 'portfolio-b', 'security-b', 'XYZ', 'AUD', 'held', '2026-08-03', '2026-08-03');
  `);
  database
    .prepare(
      `INSERT INTO import_batches (
         id, user_id, target_portfolio_id, parser_format, parser_version, filename,
         byte_size, file_sha256, status, created_at, updated_at, version
       ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv', ?,
         'sample.csv', 100, 'file-a', 'ready', '2026-08-03T00:00:00Z',
         '2026-08-03T00:00:00Z', 1)`,
    )
    .run(SUPPORTED_IMPORT_PARSER_VERSION);
  return database;
}

function normalized(
  rowNumber: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `source-${rowNumber}`,
    symbol: "ABC",
    name: "Alpha",
    displaySymbol: null,
    exchange: "ASX",
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: "2",
    costPerShare: "10",
    commission: "0",
    transactionDate: "2026-08-01 GMT+1000",
    transactionTime: `10:00:${String(rowNumber).padStart(2, "0")}`,
    purchaseExchangeRate: null,
    type: "buy",
    accounting: "fifo",
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: `2026-08-01T00:00:${String(rowNumber).padStart(2, "0")}.000Z`,
    localTradeDate: "2026-08-01",
    cashEvent: null,
    ...overrides,
  };
}

function stageRows(database: DatabaseSync, count = 3): void {
  const insert = database.prepare(
    `INSERT INTO import_rows (
       id, user_id, batch_id, physical_row_number, row_class,
       original_fields_json, normalized_fields_json, normalized_fingerprint,
       validation_status, target_portfolio_id, target_portfolio_security_id,
       commit_status, created_at, updated_at, version
     ) VALUES (?, 'user-a', 'batch-a', ?, 'transaction', '[]', ?, ?, 'valid',
       'portfolio-a', 'membership-a', 'staged', '2026-08-03', '2026-08-03', 1)`,
  );
  for (let index = 0; index < count; index += 1) {
    const rowNumber = index + 2;
    insert.run(
      `row-${index + 1}`,
      rowNumber,
      JSON.stringify(normalized(rowNumber)),
      `fingerprint-${index + 1}`,
    );
  }
}

async function previewVersion(
  client: SqlClient,
  batchId = "batch-a",
): Promise<string> {
  const validated = await createOwnedImportCommitRepository(client).validate(
    "user-a",
    batchId,
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("preview validation failed");
  return validated.previewVersion;
}

function input(version: string, key = "commit-a"): ImportCommitInput {
  return {
    expectedVersion: 1,
    expectedPreviewVersion: version,
    idempotencyKey: key,
    confirmation: true,
    requestId: "request-a",
  };
}

async function finish(
  repository: ReturnType<typeof createOwnedImportCommitRepository>,
  value: ImportCommitInput,
  first?: ImportCommitResult,
): Promise<Extract<ImportCommitResult, { ok: true }>> {
  let result = first ?? (await repository.commit("user-a", "batch-a", value));
  for (
    let attempt = 0;
    attempt < 20 && (!result.ok || result.status !== "committed");
    attempt += 1
  ) {
    assert.equal(result.ok, true);
    result = await repository.commit("user-a", "batch-a", value);
  }
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("commit did not complete");
  assert.equal(result.status, "committed");
  return result;
}

test("every chunk boundary can fail without advancing and resume exactly once", async () => {
  for (const boundary of [0, 1, 2]) {
    const database = await migratedDatabase();
    stageRows(database, 5);
    const client = createSqliteSqlClient(database);
    const version = await previewVersion(client);
    const value = input(version, `commit-${boundary}`);
    const normal = createOwnedImportCommitRepository(client, { chunkSize: 2 });
    for (let completed = 0; completed < boundary; completed += 1) {
      const progressed = await normal.commit("user-a", "batch-a", value);
      assert.equal(progressed.ok, true);
      if (progressed.ok) assert.equal(progressed.status, "committing");
    }
    const before = database
      .prepare(
        "SELECT commit_high_water_row AS high_water FROM import_batches WHERE id = 'batch-a'",
      )
      .get() as { high_water: number };
    const failed = await createOwnedImportCommitRepository(client, {
      chunkSize: 2,
      failAtChunk: boundary,
    }).commit("user-a", "batch-a", value);
    assert.deepEqual(failed, {
      ok: false,
      reason: "injected_failure",
      resumable: true,
    });
    const after = database
      .prepare(
        "SELECT commit_high_water_row AS high_water FROM import_batches WHERE id = 'batch-a'",
      )
      .get() as { high_water: number };
    assert.equal(after.high_water, before.high_water);
    const completed = await finish(normal, value);
    assert.equal(completed.committedRows, 5);
    assert.equal(
      (
        database
          .prepare("SELECT count(*) AS count FROM transactions")
          .get() as { count: number }
      ).count,
      5,
    );
  }
});

test("server revalidation rejects blocked parser state and an exact stale preview", async () => {
  const blocked = await migratedDatabase();
  stageRows(blocked, 1);
  blocked.exec(`
    UPDATE import_rows SET validation_status = 'invalid', error_count = 1 WHERE id = 'row-1';
    INSERT INTO import_issues (
      id, user_id, batch_id, row_id, physical_row_number, severity, code, message,
      created_at, updated_at, version
    ) VALUES ('issue-1', 'user-a', 'batch-a', 'row-1', 2, 'error', 'QUANTITY_INVALID',
      'Bad quantity', '2026-08-03', '2026-08-03', 1);
  `);
  const blockedResult = await createOwnedImportCommitRepository(
    createSqliteSqlClient(blocked),
  ).commit("user-a", "batch-a", input("1.fake"));
  assert.deepEqual(blockedResult, {
    ok: false,
    reason: "revalidation_failed",
  });
  assert.equal(
    (
      blocked
        .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
        .get() as { status: string }
    ).status,
    "ready",
  );

  const stale = await migratedDatabase();
  stageRows(stale, 1);
  const staleClient = createSqliteSqlClient(stale);
  const oldVersion = await previewVersion(staleClient);
  await createOwnedImportMappingDecisionRepository(staleClient).save("user-a", {
    batchId: "batch-a",
    kind: "portfolio",
    sourceKey: "Main",
    normalizedSourceValue: "main",
    targetId: "portfolio-a",
    targetValue: null,
    scope: "batch",
    confidence: "user",
    source: "user",
  });
  const staleResult = await createOwnedImportCommitRepository(
    staleClient,
  ).commit("user-a", "batch-a", input(oldVersion));
  assert.deepEqual(staleResult, { ok: false, reason: "stale_preview" });
  stale.exec(
    "UPDATE import_batches SET parser_version = 'obsolete' WHERE id = 'batch-a'",
  );
  const parserResult = await createOwnedImportCommitRepository(
    staleClient,
  ).commit("user-a", "batch-a", input("irrelevant"));
  assert.deepEqual(parserResult, {
    ok: false,
    reason: "revalidation_failed",
  });

  const raced = await migratedDatabase();
  stageRows(raced, 1);
  const racedBase = createSqliteSqlClient(raced);
  const racedVersion = await previewVersion(racedBase);
  let injectMapping = true;
  const racedClient: SqlClient = {
    ...racedBase,
    async run(sql, params) {
      if (injectMapping && sql.includes("SET status = 'committing'")) {
        injectMapping = false;
        await createOwnedImportMappingDecisionRepository(racedBase).save(
          "user-a",
          {
            batchId: "batch-a",
            kind: "portfolio",
            sourceKey: "Main",
            normalizedSourceValue: "main",
            targetId: "portfolio-a",
            targetValue: null,
            scope: "batch",
            confidence: "user",
            source: "user",
          },
        );
      }
      return racedBase.run(sql, params);
    },
  };
  const racedResult = await createOwnedImportCommitRepository(
    racedClient,
  ).commit("user-a", "batch-a", input(racedVersion));
  assert.deepEqual(racedResult, { ok: false, reason: "stale_preview" });
  assert.equal(
    (
      raced
        .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
        .get() as { status: string }
    ).status,
    "ready",
  );

  const unmapped = await migratedDatabase();
  stageRows(unmapped, 1);
  unmapped
    .prepare(
      `UPDATE import_rows
       SET target_portfolio_security_id = NULL,
           normalized_fields_json = ?
       WHERE id = 'row-1'`,
    )
    .run(JSON.stringify(normalized(2, { symbol: "NO_MATCH" })));
  const unmappedResult = await createOwnedImportCommitRepository(
    createSqliteSqlClient(unmapped),
  ).commit("user-a", "batch-a", input("irrelevant"));
  assert.deepEqual(unmappedResult, {
    ok: false,
    reason: "revalidation_failed",
  });
});

test("validated row mappings drive per-portfolio postings and real rebuild high-water values", async () => {
  const database = await migratedDatabase();
  stageRows(database, 2);
  const client = createSqliteSqlClient(database);
  const later = await createOwnedLedgerRepository(client).post("user-a", {
    portfolioId: "portfolio-a",
    type: "buy",
    portfolioSecurityId: "membership-a",
    quantityDecimal: "1",
    unitPriceDecimal: "1",
    grossAmountDecimal: null,
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    idempotencyKey: "later-ledger",
    tradeAt: "2026-08-05T00:00:00.000Z",
    localTradeDate: "2026-08-05",
    currencyCode: "AUD",
    requestId: "later-request",
  });
  assert.equal(later.ok, true);
  if (!later.ok) return;
  const mappings = createOwnedImportMappingDecisionRepository(client);
  await mappings.save("user-a", {
    batchId: "batch-a",
    kind: "portfolio",
    sourceKey: "row-2",
    normalizedSourceValue: "main",
    targetId: "portfolio-b",
    targetValue: null,
    scope: "row",
    confidence: "user",
    source: "user",
  });
  await mappings.save("user-a", {
    batchId: "batch-a",
    kind: "security",
    sourceKey: "row-2",
    normalizedSourceValue: "abc|asx|aud",
    targetId: "membership-b",
    targetValue: null,
    scope: "row",
    confidence: "user",
    source: "user",
  });
  const version = await previewVersion(client);
  const committed = await finish(
    createOwnedImportCommitRepository(client, { chunkSize: 2 }),
    input(version),
  );
  assert.equal(committed.rebuildJobIds.length, 2);
  const rows = database
    .prepare(
      `SELECT id, target_portfolio_id, target_portfolio_security_id
       FROM import_rows ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      {
        id: "row-1",
        target_portfolio_id: "portfolio-a",
        target_portfolio_security_id: "membership-a",
      },
      {
        id: "row-2",
        target_portfolio_id: "portfolio-b",
        target_portfolio_security_id: "membership-b",
      },
    ],
  );
  // CALC-004: `finalize` now also queues a sibling `snapshot`-pipeline row
  // per affected portfolio (`pipeline = 'projection'` isolates this test's
  // original per-portfolio projection-rebuild-job assertion below from
  // that addition).
  const jobs = database
    .prepare(
      `SELECT id, portfolio_id, ledger_high_water_start
       FROM calculation_runs WHERE reason = 'import_commit' AND pipeline = 'projection'
       ORDER BY portfolio_id`,
    )
    .all() as Array<Record<string, unknown>>;
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.ledger_high_water_start, later.transaction.id);
  const portfolioBTransaction = database
    .prepare(
      "SELECT id FROM transactions WHERE portfolio_id = 'portfolio-b' AND source_type = 'csv_import'",
    )
    .get() as { id: string };
  assert.equal(jobs[1]?.ledger_high_water_start, portfolioBTransaction.id);

  const calculationRuns = createCalculationRunRepository(client);
  const claimed = await calculationRuns.claim(
    "user-a",
    "portfolio-a",
    String(jobs[0]?.id),
    "worker-a",
    "2026-08-03T02:00:00Z",
    "2026-08-03T01:00:00Z",
  );
  assert.equal(claimed.ok, true);
  const completed = await calculationRuns.complete(
    "user-a",
    "portfolio-a",
    String(jobs[0]?.id),
    "worker-a",
    later.transaction.id,
    "2026-08-03T01:30:00Z",
    0,
    1,
  );
  assert.equal(completed.ok, true);
});

test("one invocation enforces D1 query, statement, and parameter budgets", async () => {
  const database = await migratedDatabase();
  stageRows(database, 2);
  const base = createSqliteSqlClient(database);
  const version = await previewVersion(base);
  let queries = 0;
  let largestBatch = 0;
  let largestStatement = 0;
  const client: SqlClient = {
    async all(sql, params) {
      queries += 1;
      return base.all(sql, params);
    },
    async get(sql, params) {
      queries += 1;
      return base.get(sql, params);
    },
    async run(sql, params) {
      queries += 1;
      return base.run(sql, params);
    },
    async batch(statements) {
      queries += statements.length;
      largestBatch = Math.max(largestBatch, statements.length);
      largestStatement = Math.max(
        largestStatement,
        ...statements.map((statement) => statement.params?.length ?? 0),
      );
      return base.batch!(statements);
    },
  };
  const result = await createOwnedImportCommitRepository(client, {
    chunkSize: IMPORT_COMMIT_LIMITS.maxChunkSize,
  }).commit("user-a", "batch-a", input(version));
  assert.equal(result.ok, true);
  assert.ok(
    queries <= IMPORT_COMMIT_LIMITS.maxQueriesPerInvocation,
    `${queries} queries`,
  );
  assert.ok(largestBatch <= IMPORT_COMMIT_LIMITS.maxStatementsPerChunk);
  assert.ok(largestStatement <= IMPORT_COMMIT_LIMITS.maxParametersPerStatement);
  assert.throws(
    () =>
      createOwnedImportCommitRepository(base, {
        chunkSize: IMPORT_COMMIT_LIMITS.maxChunkSize + 1,
      }),
    /invalid_import_commit_chunk_size/,
  );
});

// CALC-004 review-round B2 REQUIRED regression: a batch touching EXACTLY
// `IMPORT_COMMIT_LIMITS.maxAffectedPortfolios` (25) distinct portfolios --
// the documented ceiling `finalize` itself enforces (`affected.length >
// maxAffectedPortfolios` fails closed) -- must still commit to completion.
// `finalize`'s one atomic `batch()` call emits `2 * affectedCount + 2`
// statements (one `calculation_runs` INSERT per pipeline per affected
// portfolio, plus one audit insert, plus one batch-status UPDATE); at
// N=25 that is exactly 52, which exceeded the ORIGINAL 50-statement
// `maxStatementsPerChunk` bound and made `isBoundedAtomicUnit` reject the
// batch outright every single retry (a real batch touching 25 portfolios
// could never finish committing). Reproduces the reviewer's finding
// directly against the real commit machinery, not just the constant.
test("CALC-004 review-round B2: a commit touching exactly 25 distinct portfolios (the documented ceiling) still commits to completion", async () => {
  const database = await migratedDatabase();
  const PORTFOLIO_COUNT = 25;
  for (let index = 0; index < PORTFOLIO_COUNT; index += 1) {
    database
      .prepare(
        `INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
         VALUES (?, 'user-a', ?, ?, 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1)`,
      )
      .run(`portfolio-n${index}`, `N${index}`, `Portfolio ${index}`);
    database
      .prepare(
        `INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
         VALUES (?, ?, 'equity', 'AUD', 'active', '2026-08-03', '2026-08-03')`,
      )
      .run(`security-n${index}`, `Security ${index}`);
    database
      .prepare(
        `INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
         VALUES (?, 'user-a', ?, ?, ?, 'AUD', 'held', '2026-08-03', '2026-08-03')`,
      )
      .run(
        `membership-n${index}`,
        `portfolio-n${index}`,
        `security-n${index}`,
        `SYM${index}`,
      );
  }
  const rowInsert = database.prepare(
    `INSERT INTO import_rows (
       id, user_id, batch_id, physical_row_number, row_class,
       original_fields_json, normalized_fields_json, normalized_fingerprint,
       validation_status, target_portfolio_id, target_portfolio_security_id,
       commit_status, created_at, updated_at, version
     ) VALUES (?, 'user-a', 'batch-a', ?, 'transaction', '[]', ?, ?, 'valid', ?, ?,
       'staged', '2026-08-03', '2026-08-03', 1)`,
  );
  for (let index = 0; index < PORTFOLIO_COUNT; index += 1) {
    const rowNumber = index + 2;
    rowInsert.run(
      `row-n${index}`,
      rowNumber,
      JSON.stringify(
        normalized(rowNumber, {
          symbol: `SYM${index}`,
          name: `Security ${index}`,
        }),
      ),
      `fingerprint-n${index}`,
      `portfolio-n${index}`,
      `membership-n${index}`,
    );
  }
  const client = createSqliteSqlClient(database);
  const version = await previewVersion(client);
  const repository = createOwnedImportCommitRepository(client, {
    chunkSize: IMPORT_COMMIT_LIMITS.maxChunkSize,
  });
  const result = await finish(repository, input(version));
  assert.equal(result.status, "committed");
  assert.equal(result.committedRows, PORTFOLIO_COUNT);

  const runCount = database
    .prepare(
      `SELECT COUNT(*) AS count FROM calculation_runs WHERE reason = 'import_commit'`,
    )
    .get() as { count: number };
  // CALC-004 queued one row per pipeline (projection + snapshot) per
  // affected portfolio here; CALC-005 retired the snapshot pipeline
  // entirely (see docs/ARCHITECTURE.md's CALC-005 entry), so this is back
  // to one projection-pipeline row per portfolio.
  assert.equal(runCount.count, PORTFOLIO_COUNT);
  const pipelines = database
    .prepare(
      `SELECT DISTINCT pipeline FROM calculation_runs WHERE reason = 'import_commit' ORDER BY pipeline`,
    )
    .all() as Array<{ pipeline: string }>;
  assert.deepEqual(
    pipelines.map((row) => row.pipeline),
    ["projection"],
  );
});

test("atomic rollback, duplicate-file reuse, idempotency, ownership, and confirmation fail closed", async () => {
  const database = await migratedDatabase();
  stageRows(database, 2);
  database.exec(
    "UPDATE import_rows SET normalized_fingerprint = 'fingerprint-1' WHERE id = 'row-2'",
  );
  const base = createSqliteSqlClient(database);
  const version = await previewVersion(base);
  let fail = true;
  const failing: SqlClient = {
    ...base,
    async batch(statements) {
      if (fail) {
        fail = false;
        throw new Error("injected D1 failure");
      }
      return base.batch!(statements);
    },
  };
  const failed = await createOwnedImportCommitRepository(failing).commit(
    "user-a",
    "batch-a",
    input(version),
  );
  assert.deepEqual(failed, {
    ok: false,
    reason: "atomic_failure",
    resumable: true,
  });
  assert.equal(
    (
      database.prepare("SELECT count(*) AS count FROM transactions").get() as {
        count: number;
      }
    ).count,
    0,
  );
  await assert.rejects(
    createOwnedImportMappingDecisionRepository(base).save("user-a", {
      batchId: "batch-a",
      kind: "portfolio",
      sourceKey: "Main",
      normalizedSourceValue: "main",
      targetId: "portfolio-a",
      targetValue: null,
      scope: "batch",
      confidence: "user",
      source: "user",
    }),
    /import_mapping_batch_not_mutable/,
  );
  const committed = await finish(
    createOwnedImportCommitRepository(base),
    input(version),
  );
  assert.equal(committed.committedRows, 1);
  assert.equal(committed.skippedRows, 1);
  const reused = await createOwnedImportStagingRepository(base).startUpload(
    "user-a",
    {
      targetPortfolioId: "portfolio-a",
      parserFormat: "strict-versioned-csv",
      parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
      filename: "same-again.csv",
      byteSize: 100,
      fileSha256: "file-a",
    },
  );
  if (!reused.ok) throw new Error("expected duplicate upload to be reusable");
  assert.equal(reused.reused, true);
  assert.equal(reused.batch.id, committed.batchId);
  const retry = await createOwnedImportCommitRepository(base).commit(
    "user-a",
    "batch-a",
    input("stale-is-ignored-after-commit"),
  );
  assert.equal(retry.ok, true);
  if (retry.ok) assert.equal(retry.idempotent, true);
  const conflict = await createOwnedImportCommitRepository(base).commit(
    "user-a",
    "batch-a",
    input("ignored", "different-key"),
  );
  assert.deepEqual(conflict, { ok: false, reason: "conflict" });
  const otherOwner = await createOwnedImportCommitRepository(base).commit(
    "user-b",
    "batch-a",
    input(version, "other-owner"),
  );
  assert.deepEqual(otherOwner, { ok: false, reason: "not_found" });
  const invalidKey = await createOwnedImportCommitRepository(base).commit(
    "user-a",
    "batch-a",
    input(version, ""),
  );
  assert.deepEqual(invalidKey, {
    ok: false,
    reason: "invalid_idempotency_key",
  });
  const notConfirmed = await createOwnedImportCommitRepository(base).commit(
    "user-a",
    "batch-a",
    { ...input(version), confirmation: false },
  );
  assert.deepEqual(notConfirmed, {
    ok: false,
    reason: "confirmation_required",
  });
});

test("commit route rejects cross-site mutation before authentication or parsing", async () => {
  const response = rejectCrossSiteMutation(
    new Request("https://yield.example/api/import/commit/batch-a", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    }),
  );
  assert.ok(response);
  assert.equal(response.status, 403);
});
