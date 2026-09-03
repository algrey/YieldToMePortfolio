import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createImportReadyPost } from "../app/import-ready-route.ts";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import {
  buildImportReviewPreview,
  type ImportReviewPreview,
} from "../app/import-preview.ts";
import {
  capExistingTradeRows,
  MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,
} from "../app/import-trade-duplicate-check.ts";
import {
  capExistingDividendRows,
  MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
} from "../app/import-dividend-duplicate-check.ts";
import { capSuppressionReferenceRows } from "../app/import-suppression-cap.ts";
// BUG-013 review round (ruling 2): the exported, exception-safe wrapper --
// mirrors `app/import-actions.ts`'s own fix, since this mirror faithfully
// copied that call site's unguarded form before the fix.
import { safeComputeDividendCashTotal } from "../domain/imports/reconciliation.ts";
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
import type {
  ImportPreviewExistingDividendEntry,
  ImportPreviewExistingTradeEntry,
} from "../domain/imports/reconciliation.ts";

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

// DIV-004 (B2 regression, review round 1): mirrors `currentPreviewVersion`
// exactly, EXCEPT it also loads existing owner-typed dividend facts and
// supplies them as `existingDividendEntries` -- replicating the real
// page/refresh preview path (`app/import-actions.ts`'s `loadReview`), the
// ONLY caller that populates this field. Every other caller in this test
// file (`currentPreviewVersion`, used by the ready-service and commit-
// revalidation call sites under test) omits it, exactly like the real
// `import-ready-service.ts`/`import-commit.ts`. Before the B1 fix (DIV-004
// review round 1 BLOCKING), the two helpers' `previewVersion` values
// diverged whenever a DIVIDEND_NEAR_EXISTING_ENTRY warning fired, because
// the hash included the full, unfiltered preview; after the fix, the
// warning is excluded from the hash by construction, so the two helpers
// must always agree.
//
// BUG-011 review round F3/F-a: also mirrors `loadReview`'s existing-trade
// query (`existingTradeEntries`), including the F1 fix
// (`reverses_transaction_id IS NULL`, excluding a reversal's compensating
// mirror row) -- the real query's wiring had zero DB-level test coverage
// before this round. Deliberately USER-WIDE, matching the F2 ruling
// correction (a batch's target portfolio is not the only portfolio a
// staged row can resolve into -- see `docs/CSV_IMPORT_SPEC.md`'s "F2
// RULING CORRECTION" note). The cap/degrade decision itself is genuinely
// byte-for-byte with production: both this mirror and `loadReview` call
// the SAME pure `capExistingTradeRows` with the SAME
// `MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK` constant from
// `app/import-trade-duplicate-check.ts` (importable directly -- it has no
// `next/headers` dependency, unlike `app/import-actions.ts` itself). Only
// the raw SQL text is duplicated, which `tests/bug-011.test.ts`'s
// source-pin test guards separately.
//
// BUG-013: also mirrors `loadReview`'s WIDENED dividend_manual_records query
// (no longer `import_batch_id IS NULL`-scoped -- that filter was this bug's
// confirmed root cause) plus the same amount/franking/currency columns and
// the same cap/degrade decision (`capExistingDividendRows`, an alias of the
// identical `capExistingTradeRows` function, with its own
// `MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK` constant). Per this
// task's own lesson (do not let a test mirror re-implement the production
// query with no independent check), `tests/bug-013.test.ts` pins the actual
// `app/import-actions.ts` SQL text separately.
async function pagePreview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch) throw new Error("expected batch to exist");
  const [
    rows,
    issues,
    mappings,
    portfolios,
    candidateRows,
    existingManualRows,
    existingReceiptRows,
    existingSourceReferenceRows,
    existingTradeSourceReferenceRows,
    existingTradeRows,
  ] = await Promise.all([
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
    client.all<Record<string, unknown>>(
      `SELECT portfolio_security_id, payment_date, shares_decimal,
              dividend_per_share_decimal, franking_credit_per_share_decimal,
              total_cash_decimal, total_franking_decimal, currency_code
       FROM dividend_manual_records
       WHERE user_id = ? AND superseded_by_record_id IS NULL
       LIMIT ?`,
      [userId, MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK + 1],
    ),
    client.all<Record<string, unknown>>(
      `SELECT portfolio_security_id, payment_date FROM dividend_receipts
       WHERE user_id = ?
       LIMIT ?`,
      [userId, MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK + 1],
    ),
    // BUG-013 review round (ruling 1): mirrors `loadReview`'s
    // `existingSourceReferenceRows`/`existingTradeSourceReferenceRows`
    // queries, used to suppress a guaranteed-noise advisory warning for a
    // row already bound for an identical commit-time exact-match skip.
    // PRF-009 follow-up ("fail-open cap"): now bounded with `LIMIT MAX + 1`,
    // same as `loadReview` -- see `tests/bug-013.test.ts`'s source pin for
    // the production wiring this mirrors.
    client.all<Record<string, unknown>>(
      `SELECT portfolio_id, source_reference FROM dividend_manual_records
       WHERE user_id = ? AND source_reference IS NOT NULL
       LIMIT ?`,
      [userId, MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK + 1],
    ),
    client.all<Record<string, unknown>>(
      `SELECT portfolio_id, source_reference FROM transactions
       WHERE user_id = ? AND source_type = 'csv_import' AND source_reference IS NOT NULL
       LIMIT ?`,
      [userId, MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK + 1],
    ),
    // PRF-009 fold-in (a): `+reverses_transaction_id IS NULL` mirrors
    // `loadReview`'s own no-index hint (see `tests/bug-011.test.ts`'s
    // widened F-a source pin) -- semantics unchanged, only the planner's
    // index choice differs, so this mirror stays behaviourally identical.
    client.all<Record<string, unknown>>(
      `SELECT portfolio_security_id, type, local_trade_date,
              quantity_decimal, unit_price_decimal
       FROM transactions
       WHERE user_id = ? AND status = 'posted'
         AND type IN ('buy', 'sell') AND +reverses_transaction_id IS NULL
         AND portfolio_security_id IS NOT NULL
         AND quantity_decimal IS NOT NULL AND unit_price_decimal IS NOT NULL
       LIMIT ?`,
      [userId, MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK + 1],
    ),
  ]);
  const cappedManualDividendRows = capExistingDividendRows(
    existingManualRows,
    MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
  );
  const cappedReceiptDividendRows = capExistingDividendRows(
    existingReceiptRows,
    MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
  );
  const existingDividendEntriesUnavailable =
    cappedManualDividendRows.unavailable ||
    cappedReceiptDividendRows.unavailable;
  const existingDividendEntries: ImportPreviewExistingDividendEntry[] =
    existingDividendEntriesUnavailable
      ? []
      : [
          ...cappedManualDividendRows.entries.map((row) => ({
            portfolioSecurityId: String(row.portfolio_security_id),
            paymentDate: String(row.payment_date),
            cashTotalDecimal: safeComputeDividendCashTotal({
              totalCashDecimal:
                row.total_cash_decimal === null
                  ? null
                  : String(row.total_cash_decimal),
              sharesDecimal:
                row.shares_decimal === null ? null : String(row.shares_decimal),
              dividendPerShareDecimal:
                row.dividend_per_share_decimal === null
                  ? null
                  : String(row.dividend_per_share_decimal),
            }),
            frankingTotalDecimal: safeComputeDividendCashTotal({
              totalCashDecimal:
                row.total_franking_decimal === null
                  ? null
                  : String(row.total_franking_decimal),
              sharesDecimal:
                row.shares_decimal === null ? null : String(row.shares_decimal),
              dividendPerShareDecimal:
                row.franking_credit_per_share_decimal === null
                  ? null
                  : String(row.franking_credit_per_share_decimal),
            }),
            currencyCode:
              row.currency_code === null ? null : String(row.currency_code),
          })),
          ...cappedReceiptDividendRows.entries.map((row) => ({
            portfolioSecurityId: String(row.portfolio_security_id),
            paymentDate: String(row.payment_date),
          })),
        ];
  const cappedTradeRows = capExistingTradeRows(
    existingTradeRows,
    MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,
  );
  const existingTradeEntries: ImportPreviewExistingTradeEntry[] =
    cappedTradeRows.entries.map((row) => ({
      portfolioSecurityId: String(row.portfolio_security_id),
      type: String(row.type) as "buy" | "sell",
      tradeDate: String(row.local_trade_date),
      quantityDecimal: String(row.quantity_decimal),
      priceDecimal: String(row.unit_price_decimal),
    }));
  const existingDividendSourceReferences = new Set(
    capSuppressionReferenceRows(
      existingSourceReferenceRows,
      MAX_EXISTING_DIVIDEND_ENTRIES_FOR_DUPLICATE_CHECK,
    ).rows.map(
      (row) => `${String(row.portfolio_id)}::${String(row.source_reference)}`,
    ),
  );
  const existingTradeSourceReferences = new Set(
    capSuppressionReferenceRows(
      existingTradeSourceReferenceRows,
      MAX_EXISTING_TRADE_ENTRIES_FOR_DUPLICATE_CHECK,
    ).rows.map(
      (row) => `${String(row.portfolio_id)}::${String(row.source_reference)}`,
    ),
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
    existingDividendEntries,
    existingDividendEntriesUnavailable,
    existingDividendSourceReferences,
    existingTradeEntries,
    existingTradeEntriesUnavailable: cappedTradeRows.unavailable,
    existingTradeSourceReferences,
  });
  return review;
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

function dividendNormalizedRow(paymentDate: string, dividendPerShare: string) {
  const base = normalizedRow();
  return {
    ...base,
    id: "source-div-1",
    sharesOwned: "5",
    costPerShare: dividendPerShare,
    commission: "0",
    transactionDate: `${paymentDate} GMT+1000`,
    purchaseExchangeRate: null,
    type: "dividend",
    tradeAtUtc: `${paymentDate}T00:00:00.000Z`,
    localTradeDate: paymentDate,
  };
}

// DIV-004 B2 (review round 1 blocking regression): before the B1 fix, this
// test fails at the `pageReviewBeforeReady.previewVersion` equality
// assertion below -- the page path's hash included the
// DIVIDEND_NEAR_EXISTING_ENTRY warning issue while the ready-service/
// commit-revalidation paths' hash (computed without
// `existingDividendEntries`) did not, so the two previewVersions diverged
// and `markImportReadyWithContext` (which recomputes independently and
// compares against the caller-supplied version) rejected the page's version
// with a 409 forever -- no combination of resupplied versions could recover,
// since EVERY non-page path always recomputes without the warning. After the
// fix, `DIVIDEND_NEAR_EXISTING_ENTRY` is excluded from the hash input by
// construction, so every path's previewVersion agrees regardless of whether
// the warning fires.
test("DIV-004 B2: a dividend row near an existing owner-typed manual record warns in the page preview, never blocks readiness, and BOTH markImportReadyWithContext and commit succeed using the page's previewVersion", async () => {
  const database = await migratedDatabase();
  // Pre-existing OWNER-typed manual record (import_batch_id IS NULL) for
  // membership-a, 4 days before the incoming dividend row's payment date --
  // inside DIV-001's PROXIMITY_WINDOW_DAYS (7).
  database.exec(`
    INSERT INTO dividend_manual_records (
      id, user_id, portfolio_id, portfolio_security_id, payment_date,
      shares_decimal, dividend_per_share_decimal, franking_credit_per_share_decimal,
      import_batch_id, source_reference, created_at, updated_at, version
    ) VALUES ('existing-manual-1', 'user-a', 'portfolio-a', 'membership-a', '2026-08-01',
      '5', '0.50', NULL, NULL, NULL, '2026-08-01', '2026-08-01', 1);
  `);
  stageRow(
    database,
    "batch-a",
    "row-div",
    dividendNormalizedRow("2026-08-05", "0.50"),
  );
  const client = createSqliteSqlClient(database);
  const context = { client, userId: "user-a" };

  // Page path (WITH existingDividendEntries): the warning must be present
  // and readiness must be unaffected by it.
  const pageReviewBeforeReady = await pagePreview(client, "user-a", "batch-a");
  const warning = pageReviewBeforeReady.preview.issues.find(
    (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
  );
  assert.ok(
    warning,
    "expected a near-existing-entry warning on the page preview",
  );
  assert.equal(warning!.severity, "warning");
  assert.equal(pageReviewBeforeReady.preview.ready, true);

  // "Other path" (no existingDividendEntries, matching
  // import-ready-service.ts/import-commit.ts exactly): must still agree on
  // previewVersion even though its own computed preview has no warning
  // issue at all.
  const otherPathVersionBeforeReady = await currentPreviewVersion(
    client,
    "user-a",
    "batch-a",
  );
  assert.equal(
    pageReviewBeforeReady.previewVersion,
    otherPathVersionBeforeReady,
    "the page's previewVersion (warning included pre-hash) must match the ready-service's (warning never computed) -- the B1 regression guard",
  );

  // markImportReadyWithContext internally recomputes WITHOUT
  // existingDividendEntries and compares against whatever the caller
  // supplied. Using the PAGE's version here is the exact scenario that
  // 409'd forever before the B1 fix.
  const ready = await markImportReadyWithContext(context, "batch-a", {
    expectedVersion: 1,
    expectedPreviewVersion: pageReviewBeforeReady.previewVersion,
  });
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  assert.equal(ready.review.batch.status, "ready");
  const readyVersion = ready.review.batch.version;

  // Re-derive the page's preview AFTER the ready transition (the batch
  // version -- embedded as the previewVersion prefix -- changed) and confirm
  // it still matches commit's own independent revalidation before using it
  // to commit.
  const pageReviewAfterReady = await pagePreview(client, "user-a", "batch-a");
  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", "batch-a");
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(
    pageReviewAfterReady.previewVersion,
    validated.previewVersion,
    "the page's previewVersion must still match commit's own revalidation after the ready transition",
  );

  const commitInput: ImportCommitInput = {
    expectedVersion: readyVersion,
    expectedPreviewVersion: pageReviewAfterReady.previewVersion,
    idempotencyKey: "imp-004a-div-004-commit",
    confirmation: true,
    requestId: "imp-004a-div-004-commit-request",
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
  if (commitResult.ok) assert.equal(commitResult.status, "committed");

  const manualRecordCount = database
    .prepare(
      `SELECT COUNT(*) as count FROM dividend_manual_records
       WHERE user_id = 'user-a' AND portfolio_security_id = 'membership-a'`,
    )
    .get() as { count: number };
  assert.equal(
    manualRecordCount.count,
    2,
    "the pre-existing owner-typed record and the newly imported one both persist -- the warning never blocked or deduplicated anything at commit time",
  );
});

// ---------------------------------------------------------------------------
// BUG-011 review round F1/F3: DB-level coverage for `loadReview`'s
// existing-trade query wiring (`app/import-actions.ts`), which the original
// task's pure-function tests (`tests/bug-011.test.ts`) never exercised.
// ---------------------------------------------------------------------------

test("BUG-011 F1 regression: after a trade is committed then reversed, re-staging the IDENTICAL trade does not raise TRADE_NEAR_EXISTING_ENTRY -- the reversal's compensating mirror row (itself status='posted') must be excluded, not just the original now-'reversed' row", async () => {
  const database = await migratedDatabase();
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
  const readyVersion = ready.review.batch.version;

  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", "batch-a");
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: readyVersion,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "bug-011-f1-commit",
    confirmation: true,
    requestId: "bug-011-f1-commit-request",
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

  const committedBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    "batch-a",
  );
  assert.ok(committedBatch);
  const reversalRepo = createOwnedImportReversalRepository(client);
  let reversed = await reversalRepo.reverse("user-a", "batch-a", {
    expectedVersion: committedBatch!.version,
    idempotencyKey: "bug-011-f1-reverse",
    confirmation: true,
    requestId: "bug-011-f1-reverse-request",
  });
  for (
    let attempt = 0;
    attempt < 10 && (!reversed.ok || reversed.status !== "reversed");
    attempt += 1
  ) {
    assert.equal(reversed.ok, true);
    reversed = await reversalRepo.reverse("user-a", "batch-a", {
      expectedVersion: committedBatch!.version,
      idempotencyKey: "bug-011-f1-reverse",
      confirmation: true,
      requestId: "bug-011-f1-reverse-request",
    });
  }
  assert.equal(reversed.ok, true);

  // Sanity check on the fixture itself: the compensating mirror row this
  // test guards against genuinely exists, is itself `status = 'posted'`,
  // and carries `reverses_transaction_id` -- exactly the shape F1's finding
  // described (`ledger.reverse()` re-runs `prepareLedgerPosting` on the
  // ORIGINAL input).
  const mirror = database
    .prepare(
      `SELECT status, reverses_transaction_id FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = 'membership-a'
         AND reverses_transaction_id IS NOT NULL`,
    )
    .get() as { status: string; reverses_transaction_id: string } | undefined;
  assert.ok(mirror, "expected a compensating reversal mirror row");
  assert.equal(
    mirror?.status,
    "posted",
    "the mirror row is itself posted -- status='posted' alone cannot exclude it",
  );

  // Re-stage the IDENTICAL trade in a brand-new batch -- exactly BUG-011's
  // own step-2 remediation path (reverse the duplicate batch, then
  // re-import).
  database.exec(`
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-reimport', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION}', 'sample2.csv', 100, 'file-b', 'parsed',
      '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', 1);
  `);
  stageRow(database, "batch-reimport", "row-reimport", normalizedRow());
  const reimportReview = await pagePreview(client, "user-a", "batch-reimport");
  const warning = reimportReview.preview.issues.find(
    (issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY",
  );
  assert.equal(
    warning,
    undefined,
    "F1: a genuinely reverse-then-re-import trade must not be flagged as a duplicate of its own now-reversed self",
  );
});

test("BUG-011 F3 ownership isolation: the existing-trade query never returns another owner's posted trades, even when they share an identical economic identity", async () => {
  const database = await migratedDatabase();
  // A second owner's membership, sharing the SAME underlying security as
  // user-a's `membership-a` (id/economic identity is what must stay
  // isolated -- reusing the same security is deliberate, to make a leak
  // observable rather than trivially prevented by an unrelated security).
  database.exec(`
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-c', 'user-b', 'portfolio-b', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-10', '2026-08-10');
    INSERT INTO transactions (
      id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at,
      local_trade_date, quantity_decimal, unit_price_decimal, currency_code,
      fee_amount_decimal, tax_amount_decimal, source_type, created_by_user_id,
      calculation_version, created_at, version
    ) VALUES
      ('txn-user-a', 'user-a', 'portfolio-a', 'membership-a', 'buy', 'posted',
        '2026-08-01T00:00:00Z', '2026-08-01', '5', '10', 'AUD', '0', '0',
        'manual', 'user-a', 1, '2026-08-01', 1),
      ('txn-user-b', 'user-b', 'portfolio-b', 'membership-c', 'buy', 'posted',
        '2026-08-01T00:00:00Z', '2026-08-01', '5', '10', 'AUD', '0', '0',
        'manual', 'user-b', 1, '2026-08-01', 1);
  `);
  const client = createSqliteSqlClient(database);

  const query = `SELECT portfolio_security_id, type, local_trade_date,
                        quantity_decimal, unit_price_decimal
                 FROM transactions
                 WHERE user_id = ? AND portfolio_id = ? AND status = 'posted'
                   AND type IN ('buy', 'sell') AND reverses_transaction_id IS NULL
                   AND portfolio_security_id IS NOT NULL
                   AND quantity_decimal IS NOT NULL AND unit_price_decimal IS NOT NULL`;

  const forUserA = await client.all<Record<string, unknown>>(query, [
    "user-a",
    "portfolio-a",
  ]);
  assert.equal(forUserA.length, 1);
  assert.equal(forUserA[0]?.portfolio_security_id, "membership-a");

  const forUserB = await client.all<Record<string, unknown>>(query, [
    "user-b",
    "portfolio-b",
  ]);
  assert.equal(forUserB.length, 1);
  assert.equal(forUserB[0]?.portfolio_security_id, "membership-c");

  // Full-pipeline confirmation: staging the SAME economic identity for
  // user-a warns from user-a's OWN trade, never user-b's.
  stageRow(database, "batch-a", "row-1", normalizedRow());
  const review = await pagePreview(client, "user-a", "batch-a");
  const warning = review.preview.issues.find(
    (issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY",
  );
  assert.ok(warning, "expected user-a's own posted trade to raise the warning");
});

test("BUG-011 F2 ruling correction regression: a row that resolves via a MAPPING DECISION into a DIFFERENT portfolio than the batch's own target still raises TRADE_NEAR_EXISTING_ENTRY -- proves the comparison set is genuinely user-wide, not silently scoped to batch.targetPortfolioId", async () => {
  const database = await migratedDatabase();
  // A second portfolio owned by the SAME owner (user-a), distinct from
  // batch-a's own target (portfolio-a) -- exactly the reviewer's repro
  // shape. `portfolioFor` (domain/imports/reconciliation.ts) can resolve a
  // row into ANY of the owner's portfolios via a `kind:"portfolio"` mapping
  // decision, not only the batch's own target.
  database.exec(`
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a2', 'user-a', 'A2', 'Secondary', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-10', '2026-08-10', 1);
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a2', 'user-a', 'portfolio-a2', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-10', '2026-08-10');
    INSERT INTO transactions (
      id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at,
      local_trade_date, quantity_decimal, unit_price_decimal, currency_code,
      fee_amount_decimal, tax_amount_decimal, source_type, created_by_user_id,
      calculation_version, created_at, version
    ) VALUES ('txn-portfolio-a2', 'user-a', 'portfolio-a2', 'membership-a2', 'buy', 'posted',
      '2026-08-01T00:00:00Z', '2026-08-01', '5', '10', 'AUD', '0', '0',
      'manual', 'user-a', 1, '2026-08-01', 1);
  `);
  const client = createSqliteSqlClient(database);

  // batch-a's OWN target is portfolio-a (per migratedDatabase's fixture),
  // but a `kind:"portfolio"` mapping decision redirects the row's source
  // portfolio name ("Main", from `normalizedRow()`) to portfolio-a2 --
  // `saveImportMappingAction` accepts any owned `targetId`, so this is a
  // real, owner-reachable affordance, not a hypothetical.
  await createOwnedImportMappingDecisionRepository(client).save("user-a", {
    batchId: "batch-a",
    kind: "portfolio",
    sourceKey: "Main",
    normalizedSourceValue: "Main",
    targetId: "portfolio-a2",
    targetValue: null,
    scope: "batch",
    confidence: "user",
    source: "user",
  });
  stageRow(database, "batch-a", "row-1", normalizedRow());

  const review = await pagePreview(client, "user-a", "batch-a");
  const warning = review.preview.issues.find(
    (issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY",
  );
  assert.ok(
    warning,
    "the row resolves into portfolio-a2 (not batch-a's own target, portfolio-a) and must still be compared against portfolio-a2's existing trade -- a query scoped to batch.targetPortfolioId would silently miss this and produce a false negative",
  );
});

// ---------------------------------------------------------------------------
// BUG-013: the same cross-route double-commit gap, on dividends.
// ---------------------------------------------------------------------------

test("BUG-013 filter fix: a previously import-sourced dividend record (import_batch_id NOT NULL, simulating a prior CSV import) is now visible to the cross-route check -- the confirmed root-cause filter bug", async () => {
  const database = await migratedDatabase();
  // Simulates a distribution already committed via a PRIOR CSV import (any
  // batch other than the one about to be previewed) -- import_batch_id is
  // NOT NULL, exactly the row shape the old `import_batch_id IS NULL` filter
  // made invisible to both DIVIDEND_NEAR_EXISTING_ENTRY and this check.
  database.exec(`
    INSERT INTO dividend_manual_records (
      id, user_id, portfolio_id, portfolio_security_id, payment_date,
      shares_decimal, dividend_per_share_decimal, franking_credit_per_share_decimal,
      import_batch_id, source_reference, created_at, updated_at, version
    ) VALUES ('existing-imported-1', 'user-a', 'portfolio-a', 'membership-a', '2026-08-05',
      '5', '0.50', NULL, 'prior-batch-csv', 'import-fingerprint:prior-csv-row', '2026-08-01', '2026-08-01', 1);
  `);
  // Incoming row: same security, same payment date, same cash total
  // (5 x 0.50 = 2.50) -- arriving via a SECOND route/batch (Sharesight sync,
  // in the real defect) for the SAME real distribution.
  stageRow(
    database,
    "batch-a",
    "row-div",
    dividendNormalizedRow("2026-08-05", "0.50"),
  );
  const client = createSqliteSqlClient(database);

  const review = await pagePreview(client, "user-a", "batch-a");
  const warning = review.preview.issues.find(
    (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
  );
  assert.ok(
    warning,
    "an import-sourced (not owner-typed) existing dividend record must now be visible to the cross-route check -- before the fix, import_batch_id IS NULL made it invisible and this warning never fired",
  );
  assert.equal(review.preview.ready, true, "advisory only -- never blocks");

  // The pre-existing proximity check must ALSO now see this same
  // previously-invisible record (same widened query feeds both).
  const proximityWarning = review.preview.issues.find(
    (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
  );
  assert.ok(
    proximityWarning,
    "DIV-004's proximity check reuses the same widened existingDividendEntries and must also now see this import-sourced record",
  );
});

test("BUG-013 ownership isolation: the widened dividend query never returns another owner's dividend records, even when they share an identical economic identity", async () => {
  // Review round (ruling 5): re-typing the widened SELECT a THIRD time (this
  // file's `pagePreview` mirror already carries it once, matching
  // `app/import-actions.ts` once) added a third copy to drift out of sync,
  // and only ever checked the POSITIVE case (user-a warns) -- which a leaked
  // cross-user match could equally satisfy, so it never actually proved
  // isolation. Rewritten to go entirely through `pagePreview` (the SAME
  // widened-query mirror `tests/bug-013.test.ts`'s source pin verifies
  // against production) and to assert the NEGATIVE first: with ONLY
  // user-b's identical-economics record in the database, user-a's own
  // staged row raises nothing.
  const negativeDatabase = await migratedDatabase();
  // A second owner's membership, reusing the SAME underlying security as
  // user-a's `membership-a` (economic identity is what must stay isolated).
  negativeDatabase.exec(`
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-c', 'user-b', 'portfolio-b', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-10', '2026-08-10');
    INSERT INTO dividend_manual_records (
      id, user_id, portfolio_id, portfolio_security_id, payment_date,
      shares_decimal, dividend_per_share_decimal, franking_credit_per_share_decimal,
      import_batch_id, source_reference, created_at, updated_at, version
    ) VALUES ('existing-user-b', 'user-b', 'portfolio-b', 'membership-c', '2026-08-05',
      '5', '0.50', NULL, 'prior-batch-b', 'import-fingerprint:prior-b', '2026-08-01', '2026-08-01', 1);
  `);
  const negativeClient = createSqliteSqlClient(negativeDatabase);
  stageRow(
    negativeDatabase,
    "batch-a",
    "row-div",
    dividendNormalizedRow("2026-08-05", "0.50"),
  );
  const negativeReview = await pagePreview(negativeClient, "user-a", "batch-a");
  assert.equal(
    negativeReview.preview.issues.find(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    undefined,
    "user-b's identical-economics existing record alone must never leak a warning to user-a -- this is the actual isolation proof, not merely a sanity check that the positive case still works",
  );

  // Positive: with user-a's OWN matching record ALSO present (alongside
  // user-b's), the warning fires -- proves the check still works when the
  // correct owner's record genuinely exists, so the negative above is not
  // trivially true because the check is broken outright.
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-c', 'user-b', 'portfolio-b', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-10', '2026-08-10');
    INSERT INTO dividend_manual_records (
      id, user_id, portfolio_id, portfolio_security_id, payment_date,
      shares_decimal, dividend_per_share_decimal, franking_credit_per_share_decimal,
      import_batch_id, source_reference, created_at, updated_at, version
    ) VALUES
      ('existing-user-a', 'user-a', 'portfolio-a', 'membership-a', '2026-08-05',
        '5', '0.50', NULL, 'prior-batch-a', 'import-fingerprint:prior-a', '2026-08-01', '2026-08-01', 1),
      ('existing-user-b', 'user-b', 'portfolio-b', 'membership-c', '2026-08-05',
        '5', '0.50', NULL, 'prior-batch-b', 'import-fingerprint:prior-b', '2026-08-01', '2026-08-01', 1);
  `);
  const client = createSqliteSqlClient(database);
  stageRow(
    database,
    "batch-a",
    "row-div",
    dividendNormalizedRow("2026-08-05", "0.50"),
  );
  const review = await pagePreview(client, "user-a", "batch-a");
  const warning = review.preview.issues.find(
    (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
  );
  assert.ok(
    warning,
    "expected user-a's own existing dividend record to raise the warning",
  );
});

// ---------------------------------------------------------------------------
// BUG-013 review round, RULING 1: DB-level proof that a row already bound
// for a commit-time exact source_reference SKIP (a full re-sync of an
// already-fully-committed batch) raises NEITHER dividend advisory warning
// via the real query wiring, end to end -- not just the pure function.
// ---------------------------------------------------------------------------

test("BUG-013 review round: a dividend row that will be skipped at commit (its own source_reference already committed) raises no advisory warning through the real query wiring, though a genuinely different fingerprint still warns", async () => {
  const database = await migratedDatabase();
  // `stageRow` hardcodes `normalized_fingerprint = 'fingerprint-<rowId>'`
  // (see this file's own helper), so this row's commit-time source_reference
  // is EXACTLY `import-fingerprint:fingerprint-row-div` -- an existing
  // record under that identical source_reference simulates a full re-sync
  // of an already-committed batch.
  database.exec(`
    INSERT INTO dividend_manual_records (
      id, user_id, portfolio_id, portfolio_security_id, payment_date,
      shares_decimal, dividend_per_share_decimal, franking_credit_per_share_decimal,
      import_batch_id, source_reference, created_at, updated_at, version
    ) VALUES ('existing-same-route', 'user-a', 'portfolio-a', 'membership-a', '2026-08-05',
      '5', '0.50', NULL, 'prior-batch-a', 'import-fingerprint:fingerprint-row-div', '2026-08-01', '2026-08-01', 1);
  `);
  stageRow(
    database,
    "batch-a",
    "row-div",
    dividendNormalizedRow("2026-08-05", "0.50"),
  );
  const client = createSqliteSqlClient(database);
  const review = await pagePreview(client, "user-a", "batch-a");
  assert.equal(
    review.preview.issues.find(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    undefined,
    "this row's own source_reference is already committed -- commit will skip it, so the warning is guaranteed noise",
  );
  assert.equal(
    review.preview.issues.find(
      (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
    ),
    undefined,
    "DIV-004's proximity check must ALSO be suppressed for the same row",
  );

  // A SECOND batch staging the SAME economics but resolving to a genuinely
  // DIFFERENT computed fingerprint (a different source row -- the actual
  // cross-route scenario) must still warn. Raw-SQL batch insert, matching
  // this file's own established `batch-reimport` fixture precedent above.
  database.exec(`
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-cross-route', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION}', 'cross.csv', 100, 'file-cross', 'parsed',
      '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z', 1);
  `);
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, commit_status, created_at, updated_at, version
       ) VALUES (?, 'user-a', 'batch-cross-route', 2, 'transaction', '[]', ?, 'a-genuinely-different-fingerprint', 'valid',
         NULL, 'staged', '2026-08-10', '2026-08-10', 1)`,
    )
    .run(
      "row-div-cross",
      JSON.stringify(dividendNormalizedRow("2026-08-05", "0.50")),
    );
  const crossRouteReview = await pagePreview(
    client,
    "user-a",
    "batch-cross-route",
  );
  assert.ok(
    crossRouteReview.preview.issues.some(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    "a genuinely different fingerprint is NOT bound for a commit-time skip and must still warn",
  );
});

test("BUG-013 review round: a trade row that will be skipped at commit (its own source_reference already committed) raises no TRADE_NEAR_EXISTING_ENTRY through the real query wiring -- the same property BUG-011's already-live check has had since it shipped", async () => {
  const database = await migratedDatabase();
  // `stageRow` hardcodes `normalized_fingerprint = 'fingerprint-<rowId>'`,
  // so this row's commit-time source_reference is EXACTLY
  // `import-fingerprint:fingerprint-row-1`.
  database.exec(`
    INSERT INTO transactions (
      id, user_id, portfolio_id, portfolio_security_id, type, status, trade_at,
      local_trade_date, quantity_decimal, unit_price_decimal, currency_code,
      fee_amount_decimal, tax_amount_decimal, source_type, source_reference,
      created_by_user_id, calculation_version, created_at, version
    ) VALUES ('existing-same-route-trade', 'user-a', 'portfolio-a', 'membership-a', 'buy', 'posted',
      '2026-08-01T00:00:00Z', '2026-08-01', '5', '10', 'AUD', '0', '0',
      'csv_import', 'import-fingerprint:fingerprint-row-1', 'user-a', 1, '2026-08-01', 1);
  `);
  stageRow(database, "batch-a", "row-1", normalizedRow());
  const client = createSqliteSqlClient(database);
  const review = await pagePreview(client, "user-a", "batch-a");
  assert.equal(
    review.preview.issues.find(
      (issue) => issue.code === "TRADE_NEAR_EXISTING_ENTRY",
    ),
    undefined,
    "this row's own source_reference is already committed -- commit will skip it, so the warning is guaranteed noise",
  );
});
