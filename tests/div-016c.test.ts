/**
 * DIV-016 part C -- Sharesight dividend reconciliation. See TASKS.md's
 * "### DIV-016" entry for the owner rulings this implements: a manually
 * entered dividend row and the same distribution arriving later via
 * Sharesight must never both count ("it should not double count"), and once
 * reconciled the Sharesight row is authoritative "from there forward."
 *
 * Section A: pure domain unit tests for
 * `domain/imports/dividend-reconciliation.ts` (matching rule, tolerance
 * boundary, ambiguity fail-safe) -- no database.
 *
 * Section B: full-pipeline integration tests through the real
 * stage->ready->commit->reverse machinery, mirroring
 * tests/imp-006.test.ts/tests/imp-004a.test.ts's established per-test-file
 * fixture/helper convention (no shared migratedDatabase()/fixture()
 * module).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import type { ImportReviewPreview } from "../app/import-preview.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedPortfolioRepository,
  createDividendManualRecordRepository,
  createDividendAssumptionsRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type SqlClient,
} from "../db/repositories/index.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS } from "../domain/imports/index.ts";
import type { ImportPreviewDividendReconciliationCandidate } from "../domain/imports/reconciliation.ts";
import {
  cashTotalsWithinTolerance,
  computeDividendCashTotal,
  computeDividendReconciliation,
} from "../domain/imports/dividend-reconciliation.ts";

// ---------------------------------------------------------------------------
// Section A: pure domain unit tests -- no database.
// ---------------------------------------------------------------------------

test("DIV-016C domain: computeDividendCashTotal prefers totals-mode verbatim, else exact per-share multiplication, else null", () => {
  assert.equal(
    computeDividendCashTotal({
      totalCashDecimal: "2.50",
      sharesDecimal: null,
      dividendPerShareDecimal: null,
    }),
    "2.50",
  );
  assert.equal(
    computeDividendCashTotal({
      totalCashDecimal: null,
      sharesDecimal: "10",
      dividendPerShareDecimal: "0.5",
    }),
    "5",
  );
  assert.equal(
    computeDividendCashTotal({
      totalCashDecimal: null,
      sharesDecimal: "3",
      dividendPerShareDecimal: "0.333333",
    }),
    "0.999999",
    "exact decimal multiplication, never floating-point rounding",
  );
  assert.equal(
    computeDividendCashTotal({
      totalCashDecimal: null,
      sharesDecimal: null,
      dividendPerShareDecimal: "0.5",
    }),
    null,
    "never fabricates a comparable amount when neither shape is complete",
  );
});

test("DIV-016C domain: cashTotalsWithinTolerance -- exact match, boundary-inclusive 1%, and just-over-1% fails", () => {
  assert.equal(cashTotalsWithinTolerance("100", "100"), true);
  assert.equal(
    cashTotalsWithinTolerance("100", "101"),
    true,
    "exactly 1% relative difference is within tolerance (boundary inclusive)",
  );
  assert.equal(
    cashTotalsWithinTolerance("100", "102"),
    false,
    "a relative difference clearly over 1% fails",
  );
  assert.equal(
    cashTotalsWithinTolerance("0", "0"),
    true,
    "both-zero is trivially within tolerance",
  );
  assert.equal(
    cashTotalsWithinTolerance("0", "0.01"),
    false,
    "a nonzero amount against zero is never within tolerance (no relative denominator to compare against)",
  );
});

test("DIV-016C domain: matching requires the SAME security and the SAME payment date -- amount tolerance alone never bridges either", () => {
  const result = computeDividendReconciliation(
    [
      {
        rowId: "row-1",
        portfolioSecurityId: "sec-a",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "5",
      },
    ],
    [
      {
        id: "manual-1",
        portfolioSecurityId: "sec-b",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "5",
      },
      {
        id: "manual-2",
        portfolioSecurityId: "sec-a",
        paymentDate: "2026-08-06",
        cashTotalDecimal: "5",
      },
    ],
  );
  assert.deepEqual(result.matches, []);
  assert.equal(result.ambiguousRowIds.size, 0);
  assert.equal(result.ambiguousManualRecordIds.size, 0);
});

test("DIV-016C domain: a clean mutual 1:1 match reconciles", () => {
  const result = computeDividendReconciliation(
    [
      {
        rowId: "row-1",
        portfolioSecurityId: "sec-a",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "5",
      },
    ],
    [
      {
        id: "manual-1",
        portfolioSecurityId: "sec-a",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "5.02",
      },
    ],
  );
  assert.deepEqual(result.matches, [
    { rowId: "row-1", manualRecordId: "manual-1" },
  ]);
  assert.equal(result.ambiguousRowIds.size, 0);
  assert.equal(result.ambiguousManualRecordIds.size, 0);
});

test("DIV-016C domain: fail-safe ambiguity -- one incoming row matching two manual candidates reconciles NEITHER", () => {
  const result = computeDividendReconciliation(
    [
      {
        rowId: "row-1",
        portfolioSecurityId: "sec-a",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "5",
      },
    ],
    [
      {
        id: "manual-1",
        portfolioSecurityId: "sec-a",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "5",
      },
      {
        id: "manual-2",
        portfolioSecurityId: "sec-a",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "5.01",
      },
    ],
  );
  assert.deepEqual(result.matches, []);
  assert.deepEqual([...result.ambiguousRowIds], ["row-1"]);
  assert.deepEqual([...result.ambiguousManualRecordIds].sort(), [
    "manual-1",
    "manual-2",
  ]);
});

test("DIV-016C domain: fail-safe ambiguity -- one manual candidate matching two incoming rows reconciles NEITHER", () => {
  const result = computeDividendReconciliation(
    [
      {
        rowId: "row-1",
        portfolioSecurityId: "sec-a",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "5",
      },
      {
        rowId: "row-2",
        portfolioSecurityId: "sec-a",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "5.01",
      },
    ],
    [
      {
        id: "manual-1",
        portfolioSecurityId: "sec-a",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "5",
      },
    ],
  );
  assert.deepEqual(result.matches, []);
  assert.deepEqual([...result.ambiguousRowIds].sort(), ["row-1", "row-2"]);
  assert.deepEqual([...result.ambiguousManualRecordIds], ["manual-1"]);
});

// ---------------------------------------------------------------------------
// Section B: full-pipeline integration tests.
// ---------------------------------------------------------------------------

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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-26', '2026-08-26', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-26', '2026-08-26', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-26', '2026-08-26', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-26', '2026-08-26', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-26', '2026-08-26', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-26', '2026-08-26', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-26', '2026-08-26'),
           ('security-b', 'Alpha (b)', 'equity', 'AUD', 'active', '2026-08-26', '2026-08-26');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-26', '2026-08-26'),
           ('membership-b', 'user-b', 'portfolio-b', 'security-b', 'ABC', 'ASX', 'AUD', 'held', '2026-08-26', '2026-08-26');
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS}', 'sample.csv', 100, 'file-a', 'parsed',
      '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z', 1),
      ('batch-b', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS}', 'sample2.csv', 100, 'file-b', 'parsed',
      '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z', 1),
      ('batch-c', 'user-b', 'portfolio-b', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS}', 'sample3.csv', 100, 'file-c', 'parsed',
      '2026-08-26T00:00:00Z', '2026-08-26T00:00:00Z', 1);
  `);
  return database;
}

// A BRK-005-shaped totals-mode payout row (Sharesight's own shape --
// `totalCashDecimal` set, no share count/per-share amount) staged directly
// into `import_rows`, mirroring tests/imp-006.test.ts's `dividendRow`/
// `stageRow` convention for a per-share row.
function totalsDividendRow(overrides: {
  id: string;
  paymentDate: string;
  totalCashDecimal: string;
  totalFrankingDecimal?: string | null;
  symbol?: string;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    symbol: overrides.symbol ?? "ABC",
    name: "Alpha",
    displaySymbol: null,
    exchange: "ASX",
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: null,
    costPerShare: null,
    commission: "0",
    transactionDate: `${overrides.paymentDate} GMT+1000`,
    transactionTime: null,
    purchaseExchangeRate: null,
    type: "dividend",
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: `${overrides.paymentDate}T00:00:00.000Z`,
    localTradeDate: overrides.paymentDate,
    cashEvent: null,
    frankingPerShare: null,
    totalCashDecimal: overrides.totalCashDecimal,
    totalFrankingDecimal: overrides.totalFrankingDecimal ?? null,
  };
}

function stageRow(
  database: DatabaseSync,
  userId: string,
  batchId: string,
  rowId: string,
  physicalRowNumber: number,
  normalized: Record<string, unknown>,
  fingerprint?: string,
): void {
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, commit_status, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, 'transaction', '[]', ?, ?, 'valid',
         NULL, 'staged', '2026-08-26', '2026-08-26', 1)`,
    )
    .run(
      rowId,
      userId,
      batchId,
      physicalRowNumber,
      JSON.stringify(normalized),
      fingerprint ?? `fingerprint-${batchId}-${rowId}`,
    );
}

function seedManualRecord(
  database: DatabaseSync,
  overrides: {
    id: string;
    userId: string;
    portfolioId: string;
    portfolioSecurityId: string;
    paymentDate: string;
    sharesDecimal: string;
    dividendPerShareDecimal: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO dividend_manual_records (
         id, user_id, portfolio_id, portfolio_security_id, payment_date,
         shares_decimal, dividend_per_share_decimal, franking_credit_per_share_decimal,
         import_batch_id, source_reference, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '2026-08-01', '2026-08-01', 1)`,
    )
    .run(
      overrides.id,
      overrides.userId,
      overrides.portfolioId,
      overrides.portfolioSecurityId,
      overrides.paymentDate,
      overrides.sharesDecimal,
      overrides.dividendPerShareDecimal,
    );
}

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

// Mirrors the real page/refresh preview path (app/import-actions.ts's
// loadReview) -- the ONLY caller that supplies `reconciliationCandidates`.
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
    manualRows,
    existingSourceReferenceRows,
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
      `SELECT id, portfolio_security_id, payment_date, shares_decimal,
                dividend_per_share_decimal, total_cash_decimal
         FROM dividend_manual_records
         WHERE user_id = ? AND import_batch_id IS NULL
           AND superseded_by_record_id IS NULL`,
      [userId],
    ),
    // DIV-016C B1 fix: mirrors app/import-actions.ts's loadReview -- every
    // dividend row this owner has already committed, any batch, keyed by
    // (portfolio_id, source_reference).
    client.all<Record<string, unknown>>(
      `SELECT portfolio_id, source_reference FROM dividend_manual_records
       WHERE user_id = ? AND source_reference IS NOT NULL`,
      [userId],
    ),
  ]);
  const reconciliationCandidates: ImportPreviewDividendReconciliationCandidate[] =
    manualRows.map((row) => ({
      id: String(row.id),
      portfolioSecurityId: String(row.portfolio_security_id),
      paymentDate: String(row.payment_date),
      totalCashDecimal:
        row.total_cash_decimal === null ? null : String(row.total_cash_decimal),
      sharesDecimal:
        row.shares_decimal === null ? null : String(row.shares_decimal),
      dividendPerShareDecimal:
        row.dividend_per_share_decimal === null
          ? null
          : String(row.dividend_per_share_decimal),
    }));
  const existingDividendSourceReferences = new Set(
    existingSourceReferenceRows.map(
      (row) => `${String(row.portfolio_id)}::${String(row.source_reference)}`,
    ),
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
    reconciliationCandidates,
    existingDividendSourceReferences,
  });
}

async function commitBatch(
  client: SqlClient,
  userId: string,
  batchId: string,
  idempotencyKey: string,
  initialVersion = 1,
): Promise<void> {
  const previewVersion = await currentPreviewVersion(client, userId, batchId);
  const ready = await markImportReadyWithContext({ client, userId }, batchId, {
    expectedVersion: initialVersion,
    expectedPreviewVersion: previewVersion,
  });
  assert.equal(ready.ok, true, `expected ${batchId} to reach ready`);
  if (!ready.ok) return;
  const readyVersion = ready.review.batch.version;
  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate(userId, batchId);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: readyVersion,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey,
    confirmation: true,
    requestId: `${idempotencyKey}-request`,
  };
  let commitResult = await commitRepo.commit(userId, batchId, commitInput);
  for (
    let attempt = 0;
    attempt < 10 && (!commitResult.ok || commitResult.status !== "committed");
    attempt += 1
  ) {
    assert.equal(commitResult.ok, true);
    commitResult = await commitRepo.commit(userId, batchId, commitInput);
  }
  assert.equal(commitResult.ok, true);
  if (commitResult.ok) assert.equal(commitResult.status, "committed");
}

test("DIV-016C: a safe match supersedes the existing manual row atomically, records a supersede audit event, and the preview discloses it as PROPOSED without affecting previewVersion", async () => {
  const database = await migratedDatabase();
  seedManualRecord(database, {
    id: "manual-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "membership-a",
    paymentDate: "2026-08-05",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
  });
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-div",
    2,
    totalsDividendRow({
      id: "payout-1",
      paymentDate: "2026-08-05",
      totalCashDecimal: "5.02", // within 1% of the manual row's implied $5.00
      totalFrankingDecimal: "1",
    }),
  );
  const client = createSqliteSqlClient(database);

  // Preview parity: the page preview (WITH reconciliationCandidates) must
  // hash identically to the ready-service/commit-revalidation path (WITHOUT
  // them) -- mirrors DIV-004 B2's precedent exactly, now for
  // DIVIDEND_RECONCILIATION_PROPOSED.
  const page = await pagePreview(client, "user-a", "batch-a");
  const proposed = page.preview.issues.find(
    (issue) => issue.code === "DIVIDEND_RECONCILIATION_PROPOSED",
  );
  assert.ok(proposed, "expected a proposed-reconciliation disclosure");
  assert.equal(proposed!.severity, "info");
  const otherPathVersion = await currentPreviewVersion(
    client,
    "user-a",
    "batch-a",
  );
  assert.equal(
    page.previewVersion,
    otherPathVersion,
    "DIVIDEND_RECONCILIATION_PROPOSED must be excluded from the previewVersion hash",
  );

  await commitBatch(client, "user-a", "batch-a", "div-016c-commit-1");

  const manualRepo = createDividendManualRecordRepository(client);
  const head = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(head.length, 1, "the manual row is excluded once superseded");
  assert.equal(head[0]?.totalCashDecimal, "5.02");
  assert.equal(head[0]?.importBatchId, "batch-a");

  const original = await manualRepo.get("user-a", "portfolio-a", "manual-1");
  assert.ok(original);
  assert.equal(
    original?.supersededByRecordId,
    head[0]?.id,
    "the manual row now points forward at the imported successor",
  );
  // The original row's own financial fields are untouched -- supersession
  // never rewrites the ancestor.
  assert.equal(original?.sharesDecimal, "10");
  assert.equal(original?.dividendPerShareDecimal, "0.5");

  const audit = database
    .prepare(
      `SELECT action, target_id, metadata_json FROM audit_events
       WHERE action = 'dividend.manual_record.supersede' AND target_id = ?`,
    )
    .get(head[0]?.id) as
    { action: string; target_id: string; metadata_json: string } | undefined;
  assert.ok(audit, "expected a supersede audit event for the new row");
  const metadata = JSON.parse(audit!.metadata_json) as Record<string, unknown>;
  assert.equal(metadata.supersedesRecordId, "manual-1");
  assert.equal(metadata.source, "import_reconciliation");
});

test("DIV-016C: a different payment date never matches -- both the manual row and the imported row count independently", async () => {
  const database = await migratedDatabase();
  seedManualRecord(database, {
    id: "manual-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "membership-a",
    paymentDate: "2026-08-05",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
  });
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-div",
    2,
    totalsDividendRow({
      id: "payout-1",
      paymentDate: "2026-08-06",
      totalCashDecimal: "5",
    }),
  );
  const client = createSqliteSqlClient(database);
  await commitBatch(client, "user-a", "batch-a", "div-016c-commit-2");

  const manualRepo = createDividendManualRecordRepository(client);
  const head = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(head.length, 2, "unmatched rows both survive, uncollapsed");
  assert.equal(
    head.every((record) => record.supersededByRecordId === null),
    true,
  );
});

test("DIV-016C: ambiguous match -- two manual candidates for one incoming row reconciles NEITHER; all three rows survive independently", async () => {
  const database = await migratedDatabase();
  seedManualRecord(database, {
    id: "manual-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "membership-a",
    paymentDate: "2026-08-05",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
  });
  seedManualRecord(database, {
    id: "manual-2",
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "membership-a",
    paymentDate: "2026-08-05",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
  });
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-div",
    2,
    totalsDividendRow({
      id: "payout-1",
      paymentDate: "2026-08-05",
      totalCashDecimal: "5",
    }),
  );
  const client = createSqliteSqlClient(database);

  const page = await pagePreview(client, "user-a", "batch-a");
  const ambiguous = page.preview.issues.find(
    (issue) => issue.code === "DIVIDEND_RECONCILIATION_AMBIGUOUS",
  );
  assert.ok(ambiguous, "expected an ambiguous-match disclosure");
  assert.equal(ambiguous!.severity, "warning");
  assert.equal(page.preview.ready, true, "ambiguity never blocks readiness");

  await commitBatch(client, "user-a", "batch-a", "div-016c-commit-3");

  const manualRepo = createDividendManualRecordRepository(client);
  const head = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    head.length,
    3,
    "neither manual candidate was superseded -- the incoming row commits standalone",
  );
  assert.equal(
    head.every((record) => record.supersededByRecordId === null),
    true,
  );
});

test("DIV-016C: ambiguous match -- two incoming rows matching one manual candidate reconciles NEITHER, even across the whole batch (not just one commit chunk)", async () => {
  const database = await migratedDatabase();
  seedManualRecord(database, {
    id: "manual-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "membership-a",
    paymentDate: "2026-08-05",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
  });
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-div-1",
    2,
    totalsDividendRow({
      id: "payout-1",
      paymentDate: "2026-08-05",
      totalCashDecimal: "5",
    }),
  );
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-div-2",
    3,
    totalsDividendRow({
      id: "payout-2",
      paymentDate: "2026-08-05",
      totalCashDecimal: "5.01",
    }),
  );
  const client = createSqliteSqlClient(database);
  await commitBatch(client, "user-a", "batch-a", "div-016c-commit-4");

  const manualRepo = createDividendManualRecordRepository(client);
  const head = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    head.length,
    3,
    "the manual row and both incoming rows all survive, unreconciled",
  );
  assert.equal(
    head.every((record) => record.supersededByRecordId === null),
    true,
  );
});

test("DIV-016C: reversing the Sharesight batch restores the manual row's evidence -- un-supersede, never a silent loss", async () => {
  const database = await migratedDatabase();
  seedManualRecord(database, {
    id: "manual-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "membership-a",
    paymentDate: "2026-08-05",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
  });
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-div",
    2,
    totalsDividendRow({
      id: "payout-1",
      paymentDate: "2026-08-05",
      totalCashDecimal: "5",
    }),
  );
  const client = createSqliteSqlClient(database);
  await commitBatch(client, "user-a", "batch-a", "div-016c-commit-5");

  const manualRepo = createDividendManualRecordRepository(client);
  const superseded = await manualRepo.get("user-a", "portfolio-a", "manual-1");
  assert.ok(superseded?.supersededByRecordId);
  const importedId = superseded!.supersededByRecordId!;

  const reversalRepo = createOwnedImportReversalRepository(client);
  const batch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    "batch-a",
  );
  assert.ok(batch);
  let reversal = await reversalRepo.reverse("user-a", "batch-a", {
    expectedVersion: batch!.version,
    idempotencyKey: "div-016c-reversal-1",
    confirmation: true,
    requestId: "div-016c-reversal-1-request",
  });
  for (
    let attempt = 0;
    attempt < 10 && (!reversal.ok || reversal.status !== "reversed");
    attempt += 1
  ) {
    assert.equal(reversal.ok, true);
    reversal = await reversalRepo.reverse("user-a", "batch-a", {
      expectedVersion: batch!.version,
      idempotencyKey: "div-016c-reversal-1",
      confirmation: true,
      requestId: "div-016c-reversal-1-request",
    });
  }
  assert.equal(reversal.ok, true);
  if (reversal.ok) assert.equal(reversal.status, "reversed");

  // The imported successor is gone (IMP-006's existing hard-delete on
  // reversal, unchanged by this task).
  const importedGone = await manualRepo.get(
    "user-a",
    "portfolio-a",
    importedId,
  );
  assert.equal(importedGone, null);

  // The manual row is restored to head-of-lineage with its ORIGINAL
  // financial facts intact, and reappears in list().
  const restored = await manualRepo.get("user-a", "portfolio-a", "manual-1");
  assert.ok(restored);
  assert.equal(restored?.supersededByRecordId, null);
  assert.equal(restored?.sharesDecimal, "10");
  assert.equal(restored?.dividendPerShareDecimal, "0.5");
  const headAfterReversal = await manualRepo.list("user-a", "portfolio-a");
  assert.deepEqual(
    headAfterReversal.map((record) => record.id),
    ["manual-1"],
  );
});

test("DIV-016C: idempotent re-import -- re-syncing the identical distribution never re-reconciles or chains a second supersession", async () => {
  const database = await migratedDatabase();
  seedManualRecord(database, {
    id: "manual-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "membership-a",
    paymentDate: "2026-08-05",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
  });
  const normalized = totalsDividendRow({
    id: "payout-1",
    paymentDate: "2026-08-05",
    totalCashDecimal: "5",
  });
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-div",
    2,
    normalized,
    "shared-fingerprint",
  );
  const client = createSqliteSqlClient(database);
  await commitBatch(client, "user-a", "batch-a", "div-016c-commit-6a");

  const manualRepo = createDividendManualRecordRepository(client);
  const afterFirst = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(afterFirst.length, 1);
  const firstSuccessorId = afterFirst[0]!.id;

  // A second, later sync re-stages the SAME real-world payout (identical
  // content -> identical fingerprint/source_reference) in a fresh batch.
  stageRow(
    database,
    "user-a",
    "batch-b",
    "row-div-2",
    2,
    normalized,
    "shared-fingerprint",
  );
  await commitBatch(client, "user-a", "batch-b", "div-016c-commit-6b");

  const afterSecond = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    afterSecond.length,
    1,
    "cross-batch source_reference idempotency short-circuits before reconciliation runs again",
  );
  assert.equal(afterSecond[0]?.id, firstSuccessorId);
  const original = await manualRepo.get("user-a", "portfolio-a", "manual-1");
  assert.equal(
    original?.supersededByRecordId,
    firstSuccessorId,
    "still pointing at the FIRST successor -- never re-targeted or chained",
  );
});

// B1 (review round 1 BLOCKING, reviewer's exact repro): batch-a imports a
// payout with NO manual row yet (nothing to reconcile) -> the owner
// separately enters a MANUAL row for the same distribution afterward
// (unaware batch-a already covered it) -> batch-b re-imports the identical
// payout. Before the fix, batch-b's preview would have offered
// DIVIDEND_RECONCILIATION_PROPOSED against the manual row -- a false
// promise, since batch-b's row's own source_reference already exists from
// batch-a and dedupe-skips BEFORE the supersede step ever runs. After the
// fix: the preview shows DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE
// instead (never PROPOSED), commit performs no supersede, and both the
// original imported row (batch-a) and the manual row stay independent
// heads -- an honest, disclosed double count, not a silently broken
// promise.
test("DIV-016C B1: batch-a import -> manual row -> batch-b re-import of the identical payout shows the ALREADY_IMPORTED warning (never PROPOSED), and commit performs no supersede", async () => {
  const database = await migratedDatabase();
  const normalized = totalsDividendRow({
    id: "payout-1",
    paymentDate: "2026-08-05",
    totalCashDecimal: "5",
  });
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-div-a",
    2,
    normalized,
    "shared-fingerprint-b1",
  );
  const client = createSqliteSqlClient(database);
  await commitBatch(client, "user-a", "batch-a", "div-016c-b1-commit-a");

  const manualRepo = createDividendManualRecordRepository(client);
  const afterBatchA = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    afterBatchA.length,
    1,
    "batch-a's imported row, no manual row yet",
  );
  const importedFromBatchA = afterBatchA[0]!.id;

  // The owner separately enters a manual row for the SAME distribution,
  // unaware batch-a already covered it -- a genuine, independent fact.
  seedManualRecord(database, {
    id: "manual-late",
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "membership-a",
    paymentDate: "2026-08-05",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
  });

  // batch-b re-imports the IDENTICAL payout (same fingerprint -> same
  // source_reference as batch-a's already-committed row).
  stageRow(
    database,
    "user-a",
    "batch-b",
    "row-div-b",
    2,
    normalized,
    "shared-fingerprint-b1",
  );

  const page = await pagePreview(client, "user-a", "batch-b");
  const proposed = page.preview.issues.find(
    (issue) => issue.code === "DIVIDEND_RECONCILIATION_PROPOSED",
  );
  assert.equal(
    proposed,
    undefined,
    "must NEVER promise a reconciliation for a row that will dedupe-skip",
  );
  const duplicateWarning = page.preview.issues.find(
    (issue) => issue.code === "DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE",
  );
  assert.ok(duplicateWarning, "expected the honest already-imported warning");
  assert.equal(duplicateWarning!.severity, "warning");
  assert.match(duplicateWarning!.message, /already imported/i);
  assert.match(duplicateWarning!.message, /manually entered/i);
  assert.match(duplicateWarning!.message, /double-counted/i);

  // Hash parity: the new warning is advisory-only, excluded from
  // previewVersion, same as PROPOSED/AMBIGUOUS/DIVIDEND_NEAR_EXISTING_ENTRY.
  const otherPathVersion = await currentPreviewVersion(
    client,
    "user-a",
    "batch-b",
  );
  assert.equal(page.previewVersion, otherPathVersion);

  await commitBatch(client, "user-a", "batch-b", "div-016c-b1-commit-b");

  const afterBatchB = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    afterBatchB.length,
    2,
    "the batch-a imported row and the manual row both remain independent heads -- no supersede happened",
  );
  assert.equal(
    afterBatchB.every((record) => record.supersededByRecordId === null),
    true,
  );
  const stillImported = await manualRepo.get(
    "user-a",
    "portfolio-a",
    importedFromBatchA,
  );
  const stillManual = await manualRepo.get(
    "user-a",
    "portfolio-a",
    "manual-late",
  );
  assert.ok(stillImported);
  assert.ok(stillManual);
  assert.equal(stillImported?.supersededByRecordId, null);
  assert.equal(stillManual?.supersededByRecordId, null);
});

// Sibling case that motivated the freshRows/alreadyImportedRows pool split
// (the B1 fix's own rationale): a SINGLE batch carries both a dedupe-bound
// row and a genuinely fresh row that BOTH match the same manual candidate.
// Excluding the dedupe-bound row from the matching pool entirely means the
// fresh row is left as a clean, unambiguous 1:1 match -- never wrongly
// poisoned into DIVIDEND_RECONCILIATION_AMBIGUOUS just because a sibling
// row (which could never actually insert anyway) also resembled the same
// candidate.
test("DIV-016C: a dedupe-bound row and a genuinely fresh row in the SAME batch both matching one manual candidate -- the fresh row cleanly reconciles, the dedupe-bound row gets the honest warning, neither is ambiguous", async () => {
  const database = await migratedDatabase();
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-a",
    2,
    totalsDividendRow({
      id: "payout-a",
      paymentDate: "2026-08-05",
      totalCashDecimal: "5",
    }),
    "shared-fingerprint-sibling",
  );
  const client = createSqliteSqlClient(database);
  await commitBatch(client, "user-a", "batch-a", "div-016c-sibling-commit-a");

  const manualRepo = createDividendManualRecordRepository(client);
  const afterBatchA = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    afterBatchA.length,
    1,
    "batch-a's imported row, no manual row yet",
  );
  const importedFromBatchA = afterBatchA[0]!.id;

  seedManualRecord(database, {
    id: "manual-sibling",
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "membership-a",
    paymentDate: "2026-08-05",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
  });

  // batch-b carries TWO rows for the same security/date/amount: one whose
  // fingerprint already exists (dedupe-bound, from batch-a) and one whose
  // fingerprint is genuinely new (fresh -- eligible to actually insert).
  stageRow(
    database,
    "user-a",
    "batch-b",
    "row-b-dup",
    2,
    totalsDividendRow({
      id: "payout-b-dup",
      paymentDate: "2026-08-05",
      totalCashDecimal: "5",
    }),
    "shared-fingerprint-sibling",
  );
  stageRow(
    database,
    "user-a",
    "batch-b",
    "row-b-fresh",
    3,
    totalsDividendRow({
      id: "payout-b-fresh",
      paymentDate: "2026-08-05",
      totalCashDecimal: "5",
    }),
    "fresh-fingerprint-sibling",
  );

  const page = await pagePreview(client, "user-a", "batch-b");
  const proposedIssues = page.preview.issues.filter(
    (issue) => issue.code === "DIVIDEND_RECONCILIATION_PROPOSED",
  );
  const duplicateIssues = page.preview.issues.filter(
    (issue) => issue.code === "DIVIDEND_ALREADY_IMPORTED_MANUAL_DUPLICATE",
  );
  const ambiguousIssues = page.preview.issues.filter(
    (issue) => issue.code === "DIVIDEND_RECONCILIATION_AMBIGUOUS",
  );
  assert.equal(
    proposedIssues.length,
    1,
    "exactly the fresh row gets a proposed reconciliation",
  );
  assert.equal(proposedIssues[0]?.rowId, "row-b-fresh");
  assert.equal(
    duplicateIssues.length,
    1,
    "exactly the dedupe-bound row gets the honest already-imported warning",
  );
  assert.equal(duplicateIssues[0]?.rowId, "row-b-dup");
  assert.equal(
    ambiguousIssues.length,
    0,
    "excluding the dedupe-bound row from the pool means the fresh row is a clean 1:1 match, never ambiguous",
  );

  await commitBatch(client, "user-a", "batch-b", "div-016c-sibling-commit-b");

  const afterBatchB = await manualRepo.list("user-a", "portfolio-a");
  // Heads: batch-a's original imported row (untouched), the batch-b fresh
  // row (the new head of the manual lineage), and the batch-b dedupe-bound
  // row never inserted at all (skipped).
  assert.equal(afterBatchB.length, 2);
  const stillImportedFromBatchA = await manualRepo.get(
    "user-a",
    "portfolio-a",
    importedFromBatchA,
  );
  assert.ok(stillImportedFromBatchA);
  assert.equal(stillImportedFromBatchA?.supersededByRecordId, null);

  const supersededManual = await manualRepo.get(
    "user-a",
    "portfolio-a",
    "manual-sibling",
  );
  assert.ok(supersededManual);
  assert.ok(
    supersededManual?.supersededByRecordId,
    "the manual row was superseded by the batch-b FRESH row",
  );
  const successor = await manualRepo.get(
    "user-a",
    "portfolio-a",
    supersededManual!.supersededByRecordId!,
  );
  assert.ok(successor);
  assert.equal(successor?.importBatchId, "batch-b");
  assert.equal(successor?.totalCashDecimal, "5");
  // The dedupe-bound row never created a second record in batch-b.
  const batchBRecords = (await database
    .prepare(
      `SELECT COUNT(*) AS count FROM dividend_manual_records WHERE import_batch_id = 'batch-b'`,
    )
    .get()) as { count: number };
  assert.equal(batchBRecords.count, 1);
});

test("DIV-016C: cross-user isolation -- another owner's identically-shaped manual row is never matched or superseded", async () => {
  const database = await migratedDatabase();
  seedManualRecord(database, {
    id: "manual-b",
    userId: "user-b",
    portfolioId: "portfolio-b",
    portfolioSecurityId: "membership-b",
    paymentDate: "2026-08-05",
    sharesDecimal: "10",
    dividendPerShareDecimal: "0.5",
  });
  stageRow(
    database,
    "user-a",
    "batch-a",
    "row-div",
    2,
    totalsDividendRow({
      id: "payout-1",
      paymentDate: "2026-08-05",
      totalCashDecimal: "5",
    }),
  );
  const client = createSqliteSqlClient(database);
  await commitBatch(client, "user-a", "batch-a", "div-016c-commit-7");

  const manualRepoA = createDividendManualRecordRepository(client);
  const ownerARows = await manualRepoA.list("user-a", "portfolio-a");
  assert.equal(
    ownerARows.length,
    1,
    "user-a's incoming dividend commits standalone -- no cross-owner candidate exists to match",
  );
  const ownerBRow = await manualRepoA.get("user-b", "portfolio-b", "manual-b");
  assert.ok(ownerBRow);
  assert.equal(
    ownerBRow?.supersededByRecordId,
    null,
    "another owner's row is never touched by this commit",
  );
});

// ---------------------------------------------------------------------------
// Part B follow-up (b): force_assumption clears when both override fields
// are saved null.
// ---------------------------------------------------------------------------

test("DIV-016 part B follow-up (b): saving both override fields null clears a previously-forced force_assumption flag server-side", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const repo = createDividendAssumptionsRepository(client);

  const created = await repo.saveSecurityAssumptions(
    "user-a",
    "portfolio-a",
    "membership-a",
    {
      dividendYieldPercentDecimal: "4.5",
      frankingPercentDecimal: "100",
      dividendGrowthPercentDecimal: null,
      forceAssumption: true,
      expectedVersion: null,
      requestId: "req-1",
    },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.assumptions.forceAssumption, true);

  // The owner clears both override fields but the client still submits
  // `forceAssumption: true` (e.g. a stale form value) -- the server must
  // clamp it to false regardless, since "forced" is meaningless with no
  // override left to force.
  const cleared = await repo.saveSecurityAssumptions(
    "user-a",
    "portfolio-a",
    "membership-a",
    {
      dividendYieldPercentDecimal: null,
      frankingPercentDecimal: null,
      dividendGrowthPercentDecimal: null,
      forceAssumption: true,
      expectedVersion: created.assumptions.version,
      requestId: "req-2",
    },
  );
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.equal(
    cleared.assumptions.forceAssumption,
    false,
    "force_assumption is clamped to false once neither override field is set",
  );

  // Re-entering a value later must NOT silently resurrect "forced" -- the
  // owner must explicitly re-check the box (a fresh, honest true).
  const reEntered = await repo.saveSecurityAssumptions(
    "user-a",
    "portfolio-a",
    "membership-a",
    {
      dividendYieldPercentDecimal: "5",
      frankingPercentDecimal: null,
      dividendGrowthPercentDecimal: null,
      forceAssumption: false,
      expectedVersion: cleared.assumptions.version,
      requestId: "req-3",
    },
  );
  assert.equal(reEntered.ok, true);
  if (!reEntered.ok) return;
  assert.equal(reEntered.assumptions.forceAssumption, false);
});

test("DIV-016 part B follow-up (b): forceAssumption stays true when saved alongside a real override", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const repo = createDividendAssumptionsRepository(client);

  const created = await repo.saveSecurityAssumptions(
    "user-a",
    "portfolio-a",
    "membership-a",
    {
      dividendYieldPercentDecimal: null,
      frankingPercentDecimal: "50",
      dividendGrowthPercentDecimal: null,
      forceAssumption: true,
      expectedVersion: null,
      requestId: "req-1",
    },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(
    created.assumptions.forceAssumption,
    true,
    "a real override (franking, even with yield null) keeps the honest force flag",
  );
});
