import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Miniflare } from "miniflare";
import type { VerifiedAccessPrincipal } from "../domain/auth/access-jwt.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import { createAccountLifecycleService } from "../domain/auth/account-lifecycle.ts";
import {
  ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS,
  createAccountLifecycleRepository,
  createSqliteSqlClient,
  isD1ReservedTable,
} from "../db/repositories/index.ts";
import { createD1SqlClient } from "../db/d1-sql-client.ts";
import {
  authorizeExportJobRequest,
  parseExportRecoveryCredentials,
} from "../app/export-recovery-request.ts";
import { rejectCrossSiteMutation } from "../app/mutation-request.ts";

async function createMigratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    database.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits)
    VALUES ('AUD', 36, 'Australian dollar', 2), ('USD', 840, 'US dollar', 2);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at)
    VALUES
      ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
      ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');
    INSERT INTO user_identities (id, user_id, issuer, subject, email_at_link, last_authenticated_at, created_at, updated_at)
    VALUES
      ('identity-a', 'user-a', 'https://team.cloudflareaccess.com', 'subject-a', 'a@example.com', NULL, '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z'),
      ('identity-b', 'user-b', 'https://team.cloudflareaccess.com', 'subject-b', 'b@example.com', NULL, '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');
    INSERT INTO market_data_providers (id, code, name, capabilities_json, rate_limit_json)
    VALUES ('provider-a', 'provider-a', 'Provider A', '{}', '{}');
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, created_at, updated_at)
    VALUES ('security-a', 'equity', 'AUD', 'Security A', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status, verified_by_user_id, verified_at)
    VALUES ('mapping-a', 'security-a', 'provider-a', 'ASX', 'AAA.AX', '2026-01-01', 'verified', 'user-a', '2026-08-09T00:00:00Z');
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES ('price-a', 'provider-a', 'user', 'user-a', 'user-a', 'mapping-a', 'security-a', 'eod', '2026-08-08T00:00:00Z', '2026-08-08', 'Australia/Sydney', 'AUD', '123.45', 'raw', 'observed', '2026-08-09T00:00:00Z');
    INSERT INTO fx_rate_observations (id, provider_id, access_scope, scope_user_id, scope_key, base_currency_code, quote_currency_code, rate_decimal, interval, observed_at, market_date, quality, ingested_at)
    VALUES ('fx-a', 'provider-a', 'user', 'user-a', 'user-a', 'AUD', 'USD', '0.66', 'eod', '2026-08-08T00:00:00Z', '2026-08-08', 'observed', '2026-08-09T00:00:00Z');
    INSERT INTO market_data_refresh_jobs (id, provider_id, target_kind, target_key, mapping_id, security_id, access_scope, scope_user_id, scope_key, range_from, range_to, next_attempt_at, idempotency_key, created_at, updated_at)
    VALUES ('refresh-a', 'provider-a', 'price', 'mapping-a', 'mapping-a', 'security-a', 'user', 'user-a', 'user-a', '2026-08-08', '2026-08-08', '2026-08-09T00:00:00Z', 'refresh-a', '2026-08-09T00:00:00Z', '2026-08-09T00:00:00Z');
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES ('price-b', 'provider-a', 'user', 'user-b', 'user-b', 'mapping-a', 'security-a', 'eod', '2026-08-08T00:00:00Z', '2026-08-08', 'Australia/Sydney', 'AUD', '999.99', 'raw', 'observed', '2026-08-09T00:00:00Z');
    INSERT INTO fx_rate_observations (id, provider_id, access_scope, scope_user_id, scope_key, base_currency_code, quote_currency_code, rate_decimal, interval, observed_at, market_date, quality, ingested_at)
    VALUES ('fx-b', 'provider-a', 'user', 'user-b', 'user-b', 'AUD', 'USD', '9.99', 'eod', '2026-08-08T00:00:00Z', '2026-08-08', 'observed', '2026-08-09T00:00:00Z');
    INSERT INTO portfolios (id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at,version)
    VALUES ('portfolio-a','user-a','A','Owner A','AUD','Australia/Sydney','fifo','active','2026-08-09','2026-08-09',1),
           ('portfolio-b','user-b','B','Owner B','AUD','Australia/Sydney','fifo','active','2026-08-09','2026-08-09',1);
    INSERT INTO portfolio_securities (id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at)
    VALUES ('holding-a','user-a','portfolio-a','security-a','AAA','AUD','held','2026-08-09','2026-08-09');
    INSERT INTO transactions (id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at)
    VALUES ('transaction-a','user-a','portfolio-a','holding-a','buy','posted','2026-08-09T00:00:00Z','2026-08-09','2','10','AUD','20','0','0','manual','user-a',1,'2026-08-09');
    INSERT INTO cash_accounts (id,user_id,portfolio_id,currency_code,completeness,status)
    VALUES ('cash-a','user-a','portfolio-a','AUD','complete','active');
    INSERT INTO cash_ledger_entries (id,user_id,portfolio_id,cash_account_id,transaction_id,effective_at,local_effective_date,type,signed_amount_decimal,status,created_at)
    VALUES ('cash-entry-a','user-a','portfolio-a','cash-a','transaction-a','2026-08-09T00:00:00Z','2026-08-09','cash_withdrawal','-20','posted','2026-08-09');
    INSERT INTO calculation_runs (id,user_id,portfolio_id,range_from,range_to,calculation_version,reason,status,ledger_high_water_start,idempotency_key,created_at,updated_at)
    VALUES ('run-a','user-a','portfolio-a','2026-08-09','2026-08-09',1,'transaction_change','completed','transaction-a','run-a','2026-08-09','2026-08-09');
    INSERT INTO portfolio_daily_snapshots (id,user_id,portfolio_id,snapshot_date,base_currency_code,total_value_decimal,cost_basis_decimal,coverage_json,completeness,status,ledger_high_water,calculation_run_id,calculation_version,rebuilt_at)
    VALUES ('snapshot-a','user-a','portfolio-a','2026-08-09','AUD','20','20','{}','complete','ready','transaction-a','run-a',1,'2026-08-09');
    INSERT INTO projection_publications (user_id,portfolio_id,calculation_run_id,calculation_version,ledger_high_water,published_at)
    VALUES ('user-a','portfolio-a','run-a',1,'transaction-a','2026-08-09');
    INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at)
    VALUES ('projection-a','user-a','portfolio-a','holding-a','2','20','20','10','complete','ready','transaction-a','run-a',1,'2026-08-09');
    INSERT INTO import_batches (id,user_id,target_portfolio_id,parser_format,parser_version,filename,byte_size,file_sha256,status,total_rows,transaction_rows,created_at,updated_at)
    VALUES ('batch-a','user-a','portfolio-a','strict-versioned-csv','1','owner-a.csv',100,'hash-a','parsed',1,1,'2026-08-09','2026-08-09');
    INSERT INTO import_rows (id,user_id,batch_id,physical_row_number,row_class,original_fields_json,normalized_fields_json,validation_status,target_portfolio_id,commit_status,created_at,updated_at)
    VALUES ('row-a','user-a','batch-a',2,'transaction','["safe"]','{"quantity":"2"}','valid','portfolio-a','staged','2026-08-09','2026-08-09');
  `);
  return database;
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

function drizzleMigrationStatements(migrationSql: string): string[] {
  // Drizzle's explicit boundary is safe for multiline DDL and trigger bodies;
  // semicolons are not because triggers contain statements inside BEGIN/END.
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
      // D1 deliberately keeps foreign-key enforcement enabled, so historical
      // Drizzle table-rebuild copy statements can fail on a parent composite
      // index that is created only after rename. This drill starts from a new,
      // unseeded database: prove the source is empty before omitting only that
      // no-op copy. Upgrade/data-preservation migration verification is a
      // separate concern and must not be simulated by this export drill.
      const source = await database
        .prepare(`SELECT COUNT(*) AS count FROM "${rebuildSource}"`)
        .first<{ count: number }>();
      if (Number(source?.count ?? -1) !== 0)
        throw new Error(`d1_drill_rebuild_source_not_empty:${rebuildSource}`);
      continue;
    }
    await database.prepare(statement).run();
  }
}

test("D1 migration boundaries retain multiline tables and complete trigger bodies", async () => {
  const first = drizzleMigrationStatements(
    await readFile(
      new URL("../drizzle/0000_happy_madelyne_pryor.sql", import.meta.url),
      "utf8",
    ),
  );
  assert.match(first[0]!, /^CREATE TABLE `currencies` \([\s\S]*\n\);$/);
  const lifecycle = drizzleMigrationStatements(
    await readFile(
      new URL(
        "../drizzle/0024_aromatic_franklin_richards.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const triggers = lifecycle.filter((statement) =>
    statement.includes("CREATE TRIGGER account_lifecycle_requests_append_only"),
  );
  assert.equal(triggers.length, 2);
  for (const trigger of triggers) {
    assert.match(trigger, /BEGIN\n\s+SELECT RAISE\([\s\S]+\);\nEND;$/);
    assert.equal(trigger.split("SELECT RAISE").length, 2);
  }
  const manualOverrideMigration = drizzleMigrationStatements(
    await readFile(
      new URL("../drizzle/0009_nappy_tarot.sql", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    manualOverrideMigration
      .map(freshRebuildSourceTable)
      .filter((table) => table !== null)
      .at(0),
    "manual_overrides",
  );
});

test("D1 reserved tables are excluded without weakening application schema coverage", () => {
  assert.equal(isD1ReservedTable("_cf_KV"), true);
  assert.equal(isD1ReservedTable("_cf_future_internal"), true);
  assert.equal(isD1ReservedTable("d1_migrations"), true);
  assert.equal(isD1ReservedTable("account_export_jobs"), false);
  assert.equal(isD1ReservedTable("unclassified_application_table"), false);
});

test("schema-derived export classification covers every table", async () => {
  const database = await createMigratedDatabase();
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    tables
      .map((table) => table.name)
      .filter((name) => !ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS[name]),
    [],
  );
  assert.equal(
    ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS.price_observations.classification,
    "user-scoped-observation",
  );
  assert.equal(
    ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS.fx_rate_observations.classification,
    "user-scoped-observation",
  );
  for (const table of tables) {
    const classification = ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS[table.name];
    if (!classification.ownerColumn) continue;
    const columns = database
      .prepare(`PRAGMA table_info("${table.name}")`)
      .all() as Array<{ name: string }>;
    assert.equal(
      columns.some((column) => column.name === classification.ownerColumn),
      true,
      `${table.name}.${classification.ownerColumn}`,
    );
  }
});

test("disable revokes sessions, is audited, and repeated requests are stable", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const service = createAccountLifecycleService(client, {
    provisioning: "active",
    now: () => "2026-08-09T01:00:00Z",
  });
  const first = await service.disable(
    principal("subject-a", "a@example.com"),
    "disable-a",
    "request-a",
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(
    database.prepare("SELECT status FROM users WHERE id = 'user-a'").get()
      ?.status,
    "disabled",
  );
  assert.equal(
    database
      .prepare("SELECT status FROM user_identities WHERE user_id = 'user-a'")
      .get()?.status,
    "revoked",
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'account.disable'",
      )
      .get()?.count,
    1,
  );
  const revokedRetry = await service.disable(
    principal("subject-a", "a@example.com"),
    "disable-a",
    "request-retry-after-revocation",
  );
  assert.equal(revokedRetry.ok, true);
  if (revokedRetry.ok) assert.equal(revokedRetry.request.id, first.request.id);
  assert.throws(
    () =>
      database.exec(
        `DELETE FROM account_lifecycle_requests WHERE id = '${first.request.id}'`,
      ),
    /account_lifecycle_requests_are_immutable/,
  );
  assert.throws(
    () =>
      database.exec(
        `UPDATE account_lifecycle_requests SET updated_at = '2026-08-09T03:00:00Z' WHERE id = '${first.request.id}'`,
      ),
    /account_lifecycle_requests_are_immutable/,
  );
  assert.deepEqual(
    await createAccountLifecycleRepository(client).request({
      userId: "user-a",
      actorUserId: "user-a",
      requestType: "disable",
      idempotencyKey: "disable-a",
      requestId: "request-repeat",
      now: "2026-08-09T02:00:00Z",
    }),
    first.request,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM users").get()?.count,
    2,
  );
});

test("export is owner-scoped, includes an exact manifest, and does not purge", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const service = createAccountLifecycleService(client, {
    provisioning: "active",
    now: () => "2026-08-09T03:00:00Z",
  });
  await client.run(
    `INSERT INTO audit_events (id, actor_user_id, target_owner_user_id, action, target_type, target_id, request_id, result, metadata_json, occurred_at)
     VALUES ('audit-a', 'user-a', 'user-a', 'test', 'user', 'user-a', 'request', 'success', '{"token":"eyJ-real-secret","nested":{"authorization":"Bearer private"}}', '2026-08-09T03:00:00Z')`,
  );
  await client.run(
    "INSERT INTO audit_events (id, actor_user_id, target_owner_user_id, action, target_type, target_id, request_id, result, metadata_json, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [
      "audit-huge",
      "user-a",
      "user-a",
      "test.huge",
      "user",
      "user-a",
      "request-huge",
      "success",
      JSON.stringify({ payload: "x".repeat(1_200_000) }),
      "2026-08-09T03:00:00Z",
    ],
  );
  const before = Number(
    database.prepare("SELECT COUNT(*) AS count FROM users").get()?.count,
  );
  const result = await service.export(
    principal("subject-a", "a@example.com"),
    "export-a",
    "request-export",
  );
  assert.equal(result.ok, true);
  if (!result.ok || result.request.exportJobId === null) return;
  const repository = createAccountLifecycleRepository(client);
  let injectedCas = false;
  const staleClient: SqlClient = {
    ...client,
    batch: async (statements) => {
      if (!injectedCas) {
        injectedCas = true;
        await client.run(
          "UPDATE account_export_jobs SET version=version+1 WHERE id=? AND user_id=?",
          [result.request.exportJobId, "user-a"],
        );
      }
      return client.batch!(statements);
    },
  };
  const staleJob = await createAccountLifecycleRepository(
    staleClient,
  ).processExportJob(
    "user-a",
    result.request.exportJobId,
    "export-cas0",
    "2026-08-09T03:00:00Z",
  );
  assert.equal(staleJob.status, "queued");
  assert.equal(
    Number(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM account_export_chunks WHERE export_job_id=?",
        )
        .get(result.request.exportJobId)?.count,
    ),
    0,
  );
  const concurrent = await Promise.all([
    repository.processExportJob(
      "user-a",
      result.request.exportJobId,
      "export-concurrent-a",
      "2026-08-09T03:00:00Z",
    ),
    repository.processExportJob(
      "user-a",
      result.request.exportJobId,
      "export-concurrent-b",
      "2026-08-09T03:00:00Z",
    ),
  ]);
  assert.equal(
    concurrent.every((item) => item.status !== "failed"),
    true,
  );
  assert.equal(
    Number(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM account_export_checkpoint_guards WHERE export_job_id = ?",
        )
        .get(result.request.exportJobId)?.count,
    ),
    0,
  );
  let job = await repository.getJob("user-a", result.request.exportJobId);
  let finalizeCheckpoints = 0;
  for (let index = 0; index < 200 && job?.status !== "completed"; index += 1) {
    job = await repository.processExportJob(
      "user-a",
      result.request.exportJobId,
      `export-step-${index}`,
      "2026-08-09T03:00:00Z",
    );
    if (job.phase === "finalize") finalizeCheckpoints += 1;
  }
  assert.equal(job?.status, "completed");
  assert.equal(finalizeCheckpoints >= 3, true);
  assert.equal(job?.manifestDigest?.length, 64);
  const operationalAuditManifest = database
    .prepare(
      "SELECT source_row_count,cutoff_cursor FROM account_export_manifest WHERE export_job_id=? AND table_name='audit_events.process_download'",
    )
    .get(result.request.exportJobId) as {
    source_row_count: number;
    cutoff_cursor: string;
  };
  assert.match(operationalAuditManifest.cutoff_cursor, /^audit-rowid:\d+$/);
  assert.equal(
    Number(
      database
        .prepare(
          "SELECT source_row_count FROM account_export_manifest WHERE export_job_id = ? AND table_name = 'account_export_jobs'",
        )
        .get(result.request.exportJobId)?.source_row_count,
    ) > 0,
    true,
  );
  for (const [table, expected] of [
    ["security_provider_mappings", 1],
    ["price_observations", 1],
    ["fx_rate_observations", 1],
    ["market_data_refresh_jobs", 1],
    ["import_batches", 1],
    ["import_rows", 1],
    ["transactions", 1],
    ["cash_accounts", 1],
    ["cash_ledger_entries", 1],
    ["calculation_runs", 1],
    ["portfolio_daily_snapshots", 1],
    ["projection_publications", 1],
    ["holding_projections", 1],
  ] as const) {
    const manifest = database
      .prepare(
        "SELECT captured_row_count FROM account_export_manifest WHERE export_job_id = ? AND table_name = ?",
      )
      .get(result.request.exportJobId, table) as { captured_row_count: number };
    assert.equal(manifest.captured_row_count, expected, table);
  }
  const chunks = await repository.downloadPage(
    "user-a",
    result.request.exportJobId,
    null,
    "2026-08-09T03:00:00Z",
  );
  const rows = chunks.chunks.flatMap((chunk) => {
    const payload = JSON.parse(String(chunk.payload_json)) as {
      rows?: Array<Record<string, unknown>>;
    };
    return payload.rows ?? [];
  });
  assert.equal(
    rows.some((row) => row.id === "user-b"),
    false,
  );
  const allChunks = [...chunks.chunks];
  let cursor = chunks.nextCursor;
  while (cursor) {
    const next = await repository.downloadPage(
      "user-a",
      result.request.exportJobId,
      cursor,
      "2026-08-09T03:00:00Z",
    );
    allChunks.push(...next.chunks);
    cursor = next.nextCursor;
  }
  const allRows = allChunks.flatMap((chunk) => {
    const payload = JSON.parse(String(chunk.payload_json)) as {
      rows?: Array<Record<string, unknown>>;
    };
    return payload.rows ?? [];
  });
  for (const id of [
    "batch-a",
    "row-a",
    "transaction-a",
    "cash-entry-a",
    "run-a",
    "snapshot-a",
    "projection-a",
  ])
    assert.equal(
      allRows.some((row) => row.id === id),
      true,
      id,
    );
  assert.equal(
    allChunks.some(
      (chunk) =>
        String(chunk.payload_json).includes("price-b") ||
        String(chunk.payload_json).includes("fx-b") ||
        String(chunk.payload_json).includes("portfolio-b"),
    ),
    false,
  );
  const manifestRows = chunks.manifest.map((row) => ({
    table: String(row.table_name),
    classification: String(row.classification),
    retention: String(row.retention),
    reason: String(row.reason),
    sourceRowCount: Number(row.source_row_count),
    capturedRowCount: Number(row.captured_row_count),
    objectCount: Number(row.object_count),
    digest: String(row.digest),
    cutoffCursor: row.cutoff_cursor == null ? null : String(row.cutoff_cursor),
  }));
  const chunkRecords = allChunks
    .map((chunk) => ({
      table: String(chunk.table_name),
      chunkIndex: Number(chunk.chunk_index),
      rowCount: Number(chunk.row_count),
      digest: String(chunk.digest),
    }))
    .sort((left, right) =>
      left.table === right.table
        ? left.chunkIndex - right.chunkIndex
        : left.table.localeCompare(right.table),
    );
  const sha256 = (value: string) =>
    createHash("sha256").update(value, "utf8").digest("hex");
  let independentManifestDigest = sha256(
    JSON.stringify({
      format: "yieldtome.account-export",
      version: 2,
      digestAlgorithm: "sha256-chain-v1",
      ownerId: "user-a",
      jobId: result.request.exportJobId,
      expiresAt: chunks.job.expiresAt,
      tables: manifestRows,
    }),
  );
  for (const chunk of chunkRecords)
    independentManifestDigest = sha256(
      independentManifestDigest + JSON.stringify(chunk),
    );
  independentManifestDigest = sha256(independentManifestDigest + ":end");
  assert.equal(independentManifestDigest, job?.manifestDigest);
  const finalizedOperationalCount = operationalAuditManifest.source_row_count;
  const fragments = allChunks
    .map(
      (chunk) =>
        JSON.parse(String(chunk.payload_json)) as Record<string, unknown>,
    )
    .filter((payload) => payload.format === "row-fragment-v1")
    .sort(
      (left, right) => Number(left.fragmentIndex) - Number(right.fragmentIndex),
    );
  assert.equal(fragments.length > 1, true);
  assert.equal(
    fragments.length > 100,
    true,
    "large rows must continue across bounded four-fragment checkpoints",
  );
  const reconstructed = JSON.parse(
    fragments.map((fragment) => String(fragment.data)).join(""),
  ) as Record<string, unknown>;
  const reconstructedDigest = createHash("sha256")
    .update(JSON.stringify(reconstructed), "utf8")
    .digest("hex");
  assert.equal(reconstructedDigest, fragments[0]?.rowDigest);
  assert.equal(
    rows.some((row) => row.id === "audit-a"),
    true,
  );
  assert.equal(
    rows.some((row) => JSON.stringify(row).includes("eyJ")),
    false,
  );
  assert.equal(
    allChunks.some((chunk) =>
      String(chunk.payload_json).includes("Bearer private"),
    ),
    false,
  );
  assert.equal(
    Number(
      database.prepare("SELECT COUNT(*) AS count FROM users").get()?.count,
    ),
    before,
  );
  assert.equal(
    database
      .prepare(
        "SELECT source_row_count FROM account_export_manifest WHERE export_job_id=? AND table_name='audit_events.process_download'",
      )
      .get(result.request.exportJobId)?.source_row_count,
    finalizedOperationalCount,
  );
  const partChunks: Array<Record<string, unknown>> = [];
  let part: number | null = 1;
  while (part !== null) {
    const page = await repository.downloadPage(
      "user-a",
      result.request.exportJobId,
      null,
      "2026-08-09T03:00:00Z",
      part,
    );
    partChunks.push(...page.chunks);
    part = page.nextPart;
  }
  assert.deepEqual(
    partChunks.map((chunk) => [chunk.table_name, chunk.chunk_index]),
    allChunks.map((chunk) => [chunk.table_name, chunk.chunk_index]),
  );
  const repeated = await createAccountLifecycleRepository(client).request({
    userId: "user-a",
    actorUserId: "user-a",
    requestType: "export",
    idempotencyKey: "export-a",
    requestId: "request-export-repeat",
    now: "2026-08-09T04:00:00Z",
  });
  assert.deepEqual(repeated, result.request);
  assert.equal(
    (
      await repository.getJobForPrincipalRequest(
        "https://team.cloudflareaccess.com",
        "subject-a",
        "export",
        "export-a",
        result.request.exportJobId,
      )
    )?.id,
    result.request.exportJobId,
  );
  assert.equal(
    await repository.getJobForPrincipalRequest(
      "https://team.cloudflareaccess.com",
      "subject-a",
      "export",
      "wrong-key",
      result.request.exportJobId,
    ),
    null,
  );
  assert.equal(
    await repository.getJobForPrincipalRequest(
      "https://team.cloudflareaccess.com",
      "subject-b",
      "export",
      "export-a",
      result.request.exportJobId,
    ),
    null,
  );
});

test("lifecycle repository rejects a cross-owner actor", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  await assert.rejects(
    createAccountLifecycleRepository(client).request({
      userId: "user-b",
      actorUserId: "user-a",
      requestType: "export",
      idempotencyKey: "cross-owner",
      requestId: "request-cross-owner",
      now: "2026-08-09T05:00:00Z",
    }),
    /owner_mismatch/,
  );
});

test("revoked principal recovery requires the exact request type and key", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const service = createAccountLifecycleService(client, {
    provisioning: "active",
    now: () => "2026-08-09T06:00:00Z",
  });
  const disabled = await service.disable(
    principal("subject-a", "a@example.com"),
    "disable-exact-key",
    "disable-exact-request",
  );
  assert.equal(disabled.ok, true);
  const repository = createAccountLifecycleRepository(client);
  assert.equal(
    (
      await repository.getForPrincipal(
        "https://team.cloudflareaccess.com",
        "subject-a",
        "disable",
        "disable-exact-key",
      )
    )?.id,
    disabled.ok ? disabled.request.id : null,
  );
  assert.equal(
    await repository.getForPrincipal(
      "https://team.cloudflareaccess.com",
      "subject-a",
      "disable",
      "wrong-key",
    ),
    null,
  );
  assert.equal(
    await repository.getForPrincipal(
      "https://team.cloudflareaccess.com",
      "subject-b",
      "disable",
      "disable-exact-key",
    ),
    null,
  );
});

test("export route authorization requires exact credentials only for revoked identities", async () => {
  const valid = parseExportRecoveryCredentials(
    new URL(
      "https://portfolio.example/export?requestType=deletion&idempotencyKey=delete-key",
    ),
  );
  assert.deepEqual(valid, {
    ok: true,
    credentials: {
      requestType: "deletion",
      idempotencyKey: "delete-key",
    },
  });
  for (const url of [
    "https://portfolio.example/export?requestType=deletion",
    "https://portfolio.example/export?idempotencyKey=delete-key",
    "https://portfolio.example/export?requestType=wrong&idempotencyKey=delete-key",
    "https://portfolio.example/export?requestType=export&idempotencyKey=bad%20key",
  ])
    assert.deepEqual(parseExportRecoveryCredentials(new URL(url)), {
      ok: false,
    });
  assert.equal(
    await authorizeExportJobRequest({
      identityStatus: "active",
      userStatus: "active",
      credentials: null,
      exactRequestOwnsJob: async () => false,
    }),
    true,
  );
  assert.equal(
    await authorizeExportJobRequest({
      identityStatus: "revoked",
      userStatus: "deletion_pending",
      credentials: null,
      exactRequestOwnsJob: async () => true,
    }),
    false,
  );
  assert.equal(
    await authorizeExportJobRequest({
      identityStatus: "revoked",
      userStatus: "deletion_pending",
      credentials: valid.ok ? valid.credentials : null,
      exactRequestOwnsJob: async (credentials) =>
        credentials.idempotencyKey === "delete-key",
    }),
    true,
  );
  const csrf = rejectCrossSiteMutation(
    new Request("https://portfolio.example/api/account/export/job/process", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    }),
  );
  assert.equal(csrf?.status, 403);
  assert.equal(csrf?.headers.get("cache-control"), "private, no-store");
});

test("unexpected export errors atomically persist one stable failed outcome", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const repository = createAccountLifecycleRepository(client);
  const request = await repository.request({
    userId: "user-a",
    actorUserId: "user-a",
    requestType: "export",
    idempotencyKey: "failure-key",
    requestId: "failure-request",
    now: "2026-08-09T07:00:00Z",
  });
  assert.ok(request.exportJobId);
  let injected = false;
  const faulty: SqlClient = {
    ...client,
    all: async (sql, params) => {
      if (!injected) {
        injected = true;
        throw new Error("provider payload secret=must-not-leak");
      }
      return client.all(sql, params);
    },
  };
  const failed = await createAccountLifecycleRepository(
    faulty,
  ).processExportJob(
    "user-a",
    request.exportJobId!,
    "failure-process",
    "2026-08-09T07:01:00Z",
  );
  assert.equal(failed.status, "failed");
  const repeated = await repository.processExportJob(
    "user-a",
    request.exportJobId!,
    "failure-process-repeat",
    "2026-08-09T07:02:00Z",
  );
  assert.equal(repeated.status, "failed");
  const audits = database
    .prepare(
      "SELECT metadata_json FROM audit_events WHERE target_id=? AND action='account.export.process' AND result='failure'",
    )
    .all(request.exportJobId) as Array<{ metadata_json: string }>;
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.metadata_json.includes("must-not-leak"), false);
});

test("expired exports transition once and never expose artifacts", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const repository = createAccountLifecycleRepository(client);
  const request = await repository.request({
    userId: "user-a",
    actorUserId: "user-a",
    requestType: "export",
    idempotencyKey: "expiry-key",
    requestId: "expiry-request",
    now: "2026-01-01T00:00:00Z",
  });
  const expired = await repository.processExportJob(
    "user-a",
    request.exportJobId!,
    "expiry-process",
    "2026-03-01T00:00:00Z",
  );
  assert.equal(expired.status, "expired");
  await assert.rejects(
    repository.downloadPage(
      "user-a",
      request.exportJobId!,
      null,
      "2026-03-01T00:00:00Z",
    ),
    /export_not_ready/,
  );
  await repository.processExportJob(
    "user-a",
    request.exportJobId!,
    "expiry-repeat",
    "2026-03-01T00:00:01Z",
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE target_id=? AND action='account.export.process'",
      )
      .get(request.exportJobId)?.count,
    1,
  );
});

test("source mutation during reconcile fails closed without a completed manifest", async () => {
  const database = await createMigratedDatabase();
  const client = createSqliteSqlClient(database);
  const repository = createAccountLifecycleRepository(client);
  const request = await repository.request({
    userId: "user-a",
    actorUserId: "user-a",
    requestType: "export",
    idempotencyKey: "mutation-key",
    requestId: "mutation-request",
    now: "2026-08-09T08:00:00Z",
  });
  let job = await repository.getJob("user-a", request.exportJobId!);
  for (let step = 0; step < 200 && job?.phase !== "reconcile"; step += 1)
    job = await repository.processExportJob(
      "user-a",
      request.exportJobId!,
      `capture-${step}`,
      "2026-08-09T08:00:00Z",
    );
  assert.equal(job?.phase, "reconcile");
  await client.run(
    "UPDATE users SET primary_email='changed@example.com' WHERE id='user-a'",
  );
  for (let step = 0; step < 200 && job?.status !== "failed"; step += 1)
    job = await repository.processExportJob(
      "user-a",
      request.exportJobId!,
      `reconcile-${step}`,
      "2026-08-09T08:01:00Z",
    );
  assert.equal(job?.status, "failed");
  assert.equal(job?.manifestDigest, null);
  const failureAudits = database
    .prepare(
      "SELECT metadata_json FROM audit_events WHERE target_id=? AND action='account.export.process' AND result='failure'",
    )
    .all(request.exportJobId) as Array<{ metadata_json: string }>;
  assert.equal(failureAudits.length, 1);
  assert.match(
    failureAudits[0]!.metadata_json,
    /export_reconciliation_mismatch/,
  );
  await repository.processExportJob(
    "user-a",
    request.exportJobId!,
    "reconcile-terminal-repeat",
    "2026-08-09T08:02:00Z",
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE target_id=? AND action='account.export.process' AND result='failure'",
      )
      .get(request.exportJobId)?.count,
    1,
  );
});

test("lifecycle components follow server multipart completion and recovery auto-resumes", async () => {
  const controls = await readFile(
    new URL(
      "../app/components/account-lifecycle-controls.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const recovery = await readFile(
    new URL(
      "../app/components/account-lifecycle-recovery.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  for (const source of [controls, recovery]) {
    assert.match(source, /result\.nextPart \?\? null/);
    assert.match(source, /requestType=.*idempotencyKey=/);
    assert.doesNotMatch(source, /setDownloadPart\(\(part\) => part \+ 1\)/);
    assert.match(source, /All export parts downloaded/);
  }
  assert.match(recovery, /void processRecovered\(/);
  assert.match(recovery, /attempt < 1_200/);
});

test("synthetic non-production D1 drill completes, traverses, and preserves source rows", async (context) => {
  if (process.env.OPS003A_D1_DRILL !== "1") {
    context.skip(
      "set OPS003A_D1_DRILL=1 where loopback Miniflare is permitted",
    );
    return;
  }
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "ops-003a-synthetic-drill" },
  });
  try {
    const d1 = await miniflare.getD1Database("DB");
    const files = (await readdir(new URL("../drizzle", import.meta.url)))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files)
      await applyDrizzleMigrationToD1(
        d1,
        await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
      );
    for (const statement of [
      "INSERT INTO currencies (code,numeric_code,name,minor_unit_digits) VALUES ('AUD',36,'Australian dollar',2)",
      "INSERT INTO users (id,status,primary_email,timezone,created_at,updated_at) VALUES ('drill-owner','active','drill@example.invalid','Australia/Sydney','2026-08-09','2026-08-09'),('drill-other','active','other@example.invalid','Australia/Sydney','2026-08-09','2026-08-09')",
      "INSERT INTO user_identities (id,user_id,issuer,subject,email_at_link,status,created_at,updated_at) VALUES ('drill-identity','drill-owner','https://drill.cloudflareaccess.invalid','drill-subject','drill@example.invalid','active','2026-08-09','2026-08-09')",
      "INSERT INTO portfolios (id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at,version) VALUES ('drill-portfolio','drill-owner','DRILL','Synthetic','AUD','Australia/Sydney','fifo','active','2026-08-09','2026-08-09',1),('other-portfolio','drill-other','OTHER','Other','AUD','Australia/Sydney','fifo','active','2026-08-09','2026-08-09',1)",
      "INSERT INTO transactions (id,user_id,portfolio_id,type,status,trade_at,local_trade_date,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES ('drill-cash','drill-owner','drill-portfolio','cash_deposit','posted','2026-08-09T00:00:00Z','2026-08-09','AUD','50','0','0','manual','drill-owner',1,'2026-08-09')",
    ])
      await d1.prepare(statement).run();
    const client = createD1SqlClient(d1);
    const repository = createAccountLifecycleRepository(client);
    const sourceCount = Number(
      (
        await client.get<Record<string, unknown>>(
          "SELECT COUNT(*) AS count FROM transactions",
        )
      )?.count,
    );
    const request = await repository.request({
      userId: "drill-owner",
      actorUserId: "drill-owner",
      requestType: "export",
      idempotencyKey: "synthetic-d1-drill",
      requestId: "synthetic-d1-request",
      now: "2026-08-09T09:00:00Z",
    });
    let job = await repository.getJob("drill-owner", request.exportJobId!);
    for (let step = 0; step < 250 && job?.status !== "completed"; step += 1)
      job = await repository.processExportJob(
        "drill-owner",
        request.exportJobId!,
        `synthetic-d1-${step}`,
        "2026-08-09T09:00:00Z",
      );
    const failureEvidence =
      job?.status === "failed"
        ? await client.all<Record<string, unknown>>(
            "SELECT phase,status,table_index,row_cursor,reconcile_table_index,reconcile_row_cursor,finalize_table_name,finalize_chunk_index FROM account_export_jobs WHERE id=? AND user_id=? UNION ALL SELECT 'audit',result,0,0,0,0,metadata_json,0 FROM audit_events WHERE target_id=? AND action='account.export.process' ORDER BY phase",
            [request.exportJobId!, "drill-owner", request.exportJobId!],
          )
        : [];
    assert.equal(
      job?.status,
      "completed",
      `synthetic D1 failure evidence: ${JSON.stringify(failureEvidence)}`,
    );
    assert.equal(job?.manifestDigest?.length, 64);
    const first = await repository.downloadPage(
      "drill-owner",
      request.exportJobId!,
      null,
      "2026-08-09T09:00:00Z",
    );
    assert.equal(
      first.manifest.some(
        (row) =>
          row.table_name === "transactions" && row.captured_row_count === 1,
      ),
      true,
    );
    assert.equal(
      first.chunks.some((chunk) =>
        String(chunk.payload_json).includes("other-portfolio"),
      ),
      false,
    );
    assert.equal(
      Number(
        (
          await client.get<Record<string, unknown>>(
            "SELECT COUNT(*) AS count FROM transactions",
          )
        )?.count,
      ),
      sourceCount,
    );
  } finally {
    await miniflare.dispose();
  }
});
