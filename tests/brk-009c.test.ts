import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  deriveSharesightSecuritiesSummary,
  type SharesightSecuritySummaryCandidate,
  type SharesightSecuritySummaryRow,
} from "../domain/imports/security-summary.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import type { ImportReviewPreview } from "../app/import-preview.ts";
import {
  updateImportSecurityMetadataWithContext,
  type ImportSecurityMetadataActionOptions,
} from "../app/import-security-metadata-service.ts";
import { createImportSecurityMetadataPost } from "../app/import-security-metadata-route.ts";
import {
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSqliteSqlClient,
  listAttestedSecurityIds,
  listAutoCreatedSecurityIds,
  listNameEditableSecurityIds,
  type SqlClient,
} from "../db/repositories/index.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION } from "../domain/imports/index.ts";
import {
  SHARESIGHT_SYNC_PARSER_FORMAT,
  SHARESIGHT_SYNC_PARSER_VERSION,
} from "../domain/sharesight-sync/index.ts";

// BRK-009C: the pre-acceptance "Review securities" screen for
// `sharesight_sync` batches inside the existing import review component --
// (1) a pure distinct-security derivation (`domain/imports/security-summary.ts`),
// (2) a CSRF-first owner-scoped metadata edit route that corrects an
// auto-created security's missing name WITHOUT ever changing `security_id`,
// touching exchange/currency (both identity-adjacent and structurally never
// missing on a `sharesight_sync` row), or renaming a shared/provider-verified
// security, and (3) two "Accept Import" buttons sharing one confirm dialog
// on the review component. See TASKS.md's BRK-009C entry for the full
// ruling set, including the review round (findings B1/B2/B3/F1/F2/F3/F4)
// this file's tests reflect.

// ---------------------------------------------------------------------------
// Part 1: deriveSharesightSecuritiesSummary -- pure, no DB.
// ---------------------------------------------------------------------------

function row(
  overrides: Partial<{
    id: string;
    rowClass: SharesightSecuritySummaryRow["rowClass"];
    symbol: string | null;
    exchange: string | null;
    currency: string | null;
    instrumentName: string | null;
    excludedByOwnerAt: string | null;
  }> = {},
): SharesightSecuritySummaryRow {
  return {
    id: overrides.id ?? "row-1",
    rowClass: overrides.rowClass ?? "transaction",
    normalizedFields:
      overrides.symbol === null
        ? null
        : {
            symbol: overrides.symbol ?? "IXJ",
            exchange:
              overrides.exchange === undefined ? "ASX" : overrides.exchange,
            currency: overrides.currency ?? "AUD",
            instrumentName:
              overrides.instrumentName === undefined
                ? null
                : overrides.instrumentName,
          },
    excludedByOwnerAt: overrides.excludedByOwnerAt ?? null,
  };
}

function candidate(
  overrides: Partial<SharesightSecuritySummaryCandidate> = {},
): SharesightSecuritySummaryCandidate {
  return {
    portfolioId: "portfolio-a",
    sourceSymbol: "IXJ",
    sourceExchangeAlias: "ASX",
    sourceCurrencyCode: "AUD",
    securityId: null,
    ...overrides,
  };
}

test("BRK-009C: rows sharing a symbol/exchange/currency group into one distinct security with an accurate row count", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [
      row({ id: "r1" }),
      row({ id: "r2" }),
      row({ id: "r3", symbol: "OTHER" }),
    ],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [],
    conflictedRowIds: new Set(),
    securityNames: new Map(),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(summary.length, 2);
  const ixj = summary.find((entry) => entry.sourceSymbol === "IXJ");
  assert.ok(ixj);
  assert.equal(ixj!.rowCount, 2, "two rows referencing IXJ");
  const other = summary.find((entry) => entry.sourceSymbol === "OTHER");
  assert.equal(other!.rowCount, 1);
});

test("BRK-009C: a missing exchange groups separately from the same symbol with an exchange, and renders as null (Unknown), never fabricated", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [
      row({ id: "r1", exchange: "ASX" }),
      row({ id: "r2", exchange: null }),
    ],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [],
    conflictedRowIds: new Set(),
    securityNames: new Map(),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(summary.length, 2);
  const withExchange = summary.find(
    (entry) => entry.sourceExchangeAlias === "ASX",
  );
  const withoutExchange = summary.find(
    (entry) => entry.sourceExchangeAlias === null,
  );
  assert.ok(withExchange);
  assert.ok(withoutExchange);
});

test("BRK-009C: an owner-excluded row never inflates a row count, and a security with every row excluded does not appear at all", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [
      row({ id: "r1" }),
      row({ id: "r2", excludedByOwnerAt: "2026-08-18T00:00:00Z" }),
      row({
        id: "r3",
        symbol: "GONE",
        excludedByOwnerAt: "2026-08-18T00:00:00Z",
      }),
    ],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [],
    conflictedRowIds: new Set(),
    securityNames: new Map(),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.sourceSymbol, "IXJ");
  assert.equal(summary[0]!.rowCount, 1);
});

test("BRK-009C: non-transaction rows (blank/definition/unsupported) never contribute to the summary", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [row({ id: "r1", rowClass: "blank" })],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [],
    conflictedRowIds: new Set(),
    securityNames: new Map(),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.deepEqual(summary, []);
});

test("BRK-009C: a resolved candidate reports state 'resolved' (never name-editable); an auto-created one reports 'created' with nameEditable reflecting the eligibility set", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [
      row({ id: "r1", symbol: "AAA" }),
      row({ id: "r2", symbol: "BBB" }),
      row({ id: "r3", symbol: "CCC" }),
    ],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [
      candidate({ sourceSymbol: "AAA", securityId: "sec-resolved" }),
      candidate({ sourceSymbol: "BBB", securityId: "sec-created-eligible" }),
      candidate({ sourceSymbol: "CCC", securityId: "sec-created-shared" }),
    ],
    conflictedRowIds: new Set(),
    securityNames: new Map([
      ["sec-resolved", "Resolved Co"],
      ["sec-created-eligible", "Created Co"],
      ["sec-created-shared", "Shared Co"],
    ]),
    autoCreatedSecurityIds: new Set([
      "sec-created-eligible",
      "sec-created-shared",
    ]),
    // "sec-created-shared" is auto-created but NOT in the eligible set --
    // e.g. another owner also links to it, or it gained a verified provider
    // mapping (see `listNameEditableSecurityIds`).
    nameEditableSecurityIds: new Set(["sec-created-eligible"]),
  });
  const resolved = summary.find((entry) => entry.sourceSymbol === "AAA");
  const created = summary.find((entry) => entry.sourceSymbol === "BBB");
  const sharedCreated = summary.find((entry) => entry.sourceSymbol === "CCC");
  assert.equal(resolved!.state, "resolved");
  assert.equal(resolved!.name, "Resolved Co");
  assert.equal(resolved!.securityId, "sec-resolved");
  assert.equal(resolved!.nameEditable, false);
  assert.equal(created!.state, "created");
  assert.equal(created!.name, "Created Co");
  assert.equal(created!.nameEditable, true);
  assert.equal(sharedCreated!.state, "created");
  assert.equal(
    sharedCreated!.nameEditable,
    false,
    "auto-created but shared/provider-verified must not be editable",
  );
});

test("BRK-009C: an unresolved candidate with no persisted conflict issue reports state 'unresolved', never a fabricated 'conflict'", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [row({ id: "r1" })],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [candidate({ securityId: null })],
    conflictedRowIds: new Set(),
    securityNames: new Map(),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(summary[0]!.state, "unresolved");
  assert.equal(summary[0]!.securityId, null);
  assert.equal(summary[0]!.nameEditable, false);
});

test("BRK-009C: a row blocked by an unresolved SECURITY_RESOLUTION_CONFLICT issue reports state 'conflict'", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [row({ id: "r1" })],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [],
    conflictedRowIds: new Set(["r1"]),
    securityNames: new Map(),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(summary[0]!.state, "conflict");
});

test("BRK-009C review round F1: a conflict on a row whose candidate STILL carries a stale linked security_id reports state 'conflict' (never 'resolved'/'created'), and securityId is null -- never the disputed id", () => {
  // Mirrors `security-resolution.ts`'s own B2 fix: a pre-existing link is
  // re-validated for currency agreement and reported as a conflict WITHOUT
  // ever clearing `portfolio_securities.security_id` -- so the candidate
  // here still carries a (disputed) linked id even though its row is
  // ALSO flagged conflicted. The conflict check must win.
  const summary = deriveSharesightSecuritiesSummary({
    rows: [row({ id: "r1" })],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [candidate({ securityId: "sec-stale" })],
    conflictedRowIds: new Set(["r1"]),
    securityNames: new Map([["sec-stale", "Disputed Co"]]),
    autoCreatedSecurityIds: new Set(["sec-stale"]),
    nameEditableSecurityIds: new Set(["sec-stale"]),
  });
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.state, "conflict");
  assert.equal(
    summary[0]!.securityId,
    null,
    "never expose the disputed security_id once conflicted",
  );
  assert.equal(summary[0]!.nameEditable, false);
});

test("BRK-009C: name falls back to Sharesight's instrumentName when unresolved/conflicted, and to null when neither a security nor an instrument name exists", () => {
  const withName = deriveSharesightSecuritiesSummary({
    rows: [row({ id: "r1", instrumentName: "iShares Global Healthcare" })],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [],
    conflictedRowIds: new Set(),
    securityNames: new Map(),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(withName[0]!.name, "iShares Global Healthcare");

  const withoutName = deriveSharesightSecuritiesSummary({
    rows: [row({ id: "r1" })],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [],
    conflictedRowIds: new Set(),
    securityNames: new Map(),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(withoutName[0]!.name, null, "never a fabricated placeholder");
});

test("BRK-009C: grouping is case/whitespace-insensitive, mirroring reconciliation.ts's own candidate-match rule", () => {
  const summary = deriveSharesightSecuritiesSummary({
    rows: [row({ id: "r1", symbol: "ixj", exchange: " asx " })],
    targetPortfolioId: "portfolio-a",
    securityCandidates: [
      candidate({
        sourceSymbol: "IXJ",
        sourceExchangeAlias: "ASX",
        securityId: "sec-1",
      }),
    ],
    conflictedRowIds: new Set(),
    securityNames: new Map([["sec-1", "iShares"]]),
    autoCreatedSecurityIds: new Set(),
    nameEditableSecurityIds: new Set(),
  });
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.state, "resolved");
});

// ---------------------------------------------------------------------------
// Part 2: DB-backed fixtures for buildImportReviewPreview / the metadata
// mutation service.
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
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-18', '2026-08-18', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-18', '2026-08-18', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-18', '2026-08-18', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-18', '2026-08-18', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-18', '2026-08-18', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-18', '2026-08-18', 1);
  `);
  return database;
}

function insertBatch(
  database: DatabaseSync,
  options: {
    id: string;
    userId: string;
    portfolioId: string;
    parserFormat?: string;
    status?: string;
    version?: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO import_batches (
         id, user_id, target_portfolio_id, parser_format, parser_version, filename,
         byte_size, file_sha256, status, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, ?, 'sync.json', 10, ?, ?, '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z', ?)`,
    )
    .run(
      options.id,
      options.userId,
      options.portfolioId,
      options.parserFormat ?? SHARESIGHT_SYNC_PARSER_FORMAT,
      options.parserFormat === "strict-versioned-csv"
        ? SUPPORTED_IMPORT_PARSER_VERSION
        : SHARESIGHT_SYNC_PARSER_VERSION,
      `sha-${options.id}`,
      options.status ?? "parsed",
      options.version ?? 1,
    );
}

function insertRow(
  database: DatabaseSync,
  options: {
    id: string;
    batchId: string;
    userId: string;
    physicalRowNumber: number;
    symbol: string;
    exchange?: string | null;
    currency?: string;
    instrumentName?: string | null;
    excludedByOwnerAt?: string | null;
  },
): void {
  const normalized = {
    id: `sharesight-${options.id}`,
    symbol: options.symbol,
    name: null,
    displaySymbol: null,
    exchange: options.exchange === undefined ? "ASX" : options.exchange,
    portfolio: "Main",
    currency: options.currency ?? "AUD",
    sharesOwned: "5",
    costPerShare: "10",
    commission: "0",
    transactionDate: "2026-08-01",
    transactionTime: null,
    purchaseExchangeRate: null,
    type: "buy",
    accounting: null,
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: "2026-08-01T00:00:00.000Z",
    localTradeDate: "2026-08-01",
    cashEvent: null,
    frankingPerShare: null,
    sharesightInstrumentId: null,
    instrumentName:
      options.instrumentName === undefined ? null : options.instrumentName,
    isin: null,
  };
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, commit_status,
         excluded_by_owner_at, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, 'transaction', '[]', ?, ?, 'valid', NULL, 'staged',
         ?, '2026-08-18', '2026-08-18', 1)`,
    )
    .run(
      options.id,
      options.userId,
      options.batchId,
      options.physicalRowNumber,
      JSON.stringify(normalized),
      `fp-${options.id}`,
      options.excludedByOwnerAt ?? null,
    );
}

function insertSecurity(
  database: DatabaseSync,
  options: {
    id: string;
    symbol: string;
    currency?: string;
    canonicalName?: string;
    identifierSource: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO securities (
         id, asset_type, exchange_id, primary_currency_code, canonical_name,
         isin, status, first_trade_date, last_trade_date, created_at, updated_at
       ) VALUES (?, 'equity', NULL, ?, ?, NULL, 'active', NULL, NULL, '2026-08-18', '2026-08-18')`,
    )
    .run(
      options.id,
      options.currency ?? "AUD",
      options.canonicalName ?? options.symbol,
    );
  database
    .prepare(
      `INSERT INTO security_identifiers (
         id, security_id, scheme, value, exchange_id, valid_from, valid_to, source
       ) VALUES (?, ?, 'ticker', ?, NULL, '2026-08-18', NULL, ?)`,
    )
    .run(
      `ident-${options.id}`,
      options.id,
      options.symbol,
      options.identifierSource,
    );
}

function insertCandidate(
  database: DatabaseSync,
  options: {
    id: string;
    userId: string;
    portfolioId: string;
    symbol: string;
    exchange?: string | null;
    currency?: string;
    securityId?: string | null;
  },
): void {
  const securityId = options.securityId ?? null;
  database
    .prepare(
      `INSERT INTO portfolio_securities (
         id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias,
         source_currency_code, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-08-18', '2026-08-18')`,
    )
    .run(
      options.id,
      options.userId,
      options.portfolioId,
      securityId,
      options.symbol,
      options.exchange === undefined ? "ASX" : options.exchange,
      options.currency ?? "AUD",
      securityId === null ? "unresolved" : "held",
    );
}

function insertConflictIssue(
  database: DatabaseSync,
  options: {
    id: string;
    userId: string;
    batchId: string;
    rowId: string;
    physicalRowNumber: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO import_issues (
         id, user_id, batch_id, row_id, physical_row_number, field, severity,
         code, message, suggested_resolution_type, resolved_value,
         resolved_by_user_id, resolved_at, created_at, updated_at, version
       ) VALUES (?, ?, ?, ?, ?, NULL, 'error', 'SECURITY_RESOLUTION_CONFLICT',
         'conflict', NULL, NULL, NULL, NULL, '2026-08-18', '2026-08-18', 1)`,
    )
    .run(
      options.id,
      options.userId,
      options.batchId,
      options.rowId,
      options.physicalRowNumber,
    );
}

// `market_data_providers` id 'yahoo-compatible' is migration-seeded
// reference data (MKT-007, `drizzle/0037_steady_signal.sql`) -- already
// present after the full migration chain above.
function insertVerifiedProviderMapping(
  database: DatabaseSync,
  options: { id: string; securityId: string; providerSymbol?: string },
): void {
  database
    .prepare(
      `INSERT INTO security_provider_mappings (
         id, security_id, provider_id, provider_exchange, provider_symbol,
         valid_from, valid_to, status, verified_by_user_id, verified_at
       ) VALUES (?, ?, 'yahoo-compatible', 'ASX', ?, '2026-08-18', NULL, 'verified', NULL, '2026-08-18')`,
    )
    .run(options.id, options.securityId, options.providerSymbol ?? "IXJ");
}

// Mirrors `loadReview`'s widened query (app/import-actions.ts) using only
// exported repository functions, so tests can inspect the full built
// review, including `securities`.
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
        `SELECT ps.id, ps.portfolio_id, ps.source_symbol, ps.source_exchange_alias,
        ps.source_currency_code, ps.security_id, s.canonical_name
       FROM portfolio_securities ps
       LEFT JOIN securities s ON s.id = ps.security_id
       WHERE ps.user_id = ?
       ORDER BY ps.source_symbol ASC, ps.id ASC`,
        [userId],
      ),
    ],
  );
  const securityCandidates = candidateRows.map((r) => ({
    id: String(r.id),
    portfolioId: String(r.portfolio_id),
    sourceSymbol: String(r.source_symbol),
    sourceExchangeAlias:
      r.source_exchange_alias === null ? null : String(r.source_exchange_alias),
    sourceCurrencyCode: String(r.source_currency_code),
    securityId: r.security_id === null ? null : String(r.security_id),
  }));
  const securityNames = new Map<string, string>();
  for (const r of candidateRows) {
    if (r.security_id !== null && r.canonical_name !== null) {
      securityNames.set(String(r.security_id), String(r.canonical_name));
    }
  }
  const linkedSecurityIds = securityCandidates
    .map((c) => c.securityId)
    .filter((id): id is string => id !== null);
  const [attestedSecurityIds, autoCreatedSecurityIds, nameEditableSecurityIds] =
    await Promise.all([
      listAttestedSecurityIds(client, linkedSecurityIds),
      listAutoCreatedSecurityIds(client, linkedSecurityIds),
      listNameEditableSecurityIds(client, userId, linkedSecurityIds),
    ]);
  return buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfolios.map((p) => ({
      id: p.id,
      name: p.name,
      homeCurrencyCode: p.homeCurrencyCode,
      historyCompleteFrom: p.historyCompleteFrom,
    })),
    securityCandidates,
    attestedSecurityIds,
    securityNames,
    autoCreatedSecurityIds,
    nameEditableSecurityIds,
  });
}

// ---------------------------------------------------------------------------
// Part 3: buildImportReviewPreview integration -- CSV batches unchanged.
// ---------------------------------------------------------------------------

test("BRK-009C: buildImportReviewPreview derives the full securities summary (incl. nameEditable) for a sharesight_sync batch via the real DB-backed path", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  insertBatch(database, {
    id: "batch-a",
    userId: "user-a",
    portfolioId: "portfolio-a",
  });
  insertRow(database, {
    id: "row-1",
    batchId: "batch-a",
    userId: "user-a",
    physicalRowNumber: 2,
    symbol: "IXJ",
    instrumentName: "iShares Global Healthcare",
  });
  insertSecurity(database, {
    id: "sec-1",
    symbol: "IXJ",
    canonicalName: "iShares Global Healthcare",
    identifierSource: "sharesight",
  });
  insertCandidate(database, {
    id: "cand-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "IXJ",
    securityId: "sec-1",
  });

  const review = await currentReview(client, "user-a", "batch-a");
  assert.equal(review.securities.length, 1);
  assert.equal(review.securities[0]!.sourceSymbol, "IXJ");
  assert.equal(review.securities[0]!.state, "created");
  assert.equal(review.securities[0]!.name, "iShares Global Healthcare");
  assert.equal(review.securities[0]!.rowCount, 1);
  assert.equal(
    review.securities[0]!.nameEditable,
    true,
    "sole-owned, auto-created, no provider mapping -- eligible",
  );
});

test("BRK-009C: a strict-versioned-csv batch renders no securities section (unchanged UI)", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  insertBatch(database, {
    id: "batch-csv",
    userId: "user-a",
    portfolioId: "portfolio-a",
    parserFormat: "strict-versioned-csv",
    status: "needs_mapping",
  });
  insertRow(database, {
    id: "row-1",
    batchId: "batch-csv",
    userId: "user-a",
    physicalRowNumber: 2,
    symbol: "IXJ",
  });

  const review = await currentReview(client, "user-a", "batch-csv");
  assert.deepEqual(
    review.securities,
    [],
    "a CSV batch must never render a securities summary",
  );
});

test("BRK-009C: buildImportReviewPreview reports state 'conflict' for a row blocked by a persisted SECURITY_RESOLUTION_CONFLICT issue, via the real DB-backed path", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  insertBatch(database, {
    id: "batch-conflict",
    userId: "user-a",
    portfolioId: "portfolio-a",
  });
  insertRow(database, {
    id: "row-1",
    batchId: "batch-conflict",
    userId: "user-a",
    physicalRowNumber: 2,
    symbol: "IXJ",
  });
  insertConflictIssue(database, {
    id: "issue-1",
    userId: "user-a",
    batchId: "batch-conflict",
    rowId: "row-1",
    physicalRowNumber: 2,
  });

  const review = await currentReview(client, "user-a", "batch-conflict");
  assert.equal(review.securities.length, 1);
  assert.equal(review.securities[0]!.state, "conflict");
  assert.equal(review.securities[0]!.securityId, null);
  assert.equal(review.securities[0]!.nameEditable, false);
});

// ---------------------------------------------------------------------------
// Part 4: listNameEditableSecurityIds -- the three predicates in isolation.
// ---------------------------------------------------------------------------

test("BRK-009C review round B1: listNameEditableSecurityIds excludes a security another user is also linked to, includes a sole-owned one", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  insertSecurity(database, {
    id: "sec-sole",
    symbol: "AAA",
    identifierSource: "sharesight",
  });
  insertSecurity(database, {
    id: "sec-shared",
    symbol: "BBB",
    identifierSource: "sharesight",
  });
  insertCandidate(database, {
    id: "cand-a1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "AAA",
    securityId: "sec-sole",
  });
  insertCandidate(database, {
    id: "cand-a2",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "BBB",
    securityId: "sec-shared",
  });
  insertCandidate(database, {
    id: "cand-b1",
    userId: "user-b",
    portfolioId: "portfolio-b",
    symbol: "BBB",
    securityId: "sec-shared",
  });

  const eligible = await listNameEditableSecurityIds(client, "user-a", [
    "sec-sole",
    "sec-shared",
  ]);
  assert.deepEqual(eligible.sort(), ["sec-sole"]);
});

test("BRK-009C review round B1: listNameEditableSecurityIds excludes a security with an active verified provider mapping", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  insertSecurity(database, {
    id: "sec-1",
    symbol: "IXJ",
    identifierSource: "sharesight",
  });
  insertCandidate(database, {
    id: "cand-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "IXJ",
    securityId: "sec-1",
  });
  insertVerifiedProviderMapping(database, {
    id: "mapping-1",
    securityId: "sec-1",
  });

  const eligible = await listNameEditableSecurityIds(client, "user-a", [
    "sec-1",
  ]);
  assert.deepEqual(eligible, []);
});

test("BRK-009C: listNameEditableSecurityIds excludes a security whose ticker identifier is not sharesight-sourced (resolved, not created)", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  insertSecurity(database, {
    id: "sec-1",
    symbol: "IXJ",
    identifierSource: "yahoo-best-effort",
  });
  insertCandidate(database, {
    id: "cand-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "IXJ",
    securityId: "sec-1",
  });

  const eligible = await listNameEditableSecurityIds(client, "user-a", [
    "sec-1",
  ]);
  assert.deepEqual(eligible, []);
});

// ---------------------------------------------------------------------------
// Part 5: the metadata mutation route/service.
// ---------------------------------------------------------------------------

const options: ImportSecurityMetadataActionOptions = {
  now: () => "2026-08-18T12:00:00.000Z",
};

async function setUpCreatedSecurity(
  database: DatabaseSync,
  batchId = "batch-a",
): Promise<{ client: SqlClient }> {
  const client = createSqliteSqlClient(database);
  insertBatch(database, {
    id: batchId,
    userId: "user-a",
    portfolioId: "portfolio-a",
  });
  insertRow(database, {
    id: "row-1",
    batchId,
    userId: "user-a",
    physicalRowNumber: 2,
    symbol: "IXJ",
  });
  insertSecurity(database, {
    id: "sec-1",
    symbol: "IXJ",
    canonicalName: "Unnamed security",
    identifierSource: "sharesight",
  });
  insertCandidate(database, {
    id: "cand-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "IXJ",
    securityId: "sec-1",
  });
  return { client };
}

async function currentVersionAndPreview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<{ expectedVersion: number; expectedPreviewVersion: string }> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch) throw new Error("expected batch");
  const review = await currentReview(client, userId, batchId);
  return {
    expectedVersion: batch.version,
    expectedPreviewVersion: review.previewVersion,
  };
}

test("BRK-009C: editing a created security's name sanitizes control characters and truncates to 120 characters, exactly like BRK-009B's sanitizeCanonicalName", async () => {
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  const { expectedVersion, expectedPreviewVersion } =
    await currentVersionAndPreview(client, "user-a", "batch-a");
  const longName = "A\x00B".repeat(60); // 180 chars incl. a control byte
  const result = await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      securityId: "sec-1",
      name: longName,
      expectedVersion,
      expectedPreviewVersion,
    },
    options,
  );
  assert.equal(result.ok, true);
  const row = database
    .prepare(`SELECT canonical_name FROM securities WHERE id = 'sec-1'`)
    .get() as { canonical_name: string };
  assert.equal(row.canonical_name.length, 120);
  assert.ok(!row.canonical_name.includes("\x00"));
});

test("BRK-009C: a name edit never changes security_id", async () => {
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  const { expectedVersion, expectedPreviewVersion } =
    await currentVersionAndPreview(client, "user-a", "batch-a");
  await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      securityId: "sec-1",
      name: "iShares Global Healthcare",
      expectedVersion,
      expectedPreviewVersion,
    },
    options,
  );
  const candidateRow = database
    .prepare(`SELECT security_id FROM portfolio_securities WHERE id = 'cand-1'`)
    .get() as { security_id: string };
  assert.equal(candidateRow.security_id, "sec-1");
});

test("BRK-009C: a name edit on a 'resolved' (not auto-created) security is rejected -- only a created security's name is editable here", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  insertBatch(database, {
    id: "batch-a",
    userId: "user-a",
    portfolioId: "portfolio-a",
  });
  insertRow(database, {
    id: "row-1",
    batchId: "batch-a",
    userId: "user-a",
    physicalRowNumber: 2,
    symbol: "IXJ",
  });
  insertSecurity(database, {
    id: "sec-1",
    symbol: "IXJ",
    canonicalName: "iShares Global Healthcare",
    identifierSource: "yahoo-best-effort",
  });
  insertCandidate(database, {
    id: "cand-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "IXJ",
    securityId: "sec-1",
  });
  const { expectedVersion, expectedPreviewVersion } =
    await currentVersionAndPreview(client, "user-a", "batch-a");
  const result = await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      securityId: "sec-1",
      name: "Renamed",
      expectedVersion,
      expectedPreviewVersion,
    },
    options,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  const row = database
    .prepare(`SELECT canonical_name FROM securities WHERE id = 'sec-1'`)
    .get() as { canonical_name: string };
  assert.equal(row.canonical_name, "iShares Global Healthcare");
});

test("BRK-009C review round B1 (BLOCKING repro): a name edit on a security ANOTHER user is also linked to is rejected 409 by the guarded UPDATE and leaves canonical_name untouched", async () => {
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  // A DIFFERENT owner also links to the SAME shared canonical security --
  // this is the exact cross-owner-rename repro the review round reproduced
  // against migrated sqlite.
  insertCandidate(database, {
    id: "cand-b",
    userId: "user-b",
    portfolioId: "portfolio-b",
    symbol: "IXJ",
    securityId: "sec-1",
  });
  const { expectedVersion, expectedPreviewVersion } =
    await currentVersionAndPreview(client, "user-a", "batch-a");
  const before = database
    .prepare(`SELECT canonical_name FROM securities WHERE id = 'sec-1'`)
    .get() as { canonical_name: string };

  const result = await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      securityId: "sec-1",
      name: "Hijacked Name",
      expectedVersion,
      expectedPreviewVersion,
    },
    options,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  assert.match(result.message, /shared or provider-verified/);
  const after = database
    .prepare(`SELECT canonical_name FROM securities WHERE id = 'sec-1'`)
    .get() as { canonical_name: string };
  assert.equal(after.canonical_name, before.canonical_name);
});

test("BRK-009C review round B1: a name edit on a security with an active VERIFIED provider mapping is rejected 409 and leaves canonical_name untouched", async () => {
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  insertVerifiedProviderMapping(database, {
    id: "mapping-1",
    securityId: "sec-1",
  });
  const { expectedVersion, expectedPreviewVersion } =
    await currentVersionAndPreview(client, "user-a", "batch-a");
  const before = database
    .prepare(`SELECT canonical_name FROM securities WHERE id = 'sec-1'`)
    .get() as { canonical_name: string };

  const result = await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      securityId: "sec-1",
      name: "Overwritten",
      expectedVersion,
      expectedPreviewVersion,
    },
    options,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
  const after = database
    .prepare(`SELECT canonical_name FROM securities WHERE id = 'sec-1'`)
    .get() as { canonical_name: string };
  assert.equal(after.canonical_name, before.canonical_name);
});

test("BRK-009C review round B2 follow-up: a portfolioId that disagrees with the batch's own target portfolio is rejected 400, never trusted from the client", async () => {
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  const { expectedVersion, expectedPreviewVersion } =
    await currentVersionAndPreview(client, "user-a", "batch-a");
  const result = await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-b",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      securityId: "sec-1",
      name: "Renamed",
      expectedVersion,
      expectedPreviewVersion,
    },
    options,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 400);
});

test("BRK-009C review round B2: exchange and currency have no edit code path at all -- neither can ever be written by this service", async () => {
  const source = await readFile(
    new URL("../app/import-security-metadata-service.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /SET[\s\S]{0,80}(source_currency_code|primary_currency_code|source_exchange_alias)/,
    "no UPDATE statement may ever set a currency or exchange column",
  );
  assert.doesNotMatch(
    source,
    /input\?\.exchange/,
    "no exchange field is ever read from the request",
  );

  // Functional confirmation: an edit call succeeds while leaving the
  // security's currency AND the candidate's exchange columns untouched.
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  const { expectedVersion, expectedPreviewVersion } =
    await currentVersionAndPreview(client, "user-a", "batch-a");
  await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      securityId: "sec-1",
      name: "Renamed",
      expectedVersion,
      expectedPreviewVersion,
    },
    options,
  );
  const security = database
    .prepare(`SELECT primary_currency_code FROM securities WHERE id = 'sec-1'`)
    .get() as { primary_currency_code: string };
  assert.equal(security.primary_currency_code, "AUD");
  const candidateRow = database
    .prepare(
      `SELECT source_exchange_alias FROM portfolio_securities WHERE id = 'cand-1'`,
    )
    .get() as { source_exchange_alias: string };
  assert.equal(candidateRow.source_exchange_alias, "ASX");
});

test("BRK-009C: an identity tuple that is not part of this batch's current preview is rejected as not found", async () => {
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  const { expectedVersion, expectedPreviewVersion } =
    await currentVersionAndPreview(client, "user-a", "batch-a");
  const result = await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "NEVERSEEN",
      sourceExchangeAlias: null,
      sourceCurrencyCode: "AUD",
      securityId: null,
      name: "Should not apply",
      expectedVersion,
      expectedPreviewVersion,
    },
    options,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
});

test("BRK-009C: another owner's batch is denied as not found (cross-user isolation)", async () => {
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  const { expectedVersion, expectedPreviewVersion } =
    await currentVersionAndPreview(client, "user-a", "batch-a");
  const result = await updateImportSecurityMetadataWithContext(
    { client, userId: "user-b", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      securityId: "sec-1",
      name: "Hijacked",
      expectedVersion,
      expectedPreviewVersion,
    },
    options,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
  const row = database
    .prepare(`SELECT canonical_name FROM securities WHERE id = 'sec-1'`)
    .get() as { canonical_name: string };
  assert.notEqual(row.canonical_name, "Hijacked");
});

test("BRK-009C: a stale expectedVersion is rejected with 409", async () => {
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  const { expectedPreviewVersion } = await currentVersionAndPreview(
    client,
    "user-a",
    "batch-a",
  );
  const result = await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      securityId: "sec-1",
      name: "New name",
      expectedVersion: 999,
      expectedPreviewVersion,
    },
    options,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
});

test("BRK-009C: a stale expectedPreviewVersion is rejected with 409", async () => {
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  const { expectedVersion } = await currentVersionAndPreview(
    client,
    "user-a",
    "batch-a",
  );
  const result = await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      securityId: "sec-1",
      name: "New name",
      expectedVersion,
      expectedPreviewVersion: "stale.deadbeef",
    },
    options,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 409);
});

test("BRK-009C review round F4: the membership match compares currency case-insensitively, matching security-resolution.ts's own UPPER() convention", async () => {
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  const { expectedVersion, expectedPreviewVersion } =
    await currentVersionAndPreview(client, "user-a", "batch-a");
  const result = await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "ixj",
      sourceExchangeAlias: "asx",
      sourceCurrencyCode: "aud",
      securityId: "sec-1",
      name: "Case Insensitive Co",
      expectedVersion,
      expectedPreviewVersion,
    },
    options,
  );
  assert.equal(result.ok, true);
});

test("BRK-009C review round F3: a successful name edit appends an owner-attributed audit event naming the batch and the new canonical name", async () => {
  const database = await migratedDatabase();
  const { client } = await setUpCreatedSecurity(database);
  const { expectedVersion, expectedPreviewVersion } =
    await currentVersionAndPreview(client, "user-a", "batch-a");
  await updateImportSecurityMetadataWithContext(
    { client, userId: "user-a", requestId: "req-audit" },
    "batch-a",
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
      securityId: "sec-1",
      name: "Audited Co",
      expectedVersion,
      expectedPreviewVersion,
    },
    options,
  );
  const events = database
    .prepare(
      `SELECT actor_user_id, action, target_type, target_id, request_id, result, metadata_json
         FROM audit_events WHERE action = 'import.security.update_metadata'`,
    )
    .all() as {
    actor_user_id: string;
    action: string;
    target_type: string;
    target_id: string;
    request_id: string;
    result: string;
    metadata_json: string;
  }[];
  assert.equal(events.length, 1);
  assert.equal(events[0]!.actor_user_id, "user-a");
  assert.equal(events[0]!.target_type, "import_batch");
  assert.equal(events[0]!.target_id, "batch-a");
  assert.equal(events[0]!.request_id, "req-audit");
  assert.equal(events[0]!.result, "success");
  const metadata = JSON.parse(events[0]!.metadata_json) as {
    canonicalName?: string;
    sourceSymbol?: string;
  };
  assert.equal(metadata.canonicalName, "Audited Co");
  assert.equal(metadata.sourceSymbol, "IXJ");
});

test("BRK-009C: the metadata route enforces CSRF before its authenticated action", async () => {
  let calls = 0;
  const rejectedPost = createImportSecurityMetadataPost(async () => {
    calls += 1;
    throw new Error("cross-site request reached the action");
  });
  const rejected = await rejectedPost(
    new Request(
      "https://yield.example/api/import/preview/batch-a/securities/metadata",
      {
        method: "POST",
        headers: { origin: "https://attacker.example" },
      },
    ),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(rejected.status, 403);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// Part 6: import-review.tsx source/behaviour assertions.
// ---------------------------------------------------------------------------

test("BRK-009C: the review securities section renders only for a sharesight_sync batch", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /const securitiesReview =\s*\n\s*review && review\.batch\.parserFormat === "sharesight_sync"/,
  );
});

test('BRK-009C: two "Accept Import" buttons render, one before the table and one after, wired to the same dialog/action', async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  const section = component.match(
    /\{securitiesReview \? \(([\s\S]*?)\n {10}\) : null\}/,
  );
  assert.ok(section, "expected to find the securities review section");
  const body = section![1]!;

  const tableIndex = body.indexOf("<table");
  assert.ok(tableIndex > -1, "expected a table in the securities section");
  const firstAcceptIndex = body.indexOf("Accept Import");
  const lastAcceptIndex = body.lastIndexOf("Accept Import");
  assert.ok(
    firstAcceptIndex > -1 && firstAcceptIndex < tableIndex,
    "expected an Accept Import button BEFORE the table",
  );
  assert.ok(
    lastAcceptIndex > tableIndex,
    "expected an Accept Import button AFTER the table",
  );
  assert.notEqual(
    firstAcceptIndex,
    lastAcceptIndex,
    "expected two distinct Accept Import buttons",
  );

  // Both buttons open the SAME dialog via the SAME handler.
  const acceptButtonMatches = [
    ...body.matchAll(/onClick=\{\(event\) => openAcceptDialog\(event\)\}/g),
  ];
  assert.equal(
    acceptButtonMatches.length,
    2,
    "both buttons must call the identical openAcceptDialog handler",
  );

  // Exactly one dialog, gated on one boolean state, submits through one
  // action (submitAccept).
  const dialogMatches = [...component.matchAll(/acceptDialogRef/g)];
  assert.ok(dialogMatches.length > 0);
  assert.match(component, /const \[acceptDialogOpen, setAcceptDialogOpen\]/);
  assert.match(component, /async function submitAccept\(\)/);
  const submitAcceptCalls = [
    ...component.matchAll(/onClick=\{\(\) => void submitAccept\(\)\}/g),
  ];
  assert.equal(
    submitAcceptCalls.length,
    1,
    "only the dialog's own confirm button calls submitAccept",
  );
});

test("BRK-009C review round B3: acceptDisabled gates on persisted blocking issues only -- never the computed preview.ready flag", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  const match = component.match(/const acceptDisabled =\s*\n([\s\S]*?);\n/);
  assert.ok(match, "expected to find the acceptDisabled derivation");
  assert.doesNotMatch(
    match![1]!,
    /review\.preview\.ready/,
    "must not gate on the computed readiness flag (SECURITY_MAPPING_REQUIRED resolves automatically on accept)",
  );
  assert.match(match![1]!, /blockedRowIssues\.length > 0/);

  // UI-013 review round B2: `acceptDisabled` now reads the batch-scoped
  // `reviewCommit` (not raw `commit` state) -- see
  // tests/ui-013.test.ts for the scoping behaviour itself.
  const evaluate = new Function(
    "review",
    "blockedRowIssues",
    "acceptPending",
    "reviewCommit",
    `return (${match![1]!});`,
  ) as (
    review: { batch: { status: string } },
    blockedRowIssues: unknown[],
    acceptPending: boolean,
    reviewCommit: { status: string } | null,
  ) => boolean;

  const preResolution = { batch: { status: "parsed" } };
  assert.equal(
    evaluate(preResolution, [], false, null),
    false,
    "a pre-resolution (unresolved) batch with nothing persisted-blocking must render ENABLED",
  );

  assert.equal(
    evaluate(preResolution, [{ id: "issue-1" }], false, null),
    true,
    "a batch with a persisted blocking issue (conflict/collision) must render DISABLED",
  );
});

test("BRK-009C review round B3: the blocked-vs-unresolved summary copy is accurate for both cases, with correct singular/plural forms", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /Resolve \{blockedRowIssues\.length\} blocked row/);

  // "securit" + ("y" : "ies") -- NOT "security" + ("" : "ies"), which would
  // render the ungrammatical "2 unresolved securityies".
  assert.match(
    component,
    /\{unresolvedSecurityCount\} unresolved securit\s*\n\s*\{unresolvedSecurityCount === 1 \? "y" : "ies"\} will be resolved\s*\n\s*automatically on accept\./,
    'expected the singular/plural-correct "securit" + "y"/"ies" copy',
  );
  assert.doesNotMatch(
    component,
    /unresolved security\s*\n\s*\{unresolvedSecurityCount === 1 \? "" : "ies"\}/,
    'must never render the ungrammatical "security" + ("" : "ies") concatenation (renders "securityies" for plural counts)',
  );
});

test("BRK-009C review round B2: the Exchange and Currency cells are always plain read-only text, never a form", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /<td>\{entry\.sourceExchangeAlias \?\? "Unknown"\}<\/td>/,
  );
  assert.match(component, /<td>\{entry\.sourceCurrencyCode\}<\/td>/);
  assert.doesNotMatch(component, /Exchange for \{entry\.sourceSymbol\}/);
  assert.doesNotMatch(component, /name="exchange"/);
});

test("BRK-009C: the name edit is gated on entry.nameEditable, never merely state === 'created'", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /entry\.nameEditable &&\s*\n\s*isMutableExclusionStatus\(review\.batch\.status\)/,
  );
});

test("BRK-009C: the securities table state column renders text, never color alone, for every state", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /Conflict -- see blocked rows below/);
  assert.match(component, /Awaiting resolution -- see pending mappings/);
  assert.match(component, /Newly added security/);
  assert.match(component, /Resolved to an existing security/);
});

test("BRK-009C: the name edit input is labelled and both the input and its button meet the 44px minimum tap target", async () => {
  const component = await readFile(
    new URL("../app/components/import-review.tsx", import.meta.url),
    "utf8",
  );
  assert.match(component, /Name for \{entry\.sourceSymbol\}/);
  assert.match(
    component,
    /<label>\s*\n\s*Name for \{entry\.sourceSymbol\}\s*\n\s*<input/,
  );

  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.import-securities-edit input \{[^}]*min-height: 44px;/);
  assert.match(css, /\.import-securities-edit button \{[^}]*min-height: 44px;/);
  assert.match(css, /\.import-accept-actions button \{[^}]*min-height: 44px;/);
});
