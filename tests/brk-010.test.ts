import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  linkSharesightPortfolioWithContext,
  runSharesightSyncWithContext,
} from "../app/sharesight-sync-service.ts";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import { setImportRowExclusionWithContext } from "../app/import-row-exclusion-service.ts";
import {
  acceptImportWithContext,
  type ImportAcceptActionSuccess,
} from "../app/import-accept-service.ts";
import {
  buildDividendManualRecordImportInsertStatements,
  createDividendManualRecordRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  resolveSecurity,
  type ResolveSecurityCandidateIdentity,
  type SecurityIdentifierCandidateRow,
} from "../domain/securities/resolve-security.ts";
import {
  invertToPortfolioConversionRate,
  transformSharesightSync,
} from "../domain/sharesight-sync/index.ts";
import {
  computeLifetimeDividendTotals,
  deriveDividendHistoryForSecurity,
  type DividendManualRecordFact,
} from "../domain/dividends/index.ts";
import type {
  SharesightClient,
  SharesightPayout,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
} from "../domain/sharesight/index.ts";

// BRK-010: an ASX security (RMD, sharesight_instrument id 2964) trades in AUD
// but pays USD dividends -- one economic security, a foreign-currency cash
// event. See TASKS.md's BRK-010 entry for the full ruling set this test
// verifies: (1) a dividend-class candidate is exempt from the resolver's
// currency-agreement check (trade rows keep the strict rule); (2)
// `dividend_manual_records` honestly records the foreign total + Sharesight's
// own rate instead of silently treating it as 1:1; (3) a foreign payout with
// no rate fails closed pre-ready, excludable via IMP-008; (4) income
// aggregation converts the foreign total via the stored rate at read time.

// ---------------------------------------------------------------------------
// Fixtures (mirrors tests/brk-009b.test.ts's harness)
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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-19', '2026-08-19', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-19', '2026-08-19', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-19', '2026-08-19', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-19', '2026-08-19', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-19', '2026-08-19', 1),
           ('portfolio-b', 'user-b', 'B', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-19', '2026-08-19', 1);
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
    holdingId: "holding-rmd",
    instrumentCode: "RMD",
    marketCode: "ASX",
    sharesightInstrumentId: "2964",
    instrumentName: "ResMed Inc",
    isin: null,
    transactionType: "buy",
    transactionDate: "2026-08-01",
    currencyCode: "AUD",
    quantityDecimal: "10",
    priceDecimal: "50",
    valueDecimal: "500",
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
    holdingId: "holding-rmd",
    sharesightInstrumentId: "2964",
    symbol: "RMD",
    marketCode: "ASX",
    currencyCode: "USD",
    paidOnDate: "2026-08-05",
    amountDecimal: "10",
    grossAmountDecimal: "10",
    frankedAmountDecimal: null,
    unfrankedAmountDecimal: null,
    frankingCreditsDecimal: null,
    residentWithholdingTaxDecimal: null,
    nonResidentWithholdingTaxDecimal: null,
    goesExOnDate: null,
    state: null,
    confirmed: true,
    trust: null,
    nonTaxable: null,
    comments: null,
    // BRK-010 review finding B1 (LIVE-CONFIRMED): this is the RAW Sharesight
    // wire value -- `domain/sharesight-sync/transform.ts`'s
    // `invertToPortfolioConversionRate` inverts it before it ever becomes
    // `normalized.exchangeRateDecimal`/`dividend_manual_records.fx_rate_to_portfolio_decimal`.
    // "0.5" is a deliberately clean (not realistic) value so its exact
    // reciprocal ("2") stays trivially pinnable in decimal-string
    // assertions; the live-observed real-world band was ~0.60-0.72 (see
    // `contracts.ts`'s `SharesightPayout.exchangeRateDecimal` doc comment).
    exchangeRateDecimal: "0.5",
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
    // BRK-012B: listUserInstruments is now a REQUIRED typed method on
    // SharesightClient; this suite doesn't exercise the price refresh path,
    // so an empty result is a safe, unused-by-these-tests stub.
    async listUserInstruments() {
      return { ok: true, value: [] };
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

const FIXED_NOW = "2026-08-19T00:00:00.000Z";

async function currentPreviewVersion(
  client: SqlClient,
  userId: string,
  batchId: string,
): Promise<{ previewVersion: string; batchVersion: number }> {
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
  return { previewVersion: review.previewVersion, batchVersion: batch.version };
}

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

function identifierRow(
  overrides: Partial<SecurityIdentifierCandidateRow> = {},
): SecurityIdentifierCandidateRow {
  return {
    securityId: "sec-rmd",
    scheme: "sharesight_instrument",
    value: "2964",
    exchangeAlias: null,
    validFrom: "2020-01-01",
    validTo: null,
    primaryCurrencyCode: "AUD",
    ...overrides,
  };
}

function candidateIdentity(
  overrides: Partial<ResolveSecurityCandidateIdentity> = {},
): ResolveSecurityCandidateIdentity {
  return {
    symbol: "RMD",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
    sharesightInstrumentId: "2964",
    ...overrides,
  };
}

// BRK-010 review round 3: seeds a REAL, already-resolved
// `securities`/`security_identifiers`/`portfolio_securities` row -- exactly
// what an EARLIER sync (or a CSV import) would have left behind -- so a
// SUBSEQUENT payout-only fetch (no same-fetch trade evidence, the
// realistic steady state) still has real DB evidence to consult via
// `loadResolvedPortfolioInstrumentCurrencies`, rather than the removed
// portfolio-base guess.
function seedResolvedSecurity(
  database: DatabaseSync,
  args: {
    securityId: string;
    userId: string;
    portfolioId: string;
    symbol: string;
    exchangeAlias: string;
    currencyCode: string;
    sharesightInstrumentId?: string | null;
  },
): void {
  const now = "2026-08-01T00:00:00.000Z";
  database
    .prepare(
      `INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
       VALUES (?, 'equity', ?, ?, 'active', ?, ?)`,
    )
    .run(args.securityId, args.currencyCode, args.symbol, now, now);
  if (args.sharesightInstrumentId) {
    database
      .prepare(
        `INSERT INTO security_identifiers (id, security_id, scheme, value, exchange_id, valid_from, valid_to, source)
         VALUES (?, ?, 'sharesight_instrument', ?, NULL, ?, NULL, 'sharesight')`,
      )
      .run(
        `${args.securityId}-si`,
        args.securityId,
        args.sharesightInstrumentId,
        now.slice(0, 10),
      );
  }
  database
    .prepare(
      `INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?, ?)`,
    )
    .run(
      `${args.securityId}-ps`,
      args.userId,
      args.portfolioId,
      args.securityId,
      args.symbol,
      args.exchangeAlias,
      args.currencyCode,
      now,
      now,
    );
}

// ---------------------------------------------------------------------------
// Pure resolver: dividend-class currency exemption
// ---------------------------------------------------------------------------

test("BRK-010: trade-currency disagreement still conflicts", () => {
  const identifiers = [identifierRow()]; // sec-rmd, sharesight_instrument 2964, AUD

  // A TRADE-class identity in USD against an AUD-linked instrument id is
  // still a genuine, suspicious disagreement -- never exempted.
  const tradeOutcome = resolveSecurity(
    candidateIdentity({ currencyCode: "USD", rowClass: "trade" }),
    identifiers,
  );
  assert.deepEqual(tradeOutcome, {
    outcome: "conflict",
    tiers: ["sharesight_instrument"],
    securityIds: ["sec-rmd"],
  });

  // The identical identity, but DIVIDEND-class, is exempt from the currency
  // check and matches cleanly -- this is the whole BRK-010 identity fix.
  const dividendOutcome = resolveSecurity(
    candidateIdentity({ currencyCode: "USD", rowClass: "dividend" }),
    identifiers,
  );
  assert.deepEqual(dividendOutcome, {
    outcome: "matched",
    securityId: "sec-rmd",
    tier: "sharesight_instrument",
  });

  // Omitting rowClass defaults to the strict "trade" behaviour -- every
  // pre-BRK-010 caller is unaffected.
  const defaultOutcome = resolveSecurity(
    candidateIdentity({ currencyCode: "USD" }),
    identifiers,
  );
  assert.equal(defaultOutcome.outcome, "conflict");

  // A genuine cross-tier/same-tier security-id disagreement is UNAFFECTED
  // by rowClass -- the exemption only ever loosens the currency check.
  const ambiguous = resolveSecurity(
    candidateIdentity({ currencyCode: "AUD", rowClass: "dividend" }),
    [
      identifierRow({ securityId: "sec-rmd" }),
      identifierRow({ securityId: "sec-other" }),
    ],
  );
  assert.equal(ambiguous.outcome, "conflict");
});

// ---------------------------------------------------------------------------
// Rate direction (B1, live-confirmed)
// ---------------------------------------------------------------------------

test("BRK-010: invertToPortfolioConversionRate inverts Sharesight's raw wire value (B1, live-confirmed direction)", () => {
  // Clean reciprocal pairs, pinned exactly.
  assert.equal(invertToPortfolioConversionRate("0.5"), "2");
  assert.equal(invertToPortfolioConversionRate("2"), "0.5");
  assert.equal(invertToPortfolioConversionRate("0.25"), "4");
  // A live-observed-shaped value (within the confirmed 0.60-0.72 AUD/USD
  // band) still inverts to the expected reciprocal, rounded half-even to
  // 24 places -- pinned to the exact value (1 / 0.6528835691 to 24dp,
  // independently computed).
  assert.equal(
    invertToPortfolioConversionRate("0.6528835691"),
    "1.531666666659263611111147",
  );
  // Absent-tolerant.
  assert.equal(invertToPortfolioConversionRate(null), null);
  // A malformed/zero raw rate degrades to null (never divides by zero,
  // never fabricates a value).
  assert.equal(invertToPortfolioConversionRate("0"), null);
});

// ---------------------------------------------------------------------------
// Digest/fingerprint stability
// ---------------------------------------------------------------------------

test("BRK-010: digest/fingerprint stability", async () => {
  // (a) Pure transform: a payout's fingerprint (its dedupe identity) never
  // depends on exchangeRateDecimal -- identity is purely
  // (sharesightPortfolioId, holdingId, paidOnDate), unaffected by the rate.
  const withoutRate = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [],
    payouts: [fakePayout({ currencyCode: "AUD", exchangeRateDecimal: null })],
    now: FIXED_NOW,
  });
  const withRate = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [],
    payouts: [
      fakePayout({ currencyCode: "AUD", exchangeRateDecimal: "1.2345" }),
    ],
    now: FIXED_NOW,
  });
  assert.equal(withoutRate.rows[0]?.fingerprint, withRate.rows[0]?.fingerprint);
  // But the NORMALIZED exchangeRateDecimal genuinely differs (inverted from
  // each distinct raw input) -- this is the field B2 puts in the digest.
  assert.notEqual(
    withoutRate.rows[0]?.normalized.exchangeRateDecimal,
    withRate.rows[0]?.normalized.exchangeRateDecimal,
  );

  // (b) BRK-010 review finding B2 (BINDING CORRECTION): end-to-end batch
  // digest -- syncing the identical core data twice, once with no exchange
  // rate, once with one, must now resolve to TWO DIFFERENT batches
  // (`reused: false`) -- exchangeRateDecimal is VALUE-BEARING money data
  // and IS included in `canonicalRowDigestFields`, so a corrected/late rate
  // from Sharesight re-stages as a genuinely new batch rather than silently
  // reusing a stale one (BRK-005B's identical digest philosophy for a
  // trade correction).
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [fakeTrade()],
      payouts: [fakePayout({ currencyCode: "AUD", exchangeRateDecimal: null })],
    },
  );
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: { enabled: true, client: sharesightClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const ratedClient = fakeSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [fakeTrade()],
    payouts: [
      fakePayout({ currencyCode: "AUD", exchangeRateDecimal: "1.2345" }),
    ],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: { enabled: true, client: ratedClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(
    second.reused,
    false,
    "a corrected/late rate must re-stage as a genuinely NEW batch, never silently reuse the old one",
  );
  assert.notEqual(second.batchId, first.batchId);
});

// ---------------------------------------------------------------------------
// RMD-shaped end-to-end
// ---------------------------------------------------------------------------

test("BRK-010: RMD-shaped end-to-end", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [fakeTrade()], // AUD buy, sharesight_instrument 2964
      payouts: [fakePayout()], // USD payout, exchangeRateDecimal "1.5"
    },
  );

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: { enabled: true, client: sharesightClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  // Exactly ONE security -- the AUD trade group and the USD payout group
  // resolve/link to the same economic security, never two.
  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(securityCount, 1, "trades and payouts converge on one security");

  const security = database
    .prepare("SELECT id, primary_currency_code FROM securities LIMIT 1")
    .get() as { id: string; primary_currency_code: string };
  assert.equal(security.primary_currency_code, "AUD");

  // No stale SECURITY_RESOLUTION_CONFLICT issues -- the identity fix means
  // the currency mismatch never trips the resolver in the first place.
  const staging = createOwnedImportStagingRepository(client);
  const conflictIssues = (
    await staging.listIssues("user-a", synced.batchId)
  ).filter((issue) => issue.code === "SECURITY_RESOLUTION_CONFLICT");
  assert.equal(conflictIssues.length, 0);

  // Exactly ONE `portfolio_securities` row for this security -- the AUD
  // trade group and the USD payout group resolve to the same security AND
  // link to the SAME row (`portfolio_securities_resolved_unique` permits
  // only one row per (portfolio_id, security_id); a dividend fact's own
  // cash currency lives on `dividend_manual_records.currency_code`, never
  // on `portfolio_securities.source_currency_code` -- see
  // `db/repositories/security-resolution.ts`'s `linkResolvedSecurity`).
  const candidateRows = database
    .prepare(
      `SELECT id, source_currency_code FROM portfolio_securities
       WHERE user_id = 'user-a' AND security_id = ?`,
    )
    .all(security.id) as { id: string; source_currency_code: string }[];
  assert.equal(candidateRows.length, 1);
  assert.equal(candidateRows[0]?.source_currency_code, "AUD");
  const portfolioSecurityId = candidateRows[0]!.id;

  const commit = await acceptUntilCommitted(
    client,
    "user-a",
    "accept-req",
    synced.batchId,
  );
  assert.equal(commit.commit.committedRows > 0, true);

  // Trades commit AUD, native, through the ledger.
  const trade = database
    .prepare(
      `SELECT status, quantity_decimal FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = ?`,
    )
    .get(portfolioSecurityId) as
    { status: string; quantity_decimal: string } | undefined;
  assert.ok(trade);
  assert.equal(trade?.status, "posted");
  assert.equal(trade?.quantity_decimal, "10");

  // Dividends commit USD-with-rate against the SAME portfolio_security_id
  // the trade uses -- honest provenance, never 1:1.
  const dividend = database
    .prepare(
      `SELECT total_cash_decimal, currency_code, fx_rate_to_portfolio_decimal, fx_rate_source
       FROM dividend_manual_records WHERE user_id = 'user-a' AND portfolio_security_id = ?`,
    )
    .get(portfolioSecurityId) as
    | {
        total_cash_decimal: string;
        currency_code: string;
        fx_rate_to_portfolio_decimal: string;
        fx_rate_source: string;
      }
    | undefined;
  assert.ok(dividend, "expected a committed dividend record");
  assert.equal(dividend?.total_cash_decimal, "10");
  assert.equal(dividend?.currency_code, "USD");
  // Stored rate is the INVERTED value (B1) -- raw Sharesight "0.5" (see
  // fakePayout's default) becomes "2", never the raw wire value verbatim.
  assert.equal(dividend?.fx_rate_to_portfolio_decimal, "2");
  assert.equal(dividend?.fx_rate_source, "sharesight");

  // Income shows AUD-converted totals with provenance, at read time.
  const manualRecord: DividendManualRecordFact = {
    id: "dividend-row",
    paymentDate: "2026-08-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: dividend!.total_cash_decimal,
    totalFrankingDecimal: null,
    importBatchId: synced.batchId,
    currencyCode: dividend!.currency_code,
    fxRateToPortfolioDecimal: dividend!.fx_rate_to_portfolio_decimal,
    fxRateSource: dividend!.fx_rate_source,
  };
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId,
    securityCurrencyCode: security.primary_currency_code,
    portfolioBaseCurrencyCode: "AUD", // matches the security's own currency here (case B, achievable)
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [manualRecord],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.currencyCode, "AUD");
  assert.equal(rows[0]?.cashDecimal, "20"); // 10 USD * 2 = 20 AUD
  assert.equal(rows[0]?.originalCurrencyCode, "USD");
  assert.equal(rows[0]?.fxRateToPortfolioDecimal, "2");
  assert.equal(rows[0]?.fxRateSource, "sharesight");
  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(totals.status, "ok");
  assert.equal(totals.receivedCashDecimal, "20");

  // Re-running resolution (a second sync of the identical shape) resolves
  // to the SAME one security, both candidates still linked, and stages no
  // new conflict -- F1 self-heal / stability under re-sync.
  const resynced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: { enabled: true, client: sharesightClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(resynced.ok, true);
  const securityCountAfter = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(
    securityCountAfter,
    1,
    "still exactly one security after re-sync",
  );
});

// ---------------------------------------------------------------------------
// Missing-rate foreign payout fails closed
// ---------------------------------------------------------------------------

test("BRK-010: missing-rate foreign payout fails closed pre-ready with excludable issue (real DB evidence, round 3)", async () => {
  // Round 3: a payout-only fetch (no same-fetch trade -- the REALISTIC
  // steady state, since trades are historical) can no longer fall back to
  // guessing the portfolio's own base currency. This block must now be
  // driven by REAL evidence: an ALREADY-RESOLVED AUD security for this
  // exact instrument, seeded here exactly as an earlier sync/CSV import
  // would have left it.
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-rmd-seeded",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "RMD",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
    sharesightInstrumentId: "2964",
  });
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [],
      payouts: [fakePayout({ exchangeRateDecimal: null })], // USD, no rate
    },
  );

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: { enabled: true, client: sharesightClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const staging = createOwnedImportStagingRepository(client);
  const issues = await staging.listIssues("user-a", synced.batchId);
  const fxIssue = issues.find(
    (issue) => issue.code === "SHARESIGHT_PAYOUT_FX_RATE_MISSING",
  );
  assert.ok(fxIssue, "expected a blocking FX-rate-missing issue");
  assert.equal(fxIssue?.severity, "error");
  assert.equal(fxIssue?.resolvedAt, null);
  assert.notEqual(fxIssue?.rowId, null, "row-linked, so it can be excluded");
  assert.match(fxIssue!.message, /2026-08-05/);
  assert.match(fxIssue!.message, /10/);
  assert.match(fxIssue!.message, /USD/);

  // The row itself is NOT skipped -- it stages visibly.
  const rows = await staging.listRows("user-a", synced.batchId);
  assert.equal(rows.length, 1);

  // Readiness is blocked.
  let { previewVersion, batchVersion } = await currentPreviewVersion(
    client,
    "user-a",
    synced.batchId,
  );
  const readyBlocked = await markImportReadyWithContext(
    { client, userId: "user-a" },
    synced.batchId,
    { expectedVersion: batchVersion, expectedPreviewVersion: previewVersion },
  );
  assert.equal(readyBlocked.ok, false);

  // Excluding the row unblocks readiness (IMP-008).
  const excluded = await setImportRowExclusionWithContext(
    { client, userId: "user-a", requestId: "exclude-req" },
    synced.batchId,
    {
      action: "exclude",
      target: { kind: "issue", issueId: fxIssue!.id },
      expectedVersion: batchVersion,
      expectedPreviewVersion: previewVersion,
    },
  );
  assert.equal(excluded.ok, true);
  if (!excluded.ok) return;
  assert.equal(excluded.review.preview.ready, true);

  ({ previewVersion, batchVersion } = await currentPreviewVersion(
    client,
    "user-a",
    synced.batchId,
  ));
  const readyAfterExclude = await markImportReadyWithContext(
    { client, userId: "user-a" },
    synced.batchId,
    { expectedVersion: batchVersion, expectedPreviewVersion: previewVersion },
  );
  assert.equal(readyAfterExclude.ok, true);

  // Never committed at 1:1 -- no dividend_manual_records row exists at all.
  const dividendCount = (
    database
      .prepare("SELECT COUNT(*) AS n FROM dividend_manual_records")
      .get() as { n: number }
  ).n;
  assert.equal(
    dividendCount,
    0,
    "the excluded foreign payout must never commit",
  );
});

test("BRK-010: a payout-only fetch for an EXISTING NZD security with a USD payout and no rate stages clean via REAL evidence, then commits and degrades to mixed_currency at read (round 3 BLOCKER)", async () => {
  // The exact reviewer repro: no same-fetch trade (payout-only, the
  // realistic steady state) for an instrument whose security is ALREADY
  // resolved (from an earlier sync/CSV import) to NZD -- neither the
  // portfolio base (AUD) nor any rate Sharesight could ever supply can
  // convert USD into NZD, so this must stage clean, commit with the
  // currency honestly recorded, and degrade at read time -- never block on
  // a guess, and never on real evidence that says "not achievable" either.
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('NZD', 554, 'New Zealand dollar', 2, 1);
  `);
  seedResolvedSecurity(database, {
    securityId: "sec-kar-seeded",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "KAR",
    exchangeAlias: "NZX",
    currencyCode: "NZD",
    sharesightInstrumentId: "7001",
  });
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [], // no same-fetch trade evidence at all
      payouts: [
        fakePayout({
          symbol: "KAR",
          marketCode: "NZX",
          sharesightInstrumentId: "7001",
          currencyCode: "USD",
          exchangeRateDecimal: null, // no rate -- and none could ever help here
        }),
      ],
    },
  );

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: { enabled: true, client: sharesightClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const staging = createOwnedImportStagingRepository(client);
  const issues = await staging.listIssues("user-a", synced.batchId);
  assert.equal(
    issues.filter((issue) => issue.code === "SHARESIGHT_PAYOUT_FX_RATE_MISSING")
      .length,
    0,
    "real evidence says NOT achievable -- must never block",
  );

  const commit = await acceptUntilCommitted(
    client,
    "user-a",
    "accept-req",
    synced.batchId,
  );
  assert.equal(commit.commit.committedRows > 0, true);

  const dividend = database
    .prepare(
      `SELECT total_cash_decimal, currency_code, fx_rate_to_portfolio_decimal
       FROM dividend_manual_records WHERE user_id = 'user-a'`,
    )
    .get() as
    | {
        total_cash_decimal: string;
        currency_code: string;
        fx_rate_to_portfolio_decimal: string | null;
      }
    | undefined;
  assert.ok(dividend, "expected a committed dividend record");
  assert.equal(dividend?.total_cash_decimal, "10");
  assert.equal(dividend?.currency_code, "USD"); // recorded honestly, never mislabelled NZD
  assert.equal(dividend?.fx_rate_to_portfolio_decimal, null); // never converted

  const manualRecord: DividendManualRecordFact = {
    id: "dividend-row",
    paymentDate: "2026-08-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: dividend!.total_cash_decimal,
    totalFrankingDecimal: null,
    importBatchId: synced.batchId,
    currencyCode: dividend!.currency_code,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
  };
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-kar",
    securityCurrencyCode: "NZD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [manualRecord],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows[0]?.currencyCode, "USD");
  assert.equal(rows[0]?.cashDecimal, "10"); // unconverted -- case C
  const totals = computeLifetimeDividendTotals(rows, "NZD");
  assert.equal(totals.status, "mixed_currency");
});

test("BRK-010: a payout-only fetch for an EXISTING AUD security (matching portfolio base) with a foreign payout and no rate STILL blocks -- real evidence says achievable", async () => {
  // The reviewer's companion repro to the NZD case above: when the
  // ALREADY-RESOLVED security's real currency DOES match the portfolio
  // base, conversion genuinely IS achievable and a missing rate is a real,
  // fixable gap -- the block must still fire, driven by real evidence
  // rather than the removed portfolio-base guess.
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-bhp-seeded",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "BHP",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
    sharesightInstrumentId: "3001",
  });
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [], // no same-fetch trade evidence at all
      payouts: [
        fakePayout({
          symbol: "BHP",
          marketCode: "ASX",
          sharesightInstrumentId: "3001",
          currencyCode: "USD",
          exchangeRateDecimal: null,
        }),
      ],
    },
  );

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: { enabled: true, client: sharesightClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const staging = createOwnedImportStagingRepository(client);
  const issues = await staging.listIssues("user-a", synced.batchId);
  const fxIssue = issues.find(
    (issue) => issue.code === "SHARESIGHT_PAYOUT_FX_RATE_MISSING",
  );
  assert.ok(fxIssue, "real evidence says achievable -- must still block");
  assert.equal(fxIssue?.severity, "error");
});

test("BRK-010: a brand-new payout-only instrument (no resolved security anywhere yet) stages every row clean; commit-time still fails closed with a batch-level 409 (mapping_incomplete), not a row-named failure, once resolution creates a real, achievable security", async () => {
  // Genuinely NO evidence exists anywhere at staging time -- no DB-resolved
  // security, no same-fetch trade. Two payouts share this brand-new
  // instrument id: the FIRST (AUD, matching the portfolio base) becomes
  // the auto-created security's own currency; the SECOND (USD, no rate)
  // is then genuinely foreign to that real, achievable security -- proving
  // the round-3 fix only removes the pre-resolution GUESS, never weakens
  // `db/repositories/import-commit.ts`'s authoritative commit-time gate.
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [],
      payouts: [
        fakePayout({
          id: "payout-native",
          holdingId: "holding-new",
          sharesightInstrumentId: "9999",
          symbol: "NEWCO",
          marketCode: "ASX",
          currencyCode: "AUD",
          paidOnDate: "2026-08-06",
          exchangeRateDecimal: null,
        }),
        fakePayout({
          id: "payout-foreign",
          holdingId: "holding-new",
          sharesightInstrumentId: "9999",
          symbol: "NEWCO",
          marketCode: "ASX",
          currencyCode: "USD",
          paidOnDate: "2026-08-07",
          exchangeRateDecimal: null,
        }),
      ],
    },
  );

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: { enabled: true, client: sharesightClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  const staging = createOwnedImportStagingRepository(client);
  const issues = await staging.listIssues("user-a", synced.batchId);
  assert.equal(
    issues.filter((issue) => issue.code === "SHARESIGHT_PAYOUT_FX_RATE_MISSING")
      .length,
    0,
    "a brand-new instrument must never block on a guess -- no evidence exists yet",
  );

  const { previewVersion, batchVersion } = await currentPreviewVersion(
    client,
    "user-a",
    synced.batchId,
  );
  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    synced.batchId,
    { expectedVersion: batchVersion, expectedPreviewVersion: previewVersion },
  );
  assert.equal(ready.ok, true, "nothing blocks readiness for this batch");

  // Exactly one security was auto-created -- the AUD-native payout (listed
  // first, so resolved first) sets its currency; the USD payout's dividend
  // group matches the SAME security via the sharesight_instrument tier
  // (BRK-010's dividend-class currency exemption).
  const security = database
    .prepare("SELECT primary_currency_code FROM securities LIMIT 1")
    .get() as { primary_currency_code: string } | undefined;
  assert.ok(security);
  assert.equal(security?.primary_currency_code, "AUD");

  const accepted = await acceptImportWithContext(
    { client, userId: "user-a", requestId: "accept-req" },
    synced.batchId,
  );
  assert.equal(
    accepted.ok,
    false,
    "the USD payout, now genuinely foreign to a REAL, achievable AUD security with no rate, must fail closed",
  );
  if (accepted.ok) return;
  assert.equal(
    accepted.message,
    "Resolve every required mapping before committing this import.",
  );
});

// ---------------------------------------------------------------------------
// Legacy NULL-currency read unchanged
// ---------------------------------------------------------------------------

test("BRK-010: legacy NULL-currency read unchanged", () => {
  // A pre-BRK-010 (or same-currency) imported fact carries no currency/rate
  // fields at all -- the new conversion path must be a complete no-op.
  const legacyRecord: DividendManualRecordFact = {
    id: "legacy-1",
    paymentDate: "2026-08-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "50",
    totalFrankingDecimal: null,
    importBatchId: "batch-legacy",
    // currencyCode/fxRateToPortfolioDecimal/fxRateSource all omitted.
  };
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-legacy",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [legacyRecord],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.currencyCode, "AUD");
  assert.equal(
    rows[0]?.cashDecimal,
    "50",
    "unconverted -- byte-identical to pre-BRK-010",
  );
  assert.equal(rows[0]?.originalCurrencyCode, null);
  assert.equal(rows[0]?.fxRateToPortfolioDecimal, null);
  assert.equal(rows[0]?.fxRateSource, null);
});

// ---------------------------------------------------------------------------
// Aggregation converts exactly (pinned decimal strings)
// ---------------------------------------------------------------------------

test("BRK-010: aggregation converts exactly (pin decimal strings)", () => {
  const foreignRecord: DividendManualRecordFact = {
    id: "foreign-1",
    paymentDate: "2026-08-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "100",
    totalFrankingDecimal: null,
    importBatchId: "batch-foreign",
    currencyCode: "USD",
    fxRateToPortfolioDecimal: "1.5",
    fxRateSource: "sharesight",
  };
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-foreign",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [foreignRecord],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.currencyCode, "AUD");
  assert.equal(rows[0]?.cashDecimal, "150"); // 100 * 1.5, exact
  assert.equal(rows[0]?.originalCurrencyCode, "USD");
  assert.equal(rows[0]?.fxRateToPortfolioDecimal, "1.5");
  assert.equal(rows[0]?.fxRateSource, "sharesight");

  const totals = computeLifetimeDividendTotals(rows, "AUD");
  assert.equal(totals.status, "ok");
  assert.equal(totals.receivedCashDecimal, "150");
  assert.equal(totals.receivedGrossDecimal, "150");

  // A finer-grained rate still converts exactly (multiplication of two
  // finite decimals always terminates -- unlike a division, no rounding is
  // actually exercised here, matching franking.ts's own "one division only"
  // discipline; the half-even roundDecimal call is defence-in-depth).
  const finerRecord: DividendManualRecordFact = {
    ...foreignRecord,
    id: "foreign-2",
    totalCashDecimal: "10",
    fxRateToPortfolioDecimal: "1.4815",
  };
  const finerRows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-foreign-2",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [finerRecord],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(finerRows[0]?.cashDecimal, "14.815");
});

// ---------------------------------------------------------------------------
// B4: security-currency-vs-portfolio-base target assertion
// ---------------------------------------------------------------------------

test("BRK-010: an NZD-denominated security's USD payout degrades to mixed_currency, never mislabelled as NZD", () => {
  // The security's own currency (NZD) differs from BOTH the payout's
  // currency (USD) AND the portfolio's base currency (AUD) -- Sharesight's
  // rate only ever converts USD -> AUD, never USD -> NZD, so this is
  // case C: not achievable, must never convert, must never mislabel.
  const foreignRecord: DividendManualRecordFact = {
    id: "nzd-foreign-1",
    paymentDate: "2026-08-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "100",
    totalFrankingDecimal: null,
    importBatchId: "batch-nzd",
    currencyCode: "USD",
    fxRateToPortfolioDecimal: "1.5", // a genuine USD->AUD rate -- NOT applicable to NZD
    fxRateSource: "sharesight",
  };
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-nzd",
    securityCurrencyCode: "NZD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [foreignRecord],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows.length, 1);
  // The row's TRUE currency (USD) is displayed -- never silently
  // defaulted/mislabelled as the security's own NZD.
  assert.equal(rows[0]?.currencyCode, "USD");
  // Completely UNCONVERTED -- the raw USD total, not multiplied by a rate
  // that does not apply to this target.
  assert.equal(rows[0]?.cashDecimal, "100");
  // No provenance surfaced -- nothing was actually converted (F2).
  assert.equal(rows[0]?.originalCurrencyCode, null);
  assert.equal(rows[0]?.fxRateToPortfolioDecimal, null);
  assert.equal(rows[0]?.fxRateSource, null);

  // Aggregated against the security's own currency (NZD, this module's
  // per-security target), the mismatched USD row correctly triggers
  // DIV-001's PRE-EXISTING mixed-currency degradation -- honest, not a
  // silent blend.
  const totals = computeLifetimeDividendTotals(rows, "NZD");
  assert.equal(totals.status, "mixed_currency");
});

test("BRK-010: a USD-denominated security paying a USD dividend never blocks and never converts", () => {
  // (a) Staging: a USD trade establishes the security's own currency
  // (proxy, pre-resolution) as USD; a same-currency USD payout with NO
  // rate must never stage a SHARESIGHT_PAYOUT_FX_RATE_MISSING issue,
  // regardless of the portfolio's own base currency (AUD here) -- no
  // conversion is ever needed at the security-native-currency level.
  const result = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [
      fakeTrade({
        instrumentCode: "AAPL",
        marketCode: "NASDAQ",
        currencyCode: "USD",
        sharesightInstrumentId: "9001",
      }),
    ],
    payouts: [
      fakePayout({
        symbol: "AAPL",
        marketCode: "NASDAQ",
        currencyCode: "USD",
        sharesightInstrumentId: "9001",
        exchangeRateDecimal: null,
      }),
    ],
    now: FIXED_NOW,
  });
  const fxIssues = result.rows
    .flatMap((row) => row.issues)
    .filter((issue) => issue.code === "SHARESIGHT_PAYOUT_FX_RATE_MISSING");
  assert.equal(
    fxIssues.length,
    0,
    "a payout native to its own security must never block, regardless of portfolio base currency",
  );

  // (b) Read time: a record whose currencyCode already equals the
  // security's own currency is native -- unconverted, no provenance, no
  // rate required.
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-usd-native",
    securityCurrencyCode: "USD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "usd-native-1",
        paymentDate: "2026-08-05",
        sharesDecimal: null,
        dividendPerShareDecimal: null,
        frankingCreditPerShareDecimal: null,
        totalCashDecimal: "10",
        totalFrankingDecimal: null,
        importBatchId: "batch-usd-native",
        currencyCode: "USD",
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows[0]?.currencyCode, "USD");
  assert.equal(rows[0]?.cashDecimal, "10");
  assert.equal(rows[0]?.originalCurrencyCode, null);
});

test("BRK-010: an NZD security's USD payout with NO rate stages clean -- no rate could ever convert it, so staging never blocks", () => {
  // Review round 2 finding B1: the previous staging check fired whenever
  // payout currency != the security-currency proxy, WITHOUT checking
  // conversion was actually achievable -- an NZD-security/USD-payout with
  // no rate was wrongly blocked even though no Sharesight rate could ever
  // convert USD -> NZD (the rate only ever converts record-currency ->
  // PORTFOLIO BASE). Fixed: the block fires ONLY when the proxy target
  // itself equals the portfolio's own base currency (case B, achievable).
  const result = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [
      fakeTrade({
        instrumentCode: "KAR",
        marketCode: "NZX",
        currencyCode: "NZD",
        sharesightInstrumentId: "7001",
      }),
    ],
    payouts: [
      fakePayout({
        symbol: "KAR",
        marketCode: "NZX",
        currencyCode: "USD",
        sharesightInstrumentId: "7001",
        exchangeRateDecimal: null, // no rate -- and none could ever help here
      }),
    ],
    now: FIXED_NOW,
  });
  const fxIssues = result.rows
    .flatMap((row) => row.issues)
    .filter((issue) => issue.code === "SHARESIGHT_PAYOUT_FX_RATE_MISSING");
  assert.equal(
    fxIssues.length,
    0,
    "case C (target currency != portfolio base) must never block on a missing rate",
  );
});

test("BRK-010: SMALL-1 -- a zero, negative, or over-24dp-precision raw exchange_rate stages the SAME named block a missing rate does, at an achievable target", () => {
  const zeroRate = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [fakeTrade()], // AUD, sharesight_instrument 2964 -- achievable target
    payouts: [fakePayout({ exchangeRateDecimal: "0" })], // USD, zero rate
    now: FIXED_NOW,
  });
  const zeroIssues = zeroRate.rows
    .flatMap((row) => row.issues)
    .filter((issue) => issue.code === "SHARESIGHT_PAYOUT_FX_RATE_MISSING");
  assert.equal(
    zeroIssues.length,
    1,
    "a zero rate is not usable -- must block, named, not silently pass through",
  );

  // Round 4 correction: a NEGATIVE raw rate inverts to a negative VALUE
  // (not `null`), so the bare `invertToPortfolioConversionRate(...) !==
  // null` check alone let it slip through as "usable" -- it must be caught
  // by the added non-positive-result check instead.
  const negativeRate = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [fakeTrade()],
    payouts: [fakePayout({ exchangeRateDecimal: "-0.5" })], // USD, negative rate
    now: FIXED_NOW,
  });
  const negativeIssues = negativeRate.rows
    .flatMap((row) => row.issues)
    .filter((issue) => issue.code === "SHARESIGHT_PAYOUT_FX_RATE_MISSING");
  assert.equal(
    negativeIssues.length,
    1,
    "a negative rate inverts to a negative value, not null -- must still block, named, row-linked",
  );
  assert.equal(negativeIssues[0]?.severity, "error");

  const overPrecision = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [fakeTrade()],
    payouts: [
      // 26 decimal places -- two over the 24dp limit `parseDecimal` enforces
      // (`domain/calculations/decimal.ts`'s `DECIMAL_LIMITS.inputScale`),
      // so `invertToPortfolioConversionRate` can never parse it at all.
      fakePayout({ exchangeRateDecimal: "0.12345678901234567890123456" }),
    ],
    now: FIXED_NOW,
  });
  const overPrecisionIssues = overPrecision.rows
    .flatMap((row) => row.issues)
    .filter((issue) => issue.code === "SHARESIGHT_PAYOUT_FX_RATE_MISSING");
  assert.equal(
    overPrecisionIssues.length,
    1,
    "an over-24dp raw rate cannot be inverted -- must block, named, never silently die at commit as a batch-level 409, not a row-named failure",
  );

  // A genuinely usable rate at the SAME achievable target still never blocks.
  const usable = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [fakeTrade()],
    payouts: [fakePayout({ exchangeRateDecimal: "0.5" })],
    now: FIXED_NOW,
  });
  const usableIssues = usable.rows
    .flatMap((row) => row.issues)
    .filter((issue) => issue.code === "SHARESIGHT_PAYOUT_FX_RATE_MISSING");
  assert.equal(usableIssues.length, 0);
});

// ---------------------------------------------------------------------------
// B2: franking on foreign-currency payouts (product ruling)
// ---------------------------------------------------------------------------

test("BRK-010: a foreign-currency payout with ZERO/absent franking never warns; DIV-007 derives absent franking to a known $0", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [fakeTrade()], // default RMD/ASX/AUD
    payouts: [
      fakePayout({ frankingCreditsDecimal: null }), // USD, no franking
    ],
    now: FIXED_NOW,
  });
  const frankingWarnings = result.rows
    .flatMap((row) => row.issues)
    .filter(
      (issue) =>
        issue.code === "SHARESIGHT_PAYOUT_FRANKING_CURRENCY_UNVERIFIED",
    );
  assert.equal(frankingWarnings.length, 0);

  const zeroFranked = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [fakeTrade()],
    payouts: [fakePayout({ frankingCreditsDecimal: "0" })],
    now: FIXED_NOW,
  });
  const zeroWarnings = zeroFranked.rows
    .flatMap((row) => row.issues)
    .filter(
      (issue) =>
        issue.code === "SHARESIGHT_PAYOUT_FRANKING_CURRENCY_UNVERIFIED",
    );
  assert.equal(
    zeroWarnings.length,
    0,
    "an explicit zero franking total must not warn either",
  );

  // Read time: DIV-007 (owner ruling 2026-08-20, superseding this test's
  // original title/behaviour) -- an ABSENT franking field on an imported
  // totals-mode fact derives to $0 (an inference from Sharesight's own
  // demonstrated explicit-zero behaviour), never left as "Unavailable".
  // This is a DIFFERENT case from the nonzero-foreign-unverified guard
  // below, which stays completely untouched (see the next test).
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-zero-frank",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "zero-frank-1",
        paymentDate: "2026-08-05",
        sharesDecimal: null,
        dividendPerShareDecimal: null,
        frankingCreditPerShareDecimal: null,
        totalCashDecimal: "10",
        totalFrankingDecimal: null,
        importBatchId: "batch-zero-frank",
        currencyCode: "USD",
        fxRateToPortfolioDecimal: "2",
        fxRateSource: "sharesight",
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows[0]?.cashDecimal, "20"); // still converts normally
  assert.equal(rows[0]?.frankingTotalDecimal, "0"); // DIV-007: derived, not unknown
  assert.equal(rows[0]?.frankingDerivedZero, true);
});

test("BRK-010: a foreign-currency payout with NONZERO franking stages a warning (never blocking) and its franking becomes unknown at read time; cash still converts", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [fakeTrade()], // default RMD/ASX/AUD
    payouts: [
      fakePayout({ frankingCreditsDecimal: "3.21" }), // USD, nonzero franking
    ],
    now: FIXED_NOW,
  });
  const frankingWarnings = result.rows
    .flatMap((row) => row.issues)
    .filter(
      (issue) =>
        issue.code === "SHARESIGHT_PAYOUT_FRANKING_CURRENCY_UNVERIFIED",
    );
  assert.equal(frankingWarnings.length, 1);
  assert.equal(frankingWarnings[0]?.severity, "warning");
  // Never blocking -- no error-severity issue from this at all.
  const errorIssues = result.rows
    .flatMap((row) => row.issues)
    .filter(
      (issue) =>
        issue.code === "SHARESIGHT_PAYOUT_FRANKING_CURRENCY_UNVERIFIED" &&
        issue.severity === "error",
    );
  assert.equal(errorIssues.length, 0);

  // Read time: franking becomes UNKNOWN (null), cash still converts.
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-nonzero-frank",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "nonzero-frank-1",
        paymentDate: "2026-08-05",
        sharesDecimal: null,
        dividendPerShareDecimal: null,
        frankingCreditPerShareDecimal: null,
        totalCashDecimal: "10",
        totalFrankingDecimal: "3.21",
        importBatchId: "batch-nonzero-frank",
        currencyCode: "USD",
        fxRateToPortfolioDecimal: "2",
        fxRateSource: "sharesight",
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(rows[0]?.cashDecimal, "20"); // cash conversion unaffected
  assert.equal(
    rows[0]?.frankingTotalDecimal,
    null,
    "franking is treated as unknown, never converted, never trusted as-stored",
  );

  // Case C (not achievable) with nonzero franking: franking is STILL nulled
  // even though cash itself is left unconverted/degraded.
  const caseCRows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-nonzero-frank-c",
    securityCurrencyCode: "NZD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "nonzero-frank-c-1",
        paymentDate: "2026-08-05",
        sharesDecimal: null,
        dividendPerShareDecimal: null,
        frankingCreditPerShareDecimal: null,
        totalCashDecimal: "10",
        totalFrankingDecimal: "3.21",
        importBatchId: "batch-nonzero-frank-c",
        currencyCode: "USD",
        fxRateToPortfolioDecimal: "2",
        fxRateSource: "sharesight",
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-19",
  });
  assert.equal(caseCRows[0]?.currencyCode, "USD"); // degraded, true currency shown
  assert.equal(caseCRows[0]?.cashDecimal, "10"); // unconverted (case C)
  assert.equal(caseCRows[0]?.frankingTotalDecimal, null); // still unknown
});

// ---------------------------------------------------------------------------
// F5: same-symbol, two different trade currencies -- blocked, not miscommitted
// ---------------------------------------------------------------------------

test("BRK-010: a same-symbol two-different-trade-currencies ambiguity is blocked, never miscommitted", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(
    database,
    "user-a",
    "portfolio-a",
    {
      portfolios: [fakePortfolio()],
      trades: [
        fakeTrade({ id: "trade-aud" }), // default RMD/ASX/AUD, instrument 2964
        fakeTrade({
          id: "trade-usd",
          currencyCode: "USD",
          quantityDecimal: "5",
          priceDecimal: "20",
          valueDecimal: "100",
        }), // SAME symbol/exchange/instrument id, genuinely different currency
      ],
      payouts: [],
    },
  );

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: { enabled: true, client: sharesightClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  // Exactly one security -- the SECOND (USD) group never gets to create or
  // link a second one; it is blocked outright.
  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(securityCount, 1);

  const staging = createOwnedImportStagingRepository(client);
  const conflictIssues = (
    await staging.listIssues("user-a", synced.batchId)
  ).filter((issue) => issue.code === "SECURITY_RESOLUTION_CONFLICT");
  assert.ok(
    conflictIssues.length > 0,
    "the genuinely disagreeing trade-currency group must surface a real, visible conflict",
  );
  for (const issue of conflictIssues) {
    assert.equal(issue.severity, "error");
    assert.equal(issue.resolvedAt, null);
  }

  // Never miscommitted: the USD trade row never gets a resolved target, so
  // readiness stays blocked -- it can only proceed by being excluded
  // (IMP-008), never by silently posting against the wrong security.
  const { previewVersion, batchVersion } = await currentPreviewVersion(
    client,
    "user-a",
    synced.batchId,
  );
  const readyBlocked = await markImportReadyWithContext(
    { client, userId: "user-a" },
    synced.batchId,
    { expectedVersion: batchVersion, expectedPreviewVersion: previewVersion },
  );
  assert.equal(readyBlocked.ok, false);

  // No transaction was ever posted for the conflicting USD trade row.
  const usdTransactionCount = (
    database
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE user_id = 'user-a' AND quantity_decimal = '5'`,
      )
      .get() as { n: number }
  ).n;
  assert.equal(usdTransactionCount, 0);
});

// ---------------------------------------------------------------------------
// Cross-user isolation
// ---------------------------------------------------------------------------

test("BRK-010: cross-user isolation on any new query", async () => {
  const database = await migratedDatabase();

  // Distinct RAW rates with clean reciprocals ("0.5" -> "2", "0.4" -> "2.5")
  // so the stored (inverted) values stay trivially pinnable per user.
  const userA = await linkedFixture(database, "user-a", "portfolio-a", {
    portfolios: [fakePortfolio()],
    trades: [fakeTrade()],
    payouts: [fakePayout({ exchangeRateDecimal: "0.5" })],
  });
  const userB = await linkedFixture(database, "user-b", "portfolio-b", {
    portfolios: [fakePortfolio()],
    trades: [fakeTrade()],
    payouts: [fakePayout({ exchangeRateDecimal: "0.4" })],
  });

  const syncedA = await runSharesightSyncWithContext(
    { client: userA.client, userId: "user-a", requestId: "sync-a" },
    "portfolio-a",
    {
      integration: { enabled: true, client: userA.sharesightClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(syncedA.ok, true);
  if (!syncedA.ok) return;
  const syncedB = await runSharesightSyncWithContext(
    { client: userB.client, userId: "user-b", requestId: "sync-b" },
    "portfolio-b",
    {
      integration: { enabled: true, client: userB.sharesightClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(syncedB.ok, true);
  if (!syncedB.ok) return;

  // Both users' identical sharesight_instrument evidence legitimately
  // converges on ONE shared canonical security (securities/security_identifiers
  // are a shared master, IMP-004B precedent) -- but every owner-scoped row
  // stays strictly per-user.
  const securityCount = (
    database.prepare("SELECT COUNT(*) AS n FROM securities").get() as {
      n: number;
    }
  ).n;
  assert.equal(securityCount, 1, "shared canonical security, expected");

  await acceptUntilCommitted(
    userA.client,
    "user-a",
    "accept-a",
    syncedA.batchId,
  );
  await acceptUntilCommitted(
    userB.client,
    "user-b",
    "accept-b",
    syncedB.batchId,
  );

  const clientA = userA.client;
  const clientB = userB.client;

  // Each user's own dividend_manual_records.list() never returns the
  // OTHER user's row, even though both reference portfolio_securities rows
  // linked to the same shared security_id -- the new currency_code/
  // fx_rate_to_portfolio_decimal/fx_rate_source columns are exercised on
  // BOTH sides of this owner-scoped query.
  const recordsA = await createDividendManualRecordRepository(clientA).list(
    "user-a",
    "portfolio-a",
  );
  const recordsB = await createDividendManualRecordRepository(clientB).list(
    "user-b",
    "portfolio-b",
  );
  assert.equal(recordsA.length, 1);
  assert.equal(recordsB.length, 1);
  assert.equal(recordsA[0]?.userId, "user-a");
  assert.equal(recordsB[0]?.userId, "user-b");
  // Stored (already-inverted) values: raw "0.5" -> "2", raw "0.4" -> "2.5".
  assert.equal(recordsA[0]?.fxRateToPortfolioDecimal, "2");
  assert.equal(recordsB[0]?.fxRateToPortfolioDecimal, "2.5");
  assert.notEqual(recordsA[0]?.id, recordsB[0]?.id);

  // user-a cannot read user-b's record by id via the owner-scoped get(), and
  // vice versa.
  const crossReadA = await createDividendManualRecordRepository(clientA).get(
    "user-a",
    "portfolio-a",
    recordsB[0]!.id,
  );
  assert.equal(crossReadA, null);
  const crossReadB = await createDividendManualRecordRepository(clientB).get(
    "user-b",
    "portfolio-b",
    recordsA[0]!.id,
  );
  assert.equal(crossReadB, null);
});

// ---------------------------------------------------------------------------
// Migration trigger-hazard check (0042 rebuilds dividend_manual_records)
// ---------------------------------------------------------------------------

test("BRK-010: the three purge-lock triggers on dividend_manual_records survived the currency-columns rebuild migration", async () => {
  const database = await migratedDatabase();
  const triggers = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='dividend_manual_records'",
    )
    .all() as { name: string }[];
  const names = triggers.map((trigger) => trigger.name).sort();
  assert.deepEqual(names, [
    "account_purge_lock_dividend_manual_records_delete",
    "account_purge_lock_dividend_manual_records_insert",
    "account_purge_lock_dividend_manual_records_update",
  ]);
});

test("BRK-010: a pre-existing (legacy) dividend_manual_records row survives the 0042 rebuild with its data intact and the new columns NULL", async () => {
  // Mirrors the 0035/0040 rebuild-preserves-legacy-data precedent: apply
  // every migration up to (not including) 0042, seed a row exactly as a
  // pre-BRK-010 database would have it, THEN apply 0042, and confirm the
  // row's pre-existing data is byte-identical and the three new columns
  // default to NULL (never a fabricated value for pre-existing rows).
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  const migration0042 = files.find((file) => file.startsWith("0042"));
  assert.ok(migration0042, "expected migration 0042 to exist");
  for (const file of files) {
    if (file === migration0042) continue; // apply everything up to 0041 only
    database.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }

  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-legacy', 'active', 'legacy@example.com', 'Australia/Sydney', '2026-01-01', '2026-01-01', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-legacy', 'AUD', 'Australia/Sydney', '2026-01-01', '2026-01-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-legacy', 'user-legacy', 'L', 'Legacy', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-01-01', '2026-01-01', 1);
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('sec-legacy', 'equity', 'AUD', 'Legacy Co', 'active', '2026-01-01', '2026-01-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('ps-legacy', 'user-legacy', 'portfolio-legacy', 'sec-legacy', 'LEG', 'AUD', 'held', '2026-01-01', '2026-01-01');
    INSERT INTO dividend_manual_records (
      id, user_id, portfolio_id, portfolio_security_id, payment_date,
      shares_decimal, dividend_per_share_decimal, franking_credit_per_share_decimal,
      created_at, updated_at, version
    ) VALUES (
      'dmr-legacy', 'user-legacy', 'portfolio-legacy', 'ps-legacy', '2026-01-15',
      '100', '0.50', '0.15',
      '2026-01-15', '2026-01-15', 1
    );
  `);

  // Apply 0042 alone onto this pre-existing (legacy-shaped) database.
  database.exec(
    await readFile(
      new URL(`../drizzle/${migration0042}`, import.meta.url),
      "utf8",
    ),
  );

  const row = database
    .prepare(
      `SELECT shares_decimal, dividend_per_share_decimal, franking_credit_per_share_decimal,
              total_cash_decimal, total_franking_decimal,
              currency_code, fx_rate_to_portfolio_decimal, fx_rate_source, version
       FROM dividend_manual_records WHERE id = 'dmr-legacy'`,
    )
    .get() as
    | {
        shares_decimal: string;
        dividend_per_share_decimal: string;
        franking_credit_per_share_decimal: string;
        total_cash_decimal: string | null;
        total_franking_decimal: string | null;
        currency_code: string | null;
        fx_rate_to_portfolio_decimal: string | null;
        fx_rate_source: string | null;
        version: number;
      }
    | undefined;
  assert.ok(row, "the pre-existing row must survive the rebuild");
  assert.equal(row?.shares_decimal, "100");
  assert.equal(row?.dividend_per_share_decimal, "0.50");
  assert.equal(row?.franking_credit_per_share_decimal, "0.15");
  assert.equal(row?.total_cash_decimal, null);
  assert.equal(row?.total_franking_decimal, null);
  // The new BRK-010 columns default to NULL for a pre-existing row -- never
  // a fabricated currency/rate/source.
  assert.equal(row?.currency_code, null);
  assert.equal(row?.fx_rate_to_portfolio_decimal, null);
  assert.equal(row?.fx_rate_source, null);
  assert.equal(row?.version, 1);
});

// ---------------------------------------------------------------------------
// F3: write-time rejection + read-time per-record isolation
// ---------------------------------------------------------------------------

test("BRK-010: F3 write-time validation rejects a stored FX rate with more than 24 decimal places", () => {
  const overPrecision = {
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "ps-a",
    paymentDate: "2026-08-05",
    totalCashDecimal: "10",
    importBatchId: "batch-a",
    sourceReference: "import-fingerprint:row-a",
    requestId: "req-a",
    now: "2026-08-19T00:00:00.000Z",
    currencyCode: "USD",
    // 25 decimal places -- one over the 24dp limit.
    fxRateToPortfolioDecimal: "1.1234567890123456789012345",
    fxRateSource: "sharesight" as const,
  };
  const result = buildDividendManualRecordImportInsertStatements(overPrecision);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "invalid_input");

  // Exactly 24dp is accepted.
  const exactly24dp = {
    ...overPrecision,
    fxRateToPortfolioDecimal: "1.123456789012345678901234",
  };
  const accepted = buildDividendManualRecordImportInsertStatements(exactly24dp);
  assert.equal(accepted.ok, true);
});

test("BRK-010: F3 read-time isolation -- one record's malformed rate degrades only that record, never aborts the whole derivation", () => {
  const goodRecord: DividendManualRecordFact = {
    id: "good-1",
    paymentDate: "2026-08-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "100",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
    currencyCode: "USD",
    fxRateToPortfolioDecimal: "1.5",
    fxRateSource: "sharesight",
  };
  // A malformed (non-decimal) stored rate -- reachable only via legacy/
  // direct-DB-write data, since write-time validation (above) already
  // rejects this shape going forward.
  const badRecord: DividendManualRecordFact = {
    id: "bad-1",
    paymentDate: "2026-09-05",
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "200",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
    currencyCode: "USD",
    fxRateToPortfolioDecimal: "not-a-decimal",
    fxRateSource: "sharesight",
  };
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps-mixed",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [goodRecord, badRecord],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-09-19",
  });
  assert.equal(
    rows.length,
    2,
    "both records still produce a row -- never aborted",
  );
  // Standalone "imported" tier rows are keyed `imported:<record id>` (see
  // `pushEventlessRow`'s callers), not the bare record id.
  const good = rows.find((row) => row.id === "imported:good-1");
  const bad = rows.find((row) => row.id === "imported:bad-1");
  assert.equal(good?.cashDecimal, "150"); // unaffected by the other record's bad rate
  assert.equal(good?.amountUnknown, false);
  assert.equal(bad?.cashDecimal, null); // this record alone degrades to unavailable
  assert.equal(bad?.amountUnknown, true);
});
