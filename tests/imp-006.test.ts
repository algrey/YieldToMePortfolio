import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedPortfolioRepository,
  createDividendManualRecordRepository,
  createOwnedLedgerRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  createImportReconciliationPreview,
  parseStrictVersionedCsvImport,
  SUPPORTED_IMPORT_HEADER,
  SUPPORTED_IMPORT_HEADER_WITH_DIVIDENDS,
  SUPPORTED_IMPORT_PARSER_VERSION,
  SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS,
  type ImportReconciliationRow,
} from "../domain/imports/index.ts";
import { deriveDividendHistoryForSecurity } from "../domain/dividends/history.ts";

function makeCsv(rows: string[]): string {
  return [SUPPORTED_IMPORT_HEADER_WITH_DIVIDENDS.join(","), ...rows].join("\n");
}

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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-13', '2026-08-13', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-13', '2026-08-13');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-13', '2026-08-13');
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS}', 'sample.csv', 100, 'file-a', 'parsed',
      '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 1),
      ('batch-b', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS}', 'sample2.csv', 100, 'file-b', 'parsed',
      '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 1);
  `);
  return database;
}

function buyRow(
  overrides: Partial<{
    id: string;
    transactionDate: string;
    transactionTime: string;
    tradeAtUtc: string;
    localTradeDate: string;
  }> = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? "trade-1",
    symbol: "ABC",
    name: "Alpha",
    displaySymbol: null,
    exchange: "ASX",
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: "5",
    costPerShare: "10",
    commission: "0",
    transactionDate: overrides.transactionDate ?? "2026-08-01 GMT+1000",
    transactionTime: overrides.transactionTime ?? "10:00:00",
    purchaseExchangeRate: null,
    type: "buy",
    accounting: "fifo",
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: overrides.tradeAtUtc ?? "2026-08-01T00:00:00.000Z",
    localTradeDate: overrides.localTradeDate ?? "2026-08-01",
    cashEvent: null,
    frankingPerShare: null,
  };
}

function dividendRow(
  overrides: Partial<{
    id: string;
    symbol: string;
    exchange: string | null;
    currency: string;
    sharesOwned: string;
    costPerShare: string;
    frankingPerShare: string | null;
    paymentDate: string;
    localTradeDate: string;
  }> = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? "div-1",
    symbol: overrides.symbol ?? "ABC",
    name: "Alpha",
    displaySymbol: null,
    exchange: overrides.exchange ?? "ASX",
    portfolio: "Main",
    currency: overrides.currency ?? "AUD",
    sharesOwned: overrides.sharesOwned ?? "5",
    costPerShare: overrides.costPerShare ?? "0.5",
    commission: "0",
    transactionDate: overrides.paymentDate ?? "2026-08-05 GMT+1000",
    transactionTime: null,
    purchaseExchangeRate: null,
    type: "dividend",
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: "2026-08-04T14:00:00.000Z",
    localTradeDate: overrides.localTradeDate ?? "2026-08-05",
    cashEvent: null,
    frankingPerShare:
      overrides.frankingPerShare === undefined
        ? "0.21"
        : overrides.frankingPerShare,
  };
}

function stageRow(
  database: DatabaseSync,
  batchId: string,
  rowId: string,
  physicalRowNumber: number,
  normalized: Record<string, unknown>,
  // Real fingerprints are content-derived (see `normalizeRowForFingerprint`)
  // and therefore identical across batches for a genuine re-import of the
  // same source row; tests that exercise cross-batch duplicate detection
  // pass an explicit shared value, everything else gets a row-unique one.
  fingerprint?: string,
): void {
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, commit_status, created_at, updated_at, version
       ) VALUES (?, 'user-a', ?, ?, 'transaction', '[]', ?, ?, 'valid',
         NULL, 'staged', '2026-08-13', '2026-08-13', 1)`,
    )
    .run(
      rowId,
      batchId,
      physicalRowNumber,
      JSON.stringify(normalized),
      fingerprint ?? `fingerprint-${batchId}-${rowId}`,
    );
}

// BUG-016: a pre-existing OWNER-typed manual record (no `import_batch_id`,
// no `superseded_by_record_id`) -- the DIV-016C reconciliation candidate
// shape (mirrors `tests/div-016c.test.ts`'s identical helper). Used to prove
// that a chunked reversal's un-supersede restore only ever fires on the
// FINAL invocation, and fires exactly once even if the final invocation is
// itself repeated.
function seedManualRecord(
  database: DatabaseSync,
  overrides: {
    id: string;
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
       ) VALUES (?, 'user-a', 'portfolio-a', ?, ?, ?, ?, NULL, NULL, NULL, '2026-08-01', '2026-08-01', 1)`,
    )
    .run(
      overrides.id,
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

async function commitBatch(
  client: SqlClient,
  batchId: string,
  idempotencyKey: string,
  initialVersion = 1,
): Promise<void> {
  const previewVersion = await currentPreviewVersion(client, "user-a", batchId);
  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    batchId,
    { expectedVersion: initialVersion, expectedPreviewVersion: previewVersion },
  );
  assert.equal(ready.ok, true, `expected ${batchId} to reach ready`);
  if (!ready.ok) return;
  const readyVersion = ready.review.batch.version;
  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", batchId);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: readyVersion,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey,
    confirmation: true,
    requestId: `${idempotencyKey}-request`,
  };
  let commitResult = await commitRepo.commit("user-a", batchId, commitInput);
  for (
    let attempt = 0;
    attempt < 10 && (!commitResult.ok || commitResult.status !== "committed");
    attempt += 1
  ) {
    assert.equal(commitResult.ok, true);
    commitResult = await commitRepo.commit("user-a", batchId, commitInput);
  }
  assert.equal(commitResult.ok, true);
  if (commitResult.ok) assert.equal(commitResult.status, "committed");
}

// ---------------------------------------------------------------------------
// Parser: header/row-grammar/validation edge cases
// ---------------------------------------------------------------------------

test("the original 17-column header keeps parsing under the original parser version (backward compatibility)", async () => {
  const csv = [
    SUPPORTED_IMPORT_HEADER.join(","),
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,`,
  ].join("\n");
  const result = await parseStrictVersionedCsvImport(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.parserVersion, SUPPORTED_IMPORT_PARSER_VERSION);
  assert.equal(result.header.parserVersion, SUPPORTED_IMPORT_PARSER_VERSION);
});

// Review B1 fix + regression pin: `normalizeRowForFingerprint` used to
// append `row.frankingPerShare ?? ""` unconditionally, which changed EVERY
// row's fingerprint -- including every legacy 17-column row, which can
// never carry franking at all. That silently broke cross-version
// idempotency: the exact same bytes already committed under the pre-IMP-006
// parser would no longer fingerprint-match themselves on a later re-import
// and would double-post (quantities doubling on re-import). This constant
// is the fingerprint HEAD (commit d158e3a, before any IMP-006 change)
// produces for the row below, verified by running that exact commit's
// `strict-versioned-parser.ts` against the same input -- a fixture pin so
// any future change to the canonical serialization fails loudly here
// instead of silently corrupting re-imports.
const PINNED_LEGACY_FINGERPRINT =
  "41c4c2d71f2570758c0795f8c405fca2dc21a63009218277b70396cb723aa87f";

test("fingerprint stability pin: a 17-column row's fingerprint is byte-identical to the pre-IMP-006 value", async () => {
  const csv = [
    SUPPORTED_IMPORT_HEADER.join(","),
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"note"`,
  ].join("\n");
  const result = await parseStrictVersionedCsvImport(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0]?.fingerprint, PINNED_LEGACY_FINGERPRINT);
});

test("cross-version idempotency: a file already committed under the 17-column parser re-fingerprints identically, and an 18-column row with blank franking hashes like its 17-column equivalent", async () => {
  // Reproduces the reviewer's exact scenario: a file committed under the
  // original 17-column parser must not re-fingerprint differently (and
  // therefore re-post as a DUPLICATE, doubling quantity) merely because the
  // parser module now also understands an 18-column dividend variant.
  const legacyCsv = [
    SUPPORTED_IMPORT_HEADER.join(","),
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"note"`,
  ].join("\n");
  const legacyResult = await parseStrictVersionedCsvImport(legacyCsv);
  assert.equal(legacyResult.ok, true);
  if (!legacyResult.ok) return;
  assert.equal(legacyResult.rows[0]?.fingerprint, PINNED_LEGACY_FINGERPRINT);

  // The identical row content, but through the 18-column dividend-capable
  // header with the trailing franking column left blank, must hash
  // IDENTICALLY to the 17-column version above -- a blank/absent franking
  // column is never part of a non-dividend row's identity.
  const dividendCapableCsv = [
    SUPPORTED_IMPORT_HEADER_WITH_DIVIDENDS.join(","),
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2025-07-16 GMT+1000","14:35:00",,"Buy",,,"note",`,
  ].join("\n");
  const dividendCapableResult =
    await parseStrictVersionedCsvImport(dividendCapableCsv);
  assert.equal(dividendCapableResult.ok, true);
  if (!dividendCapableResult.ok) return;
  assert.equal(
    dividendCapableResult.rows[0]?.fingerprint,
    PINNED_LEGACY_FINGERPRINT,
  );
});

test("the 18-column dividend-capable header tolerates BOM/CRLF and parses a Dividend row", async () => {
  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD",,,,,,,,,,,`,
    `"2","ABC","Alpha",,"ASX","Main","AUD","5","0.50","0","2026-08-05 GMT+1000",,,"Dividend",,,,"0.21"`,
  ]);
  const withBomAndCrlf = `﻿${csv.replace(/\n/g, "\r\n")}`;
  const result = await parseStrictVersionedCsvImport(withBomAndCrlf);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.parserVersion,
    SUPPORTED_IMPORT_PARSER_VERSION_WITH_DIVIDENDS,
  );
  assert.equal(result.summary.dividendRows, 1);
  const row = result.rows.find((row) => row.normalized.type === "dividend");
  assert.ok(row);
  assert.equal(row?.kind, "transaction");
  assert.equal(row?.normalized.sharesOwned, "5");
  assert.equal(row?.normalized.costPerShare, "0.5");
  assert.equal(row?.normalized.frankingPerShare, "0.21");
  assert.equal(row?.normalized.localTradeDate, "2026-08-05");
  assert.equal(row?.issues.length, 0);
});

test("missing franking is unknown (null), never a silent zero", async () => {
  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","5","0.50","0","2026-08-05 GMT+1000",,,"Dividend",,,,`,
  ]);
  const result = await parseStrictVersionedCsvImport(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0]?.normalized.frankingPerShare, null);
  assert.equal(
    result.rows[0]?.issues.some((issue) => issue.code === "FRANKING_INVALID"),
    false,
  );
});

test("a Dividend row on the ORIGINAL 17-column header parses cleanly with franking always null (the column simply doesn't exist)", async () => {
  const csv = [
    SUPPORTED_IMPORT_HEADER.join(","),
    `"1","ABC","Alpha",,"ASX","Main","AUD","5","0.50","0","2026-08-05 GMT+1000",,,"Dividend",,,`,
  ].join("\n");
  const result = await parseStrictVersionedCsvImport(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.parserVersion, SUPPORTED_IMPORT_PARSER_VERSION);
  assert.equal(result.summary.dividendRows, 1);
  assert.equal(result.rows[0]?.kind, "transaction");
  assert.equal(result.rows[0]?.normalized.type, "dividend");
  assert.equal(result.rows[0]?.normalized.frankingPerShare, null);
  assert.equal(result.rows[0]?.issues.length, 0);
});

test("a malformed franking value is a distinct blocking issue, not silently treated as unknown", async () => {
  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","5","0.50","0","2026-08-05 GMT+1000",,,"Dividend",,,,"not-a-number"`,
  ]);
  const result = await parseStrictVersionedCsvImport(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0]?.kind, "unsupported");
  assert.equal(result.rows[0]?.normalized.frankingPerShare, null);
  assert.equal(
    result.rows[0]?.issues.some((issue) => issue.code === "FRANKING_INVALID"),
    true,
  );
});

test("a negative franking value is rejected", async () => {
  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","5","0.50","0","2026-08-05 GMT+1000",,,"Dividend",,,,"-0.10"`,
  ]);
  const result = await parseStrictVersionedCsvImport(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0]?.kind, "unsupported");
  assert.equal(
    result.rows[0]?.issues.some((issue) => issue.code === "FRANKING_INVALID"),
    true,
  );
});

test("franking on a non-dividend row is a warning, is ignored, and never contributes to that row's fingerprint (follow-up 1)", async () => {
  const withFranking = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2026-08-05 GMT+1000","10:00:00",,"Buy",,,,"0.30"`,
  ]);
  const withoutFranking = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","3","12.50","0","2026-08-05 GMT+1000","10:00:00",,"Buy",,,,`,
  ]);
  const resultWithFranking = await parseStrictVersionedCsvImport(withFranking);
  const resultWithoutFranking =
    await parseStrictVersionedCsvImport(withoutFranking);
  assert.equal(resultWithFranking.ok, true);
  assert.equal(resultWithoutFranking.ok, true);
  if (!resultWithFranking.ok || !resultWithoutFranking.ok) return;

  // Not silently dropped -- surfaced as a warning -- but doesn't block the row.
  assert.equal(resultWithFranking.rows[0]?.kind, "transaction");
  assert.equal(
    resultWithFranking.rows[0]?.issues.some(
      (issue) =>
        issue.code === "FRANKING_ON_NON_DIVIDEND" &&
        issue.severity === "warning",
    ),
    true,
  );
  assert.equal(resultWithoutFranking.rows[0]?.issues.length, 0);

  // Excluded from identity: a buy row with a stray franking value
  // fingerprints identically to the same row without it.
  assert.equal(
    resultWithFranking.rows[0]?.fingerprint,
    resultWithoutFranking.rows[0]?.fingerprint,
  );
});

test("a zero dividend-per-share is rejected (a dividend must be a positive amount)", async () => {
  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","5","0","0","2026-08-05 GMT+1000",,,"Dividend",,,,`,
  ]);
  const result = await parseStrictVersionedCsvImport(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0]?.kind, "unsupported");
  assert.equal(
    result.rows[0]?.issues.some(
      (issue) => issue.code === "DIVIDEND_PER_SHARE_INVALID",
    ),
    true,
  );
});

test("a malformed dividend-per-share (Cost Per Share) decimal blocks the row like any other price field", async () => {
  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","5","not-a-price","0","2026-08-05 GMT+1000",,,"Dividend",,,,`,
  ]);
  const result = await parseStrictVersionedCsvImport(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0]?.kind, "unsupported");
  assert.equal(
    result.rows[0]?.issues.some((issue) => issue.code === "PRICE_INVALID"),
    true,
  );
});

test("a bad payment date blocks a dividend row exactly like a bad transaction date on a trade", async () => {
  const csv = makeCsv([
    `"1","ABC","Alpha",,"ASX","Main","AUD","5","0.50","0","not-a-date",,,"Dividend",,,,`,
  ]);
  const result = await parseStrictVersionedCsvImport(csv);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0]?.kind, "unsupported");
  assert.equal(
    result.rows[0]?.issues.some((issue) => issue.code === "DATE_INVALID"),
    true,
  );
});

// ---------------------------------------------------------------------------
// Reconciliation preview: per-type counts and unresolved-security blocking
// ---------------------------------------------------------------------------

test("preview reports separate per-type counts for trade and dividend rows", () => {
  const portfolio = {
    id: "portfolio-a",
    name: "Main",
    homeCurrencyCode: "AUD",
    historyCompleteFrom: "2026-01-01",
  };
  const security = {
    id: "membership-a",
    portfolioId: "portfolio-a",
    sourceSymbol: "ABC",
    sourceExchangeAlias: "ASX",
    sourceCurrencyCode: "AUD",
    securityId: "security-a",
  };
  const rows: ImportReconciliationRow[] = [
    {
      id: "trade-1",
      physicalRowNumber: 2,
      rowClass: "transaction",
      fingerprint: "trade-1",
      normalized: buyRow() as never,
    },
    {
      id: "div-1",
      physicalRowNumber: 3,
      rowClass: "transaction",
      fingerprint: "div-1",
      normalized: dividendRow() as never,
    },
  ];
  const preview = createImportReconciliationPreview({
    portfolios: [portfolio],
    securityCandidates: [security],
    rows,
  });
  assert.equal(preview.ready, true);
  assert.equal(preview.counts.transactionCreates, 1);
  assert.equal(preview.counts.dividendCreates, 1);
});

test("a dividend row for an unresolved security blocks readiness exactly like a trade row (SECURITY_MAPPING_REQUIRED)", () => {
  const portfolio = {
    id: "portfolio-a",
    name: "Main",
    homeCurrencyCode: "AUD",
    historyCompleteFrom: "2026-01-01",
  };
  const rows: ImportReconciliationRow[] = [
    {
      id: "div-1",
      physicalRowNumber: 2,
      rowClass: "transaction",
      fingerprint: "div-1",
      normalized: dividendRow({ symbol: "ZZZ" }) as never,
    },
  ];
  const preview = createImportReconciliationPreview({
    portfolios: [portfolio],
    securityCandidates: [],
    rows,
  });
  assert.equal(preview.ready, false);
  assert.equal(
    preview.issues.some((issue) => issue.code === "SECURITY_MAPPING_REQUIRED"),
    true,
  );
  assert.equal(preview.unresolvedCandidates.length, 1);
});

// ---------------------------------------------------------------------------
// Commit / reversal round trip
// ---------------------------------------------------------------------------

test("a mixed trade+dividend batch commits atomically, and reversal removes the dividend record and reverses the trade", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", 2, buyRow());
  stageRow(database, "batch-a", "row-2", 3, dividendRow());
  const client = createSqliteSqlClient(database);

  await commitBatch(client, "batch-a", "imp-006-commit");

  const trade = database
    .prepare(
      `SELECT status, type, quantity_decimal FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = 'membership-a'`,
    )
    .get() as
    { status: string; type: string; quantity_decimal: string } | undefined;
  assert.ok(trade, "expected a posted ledger transaction for the buy row");
  assert.equal(trade?.status, "posted");
  assert.equal(trade?.type, "buy");

  const manualRepo = createDividendManualRecordRepository(client);
  const records = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.portfolioSecurityId, "membership-a");
  assert.equal(record.sharesDecimal, "5");
  assert.equal(record.dividendPerShareDecimal, "0.5");
  assert.equal(record.frankingCreditPerShareDecimal, "0.21");
  assert.equal(record.paymentDate, "2026-08-05");
  assert.equal(record.importBatchId, "batch-a");
  assert.equal(
    record.sourceReference,
    "import-fingerprint:fingerprint-batch-a-row-2",
  );

  const rows = await createOwnedImportStagingRepository(client).listRows(
    "user-a",
    "batch-a",
  );
  const tradeRow = rows.find((row) => row.id === "row-1");
  const dividendRowRecord = rows.find((row) => row.id === "row-2");
  assert.equal(tradeRow?.commitStatus, "committed");
  assert.equal(dividendRowRecord?.commitStatus, "committed");
  assert.equal(dividendRowRecord?.commitTransactionId, record.id);

  // DIV-004: DIV-001's derived history surfaces an imported manual record
  // (non-null `importBatchId`) with source "imported" -- a distinct,
  // below-owner-manual/receipt tier -- rather than the pre-DIV-004 "manual"
  // label, so it never silently outranks an owner-typed fact.
  const derived = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "membership-a",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: record.id,
        paymentDate: record.paymentDate,
        sharesDecimal: record.sharesDecimal,
        dividendPerShareDecimal: record.dividendPerShareDecimal,
        frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
        importBatchId: record.importBatchId,
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  assert.equal(derived.length, 1);
  assert.equal(derived[0]?.source, "imported");
  assert.equal(derived[0]?.sharesDecimal, "5");
  assert.equal(derived[0]?.dividendPerShareDecimal, "0.5");

  // Reverse the whole batch.
  const committedBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    "batch-a",
  );
  assert.ok(committedBatch);
  const reversalRepo = createOwnedImportReversalRepository(client);
  let reversed = await reversalRepo.reverse("user-a", "batch-a", {
    expectedVersion: committedBatch!.version,
    idempotencyKey: "imp-006-reverse",
    confirmation: true,
    requestId: "imp-006-reverse-request",
  });
  for (
    let attempt = 0;
    attempt < 10 && (!reversed.ok || reversed.status !== "reversed");
    attempt += 1
  ) {
    assert.equal(reversed.ok, true);
    reversed = await reversalRepo.reverse("user-a", "batch-a", {
      expectedVersion: committedBatch!.version,
      idempotencyKey: "imp-006-reverse",
      confirmation: true,
      requestId: "imp-006-reverse-request",
    });
  }
  assert.equal(reversed.ok, true);
  if (reversed.ok) assert.equal(reversed.status, "reversed");

  const remainingRecords = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    remainingRecords.length,
    0,
    "expected the dividend manual record to be deleted by reversal",
  );

  // Follow-up 2: the reversal audit event must not read "0 reversed" while
  // it actually deleted an income fact.
  const reversalAudit = database
    .prepare(
      `SELECT metadata_json FROM audit_events
       WHERE action = 'import.reverse' AND target_id = 'batch-a'
       ORDER BY occurred_at DESC LIMIT 1`,
    )
    .get() as { metadata_json: string } | undefined;
  assert.ok(reversalAudit, "expected a terminal import.reverse audit event");
  const reversalMetadata = JSON.parse(reversalAudit!.metadata_json) as {
    reversedDividendRecordCount: number;
  };
  assert.equal(reversalMetadata.reversedDividendRecordCount, 1);

  const reversedTrade = database
    .prepare(
      `SELECT status FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = 'membership-a'
         AND type = 'buy' AND reverses_transaction_id IS NULL`,
    )
    .get() as { status: string } | undefined;
  assert.equal(reversedTrade?.status, "reversed");
  const compensatingEntry = database
    .prepare(
      `SELECT status FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = 'membership-a'
         AND reverses_transaction_id IS NOT NULL`,
    )
    .get() as { status: string } | undefined;
  assert.equal(
    compensatingEntry?.status,
    "posted",
    "expected an immutable compensating reversal entry, not a rewrite of the original fact",
  );

  const rowsAfterReversal = await createOwnedImportStagingRepository(
    client,
  ).listRows("user-a", "batch-a");
  const dividendRowAfterReversal = rowsAfterReversal.find(
    (row) => row.id === "row-2",
  );
  assert.equal(dividendRowAfterReversal?.commitStatus, "reversed");
});

test("duplicate dividend rows across two re-imported batches are detected and only the first is committed", async () => {
  const database = await migratedDatabase();
  const normalized = dividendRow({ id: "div-shared" });
  const sharedFingerprint = "fingerprint-shared-div";
  stageRow(database, "batch-a", "row-a1", 2, normalized, sharedFingerprint);
  stageRow(database, "batch-b", "row-b1", 2, normalized, sharedFingerprint);
  const client = createSqliteSqlClient(database);

  await commitBatch(client, "batch-a", "imp-006-dup-a");
  const manualRepo = createDividendManualRecordRepository(client);
  const afterFirst = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(afterFirst.length, 1);

  await commitBatch(client, "batch-b", "imp-006-dup-b");
  const afterSecond = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    afterSecond.length,
    1,
    "the second batch's identical dividend row must not create a duplicate record",
  );

  const secondBatchRows = await createOwnedImportStagingRepository(
    client,
  ).listRows("user-a", "batch-b");
  const skippedRow = secondBatchRows.find((row) => row.id === "row-b1");
  assert.equal(skippedRow?.commitStatus, "skipped");
  assert.equal(skippedRow?.commitTransactionId, afterFirst[0]?.id);
});

test("cross-batch duplicate dividend rows are detected using REAL parser fingerprints (follow-up 3), not synthetic test fixtures", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const staging = createOwnedImportStagingRepository(client);
  const csv = makeCsv([
    `"e2e-dup","ABC","Alpha",,"ASX","Main","AUD","5","0.50","0","2026-08-05 GMT+1000",,,"Dividend",,,,"0.21"`,
  ]);
  const parseResult = await parseStrictVersionedCsvImport(csv);
  assert.equal(parseResult.ok, true);
  if (!parseResult.ok) return;

  // Two distinct uploads (different caller-supplied file hashes, so this
  // is NOT exact-file-upload dedup) whose dividend row is byte-identical,
  // so the real parser produces the same row fingerprint for both --
  // exactly the "re-exported the same broker data into a second batch"
  // scenario the natural-key duplicate rule (CSV_IMPORT_SPEC.md sec 10) is
  // for.
  const firstUpload = await staging.startUpload("user-a", {
    parserFormat: "strict-versioned-csv",
    parserVersion: parseResult.parserVersion,
    filename: "dividends.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: "hash-e2e-dup-1",
    targetPortfolioId: "portfolio-a",
  });
  assert.equal(firstUpload.ok, true);
  if (!firstUpload.ok) return;
  const firstStaged = await staging.recordParseResult(
    "user-a",
    firstUpload.batch.id,
    { expectedVersion: firstUpload.batch.version, parseResult },
  );
  assert.equal(firstStaged.ok, true);
  if (!firstStaged.ok) return;

  const secondUpload = await staging.startUpload("user-a", {
    parserFormat: "strict-versioned-csv",
    parserVersion: parseResult.parserVersion,
    filename: "dividends-reexported.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: "hash-e2e-dup-2",
    targetPortfolioId: "portfolio-a",
  });
  assert.equal(secondUpload.ok, true);
  if (!secondUpload.ok) return;
  const secondStaged = await staging.recordParseResult(
    "user-a",
    secondUpload.batch.id,
    { expectedVersion: secondUpload.batch.version, parseResult },
  );
  assert.equal(secondStaged.ok, true);
  if (!secondStaged.ok) return;

  const firstRows = await staging.listRows("user-a", firstUpload.batch.id);
  const secondRows = await staging.listRows("user-a", secondUpload.batch.id);
  assert.equal(
    firstRows[0]?.normalizedFingerprint,
    secondRows[0]?.normalizedFingerprint,
    "the real parser must fingerprint the identical row content identically across batches",
  );

  await commitBatch(
    client,
    firstUpload.batch.id,
    "imp-006-e2e-dup-a",
    firstStaged.batch.version,
  );
  const manualRepo = createDividendManualRecordRepository(client);
  const afterFirst = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(afterFirst.length, 1);
  assert.equal(
    afterFirst[0]?.sourceReference,
    `import-fingerprint:${firstRows[0]?.normalizedFingerprint}`,
  );

  await commitBatch(
    client,
    secondUpload.batch.id,
    "imp-006-e2e-dup-b",
    secondStaged.batch.version,
  );
  const afterSecond = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    afterSecond.length,
    1,
    "a real re-exported duplicate dividend row must not create a second record",
  );

  const secondBatchCommittedRows = await staging.listRows(
    "user-a",
    secondUpload.batch.id,
  );
  assert.equal(secondBatchCommittedRows[0]?.commitStatus, "skipped");
  assert.equal(
    secondBatchCommittedRows[0]?.commitTransactionId,
    afterFirst[0]?.id,
  );
});

test("a committed dividend record surfaces end-to-end in DIV-001 derived history with source 'imported' (DIV-004) and franking honestly unknown (not zero) (follow-up 3)", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const staging = createOwnedImportStagingRepository(client);
  // 17-column file, Type=Dividend: franking is structurally absent, not
  // merely blank -- the strongest form of "unknown, never zero".
  const csv = [
    SUPPORTED_IMPORT_HEADER.join(","),
    `"e2e-hist","ABC","Alpha",,"ASX","Main","AUD","5","0.75","0","2026-08-06 GMT+1000",,,"Dividend",,,`,
  ].join("\n");
  const parseResult = await parseStrictVersionedCsvImport(csv);
  assert.equal(parseResult.ok, true);
  if (!parseResult.ok) return;

  const upload = await staging.startUpload("user-a", {
    parserFormat: "strict-versioned-csv",
    parserVersion: parseResult.parserVersion,
    filename: "dividends-17col.csv",
    byteSize: Buffer.byteLength(csv),
    fileSha256: "hash-e2e-hist",
    targetPortfolioId: "portfolio-a",
  });
  assert.equal(upload.ok, true);
  if (!upload.ok) return;
  const staged = await staging.recordParseResult("user-a", upload.batch.id, {
    expectedVersion: upload.batch.version,
    parseResult,
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) return;

  await commitBatch(
    client,
    upload.batch.id,
    "imp-006-e2e-history",
    staged.batch.version,
  );

  const manualRepo = createDividendManualRecordRepository(client);
  const records = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.sharesDecimal, "5");
  assert.equal(record.dividendPerShareDecimal, "0.75");
  assert.equal(
    record.frankingCreditPerShareDecimal,
    null,
    "17-column import has no franking column at all -- never a silent zero",
  );

  const derived = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "membership-a",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: record.id,
        paymentDate: record.paymentDate,
        sharesDecimal: record.sharesDecimal,
        dividendPerShareDecimal: record.dividendPerShareDecimal,
        frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
        importBatchId: record.importBatchId,
      },
    ],
    transactions: [],
    // No security-level "franking if not known" default configured either,
    // so the franking chain genuinely bottoms out at unknown.
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  assert.equal(derived.length, 1);
  // DIV-004: an imported row (non-null `importBatchId`) derives with source
  // "imported", not "manual".
  assert.equal(derived[0]?.source, "imported");
  assert.equal(derived[0]?.sharesDecimal, "5");
  assert.equal(derived[0]?.dividendPerShareDecimal, "0.75");
  assert.equal(derived[0]?.franking.source, "unknown");
  assert.equal(derived[0]?.franking.perShareDecimal, null);
});

test("a dividend-only reversal (no trade rows at all) still audits its deleted income facts, never '0 reversed' (follow-up 2)", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", 2, dividendRow());
  const client = createSqliteSqlClient(database);

  await commitBatch(client, "batch-a", "imp-006-div-only-commit");
  const manualRepo = createDividendManualRecordRepository(client);
  assert.equal((await manualRepo.list("user-a", "portfolio-a")).length, 1);

  const committedBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    "batch-a",
  );
  assert.ok(committedBatch);
  const reversalRepo = createOwnedImportReversalRepository(client);
  let reversed = await reversalRepo.reverse("user-a", "batch-a", {
    expectedVersion: committedBatch!.version,
    idempotencyKey: "imp-006-div-only-reverse",
    confirmation: true,
    requestId: "imp-006-div-only-reverse-request",
  });
  for (
    let attempt = 0;
    attempt < 10 && (!reversed.ok || reversed.status !== "reversed");
    attempt += 1
  ) {
    assert.equal(reversed.ok, true);
    reversed = await reversalRepo.reverse("user-a", "batch-a", {
      expectedVersion: committedBatch!.version,
      idempotencyKey: "imp-006-div-only-reverse",
      confirmation: true,
      requestId: "imp-006-div-only-reverse-request",
    });
  }
  assert.equal(reversed.ok, true);
  if (reversed.ok) {
    assert.equal(reversed.status, "reversed");
    // No ledger transactions existed in this batch at all.
    assert.equal(reversed.reversedTransactions, 0);
  }
  assert.equal((await manualRepo.list("user-a", "portfolio-a")).length, 0);

  const reversalAudit = database
    .prepare(
      `SELECT metadata_json FROM audit_events
       WHERE action = 'import.reverse' AND target_id = 'batch-a'
       ORDER BY occurred_at DESC LIMIT 1`,
    )
    .get() as { metadata_json: string } | undefined;
  assert.ok(reversalAudit);
  const metadata = JSON.parse(reversalAudit!.metadata_json) as {
    reversedTransactionCount: number;
    reversedDividendRecordCount: number;
  };
  assert.equal(metadata.reversedTransactionCount, 0);
  assert.equal(
    metadata.reversedDividendRecordCount,
    1,
    "a dividend-only reversal must not read as '0 reversed' while it deletes an income fact",
  );
});

test("cross-user access is denied at the repository boundary for a dividend-containing batch (no route changes needed)", async () => {
  const database = await migratedDatabase();
  stageRow(database, "batch-a", "row-1", 2, dividendRow());
  const client = createSqliteSqlClient(database);

  const otherUserReady = await markImportReadyWithContext(
    { client, userId: "user-b" },
    "batch-a",
    { expectedVersion: 1, expectedPreviewVersion: "anything" },
  );
  assert.equal(otherUserReady.ok, false);
  if (!otherUserReady.ok) assert.equal(otherUserReady.status, 404);

  await commitBatch(client, "batch-a", "imp-006-cross-user-commit");
  const committedBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    "batch-a",
  );
  assert.ok(committedBatch);

  const otherUserReversal = await createOwnedImportReversalRepository(
    client,
  ).reverse("user-b", "batch-a", {
    expectedVersion: committedBatch!.version,
    idempotencyKey: "imp-006-cross-user-reverse",
    confirmation: true,
    requestId: "imp-006-cross-user-reverse-request",
  });
  assert.equal(otherUserReversal.ok, false);
  if (!otherUserReversal.ok)
    assert.equal(otherUserReversal.reason, "not_found");

  const manualRepo = createDividendManualRecordRepository(client);
  const stillPresent = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    stillPresent.length,
    1,
    "another owner's failed reversal attempt must not affect the real owner's record",
  );
});

// ---------------------------------------------------------------------------
// BUG-016: chunked reversal must not touch dividend facts before the trade
// side is complete
// ---------------------------------------------------------------------------

test("BUG-016: a chunked reversal (chunkSize 1) leaves dividend records and the DIV-016C restore untouched until the FINAL invocation, then deletes/restores them, queues a rebuild, and a repeated final call is a no-op", async () => {
  const database = await migratedDatabase();

  // A pre-existing owner-typed manual record that the imported "div-1" row
  // below will safely reconcile against (same security, payment date and
  // cash total: 5 x 0.5 = 2.5) -- the DIV-016C candidate shape.
  seedManualRecord(database, {
    id: "manual-pre",
    portfolioSecurityId: "membership-a",
    paymentDate: "2026-08-10",
    sharesDecimal: "5",
    dividendPerShareDecimal: "0.5",
  });

  stageRow(
    database,
    "batch-a",
    "trade-1",
    2,
    buyRow({
      id: "trade-1",
      transactionDate: "2026-08-01 GMT+1000",
      tradeAtUtc: "2026-08-01T00:00:00.000Z",
      localTradeDate: "2026-08-01",
    }),
  );
  stageRow(
    database,
    "batch-a",
    "trade-2",
    3,
    buyRow({
      id: "trade-2",
      transactionDate: "2026-08-02 GMT+1000",
      tradeAtUtc: "2026-08-02T00:00:00.000Z",
      localTradeDate: "2026-08-02",
    }),
  );
  stageRow(
    database,
    "batch-a",
    "trade-3",
    4,
    buyRow({
      id: "trade-3",
      transactionDate: "2026-08-03 GMT+1000",
      tradeAtUtc: "2026-08-03T00:00:00.000Z",
      localTradeDate: "2026-08-03",
    }),
  );
  stageRow(
    database,
    "batch-a",
    "row-div-1",
    5,
    dividendRow({
      id: "div-1",
      paymentDate: "2026-08-10 GMT+1000",
      localTradeDate: "2026-08-10",
    }),
  );
  stageRow(
    database,
    "batch-a",
    "row-div-2",
    6,
    dividendRow({
      id: "div-2",
      paymentDate: "2026-08-11 GMT+1000",
      localTradeDate: "2026-08-11",
      costPerShare: "0.3",
    }),
  );
  const client = createSqliteSqlClient(database);
  await commitBatch(client, "batch-a", "bug-016-commit");

  const manualRepo = createDividendManualRecordRepository(client);
  const supersededPre = await manualRepo.get(
    "user-a",
    "portfolio-a",
    "manual-pre",
  );
  assert.ok(
    supersededPre?.supersededByRecordId,
    "expected the imported div-1 row to reconcile against the pre-existing manual record",
  );
  const preVersionAfterSupersede = supersededPre!.version;

  function batchDividendRecordCount(): number {
    return (
      database
        .prepare(
          "SELECT count(*) AS count FROM dividend_manual_records WHERE import_batch_id = 'batch-a'",
        )
        .get() as { count: number }
    ).count;
  }
  function dividendImportRowStatuses(): string[] {
    return (
      database
        .prepare(
          "SELECT commit_status FROM import_rows WHERE id IN ('row-div-1', 'row-div-2') ORDER BY id",
        )
        .all() as { commit_status: string }[]
    ).map((row) => row.commit_status);
  }
  function rebuildRunCount(): number {
    return (
      database
        .prepare(
          "SELECT count(*) AS count FROM calculation_runs WHERE reason = 'import_reverse' AND user_id = 'user-a' AND portfolio_id = 'portfolio-a'",
        )
        .get() as { count: number }
    ).count;
  }
  function reverseAuditCount(): number {
    return (
      database
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'import.reverse' AND target_id = 'batch-a'",
        )
        .get() as { count: number }
    ).count;
  }

  assert.equal(batchDividendRecordCount(), 2);

  const committedBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    "batch-a",
  );
  assert.ok(committedBatch);
  const reversalRepo = createOwnedImportReversalRepository(client, {
    chunkSize: 1,
  });
  const reversalInput = {
    expectedVersion: committedBatch!.version,
    idempotencyKey: "bug-016-reverse",
    confirmation: true,
    requestId: "bug-016-reverse-request",
  };

  // Invocation 1 of 3: reverses trade-1 only. Two trades remain, so this is
  // NOT the finalizing invocation -- dividend facts must be untouched.
  const first = await reversalRepo.reverse("user-a", "batch-a", reversalInput);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.status, "reversing");
    assert.equal(first.reversedTransactions, 1);
    assert.equal(first.remainingTransactions, 2);
  }
  assert.equal(
    batchDividendRecordCount(),
    2,
    "the first (non-final) chunk must not delete any dividend record",
  );
  assert.deepEqual(dividendImportRowStatuses(), ["committed", "committed"]);
  assert.equal(
    (await manualRepo.get("user-a", "portfolio-a", "manual-pre"))
      ?.supersededByRecordId,
    supersededPre!.supersededByRecordId,
    "the DIV-016C restore must not fire on a non-final chunk",
  );
  assert.equal(rebuildRunCount(), 0);

  // Invocation 2 of 3: reverses trade-2. One trade remains -- still not
  // finalizing.
  const second = await reversalRepo.reverse("user-a", "batch-a", reversalInput);
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.equal(second.status, "reversing");
    assert.equal(second.remainingTransactions, 1);
  }
  assert.equal(batchDividendRecordCount(), 2);
  assert.deepEqual(dividendImportRowStatuses(), ["committed", "committed"]);
  assert.equal(rebuildRunCount(), 0);

  // Invocation 3 of 3: reverses trade-3, the last trade -- THIS is the
  // finalizing invocation. Now the dividend flip/restore/delete and the
  // PRF-007-mirrored rebuild queueing must all fire, atomically.
  const third = await reversalRepo.reverse("user-a", "batch-a", reversalInput);
  assert.equal(third.ok, true);
  if (third.ok) {
    assert.equal(third.status, "reversed");
    assert.equal(third.remainingTransactions, 0);
    assert.ok(
      third.rebuildJobIds.some((id) =>
        id.startsWith("import-reversal-rebuild:batch-a:portfolio-a"),
      ),
      "expected the dividend-driven rebuild id in the finalizing call's rebuildJobIds",
    );
  }
  assert.equal(
    batchDividendRecordCount(),
    0,
    "the finalizing invocation must delete every one of this batch's dividend records",
  );
  assert.deepEqual(dividendImportRowStatuses(), ["reversed", "reversed"]);
  const restoredPre = await manualRepo.get(
    "user-a",
    "portfolio-a",
    "manual-pre",
  );
  assert.equal(
    restoredPre?.supersededByRecordId,
    null,
    "the DIV-016C restore must fire on the finalizing invocation",
  );
  const restoredVersion = restoredPre!.version;
  assert.ok(
    restoredVersion > preVersionAfterSupersede,
    "the restore must have actually written the row (version advanced)",
  );
  assert.equal(
    rebuildRunCount(),
    1,
    "exactly one import_reverse rebuild run queued for the affected portfolio",
  );
  const rebuildRun = database
    .prepare(
      "SELECT range_from, range_to, invalidation_source FROM calculation_runs WHERE reason = 'import_reverse' AND user_id = 'user-a' AND portfolio_id = 'portfolio-a'",
    )
    .get() as {
    range_from: string;
    range_to: string;
    invalidation_source: string;
  };
  assert.equal(rebuildRun.range_from, "2026-08-10");
  assert.equal(rebuildRun.range_to, "2026-08-11");
  assert.equal(rebuildRun.invalidation_source, "batch-a");
  assert.equal(reverseAuditCount(), 1);
  const finalAudit = database
    .prepare(
      `SELECT metadata_json FROM audit_events
       WHERE action = 'import.reverse' AND target_id = 'batch-a'
       ORDER BY occurred_at DESC LIMIT 1`,
    )
    .get() as { metadata_json: string };
  const finalMetadata = JSON.parse(finalAudit.metadata_json) as {
    reversedDividendRecordCount: number;
    restoredManualRecordCount: number;
    rebuildJobIds: string[];
  };
  assert.equal(finalMetadata.reversedDividendRecordCount, 2);
  assert.equal(finalMetadata.restoredManualRecordCount, 1);
  assert.ok(
    finalMetadata.rebuildJobIds.some((id) =>
      id.startsWith("import-reversal-rebuild:batch-a:portfolio-a"),
    ),
  );

  // Invocation 4: the batch is already `reversed` -- a repeated FINAL call
  // (same idempotency key) must be a no-op, not a second delete/restore/
  // queue.
  const repeated = await reversalRepo.reverse(
    "user-a",
    "batch-a",
    reversalInput,
  );
  assert.equal(repeated.ok, true);
  if (repeated.ok) {
    assert.equal(repeated.resumed, true);
    assert.equal(repeated.idempotent, true);
  }
  assert.equal(batchDividendRecordCount(), 0);
  assert.equal(rebuildRunCount(), 1, "no duplicate rebuild run queued");
  assert.equal(reverseAuditCount(), 1, "no duplicate terminal audit event");
  const restoredAgain = await manualRepo.get(
    "user-a",
    "portfolio-a",
    "manual-pre",
  );
  assert.equal(
    restoredAgain?.version,
    restoredVersion,
    "the DIV-016C restore must fire exactly once, not again on a repeated final call",
  );
});

test("BUG-016: a mid-reversal dependent_facts failure (a sell posted against a lot between chunk invocations) leaves the batch's dividend records intact", async () => {
  const database = await migratedDatabase();
  stageRow(
    database,
    "batch-a",
    "trade-1",
    2,
    buyRow({
      id: "trade-1",
      transactionDate: "2026-08-01 GMT+1000",
      tradeAtUtc: "2026-08-01T00:00:00.000Z",
      localTradeDate: "2026-08-01",
    }),
  );
  stageRow(
    database,
    "batch-a",
    "trade-2",
    3,
    buyRow({
      id: "trade-2",
      transactionDate: "2026-08-02 GMT+1000",
      tradeAtUtc: "2026-08-02T00:00:00.000Z",
      localTradeDate: "2026-08-02",
    }),
  );
  stageRow(
    database,
    "batch-a",
    "row-div-1",
    4,
    dividendRow({
      id: "div-1",
      paymentDate: "2026-08-10 GMT+1000",
      localTradeDate: "2026-08-10",
    }),
  );
  const client = createSqliteSqlClient(database);
  await commitBatch(client, "batch-a", "bug-016-df-commit");

  function batchDividendRecordCount(): number {
    return (
      database
        .prepare(
          "SELECT count(*) AS count FROM dividend_manual_records WHERE import_batch_id = 'batch-a'",
        )
        .get() as { count: number }
    ).count;
  }

  assert.equal(batchDividendRecordCount(), 1);

  const committedBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    "batch-a",
  );
  assert.ok(committedBatch);
  const reversalRepo = createOwnedImportReversalRepository(client, {
    chunkSize: 1,
  });
  const reversalInput = {
    expectedVersion: committedBatch!.version,
    idempotencyKey: "bug-016-df-reverse",
    confirmation: true,
    requestId: "bug-016-df-reverse-request",
  };

  const first = await reversalRepo.reverse("user-a", "batch-a", reversalInput);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.status, "reversing");
    assert.equal(first.remainingTransactions, 1);
  }
  assert.equal(batchDividendRecordCount(), 1);

  // A sell against the remaining lot, posted OUTSIDE this batch, dated after
  // the still-unreversed trade-2 -- makes the rest of this batch's reversal
  // permanently blocked (`dependent_facts`).
  const sale = await createOwnedLedgerRepository(client).post("user-a", {
    portfolioId: "portfolio-a",
    type: "sell",
    portfolioSecurityId: "membership-a",
    quantityDecimal: "2",
    unitPriceDecimal: "12",
    grossAmountDecimal: "24",
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

  const second = await reversalRepo.reverse("user-a", "batch-a", reversalInput);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, "dependent_facts");
    assert.ok(second.impacts && second.impacts.length > 0);
  }
  assert.equal(
    batchDividendRecordCount(),
    1,
    "a mid-reversal dependent_facts failure must leave this batch's dividend records intact",
  );
  const batchAfter = database
    .prepare("SELECT status FROM import_batches WHERE id = 'batch-a'")
    .get() as { status: string };
  assert.equal(batchAfter.status, "reversing");
});
