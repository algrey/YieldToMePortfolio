/**
 * BRK-019 slice 1 -- value-aware identity comparison at Sharesight-sync
 * preview time (`ROW_DIFFERS_FROM_COMMITTED_RECORD`), commit's own
 * independent fail-closed re-derivation, and the sync result's separate
 * "N need a decision" bucket. Owner ruling (TASKS.md, 2026-09-04): option A
 * -- a Sharesight correction is a decision surface, never an auto-write.
 *
 * This suite drives the REAL staging/commit/exclusion machinery against an
 * in-memory D1-shaped SQLite database (mirrors `tests/brk-005.test.ts`'s own
 * fixtures/helpers -- duplicated here rather than imported, since importing
 * another `*.test.ts` file re-executes its top-level `test()` calls too).
 * Preview-level assertions go through `buildImportReviewPreview` fed with
 * evidence assembled from the SAME pure query builders
 * (`app/import-review-queries.ts`) `app/import-actions.ts`'s `loadReview`
 * uses in production -- `loadReview` itself cannot be imported here (it
 * transitively pulls in `next/headers`).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { setImportRowExclusionWithContext } from "../app/import-row-exclusion-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import { deriveCommittedStatusLine } from "../app/import-review-commit-state.ts";
import { formatSyncResultMessage } from "../app/sharesight-sync-panel-helpers.ts";
import {
  existingDividendSourceReferenceRowsQuery,
  existingManualDividendRowsQuery,
  existingTradeSourceReferenceRowsQuery,
} from "../app/import-review-queries.ts";
import {
  linkSharesightPortfolioWithContext,
  runSharesightSyncWithContext,
} from "../app/sharesight-sync-service.ts";
import { invertToPortfolioConversionRate } from "../domain/sharesight-sync/transform.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION } from "../domain/imports/index.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type ImportCommitSuccess,
  type SqlClient,
} from "../db/repositories/index.ts";
import type {
  SharesightClient,
  SharesightPayout,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
} from "../domain/sharesight/index.ts";
import {
  createImportReconciliationPreview,
  type ImportPreviewExistingDividendEntry,
  type ImportPreviewPortfolio,
  type ImportPreviewSecurityCandidate,
  type ImportReconciliationIssue,
  type ImportReconciliationRow,
} from "../domain/imports/reconciliation.ts";
import {
  decimalValuesMatch,
  tradeValueDifferences,
  type CommittedDividendValues,
  type CommittedTradeValues,
} from "../domain/imports/committed-value-comparison.ts";

// ---------------------------------------------------------------------------
// Fixtures (duplicated from tests/brk-005.test.ts -- see this file's header)
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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-13', '2026-08-13', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-13', '2026-08-13', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-13', '2026-08-13'),
           ('security-b', 'Beta', 'equity', 'AUD', 'active', '2026-08-13', '2026-08-13');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-13', '2026-08-13'),
           ('membership-b', 'user-b', 'portfolio-b', 'security-b', 'ABC', 'ASX', 'AUD', 'held', '2026-08-13', '2026-08-13');
  `);
  return database;
}

function fakeTrade(overrides: Partial<SharesightTrade> = {}): SharesightTrade {
  return {
    id: "trade-1",
    portfolioId: "sp-1",
    holdingId: "holding-1",
    instrumentCode: "ABC",
    marketCode: "ASX",
    sharesightInstrumentId: null,
    instrumentName: null,
    isin: null,
    transactionType: "buy",
    transactionDate: "2026-08-01",
    currencyCode: "AUD",
    quantityDecimal: "5",
    priceDecimal: "10",
    valueDecimal: "50",
    brokerageDecimal: null,
    brokerageCurrencyCode: null,
    exchangeRateDecimal: null,
    exchangeRatePair: null,
    state: null,
    uniqueIdentifier: null,
    paidOnDate: null,
    descriptionCode: null,
    sourceCategory: null,
    comments: null,
    ...overrides,
  };
}

function fakePayout(
  overrides: Partial<SharesightPayout> = {},
): SharesightPayout {
  return {
    id: "payout-1",
    portfolioId: "sp-1",
    holdingId: "holding-1",
    sharesightInstrumentId: null,
    symbol: "ABC",
    marketCode: "ASX",
    currencyCode: "AUD",
    paidOnDate: "2026-08-05",
    amountDecimal: "2.50",
    grossAmountDecimal: "3.57",
    frankedAmountDecimal: null,
    unfrankedAmountDecimal: null,
    frankingCreditsDecimal: "1.07",
    residentWithholdingTaxDecimal: null,
    nonResidentWithholdingTaxDecimal: null,
    goesExOnDate: null,
    state: null,
    confirmed: true,
    trust: null,
    nonTaxable: null,
    comments: null,
    exchangeRateDecimal: null,
    ...overrides,
  };
}

function fakePortfolio(
  overrides: Partial<SharesightPortfolio> = {},
): SharesightPortfolio {
  return {
    id: "sp-1",
    name: "My SS Portfolio",
    currencyCode: "AUD",
    inceptionDate: null,
    tzName: null,
    accessLevel: null,
    financialYearEnd: null,
    cgDiscount: null,
    countryCode: null,
    ownerName: null,
    taxEntityType: null,
    ...overrides,
  };
}

function fakeSharesightClient(fixtures: {
  portfolios?: SharesightPortfolio[];
  trades?: SharesightTrade[];
  payouts?: SharesightPayout[];
  tradesResult?: SharesightResult<SharesightTrade[]>;
  payoutsResult?: SharesightResult<SharesightPayout[]>;
}): SharesightClient {
  return {
    async listPortfolios() {
      return { ok: true, value: fixtures.portfolios ?? [] };
    },
    async getPortfolioHoldings() {
      return { ok: true, value: [] };
    },
    async listTrades() {
      return (
        fixtures.tradesResult ?? { ok: true, value: fixtures.trades ?? [] }
      );
    },
    async listPayouts() {
      return (
        fixtures.payoutsResult ?? { ok: true, value: fixtures.payouts ?? [] }
      );
    },
    async listUserInstruments() {
      return { ok: true, value: [] };
    },
  };
}

async function linkedFixture(
  database: DatabaseSync,
  userId: string,
  portfolioId: string,
  sharesightPortfolioId: string,
  fixtures: Parameters<typeof fakeSharesightClient>[0],
): Promise<{ client: SqlClient; sharesightClient: SharesightClient }> {
  const client = createSqliteSqlClient(database);
  const sharesightClient = fakeSharesightClient(fixtures);
  const linked = await linkSharesightPortfolioWithContext(
    { client, userId, requestId: "link-req" },
    portfolioId,
    { sharesightPortfolioId },
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(linked.ok, true);
  return { client, sharesightClient };
}

// ---------------------------------------------------------------------------
// Committed-value evidence assembly -- mirrors app/import-actions.ts's
// loadReview evidence assembly (see that file and app/import-review-queries.ts
// for the production wiring this test-only helper replicates against a real,
// user-scoped DB read).
// ---------------------------------------------------------------------------

async function loadCommittedComparisonEvidence(
  client: SqlClient,
  userId: string,
): Promise<{
  existingTradeSourceReferences: Set<string>;
  existingDividendSourceReferences: Set<string>;
  committedTradeValues: Map<string, CommittedTradeValues>;
  committedDividendValues: Map<string, CommittedDividendValues>;
  existingDividendEntries: ImportPreviewExistingDividendEntry[];
}> {
  const tradeStmt = existingTradeSourceReferenceRowsQuery(userId, 5001);
  const tradeRows = await client.all<Record<string, unknown>>(
    tradeStmt.sql,
    tradeStmt.params,
  );
  const dividendStmt = existingDividendSourceReferenceRowsQuery(userId);
  const dividendRows = await client.all<Record<string, unknown>>(
    dividendStmt.sql,
    dividendStmt.params,
  );
  const manualStmt = existingManualDividendRowsQuery(userId, 5001);
  const manualRows = await client.all<Record<string, unknown>>(
    manualStmt.sql,
    manualStmt.params,
  );

  const existingTradeSourceReferences = new Set(
    tradeRows.map(
      (row) => `${String(row.portfolio_id)}::${String(row.source_reference)}`,
    ),
  );
  const committedTradeValues = new Map<string, CommittedTradeValues>(
    tradeRows.map((row) => [
      `${String(row.portfolio_id)}::${String(row.source_reference)}`,
      {
        quantityDecimal:
          row.quantity_decimal === null ? null : String(row.quantity_decimal),
        priceDecimal:
          row.unit_price_decimal === null
            ? null
            : String(row.unit_price_decimal),
        feeAmountDecimal:
          row.fee_amount_decimal === null
            ? null
            : String(row.fee_amount_decimal),
        localTradeDate:
          row.local_trade_date === null ? null : String(row.local_trade_date),
        type: row.type === null ? null : String(row.type),
        currencyCode:
          row.currency_code === null ? null : String(row.currency_code),
      },
    ]),
  );
  const existingDividendSourceReferences = new Set(
    dividendRows.map(
      (row) => `${String(row.portfolio_id)}::${String(row.source_reference)}`,
    ),
  );
  const committedDividendValues = new Map<string, CommittedDividendValues>(
    dividendRows.map((row) => [
      `${String(row.portfolio_id)}::${String(row.source_reference)}`,
      {
        cashTotalDecimal:
          row.total_cash_decimal === null
            ? null
            : String(row.total_cash_decimal),
        totalFrankingDecimal:
          row.total_franking_decimal === null
            ? null
            : String(row.total_franking_decimal),
        paymentDate:
          row.payment_date === null ? null : String(row.payment_date),
        fxRateToPortfolioDecimal:
          row.fx_rate_to_portfolio_decimal === null
            ? null
            : String(row.fx_rate_to_portfolio_decimal),
        currencyCode:
          row.currency_code === null ? null : String(row.currency_code),
      },
    ]),
  );
  const existingDividendEntries: ImportPreviewExistingDividendEntry[] =
    manualRows.map((row) => ({
      portfolioSecurityId: String(row.portfolio_security_id),
      paymentDate: String(row.payment_date),
      cashTotalDecimal:
        row.total_cash_decimal === null ? null : String(row.total_cash_decimal),
      frankingTotalDecimal:
        row.total_franking_decimal === null
          ? null
          : String(row.total_franking_decimal),
      currencyCode:
        row.currency_code === null ? null : String(row.currency_code),
      sourceReference:
        row.source_reference === null ? null : String(row.source_reference),
    }));
  return {
    existingTradeSourceReferences,
    existingDividendSourceReferences,
    committedTradeValues,
    committedDividendValues,
    existingDividendEntries,
  };
}

/** Loads the FULL, evidence-complete review preview for a batch -- this is
 * the "page path" (`app/import-actions.ts`'s `loadReview`) that alone
 * supplies `committedTradeValues`/`committedDividendValues`/
 * `existingDividendEntries` (see `ROW_DIFFERS_FROM_COMMITTED_RECORD`'s own
 * doc comment in reconciliation.ts for why this is deliberately NOT the
 * evidence-blind copy `app/import-ready-service.ts`/
 * `app/import-row-exclusion-service.ts` use for the ready/exclude
 * transitions themselves). */
async function loadFullPreview(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<{ issues: readonly ImportReconciliationIssue[]; ready: boolean }> {
  const staging = createOwnedImportStagingRepository(client);
  const batch = await staging.get(userId, batchId);
  if (!batch) throw new Error("expected batch to exist");
  const [rows, issues, mappings, portfolios, candidateRows, evidence] =
    await Promise.all([
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
      loadCommittedComparisonEvidence(client, userId),
    ]);
  const portfoliosMapped: ImportPreviewPortfolio[] = portfolios.map(
    (portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    }),
  );
  const securityCandidates: ImportPreviewSecurityCandidate[] =
    candidateRows.map((row) => ({
      id: String(row.id),
      portfolioId: String(row.portfolio_id),
      sourceSymbol: String(row.source_symbol),
      sourceExchangeAlias:
        row.source_exchange_alias === null
          ? null
          : String(row.source_exchange_alias),
      sourceCurrencyCode: String(row.source_currency_code),
      securityId: row.security_id === null ? null : String(row.security_id),
    }));
  const review = buildImportReviewPreview({
    batch,
    rows,
    issues,
    mappings,
    portfolios: portfoliosMapped,
    securityCandidates,
    existingDividendEntries: evidence.existingDividendEntries,
    existingTradeSourceReferences: evidence.existingTradeSourceReferences,
    existingDividendSourceReferences: evidence.existingDividendSourceReferences,
    committedTradeValues: evidence.committedTradeValues,
    committedDividendValues: evidence.committedDividendValues,
  });
  return { issues: review.preview.issues, ready: review.preview.ready };
}

/** The evidence-BLIND preview version/readiness computation the ready and
 * exclusion services themselves use in production (`app/import-ready-service.ts`'s
 * `loadImportReview`) -- deliberately excludes `committedTradeValues`/
 * `committedDividendValues`/`existingDividendEntries`. `ROW_DIFFERS_FROM_
 * COMMITTED_RECORD` is excluded from `previewVersion` hashing regardless
 * (`domain/imports/review.ts`), so this stays byte-compatible with
 * `loadFullPreview`'s own hash for the SAME server-round-trip discipline
 * production relies on. */
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

/** Drives a batch through ready -> commit (retrying until `status ===
 * "committed"`, matching this codebase's chunked-commit convention) and
 * returns the FINAL commit result, unlike `tests/brk-005.test.ts`'s own
 * `commitBatch` (which discards it) -- this suite needs the row-effect
 * counts (`needsDecisionRows`/`skippedRows`/`committedRows`) the ready/
 * exclude services never see. */
async function commitBatchAndReturnResult(
  client: SqlClient,
  userId: string,
  batchId: string,
  idempotencyKey: string,
  expectedVersion: number,
): Promise<ImportCommitSuccess> {
  const previewVersion = await currentPreviewVersion(client, userId, batchId);
  const ready = await markImportReadyWithContext({ client, userId }, batchId, {
    expectedVersion,
    expectedPreviewVersion: previewVersion,
  });
  assert.equal(ready.ok, true, `expected ${batchId} to reach ready`);
  if (!ready.ok) throw new Error("unreachable");
  const readyVersion = ready.review.batch.version;
  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate(userId, batchId);
  assert.equal(validated.ok, true);
  if (!validated.ok) throw new Error("unreachable");
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
  if (!commitResult.ok) throw new Error("unreachable");
  assert.equal(commitResult.status, "committed");
  return commitResult;
}

function onlyIssue(
  issues: readonly ImportReconciliationIssue[],
  code: string,
): ImportReconciliationIssue {
  const matches = issues.filter((issue) => issue.code === code);
  assert.equal(
    matches.length,
    1,
    `expected exactly one ${code} issue, found ${matches.length}`,
  );
  return matches[0]!;
}

function fieldDiff(
  issue: ImportReconciliationIssue,
  field: string,
): { committed: string | null; incoming: string | null } {
  const match = (issue.fieldDifferences ?? []).find(
    (difference) => difference.field === field,
  );
  assert.ok(match, `expected a "${field}" field difference on the issue`);
  return match!;
}

// ---------------------------------------------------------------------------
// A1-A5: sync -> commit -> corrected re-sync each yields exactly one
// needs_decision (ROW_DIFFERS_FROM_COMMITTED_RECORD) row at PREVIEW time,
// with the correct committed (old) vs incoming (new) value on the changed
// field.
// ---------------------------------------------------------------------------

test("BRK-019: a franking-only correction to a committed payout yields exactly one needs_decision row, with the correct old/new franking values", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient: firstClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    "sp-1",
    {
      portfolios: [fakePortfolio()],
      trades: [],
      payouts: [
        fakePayout({
          id: "payout-franking",
          paidOnDate: "2026-08-05",
          amountDecimal: "2.50",
          frankingCreditsDecimal: "1.07",
        }),
      ],
    },
  );
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: { enabled: true, client: firstClient } },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    first.batchId,
    "brk-019-franking-commit",
    firstBatch!.version,
  );

  const correctedClient = fakeSharesightClient({
    trades: [],
    payouts: [
      fakePayout({
        id: "payout-franking",
        paidOnDate: "2026-08-05",
        amountDecimal: "2.50",
        frankingCreditsDecimal: "2.50",
      }),
    ],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: { enabled: true, client: correctedClient } },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const preview = await loadFullPreview(client, "user-a", second.batchId);
  const issue = onlyIssue(preview.issues, "ROW_DIFFERS_FROM_COMMITTED_RECORD");
  assert.equal(issue.severity, "error");
  const diff = fieldDiff(issue, "franking credits");
  assert.equal(diff.committed, "1.07");
  assert.equal(diff.incoming, "2.50");
});

test("BRK-019: a trade-date-only correction to a committed trade yields exactly one needs_decision row, with the correct old/new trade date", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient: firstClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    "sp-1",
    {
      portfolios: [fakePortfolio()],
      trades: [fakeTrade({ id: "trade-date", transactionDate: "2026-08-01" })],
      payouts: [],
    },
  );
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: { enabled: true, client: firstClient } },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    first.batchId,
    "brk-019-tradedate-commit",
    firstBatch!.version,
  );

  const correctedClient = fakeSharesightClient({
    trades: [fakeTrade({ id: "trade-date", transactionDate: "2026-08-15" })],
    payouts: [],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: { enabled: true, client: correctedClient } },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const preview = await loadFullPreview(client, "user-a", second.batchId);
  const issue = onlyIssue(preview.issues, "ROW_DIFFERS_FROM_COMMITTED_RECORD");
  const diff = fieldDiff(issue, "trade date");
  assert.equal(diff.committed, "2026-08-01");
  assert.equal(diff.incoming, "2026-08-15");
});

test("BRK-019: a fee-only correction to a committed trade yields exactly one needs_decision row, with the correct old/new fee", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient: firstClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    "sp-1",
    {
      portfolios: [fakePortfolio()],
      trades: [fakeTrade({ id: "trade-fee", brokerageDecimal: null })],
      payouts: [],
    },
  );
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: { enabled: true, client: firstClient } },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    first.batchId,
    "brk-019-fee-commit",
    firstBatch!.version,
  );

  // Sharesight reports the SAME trade id with a corrected brokerage fee
  // only -- fingerprint is `sharesight-trade:<id>` alone (never affected by
  // commission), so this is still the same identity.
  const correctedClient = fakeSharesightClient({
    trades: [fakeTrade({ id: "trade-fee", brokerageDecimal: "5" })],
    payouts: [],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: { enabled: true, client: correctedClient } },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const preview = await loadFullPreview(client, "user-a", second.batchId);
  const issue = onlyIssue(preview.issues, "ROW_DIFFERS_FROM_COMMITTED_RECORD");
  const diff = fieldDiff(issue, "fee");
  assert.equal(diff.committed, "0");
  assert.equal(diff.incoming, "5");
});

test("BRK-019: an FX-only correction to a foreign-currency payout yields exactly one needs_decision row, with the correct old/new FX rate", async () => {
  const database = await migratedDatabase();
  // membership-a's source currency is widened to USD so the payout resolves
  // to the pre-seeded membership (matches tests/brk-005.test.ts's own
  // "FX-only correction" fixture -- see that test's comment for the exact
  // "foreign to security" mechanics this exercises).
  database.exec(
    `UPDATE portfolio_securities SET source_currency_code = 'USD' WHERE id = 'membership-a';`,
  );
  const { client, sharesightClient: firstClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    "sp-1",
    {
      portfolios: [fakePortfolio()],
      trades: [],
      payouts: [
        fakePayout({
          id: "payout-fx",
          paidOnDate: "2026-08-05",
          currencyCode: "USD",
          amountDecimal: "2.50",
          frankingCreditsDecimal: null,
          exchangeRateDecimal: "0.65",
        }),
      ],
    },
  );
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: { enabled: true, client: firstClient } },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    first.batchId,
    "brk-019-fx-commit",
    firstBatch!.version,
  );

  const correctedClient = fakeSharesightClient({
    trades: [],
    payouts: [
      fakePayout({
        id: "payout-fx",
        paidOnDate: "2026-08-05",
        currencyCode: "USD",
        amountDecimal: "2.50",
        frankingCreditsDecimal: null,
        exchangeRateDecimal: "0.70",
      }),
    ],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: { enabled: true, client: correctedClient } },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const preview = await loadFullPreview(client, "user-a", second.batchId);
  const issue = onlyIssue(preview.issues, "ROW_DIFFERS_FROM_COMMITTED_RECORD");
  const diff = fieldDiff(issue, "FX rate");
  // BRK-010 review finding B1: Sharesight's raw `exchange_rate` is the
  // INVERSE of this codebase's `fx_rate_to_portfolio_decimal` convention --
  // `transformSharesightSync` corrects it exactly once
  // (`invertToPortfolioConversionRate`), so both the committed (old) and
  // incoming (new) values are the RECIPROCAL of the raw fixture rates, not
  // "0.65"/"0.70" verbatim.
  assert.equal(diff.committed, invertToPortfolioConversionRate("0.65"));
  assert.equal(diff.incoming, invertToPortfolioConversionRate("0.70"));
});

test("BRK-019: a paid-date-only correction escalates the DIV-004 near-match against a Sharesight-sourced record to a needs_decision row, not a plain warning", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient: firstClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    "sp-1",
    {
      portfolios: [fakePortfolio()],
      trades: [],
      payouts: [
        fakePayout({
          id: "payout-paiddate",
          paidOnDate: "2026-08-05",
          amountDecimal: "2.50",
          frankingCreditsDecimal: "1.07",
        }),
      ],
    },
  );
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: { enabled: true, client: firstClient } },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    first.batchId,
    "brk-019-paiddate-commit",
    firstBatch!.version,
  );

  // Same payout id, same amount, but a paid-on-date 3 days later (within
  // DIV-001/DIV-004's 7-day proximity window) -- the identity key
  // (`sharesight-payout:<portfolio>:<holding>:<paidOnDate>`) is NEW, so this
  // is not an exact-identity match at all; only the DIV-004 economic
  // near-match (same security, same cash total, Sharesight-sourced
  // neighbour) can catch it.
  const correctedClient = fakeSharesightClient({
    trades: [],
    payouts: [
      fakePayout({
        id: "payout-paiddate",
        paidOnDate: "2026-08-08",
        amountDecimal: "2.50",
        frankingCreditsDecimal: "1.07",
      }),
    ],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: { enabled: true, client: correctedClient } },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.notEqual(
    second.batchId,
    first.batchId,
    "a new identity key must stage a new batch",
  );

  const preview = await loadFullPreview(client, "user-a", second.batchId);
  const issue = onlyIssue(preview.issues, "ROW_DIFFERS_FROM_COMMITTED_RECORD");
  const diff = fieldDiff(issue, "paid on date");
  assert.equal(diff.committed, "2026-08-05");
  assert.equal(diff.incoming, "2026-08-08");
  assert.equal(
    preview.issues.find(
      (candidate) => candidate.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
    ),
    undefined,
    "the paid-date escalation must REPLACE the plain proximity warning, not add to it",
  );
});

// ---------------------------------------------------------------------------
// A6: an identical re-sync is a true no-op -- already_imported, fully
// suppressed at preview time, "No new rows" at the sync-result level.
// ---------------------------------------------------------------------------

test("BRK-019: a byte-identical re-sync of a committed trade reports already_imported, is fully suppressed at preview time, and the sync message says 'No new rows'", async () => {
  const database = await migratedDatabase();
  const fixtures = {
    portfolios: [fakePortfolio()],
    trades: [fakeTrade({ id: "trade-unchanged" })],
    payouts: [] as SharesightPayout[],
  };
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    "sp-1",
    fixtures,
  );
  const integration = { enabled: true as const, client: sharesightClient };
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    first.batchId,
    "brk-019-unchanged-commit",
    firstBatch!.version,
  );

  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.reused, true, "identical fetch must reuse the batch");
  assert.equal(second.newRows, 0);
  assert.equal(second.needsDecisionRows, 0);
  assert.equal(second.alreadyImportedRows, 1);
  assert.match(formatSyncResultMessage(second), /No new rows/);

  const preview = await loadFullPreview(client, "user-a", second.batchId);
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "ROW_DIFFERS_FROM_COMMITTED_RECORD",
    ),
    undefined,
    "an unchanged row must never be flagged as needing a decision",
  );
});

// ---------------------------------------------------------------------------
// A7: Accept with an unresolved needs-decision row commits every OTHER row,
// reports "1 needs a decision", and leaves the ledger for that identity
// unchanged (row count + values).
// ---------------------------------------------------------------------------

test("BRK-019: accepting a batch with one needs_decision row commits every other row, reports '1 needs a decision', and leaves the corrected identity's ledger row untouched", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient: firstClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    "sp-1",
    {
      portfolios: [fakePortfolio()],
      trades: [fakeTrade({ id: "trade-corrected", brokerageDecimal: null })],
      payouts: [],
    },
  );
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: { enabled: true, client: firstClient } },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    first.batchId,
    "brk-019-accept-commit-1",
    firstBatch!.version,
  );

  // The second sync's fetch contains BOTH the corrected trade (fee changed)
  // AND a genuinely brand-new trade for the same holding.
  const correctedClient = fakeSharesightClient({
    trades: [
      fakeTrade({ id: "trade-corrected", brokerageDecimal: "5" }),
      fakeTrade({
        id: "trade-new",
        transactionDate: "2026-08-10",
        quantityDecimal: "3",
        priceDecimal: "20",
        valueDecimal: "60",
      }),
    ],
    payouts: [],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: { enabled: true, client: correctedClient } },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.rowsStaged, 2);
  assert.equal(second.needsDecisionRows, 1);
  assert.equal(second.newRows, 1);

  const secondBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    second.batchId,
  );
  const commitResult = await commitBatchAndReturnResult(
    client,
    "user-a",
    second.batchId,
    "brk-019-accept-commit-2",
    secondBatch!.version,
  );
  assert.equal(
    commitResult.committedRows,
    1,
    "the genuinely new row must commit",
  );
  assert.equal(commitResult.skippedRows, 1, "the needs_decision row must skip");
  assert.equal(commitResult.needsDecisionRows, 1);
  assert.equal(commitResult.excludedByOwnerRows, 0);
  assert.equal(commitResult.remainingRows, 0);

  const statusLine = deriveCommittedStatusLine(
    "committed",
    commitResult,
    commitResult,
  );
  assert.match(statusLine, /1 needs a decision/);

  // Ledger unchanged for the corrected identity: still exactly one row,
  // still the ORIGINAL fee ("0"), never the incoming "5".
  const correctedRows = await client.all<{
    fee_amount_decimal: string;
    quantity_decimal: string;
  }>(
    `SELECT fee_amount_decimal, quantity_decimal FROM transactions
      WHERE user_id = ? AND portfolio_id = ? AND source_reference = ?
        AND status <> 'reversed'`,
    [
      "user-a",
      "portfolio-a",
      "import-fingerprint:sharesight-trade:trade-corrected",
    ],
  );
  assert.equal(correctedRows.length, 1);
  assert.equal(correctedRows[0]!.fee_amount_decimal, "0");
  assert.equal(correctedRows[0]!.quantity_decimal, "5");

  // The genuinely new row DID commit.
  const newRows = await client.all<{ quantity_decimal: string }>(
    `SELECT quantity_decimal FROM transactions
      WHERE user_id = ? AND portfolio_id = ? AND source_reference = ?
        AND status <> 'reversed'`,
    ["user-a", "portfolio-a", "import-fingerprint:sharesight-trade:trade-new"],
  );
  assert.equal(newRows.length, 1);
  assert.equal(newRows[0]!.quantity_decimal, "3");
});

// ---------------------------------------------------------------------------
// A8: Exclude clears the block (IMP-008 precedent).
// ---------------------------------------------------------------------------

test("BRK-019: excluding a needs_decision row clears the block at preview time and commits as owner-excluded, never as needs_decision", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient: firstClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    "sp-1",
    {
      portfolios: [fakePortfolio()],
      trades: [fakeTrade({ id: "trade-exclude", brokerageDecimal: null })],
      payouts: [],
    },
  );
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: { enabled: true, client: firstClient } },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    first.batchId,
    "brk-019-exclude-commit-1",
    firstBatch!.version,
  );

  const correctedClient = fakeSharesightClient({
    trades: [fakeTrade({ id: "trade-exclude", brokerageDecimal: "5" })],
    payouts: [],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: { enabled: true, client: correctedClient } },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const beforeExclude = await loadFullPreview(client, "user-a", second.batchId);
  assert.equal(
    beforeExclude.issues.filter(
      (issue) => issue.code === "ROW_DIFFERS_FROM_COMMITTED_RECORD",
    ).length,
    1,
  );
  assert.equal(
    beforeExclude.ready,
    false,
    "the needs_decision row must block readiness at the page level",
  );

  const staging = createOwnedImportStagingRepository(client);
  const secondBatch = await staging.get("user-a", second.batchId);
  const stagedRows = await staging.listRows("user-a", second.batchId);
  const targetRow = stagedRows.find(
    (row) => row.normalizedFingerprint === "sharesight-trade:trade-exclude",
  );
  assert.ok(targetRow);
  const previewVersion = await currentPreviewVersion(
    client,
    "user-a",
    second.batchId,
  );
  const excluded = await setImportRowExclusionWithContext(
    { client, userId: "user-a", requestId: "exclude-req" },
    second.batchId,
    {
      action: "exclude",
      target: { kind: "rowIds", rowIds: [targetRow!.id] },
      expectedVersion: secondBatch!.version,
      expectedPreviewVersion: previewVersion,
    },
  );
  assert.equal(excluded.ok, true);

  const afterExclude = await loadFullPreview(client, "user-a", second.batchId);
  assert.equal(
    afterExclude.issues.find(
      (issue) => issue.code === "ROW_DIFFERS_FROM_COMMITTED_RECORD",
    ),
    undefined,
    "excluding the row must clear the block entirely",
  );
  assert.equal(afterExclude.ready, true);

  const secondBatchAfterExclude = await staging.get("user-a", second.batchId);
  const commitResult = await commitBatchAndReturnResult(
    client,
    "user-a",
    second.batchId,
    "brk-019-exclude-commit-2",
    secondBatchAfterExclude!.version,
  );
  assert.equal(commitResult.committedRows, 0);
  assert.equal(commitResult.skippedRows, 1);
  assert.equal(commitResult.excludedByOwnerRows, 1);
  assert.equal(
    commitResult.needsDecisionRows,
    0,
    "an excluded row is never ALSO counted as needing a decision",
  );

  // The committed record is genuinely untouched.
  const rows = await client.all<{ fee_amount_decimal: string }>(
    `SELECT fee_amount_decimal FROM transactions
      WHERE user_id = ? AND portfolio_id = ? AND source_reference = ?
        AND status <> 'reversed'`,
    [
      "user-a",
      "portfolio-a",
      "import-fingerprint:sharesight-trade:trade-exclude",
    ],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.fee_amount_decimal, "0");
});

// ---------------------------------------------------------------------------
// A9: CSV-route parity -- the SAME commit-time fail-closed check applies
// regardless of upload origin, because both routes commit through the same
// `db/repositories/import-commit.ts` writer (a CSV-parsed trade and a
// Sharesight-synced trade both land with `transactions.source_type =
// 'csv_import'`). Staged directly via raw SQL (this codebase's established
// per-test-file `stageRow` convention -- see tests/imp-003b.test.ts) rather
// than driving the real CSV parser, since only commit's OWN behaviour is
// under test here.
// ---------------------------------------------------------------------------

test("BRK-019: CSV-route parity -- a re-uploaded CSV row sharing its predecessor's fingerprint with a corrected trade date is skipped as needs_decision, never silently accepted", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const now = "2026-08-20T00:00:00Z";

  database.exec(`
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('csv-batch-1', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION}', 'first.csv', 100, 'file-1', 'parsed', '${now}', '${now}', 1);
    INSERT INTO import_rows (
      id, user_id, batch_id, physical_row_number, row_class,
      original_fields_json, normalized_fields_json, normalized_fingerprint,
      validation_status, target_portfolio_id, target_portfolio_security_id,
      commit_status, created_at, updated_at, version
    ) VALUES ('csv-row-1', 'user-a', 'csv-batch-1', 2, 'transaction', '[]',
      '${JSON.stringify({
        id: "csv-row-1",
        symbol: "ABC",
        name: "Alpha",
        displaySymbol: null,
        exchange: "ASX",
        portfolio: "Main",
        currency: "AUD",
        sharesOwned: "5",
        costPerShare: "10",
        commission: "0",
        transactionDate: "2026-08-01",
        transactionTime: null,
        purchaseExchangeRate: null,
        type: "buy",
        accounting: "fifo",
        accountingExecutionIds: null,
        notes: null,
        tradeAtUtc: "2026-08-01T00:00:00.000Z",
        localTradeDate: "2026-08-01",
        cashEvent: null,
      })}', 'csv-fingerprint-shared', 'valid', 'portfolio-a', 'membership-a',
      'staged', '${now}', '${now}', 1);
  `);
  await commitBatchAndReturnResult(
    client,
    "user-a",
    "csv-batch-1",
    "csv-commit-1",
    1,
  );

  database.exec(`
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('csv-batch-2', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION}', 'corrected.csv', 100, 'file-2', 'parsed', '${now}', '${now}', 1);
    INSERT INTO import_rows (
      id, user_id, batch_id, physical_row_number, row_class,
      original_fields_json, normalized_fields_json, normalized_fingerprint,
      validation_status, target_portfolio_id, target_portfolio_security_id,
      commit_status, created_at, updated_at, version
    ) VALUES ('csv-row-2', 'user-a', 'csv-batch-2', 2, 'transaction', '[]',
      '${JSON.stringify({
        id: "csv-row-2",
        symbol: "ABC",
        name: "Alpha",
        displaySymbol: null,
        exchange: "ASX",
        portfolio: "Main",
        currency: "AUD",
        sharesOwned: "5",
        costPerShare: "10",
        commission: "0",
        transactionDate: "2026-08-15",
        transactionTime: null,
        purchaseExchangeRate: null,
        type: "buy",
        accounting: "fifo",
        accountingExecutionIds: null,
        notes: null,
        tradeAtUtc: "2026-08-15T00:00:00.000Z",
        localTradeDate: "2026-08-15",
        cashEvent: null,
      })}', 'csv-fingerprint-shared', 'valid', 'portfolio-a', 'membership-a',
      'staged', '${now}', '${now}', 1);
  `);
  const commitResult = await commitBatchAndReturnResult(
    client,
    "user-a",
    "csv-batch-2",
    "csv-commit-2",
    1,
  );
  assert.equal(commitResult.committedRows, 0);
  assert.equal(commitResult.skippedRows, 1);
  assert.equal(commitResult.needsDecisionRows, 1);

  const issues = await client.all<{ code: string; message: string }>(
    `SELECT code, message FROM import_issues WHERE batch_id = 'csv-batch-2' AND row_id = 'csv-row-2'`,
    [],
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.code, "ROW_DIFFERS_FROM_COMMITTED_RECORD");
  assert.match(issues[0]!.message, /trade date/);

  const rows = await client.all<{ local_trade_date: string }>(
    `SELECT local_trade_date FROM transactions
      WHERE user_id = ? AND portfolio_id = ? AND source_reference = ?
        AND status <> 'reversed'`,
    ["user-a", "portfolio-a", "import-fingerprint:csv-fingerprint-shared"],
  );
  assert.equal(
    rows.length,
    1,
    "the CSV route must never double-write for a shared fingerprint",
  );
  assert.equal(
    rows[0]!.local_trade_date,
    "2026-08-01",
    "the original committed date is untouched",
  );
});

// ---------------------------------------------------------------------------
// A10: Ownership isolation -- another owner's differently-valued committed
// row sharing the identical fingerprint SUFFIX never leaks into this
// owner's comparison, because both the map key and the underlying query are
// scoped to `user_id`.
// ---------------------------------------------------------------------------

test("BRK-019: ownership isolation -- another owner's committed trade sharing the identical fingerprint text never affects this owner's already-imported classification", async () => {
  const database = await migratedDatabase();
  const now = "2026-08-20T00:00:00Z";
  // user-b independently commits a DIFFERENTLY-VALUED trade whose Sharesight
  // id happens to be the SAME literal string ("trade-1") as the one user-a
  // will sync below -- if the comparison evidence were not scoped by
  // user_id, user-a's own unchanged re-sync would spuriously read as
  // "changed" against user-b's row.
  database.exec(`
    INSERT INTO transactions (
      id, user_id, portfolio_id, portfolio_security_id, type, status,
      trade_at, local_trade_date, quantity_decimal, unit_price_decimal,
      currency_code, fee_amount_decimal, source_type, source_reference,
      created_by_user_id, calculation_version, created_at, version
    ) VALUES ('txn-user-b', 'user-b', 'portfolio-b', 'membership-b', 'buy', 'posted',
      '2020-01-01T00:00:00Z', '2020-01-01', '999', '999', 'AUD', '999', 'csv_import',
      'import-fingerprint:sharesight-trade:trade-1', 'user-b', 1, '${now}', 1);
  `);

  const fixtures = {
    portfolios: [fakePortfolio()],
    trades: [fakeTrade({ id: "trade-1" })],
    payouts: [] as SharesightPayout[],
  };
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    "sp-1",
    fixtures,
  );
  const integration = { enabled: true as const, client: sharesightClient };
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    first.batchId,
    "brk-019-isolation-commit",
    firstBatch!.version,
  );

  // An UNCHANGED re-sync (still just "trade-1", same values) must classify
  // as already_imported against user-a's OWN committed row, never as
  // needs_decision against user-b's differently-valued row of the same
  // literal source_reference string.
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.needsDecisionRows, 0);
  assert.equal(second.alreadyImportedRows, 1);
});

// ---------------------------------------------------------------------------
// A11 (F3): the REUSED sync path re-derives its classification from the
// STORED staged rows, never from the just-completed fetch's in-memory
// transform -- mutate `import_rows.normalized_fields_json` directly between
// two identical-fetch syncs and confirm the reused path's classification
// reflects the STORED (mutated) value, not the fresh transform (which would
// still show the ORIGINAL, untouched trade).
// ---------------------------------------------------------------------------

test("BRK-019 (F3): the reused-batch classification is re-derived from STORED rows -- mutating normalized_fields_json between syncs changes the outcome, proving the fresh in-memory transform is never trusted", async () => {
  const database = await migratedDatabase();
  const fixtures = {
    portfolios: [fakePortfolio()],
    trades: [
      fakeTrade({
        id: "trade-reused-f3",
        quantityDecimal: "5",
        priceDecimal: "10",
      }),
    ],
    payouts: [] as SharesightPayout[],
  };
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    "sp-1",
    fixtures,
  );
  const integration = { enabled: true as const, client: sharesightClient };
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    first.batchId,
    "brk-019-f3-commit",
    firstBatch!.version,
  );

  // A second sync with the IDENTICAL client fixture reuses the same batch
  // (unchanged) -- matches the pre-existing BRK-014 "reused" precedent.
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.batchId, first.batchId);
  assert.equal(second.reused, true);
  assert.equal(second.needsDecisionRows, 0);
  assert.equal(second.alreadyImportedRows, 1);

  // Directly mutate the STORED staged row's price -- the fake Sharesight
  // client fixture is untouched and will keep returning the ORIGINAL price
  // ("10") on any future fetch, so this can only be reflected in a THIRD
  // sync's result if the reused path genuinely re-reads storage instead of
  // trusting the fresh transform.
  const staging = createOwnedImportStagingRepository(client);
  const storedRows = await staging.listRows("user-a", second.batchId);
  const storedRow = storedRows.find(
    (row) => row.normalizedFingerprint === "sharesight-trade:trade-reused-f3",
  );
  assert.ok(storedRow);
  const mutatedFields = { ...storedRow!.normalizedFields, costPerShare: "999" };
  database
    .prepare(
      `UPDATE import_rows SET normalized_fields_json = ? WHERE id = ? AND user_id = 'user-a'`,
    )
    .run(JSON.stringify(mutatedFields), storedRow!.id);

  const third = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-3" },
    "portfolio-a",
    { integration },
  );
  assert.equal(third.ok, true);
  if (!third.ok) return;
  assert.equal(third.batchId, first.batchId, "still the same reused batch");
  assert.equal(third.reused, true);
  assert.equal(
    third.needsDecisionRows,
    1,
    "the mutated STORED price must be re-derived and compared, not the fresh transform's original value",
  );
  assert.equal(third.alreadyImportedRows, 0);
});

// ---------------------------------------------------------------------------
// B1: decimal-string equality, no float arithmetic (pure unit tests on the
// shared comparison module).
// ---------------------------------------------------------------------------

test("BRK-019: decimal-string equality tolerates formatting differences and never uses JS float comparison", () => {
  assert.equal(decimalValuesMatch("100", "100.00"), true);
  assert.equal(decimalValuesMatch("2.50", "2.5"), true);
  assert.equal(decimalValuesMatch("0.1", "0.10"), true);
  // A value that would fail a naive `0.1 + 0.2 === 0.3` float comparison
  // must still compare correctly as decimal strings.
  assert.equal(decimalValuesMatch("0.3", "0.30"), true);
  assert.equal(decimalValuesMatch("100", "100.01"), false);
  assert.equal(decimalValuesMatch(null, null), true);
  assert.equal(decimalValuesMatch("100", null), false);
  assert.equal(decimalValuesMatch(null, "100"), false);

  const noDiff = tradeValueDifferences(
    {
      type: "buy",
      localTradeDate: "2026-08-01",
      quantityDecimal: "5",
      priceDecimal: "10.00",
      feeAmountDecimal: "0",
      currencyCode: "AUD",
    },
    {
      quantityDecimal: "5.0",
      priceDecimal: "10",
      feeAmountDecimal: "0.00",
      localTradeDate: "2026-08-01",
      type: "buy",
      currencyCode: "AUD",
    },
  );
  assert.deepEqual(
    noDiff,
    [],
    "formatting-only differences must never be reported",
  );
});

// ---------------------------------------------------------------------------
// B2: BUG-013's suppression-set-equals-commit-skip-set invariant still
// holds for the already_imported class once committed-value evidence is
// supplied -- a row that is genuinely unchanged must stay fully suppressed
// (no advisory warning, and no ROW_DIFFERS_FROM_COMMITTED_RECORD either).
// ---------------------------------------------------------------------------

const PORTFOLIOS: ImportPreviewPortfolio[] = [
  {
    id: "portfolio-1",
    name: "Main",
    homeCurrencyCode: "AUD",
    historyCompleteFrom: "2020-01-01",
  },
];

const SECURITY_CANDIDATES: ImportPreviewSecurityCandidate[] = [
  {
    id: "membership-1",
    portfolioId: "portfolio-1",
    sourceSymbol: "ABC",
    sourceExchangeAlias: null,
    sourceCurrencyCode: "AUD",
    securityId: "security-1",
  },
];

function totalsDividendRow(rowId: string): ImportReconciliationRow {
  return {
    id: rowId,
    physicalRowNumber: 2,
    rowClass: "transaction",
    fingerprint: `fp-${rowId}`,
    normalized: {
      id: rowId,
      symbol: "ABC",
      name: null,
      displaySymbol: null,
      exchange: null,
      portfolio: "Main",
      currency: "AUD",
      sharesOwned: null,
      costPerShare: null,
      commission: null,
      transactionDate: "2026-08-05",
      transactionTime: null,
      purchaseExchangeRate: null,
      type: "dividend",
      accounting: null,
      accountingExecutionIds: null,
      notes: null,
      tradeAtUtc: "2026-08-05T00:00:00Z",
      localTradeDate: "2026-08-05",
      cashEvent: null,
      frankingPerShare: null,
      totalCashDecimal: "2.50",
      totalFrankingDecimal: null,
    },
  };
}

test("BRK-019: a row already bound for the commit-time exact skip stays fully suppressed (no advisory warning, no needs_decision) once its committed value genuinely matches", () => {
  const row = totalsDividendRow("row-unchanged");
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [
      {
        portfolioSecurityId: "membership-1",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "2.50",
        frankingTotalDecimal: null,
        currencyCode: null,
      },
    ],
    existingDividendSourceReferences: new Set([
      `portfolio-1::import-fingerprint:${row.fingerprint}`,
    ]),
    committedDividendValues: new Map([
      [
        `portfolio-1::import-fingerprint:${row.fingerprint}`,
        {
          cashTotalDecimal: "2.50",
          totalFrankingDecimal: null,
          paymentDate: "2026-08-05",
          fxRateToPortfolioDecimal: null,
          currencyCode: null,
        },
      ],
    ]),
  });
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_MATCHES_EXISTING_ENTRY",
    ),
    undefined,
  );
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
    ),
    undefined,
  );
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "ROW_DIFFERS_FROM_COMMITTED_RECORD",
    ),
    undefined,
    "supplying committedDividendValues must not turn a genuine no-op into a needs_decision row",
  );
  assert.equal(preview.ready, true);
});

test("BRK-019: the SAME row escalates to needs_decision the instant its committed value genuinely differs -- the suppression set is value-aware, not identity-only", () => {
  const row = totalsDividendRow("row-changed");
  const preview = createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    existingDividendEntries: [
      {
        portfolioSecurityId: "membership-1",
        paymentDate: "2026-08-05",
        cashTotalDecimal: "9.99",
        frankingTotalDecimal: null,
        currencyCode: null,
      },
    ],
    existingDividendSourceReferences: new Set([
      `portfolio-1::import-fingerprint:${row.fingerprint}`,
    ]),
    committedDividendValues: new Map([
      [
        `portfolio-1::import-fingerprint:${row.fingerprint}`,
        {
          cashTotalDecimal: "9.99",
          totalFrankingDecimal: null,
          paymentDate: "2026-08-05",
          fxRateToPortfolioDecimal: null,
          currencyCode: null,
        },
      ],
    ]),
  });
  const issue = onlyIssue(preview.issues, "ROW_DIFFERS_FROM_COMMITTED_RECORD");
  const diff = fieldDiff(issue, "cash total");
  assert.equal(diff.committed, "9.99");
  assert.equal(diff.incoming, "2.50");
  assert.equal(preview.ready, false);
});
