import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  linkSharesightPortfolioWithContext,
  runSharesightSyncWithContext,
} from "../app/sharesight-sync-service.ts";
import { resolveSharesightBatchSecuritiesWithContext } from "../app/security-resolution-service.ts";
import {
  acceptImportWithContext,
  type ImportAcceptActionSuccess,
} from "../app/import-accept-service.ts";
import { createImportAcceptPost } from "../app/import-accept-route.ts";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import {
  createOwnedImportMappingDecisionRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createOwnedSecurityResolutionRepository,
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import { parseStrictVersionedCsvImport } from "../domain/imports/index.ts";
import type {
  SharesightClient,
  SharesightPayout,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
} from "../domain/sharesight/index.ts";

// BRK-009B: (1) automatic security resolution/auto-creation for
// `sharesight_sync` batches, replacing per-security manual verification, (2)
// a single atomic "accept" action (mark-ready + commit). See TASKS.md's
// BRK-009B entry for the full ruling set. CSV batches are entirely out of
// scope for (1) -- see the dedicated test below.

// ---------------------------------------------------------------------------
// Fixtures
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
           ('portfolio-a2', 'user-a', 'A2', 'Second', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-18', '2026-08-18', 1),
           ('portfolio-b', 'user-b', 'B', 'Other', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-18', '2026-08-18', 1);
  `);
  return database;
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

function fakeTrade(overrides: Partial<SharesightTrade> = {}): SharesightTrade {
  return {
    id: "trade-1",
    portfolioId: "sp-1",
    holdingId: "holding-1",
    instrumentCode: "IXJ",
    marketCode: "ASX",
    sharesightInstrumentId: "4242",
    instrumentName: "iShares Global Healthcare (Synthetic)",
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
    sharesightInstrumentId: "4242",
    symbol: "IXJ",
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
  };
}

async function linkedFixture(
  database: DatabaseSync,
  userId: string,
  portfolioId: string,
  fixtures: Parameters<typeof fakeSharesightClient>[0] = {
    portfolios: [fakePortfolio()],
  },
): Promise<{ client: SqlClient; sharesightClient: SharesightClient }> {
  const client = createSqliteSqlClient(database);
  const sharesightClient = fakeSharesightClient(fixtures);
  const linked = await linkSharesightPortfolioWithContext(
    { client, userId, requestId: "link-req" },
    portfolioId,
    { sharesightPortfolioId: "sp-1" },
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(linked.ok, true);
  return { client, sharesightClient };
}

// Repeatedly calls the atomic accept action until the batch is fully
// `committed` -- `DEFAULT_CHUNK_SIZE` (import-commit.ts) commits at most 2
// rows per call, so a batch with more rows needs more than one accept call
// to finish; this mirrors that "resumable across calls" contract and the
// task's own "idempotent re-accept" requirement (a second call on an
// already-committed batch must converge on the SAME result, never
// double-commit).
async function acceptUntilCommitted(
  client: SqlClient,
  userId: string,
  requestId: string,
  batchId: string,
): Promise<ImportAcceptActionSuccess> {
  let result = await acceptImportWithContext(
    { client, userId, requestId },
    batchId,
  );
  for (
    let attempt = 0;
    attempt < 10 && (!result.ok || result.commit.status !== "committed");
    attempt += 1
  ) {
    assert.equal(result.ok, true, "expected accept to keep succeeding");
    result = await acceptImportWithContext(
      { client, userId, requestId },
      batchId,
    );
  }
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.commit.status, "committed");
  return result;
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

// ---------------------------------------------------------------------------
// End-to-end: zero securities -> auto-resolve/create -> ready -> accept
// ---------------------------------------------------------------------------

test("BRK-009B: a zero-security sharesight sync auto-resolves and auto-creates from Sharesight metadata, reaches ready with zero manual verification, and accept commits atomically with holdings and income present", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [fakeTrade({ id: "trade-e2e" })],
      payouts: [fakePayout({ id: "payout-e2e" })],
    },
  );

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  // No securities existed before this sync -- confirm the auto-create path
  // actually ran (not a pre-seeded fixture masking the behaviour under test).
  const securitiesBefore = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(
    securitiesBefore,
    1,
    "the sync itself auto-created exactly one security from zero",
  );

  const security = database
    .prepare(
      `SELECT id, canonical_name, primary_currency_code FROM securities LIMIT 1`,
    )
    .get() as {
    id: string;
    canonical_name: string;
    primary_currency_code: string;
  };
  assert.equal(
    security.canonical_name,
    "iShares Global Healthcare (Synthetic)",
    "canonical name comes from Sharesight's instrument name when present",
  );
  assert.equal(security.primary_currency_code, "AUD");

  const identifiers = database
    .prepare(
      `SELECT scheme, value, source FROM security_identifiers WHERE security_id = ? ORDER BY scheme`,
    )
    .all(security.id) as { scheme: string; value: string; source: string }[];
  assert.deepEqual(
    identifiers.map((row) => `${row.scheme}:${row.value}:${row.source}`).sort(),
    ["sharesight_instrument:4242:sharesight", "ticker:IXJ:sharesight"],
  );

  const mappingCount = (
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM security_provider_mappings WHERE security_id = ?`,
      )
      .get(security.id) as { n: number }
  ).n;
  assert.equal(
    mappingCount,
    0,
    "auto-created securities must never write a security_provider_mappings row",
  );

  const auditRow = database
    .prepare(
      `SELECT action FROM audit_events WHERE action = 'sharesight.security.auto_resolve' LIMIT 1`,
    )
    .get() as { action: string } | undefined;
  assert.ok(auditRow, "expected an owner-attributed audit event");

  const linked = database
    .prepare(
      `SELECT id, status FROM portfolio_securities WHERE user_id = 'user-a' AND security_id = ?`,
    )
    .get(security.id) as { id: string; status: string };
  assert.equal(linked.status, "held");

  // Ready with ZERO manual steps: no verify/attest call anywhere in this
  // test before accept.
  const commit = await acceptUntilCommitted(
    client,
    "user-a",
    "accept-req",
    synced.batchId,
  );
  assert.equal(commit.commit.committedRows > 0, true);

  const trade = database
    .prepare(
      `SELECT status, type, quantity_decimal FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = ?`,
    )
    .get(linked.id) as
    { status: string; type: string; quantity_decimal: string } | undefined;
  assert.ok(trade, "expected a posted ledger transaction (holdings present)");
  assert.equal(trade?.status, "posted");
  assert.equal(trade?.quantity_decimal, "5");

  const dividend = database
    .prepare(
      `SELECT total_cash_decimal FROM dividend_manual_records
       WHERE user_id = 'user-a' AND portfolio_security_id = ?`,
    )
    .get(linked.id) as { total_cash_decimal: string } | undefined;
  assert.ok(dividend, "expected a dividend record (income present)");
  assert.equal(dividend?.total_cash_decimal, "2.50");

  // Idempotent re-accept: calling accept again on the now-committed batch
  // must return the same commit result, never double-commit.
  const reAccepted = await acceptImportWithContext(
    { client, userId: "user-a", requestId: "accept-req-2" },
    synced.batchId,
  );
  assert.equal(reAccepted.ok, true);
  if (!reAccepted.ok) return;
  assert.equal(reAccepted.commit.status, "committed");
  assert.equal(reAccepted.commit.idempotent, true);
  const tradeCountAfterReaccept = (
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE user_id = 'user-a' AND portfolio_security_id = ?`,
      )
      .get(linked.id) as { n: number }
  ).n;
  assert.equal(
    tradeCountAfterReaccept,
    1,
    "re-accept must never create a second transaction",
  );

  // Reversal round trip.
  const committedBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    synced.batchId,
  );
  const reversalRepo = createOwnedImportReversalRepository(client);
  let reversed = await reversalRepo.reverse("user-a", synced.batchId, {
    expectedVersion: committedBatch!.version,
    idempotencyKey: "brk-009b-reverse",
    confirmation: true,
    requestId: "brk-009b-reverse-request",
  });
  for (
    let attempt = 0;
    attempt < 10 && (!reversed.ok || reversed.status !== "reversed");
    attempt += 1
  ) {
    assert.equal(reversed.ok, true);
    reversed = await reversalRepo.reverse("user-a", synced.batchId, {
      expectedVersion: committedBatch!.version,
      idempotencyKey: "brk-009b-reverse",
      confirmation: true,
      requestId: "brk-009b-reverse-request",
    });
  }
  assert.equal(reversed.ok, true);
  if (reversed.ok) assert.equal(reversed.status, "reversed");

  const reversedTrade = database
    .prepare(
      `SELECT status FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = ?
         AND type = 'buy' AND reverses_transaction_id IS NULL`,
    )
    .get(linked.id) as { status: string } | undefined;
  assert.equal(reversedTrade?.status, "reversed");
});

// ---------------------------------------------------------------------------
// Same-user dedupe (F2) / conflict / tier precedence / F3 fallback
// ---------------------------------------------------------------------------

test("BRK-009B: an existing attested security with agreeing ticker+currency and no exchange evidence on either side links via the same-user fallback instead of duplicating", async () => {
  const database = await migratedDatabase();
  // Pre-existing OWNER-ATTESTED security for ticker "IXJ"/AUD, no exchange
  // evidence at all -- the exact ambiguity F2 exists to resolve. Linked in a
  // DIFFERENT portfolio (`portfolio-a2`) than the one this sync targets:
  // `portfolio_securities_resolved_unique` allows only one row per
  // (portfolio, security), so this is the same-user, cross-portfolio shape
  // the F2 dedupe rule actually targets (the owner already knows this
  // security somewhere in their own data; this sync is a DIFFERENT
  // portfolio's first encounter with it).
  database.exec(`
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('sec-existing', 'equity', 'AUD', 'iShares Global Healthcare', 'active', '2026-08-18', '2026-08-18');
    INSERT INTO security_identifiers (id, security_id, scheme, value, exchange_id, valid_from, valid_to, source)
    VALUES ('id-existing', 'sec-existing', 'ticker', 'IXJ', NULL, '2026-08-18', NULL, 'owner_attested');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-existing', 'user-a', 'portfolio-a2', 'sec-existing', 'IXJ', NULL, 'AUD', 'held', '2026-08-18', '2026-08-18');
  `);

  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      // No sharesightInstrumentId/isin at all on this trade -- pure
      // ticker+currency evidence, exactly the same-user fallback path.
      trades: [
        fakeTrade({
          id: "trade-dedupe",
          sharesightInstrumentId: null,
          instrumentName: null,
        }),
      ],
      payouts: [],
    },
  );
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(securityCount, 1, "no duplicate security was created");

  const linked = database
    .prepare(
      `SELECT security_id FROM portfolio_securities WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a' AND source_symbol = 'IXJ' AND source_exchange_alias = 'ASX'`,
    )
    .get() as { security_id: string } | undefined;
  assert.equal(linked?.security_id, "sec-existing");
});

test("BRK-009B: exchange evidence that disagrees on both sides stages a blocking SECURITY_RESOLUTION_CONFLICT issue instead of auto-resolving", async () => {
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('sec-existing', 'equity', 'AUD', 'iShares Global Healthcare', 'active', '2026-08-18', '2026-08-18');
    INSERT INTO security_identifiers (id, security_id, scheme, value, exchange_id, valid_from, valid_to, source)
    VALUES ('id-existing', 'sec-existing', 'ticker', 'IXJ', NULL, '2026-08-18', NULL, 'owner_attested');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-existing', 'user-a', 'portfolio-a', 'sec-existing', 'IXJ', 'NZX', 'AUD', 'held', '2026-08-18', '2026-08-18');
  `);

  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [
        fakeTrade({
          id: "trade-conflict",
          marketCode: "ASX",
          sharesightInstrumentId: null,
          instrumentName: null,
        }),
      ],
      payouts: [],
    },
  );
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const staging = createOwnedImportStagingRepository(client);
  const issues = await staging.listIssues("user-a", synced.batchId);
  const conflictIssues = issues.filter(
    (issue) => issue.code === "SECURITY_RESOLUTION_CONFLICT",
  );
  assert.equal(conflictIssues.length, 1);
  assert.equal(conflictIssues[0]?.severity, "error");
  assert.equal(conflictIssues[0]?.resolvedAt, null);

  const readied = await markImportReadyWithContext(
    { client, userId: "user-a" },
    synced.batchId,
    {
      expectedVersion: (await staging.get("user-a", synced.batchId))!.version,
      expectedPreviewVersion: await currentPreviewVersion(
        client,
        "user-a",
        synced.batchId,
      ),
    },
  );
  assert.equal(readied.ok, false, "a resolver conflict must block readiness");

  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(
    securityCount,
    1,
    "a conflicted candidate must never auto-create a second security",
  );
});

test("BRK-009B: the sharesight_instrument tier beats a historical ticker alias (Z1P renamed to ZIP)", async () => {
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('sec-zip', 'equity', 'AUD', 'Zip Co', 'active', '2026-08-18', '2026-08-18');
    INSERT INTO security_identifiers (id, security_id, scheme, value, exchange_id, valid_from, valid_to, source)
    VALUES ('id-zip-active', 'sec-zip', 'ticker', 'ZIP', NULL, '2020-01-01', NULL, 'sharesight'),
           ('id-zip-historical', 'sec-zip', 'ticker', 'Z1P', NULL, '2015-01-01', '2020-01-01', 'sharesight'),
           ('id-zip-instrument', 'sec-zip', 'sharesight_instrument', '999', NULL, '2020-01-01', NULL, 'sharesight');
  `);

  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      // Reports the OLD ticker text but the SAME instrument id -- the
      // instrument-id tier must win over (agree with) the historical ticker
      // alias, resolving to the SAME security either way, never a conflict.
      trades: [
        fakeTrade({
          id: "trade-z1p",
          instrumentCode: "Z1P",
          sharesightInstrumentId: "999",
          instrumentName: null,
        }),
      ],
      payouts: [],
    },
  );
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const linked = database
    .prepare(
      `SELECT security_id FROM portfolio_securities WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a' AND source_symbol = 'Z1P'`,
    )
    .get() as { security_id: string } | undefined;
  assert.equal(linked?.security_id, "sec-zip");

  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(securityCount, 1, "no duplicate security created");
});

test("BRK-009B: a metadata-less row (no sharesightInstrumentId) still resolves through the ticker+currency fallback", async () => {
  const database = await migratedDatabase();
  // Linked in a DIFFERENT portfolio than this sync targets -- see the
  // same-user fallback test above for why (`portfolio_securities_resolved_unique`).
  database.exec(`
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('sec-existing', 'equity', 'AUD', 'iShares Global Healthcare', 'active', '2026-08-18', '2026-08-18');
    INSERT INTO security_identifiers (id, security_id, scheme, value, exchange_id, valid_from, valid_to, source)
    VALUES ('id-existing', 'sec-existing', 'ticker', 'IXJ', NULL, '2026-08-18', NULL, 'sharesight');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-existing', 'user-a', 'portfolio-a2', 'sec-existing', 'IXJ', NULL, 'AUD', 'held', '2026-08-18', '2026-08-18');
  `);

  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      // F3: pre-BRK-009A-shaped row -- no instrument id, name, or isin at
      // all, exactly what every batch staged before that task looked like.
      trades: [
        fakeTrade({
          id: "trade-f3",
          sharesightInstrumentId: null,
          instrumentName: null,
          isin: null,
        }),
      ],
      payouts: [],
    },
  );
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const linked = database
    .prepare(
      `SELECT security_id FROM portfolio_securities WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a' AND source_symbol = 'IXJ' AND source_exchange_alias = 'ASX'`,
    )
    .get() as { security_id: string } | undefined;
  assert.equal(linked?.security_id, "sec-existing");
});

test("BRK-009B: an already-linked candidate is found case-insensitively by symbol, matching reconciliation's own candidate-match rule (F5)", async () => {
  const database = await migratedDatabase();
  // A pre-existing candidate stored with a LOWER-case symbol (e.g. entered
  // through a path that didn't upper-normalize it) -- Sharesight always
  // reports "IXJ" upper-case, so this proves `existingCandidateRow` finds it
  // regardless of stored case, exactly like `domain/imports/reconciliation.ts`'s
  // own `normalized()` (trim + lower-case) candidate match already does.
  database.exec(`
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('sec-lower', 'equity', 'AUD', 'iShares Global Healthcare', 'active', '2026-08-18', '2026-08-18');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-lower', 'user-a', 'portfolio-a', 'sec-lower', 'ixj', 'ASX', 'AUD', 'held', '2026-08-18', '2026-08-18');
  `);

  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [
        fakeTrade({
          id: "trade-f5",
          sharesightInstrumentId: null,
          instrumentName: null,
        }),
      ],
      payouts: [],
    },
  );
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const portfolioSecuritiesCount = (
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM portfolio_securities WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a'`,
      )
      .get() as { n: number }
  ).n;
  assert.equal(
    portfolioSecuritiesCount,
    1,
    "the lower-case-stored candidate must be found, not duplicated under a new upper-case row",
  );
  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(securityCount, 1, "no duplicate security created");
});

// ---------------------------------------------------------------------------
// CSV batches unaffected
// ---------------------------------------------------------------------------

test("BRK-009B: a CSV batch is completely unaffected -- resolution never runs and SECURITY_MAPPING_REQUIRED is still emitted for an unresolved candidate", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const csv = [
    "Id,Symbol,Name,Display Symbol,Exchange,Portfolio,Currency,Shares Owned,Cost Per Share,Commission,Transaction Date,Transaction Time,Purchase Exchange Rate,Type,Accounting,Accounting Execution Ids,Notes",
    '"1","IXJ","","","ASX","Main","AUD","5","10","0","2026-08-01 GMT+1000","10:00:00","0","Buy","","",""',
  ].join("\n");
  const parsed = await parseStrictVersionedCsvImport(csv, {
    maxBytes: 10_000_000,
    maxRows: 1000,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const staging = createOwnedImportStagingRepository(client);
  const started = await staging.startUpload("user-a", {
    targetPortfolioId: "portfolio-a",
    parserFormat: "strict-versioned-csv",
    parserVersion: parsed.parserVersion,
    filename: "sample.csv",
    byteSize: csv.length,
    fileSha256: parsed.fileFingerprint,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const recorded = await staging.recordParseResult("user-a", started.batch.id, {
    expectedVersion: started.batch.version,
    parseResult: parsed,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;

  const resolveResult = await resolveSharesightBatchSecuritiesWithContext(
    { client, userId: "user-a", requestId: "req" },
    started.batch.id,
  );
  assert.deepEqual(resolveResult, {
    ok: true,
    resolvedCount: 0,
    createdCount: 0,
    conflictCount: 0,
  });

  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(
    securityCount,
    0,
    "CSV batches must never auto-create a security",
  );

  const previewVersion = await currentPreviewVersion(
    client,
    "user-a",
    started.batch.id,
  );
  const rows = await staging.listRows("user-a", started.batch.id);
  const portfolios =
    await createOwnedPortfolioRepository(client).list("user-a");
  const built = buildImportReviewPreview({
    batch: (await staging.get("user-a", started.batch.id))!,
    rows,
    issues: await staging.listIssues("user-a", started.batch.id),
    mappings: [],
    portfolios: portfolios.map((portfolio) => ({
      id: portfolio.id,
      name: portfolio.name,
      homeCurrencyCode: portfolio.homeCurrencyCode,
      historyCompleteFrom: portfolio.historyCompleteFrom,
    })),
    securityCandidates: [],
  });
  assert.ok(previewVersion.length > 0);
  const hasSecurityMappingRequired = built.preview.issues.some(
    (issue) => issue.code === "SECURITY_MAPPING_REQUIRED",
  );
  assert.equal(
    hasSecurityMappingRequired,
    true,
    "CSV batches keep the pre-existing candidate flow -- unresolved securities still block",
  );
});

// ---------------------------------------------------------------------------
// Concurrency, ownership, CSRF, staleness
// ---------------------------------------------------------------------------

test("BRK-009B: two concurrent syncs for the same instrument converge on one created security, never a duplicate", async () => {
  // node:sqlite's synchronous engine means two `client.batch()` calls
  // cannot truly interleave mid-transaction, but issuing both
  // `resolveAndLink` calls before either is awaited still exercises the
  // repository's re-read-after-attempt path exactly as a second sync
  // arriving moments after the first would (mirrors IMP-009's identical
  // "concurrent attest" drill).
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const repository = createOwnedSecurityResolutionRepository(client);
  const identity = {
    symbol: "IXJ",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
    sharesightInstrumentId: "4242",
    isin: null,
    instrumentName: "iShares Global Healthcare (Synthetic)",
  };

  const [first, second] = await Promise.all([
    repository.resolveAndLink("user-a", identity, {
      portfolioId: "portfolio-a",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    }),
    repository.resolveAndLink("user-a", identity, {
      portfolioId: "portfolio-a2",
      sourceSymbol: "IXJ",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.equal(first.securityId, second.securityId);

  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(securityCount, 1, "no duplicate canonical security created");

  const instrumentIdentifierCount = (
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM security_identifiers WHERE scheme = 'sharesight_instrument' AND value = '4242' AND valid_to IS NULL`,
      )
      .get() as { n: number }
  ).n;
  assert.equal(instrumentIdentifierCount, 1);
});

// ---------------------------------------------------------------------------
// 2026-08-18 review round: B1/B2/B3 currency-blind-merge fixes, F1/F2/F4
// follow-up rulings.
// ---------------------------------------------------------------------------

test("BRK-009B: a ticker-text collision with a DIFFERENT currency creates a second, distinct security -- never a merge, never a permanent conflict", async () => {
  // Reviewer drill (B1): AGL/ASX/AUD then metadata-less AGL/NYSE/USD used to
  // resolve to the SAME (AUD) security, so a USD row would have committed
  // against an AUD security. Both resolutions must now succeed
  // independently, each creating its OWN security.
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const repository = createOwnedSecurityResolutionRepository(client);

  const first = await repository.resolveAndLink(
    "user-a",
    {
      symbol: "AGL",
      exchangeAlias: "ASX",
      currencyCode: "AUD",
      sharesightInstrumentId: null,
      isin: null,
      instrumentName: null,
    },
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "AGL",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.outcome, "created");

  const second = await repository.resolveAndLink(
    "user-a",
    {
      symbol: "AGL",
      exchangeAlias: "NYSE",
      currencyCode: "USD",
      sharesightInstrumentId: null,
      isin: null,
      instrumentName: null,
    },
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "AGL",
      sourceExchangeAlias: "NYSE",
      sourceCurrencyCode: "USD",
    },
  );
  assert.equal(
    second.ok,
    true,
    "a genuinely distinct-currency identity must be CREATABLE, never permanently blocked",
  );
  if (!second.ok) return;
  assert.equal(second.outcome, "created");
  assert.notEqual(
    first.securityId,
    second.securityId,
    "the AUD and USD identities must never merge onto one security",
  );

  const securities = database
    .prepare(
      `SELECT id, primary_currency_code FROM securities ORDER BY primary_currency_code`,
    )
    .all() as { id: string; primary_currency_code: string }[];
  assert.equal(securities.length, 2);
  assert.deepEqual(
    securities.map((row) => row.primary_currency_code),
    ["AUD", "USD"],
  );
});

test("BRK-009B: differing exchange evidence on both sides of a cross-owner ticker+currency match stages a conflict, never a silent merge, and persists nothing", async () => {
  const database = await migratedDatabase();
  // Existing security, owned by a DIFFERENT user (user-b/portfolio-b), with
  // exchange evidence "ASX".
  database.exec(`
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('sec-other-owner', 'equity', 'AUD', 'AGL Energy', 'active', '2026-08-18', '2026-08-18');
    INSERT INTO security_identifiers (id, security_id, scheme, value, exchange_id, valid_from, valid_to, source)
    VALUES ('id-other-owner', 'sec-other-owner', 'ticker', 'AGL', NULL, '2026-08-18', NULL, 'owner_attested');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-other-owner', 'user-b', 'portfolio-b', 'sec-other-owner', 'AGL', 'ASX', 'AUD', 'held', '2026-08-18', '2026-08-18');
  `);
  const securitiesBefore = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  const portfolioSecuritiesBefore = (
    database
      .prepare("SELECT COUNT(*) AS n FROM portfolio_securities")
      .get() as {
      n: number;
    }
  ).n;

  const client = createSqliteSqlClient(database);
  const repository = createOwnedSecurityResolutionRepository(client);
  // A DIFFERENT user (user-a), same ticker+currency, but DISAGREEING
  // exchange evidence ("NYSE" vs the existing "ASX").
  const result = await repository.resolveAndLink(
    "user-a",
    {
      symbol: "AGL",
      exchangeAlias: "NYSE",
      currencyCode: "AUD",
      sharesightInstrumentId: null,
      isin: null,
      instrumentName: null,
    },
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "AGL",
      sourceExchangeAlias: "NYSE",
      sourceCurrencyCode: "AUD",
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "conflict");
  if (result.reason === "conflict") {
    assert.deepEqual([...result.tiers], ["global_ticker_currency"]);
    assert.deepEqual([...result.securityIds], ["sec-other-owner"]);
  }

  // B2: a rejected resolution must persist NOTHING -- zero new rows either
  // side of the failed call.
  const securitiesAfter = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  const portfolioSecuritiesAfter = (
    database
      .prepare("SELECT COUNT(*) AS n FROM portfolio_securities")
      .get() as {
      n: number;
    }
  ).n;
  assert.equal(securitiesAfter, securitiesBefore);
  assert.equal(portfolioSecuritiesAfter, portfolioSecuritiesBefore);
});

test("BRK-009B: cross-owner same ticker+currency with agreeing (uncontradicted) identity links to the shared canonical security, never duplicating it", async () => {
  // F4 pin: shared canonical securities may legitimately dedupe cross-owner
  // (IMP-004B precedent), but ONLY when identity actually agrees -- here
  // the existing security carries NO exchange evidence at all, so there is
  // nothing to contradict.
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('sec-other-owner', 'equity', 'AUD', 'AGL Energy', 'active', '2026-08-18', '2026-08-18');
    INSERT INTO security_identifiers (id, security_id, scheme, value, exchange_id, valid_from, valid_to, source)
    VALUES ('id-other-owner', 'sec-other-owner', 'ticker', 'AGL', NULL, '2026-08-18', NULL, 'owner_attested');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-other-owner', 'user-b', 'portfolio-b', 'sec-other-owner', 'AGL', NULL, 'AUD', 'held', '2026-08-18', '2026-08-18');
  `);

  const client = createSqliteSqlClient(database);
  const repository = createOwnedSecurityResolutionRepository(client);
  const result = await repository.resolveAndLink(
    "user-a",
    {
      symbol: "AGL",
      exchangeAlias: "ASX",
      currencyCode: "AUD",
      sharesightInstrumentId: null,
      isin: null,
      instrumentName: null,
    },
    {
      portfolioId: "portfolio-a",
      sourceSymbol: "AGL",
      sourceExchangeAlias: "ASX",
      sourceCurrencyCode: "AUD",
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outcome, "matched");
  assert.equal(result.securityId, "sec-other-owner");
  assert.equal(result.tier, "global_ticker_currency");

  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(
    securityCount,
    1,
    "no duplicate security -- linked to the existing one",
  );
});

test("BRK-009B: a re-resolution pass clears a previously-staged SECURITY_RESOLUTION_CONFLICT issue once the underlying disagreement no longer reproduces, with an audit event", async () => {
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('sec-existing', 'equity', 'AUD', 'iShares Global Healthcare', 'active', '2026-08-18', '2026-08-18');
    INSERT INTO security_identifiers (id, security_id, scheme, value, exchange_id, valid_from, valid_to, source)
    VALUES ('id-existing', 'sec-existing', 'ticker', 'IXJ', NULL, '2026-08-18', NULL, 'owner_attested');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-existing', 'user-a', 'portfolio-a', 'sec-existing', 'IXJ', 'NZX', 'AUD', 'held', '2026-08-18', '2026-08-18');
  `);
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [
        fakeTrade({
          id: "trade-f1",
          marketCode: "ASX",
          sharesightInstrumentId: null,
          instrumentName: null,
        }),
      ],
      payouts: [],
    },
  );
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const staging = createOwnedImportStagingRepository(client);
  const conflictBefore = (
    await staging.listIssues("user-a", synced.batchId)
  ).filter((issue) => issue.code === "SECURITY_RESOLUTION_CONFLICT");
  assert.equal(conflictBefore.length, 1);
  assert.equal(conflictBefore[0]?.resolvedAt, null);

  // Fix the underlying disagreement: the owner corrects the pre-existing
  // exchange evidence to agree with what Sharesight reports.
  database.exec(
    `UPDATE portfolio_securities SET source_exchange_alias = 'ASX' WHERE id = 'membership-existing'`,
  );

  const rerun = await resolveSharesightBatchSecuritiesWithContext(
    { client, userId: "user-a", requestId: "rerun-req" },
    synced.batchId,
  );
  assert.equal(rerun.ok, true);
  if (!rerun.ok) return;
  assert.equal(rerun.conflictCount, 0);

  const conflictAfter = (
    await staging.listIssues("user-a", synced.batchId)
  ).filter((issue) => issue.code === "SECURITY_RESOLUTION_CONFLICT");
  assert.equal(conflictAfter.length, 1);
  assert.notEqual(
    conflictAfter[0]?.resolvedAt,
    null,
    "the stale conflict issue must be marked resolved once it no longer reproduces",
  );

  const auditRow = database
    .prepare(
      `SELECT action FROM audit_events WHERE action = 'sharesight.security.conflict_resolved' LIMIT 1`,
    )
    .get() as { action: string } | undefined;
  assert.ok(auditRow, "expected an audit event recording the resolution");
});

test("BRK-009B: an auto-created canonical name strips control characters and truncates to 120 characters", async () => {
  const database = await migratedDatabase();
  const longName = `Bad\x01Name${"X".repeat(200)}`;
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [
        fakeTrade({
          id: "trade-f2",
          instrumentCode: "LONGCO",
          sharesightInstrumentId: "5001",
          instrumentName: longName,
        }),
      ],
      payouts: [],
    },
  );
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const security = database
    .prepare(`SELECT canonical_name FROM securities LIMIT 1`)
    .get() as { canonical_name: string } | undefined;
  assert.ok(security);
  assert.ok(security!.canonical_name.length <= 120);
  assert.doesNotMatch(security!.canonical_name, /[\x00-\x1f\x7f]/);
  assert.ok(security!.canonical_name.startsWith("BadName"));
});

test("BRK-009B: accept denies a non-Sharesight (CSV) batch with an honest 400 naming the review flow", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const csv = [
    "Id,Symbol,Name,Display Symbol,Exchange,Portfolio,Currency,Shares Owned,Cost Per Share,Commission,Transaction Date,Transaction Time,Purchase Exchange Rate,Type,Accounting,Accounting Execution Ids,Notes",
    '"1","IXJ","","","ASX","Main","AUD","5","10","0","2026-08-01 GMT+1000","10:00:00","0","Buy","","",""',
  ].join("\n");
  const parsed = await parseStrictVersionedCsvImport(csv, {
    maxBytes: 10_000_000,
    maxRows: 1000,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const staging = createOwnedImportStagingRepository(client);
  const started = await staging.startUpload("user-a", {
    targetPortfolioId: "portfolio-a",
    parserFormat: "strict-versioned-csv",
    parserVersion: parsed.parserVersion,
    filename: "sample.csv",
    byteSize: csv.length,
    fileSha256: parsed.fileFingerprint,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const recorded = await staging.recordParseResult("user-a", started.batch.id, {
    expectedVersion: started.batch.version,
    parseResult: parsed,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;

  const denied = await acceptImportWithContext(
    { client, userId: "user-a", requestId: "accept-csv-req" },
    started.batch.id,
  );
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.status, 400);
  assert.equal(
    denied.message,
    "Accept is available for Sharesight sync imports; use the review flow for CSV imports.",
  );

  const batch = await staging.get("user-a", started.batch.id);
  assert.notEqual(batch?.status, "ready");
  assert.notEqual(batch?.status, "committed");
});

test("BRK-009B: accept action denies another owner's batch as not-found", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [fakeTrade({ id: "trade-cross-user" })],
      payouts: [],
    },
  );
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const denied = await acceptImportWithContext(
    { client, userId: "user-b", requestId: "cross-user-req" },
    synced.batchId,
  );
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.status, 404);

  const batch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    synced.batchId,
  );
  assert.notEqual(
    batch?.status,
    "committed",
    "another owner's accept attempt must never commit the batch",
  );
});

test("BRK-009B: accept route enforces CSRF before its authenticated action", async () => {
  let calls = 0;
  const rejectedPost = createImportAcceptPost(async () => {
    calls += 1;
    throw new Error("cross-site request reached the action");
  });
  const rejected = await rejectedPost(
    new Request("https://yield.example/api/import/preview/batch-a/accept", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    }),
    { params: Promise.resolve({ batchId: "batch-a" }) },
  );
  assert.equal(rejected.status, 403);
  assert.equal(calls, 0);
});

test("BRK-009B: the ready service accept reuses still rejects a stale expectedVersion/expectedPreviewVersion with 409", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [fakeTrade({ id: "trade-stale" })],
      payouts: [],
    },
  );
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const staleReady = await markImportReadyWithContext(
    { client, userId: "user-a" },
    synced.batchId,
    { expectedVersion: 999, expectedPreviewVersion: "stale-preview-version" },
  );
  assert.equal(staleReady.ok, false);
  if (staleReady.ok) return;
  assert.equal(staleReady.status, 409);
});

// ---------------------------------------------------------------------------
// QA-001A matrix self-check (mirrors tests/brk-005.test.ts's/tests/imp-009.test.ts's
// identical pattern).
// ---------------------------------------------------------------------------

test("BRK-009B: the QA-001A matrix records the new accept route", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const needle of [
    "/api/import/preview/:batchId/accept",
    "tests/brk-009b.test.ts",
  ]) {
    assert.ok(matrix.includes(needle), `matrix should mention ${needle}`);
  }
});

test("BRK-009B: every matrix citation naming tests/brk-009b.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/brk-009b.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/brk-009b\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
  const quotedStringPattern = /"(?:[^"\\]|\\.)*"/g;
  let groupCount = 0;
  let titleCount = 0;
  for (const match of matrix.matchAll(citationGroupPattern)) {
    groupCount += 1;
    const titles = match[2]!.match(quotedStringPattern) ?? [];
    for (const quoted of titles) {
      titleCount += 1;
      const title = quoted.slice(1, -1);
      assert.ok(
        ownSource.includes(title),
        `matrix cites "${title}" in tests/brk-009b.test.ts, but that title is not a literal substring of the file (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount >= 1, "expected at least 1 citation group to check");
  assert.ok(titleCount >= 2, "expected at least 2 quoted titles to check");
});
