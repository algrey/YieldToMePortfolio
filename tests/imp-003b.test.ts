import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createImportReversalPost } from "../app/import-reversal-route.ts";
import { reverseImportWithContext } from "../app/import-reversal-service.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedLedgerRepository,
  createSqliteSqlClient,
  IMPORT_REVERSAL_LIMITS,
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
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-03', '2026-08-03');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'AUD', 'held', '2026-08-03', '2026-08-03');
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION}', 'sample.csv', 100, 'file-a', 'ready',
      '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z', 1);
  `);
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

function stageRows(database: DatabaseSync, count: number): void {
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

async function commitBatch(
  database: DatabaseSync,
  count: number,
): Promise<{ database: DatabaseSync; version: number }> {
  stageRows(database, count);
  return commitStagedBatch(database);
}

/** `commitBatch` without the staging step, for fixtures that stage their own rows. */
async function commitStagedBatch(
  database: DatabaseSync,
): Promise<{ database: DatabaseSync; version: number }> {
  const client = createSqliteSqlClient(database);
  const repository = createOwnedImportCommitRepository(client);
  const validated = await repository.validate("user-a", "batch-a");
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("expected the import to validate");
  const input: ImportCommitInput = {
    expectedVersion: 1,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "commit-a",
    confirmation: true,
    requestId: "request-a",
  };
  let result = await repository.commit("user-a", "batch-a", input);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (result.ok && result.status === "committed") break;
    assert.equal(result.ok, true);
    result = await repository.commit("user-a", "batch-a", input);
  }
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected the import to commit");
  assert.equal(result.status, "committed");
  const batch = database
    .prepare("SELECT version FROM import_batches WHERE id = 'batch-a'")
    .get() as { version: number };
  return { database, version: batch.version };
}

function reversalInput(expectedVersion: number, key = "reverse-a") {
  return {
    expectedVersion,
    idempotencyKey: key,
    confirmation: true,
    requestId: "request-reversal",
  };
}

test("clean reversal is compensating, auditable, and idempotent", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 2);
  database
    .prepare(
      `INSERT INTO import_mapping_decisions (
         id, user_id, batch_id, kind, source_key, normalized_source_value,
         target_id, target_value, scope, confidence, source, created_at,
         updated_at, version
       ) VALUES ('mapping-a', 'user-a', 'batch-a', 'portfolio', 'Main', 'main',
         'portfolio-a', NULL, 'batch', 'user', 'user', '2026-08-03',
         '2026-08-03', 1)`,
    )
    .run();
  const client = createSqliteSqlClient(database);
  const result = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "reversed");
  assert.equal(result.reversedTransactions, 2);
  assert.equal(result.remainingTransactions, 0);
  assert.equal(result.rebuildJobIds.length, 2);
  assert.deepEqual(
    database
      .prepare(
        "SELECT status, count(*) AS count FROM transactions GROUP BY status ORDER BY status",
      )
      .all()
      .map((row) => ({ status: String(row.status), count: Number(row.count) })),
    [
      { status: "posted", count: 2 },
      { status: "reversed", count: 2 },
    ],
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT COALESCE(SUM(CAST(signed_amount_decimal AS REAL)), 0) AS total FROM cash_ledger_entries",
        )
        .get() as { total: number }
    ).total,
    0,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM import_rows WHERE commit_status = 'reversed'",
        )
        .get() as { count: number }
    ).count,
    2,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM import_mapping_decisions WHERE user_id = 'user-a' AND batch_id = 'batch-a'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'import.reverse' AND target_id = 'batch-a'",
        )
        .get() as { count: number }
    ).count,
    1,
  );
  const repeated = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(999),
  );
  assert.equal(repeated.ok, true);
  if (repeated.ok) assert.equal(repeated.idempotent, true);
});

test("later dependent sales block reversal with exact impact evidence", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 1);
  const client = createSqliteSqlClient(database);
  const sale = await createOwnedLedgerRepository(client).post("user-a", {
    portfolioId: "portfolio-a",
    type: "sell",
    portfolioSecurityId: "membership-a",
    quantityDecimal: "1",
    unitPriceDecimal: "12",
    grossAmountDecimal: "12",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: null,
    sourceType: "manual",
    sourceReference: "manual-sale-1",
    idempotencyKey: "manual-sale-1",
    tradeAt: "2026-08-04T00:00:00.000Z",
    localTradeDate: "2026-08-04",
    settlementDate: null,
    currencyCode: "AUD",
    fxRateSource: null,
    fxObservedAt: null,
    requestId: "request-sale",
  });
  assert.equal(sale.ok, true);
  if (!sale.ok) return;
  const result = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version),
  );
  assert.deepEqual(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "dependent_facts");
    assert.equal(result.impacts?.length, 1);
    assert.equal(
      result.impacts?.[0]?.dependentTransactionId,
      sale.transaction.id,
    );
    assert.equal(result.impacts?.[0]?.dependentQuantityDecimal, "1");
    assert.equal(
      result.impacts?.[0]?.dependentTradeAt,
      "2026-08-04T00:00:00.000Z",
    );
  }
  assert.equal(
    (
      database
        .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
        .get() as { status: string }
    ).status,
    "committed",
  );
});

test("equal-timestamp sales respect the stable ledger ordering", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 1);
  const client = createSqliteSqlClient(database);
  database
    .prepare(
      `INSERT INTO transactions (
         id, user_id, portfolio_id, portfolio_security_id, type, status,
         trade_at, local_trade_date, quantity_decimal, unit_price_decimal,
         currency_code, gross_amount_decimal, source_type, source_reference,
         created_by_user_id, calculation_version, created_at
       ) VALUES ('zz-sale-equal-time', 'user-a', 'portfolio-a', 'membership-a',
         'sell', 'posted', '2026-08-01T00:00:02.000Z', '2026-08-01',
         '1', '12', 'AUD', '12', 'manual', 'manual-sale-equal-time',
         'user-a', 1, '2026-08-01')`,
    )
    .run();
  const result = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "dependent_facts");
});

test("direct reversal denies another owner without changing the batch", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 1);
  const result = await createOwnedImportReversalRepository(
    createSqliteSqlClient(database),
  ).reverse("user-b", "batch-a", reversalInput(version, "wrong-owner"));
  assert.deepEqual(result, { ok: false, reason: "not_found" });
  assert.equal(
    (
      database
        .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
        .get() as { status: string }
    ).status,
    "committed",
  );
});

test("authenticated reversal action rejects malformed, unconfirmed, and stale requests", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 1);
  const context = {
    client: createSqliteSqlClient(database),
    userId: "user-a",
    requestId: "authenticated-request",
  };
  assert.deepEqual(await reverseImportWithContext(context, "batch-a", null), {
    ok: false,
    status: 400,
    message:
      "The batch version, confirmation, and idempotency key are required.",
  });
  assert.deepEqual(
    await reverseImportWithContext(context, "batch-a", {
      ...reversalInput(version),
      confirmation: false,
    }),
    {
      ok: false,
      status: 400,
      message: "Confirm the import reversal before continuing.",
      impacts: undefined,
    },
  );
  assert.deepEqual(
    await reverseImportWithContext(context, "batch-a", reversalInput(0)),
    {
      ok: false,
      status: 409,
      message: "This import changed. Reload it before reversing it.",
      impacts: undefined,
    },
  );
});

// BUG-016 fold-in (F1): `reverseImportWithContext` used to discard
// `result.rebuildJobIds` entirely -- the queued `calculation_runs` rows
// (here, the per-transaction `ledger_mutation` row `ledger.reverse()`
// queues) sat `queued` until the cron sweep. Mirrors the commit routes'
// `advanceCalculationRunsForCommit` best-effort call: after a successful
// reversal the portfolio's projection publication must already be CURRENT,
// with no queued run left over, in the SAME request.
test("BUG-016 fold-in: a reversal advances its own queued calculation runs in-request, leaving the portfolio's projection publication current", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 1);
  // The commit above already queued its own (now-stale) `calculation_runs`
  // rows for portfolio-a; `advanceCalculationRuns`'s bulk
  // `supersedeStaleQueuedRuns` step recognizes and supersedes them once
  // the reversal's own NEWER run exists. No clock gap is needed between
  // the commit and the reversal: an exact `created_at` tie (millisecond
  // resolution, easily hit here) is broken on insertion order (`rowid`),
  // never on the random-UUID id -- `tests/calc-003.test.ts` pins that.
  const context = {
    client: createSqliteSqlClient(database),
    userId: "user-a",
    requestId: "fold-in-request",
  };
  const result = await reverseImportWithContext(
    context,
    "batch-a",
    reversalInput(version, "fold-in-reverse"),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reversal.status, "reversed");
  assert.equal(result.reversal.rebuildJobIds.length, 1);
  const runId = result.reversal.rebuildJobIds[0]!;

  const run = database
    .prepare(`SELECT status FROM calculation_runs WHERE id = ?`)
    .get(runId) as { status: string } | undefined;
  assert.equal(
    run?.status,
    "completed",
    "the reversal's own queued run must already be advanced by the time the request returns",
  );

  const publication = database
    .prepare(
      `SELECT calculation_run_id FROM projection_publications
       WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a'`,
    )
    .get() as { calculation_run_id: string } | undefined;
  assert.equal(
    publication?.calculation_run_id,
    runId,
    "expected the projection publication to be current, pointing at the just-completed run",
  );

  const stillQueued = database
    .prepare(
      `SELECT count(*) AS count FROM calculation_runs
       WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a' AND status = 'queued'`,
    )
    .get() as { count: number };
  assert.equal(
    stillQueued.count,
    0,
    "no queued run should remain when the post-reversal budget suffices",
  );
});

test("reversal route enforces CSRF before its authenticated action and returns private progress", async () => {
  let calls = 0;
  const rejectedPost = createImportReversalPost(async () => {
    calls += 1;
    throw new Error("cross-site request reached the action");
  });
  const rejected = await rejectedPost(
    new Request("https://yield.example/api/import/commit/batch-a/reverse", {
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

  const { database, version } = await commitBatch(await migratedDatabase(), 1);
  const authenticatedPost = createImportReversalPost((batchId, value) =>
    reverseImportWithContext(
      {
        client: createSqliteSqlClient(database),
        userId: "user-a",
        requestId: "route-request",
      },
      batchId,
      value,
    ),
  );
  const response = await authenticatedPost(
    new Request("https://yield.example/api/import/commit/batch-a/reverse", {
      method: "POST",
      headers: {
        origin: "https://yield.example",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify(reversalInput(version, "route-reversal")),
    }),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = (await response.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test("one reversal invocation stays within D1 query, statement, and parameter budgets", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 2);
  const base = createSqliteSqlClient(database);
  let queries = 0;
  let statements = 0;
  let largestAtomicUnit = 0;
  let largestParameterCount = 0;
  const client: SqlClient = {
    async all(sql, params) {
      queries += 1;
      largestParameterCount = Math.max(
        largestParameterCount,
        params?.length ?? 0,
      );
      return base.all(sql, params);
    },
    async get(sql, params) {
      queries += 1;
      largestParameterCount = Math.max(
        largestParameterCount,
        params?.length ?? 0,
      );
      return base.get(sql, params);
    },
    async run(sql, params) {
      queries += 1;
      statements += 1;
      largestParameterCount = Math.max(
        largestParameterCount,
        params?.length ?? 0,
      );
      return base.run(sql, params);
    },
    async batch(batchStatements) {
      queries += batchStatements.length;
      statements += batchStatements.length;
      largestAtomicUnit = Math.max(largestAtomicUnit, batchStatements.length);
      largestParameterCount = Math.max(
        largestParameterCount,
        ...batchStatements.map((statement) => statement.params?.length ?? 0),
      );
      return base.batch!(batchStatements);
    },
  };
  const result = await createOwnedImportReversalRepository(client, {
    chunkSize: IMPORT_REVERSAL_LIMITS.maxChunkSize,
  }).reverse("user-a", "batch-a", reversalInput(version, "budget-reversal"));
  assert.equal(result.ok, true);
  assert.ok(
    queries <= IMPORT_REVERSAL_LIMITS.maxQueriesPerInvocation,
    `${queries} D1 queries`,
  );
  assert.ok(
    statements <= IMPORT_REVERSAL_LIMITS.maxStatementsPerInvocation,
    `${statements} D1 statements`,
  );
  assert.ok(
    largestAtomicUnit <= IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit,
  );
  assert.ok(
    largestParameterCount <= IMPORT_REVERSAL_LIMITS.maxParametersPerStatement,
  );
  assert.throws(
    () =>
      createOwnedImportReversalRepository(base, {
        chunkSize: IMPORT_REVERSAL_LIMITS.maxChunkSize + 1,
      }),
    /invalid_import_reversal_chunk_size/,
  );
});

// BUG-016 review B1 regression pin: before the fix, `finalize`'s single
// atomic `client.batch()` call grew by one `calculation_runs` INSERT per
// distinct dividend-bearing portfolio in the batch, with no LIMIT on the
// grouped SELECT driving it -- a batch spanning 6 dividend-bearing
// portfolios produced a 12-statement atomic unit against the 10-statement
// `maxStatementsPerAtomicUnit` ceiling. This fixture seeds a dividend-only,
// 6-portfolio batch (finalizing on the very first invocation -- no trades
// to chunk) and pins that the fixed atomic unit inside `finalize` itself
// stays exactly 6 statements (row flip, dividend flip, DIV-016C restore,
// delete, audit, batch-status) regardless of portfolio count, with the
// per-portfolio rebuild queueing issued as its OWN separate, bounded
// `client.batch()` call afterward.
function seedDividendBearingPortfolio(
  database: DatabaseSync,
  index: number,
): void {
  const portfolioId = `portfolio-div-${index}`;
  const membershipId = `membership-div-${index}`;
  database.exec(`
    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone,
      accounting_method, status, created_at, updated_at, version
    ) VALUES ('${portfolioId}', 'user-a', 'D${index}', 'Div ${index}', 'AUD',
      'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolio_securities (
      id, user_id, portfolio_id, security_id, source_symbol,
      source_currency_code, status, created_at, updated_at
    ) VALUES ('${membershipId}', 'user-a', '${portfolioId}', 'security-a',
      'ABC${index}', 'AUD', 'held', '2026-08-03', '2026-08-03');
    INSERT INTO dividend_manual_records (
      id, user_id, portfolio_id, portfolio_security_id, payment_date,
      shares_decimal, dividend_per_share_decimal,
      franking_credit_per_share_decimal, import_batch_id, source_reference,
      created_at, updated_at, version
    ) VALUES ('div-${index}', 'user-a', '${portfolioId}', '${membershipId}',
      '2026-08-10', '5', '0.5', NULL, 'batch-a', NULL, '2026-08-03',
      '2026-08-03', 1);
  `);
}

test("BUG-016 review B1: a finalizing reversal across 6 dividend-bearing portfolios keeps every atomic unit fixed-size, not data-controlled", async () => {
  const database = await migratedDatabase();
  const portfolioCount = 6;
  for (let index = 1; index <= portfolioCount; index += 1) {
    seedDividendBearingPortfolio(database, index);
  }
  // Dividend-only batch: no trade rows staged at all, so this batch commits
  // trivially and the very first reversal invocation is already finalizing
  // (`remainingTransactions` is 0 from the start).
  const { version } = await commitBatch(database, 0);
  const base = createSqliteSqlClient(database);
  const batchSizes: number[] = [];
  const client: SqlClient = {
    all: (sql, params) => base.all(sql, params),
    get: (sql, params) => base.get(sql, params),
    run: (sql, params) => base.run(sql, params),
    async batch(statements) {
      batchSizes.push(statements.length);
      return base.batch!(statements);
    },
  };
  const result = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version, "reverse-dividend-portfolios"),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "reversed");
  assert.equal(result.rebuildJobIds.length, portfolioCount);
  for (let index = 1; index <= portfolioCount; index += 1) {
    assert.ok(
      result.rebuildJobIds.includes(
        `import-reversal-rebuild:batch-a:portfolio-div-${index}`,
      ),
    );
  }
  assert.ok(
    batchSizes.every(
      (size) => size <= IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit,
    ),
    `every atomic unit must stay within the ${IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit}-statement budget, saw ${JSON.stringify(batchSizes)}`,
  );
  // Exactly two atomic calls: `finalize`'s own fixed 6-statement unit, then
  // ONE separate chunk queueing all 6 portfolios' rebuild rows (6 <=
  // maxStatementsPerAtomicUnit, so a single chunk suffices).
  assert.deepEqual(batchSizes, [6, portfolioCount]);
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM calculation_runs WHERE reason = 'import_reverse' AND user_id = 'user-a'",
        )
        .get() as { count: number }
    ).count,
    portfolioCount,
  );
});

/**
 * Instrumented `SqlClient` wrapper: counts D1 queries/statements, records
 * every atomic unit's size, and tracks the largest parameter list, exactly
 * as the trade-only budget test above does inline.
 */
function countingClient(base: SqlClient): {
  client: SqlClient;
  counts: {
    queries: number;
    statements: number;
    largestParameterCount: number;
    batchSizes: number[];
  };
} {
  const counts = {
    queries: 0,
    statements: 0,
    largestParameterCount: 0,
    batchSizes: [] as number[],
  };
  const client: SqlClient = {
    async all(sql, params) {
      counts.queries += 1;
      counts.largestParameterCount = Math.max(
        counts.largestParameterCount,
        params?.length ?? 0,
      );
      return base.all(sql, params);
    },
    async get(sql, params) {
      counts.queries += 1;
      counts.largestParameterCount = Math.max(
        counts.largestParameterCount,
        params?.length ?? 0,
      );
      return base.get(sql, params);
    },
    async run(sql, params) {
      counts.queries += 1;
      counts.statements += 1;
      counts.largestParameterCount = Math.max(
        counts.largestParameterCount,
        params?.length ?? 0,
      );
      return base.run(sql, params);
    },
    async batch(statements) {
      counts.queries += statements.length;
      counts.statements += statements.length;
      counts.batchSizes.push(statements.length);
      counts.largestParameterCount = Math.max(
        counts.largestParameterCount,
        ...statements.map((statement) => statement.params?.length ?? 0),
      );
      return base.batch!(statements);
    },
  };
  return { client, counts };
}

// BUG-016 review round-3 B1 regression pin (precedent: tests/imp-003a.test.ts's
// "commit touching exactly 25 distinct portfolios" test): the phase-2
// dividend-rebuild INSERTs are N extra statements on the SAME invocation, so
// the per-invocation budget has to be sized at the `maxAffectedPortfolios`
// ceiling, not at the trade-only path. The previous 56 bound was already
// exceeded at N=6 (56), N=7 (57), N=10 (60); N=25 -- the documented ceiling
// itself -- measures 75 queries / 50 statements. This pins BOTH bounds at
// exactly that ceiling, plus the atomic-unit bound the round-2 fix bought.
test("BUG-016 review B1: a finalizing reversal at exactly the 25-portfolio ceiling stays inside the per-invocation D1 budgets", async () => {
  const database = await migratedDatabase();
  const portfolioCount = IMPORT_REVERSAL_LIMITS.maxAffectedPortfolios;
  assert.equal(portfolioCount, 25);
  for (let index = 1; index <= portfolioCount; index += 1) {
    seedDividendBearingPortfolio(database, index);
  }
  // Two trades as well: `maxChunkSize` is 2, so this single finalizing
  // invocation carries the maximum trade work AND the maximum dividend work.
  const { version } = await commitBatch(database, 2);
  const { client, counts } = countingClient(createSqliteSqlClient(database));
  // PRF-009 BUG-016 follow-up (c): this fixture is the one that actually
  // REACHES `affectedPortfolioIdsForBatch`'s overflow branch (25 dividend
  // portfolios + the trade-bearing `portfolio-a` = 26, one past the
  // ceiling) -- `import.reverse.calculation_advance_overflow` was emitted
  // here but never asserted. Capture stdout the same way the dedicated
  // dividend-overflow test below does.
  const logLines: string[] = [];
  const originalLog = console.log;
  console.log = (line: unknown) => {
    logLines.push(String(line));
  };
  let result;
  try {
    result = await createOwnedImportReversalRepository(client, {
      chunkSize: IMPORT_REVERSAL_LIMITS.maxChunkSize,
    }).reverse("user-a", "batch-a", reversalInput(version, "ceiling-reversal"));
  } finally {
    console.log = originalLog;
  }
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "reversed");
  // 2 per-transaction `ledger_mutation` ids + one `import_reverse` id per
  // dividend-bearing portfolio.
  assert.equal(result.rebuildJobIds.length, 2 + portfolioCount);
  // BUG-016 round-4 B1: the batch-wide advance set is 25 dividend-bearing
  // portfolios PLUS the trade-bearing `portfolio-a` = 26, one past
  // `maxAffectedPortfolios` -- so this fixture also exercises the advance
  // set's never-fail-closed overflow degrade (log, keep the first N by id;
  // `portfolio-a` sorts first, so `portfolio-div-9` is the one dropped).
  assert.equal(
    result.affectedPortfolioIds.length,
    IMPORT_REVERSAL_LIMITS.maxAffectedPortfolios,
  );
  assert.equal(result.affectedPortfolioIds[0], "portfolio-a");
  assert.ok(!result.affectedPortfolioIds.includes("portfolio-div-9"));
  const advanceOverflowWarnings = logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (entry) => entry.action === "import.reverse.calculation_advance_overflow",
    );
  assert.equal(advanceOverflowWarnings.length, 1);
  assert.equal(advanceOverflowWarnings[0]!.level, "warn");
  assert.deepEqual(advanceOverflowWarnings[0]!.metadata, {
    batchId: "batch-a",
    affectedPortfolios: portfolioCount + 1,
    advancedPortfolios: IMPORT_REVERSAL_LIMITS.maxAffectedPortfolios,
  });
  assert.ok(
    counts.queries <= IMPORT_REVERSAL_LIMITS.maxQueriesPerInvocation,
    `${counts.queries} D1 queries at the ${portfolioCount}-portfolio ceiling exceeds the ${IMPORT_REVERSAL_LIMITS.maxQueriesPerInvocation} budget`,
  );
  assert.ok(
    counts.statements <= IMPORT_REVERSAL_LIMITS.maxStatementsPerInvocation,
    `${counts.statements} D1 statements at the ${portfolioCount}-portfolio ceiling exceeds the ${IMPORT_REVERSAL_LIMITS.maxStatementsPerInvocation} budget`,
  );
  assert.ok(
    counts.batchSizes.every(
      (size) => size <= IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit,
    ),
    `every atomic unit must stay within the ${IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit}-statement budget, saw ${JSON.stringify(counts.batchSizes)}`,
  );
  assert.ok(
    counts.largestParameterCount <=
      IMPORT_REVERSAL_LIMITS.maxParametersPerStatement,
  );
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM calculation_runs WHERE reason = 'import_reverse' AND user_id = 'user-a'",
        )
        .get() as { count: number }
    ).count,
    portfolioCount,
  );
});

// BUG-016 review round-3 fold-in: the overflow branch (more dividend-bearing
// portfolios than `maxAffectedPortfolios`) had no test at all. Unlike the
// commit side, a reversal must NEVER fail closed here -- the ledger is
// already reversed by the time this runs -- so overflow queues the first N
// portfolios by id, logs the rest as a structured warning naming the batch,
// and still reports the batch `reversed`.
test("BUG-016: a reversal over more dividend-bearing portfolios than the ceiling queues the first 25 by id, warns once, and still completes", async () => {
  const database = await migratedDatabase();
  const portfolioCount = IMPORT_REVERSAL_LIMITS.maxAffectedPortfolios + 1;
  for (let index = 1; index <= portfolioCount; index += 1) {
    seedDividendBearingPortfolio(database, index);
  }
  const { version } = await commitBatch(database, 0);
  const { client, counts } = countingClient(createSqliteSqlClient(database));
  const logLines: string[] = [];
  const originalLog = console.log;
  console.log = (line: unknown) => {
    logLines.push(String(line));
  };
  let result;
  try {
    result = await createOwnedImportReversalRepository(client).reverse(
      "user-a",
      "batch-a",
      reversalInput(version, "overflow-reversal"),
    );
  } finally {
    console.log = originalLog;
  }
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "reversed");

  // Exactly the first 25 portfolios, in `portfolio_id` order -- the SELECT
  // driving the queueing is `ORDER BY dmr.portfolio_id ASC LIMIT 26`, and the
  // slice keeps the leading 25. Ids sort lexically, so `portfolio-div-1`,
  // `portfolio-div-10`..`portfolio-div-19`, `portfolio-div-2`, ... and
  // `portfolio-div-9` is the one left out at N=26.
  const expectedPortfolioIds = Array.from(
    { length: portfolioCount },
    (_unused, index) => `portfolio-div-${index + 1}`,
  )
    .sort()
    .slice(0, IMPORT_REVERSAL_LIMITS.maxAffectedPortfolios);
  assert.deepEqual(
    result.rebuildJobIds,
    expectedPortfolioIds.map(
      (portfolioId) => `import-reversal-rebuild:batch-a:${portfolioId}`,
    ),
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT portfolio_id FROM calculation_runs
         WHERE user_id = 'user-a' AND reason = 'import_reverse'
         ORDER BY portfolio_id ASC`,
      )
      .all()
      .map((row) => String(row.portfolio_id)),
    expectedPortfolioIds,
  );

  // `finalize`'s own fixed 6-statement unit, then the 25 queued INSERTs
  // chunked at `maxStatementsPerAtomicUnit` (10 + 10 + 5).
  assert.deepEqual(counts.batchSizes, [
    6,
    IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit,
    IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit,
    IMPORT_REVERSAL_LIMITS.maxAffectedPortfolios -
      2 * IMPORT_REVERSAL_LIMITS.maxStatementsPerAtomicUnit,
  ]);

  const overflowWarnings = logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (entry) => entry.action === "import.reverse.dividend_rebuild_overflow",
    );
  assert.equal(overflowWarnings.length, 1);
  assert.equal(overflowWarnings[0]!.level, "warn");
  assert.deepEqual(overflowWarnings[0]!.metadata, {
    batchId: "batch-a",
    affectedPortfolios: portfolioCount,
    queuedPortfolios: IMPORT_REVERSAL_LIMITS.maxAffectedPortfolios,
  });
});

/** Captures every `all`/`get` call's exact SQL/params -- lets a test re-run
 * `EXPLAIN QUERY PLAN` on precisely what the real code path just executed
 * (the `tests/prf-002.test.ts` `stageCensusClient` / `tests/prf-010.test.ts`
 * `censusClient` convention), rather than a hand-copied literal that could
 * drift from the source. */
function capturingClient(base: SqlClient): {
  client: SqlClient;
  calls: Array<{ sql: string; params: readonly unknown[] | undefined }>;
} {
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> =
    [];
  const client: SqlClient = {
    async all(sql, params) {
      calls.push({ sql, params });
      return base.all(sql, params);
    },
    async get(sql, params) {
      calls.push({ sql, params });
      return base.get(sql, params);
    },
    run: (sql, params) => base.run(sql, params),
    batch: (statements) => base.batch!(statements),
  };
  return { client, calls };
}

// PRF-009 / BUG-016 follow-up (b): `affectedPortfolioIdsForBatch`'s
// `+source_row.user_id` no-index hint (added round-4, mirroring PRF-009
// fold-in (a)'s identical technique on the commit side) had no EXPLAIN or
// source pin proving it does what its own comment claims -- keep the
// planner off `import_rows_user_normalized_fingerprint_idx (user_id=?)`
// (a user-wide range covering every batch this owner has ever reversed)
// and onto the batch-scoped `import_rows_batch_physical_row_unique
// (batch_id=?)` seek instead. Seeded with 40 prior REVERSED batches (200
// rows) for user-a so a hint-less planner would have real user-wide history
// to prefer -- not just an empty table where either index looks free.
test("PRF-009 BUG-016 (b): affectedPortfolioIdsForBatch's +user_id hint keeps the planner on the batch-scoped seek, not a user-wide one", async () => {
  const database = await migratedDatabase();
  // Prior, already-fully-reversed batches: same shape (import_rows.commit_
  // status = 'reversed', matched via source_row.import_row_id) as the batch
  // under test, so they would be visible to a user-id-wide seek if the hint
  // were removed.
  for (let batch = 0; batch < 40; batch += 1) {
    const database_ = database;
    database_.exec(
      `INSERT INTO import_batches (id, user_id, target_portfolio_id, parser_format, parser_version, filename, byte_size, file_sha256, status, created_at, updated_at, version)
       VALUES ('batch-old-${batch}', 'user-a', 'portfolio-a', 'strict-versioned-csv', '${SUPPORTED_IMPORT_PARSER_VERSION}', 'old.csv', 100, 'sha-old-${batch}', 'ready', '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z', 1)`,
    );
    for (let row = 0; row < 5; row += 1) {
      const suffix = `${batch}-${row}`;
      database_.exec(
        `INSERT INTO import_rows (id, user_id, batch_id, physical_row_number, row_class, original_fields_json, normalized_fingerprint, target_portfolio_id, target_portfolio_security_id, commit_status, commit_transaction_id, created_at, updated_at, version)
         VALUES ('row-old-${suffix}', 'user-a', 'batch-old-${batch}', ${row + 2}, 'transaction', '[]', 'fp-old-${suffix}', 'portfolio-a', 'membership-a', 'staged', NULL, '2026-08-03', '2026-08-03', 1)`,
      );
      database_.exec(
        `INSERT INTO transactions (id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at, local_trade_date, currency_code, source_type, source_reference, import_row_id, created_by_user_id, calculation_version, created_at, version)
         VALUES ('tx-old-${suffix}', 'user-a', 'portfolio-a', 'membership-a', 'buy', 'reversed', '2026-08-01T00:00:00.000Z', '2026-08-01', 'AUD', 'csv_import', 'src-old-${suffix}', 'row-old-${suffix}', 'user-a', 1, '2026-08-03', 1)`,
      );
      database_.exec(
        `UPDATE import_rows SET commit_status = 'reversed', commit_transaction_id = 'tx-old-${suffix}' WHERE id = 'row-old-${suffix}'`,
      );
    }
  }
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM import_rows WHERE user_id = 'user-a' AND commit_status = 'reversed'",
        )
        .get() as { count: number }
    ).count,
    200,
    "prior reversed history must be seeded before the batch under test",
  );

  const { database: committed, version } = await commitBatch(database, 2);
  const { client, calls } = capturingClient(createSqliteSqlClient(committed));
  const result = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version, "explain-reversal"),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "reversed");

  const affectedPortfolioCall = calls.find((call) =>
    call.sql.includes("SELECT DISTINCT source.portfolio_id"),
  );
  assert.ok(
    affectedPortfolioCall,
    "expected affectedPortfolioIdsForBatch's query to have run",
  );
  const plan = committed
    .prepare(`EXPLAIN QUERY PLAN ${affectedPortfolioCall!.sql}`)
    .all(...((affectedPortfolioCall!.params ?? []) as never[])) as Array<{
    detail: string;
  }>;
  const details = plan.map((row) => row.detail);
  assert.ok(
    details.some((detail) =>
      /SEARCH source_row USING INDEX import_rows_batch_physical_row_unique \(batch_id=\?\)/.test(
        detail,
      ),
    ),
    `expected a batch-scoped seek, got: ${JSON.stringify(details)}`,
  );
  assert.ok(
    !details.some((detail) =>
      detail.includes("import_rows_user_normalized_fingerprint_idx"),
    ),
    `must not fall back to the user-wide index, got: ${JSON.stringify(details)}`,
  );

  // Mutation check: removing the hint on the SAME captured SQL/params must
  // NOT keep the batch-scoped plan -- whichever table the planner ends up
  // driving from (import_rows via its user-wide fingerprint index, or
  // transactions via its own user-wide idempotency index -- SQLite's choice
  // between the two is an implementation detail, not the point here), it
  // must stop being a `batch_id=?` seek. That is the regression the hint
  // exists to prevent.
  const unhinted = affectedPortfolioCall!.sql.replace(
    "+source_row.user_id = ?",
    "source_row.user_id = ?",
  );
  assert.notEqual(unhinted, affectedPortfolioCall!.sql);
  const unhintedPlan = committed
    .prepare(`EXPLAIN QUERY PLAN ${unhinted}`)
    .all(...((affectedPortfolioCall!.params ?? []) as never[])) as Array<{
    detail: string;
  }>;
  assert.ok(
    !unhintedPlan.some((row) =>
      /USING INDEX import_rows_batch_physical_row_unique \(batch_id=\?\)/.test(
        row.detail,
      ),
    ),
    `expected removing the hint to give up the batch-scoped seek, got: ${JSON.stringify(unhintedPlan.map((row) => row.detail))}`,
  );
});

// BUG-016 review round-3 B2 regression pin: `reverseImportWithContext` used
// to advance whatever `rebuildJobIds` came back from ANY invocation, so a
// chunked reversal (`maxChunkSize` is 2 -- the owner's 226-row batch is 113
// invocations) ran a full FIFO rebuild plus publish on EVERY chunk, against a
// ledger still mid-reversal. Measured across this 3-invocation fixture:
// 75/72/65 D1 queries ungated versus 46/45/65 gated, for an identical end
// state. The commit route it mirrors gates on the terminal status
// (`result.status === "committed"`); this pins the reversal's equivalent.
test("BUG-016 review B2: a chunked reversal advances calculation runs once, on the finalizing invocation only", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 6);
  // Same clock-gap rationale as the single-invocation fold-in test above:
  // keeps the commit's own now-stale runs from tying with the reversal's on
  // `created_at`.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const context = {
    client: createSqliteSqlClient(database),
    userId: "user-a",
    requestId: "chunked-fold-in-request",
  };
  const completedCount = () =>
    (
      database
        .prepare(
          `SELECT count(*) AS count FROM calculation_runs
           WHERE user_id = 'user-a' AND status = 'completed'`,
        )
        .get() as { count: number }
    ).count;

  const statuses: string[] = [];
  for (let invocation = 1; invocation <= 3; invocation += 1) {
    const result = await reverseImportWithContext(
      context,
      "batch-a",
      reversalInput(version, "chunked-fold-in"),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    statuses.push(result.reversal.status);
    if (invocation < 3) {
      assert.equal(
        completedCount(),
        0,
        `invocation ${invocation} is a non-final chunk and must not advance any calculation run`,
      );
    }
  }
  assert.deepEqual(statuses, ["reversing", "reversing", "reversed"]);

  // Exactly one advancement across the whole reversal.
  assert.equal(completedCount(), 1);
  const completedRunId = String(
    (
      database
        .prepare(
          `SELECT id FROM calculation_runs
           WHERE user_id = 'user-a' AND status = 'completed'`,
        )
        .get() as { id: string }
    ).id,
  );
  // Everything the earlier chunks queued is resolved, not stranded: the
  // finalizing call advances the whole projection pipeline for the portfolio,
  // superseding the older queued rows.
  assert.equal(
    (
      database
        .prepare(
          `SELECT count(*) AS count FROM calculation_runs
           WHERE user_id = 'user-a' AND status IN ('queued', 'running')`,
        )
        .get() as { count: number }
    ).count,
    0,
  );
  const publication = database
    .prepare(
      `SELECT calculation_run_id FROM projection_publications
       WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a'`,
    )
    .get() as { calculation_run_id: string } | undefined;
  assert.equal(
    publication?.calculation_run_id,
    completedRunId,
    "the publication must be current at the end of a chunked reversal, pointing at its single completed run",
  );
});

// BUG-016 round-4 B1 fixture: a batch whose trade rows span TWO portfolios,
// the second portfolio's rows physically LAST. Reversing at `maxChunkSize`
// (2) therefore fully reverses portfolio-a on the FIRST (non-final)
// invocation, leaving only portfolio-c's rows for the finalizing one -- so
// the finalizing invocation's own `rebuildJobIds` name portfolio-c ONLY.
// Portfolio resolution follows the `tests/imp-003a.test.ts` 25-portfolio
// precedent: a distinct source symbol per portfolio is what revalidation
// resolves the row's target from.
function seedSecondTradePortfolio(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO portfolios (
      id, user_id, code, name, base_currency_code, timezone,
      accounting_method, status, created_at, updated_at, version
    ) VALUES ('portfolio-c', 'user-a', 'C', 'Second', 'AUD',
      'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    INSERT INTO securities (
      id, canonical_name, asset_type, primary_currency_code, status,
      created_at, updated_at
    ) VALUES ('security-c', 'Gamma', 'equity', 'AUD', 'active', '2026-08-03',
      '2026-08-03');
    INSERT INTO portfolio_securities (
      id, user_id, portfolio_id, security_id, source_symbol,
      source_currency_code, status, created_at, updated_at
    ) VALUES ('membership-c', 'user-a', 'portfolio-c', 'security-c', 'XYZ',
      'AUD', 'held', '2026-08-03', '2026-08-03');
  `);
}

function stageTwoPortfolioRows(database: DatabaseSync): void {
  const insert = database.prepare(
    `INSERT INTO import_rows (
       id, user_id, batch_id, physical_row_number, row_class,
       original_fields_json, normalized_fields_json, normalized_fingerprint,
       validation_status, target_portfolio_id, target_portfolio_security_id,
       commit_status, created_at, updated_at, version
     ) VALUES (?, 'user-a', 'batch-a', ?, 'transaction', '[]', ?, ?, 'valid',
       ?, ?, 'staged', '2026-08-03', '2026-08-03', 1)`,
  );
  const targets = [
    ["portfolio-a", "membership-a", "ABC", "Alpha"],
    ["portfolio-a", "membership-a", "ABC", "Alpha"],
    ["portfolio-c", "membership-c", "XYZ", "Gamma"],
    ["portfolio-c", "membership-c", "XYZ", "Gamma"],
  ] as const;
  targets.forEach(([portfolioId, membershipId, symbol, name], index) => {
    const rowNumber = index + 2;
    insert.run(
      `row-${index + 1}`,
      rowNumber,
      JSON.stringify(normalized(rowNumber, { symbol, name })),
      `fingerprint-${index + 1}`,
      portfolioId,
      membershipId,
    );
  });
}

async function commitTwoPortfolioBatch(): Promise<{
  database: DatabaseSync;
  version: number;
}> {
  const database = await migratedDatabase();
  seedSecondTradePortfolio(database);
  stageTwoPortfolioRows(database);
  const committed = await commitStagedBatch(database);
  assert.deepEqual(
    database
      .prepare(
        `SELECT portfolio_id, count(*) AS count FROM transactions
         WHERE user_id = 'user-a' GROUP BY portfolio_id ORDER BY portfolio_id`,
      )
      .all()
      .map((row) => ({
        portfolioId: String(row.portfolio_id),
        count: Number(row.count),
      })),
    [
      { portfolioId: "portfolio-a", count: 2 },
      { portfolioId: "portfolio-c", count: 2 },
    ],
    "the fixture must actually span two portfolios",
  );
  // Same clock-gap rationale as the single-portfolio fold-in tests above:
  // keeps the commit's own now-stale runs from tying with the reversal's on
  // `created_at`.
  await new Promise((resolve) => setTimeout(resolve, 10));
  return committed;
}

function pipelineState(
  database: DatabaseSync,
  portfolioId: string,
): { pending: number; completed: number; publishedRunId: string | null } {
  const pending = (
    database
      .prepare(
        `SELECT count(*) AS count FROM calculation_runs
         WHERE user_id = 'user-a' AND portfolio_id = ?
           AND status IN ('queued', 'running')`,
      )
      .get(portfolioId) as { count: number }
  ).count;
  const completedRows = database
    .prepare(
      `SELECT id FROM calculation_runs
       WHERE user_id = 'user-a' AND portfolio_id = ? AND status = 'completed'`,
    )
    .all(portfolioId) as Array<{ id: string }>;
  const publication = database
    .prepare(
      `SELECT calculation_run_id FROM projection_publications
       WHERE user_id = 'user-a' AND portfolio_id = ?`,
    )
    .get(portfolioId) as { calculation_run_id: string } | undefined;
  return {
    pending,
    completed: completedRows.length,
    publishedRunId: publication ? String(publication.calculation_run_id) : null,
  };
}

/** Asserts a portfolio's projection pipeline is fully settled and current. */
function assertSettled(database: DatabaseSync, portfolioId: string): void {
  const state = pipelineState(database, portfolioId);
  assert.equal(
    state.pending,
    0,
    `${portfolioId} still has ${state.pending} queued/running calculation runs after the finalizing reversal`,
  );
  assert.equal(
    state.completed,
    1,
    `${portfolioId} must have exactly one completed run, saw ${state.completed}`,
  );
  assert.ok(
    state.publishedRunId,
    `${portfolioId} must have a projection publication`,
  );
  const completedId = (
    database
      .prepare(
        `SELECT id FROM calculation_runs
         WHERE user_id = 'user-a' AND portfolio_id = ? AND status = 'completed'`,
      )
      .get(portfolioId) as { id: string }
  ).id;
  assert.equal(
    state.publishedRunId,
    String(completedId),
    `${portfolioId}'s publication must point at its completed run`,
  );
}

// BUG-016 round-4 B1 regression pin (BLOCKING finding, reproduced): the
// finalizing invocation advanced `result.rebuildJobIds`, and
// `advanceCalculationRunsForCommit` resolves portfolios from THOSE ids only
// -- the finalizing chunk's own `ledger.reverse()` ids plus the dividend
// parity ids. A portfolio whose transactions were all reversed by an EARLIER
// chunk contributes no id, so it was never advanced in-request: against
// `5c656a4` this fixture left portfolio-a with 5 `queued` rows (its commit's
// `import_commit` run, two `ledger_mutation` rows from the commit's postings,
// and two more from the reversal) while portfolio-c completed normally.
// Fixed by advancing the BATCH's affected-portfolio set instead.
test("BUG-016 round-4 B1: a chunked reversal advances every portfolio the BATCH reversed, not just the finalizing chunk's own", async () => {
  const { database, version } = await commitTwoPortfolioBatch();
  const context = {
    client: createSqliteSqlClient(database),
    userId: "user-a",
    requestId: "two-portfolio-request",
  };

  const first = await reverseImportWithContext(
    context,
    "batch-a",
    reversalInput(version, "two-portfolio-reverse"),
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.reversal.status, "reversing");
  // The non-final chunk must still advance nothing at all (the round-3 B2
  // gate), even though it just reversed the whole of portfolio-a.
  assert.deepEqual(first.reversal.affectedPortfolioIds, []);
  assert.equal(
    (
      database
        .prepare(
          `SELECT count(*) AS count FROM calculation_runs
           WHERE user_id = 'user-a' AND status = 'completed'`,
        )
        .get() as { count: number }
    ).count,
    0,
    "a non-final chunk must not advance any calculation run",
  );

  const final = await reverseImportWithContext(
    context,
    "batch-a",
    reversalInput(version, "two-portfolio-reverse"),
  );
  assert.equal(final.ok, true);
  if (!final.ok) return;
  assert.equal(final.reversal.status, "reversed");
  // The defect in one line: the finalizing invocation's own ids name
  // portfolio-c only, while the batch reversed both portfolios.
  assert.deepEqual(
    database
      .prepare(
        `SELECT DISTINCT portfolio_id FROM calculation_runs
         WHERE user_id = 'user-a' AND id IN (${final.reversal.rebuildJobIds
           .map(() => "?")
           .join(",")})`,
      )
      .all(...final.reversal.rebuildJobIds)
      .map((row) => String(row.portfolio_id)),
    ["portfolio-c"],
  );
  assert.deepEqual(final.reversal.affectedPortfolioIds, [
    "portfolio-a",
    "portfolio-c",
  ]);

  assertSettled(database, "portfolio-a");
  assertSettled(database, "portfolio-c");
});

// BUG-016 round-4 F1 regression pin: a RESUMED finalizing invocation reverses
// nothing (the previous attempt's `ledger.reverse()` work is already durable
// in its own atomic units) and therefore returns NO run ids of its own, so
// the old id-addressed advancement did nothing whatsoever -- both portfolios
// stayed queued. The batch's affected-portfolio set does not depend on what
// this invocation happened to do, so the resumed call still settles both.
test("BUG-016 round-4 F1: a resumed finalizing reversal, with no run ids of its own, still advances every portfolio the batch reversed", async () => {
  const { database, version } = await commitTwoPortfolioBatch();
  const base = createSqliteSqlClient(database);
  const context = {
    client: base,
    userId: "user-a",
    requestId: "resumed-finalize-request",
  };
  const input = reversalInput(version, "resumed-finalize");

  const first = await reverseImportWithContext(context, "batch-a", input);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.reversal.status, "reversing");

  // Fail the finalizing invocation inside `finalize`'s own atomic unit --
  // AFTER its `ledger.reverse()` calls have already committed portfolio-c's
  // reversals in their own units. `finalize` is the only atomic unit that
  // touches `import_rows`.
  let injected = 0;
  const failingClient: SqlClient = {
    ...base,
    async batch(statements) {
      if (
        statements.some((statement) => /UPDATE import_rows/.test(statement.sql))
      ) {
        injected += 1;
        throw new Error("injected D1 failure inside finalize");
      }
      return base.batch!(statements);
    },
  };
  const interrupted = await reverseImportWithContext(
    { ...context, client: failingClient },
    "batch-a",
    input,
  );
  assert.equal(injected, 1);
  assert.deepEqual(interrupted, {
    ok: false,
    status: 503,
    message:
      "The import reversal is still in progress and can be resumed safely.",
    impacts: undefined,
  });
  assert.equal(
    (
      database
        .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
        .get() as { status: string }
    ).status,
    "reversing",
  );

  const resumed = await reverseImportWithContext(context, "batch-a", input);
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.reversal.status, "reversed");
  assert.equal(
    resumed.reversal.reversedTransactions,
    0,
    "a resumed finalizing invocation reverses nothing of its own",
  );
  assert.deepEqual(
    resumed.reversal.rebuildJobIds,
    [],
    "...and so returns no run ids of its own -- the id-addressed advancement had nothing to work with",
  );
  assert.deepEqual(resumed.reversal.affectedPortfolioIds, [
    "portfolio-a",
    "portfolio-c",
  ]);

  assertSettled(database, "portfolio-a");
  assertSettled(database, "portfolio-c");
});

test("reversal resumes after a bounded failure and corrected upload supersedes only reversed batches", async () => {
  const { database, version } = await commitBatch(await migratedDatabase(), 3);
  const client = createSqliteSqlClient(database);
  const failed = await createOwnedImportReversalRepository(client, {
    failAtTransaction: 0,
  }).reverse("user-a", "batch-a", reversalInput(version, "reverse-b"));
  assert.deepEqual(failed, {
    ok: false,
    reason: "injected_failure",
    resumable: true,
  });
  assert.equal(
    (
      database
        .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
        .get() as { status: string }
    ).status,
    "reversing",
  );
  const first = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version, "reverse-b"),
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.status, "reversing");
  assert.equal(first.remainingTransactions, 1);
  const completed = await createOwnedImportReversalRepository(client).reverse(
    "user-a",
    "batch-a",
    reversalInput(version, "reverse-b"),
  );
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  assert.equal(completed.status, "reversed");

  const corrected = await createOwnedImportStagingRepository(
    client,
  ).startUpload("user-a", {
    targetPortfolioId: "portfolio-a",
    supersedesBatchId: "batch-a",
    parserFormat: "strict-versioned-csv",
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "corrected.csv",
    byteSize: 120,
    fileSha256: "file-corrected",
  });
  assert.equal(corrected.ok, true);
  if (!corrected.ok) return;
  assert.equal(corrected.batch.supersedesBatchId, "batch-a");
  assert.equal(corrected.batch.targetPortfolioId, "portfolio-a");
  const crossUser = await createOwnedImportStagingRepository(
    client,
  ).startUpload("user-b", {
    supersedesBatchId: "batch-a",
    parserFormat: "strict-versioned-csv",
    parserVersion: SUPPORTED_IMPORT_PARSER_VERSION,
    filename: "wrong-owner.csv",
    byteSize: 120,
    fileSha256: "file-wrong-owner",
  });
  assert.deepEqual(crossUser, { ok: false, reason: "not_found" });
});

// IMP-010B honest flip: the upload request body moved from
// `multipart/form-data` (read via `request.formData()`/`form.get(...)`) to
// browser-parsed JSON (read via `readJsonBody`/`supersedesBatchIdFromImportBody`
// -- see `app/import-request-body.ts`), since the server no longer reads a
// raw CSV file at all. The corrected-batch-reference forwarding this test
// pins is otherwise unchanged: `supersedesBatchId` is still read from the
// request and still forwarded as `supersedesBatchId || null` into
// `startUpload`.
test("corrected upload action forwards the superseded batch reference", async () => {
  const source = await readFile(
    new URL("../app/import-actions.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /supersedesBatchIdFromImportBody\(read\.body\)/);
  assert.match(source, /supersedesBatchId: supersedesBatchId \|\| null/);
});
