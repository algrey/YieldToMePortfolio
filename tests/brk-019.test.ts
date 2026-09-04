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
import { loadImportReviewForReadyTransition } from "../app/import-ready-review-loader.ts";
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
  safeComputeDividendCashTotal,
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
  // CORRECTION ROUND (B2, BLOCKING): mirrors `app/import-actions.ts`'s own
  // fix -- the committed side must be derived via `safeComputeDividendCashTotal`
  // over the three amount-bearing columns, exactly like the incoming side,
  // never read `total_cash_decimal`/`total_franking_decimal` verbatim (that
  // reports `null` for a PER-SHARE-mode committed record, see
  // `committed-value-comparison.ts`'s `dividendValueDifferences` doc
  // comment).
  const committedDividendValues = new Map<string, CommittedDividendValues>(
    dividendRows.map((row) => [
      `${String(row.portfolio_id)}::${String(row.source_reference)}`,
      {
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
        totalFrankingDecimal: safeComputeDividendCashTotal({
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

/** CORRECTION ROUND (B1b): the preview version/readiness computation the
 * ready and accept services themselves use in production -- now the REAL
 * shared loader (`app/import-ready-review-loader.ts`'s
 * `loadImportReviewForReadyTransition`), imported directly rather than
 * hand-mirrored, so this helper can never independently drift from
 * production the way the pre-correction-round hand-typed copy did (see that
 * loader's own header comment for the reviewer-discovered divergence this
 * caused). Still deliberately narrower than `loadFullPreview` above --
 * `committedTradeValues`/`committedDividendValues`/
 * `existingDividendSourceReferences`/`existingTradeSourceReferences` stay
 * absent, by production design (see the loader's own doc comment) -- but
 * `existingDividendEntries` IS now included, matching production. */
async function currentPreviewVersion(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<string> {
  const review = await loadImportReviewForReadyTransition(
    client,
    userId,
    batchId,
  );
  if ("ok" in review) throw new Error("expected batch to exist");
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

// ---------------------------------------------------------------------------
// BRK-019 slice 1 CORRECTION ROUND
//
// F2: the DIV-004 near-match escalation is Sharesight-payout-specific -- a
// near neighbour sourced from a manual entry, a CSV import, or even a
// Sharesight TRADE (not payout) stays the plain, non-blocking
// DIVIDEND_NEAR_EXISTING_ENTRY warning; only a `sharesight-payout:`-prefixed
// neighbour escalates to ROW_DIFFERS_FROM_COMMITTED_RECORD.
// ---------------------------------------------------------------------------

function nearMatchPreview(
  existingSourceReference: string | null,
): ReturnType<typeof createImportReconciliationPreview> {
  const row = totalsDividendRow("row-nearmatch");
  return createImportReconciliationPreview({
    rows: [row],
    portfolios: PORTFOLIOS,
    securityCandidates: SECURITY_CANDIDATES,
    // Payment date 3 days after the incoming row's own 2026-08-05 -- inside
    // DIV-001's 7-day proximity window, but NOT the same date (so this
    // exercises the near-match branch, not the exact-`source_reference`-
    // match branch above -- `existingDividendSourceReferences` is
    // deliberately omitted).
    existingDividendEntries: [
      {
        portfolioSecurityId: "membership-1",
        paymentDate: "2026-08-08",
        cashTotalDecimal: "2.50",
        frankingTotalDecimal: null,
        currencyCode: null,
        sourceReference: existingSourceReference,
      },
    ],
  });
}

test("BRK-019 (F2): a near-match against a MANUAL entry (source_reference null) stays a plain DIVIDEND_NEAR_EXISTING_ENTRY warning, never escalates", () => {
  const preview = nearMatchPreview(null);
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "ROW_DIFFERS_FROM_COMMITTED_RECORD",
    ),
    undefined,
  );
  const warning = onlyIssue(preview.issues, "DIVIDEND_NEAR_EXISTING_ENTRY");
  assert.equal(warning.severity, "warning");
  assert.equal(preview.ready, true);
});

test("BRK-019 (F2): a near-match against a CSV-sourced entry (import-fingerprint:csv-...) stays a plain DIVIDEND_NEAR_EXISTING_ENTRY warning, never escalates", () => {
  const preview = nearMatchPreview("import-fingerprint:csv-abc123");
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "ROW_DIFFERS_FROM_COMMITTED_RECORD",
    ),
    undefined,
  );
  const warning = onlyIssue(preview.issues, "DIVIDEND_NEAR_EXISTING_ENTRY");
  assert.equal(warning.severity, "warning");
  assert.equal(preview.ready, true);
});

test("BRK-019 (F2): a near-match against a Sharesight TRADE-sourced entry (import-fingerprint:sharesight-trade:...) stays a plain DIVIDEND_NEAR_EXISTING_ENTRY warning, never escalates -- only the sharesight-payout: prefix qualifies", () => {
  const preview = nearMatchPreview(
    "import-fingerprint:sharesight-trade:trade-1",
  );
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "ROW_DIFFERS_FROM_COMMITTED_RECORD",
    ),
    undefined,
  );
  const warning = onlyIssue(preview.issues, "DIVIDEND_NEAR_EXISTING_ENTRY");
  assert.equal(warning.severity, "warning");
  assert.equal(preview.ready, true);
});

test("BRK-019 (F2): a near-match against a Sharesight PAYOUT-sourced entry (import-fingerprint:sharesight-payout:...) escalates to ROW_DIFFERS_FROM_COMMITTED_RECORD, replacing the plain warning", () => {
  const preview = nearMatchPreview(
    "import-fingerprint:sharesight-payout:sp-1:holding-1:2026-08-08",
  );
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "DIVIDEND_NEAR_EXISTING_ENTRY",
    ),
    undefined,
    "the escalation must REPLACE the plain warning, not add to it",
  );
  const issue = onlyIssue(preview.issues, "ROW_DIFFERS_FROM_COMMITTED_RECORD");
  assert.equal(issue.severity, "error");
  assert.equal(preview.ready, false);
});

// ---------------------------------------------------------------------------
// B2: an identical PER-SHARE CSV dividend re-upload (same fingerprint, same
// per-share amount) must never report a false ROW_DIFFERS_FROM_COMMITTED_RECORD
// -- the committed side's comparable total must be DERIVED
// (`safeComputeDividendCashTotal`) from the stored per-share columns, never
// read from the (NULL, in per-share mode) raw totals columns. A genuinely
// CHANGED per-share amount must still be caught.
// ---------------------------------------------------------------------------

function csvDividendRowJson(overrides: {
  id: string;
  dividendPerShare: string;
  paymentDate: string;
}): string {
  return JSON.stringify({
    id: overrides.id,
    symbol: "ABC",
    name: "Alpha",
    displaySymbol: null,
    exchange: "ASX",
    portfolio: "Main",
    currency: "AUD",
    sharesOwned: "5",
    costPerShare: overrides.dividendPerShare,
    commission: "0",
    transactionDate: overrides.paymentDate,
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
    totalCashDecimal: null,
    totalFrankingDecimal: null,
  });
}

function stageCsvDividendBatch(
  database: DatabaseSync,
  batchId: string,
  rowId: string,
  fingerprint: string,
  dividendPerShare: string,
  paymentDate: string,
): void {
  const now = "2026-08-20T00:00:00Z";
  database
    .prepare(
      `INSERT INTO import_batches (
         id, user_id, target_portfolio_id, parser_format, parser_version, filename,
         byte_size, file_sha256, status, created_at, updated_at, version
       ) VALUES (?, 'user-a', 'portfolio-a', 'strict-versioned-csv', ?, ?, 100, ?, 'parsed', ?, ?, 1)`,
    )
    .run(
      batchId,
      SUPPORTED_IMPORT_PARSER_VERSION,
      `${batchId}.csv`,
      `file-${batchId}`,
      now,
      now,
    );
  database
    .prepare(
      `INSERT INTO import_rows (
         id, user_id, batch_id, physical_row_number, row_class,
         original_fields_json, normalized_fields_json, normalized_fingerprint,
         validation_status, target_portfolio_id, target_portfolio_security_id,
         commit_status, created_at, updated_at, version
       ) VALUES (?, 'user-a', ?, 2, 'transaction', '[]', ?, ?, 'valid',
         'portfolio-a', 'membership-a', 'staged', ?, ?, 1)`,
    )
    .run(
      rowId,
      batchId,
      csvDividendRowJson({ id: rowId, dividendPerShare, paymentDate }),
      fingerprint,
      now,
      now,
    );
}

test("BRK-019 (B2): an identical PER-SHARE CSV dividend re-upload never reports a false needs_decision -- the committed side is derived, not read verbatim", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);

  stageCsvDividendBatch(
    database,
    "div-b2-batch-1",
    "div-b2-row-1",
    "div-b2-fingerprint-shared",
    "0.50",
    "2026-08-05",
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    "div-b2-batch-1",
    "div-b2-commit-1",
    1,
  );

  // Confirm the committed record is genuinely PER-SHARE-mode (the totals
  // columns are NULL) -- otherwise this test would not exercise B2 at all.
  const committed = await client.all<{
    total_cash_decimal: string | null;
    shares_decimal: string;
    dividend_per_share_decimal: string;
  }>(
    `SELECT total_cash_decimal, shares_decimal, dividend_per_share_decimal
       FROM dividend_manual_records
      WHERE user_id = 'user-a' AND source_reference = 'import-fingerprint:div-b2-fingerprint-shared'`,
    [],
  );
  assert.equal(committed.length, 1);
  assert.equal(committed[0]!.total_cash_decimal, null);

  // Re-upload: SAME fingerprint (same identity), SAME per-share amount.
  stageCsvDividendBatch(
    database,
    "div-b2-batch-2",
    "div-b2-row-2",
    "div-b2-fingerprint-shared",
    "0.50",
    "2026-08-05",
  );
  const preview = await loadFullPreview(client, "user-a", "div-b2-batch-2");
  assert.equal(
    preview.issues.find(
      (issue) => issue.code === "ROW_DIFFERS_FROM_COMMITTED_RECORD",
    ),
    undefined,
    "an identical per-share re-upload must never report a false needs_decision",
  );
  assert.equal(preview.ready, true);

  const commitResult = await commitBatchAndReturnResult(
    client,
    "user-a",
    "div-b2-batch-2",
    "div-b2-commit-2",
    1,
  );
  assert.equal(commitResult.committedRows, 0);
  assert.equal(commitResult.skippedRows, 1);
  assert.equal(
    commitResult.needsDecisionRows,
    0,
    "an identical per-share re-upload must skip as a true no-op, never as needs_decision",
  );
  const persistedIssues = await client.all(
    `SELECT id FROM import_issues WHERE batch_id = 'div-b2-batch-2' AND row_id = 'div-b2-row-2'`,
    [],
  );
  assert.equal(
    persistedIssues.length,
    0,
    "no import_issues row may exist for a genuinely unchanged re-upload",
  );
});

test("BRK-019 (B2): a PER-SHARE CSV dividend re-upload with a CHANGED per-share amount is still caught as exactly one needs_decision row", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);

  stageCsvDividendBatch(
    database,
    "div-b2c-batch-1",
    "div-b2c-row-1",
    "div-b2c-fingerprint-shared",
    "0.50",
    "2026-08-05",
  );
  await commitBatchAndReturnResult(
    client,
    "user-a",
    "div-b2c-batch-1",
    "div-b2c-commit-1",
    1,
  );

  // Re-upload: SAME fingerprint, CHANGED per-share amount.
  stageCsvDividendBatch(
    database,
    "div-b2c-batch-2",
    "div-b2c-row-2",
    "div-b2c-fingerprint-shared",
    "0.60",
    "2026-08-05",
  );
  const commitResult = await commitBatchAndReturnResult(
    client,
    "user-a",
    "div-b2c-batch-2",
    "div-b2c-commit-2",
    1,
  );
  assert.equal(commitResult.committedRows, 0);
  assert.equal(commitResult.skippedRows, 1);
  assert.equal(commitResult.needsDecisionRows, 1);

  const issues = await client.all<{ code: string; message: string }>(
    `SELECT code, message FROM import_issues
      WHERE batch_id = 'div-b2c-batch-2' AND row_id = 'div-b2c-row-2'`,
    [],
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0]!.code, "ROW_DIFFERS_FROM_COMMITTED_RECORD");
  assert.match(issues[0]!.message, /cash total/);

  const manualRecordCount = await client.all<{ count: number }>(
    `SELECT COUNT(*) as count FROM dividend_manual_records
      WHERE user_id = 'user-a' AND source_reference = 'import-fingerprint:div-b2c-fingerprint-shared'`,
    [],
  );
  assert.equal(
    manualRecordCount[0]!.count,
    1,
    "the CSV route must never double-write for a shared fingerprint",
  );
});

// ---------------------------------------------------------------------------
// B1: end-to-end commit-through drill -- sync -> commit -> re-sync (SAME
// amount, paidOnDate shifted) -> Accept must never double-write, must be
// visibly blocked in the review's derived state, and excluding the row must
// let the rest of the batch commit.
// ---------------------------------------------------------------------------

test("BRK-019 CORRECTION ROUND (B1): a paid-date-shifted re-sync is caught end-to-end -- exactly one dividend_manual_records row survives, the sync/commit results agree on needs_decision, Accept is blocked until the row is excluded, and excluding it commits the rest", async () => {
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
          id: "payout-b1-drill",
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
    "brk-019-b1-drill-commit-1",
    firstBatch!.version,
  );

  // Re-sync: SAME payout id, SAME amount, paid-on-date shifted by 3 days --
  // within DIV-001/DIV-004's 7-day proximity window. The identity key
  // (`sharesight-payout:<portfolio>:<holding>:<paidOnDate>`) is NEW, so this
  // can never hit commit's exact-match lookup.
  const correctedClient = fakeSharesightClient({
    trades: [],
    payouts: [
      fakePayout({
        id: "payout-b1-drill",
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
  // B1c: the sync result itself must classify this as needing a decision,
  // never as a genuinely new payout.
  assert.equal(second.needsDecisionRows, 1);
  assert.equal(second.newRows, 0);

  const secondBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    second.batchId,
  );

  // "Accept blocked in the review's derived state": the escalation must be
  // visible and blocking BEFORE any commit is attempted, via the REAL
  // ready-service path every Accept/Mark-Ready flow goes through -- not just
  // the full page's own (already-correct) preview.
  const previewVersion = await currentPreviewVersion(
    client,
    "user-a",
    second.batchId,
  );
  const blockedReady = await markImportReadyWithContext(
    { client, userId: "user-a" },
    second.batchId,
    {
      expectedVersion: secondBatch!.version,
      expectedPreviewVersion: previewVersion,
    },
  );
  assert.equal(
    blockedReady.ok,
    false,
    "the ready transition (and therefore Accept) must be blocked while the paid-date correction is unresolved",
  );

  // The escalation must now also be PERSISTED (not just computed) -- this is
  // what lets the review UI's `blockedRowIssues`/`acceptDisabled` (persisted-
  // issue-driven, BRK-009C) show the block pre-emptively.
  const persistedIssues = await client.all<{ code: string; row_id: string }>(
    `SELECT code, row_id FROM import_issues
      WHERE batch_id = ? AND code = 'ROW_DIFFERS_FROM_COMMITTED_RECORD'`,
    [second.batchId],
  );
  assert.equal(persistedIssues.length, 1);
  const blockedRowId = persistedIssues[0]!.row_id;

  // Excluding the row clears the block; the batch then reaches ready and
  // commits with zero NEW dividend_manual_records rows for this identity.
  const previewVersionForExclude = await currentPreviewVersion(
    client,
    "user-a",
    second.batchId,
  );
  const excluded = await setImportRowExclusionWithContext(
    { client, userId: "user-a", requestId: "exclude-req" },
    second.batchId,
    {
      action: "exclude",
      target: { kind: "rowIds", rowIds: [blockedRowId] },
      expectedVersion: secondBatch!.version,
      expectedPreviewVersion: previewVersionForExclude,
    },
  );
  assert.equal(excluded.ok, true);

  const secondBatchAfterExclude = await createOwnedImportStagingRepository(
    client,
  ).get("user-a", second.batchId);
  const commitResult = await commitBatchAndReturnResult(
    client,
    "user-a",
    second.batchId,
    "brk-019-b1-drill-commit-2",
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

  // The financial-safety property this whole drill exists to prove: exactly
  // ONE dividend_manual_records row survives for this holding, never two.
  const manualRecords = await client.all<{
    id: string;
    payment_date: string;
    source_reference: string;
  }>(
    `SELECT id, payment_date, source_reference FROM dividend_manual_records
      WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a'
        AND portfolio_security_id = 'membership-a'
        AND superseded_by_record_id IS NULL`,
    [],
  );
  assert.equal(
    manualRecords.length,
    1,
    "the paid-date correction must never double-write the distribution",
  );
  assert.equal(manualRecords[0]!.payment_date, "2026-08-05");
  assert.equal(
    manualRecords[0]!.source_reference,
    "import-fingerprint:sharesight-payout:sp-1:holding-1:2026-08-05",
  );
});

// ---------------------------------------------------------------------------
// B1a: commit's OWN independent near-match backstop still fires even when
// the ready-time check is bypassed entirely (a resumed old batch, or a
// direct commit call that never went through markImportReadyWithContext) --
// this is the defence-in-depth layer, not a substitute for the ready-time
// block above.
// ---------------------------------------------------------------------------

test("BRK-019 CORRECTION ROUND (B1a): commit's own near-match backstop skips a paid-date-shifted row even if the ready-time check never ran, and persists the SAME issue commit's exact-match backstop uses", async () => {
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
          id: "payout-b1a-backstop",
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
    "brk-019-b1a-backstop-commit-1",
    firstBatch!.version,
  );

  const correctedClient = fakeSharesightClient({
    trades: [],
    payouts: [
      fakePayout({
        id: "payout-b1a-backstop",
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

  // Force the batch straight to `ready` at the DB level -- bypassing
  // `markImportReadyWithContext` entirely, simulating a batch that reached
  // `ready` before this correction round's ready-time check existed (or any
  // other path that skips it), so the assertion below exercises commit's OWN
  // independent re-derivation, never the ready-time block from the drill
  // above.
  database.exec(
    `UPDATE import_batches SET status = 'ready' WHERE id = '${second.batchId}'`,
  );
  const secondBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    second.batchId,
  );
  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", second.batchId);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: secondBatch!.version,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "brk-019-b1a-backstop-commit-2",
    confirmation: true,
    requestId: "brk-019-b1a-backstop-commit-2-request",
  };
  let commitResult = await commitRepo.commit(
    "user-a",
    second.batchId,
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
      second.batchId,
      commitInput,
    );
  }
  assert.equal(commitResult.ok, true);
  if (!commitResult.ok) return;
  assert.equal(commitResult.status, "committed");
  assert.equal(commitResult.committedRows, 0);
  assert.equal(commitResult.skippedRows, 1);
  assert.equal(commitResult.needsDecisionRows, 1);

  const manualRecords = await client.all<{ id: string }>(
    `SELECT id FROM dividend_manual_records
      WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a'
        AND portfolio_security_id = 'membership-a'
        AND superseded_by_record_id IS NULL`,
    [],
  );
  assert.equal(
    manualRecords.length,
    1,
    "commit's own backstop must never double-write even when the ready-time check is bypassed",
  );

  const issues = await client.all<{ code: string }>(
    `SELECT code FROM import_issues
      WHERE batch_id = ? AND code = 'ROW_DIFFERS_FROM_COMMITTED_RECORD'`,
    [second.batchId],
  );
  assert.equal(issues.length, 1);
});
