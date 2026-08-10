import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createD1SqlClient } from "../db/d1-sql-client.ts";
import type { VerifiedAccessPrincipal } from "../domain/auth/access-jwt.ts";
import { createIdentityLifecycleService } from "../domain/auth/identity-lifecycle.ts";
import {
  parseStrictVersionedCsvImport,
  SUPPORTED_IMPORT_HEADER,
  SUPPORTED_IMPORT_PARSER_VERSION,
} from "../domain/imports/index.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedLedgerRepository,
  createOwnedManualOverrideRepository,
  createOwnedPortfolioRepository,
  createMarketDataRefreshRepository,
  type ImportCommitInput,
  type ImportCommitResult,
  type SqlClient,
} from "../db/repositories/index.ts";

// QA-003: repository write paths were converted from SQL-level
// `BEGIN IMMEDIATE TRANSACTION`/`COMMIT`/`ROLLBACK` (which Cloudflare D1
// rejects outright) to D1's `batch()` API. `node:sqlite`-backed tests cannot
// catch that class of regression because the sqlite test client tolerates
// SQL transaction control. This drill runs the same write paths against a
// real Miniflare/workerd D1 database so the BEGIN incompatibility — and the
// atomicity the batch() conversion must preserve — cannot silently regress.
//
// Requires a loopback Miniflare binding, which some sandboxes block; run
// with QA003_D1_DRILL=1 where a listening socket is permitted.

function drizzleMigrationStatements(migrationSql: string): string[] {
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function freshRebuildSourceTable(statement: string): string | null {
  const match = statement.match(
    /\bINSERT INTO `__new_[A-Za-z0-9_]+`[\s\S]+ FROM `([A-Za-z0-9_]+)`;?\s*$/,
  );
  return match?.[1] ?? null;
}

async function applyDrizzleMigrationToD1(
  database: D1Database,
  migrationSql: string,
): Promise<void> {
  for (const statement of drizzleMigrationStatements(migrationSql)) {
    const rebuildSource = freshRebuildSourceTable(statement);
    if (rebuildSource) {
      const source = await database
        .prepare(`SELECT COUNT(*) AS count FROM "${rebuildSource}"`)
        .first<{ count: number }>();
      if (Number(source?.count ?? -1) !== 0) {
        throw new Error(`d1_drill_rebuild_source_not_empty:${rebuildSource}`);
      }
      continue;
    }
    await database.prepare(statement).run();
  }
}

async function migrateD1(database: D1Database): Promise<void> {
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  for (const file of files) {
    await applyDrizzleMigrationToD1(
      database,
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
}

async function seedFixture(database: D1Database): Promise<void> {
  const statements = [
    `INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
     VALUES ('AUD', 36, 'Australian dollar', 2, 1)`,
    `INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
     VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-10', '2026-08-10', 1)`,
    `INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
     VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-10', '2026-08-10', 1)`,
    `INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
     VALUES ('portfolio-a', 'user-a', 'A', 'Aus Super', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-10', '2026-08-10', 1)`,
    `INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
     VALUES ('security-a', 'Isglhltca Etf Units', 'equity', 'AUD', 'active', '2026-08-10', '2026-08-10')`,
    `INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
     VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'IXJ.AX', 'ASX', 'AUD', 'held', '2026-08-10', '2026-08-10')`,
    `INSERT INTO market_data_providers (id, code, name, capabilities_json, rate_limit_json)
     VALUES ('provider-a', 'provider-a', 'Provider A', '{}', '{}')`,
    `INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
     VALUES ('mapping-a', 'security-a', 'provider-a', 'ASX', 'IXJ.AX', '2026-01-01', 'verified')`,
  ];
  for (const sql of statements) {
    await database.prepare(sql).run();
  }
}

async function stageImportBatch(
  database: D1Database,
  batchId: string,
  rowCount: number,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO import_batches (
         id, user_id, target_portfolio_id, parser_format, parser_version,
         filename, byte_size, file_sha256, status, created_at, updated_at, version
       ) VALUES (?, 'user-a', 'portfolio-a', 'strict-versioned-csv', ?,
         'sample.csv', 100, ?, 'ready', '2026-08-10', '2026-08-10', 1)`,
    )
    .bind(batchId, SUPPORTED_IMPORT_PARSER_VERSION, `hash-${batchId}`)
    .run();
  const normalized = (index: number) =>
    JSON.stringify({
      id: `source-${index}`,
      symbol: "IXJ.AX",
      name: "Isglhltca Etf Units",
      displaySymbol: null,
      exchange: "ASX",
      portfolio: "Aus Super",
      currency: "AUD",
      sharesOwned: "1",
      costPerShare: "10",
      commission: "0",
      transactionDate: "2026-08-01 GMT+1000",
      transactionTime: `10:00:${String(index).padStart(2, "0")}`,
      purchaseExchangeRate: null,
      type: "buy",
      accounting: "fifo",
      accountingExecutionIds: null,
      notes: null,
      tradeAtUtc: `2026-08-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      localTradeDate: "2026-08-01",
      cashEvent: null,
    });
  for (let index = 0; index < rowCount; index += 1) {
    await database
      .prepare(
        `INSERT INTO import_rows (
           id, user_id, batch_id, physical_row_number, row_class,
           original_fields_json, normalized_fields_json, normalized_fingerprint,
           validation_status, target_portfolio_id, target_portfolio_security_id,
           commit_status, created_at, updated_at, version
         ) VALUES (?, 'user-a', ?, ?, 'transaction', '[]', ?, ?, 'valid',
           'portfolio-a', 'membership-a', 'staged', '2026-08-10', '2026-08-10', 1)`,
      )
      .bind(
        `row-${batchId}-${index + 1}`,
        batchId,
        index + 2,
        normalized(index + 2),
        `fingerprint-${batchId}-${index + 1}`,
      )
      .run();
  }
}

function principal(subject: string, email: string): VerifiedAccessPrincipal {
  return {
    issuer: "https://team.cloudflareaccess.com",
    audience: "portfolio-audience",
    subject,
    email,
    tokenType: "app",
    issuedAt: 1,
    notBefore: 1,
    expiresAt: 2_000,
    keyId: "key",
  };
}

test("write paths execute atomically via D1 batch() with the local-dev BEGIN shim removed", async (context) => {
  if (process.env.QA003_D1_DRILL !== "1") {
    context.skip("set QA003_D1_DRILL=1 where loopback Miniflare is permitted");
    return;
  }

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "qa-003-drill" },
  });
  try {
    const d1 = await miniflare.getD1Database("DB");
    await migrateD1(d1);
    await seedFixture(d1);
    const client: SqlClient = createD1SqlClient(d1);

    // No repository here (or anywhere in db/repositories, domain/auth) may
    // issue SQL-level transaction control; D1 rejects it outright.
    const originalRun = client.run.bind(client);
    const observedSql: string[] = [];
    const observingClient: SqlClient = {
      ...client,
      run: (sql, params) => {
        observedSql.push(sql);
        return originalRun(sql, params);
      },
      batch: (statements) => {
        for (const statement of statements) observedSql.push(statement.sql);
        return client.batch(statements);
      },
    };

    // 1. owned-portfolios.ts: create()/rename() batch conversion.
    const portfolios = createOwnedPortfolioRepository(
      observingClient,
      () => "2026-08-10T09:00:00Z",
    );
    const created = await portfolios.create("user-a", {
      id: "portfolio-b",
      code: "B",
      name: "Second Portfolio",
      timezone: "Australia/Sydney",
    });
    assert.ok(created);
    const renamed = await portfolios.rename("user-a", "portfolio-b", {
      expectedVersion: 1,
      name: "Renamed Portfolio",
    });
    assert.equal(renamed.ok, true);

    // 2. identity-lifecycle.ts: provision then touch via batch.
    const identity = createIdentityLifecycleService(observingClient, {
      now: () => "2026-08-10T09:05:00Z",
      requestId: "qa-003-identity",
    });
    const provisioned = await identity.resolve(
      principal("subject-new", "new@example.com"),
    );
    assert.equal(provisioned.ok, true);
    if (provisioned.ok) assert.equal(provisioned.provisioned, true);
    const touched = await identity.resolve(
      principal("subject-new", "new@example.com"),
    );
    assert.equal(touched.ok, true);
    if (touched.ok) assert.equal(touched.provisioned, false);

    // 3. ledger.ts: post() atomic() conversion.
    const ledger = createOwnedLedgerRepository(observingClient);
    const posted = await ledger.post("user-a", {
      portfolioId: "portfolio-a",
      type: "buy",
      portfolioSecurityId: "membership-a",
      quantityDecimal: "5",
      unitPriceDecimal: "10",
      grossAmountDecimal: null,
      feeAmountDecimal: "0",
      taxAmountDecimal: "0",
      fxRateToBaseDecimal: null,
      sourceType: "manual",
      idempotencyKey: "qa-003-ledger",
      tradeAt: "2026-08-01T00:00:00.000Z",
      localTradeDate: "2026-08-01",
      currencyCode: "AUD",
      requestId: "qa-003-ledger-request",
    });
    assert.equal(posted.ok, true);

    // 4. market-data.ts: manual override save() atomic() conversion.
    const overrides = createOwnedManualOverrideRepository(
      observingClient,
      () => "2026-08-10T09:10:00Z",
    );
    const saved = await overrides.save("user-a", {
      portfolioId: "portfolio-a",
      securityId: null,
      type: "price",
      targetKey: "security-a",
      effectiveFrom: "2026-08-01",
      effectiveTo: "2026-08-10",
      valueJson: '{"closeDecimal":"12.50","currencyCode":"AUD"}',
      reason: "Manual correction",
      requestId: "qa-003-override",
    });
    assert.equal(saved.ok, true);

    // 5. market-data-refresh.ts: request() runAtomicBatch() conversion.
    const refresh = createMarketDataRefreshRepository(observingClient);
    const job = await refresh.request({
      id: "qa-003-refresh-job",
      providerId: "provider-a",
      targetKind: "price",
      targetKey: "mapping-a",
      mappingId: "mapping-a",
      securityId: "security-a",
      scope: { kind: "deployment", userId: null },
      rangeFrom: "2026-07-29",
      rangeTo: "2026-07-30",
      chunkDays: 1,
      idempotencyKey: "qa-003-refresh",
      now: "2026-08-10T09:15:00Z",
    });
    assert.equal(job.status, "queued");

    // 6. import-staging.ts: persistParsedResult() against the real
    // Example_Portfolio.csv evidence file (244 data rows). Chunking was
    // removed from this path — persistParsedResult now issues one guarded
    // INSERT per parsed row/issue (guarded on the batch's pre-state) plus
    // one closing UPDATE, all in a single D1 batch() call (see
    // docs/DATA_MODEL.md's "Guard-conditional single batch" note). This case
    // exercises that large single atomic batch — several hundred statements
    // in one batch() call — through the guard-conditional design against
    // real D1, not just a trivial one- or two-row case.
    const exampleCsv = await readFile(
      new URL("../docs/Example_Portfolio.csv", import.meta.url),
      "utf8",
    );
    const parseResult = await parseStrictVersionedCsvImport(exampleCsv);
    assert.equal(parseResult.ok, true);
    if (!parseResult.ok) return;
    assert.ok(
      parseResult.rows.length > 50,
      "expected the example file to exercise a large single atomic batch",
    );

    const staging = createOwnedImportStagingRepository(
      observingClient,
      () => "2026-08-10T09:20:00Z",
    );
    const started = await staging.startUpload("user-a", {
      id: "example-batch",
      targetPortfolioId: "portfolio-a",
      parserFormat: "strict-versioned-csv",
      parserVersion: parseResult.parserVersion,
      filename: "Example_Portfolio.csv",
      byteSize: Buffer.byteLength(exampleCsv),
      fileSha256: parseResult.fileFingerprint,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    const recorded = await staging.recordParseResult(
      "user-a",
      started.batch.id,
      { expectedVersion: started.batch.version, parseResult },
    );
    assert.equal(recorded.ok, true);
    if (!recorded.ok) return;
    assert.equal(recorded.rowsInserted, parseResult.rows.length);
    const persistedRows = await d1
      .prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE batch_id = 'example-batch'",
      )
      .first<{ count: number }>();
    assert.equal(Number(persistedRows?.count), parseResult.rows.length);
    const finalBatch = await staging.get("user-a", started.batch.id);
    assert.ok(finalBatch);
    assert.equal(finalBatch?.totalRows, parseResult.summary.totalRows);

    // 7. import-commit.ts / import-reversal.ts: atomic() conversion, plus
    // the chunked resumable commit/reversal state machine, on a small
    // synthetic batch (kept small because MAX_CHUNK_SIZE=2 means a
    // 244-row commit would need over 100 sequential invocations).
    await stageImportBatch(d1, "small-batch", 4);
    const commitRepo = createOwnedImportCommitRepository(observingClient);
    const validated = await commitRepo.validate("user-a", "small-batch");
    assert.equal(validated.ok, true);
    if (!validated.ok) return;
    const commitInput: ImportCommitInput = {
      expectedVersion: 1,
      expectedPreviewVersion: validated.previewVersion,
      idempotencyKey: "qa-003-commit",
      confirmation: true,
      requestId: "qa-003-commit-request",
    };
    let commitResult: ImportCommitResult = await commitRepo.commit(
      "user-a",
      "small-batch",
      commitInput,
    );
    for (
      let attempt = 0;
      attempt < 10 && (!commitResult.ok || commitResult.status !== "committed");
      attempt += 1
    ) {
      assert.equal(commitResult.ok, true);
      commitResult = await commitRepo.commit(
        "user-a",
        "small-batch",
        commitInput,
      );
    }
    assert.equal(commitResult.ok, true);
    if (!commitResult.ok) return;
    assert.equal(commitResult.status, "committed");
    assert.equal(commitResult.committedRows, 4);

    const committedBatch = await staging.get("user-a", "small-batch");
    assert.ok(committedBatch);
    const reversalRepo = createOwnedImportReversalRepository(observingClient);
    let reversed = await reversalRepo.reverse("user-a", "small-batch", {
      expectedVersion: committedBatch!.version,
      idempotencyKey: "qa-003-reverse",
      confirmation: true,
      requestId: "qa-003-reverse-request",
    });
    for (
      let attempt = 0;
      attempt < 10 && (!reversed.ok || reversed.status !== "reversed");
      attempt += 1
    ) {
      assert.equal(reversed.ok, true);
      reversed = await reversalRepo.reverse("user-a", "small-batch", {
        expectedVersion: committedBatch!.version,
        idempotencyKey: "qa-003-reverse",
        confirmation: true,
        requestId: "qa-003-reverse-request",
      });
    }
    assert.equal(reversed.ok, true);
    if (reversed.ok) assert.equal(reversed.status, "reversed");

    // No `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` ever reached the D1 client —
    // every multi-statement write above executed through `batch()`.
    assert.equal(
      observedSql.some((sql) =>
        /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql),
      ),
      false,
    );
  } finally {
    await miniflare.dispose();
  }
});

function smallCsv(): string {
  return [
    SUPPORTED_IMPORT_HEADER.join(","),
    `"1","IXJ.AX","Isglhltca Etf Units",,"ASX","Aus Super","AUD",,,,,,,,,,`,
    `"2","IXJ.AX","Isglhltca Etf Units",,"ASX","Aus Super","AUD","3","12.50","0","2026-08-01 GMT+1000","10:00:00",,"Buy",,,"note"`,
  ].join("\n");
}

// QA-003 B4(a): against real Miniflare/workerd D1, a stale `expectedVersion`
// passed to `persistParsedResult` (via `recordParseResult`) must leave the
// atomic batch untouched — zero rows/issues persisted, batch status/version
// unchanged — and the same batch must remain retryable with the correct
// version afterward.
test("stale expectedVersion on persistParsedResult persists nothing against real D1", async (context) => {
  if (process.env.QA003_D1_DRILL !== "1") {
    context.skip("set QA003_D1_DRILL=1 where loopback Miniflare is permitted");
    return;
  }

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "qa-003-stale-version-drill" },
  });
  try {
    const d1 = await miniflare.getD1Database("DB");
    await migrateD1(d1);
    await seedFixture(d1);
    const client: SqlClient = createD1SqlClient(d1);
    const staging = createOwnedImportStagingRepository(
      client,
      () => "2026-08-10T09:00:00Z",
    );

    const csv = smallCsv();
    const parseResult = await parseStrictVersionedCsvImport(csv);
    assert.equal(parseResult.ok, true);
    if (!parseResult.ok) return;

    const started = await staging.startUpload("user-a", {
      id: "stale-version-batch",
      targetPortfolioId: "portfolio-a",
      parserFormat: "strict-versioned-csv",
      parserVersion: parseResult.parserVersion,
      filename: "stale-version.csv",
      byteSize: Buffer.byteLength(csv),
      fileSha256: parseResult.fileFingerprint,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const staleResult = await staging.recordParseResult(
      "user-a",
      started.batch.id,
      { expectedVersion: started.batch.version + 1, parseResult },
    );
    assert.equal(staleResult.ok, false);
    if (staleResult.ok) return;
    assert.equal(staleResult.reason, "version_conflict");

    const persistedRows = await d1
      .prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE batch_id = 'stale-version-batch'",
      )
      .first<{ count: number }>();
    assert.equal(Number(persistedRows?.count), 0);
    const persistedIssues = await d1
      .prepare(
        "SELECT COUNT(*) AS count FROM import_issues WHERE batch_id = 'stale-version-batch'",
      )
      .first<{ count: number }>();
    assert.equal(Number(persistedIssues?.count), 0);

    const unchangedBatch = await staging.get("user-a", started.batch.id);
    assert.ok(unchangedBatch);
    assert.equal(unchangedBatch?.status, "uploaded");
    assert.equal(unchangedBatch?.version, started.batch.version);

    const retried = await staging.recordParseResult(
      "user-a",
      started.batch.id,
      { expectedVersion: started.batch.version, parseResult },
    );
    assert.equal(retried.ok, true);
  } finally {
    await miniflare.dispose();
  }
});

// QA-003 B4(c): against real Miniflare/workerd D1, if any statement in
// `persistParsedResult`'s single atomic `batch()` call fails, D1's batch()
// semantics roll back every statement issued in that call, so nothing
// persists — not even the guarded inserts that would otherwise have
// succeeded. Simulated by wrapping the D1 client so the exact batch call
// made by `persistParsedResult` has one guaranteed-to-fail statement
// (violates a NOT NULL constraint) appended to it before it reaches D1.
test("a mid-batch statement failure persists nothing against real D1", async (context) => {
  if (process.env.QA003_D1_DRILL !== "1") {
    context.skip("set QA003_D1_DRILL=1 where loopback Miniflare is permitted");
    return;
  }

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "qa-003-mid-batch-failure-drill" },
  });
  try {
    const d1 = await miniflare.getD1Database("DB");
    await migrateD1(d1);
    await seedFixture(d1);
    const baseClient: SqlClient = createD1SqlClient(d1);
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
    const staging = createOwnedImportStagingRepository(
      injectingClient,
      () => "2026-08-10T09:00:00Z",
    );

    const csv = smallCsv();
    const parseResult = await parseStrictVersionedCsvImport(csv);
    assert.equal(parseResult.ok, true);
    if (!parseResult.ok) return;

    const started = await staging.startUpload("user-a", {
      id: "mid-batch-failure-batch",
      targetPortfolioId: "portfolio-a",
      parserFormat: "strict-versioned-csv",
      parserVersion: parseResult.parserVersion,
      filename: "mid-batch-failure.csv",
      byteSize: Buffer.byteLength(csv),
      fileSha256: parseResult.fileFingerprint,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const recorded = await staging.recordParseResult(
      "user-a",
      started.batch.id,
      { expectedVersion: started.batch.version, parseResult },
    );
    assert.equal(recorded.ok, false);
    if (recorded.ok) return;
    assert.equal(recorded.reason, "atomic_failure");

    const persistedRows = await d1
      .prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE batch_id = 'mid-batch-failure-batch'",
      )
      .first<{ count: number }>();
    assert.equal(Number(persistedRows?.count), 0);

    const verifyStaging = createOwnedImportStagingRepository(baseClient);
    const unchangedBatch = await verifyStaging.get("user-a", started.batch.id);
    assert.ok(unchangedBatch);
    assert.equal(unchangedBatch?.status, "uploaded");
    assert.equal(unchangedBatch?.version, started.batch.version);
  } finally {
    await miniflare.dispose();
  }
});

const PARSE_RESULT_PRECHECK_SQL =
  "SELECT id, status, version FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1";

/**
 * Wraps a D1-backed `SqlClient` so that the FIRST time `persistParsedResult`'s
 * version/status pre-check `get()` runs, a concurrent writer's own
 * `uploaded -> failed` version bump is applied directly against D1 strictly
 * AFTER that pre-check read returns but BEFORE the repository's `batch()`
 * call executes. QA-003 B1: the guarded child inserts must key off the
 * PRE-state (this call's own expectedVersion/status), not any post-bump
 * version — otherwise this exact race lets a concurrent writer's bump
 * independently satisfy a guard written against the post-bump value, so
 * rows/issues persist into a batch whose state this call never wrote, even
 * though its own closing UPDATE no-ops.
 */
function createConcurrentBumpD1Client(
  baseClient: SqlClient,
  d1: D1Database,
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
        await d1
          .prepare(
            `UPDATE import_batches
             SET status = 'failed', failure_category = 'concurrent_writer',
                 updated_at = ?, version = version + 1
             WHERE id = ?`,
          )
          .bind("2026-08-10T09:00:01Z", batchId)
          .run();
      }
      return result;
    },
  };
}

// QA-003 B1/B2: against real Miniflare/workerd D1, a concurrent writer's
// version bump landing strictly between `persistParsedResult`'s pre-check
// read and its atomic `batch()` call must make the ENTIRE call a no-op —
// zero rows, zero issues, `version_conflict` — for the parsed-rows
// (success) path. The stale-`expectedVersion` test above cannot exercise
// this: it is rejected by the pre-check before any batch is issued.
test("a concurrent uploaded->failed bump between the pre-check and the atomic batch blocks every guarded insert against real D1 (parsed rows)", async (context) => {
  if (process.env.QA003_D1_DRILL !== "1") {
    context.skip("set QA003_D1_DRILL=1 where loopback Miniflare is permitted");
    return;
  }

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "qa-003-concurrent-bump-rows-drill" },
  });
  try {
    const d1 = await miniflare.getD1Database("DB");
    await migrateD1(d1);
    await seedFixture(d1);
    const baseClient: SqlClient = createD1SqlClient(d1);
    const setupStaging = createOwnedImportStagingRepository(baseClient);

    const csv = smallCsv();
    const parseResult = await parseStrictVersionedCsvImport(csv);
    assert.equal(parseResult.ok, true);
    if (!parseResult.ok) return;

    const started = await setupStaging.startUpload("user-a", {
      id: "concurrent-bump-rows-batch",
      targetPortfolioId: "portfolio-a",
      parserFormat: "strict-versioned-csv",
      parserVersion: parseResult.parserVersion,
      filename: "concurrent-bump-rows.csv",
      byteSize: Buffer.byteLength(csv),
      fileSha256: parseResult.fileFingerprint,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const injectingClient = createConcurrentBumpD1Client(
      baseClient,
      d1,
      started.batch.id,
    );
    const staging = createOwnedImportStagingRepository(
      injectingClient,
      () => "2026-08-10T09:00:00Z",
    );

    const recorded = await staging.recordParseResult(
      "user-a",
      started.batch.id,
      { expectedVersion: started.batch.version, parseResult },
    );
    assert.equal(recorded.ok, false);
    if (recorded.ok) return;
    assert.equal(recorded.reason, "version_conflict");

    const persistedRows = await d1
      .prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE batch_id = 'concurrent-bump-rows-batch'",
      )
      .first<{ count: number }>();
    assert.equal(Number(persistedRows?.count), 0);
    const persistedIssues = await d1
      .prepare(
        "SELECT COUNT(*) AS count FROM import_issues WHERE batch_id = 'concurrent-bump-rows-batch'",
      )
      .first<{ count: number }>();
    assert.equal(Number(persistedIssues?.count), 0);

    const finalBatch = await setupStaging.get("user-a", started.batch.id);
    assert.ok(finalBatch);
    assert.equal(finalBatch?.status, "failed");
    assert.equal(finalBatch?.failureCategory, "concurrent_writer");
    assert.equal(finalBatch?.version, started.batch.version + 1);
  } finally {
    await miniflare.dispose();
  }
});

// QA-003 B1/B2: same race as above, against real D1, exercised on the
// parse-FAILURE (batch-level issues) path — this path has no unique-index
// safety net at all, so a mis-guarded insert here would silently persist
// issue rows into a batch a concurrent writer already moved on from.
test("a concurrent uploaded->failed bump between the pre-check and the atomic batch blocks every guarded insert against real D1 (parse-failure issues)", async (context) => {
  if (process.env.QA003_D1_DRILL !== "1") {
    context.skip("set QA003_D1_DRILL=1 where loopback Miniflare is permitted");
    return;
  }

  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "qa-003-concurrent-bump-issues-drill" },
  });
  try {
    const d1 = await miniflare.getD1Database("DB");
    await migrateD1(d1);
    await seedFixture(d1);
    const baseClient: SqlClient = createD1SqlClient(d1);
    const setupStaging = createOwnedImportStagingRepository(baseClient);

    const csv = [
      "Id,Symbol,Name,Display Symbol,Exchange,Portfolio,Currency,Shares Owned,Cost Per Share,Commission,Transaction Date,Transaction Time,Purchase Exchange Rate,Type,Accounting,Accounting Execution Ids,Extra",
      `"1","IXJ.AX","Isglhltca Etf Units",,"ASX","Aus Super","AUD",,,,,,,,,,`,
    ].join("\n");
    const parseResult = await parseStrictVersionedCsvImport(csv);
    assert.equal(parseResult.ok, false);
    if (parseResult.ok) return;

    const started = await setupStaging.startUpload("user-a", {
      id: "concurrent-bump-issues-batch",
      parserFormat: "strict-versioned-csv",
      parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
      filename: "concurrent-bump-issues.csv",
      byteSize: Buffer.byteLength(csv),
      fileSha256: parseResult.fileFingerprint,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;

    const injectingClient = createConcurrentBumpD1Client(
      baseClient,
      d1,
      started.batch.id,
    );
    const staging = createOwnedImportStagingRepository(
      injectingClient,
      () => "2026-08-10T09:00:00Z",
    );

    const recorded = await staging.recordParseResult(
      "user-a",
      started.batch.id,
      { expectedVersion: started.batch.version, parseResult },
    );
    assert.equal(recorded.ok, false);
    if (recorded.ok) return;
    assert.equal(recorded.reason, "version_conflict");

    const persistedRows = await d1
      .prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE batch_id = 'concurrent-bump-issues-batch'",
      )
      .first<{ count: number }>();
    assert.equal(Number(persistedRows?.count), 0);
    const persistedIssues = await d1
      .prepare(
        "SELECT COUNT(*) AS count FROM import_issues WHERE batch_id = 'concurrent-bump-issues-batch'",
      )
      .first<{ count: number }>();
    assert.equal(Number(persistedIssues?.count), 0);

    const finalBatch = await setupStaging.get("user-a", started.batch.id);
    assert.ok(finalBatch);
    assert.equal(finalBatch?.status, "failed");
    assert.equal(finalBatch?.failureCategory, "concurrent_writer");
    assert.equal(finalBatch?.version, started.batch.version + 1);
  } finally {
    await miniflare.dispose();
  }
});
