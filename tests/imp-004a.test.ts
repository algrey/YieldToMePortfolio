import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createImportReadyPost } from "../app/import-ready-route.ts";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type SqlClient,
} from "../db/repositories/index.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION } from "../domain/imports/index.ts";

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
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-10', '2026-08-10', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-10', '2026-08-10', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-10', '2026-08-10', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-10', '2026-08-10', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-10', '2026-08-10', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-10', '2026-08-10', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-10', '2026-08-10'),
           ('security-b', 'Beta', 'equity', 'USD', 'active', '2026-08-10', '2026-08-10');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-10', '2026-08-10'),
           ('membership-b', 'user-a', 'portfolio-a', 'security-b', 'XYZ', 'ASX', 'USD', 'held', '2026-08-10', '2026-08-10');
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION}', 'sample.csv', 100, 'file-a', 'parsed',
      '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', 1);
  `);
  return database;
}

function normalizedRow(
  overrides: Partial<{
    portfolio: string;
    symbol: string;
    currency: string;
    purchaseExchangeRate: string | null;
  }> = {},
) {
  return {
    id: "source-2",
    symbol: overrides.symbol ?? "ABC",
    name: "Alpha",
    displaySymbol: null,
    exchange: "ASX",
    portfolio: overrides.portfolio ?? "Main",
    currency: overrides.currency ?? "AUD",
    sharesOwned: "5",
    costPerShare: "10",
    commission: "0",
    transactionDate: "2026-08-01 GMT+1000",
    transactionTime: "10:00:00",
    purchaseExchangeRate: overrides.purchaseExchangeRate ?? null,
    type: "buy",
    accounting: "fifo",
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: "2026-08-01T00:00:00.000Z",
    localTradeDate: "2026-08-01",
    cashEvent: null,
  };
}

function stageRow(
  database: DatabaseSync,
  batchId: string,
  rowId: string,
  normalized: ReturnType<typeof normalizedRow>,
): void {
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, commit_status, created_at, updated_at, version
       ) VALUES (?, 'user-a', ?, 2, 'transaction', '[]', ?, ?, 'valid',
         NULL, 'staged', '2026-08-10', '2026-08-10', 1)`,
    )
    .run(rowId, batchId, JSON.stringify(normalized), `fingerprint-${rowId}`);
}

// Mirrors the private `loadReview` helper in app/import-actions.ts using only
// exported repository functions, so tests can obtain the current server
// `previewVersion` for a batch regardless of whether it is currently ready
// (the commit repository's own `validate()` only returns a version once
// ready, which is unusable for exercising the "still blocked" branch below).
async function currentPreviewVersion(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<string> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch) throw new Error("expected batch to exist");
  const [rows, issues, mappings, portfolios, candidateRows] = await Promise.all(
    [
      staging.listRows(userId, batchId),
      staging.listIssues(userId, batchId),
      createOwnedImportMappingDecisionRepository(client).list(userId, batchId),
      createOwnedPortfolioRepository(client).list(userId),
      client.all<Record<string, unknown>>(
        `SELECT id, portfolio_id, source_symbol, source_exchange_alias,
                source_currency_code, security_id
           FROM portfolio_securities WHERE user_id = ?
          ORDER BY source_symbol ASC, id ASC`,
        [userId],
      ),
    ],
  );
  const review = buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    })),
    securityCandidates: candidateRows.map((row) => ({
      id: String(row.id),
      portfolioId: String(row.portfolio_id),
      sourceSymbol: String(row.source_symbol),
      sourceExchangeAlias:
        row.source_exchange_alias === null
          ? null
          : String(row.source_exchange_alias),
      sourceCurrencyCode: String(row.source_currency_code),
      securityId: row.security_id === null ? null : String(row.security_id),
    })),
  });
  return review.previewVersion;
}

test("readiness blocks on an unresolved FX direction, then transitions to ready once it is resolved", async () => {
  const database = await migratedDatabase();
  // Symbol/exchange/currency match the pre-existing resolved `membership-b`
  // candidate automatically (no security mapping needed), but the row's
  // currency (USD) differs from the portfolio's home currency (AUD) and
  // carries a purchase exchange rate whose direction is not yet confirmed --
  // this is FX_DIRECTION_REQUIRED, one of the "unresolved... FX candidates"
  // this task's UI must let the owner resolve.
  stageRow(
    database,
    "batch-a",
    "row-1",
    normalizedRow({
      symbol: "XYZ",
      currency: "USD",
      purchaseExchangeRate: "1.35",
    }),
  );
  const client = createSqliteSqlClient(database);
  const context = { client, userId: "user-a" };

  const blockedPreviewVersion = await currentPreviewVersion(
    client,
    "user-a",
    "batch-a",
  );
  const blocked = await markImportReadyWithContext(context, "batch-a", {
    expectedVersion: 1,
    expectedPreviewVersion: blockedPreviewVersion,
  });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.status, 409);
  assert.equal(
    (
      database
        .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
        .get() as { status: string }
    ).status,
    "parsed",
  );

  await createOwnedImportMappingDecisionRepository(client).save("user-a", {
    batchId: "batch-a",
    kind: "fx",
    sourceKey: "USD->AUD",
    normalizedSourceValue: "USD->AUD",
    targetId: null,
    targetValue: "native_to_home",
    scope: "batch",
    confidence: "user",
    source: "user",
  });

  const resolvedPreviewVersion = await currentPreviewVersion(
    client,
    "user-a",
    "batch-a",
  );
  const ready = await markImportReadyWithContext(context, "batch-a", {
    expectedVersion: 1,
    expectedPreviewVersion: resolvedPreviewVersion,
  });
  assert.equal(ready.ok, true);
  if (ready.ok) {
    assert.equal(ready.review.batch.status, "ready");
    assert.equal(ready.review.preview.ready, true);
  }
});

test("readiness stays blocked on an unresolved persisted validation issue even when the reconciliation preview looks clear", async () => {
  const database = await migratedDatabase();
  // No rows at all: reconciliation trivially reports `ready: true` (no rows
  // to reconcile). A leftover unresolved *persisted* error issue (e.g. from
  // parse-time field validation) must still block readiness -- this is the
  // half of the precondition that `preview.ready` alone cannot see, mirroring
  // import-commit.ts's own independent `hasBlockingPersistedState` check.
  database.exec(`
    INSERT INTO import_issues (
      id, user_id, batch_id, severity, code, message, created_at, updated_at, version
    ) VALUES ('issue-a', 'user-a', 'batch-a', 'error', 'QUANTITY_INVALID',
      'Missing quantity', '2026-08-10', '2026-08-10', 1);
  `);
  const client = createSqliteSqlClient(database);
  const context = { client, userId: "user-a" };
  const previewVersion = await currentPreviewVersion(
    client,
    "user-a",
    "batch-a",
  );
  const result = await markImportReadyWithContext(context, "batch-a", {
    expectedVersion: 1,
    expectedPreviewVersion: previewVersion,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 409);
});

test("readiness action rejects malformed input, a stale version, wrong status, and another owner's batch", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const context = { client, userId: "user-a" };

  assert.deepEqual(await markImportReadyWithContext(context, "batch-a", null), {
    ok: false,
    status: 400,
    message: "The reviewed preview version is required.",
  });
  assert.deepEqual(
    await markImportReadyWithContext(context, "batch-a", {
      expectedVersion: 99,
      expectedPreviewVersion: "anything",
    }),
    {
      ok: false,
      status: 409,
      message: "This preview is stale. Reload it before marking it ready.",
    },
  );
  assert.deepEqual(
    await markImportReadyWithContext(context, "missing-batch", {
      expectedVersion: 1,
      expectedPreviewVersion: "anything",
    }),
    { ok: false, status: 404, message: "Import batch not found." },
  );
  assert.deepEqual(
    await markImportReadyWithContext({ client, userId: "user-b" }, "batch-a", {
      expectedVersion: 1,
      expectedPreviewVersion: "anything",
    }),
    { ok: false, status: 404, message: "Import batch not found." },
  );

  database.exec(
    "UPDATE import_batches SET status = 'invalid' WHERE id = 'batch-a'",
  );
  const wrongStatus = await markImportReadyWithContext(context, "batch-a", {
    expectedVersion: 1,
    expectedPreviewVersion: "anything",
  });
  assert.equal(wrongStatus.ok, false);
  if (!wrongStatus.ok) assert.equal(wrongStatus.status, 409);
});

test("ready route enforces CSRF before its authenticated action", async () => {
  let calls = 0;
  const rejectedPost = createImportReadyPost(async () => {
    calls += 1;
    throw new Error("cross-site request reached the action");
  });
  const rejected = await rejectedPost(
    new Request("https://yield.example/api/import/preview/batch-a/ready", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(rejected.status, 403);
  assert.equal(calls, 0);

  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", normalizedRow());
  const client = createSqliteSqlClient(database);
  const previewVersion = await currentPreviewVersion(
    client,
    "user-a",
    "batch-a",
  );
  const authenticatedPost = createImportReadyPost((batchId, value) =>
    markImportReadyWithContext({ client, userId: "user-a" }, batchId, value),
  );
  const response = await authenticatedPost(
    new Request("https://yield.example/api/import/preview/batch-a/ready", {
      method: "POST",
      headers: {
        origin: "https://yield.example",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expectedVersion: 1,
        expectedPreviewVersion: previewVersion,
      }),
    }),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = (await response.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test("full round trip: an owner-resolved import reaches ready, commits into holdings, and reverses", async () => {
  const database = await migratedDatabase();
  // The staged row's symbol/exchange/currency automatically match the
  // pre-existing resolved `membership-a` candidate, so no mapping decision
  // is required here (this is the ordinary "map to an existing resolved
  // security" outcome: `securities` stays untouched -- see reconciliation.ts
  // -- while the owner's own private `portfolio_securities` row supplies the
  // resolved target).
  stageRow(database, "batch-a", "row-1", normalizedRow());
  const client = createSqliteSqlClient(database);
  const context = { client, userId: "user-a" };

  const previewVersion = await currentPreviewVersion(
    client,
    "user-a",
    "batch-a",
  );
  const ready = await markImportReadyWithContext(context, "batch-a", {
    expectedVersion: 1,
    expectedPreviewVersion: previewVersion,
  });
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  assert.equal(ready.review.batch.status, "ready");
  const readyVersion = ready.review.batch.version;

  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", "batch-a");
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: readyVersion,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "imp-004a-commit",
    confirmation: true,
    requestId: "imp-004a-commit-request",
  };
  let commitResult = await commitRepo.commit("user-a", "batch-a", commitInput);
  for (
    let attempt = 0;
    attempt < 10 && (!commitResult.ok || commitResult.status !== "committed");
    attempt += 1
  ) {
    assert.equal(commitResult.ok, true);
    commitResult = await commitRepo.commit("user-a", "batch-a", commitInput);
  }
  assert.equal(commitResult.ok, true);
  if (!commitResult.ok) return;
  assert.equal(commitResult.status, "committed");
  assert.equal(commitResult.committedRows, 1);

  const posted = database
    .prepare(
      `SELECT status, quantity_decimal, type FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = 'membership-a'`,
    )
    .get() as
    { status: string; quantity_decimal: string; type: string } | undefined;
  assert.ok(
    posted,
    "expected a posted ledger transaction for the committed buy",
  );
  assert.equal(posted?.status, "posted");
  assert.equal(posted?.type, "buy");
  assert.equal(posted?.quantity_decimal, "5");
  const rebuildJob = database
    .prepare(
      `SELECT id FROM calculation_runs
       WHERE user_id = 'user-a' AND reason = 'import_commit' AND invalidation_source = 'batch-a'`,
    )
    .get();
  assert.ok(
    rebuildJob,
    "expected a queued rebuild job for the affected portfolio",
  );

  const committedBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    "batch-a",
  );
  assert.ok(committedBatch);
  const reversalRepo = createOwnedImportReversalRepository(client);
  let reversed = await reversalRepo.reverse("user-a", "batch-a", {
    expectedVersion: committedBatch!.version,
    idempotencyKey: "imp-004a-reverse",
    confirmation: true,
    requestId: "imp-004a-reverse-request",
  });
  for (
    let attempt = 0;
    attempt < 10 && (!reversed.ok || reversed.status !== "reversed");
    attempt += 1
  ) {
    assert.equal(reversed.ok, true);
    reversed = await reversalRepo.reverse("user-a", "batch-a", {
      expectedVersion: committedBatch!.version,
      idempotencyKey: "imp-004a-reverse",
      confirmation: true,
      requestId: "imp-004a-reverse-request",
    });
  }
  assert.equal(reversed.ok, true);
  if (reversed.ok) assert.equal(reversed.status, "reversed");
  const reversedBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    "batch-a",
  );
  assert.equal(reversedBatch?.status, "reversed");
});
