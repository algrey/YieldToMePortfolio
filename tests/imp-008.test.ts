import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createOwnedImportCommitRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedPortfolioRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type SqlClient,
} from "../db/repositories/index.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION } from "../domain/imports/index.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import type { ImportReviewPreview } from "../app/import-preview.ts";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import {
  setImportRowExclusionWithContext,
  type ImportRowExclusionActionContext,
} from "../app/import-row-exclusion-service.ts";
import { createImportRowExclusionPost } from "../app/import-row-exclusion-route.ts";

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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-11', '2026-08-11', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-11', '2026-08-11', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-res', 'Resolved Co', 'equity', 'AUD', 'active', '2026-08-11', '2026-08-11');
    INSERT INTO portfolio_securities (
      id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias,
      source_currency_code, status, created_at, updated_at
    ) VALUES ('membership-res', 'user-a', 'portfolio-a', 'security-res', 'RES', 'ASX', 'AUD', 'held', '2026-08-11', '2026-08-11');
  `);
  return database;
}

function insertBatch(
  database: DatabaseSync,
  id: string,
  overrides: Partial<{ status: string; version: number }> = {},
): void {
  database
    .prepare(
      `INSERT INTO import_batches (
         id, user_id, target_portfolio_id, parser_format, parser_version, filename,
         byte_size, file_sha256, status, created_at, updated_at, version
       ) VALUES (?, 'user-a', 'portfolio-a', 'strict-versioned-csv', ?, ?, 100, ?, ?, '2026-08-11', '2026-08-11', ?)`,
    )
    .run(
      id,
      SUPPORTED_IMPORT_PARSER_VERSION,
      `${id}.csv`,
      `sha-${id}`,
      overrides.status ?? "parsed",
      overrides.version ?? 1,
    );
}

function normalizedBuyRow(
  overrides: Partial<{
    symbol: string;
    exchange: string | null;
    currency: string;
  }> = {},
) {
  return {
    id: "source",
    symbol: overrides.symbol ?? "RES",
    name: "A Security",
    displaySymbol: null,
    exchange: overrides.exchange === undefined ? "ASX" : overrides.exchange,
    portfolio: "Main",
    currency: overrides.currency ?? "AUD",
    sharesOwned: "1",
    costPerShare: "10",
    commission: "0",
    transactionDate: "2026-08-01 GMT+1000",
    transactionTime: "10:00:00",
    purchaseExchangeRate: null,
    type: "buy",
    accounting: "fifo",
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: "2026-08-01T00:00:00.000Z",
    localTradeDate: "2026-08-01",
    cashEvent: null,
    frankingPerShare: null,
  };
}

function insertRow(
  database: DatabaseSync,
  batchId: string,
  rowId: string,
  physicalRowNumber: number,
  normalized: ReturnType<typeof normalizedBuyRow> | null,
  overrides: Partial<{
    validationStatus: string;
    errorCount: number;
    commitStatus: string;
  }> = {},
): void {
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, commit_status, error_count,
         created_at, updated_at, version
       ) VALUES (?, 'user-a', ?, ?, 'transaction', '[]', ?, ?, ?, NULL, ?, ?, '2026-08-11', '2026-08-11', 1)`,
    )
    .run(
      rowId,
      batchId,
      physicalRowNumber,
      normalized === null ? null : JSON.stringify(normalized),
      `fingerprint-${rowId}`,
      overrides.validationStatus ?? "valid",
      overrides.commitStatus ?? "staged",
      overrides.errorCount ?? 0,
    );
}

function insertIssue(
  database: DatabaseSync,
  id: string,
  batchId: string,
  rowId: string | null,
  code: string,
  severity: "error" | "warning" | "info" = "error",
): void {
  database
    .prepare(
      `INSERT INTO import_issues (
         id, user_id, batch_id, row_id, physical_row_number, severity, code,
         message, created_at, updated_at, version
       ) VALUES (?, 'user-a', ?, ?, NULL, ?, ?, ?, '2026-08-11', '2026-08-11', 1)`,
    )
    .run(id, batchId, rowId, severity, code, `${code} message`);
}

async function currentReview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<ImportReviewPreview> {
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
  return buildImportReviewPreview({
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
}

function context(
  client: SqlClient,
  userId = "user-a",
): ImportRowExclusionActionContext {
  return { client, userId, requestId: "imp-008-request" };
}

// Mirrors tests/ui-006b.test.ts's identical helper.
function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected a "${selector}" rule in globals.css`);
  return match![1];
}

// ---------------------------------------------------------------------------
// Migration / schema
// ---------------------------------------------------------------------------

test("IMP-008: the full migration chain applies and the three account-purge-lock triggers on import_rows survive the ADD COLUMN migration", async () => {
  const database = await migratedDatabase();
  const columns = database
    .prepare("PRAGMA table_info('import_rows')")
    .all()
    .map(
      (row) => row as { name: string; notnull: number; dflt_value: unknown },
    );
  const excludedColumn = columns.find(
    (column) => column.name === "excluded_by_owner_at",
  );
  assert.ok(excludedColumn, "expected excluded_by_owner_at column to exist");
  assert.equal(excludedColumn!.notnull, 0, "column must be nullable");
  assert.equal(excludedColumn!.dflt_value, null, "column must default to NULL");

  const triggers = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='import_rows'",
    )
    .all()
    .map((row) => (row as { name: string }).name)
    .sort();
  assert.deepEqual(triggers, [
    "account_purge_lock_import_rows_delete",
    "account_purge_lock_import_rows_insert",
    "account_purge_lock_import_rows_update",
  ]);
});

// ---------------------------------------------------------------------------
// Security-candidate exclusion (the "19 candidates" case)
// ---------------------------------------------------------------------------

test("IMP-008: excluding a security candidate skips every row referencing it and unblocks readiness; un-skip restores blocking", async () => {
  const database = await migratedDatabase();
  insertBatch(database, "batch-a");
  insertRow(database, "batch-a", "row-res", 2, normalizedBuyRow());
  insertRow(
    database,
    "batch-a",
    "row-zzz-1",
    3,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  insertRow(
    database,
    "batch-a",
    "row-zzz-2",
    4,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  insertRow(
    database,
    "batch-a",
    "row-zzz-3",
    5,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  const client = createSqliteSqlClient(database);

  const before = await currentReview(client, "user-a", "batch-a");
  assert.equal(before.preview.ready, false);
  assert.equal(before.preview.unresolvedCandidates.length, 1);
  assert.equal(before.preview.unresolvedCandidates[0]?.sourceSymbol, "ZZZ");

  const excluded = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: {
        kind: "securityCandidate",
        portfolioId: "portfolio-a",
        sourceSymbol: "ZZZ",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
      expectedVersion: before.batch.version,
      expectedPreviewVersion: before.previewVersion,
    },
  );
  assert.equal(excluded.ok, true);
  if (!excluded.ok) return;
  assert.equal(excluded.changedRowCount, 3);
  assert.equal(excluded.review.preview.ready, true);
  assert.equal(excluded.review.preview.unresolvedCandidates.length, 0);
  assert.equal(excluded.review.excludedRows.length, 3);
  assert.notEqual(excluded.review.previewVersion, before.previewVersion);

  const included = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "include",
      target: {
        kind: "securityCandidate",
        portfolioId: "portfolio-a",
        sourceSymbol: "ZZZ",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
      expectedVersion: excluded.review.batch.version,
      expectedPreviewVersion: excluded.review.previewVersion,
    },
  );
  assert.equal(included.ok, true);
  if (!included.ok) return;
  assert.equal(included.changedRowCount, 3);
  assert.equal(included.review.preview.ready, false);
  assert.equal(included.review.preview.unresolvedCandidates.length, 1);
  assert.equal(included.review.excludedRows.length, 0);
});

test("IMP-008: excluded rows' issues do not block readiness, but a non-excluded error still does", async () => {
  const database = await migratedDatabase();
  insertBatch(database, "batch-a");
  insertRow(database, "batch-a", "row-res", 2, normalizedBuyRow());
  insertRow(
    database,
    "batch-a",
    "row-zzz",
    3,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  insertRow(
    database,
    "batch-a",
    "row-yyy",
    4,
    normalizedBuyRow({ symbol: "YYY" }),
  );
  const client = createSqliteSqlClient(database);
  const before = await currentReview(client, "user-a", "batch-a");
  const excluded = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: {
        kind: "securityCandidate",
        portfolioId: "portfolio-a",
        sourceSymbol: "ZZZ",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
      expectedVersion: before.batch.version,
      expectedPreviewVersion: before.previewVersion,
    },
  );
  assert.equal(excluded.ok, true);
  if (!excluded.ok) return;
  assert.equal(
    excluded.review.preview.ready,
    false,
    "YYY remains unresolved and still blocks readiness",
  );
});

// ---------------------------------------------------------------------------
// Issue-linked exclusion and the invalid -> needs_mapping unblock
// (IMP-008 supersedes BRK-005D)
// ---------------------------------------------------------------------------

test("IMP-008: excluding both rows of a persisted-issue collision pair unblocks readiness and advances an invalid batch to needs_mapping", async () => {
  const database = await migratedDatabase();
  insertBatch(database, "batch-a", { status: "invalid" });
  insertRow(
    database,
    "batch-a",
    "row-c1",
    2,
    normalizedBuyRow({ symbol: "DIV" }),
    {
      validationStatus: "invalid",
      errorCount: 1,
    },
  );
  insertRow(
    database,
    "batch-a",
    "row-c2",
    3,
    normalizedBuyRow({ symbol: "DIV" }),
    {
      validationStatus: "invalid",
      errorCount: 1,
    },
  );
  insertIssue(
    database,
    "issue-c1",
    "batch-a",
    "row-c1",
    "SHARESIGHT_PAYOUT_KEY_COLLISION",
  );
  insertIssue(
    database,
    "issue-c2",
    "batch-a",
    "row-c2",
    "SHARESIGHT_PAYOUT_KEY_COLLISION",
  );
  const client = createSqliteSqlClient(database);
  const staging = createOwnedImportStagingRepository(client);

  let review = await currentReview(client, "user-a", "batch-a");
  const issueOne = review.issues.find((issue) => issue.id === "issue-c1");
  assert.ok(issueOne);

  const excludeFirst = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: { kind: "issue", issueId: "issue-c1" },
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(excludeFirst.ok, true);
  if (!excludeFirst.ok) return;
  assert.equal(excludeFirst.changedRowCount, 1);
  const stillInvalid = await staging.get("user-a", "batch-a");
  assert.equal(
    stillInvalid?.status,
    "invalid",
    "the second colliding row still blocks -- the batch must not advance yet",
  );

  review = excludeFirst.review;
  const excludeSecond = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: { kind: "issue", issueId: "issue-c2" },
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(excludeSecond.ok, true);
  if (!excludeSecond.ok) return;
  assert.equal(excludeSecond.changedRowCount, 1);

  const advanced = await staging.get("user-a", "batch-a");
  assert.equal(
    advanced?.status,
    "needs_mapping",
    "excluding every remaining blocking row must advance the batch off 'invalid'",
  );

  const finalReview = await currentReview(client, "user-a", "batch-a");
  assert.equal(finalReview.preview.ready, true);
  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    "batch-a",
    {
      expectedVersion: finalReview.batch.version,
      expectedPreviewVersion: finalReview.previewVersion,
    },
  );
  assert.equal(ready.ok, true, !ready.ok ? ready.message : undefined);
});

// ---------------------------------------------------------------------------
// Commit with mixed exclusions, and reversal round trip
// ---------------------------------------------------------------------------

test("IMP-008: commit excludes exactly the excluded rows -- committed effects and holdings never include them, and reversal only reverses committed rows", async () => {
  const database = await migratedDatabase();
  insertBatch(database, "batch-a");
  insertRow(database, "batch-a", "row-res", 2, normalizedBuyRow());
  insertRow(
    database,
    "batch-a",
    "row-zzz",
    3,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  const client = createSqliteSqlClient(database);
  const staging = createOwnedImportStagingRepository(client);

  const before = await currentReview(client, "user-a", "batch-a");
  const excluded = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: {
        kind: "securityCandidate",
        portfolioId: "portfolio-a",
        sourceSymbol: "ZZZ",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
      expectedVersion: before.batch.version,
      expectedPreviewVersion: before.previewVersion,
    },
  );
  assert.equal(excluded.ok, true);
  if (!excluded.ok) return;

  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    "batch-a",
    {
      expectedVersion: excluded.review.batch.version,
      expectedPreviewVersion: excluded.review.previewVersion,
    },
  );
  assert.equal(ready.ok, true, !ready.ok ? ready.message : undefined);
  if (!ready.ok) return;

  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", "batch-a");
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: ready.review.batch.version,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "imp-008-commit",
    confirmation: true,
    requestId: "imp-008-commit-request",
  };
  let commitResult = await commitRepo.commit("user-a", "batch-a", commitInput);
  for (
    let attempt = 0;
    attempt < 20 && (!commitResult.ok || commitResult.status !== "committed");
    attempt += 1
  ) {
    assert.equal(
      commitResult.ok,
      true,
      !commitResult.ok ? commitResult.reason : undefined,
    );
    commitResult = await commitRepo.commit("user-a", "batch-a", commitInput);
  }
  assert.equal(commitResult.ok, true);
  if (!commitResult.ok) return;
  assert.equal(commitResult.status, "committed");
  assert.equal(commitResult.committedRows, 1);
  assert.equal(commitResult.excludedByOwnerRows, 1);

  const transactionCount = (
    database.prepare("SELECT COUNT(*) AS n FROM transactions").get() as {
      n: number;
    }
  ).n;
  assert.equal(
    transactionCount,
    1,
    "the excluded ZZZ row must never post any ledger effect",
  );
  const zzzMembership = database
    .prepare(
      "SELECT COUNT(*) AS n FROM portfolio_securities WHERE source_symbol = 'ZZZ'",
    )
    .get() as { n: number };
  assert.equal(
    zzzMembership.n,
    0,
    "an excluded row must never create a portfolio-security candidate",
  );

  const excludedRow = await staging.get("user-a", "batch-a").then(
    () =>
      database
        .prepare(
          "SELECT commit_status, excluded_by_owner_at FROM import_rows WHERE id = 'row-zzz'",
        )
        .get() as {
        commit_status: string;
        excluded_by_owner_at: string | null;
      },
  );
  assert.equal(excludedRow.commit_status, "skipped");
  assert.notEqual(excludedRow.excluded_by_owner_at, null);

  // Reversal round trip: only the genuinely committed row is reversed, and
  // the never-committed excluded row is never touched by it.
  const committedBatch = await staging.get("user-a", "batch-a");
  const reversalRepo = createOwnedImportReversalRepository(client);
  let reversed = await reversalRepo.reverse("user-a", "batch-a", {
    expectedVersion: committedBatch!.version,
    idempotencyKey: "imp-008-reverse",
    confirmation: true,
    requestId: "imp-008-reverse-request",
  });
  for (
    let attempt = 0;
    attempt < 10 && (!reversed.ok || reversed.status !== "reversed");
    attempt += 1
  ) {
    assert.equal(reversed.ok, true);
    reversed = await reversalRepo.reverse("user-a", "batch-a", {
      expectedVersion: committedBatch!.version,
      idempotencyKey: "imp-008-reverse",
      confirmation: true,
      requestId: "imp-008-reverse-request",
    });
  }
  assert.equal(reversed.ok, true);
  if (reversed.ok) assert.equal(reversed.status, "reversed");

  const reversedTransactions = database
    .prepare(
      "SELECT status FROM transactions WHERE reverses_transaction_id IS NULL",
    )
    .get() as { status: string };
  assert.equal(reversedTransactions.status, "reversed");
  const stillExcludedRow = database
    .prepare("SELECT commit_status FROM import_rows WHERE id = 'row-zzz'")
    .get() as { commit_status: string };
  assert.equal(
    stillExcludedRow.commit_status,
    "skipped",
    "reversal must never attempt to reverse a never-committed excluded row",
  );
});

// ---------------------------------------------------------------------------
// previewVersion / expectedVersion staleness
// ---------------------------------------------------------------------------

test("IMP-008: a stale expectedVersion or expectedPreviewVersion is rejected with 409 for both exclude and include", async () => {
  const database = await migratedDatabase();
  insertBatch(database, "batch-a");
  insertRow(
    database,
    "batch-a",
    "row-zzz",
    2,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  const client = createSqliteSqlClient(database);
  const review = await currentReview(client, "user-a", "batch-a");
  const target = {
    kind: "securityCandidate" as const,
    portfolioId: "portfolio-a",
    sourceSymbol: "ZZZ",
    sourceExchangeAlias: "ASX",
    sourceCurrencyCode: "AUD",
  };

  const staleVersion = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target,
      expectedVersion: review.batch.version + 1,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(staleVersion.ok, false);
  if (!staleVersion.ok) assert.equal(staleVersion.status, 409);

  const stalePreview = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target,
      expectedVersion: review.batch.version,
      expectedPreviewVersion: "0.not-the-real-hash",
    },
  );
  assert.equal(stalePreview.ok, false);
  if (!stalePreview.ok) assert.equal(stalePreview.status, 409);

  const excluded = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target,
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(excluded.ok, true);
  if (!excluded.ok) return;

  // Un-include against the NOW-stale (pre-exclude) preview version is also
  // rejected -- the same staleness guard applies symmetrically.
  const staleInclude = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "include",
      target,
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(staleInclude.ok, false);
  if (!staleInclude.ok) assert.equal(staleInclude.status, 409);
});

// ---------------------------------------------------------------------------
// Ownership and CSRF
// ---------------------------------------------------------------------------

test("IMP-008: a cross-user exclusion attempt is denied as not-found, never leaking or mutating another owner's batch", async () => {
  const database = await migratedDatabase();
  insertBatch(database, "batch-a");
  insertRow(
    database,
    "batch-a",
    "row-zzz",
    2,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  const client = createSqliteSqlClient(database);
  const review = await currentReview(client, "user-a", "batch-a");

  const denied = await setImportRowExclusionWithContext(
    context(client, "user-b"),
    "batch-a",
    {
      action: "exclude",
      target: {
        kind: "securityCandidate",
        portfolioId: "portfolio-a",
        sourceSymbol: "ZZZ",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 404);

  const row = database
    .prepare(
      "SELECT excluded_by_owner_at FROM import_rows WHERE id = 'row-zzz'",
    )
    .get() as { excluded_by_owner_at: string | null };
  assert.equal(row.excluded_by_owner_at, null);
});

test("IMP-008: the exclusions route enforces CSRF before its authenticated action, and succeeds for a same-origin request", async () => {
  let calls = 0;
  const rejectedPost = createImportRowExclusionPost(async () => {
    calls += 1;
    throw new Error("cross-site request reached the action");
  });
  const rejected = await rejectedPost(
    new Request("https://yield.example/api/import/preview/batch-a/exclusions", {
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
  insertBatch(database, "batch-a");
  insertRow(
    database,
    "batch-a",
    "row-zzz",
    2,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  const client = createSqliteSqlClient(database);
  const review = await currentReview(client, "user-a", "batch-a");
  const authenticatedPost = createImportRowExclusionPost((batchId, value) =>
    setImportRowExclusionWithContext(context(client), batchId, value),
  );
  const response = await authenticatedPost(
    new Request("https://yield.example/api/import/preview/batch-a/exclusions", {
      method: "POST",
      headers: {
        origin: "https://yield.example",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "exclude",
        target: {
          kind: "securityCandidate",
          portfolioId: "portfolio-a",
          sourceSymbol: "ZZZ",
          sourceExchangeAlias: "ASX",
          sourceCurrencyCode: "AUD",
        },
        expectedVersion: review.batch.version,
        expectedPreviewVersion: review.previewVersion,
      }),
    }),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = (await response.json()) as {
    ok: boolean;
    changedRowCount: number;
  };
  assert.equal(body.ok, true);
  assert.equal(body.changedRowCount, 1);
});

// ---------------------------------------------------------------------------
// Audit attribution
// ---------------------------------------------------------------------------

test("IMP-008: exclude and include each append an owner-attributed audit event naming the affected rows", async () => {
  const database = await migratedDatabase();
  insertBatch(database, "batch-a");
  insertRow(
    database,
    "batch-a",
    "row-zzz",
    2,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  const client = createSqliteSqlClient(database);
  const review = await currentReview(client, "user-a", "batch-a");
  const target = {
    kind: "securityCandidate" as const,
    portfolioId: "portfolio-a",
    sourceSymbol: "ZZZ",
    sourceExchangeAlias: "ASX",
    sourceCurrencyCode: "AUD",
  };

  const excluded = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target,
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(excluded.ok, true);
  if (!excluded.ok) return;

  const included = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "include",
      target,
      expectedVersion: excluded.review.batch.version,
      expectedPreviewVersion: excluded.review.previewVersion,
    },
  );
  assert.equal(included.ok, true);

  const events = database
    .prepare(
      `SELECT actor_user_id, target_owner_user_id, action, target_type, target_id, metadata_json
         FROM audit_events WHERE target_id = 'batch-a' ORDER BY rowid ASC`,
    )
    .all() as Array<{
    actor_user_id: string;
    target_owner_user_id: string;
    action: string;
    target_type: string;
    target_id: string;
    metadata_json: string;
  }>;
  assert.equal(events.length, 2);
  assert.equal(events[0]?.action, "import.row.exclude");
  assert.equal(events[1]?.action, "import.row.include");
  for (const event of events) {
    assert.equal(event.actor_user_id, "user-a");
    assert.equal(event.target_owner_user_id, "user-a");
    assert.equal(event.target_type, "import_batch");
    assert.equal(event.target_id, "batch-a");
    const metadata = JSON.parse(event.metadata_json) as { rowIds: string[] };
    assert.deepEqual(metadata.rowIds, ["row-zzz"]);
  }
});

// ---------------------------------------------------------------------------
// No sticky suppression across batches
// ---------------------------------------------------------------------------

test("IMP-008: excluding a row in one batch never excludes a same-symbol row freshly staged in a LATER batch", async () => {
  const database = await migratedDatabase();
  insertBatch(database, "batch-a");
  insertRow(
    database,
    "batch-a",
    "row-zzz",
    2,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  const client = createSqliteSqlClient(database);
  const review = await currentReview(client, "user-a", "batch-a");
  const excluded = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: {
        kind: "securityCandidate",
        portfolioId: "portfolio-a",
        sourceSymbol: "ZZZ",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(excluded.ok, true);

  // A later, independent batch (e.g. a fresh Sharesight sync) stages its OWN
  // new row for the same symbol -- each batch decides independently, so
  // this fresh row must start un-excluded and re-raise the same issue.
  insertBatch(database, "batch-b", { version: 1 });
  insertRow(
    database,
    "batch-b",
    "row-zzz-2",
    2,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  const laterReview = await currentReview(client, "user-a", "batch-b");
  assert.equal(laterReview.preview.ready, false);
  assert.equal(laterReview.preview.unresolvedCandidates.length, 1);
  assert.equal(laterReview.excludedRows.length, 0);
  const rawRow = database
    .prepare(
      "SELECT excluded_by_owner_at FROM import_rows WHERE id = 'row-zzz-2'",
    )
    .get() as { excluded_by_owner_at: string | null };
  assert.equal(rawRow.excluded_by_owner_at, null);
});

// ---------------------------------------------------------------------------
// Review finding B1: exclusion stays reversible through `ready`, with an
// atomic `ready` -> `needs_mapping` downgrade when a change leaves the
// batch no longer actually ready.
// ---------------------------------------------------------------------------

async function reachReadyExcludingZzz(
  database: DatabaseSync,
  client: SqlClient,
): Promise<ImportReviewPreview> {
  insertBatch(database, "batch-a");
  insertRow(database, "batch-a", "row-res", 2, normalizedBuyRow());
  insertRow(
    database,
    "batch-a",
    "row-zzz",
    3,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  const before = await currentReview(client, "user-a", "batch-a");
  const excluded = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: {
        kind: "securityCandidate",
        portfolioId: "portfolio-a",
        sourceSymbol: "ZZZ",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
      expectedVersion: before.batch.version,
      expectedPreviewVersion: before.previewVersion,
    },
  );
  assert.equal(excluded.ok, true);
  if (!excluded.ok) throw new Error("expected exclude to succeed");
  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    "batch-a",
    {
      expectedVersion: excluded.review.batch.version,
      expectedPreviewVersion: excluded.review.previewVersion,
    },
  );
  assert.equal(ready.ok, true, !ready.ok ? ready.message : undefined);
  if (!ready.ok) throw new Error("expected markImportReady to succeed");
  assert.equal(ready.review.batch.status, "ready");
  return ready.review;
}

test("IMP-008 B1: un-skip at ready re-blocks readiness and downgrades the batch to needs_mapping atomically", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const readyReview = await reachReadyExcludingZzz(database, client);

  const included = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "include",
      target: {
        kind: "securityCandidate",
        portfolioId: "portfolio-a",
        sourceSymbol: "ZZZ",
        sourceExchangeAlias: "ASX",
        sourceCurrencyCode: "AUD",
      },
      expectedVersion: readyReview.batch.version,
      expectedPreviewVersion: readyReview.previewVersion,
    },
  );
  assert.equal(included.ok, true, !included.ok ? included.message : undefined);
  if (!included.ok) return;
  assert.equal(included.changedRowCount, 1);
  assert.equal(
    included.review.batch.status,
    "needs_mapping",
    "an un-skip that re-surfaces a blocking issue must downgrade a ready batch",
  );
  assert.equal(included.review.preview.ready, false);
  assert.equal(included.review.preview.unresolvedCandidates.length, 1);
  assert.equal(included.review.excludedRows.length, 0);

  const staging = createOwnedImportStagingRepository(client);
  const persisted = await staging.get("user-a", "batch-a");
  assert.equal(persisted?.status, "needs_mapping");
});

test("IMP-008 B1: excluding an already-resolved row at ready leaves the batch ready", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const readyReview = await reachReadyExcludingZzz(database, client);

  const excluded = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: { kind: "rowIds", rowIds: ["row-res"] },
      expectedVersion: readyReview.batch.version,
      expectedPreviewVersion: readyReview.previewVersion,
    },
  );
  assert.equal(excluded.ok, true, !excluded.ok ? excluded.message : undefined);
  if (!excluded.ok) return;
  assert.equal(excluded.changedRowCount, 1);
  assert.equal(
    excluded.review.batch.status,
    "ready",
    "excluding a row that leaves the batch still ready must not downgrade it",
  );
  assert.equal(excluded.review.preview.ready, true);
  assert.equal(excluded.review.excludedRows.length, 2);
});

test("IMP-008 B1: a stale expectedVersion at ready is still rejected with 409", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const readyReview = await reachReadyExcludingZzz(database, client);

  const stale = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: { kind: "rowIds", rowIds: ["row-res"] },
      expectedVersion: readyReview.batch.version + 1,
      expectedPreviewVersion: readyReview.previewVersion,
    },
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.status, 409);

  const stalePreview = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: { kind: "rowIds", rowIds: ["row-res"] },
      expectedVersion: readyReview.batch.version,
      expectedPreviewVersion: "0.not-the-real-hash",
    },
  );
  assert.equal(stalePreview.ok, false);
  if (!stalePreview.ok) assert.equal(stalePreview.status, 409);

  const staging = createOwnedImportStagingRepository(client);
  const persisted = await staging.get("user-a", "batch-a");
  assert.equal(
    persisted?.status,
    "ready",
    "a rejected stale request must never change batch status",
  );
});

// IMP-008 review finding FU-1: `stillReadyAfterChange` must also catch a
// row that reconciliation alone would call resolved (no reconciliation
// issue, no persisted ISSUE) but whose OWN persisted `validationStatus`/
// `errorCount` is still invalid -- the exact predicate commit's own
// `revalidate()` uses (`db/repositories/import-commit.ts`). Without it, an
// include-at-ready of such a row would leave the batch mislabelled `ready`
// when commit would immediately fail-closed with `revalidation_failed`.
test("IMP-008 FU-1: including an invalid/error-count row at ready downgrades the batch to needs_mapping", async () => {
  const database = await migratedDatabase();
  insertBatch(database, "batch-a");
  insertRow(database, "batch-a", "row-res", 2, normalizedBuyRow());
  // Resolves cleanly through reconciliation (no reconciliation issue, and
  // deliberately no persisted `import_issues` row either) -- only its own
  // PERSISTED row state says it is broken, exactly the gap FU-1 closes.
  insertRow(
    database,
    "batch-a",
    "row-broken",
    3,
    normalizedBuyRow({ symbol: "RES" }),
    { validationStatus: "invalid", errorCount: 1 },
  );
  const client = createSqliteSqlClient(database);

  const before = await currentReview(client, "user-a", "batch-a");
  const excluded = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: { kind: "rowIds", rowIds: ["row-broken"] },
      expectedVersion: before.batch.version,
      expectedPreviewVersion: before.previewVersion,
    },
  );
  assert.equal(excluded.ok, true, !excluded.ok ? excluded.message : undefined);
  if (!excluded.ok) return;
  assert.equal(
    excluded.review.preview.ready,
    true,
    "excluding the broken row must reach readiness",
  );

  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    "batch-a",
    {
      expectedVersion: excluded.review.batch.version,
      expectedPreviewVersion: excluded.review.previewVersion,
    },
  );
  assert.equal(ready.ok, true, !ready.ok ? ready.message : undefined);
  if (!ready.ok) return;
  assert.equal(ready.review.batch.status, "ready");

  const included = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "include",
      target: { kind: "rowIds", rowIds: ["row-broken"] },
      expectedVersion: ready.review.batch.version,
      expectedPreviewVersion: ready.review.previewVersion,
    },
  );
  assert.equal(included.ok, true, !included.ok ? included.message : undefined);
  if (!included.ok) return;
  assert.equal(included.changedRowCount, 1);
  assert.equal(
    included.review.batch.status,
    "needs_mapping",
    "un-excluding a row that is still persistently invalid must downgrade a ready batch, even though reconciliation alone sees no blocking issue",
  );
});

// ---------------------------------------------------------------------------
// Review finding B3: audit metadata must record only the rows that
// ACTUALLY changed, never ids the request merely asked for.
// ---------------------------------------------------------------------------

test("IMP-008 B3: audit metadata contains only actually-changed row ids when the request includes ineligible ids", async () => {
  const database = await migratedDatabase();
  insertBatch(database, "batch-a");
  insertRow(
    database,
    "batch-a",
    "row-zzz",
    2,
    normalizedBuyRow({ symbol: "ZZZ" }),
  );
  const client = createSqliteSqlClient(database);
  const review = await currentReview(client, "user-a", "batch-a");

  const excluded = await setImportRowExclusionWithContext(
    context(client),
    "batch-a",
    {
      action: "exclude",
      target: {
        kind: "rowIds",
        rowIds: ["row-zzz", "row-does-not-exist", "row-also-missing"],
      },
      expectedVersion: review.batch.version,
      expectedPreviewVersion: review.previewVersion,
    },
  );
  assert.equal(excluded.ok, true, !excluded.ok ? excluded.message : undefined);
  if (!excluded.ok) return;
  assert.equal(
    excluded.changedRowCount,
    1,
    "only the genuinely eligible row changed",
  );

  const event = database
    .prepare(
      `SELECT metadata_json FROM audit_events
         WHERE target_id = 'batch-a' AND action = 'import.row.exclude'
         ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { metadata_json: string };
  const metadata = JSON.parse(event.metadata_json) as { rowIds: string[] };
  assert.deepEqual(
    metadata.rowIds,
    ["row-zzz"],
    "audit metadata must name only the row that actually changed, never the ineligible ids the request also asked for",
  );
});

// ---------------------------------------------------------------------------
// QA-001A matrix self-check, mirroring tests/brk-005.test.ts's identical
// pattern.
// ---------------------------------------------------------------------------

test("IMP-008: the QA-001A matrix records the new exclusions route", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const needle of [
    "/api/import/preview/:batchId/exclusions",
    "tests/imp-008.test.ts",
  ]) {
    assert.ok(matrix.includes(needle), `matrix should mention ${needle}`);
  }
});

test("IMP-008: every matrix citation naming tests/imp-008.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/imp-008.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/imp-008\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
  const quotedStringPattern = /"(?:[^"\\]|\\.)*"/g;
  let groupCount = 0;
  for (const match of matrix.matchAll(citationGroupPattern)) {
    groupCount += 1;
    const titles = match[2]!.match(quotedStringPattern) ?? [];
    for (const quoted of titles) {
      const title = quoted.slice(1, -1);
      assert.ok(
        ownSource.includes(title),
        `matrix cites "${title}" in tests/imp-008.test.ts, but that title is not a literal substring of the file (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount >= 1, "expected at least 1 citation group to check");
});

// ---------------------------------------------------------------------------
// QA-001B-style accessibility evidence (touch targets, no color-only status)
// ---------------------------------------------------------------------------

test("IMP-008: skip/un-skip and dialog-action buttons meet the 44x44 CSS-pixel touch-target minimum", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  for (const selector of [
    ".import-issues li button",
    ".dialog-actions button",
  ]) {
    const block = extractBlock(styles, selector);
    assert.match(
      block,
      /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/,
      `${selector} must declare min-height >= 44px`,
    );
  }
  // The "Skip rows referencing SYMBOL" button on the security-resolution
  // card is a plain child of `.import-mapping-form`, which already declares
  // the same minimum -- verified once here rather than re-declaring it.
  const mappingFormButton = extractBlock(styles, ".import-mapping-form button");
  assert.match(mappingFormButton, /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/);
});

test("IMP-008: excluded/blocked-row state is conveyed by literal text, never color alone", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /will not be committed/,
    "excluded-row consequence must be stated in text",
  );
  assert.match(
    component,
    /excluded by owner/,
    "the excluded-row count must be stated in text",
  );
  assert.match(
    component,
    /Skip this row|Skip \{blockedRowCount\} row/,
    "the skip action's own label must be textual, not an icon/color-only affordance",
  );
});

// ---------------------------------------------------------------------------
// Review finding B4: the skip affordance must state the row count.
// ---------------------------------------------------------------------------

test("IMP-008 B4: the security-candidate skip button and confirm-dialog copy both state the blocked row count", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /const blockedRowCount = review\.preview\.issues\.filter\(/,
    "the blocked-row count must be derived from the current preview's issues",
  );
  assert.match(
    component,
    /Skip \{blockedRowCount\} row/,
    "the skip BUTTON label must state the row count",
  );
  assert.match(
    component,
    /Skip \$\{blockedRowCount\} row\$\{blockedRowCount === 1 \? "" : "s"\} referencing/,
    "the confirm DIALOG body copy must also state the row count",
  );
});

// ---------------------------------------------------------------------------
// Review finding B2: the "Excluded rows" un-skip button and consequence
// copy must reflect whether the batch can still be mutated.
// ---------------------------------------------------------------------------

// `isMutableExclusionStatus` is a small module-private pure function in
// import-review.tsx; every OTHER test of this file exercises the component
// through source-text assertions (it is a stateful client component with no
// prop-injectable review state, so it cannot be rendered standalone the way
// `ImportHistoryDetailPanel` is in tests/ui-005c.test.ts). This test goes
// one step further than a plain source match: it extracts the ACTUAL
// shipped function body by name and evaluates it, so a typo/logic drift in
// the real function (not a hand-duplicated copy of it) would be caught.
test("IMP-008 B2: isMutableExclusionStatus gates the include button/future-tense copy to exactly the still-mutable statuses", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  const match = component.match(
    /function isMutableExclusionStatus\(status: string\): boolean \{([\s\S]*?)\n\}/,
  );
  assert.ok(match, "expected to find isMutableExclusionStatus in the source");
  // Evaluates the REAL extracted function body (not a re-implementation of
  // it), so a typo/logic drift in the actual shipped code would be caught.
  const isMutableExclusionStatus = new Function("status", match![1]!) as (
    status: string,
  ) => boolean;

  for (const status of ["parsed", "needs_mapping", "invalid", "ready"]) {
    assert.equal(
      isMutableExclusionStatus(status),
      true,
      `${status} must stay mutable (review finding B1)`,
    );
  }
  for (const status of [
    "uploaded",
    "committing",
    "committed",
    "reversing",
    "reversed",
    "failed",
  ]) {
    assert.equal(
      isMutableExclusionStatus(status),
      false,
      `${status} must be immutable -- exclusion mutation would 409`,
    );
  }

  // The button and past/future-tense copy in the "Excluded rows" section
  // must both be conditioned on this exact function, not a separate
  // ad-hoc check that could drift from it.
  const excludedRowsSection = component.slice(
    component.indexOf('aria-labelledby="excluded-rows-title"'),
    component.indexOf('aria-labelledby="excluded-rows-title"') + 2000,
  );
  assert.match(
    excludedRowsSection,
    /isMutableExclusionStatus\(review\.batch\.status\)\s*\n\s*\? "will not be committed\."\s*\n\s*: "was not committed\."/,
  );
  assert.match(
    excludedRowsSection,
    /isMutableExclusionStatus\(review\.batch\.status\) \? \(\s*\n\s*<button/,
  );

  // IMP-008 review finding B2-residual: the "Blocked rows" section's own
  // skip button must be gated the same way -- a committed/failed batch
  // must never offer a button that would 409.
  const blockedRowsSection = component.slice(
    component.indexOf('aria-labelledby="blocked-rows-title"'),
    component.indexOf('aria-labelledby="blocked-rows-title"') + 2000,
  );
  assert.match(
    blockedRowsSection,
    /issue\.rowId &&\s*\n\s*isMutableExclusionStatus\(review\.batch\.status\)/,
  );
  // And it must render from `blockedRowIssues` (filtered through
  // `isRowStillBlocking`), never the raw, unfiltered `review.issues`.
  assert.match(blockedRowsSection, /blockedRowIssues\.map\(/);
  assert.doesNotMatch(blockedRowsSection, /review\.issues\.filter/);
});

// IMP-008 review finding B2-residual: `isRowStillBlocking` decides whether
// a persisted issue still belongs in "Blocked rows" -- covers the
// committed-batch case behaviorally: an issue whose row was already
// excluded must be suppressed (it is shown, accurately, in "Excluded
// rows" instead) regardless of the batch's status, exactly the scenario a
// reopened/never-refreshed committed-batch page would otherwise mishandle.
test("IMP-008 B2-residual: isRowStillBlocking suppresses an issue once its row is excluded, including after commit", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  const match = component.match(
    /function isRowStillBlocking\(\s*issue: \{[\s\S]*?\},\s*excludedRowIds: ReadonlySet<string>,\s*\): boolean \{([\s\S]*?)\n\}/,
  );
  assert.ok(match, "expected to find isRowStillBlocking in the source");
  const isRowStillBlocking = new Function(
    "issue",
    "excludedRowIds",
    match![1]!,
  ) as (
    issue: {
      severity: string;
      resolvedAt: string | null;
      rowId: string | null;
    },
    excludedRowIds: ReadonlySet<string>,
  ) => boolean;

  const stillBlockingIssue = {
    severity: "error",
    resolvedAt: null,
    rowId: "row-collision-1",
  };
  const excludedRowIssue = {
    severity: "error",
    resolvedAt: null,
    rowId: "row-collision-2",
  };
  const excludedRowIds = new Set(["row-collision-2"]);

  assert.equal(
    isRowStillBlocking(stillBlockingIssue, excludedRowIds),
    true,
    "a non-excluded unresolved error issue is still genuinely blocking",
  );
  assert.equal(
    isRowStillBlocking(excludedRowIssue, excludedRowIds),
    false,
    "an issue whose row is already excluded (e.g. after commit, where resolved_at is never set) must not be shown as blocked",
  );
  assert.equal(
    isRowStillBlocking(
      { severity: "error", resolvedAt: null, rowId: null },
      excludedRowIds,
    ),
    true,
    "a batch-level issue (no rowId) is never suppressed by row exclusion",
  );
});
