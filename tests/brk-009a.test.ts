import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  linkSharesightPortfolioWithContext,
  runSharesightSyncWithContext,
} from "../app/sharesight-sync-service.ts";
import {
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  parseSharesightHoldings,
  parseSharesightPayouts,
  parseSharesightTrades,
} from "../domain/sharesight/parse.ts";
import type {
  SharesightClient,
  SharesightPayout,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
} from "../domain/sharesight/index.ts";
import { transformSharesightSync } from "../domain/sharesight-sync/transform.ts";
import {
  resolveSecurity,
  type ResolveSecurityCandidateIdentity,
  type SecurityIdentifierCandidateRow,
} from "../domain/securities/resolve-security.ts";

// BRK-009A: (1) optional Sharesight instrument-metadata capture in the parse
// layer, (2) carriage through the sync transform with fingerprint stability,
// (3) a pure multi-scheme security resolver + identifier-scheme unique
// indexes. See TASKS.md's BRK-009A entry for the full ruling set.

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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-18', '2026-08-18', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-18', '2026-08-18', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-18', '2026-08-18', 1);
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
  fixtures: Parameters<typeof fakeSharesightClient>[0] = {
    portfolios: [fakePortfolio()],
  },
): Promise<{ client: SqlClient; sharesightClient: SharesightClient }> {
  const client = createSqliteSqlClient(database);
  const sharesightClient = fakeSharesightClient(fixtures);
  const linked = await linkSharesightPortfolioWithContext(
    { client, userId: "user-a", requestId: "link-req" },
    "portfolio-a",
    { sharesightPortfolioId: "sp-1" },
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(linked.ok, true);
  return { client, sharesightClient };
}

function identifierRow(
  overrides: Partial<SecurityIdentifierCandidateRow> = {},
): SecurityIdentifierCandidateRow {
  return {
    securityId: "sec-a",
    scheme: "ticker",
    value: "ZIP",
    exchangeAlias: "ASX",
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
    symbol: "ZIP",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) Parse layer: holdings/trades instrument.id/instrument.name/instrument.isin
// ---------------------------------------------------------------------------

test("BRK-009A parse: holdings capture instrument.id/instrument.name/instrument.isin when present", async () => {
  const result = await parseSharesightHoldings(
    {
      holdings: [
        {
          id: 9001,
          symbol: "IXJ",
          instrument: {
            code: "IXJ",
            market_code: "ASX",
            currency_code: "AUD",
            id: 4242,
            name: "iShares Global Healthcare (Synthetic)",
            isin: "AU000000IXJ1",
          },
        },
      ],
    },
    "p1",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const holding = result.value[0];
  assert.equal(holding?.sharesightInstrumentId, "4242");
  assert.equal(
    holding?.instrumentName,
    "iShares Global Healthcare (Synthetic)",
  );
  assert.equal(holding?.isin, "AU000000IXJ1");
});

test("BRK-009A parse: holdings instrument.id/instrument.name/instrument.isin absent are an honest null", async () => {
  const result = await parseSharesightHoldings(
    {
      holdings: [
        {
          id: 9001,
          symbol: "IXJ",
          instrument: { code: "IXJ", market_code: "ASX", currency_code: "AUD" },
        },
      ],
    },
    "p1",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const holding = result.value[0];
  assert.equal(holding?.sharesightInstrumentId, null);
  assert.equal(holding?.instrumentName, null);
  assert.equal(holding?.isin, null);
});

// F1 (2026-08-18 reviewer ruling): `instrument.id` is an AUXILIARY matching
// aid, not financial data -- unlike every other malformed-optional field in
// this module, a malformed value must never fail the whole item closed. It
// degrades to `null` (falls back to ticker-tier resolution downstream)
// while the rest of the item still parses normally.

test("BRK-009A parse: holdings instrument.id accepts an integer-shaped STRING and normalizes it", async () => {
  const result = await parseSharesightHoldings(
    {
      holdings: [
        {
          id: 9001,
          symbol: "IXJ",
          instrument: {
            code: "IXJ",
            market_code: "ASX",
            currency_code: "AUD",
            id: "004242",
          },
        },
      ],
    },
    "p1",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value[0]?.sharesightInstrumentId, "4242");
});

test("BRK-009A parse: holdings malformed instrument.id (boolean/object/float) degrades to null -- the item still parses, other fields intact", async () => {
  for (const malformedId of [true, { nested: true }, 42.5]) {
    const result = await parseSharesightHoldings(
      {
        holdings: [
          {
            id: 9001,
            symbol: "IXJ",
            instrument: {
              code: "IXJ",
              market_code: "ASX",
              currency_code: "AUD",
              id: malformedId,
              name: "iShares Global Healthcare (Synthetic)",
            },
          },
        ],
      },
      "p1",
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const holding = result.value[0];
    assert.equal(holding?.sharesightInstrumentId, null);
    // Other fields on the same item are unaffected by the degraded id.
    assert.equal(
      holding?.instrumentName,
      "iShares Global Healthcare (Synthetic)",
    );
    assert.equal(holding?.instrumentCode, "IXJ");
    assert.equal(holding?.marketCode, "ASX");
  }
});

test("BRK-009A parse: holdings malformed instrument.name fails the item closed", async () => {
  const result = await parseSharesightHoldings(
    {
      holdings: [
        {
          id: 9001,
          symbol: "IXJ",
          instrument: {
            code: "IXJ",
            market_code: "ASX",
            currency_code: "AUD",
            name: 12345,
          },
        },
      ],
    },
    "p1",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.itemFailure, {
    itemIndex: 0,
    fieldName: "instrument.name",
    reason: "wrong_type",
  });
});

test("BRK-009A parse: holdings malformed instrument.isin fails the item closed", async () => {
  const result = await parseSharesightHoldings(
    {
      holdings: [
        {
          id: 9001,
          symbol: "IXJ",
          instrument: {
            code: "IXJ",
            market_code: "ASX",
            currency_code: "AUD",
            isin: false,
          },
        },
      ],
    },
    "p1",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.itemFailure, {
    itemIndex: 0,
    fieldName: "instrument.isin",
    reason: "wrong_type",
  });
});

test("BRK-009A parse: trades capture instrument.id/instrument.name/instrument.isin when present", async () => {
  const result = await parseSharesightTrades(
    {
      trades: [
        {
          id: 5001,
          instrument: {
            code: "WHC",
            market_code: "ASX",
            currency_code: "AUD",
            id: 7788,
            name: "Whitehaven Coal (Synthetic)",
            isin: "AU000000WHC5",
          },
          transaction_date: "2026-01-15",
          quantity: 50,
          price: "5.20",
          holding_id: 4001,
          portfolio_id: 3001,
        },
      ],
    },
    "3001",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const trade = result.value[0];
  assert.equal(trade?.sharesightInstrumentId, "7788");
  assert.equal(trade?.instrumentName, "Whitehaven Coal (Synthetic)");
  assert.equal(trade?.isin, "AU000000WHC5");
});

test("BRK-009A parse: trades instrument.id/instrument.name/instrument.isin absent are an honest null", async () => {
  const result = await parseSharesightTrades(
    {
      trades: [
        {
          id: 5001,
          instrument: { code: "WHC", market_code: "ASX", currency_code: "AUD" },
          transaction_date: "2026-01-15",
          quantity: 50,
          price: "5.20",
          holding_id: 4001,
          portfolio_id: 3001,
        },
      ],
    },
    "3001",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const trade = result.value[0];
  assert.equal(trade?.sharesightInstrumentId, null);
  assert.equal(trade?.instrumentName, null);
  assert.equal(trade?.isin, null);
});

// F1 (2026-08-18 reviewer ruling): see the equivalent holdings block above
// for why a malformed `instrument.id` degrades to `null` here too, rather
// than failing the item closed.

test("BRK-009A parse: trades instrument.id accepts an integer-shaped STRING and normalizes it", async () => {
  const result = await parseSharesightTrades(
    {
      trades: [
        {
          id: 5001,
          instrument: {
            code: "WHC",
            market_code: "ASX",
            currency_code: "AUD",
            id: "007788",
          },
          transaction_date: "2026-01-15",
          quantity: 50,
          price: "5.20",
          holding_id: 4001,
          portfolio_id: 3001,
        },
      ],
    },
    "3001",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value[0]?.sharesightInstrumentId, "7788");
});

test("BRK-009A parse: trades malformed instrument.id (boolean/object/float) degrades to null -- the item still parses, other fields intact", async () => {
  for (const malformedId of [false, ["nested"], -1, 3.14]) {
    const result = await parseSharesightTrades(
      {
        trades: [
          {
            id: 5001,
            instrument: {
              code: "WHC",
              market_code: "ASX",
              currency_code: "AUD",
              id: malformedId,
            },
            transaction_date: "2026-01-15",
            quantity: 50,
            price: "5.20",
            holding_id: 4001,
            portfolio_id: 3001,
          },
        ],
      },
      "3001",
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const trade = result.value[0];
    assert.equal(trade?.sharesightInstrumentId, null);
    assert.equal(trade?.instrumentCode, "WHC");
    assert.equal(trade?.quantityDecimal, "50");
  }
});

test("BRK-009A parse: trades malformed instrument.name fails the item closed", async () => {
  const result = await parseSharesightTrades(
    {
      trades: [
        {
          id: 5001,
          instrument: {
            code: "WHC",
            market_code: "ASX",
            currency_code: "AUD",
            name: { nested: true },
          },
          transaction_date: "2026-01-15",
          quantity: 50,
          price: "5.20",
          holding_id: 4001,
          portfolio_id: 3001,
        },
      ],
    },
    "3001",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.itemFailure, {
    itemIndex: 0,
    fieldName: "instrument.name",
    reason: "wrong_type",
  });
});

test("BRK-009A parse: trades malformed instrument.isin fails the item closed", async () => {
  const result = await parseSharesightTrades(
    {
      trades: [
        {
          id: 5001,
          instrument: {
            code: "WHC",
            market_code: "ASX",
            currency_code: "AUD",
            isin: 42,
          },
          transaction_date: "2026-01-15",
          quantity: 50,
          price: "5.20",
          holding_id: 4001,
          portfolio_id: 3001,
        },
      ],
    },
    "3001",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.error.itemFailure, {
    itemIndex: 0,
    fieldName: "instrument.isin",
    reason: "wrong_type",
  });
});

// ---------------------------------------------------------------------------
// (1) Parse layer: payouts' flat instrument_id
// ---------------------------------------------------------------------------

test("BRK-009A parse: payouts capture instrument_id when present", async () => {
  const result = await parseSharesightPayouts(
    {
      payouts: [
        {
          id: 6001,
          holding_id: 4001,
          instrument_id: 1234,
          portfolio_id: 3001,
          paid_on: "2026-02-01",
          symbol: "IXJ",
          market: "ASX",
          currency: "AUD",
          amount: 120.0,
          gross_amount: 171.43,
        },
      ],
    },
    "3001",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value[0]?.sharesightInstrumentId, "1234");
});

test("BRK-009A parse: payouts instrument_id absent is an honest null", async () => {
  const result = await parseSharesightPayouts(
    {
      payouts: [
        {
          id: 6001,
          holding_id: 4001,
          portfolio_id: 3001,
          paid_on: "2026-02-01",
          symbol: "IXJ",
          market: "ASX",
          currency: "AUD",
          amount: 120.0,
          gross_amount: 171.43,
        },
      ],
    },
    "3001",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value[0]?.sharesightInstrumentId, null);
});

// F1 (2026-08-18 reviewer ruling): see the equivalent holdings/trades blocks
// above for why a malformed payout `instrument_id` degrades to `null` here
// too, rather than failing the item closed.

test("BRK-009A parse: payouts instrument_id accepts an integer-shaped STRING and normalizes it", async () => {
  const result = await parseSharesightPayouts(
    {
      payouts: [
        {
          id: 6001,
          holding_id: 4001,
          instrument_id: "001234",
          portfolio_id: 3001,
          paid_on: "2026-02-01",
          symbol: "IXJ",
          market: "ASX",
          currency: "AUD",
          amount: 120.0,
          gross_amount: 171.43,
        },
      ],
    },
    "3001",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value[0]?.sharesightInstrumentId, "1234");
});

test("BRK-009A parse: payouts malformed instrument_id (boolean/object/float/non-digit string) degrades to null -- the item still parses, other fields intact", async () => {
  for (const malformedId of [true, { nested: true }, 42.5, "not-a-number"]) {
    const result = await parseSharesightPayouts(
      {
        payouts: [
          {
            id: 6001,
            holding_id: 4001,
            instrument_id: malformedId,
            portfolio_id: 3001,
            paid_on: "2026-02-01",
            symbol: "IXJ",
            market: "ASX",
            currency: "AUD",
            amount: 120.0,
            gross_amount: 171.43,
          },
        ],
      },
      "3001",
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const payout = result.value[0];
    assert.equal(payout?.sharesightInstrumentId, null);
    assert.equal(payout?.symbol, "IXJ");
    assert.equal(payout?.amountDecimal, "120");
  }
});

// ---------------------------------------------------------------------------
// (2) Transform: field carriage + fingerprint/digest stability
// ---------------------------------------------------------------------------

test("BRK-009A transform: trade rows carry instrument metadata into normalized fields when present", () => {
  const trade = fakeTrade({
    id: "trade-meta",
    sharesightInstrumentId: "777",
    instrumentName: "Test Co",
    isin: "AU000TEST001",
  });
  const result = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [trade],
    payouts: [],
    now: "2026-08-18T00:00:00.000Z",
  });
  const row = result.rows[0];
  assert.equal(row?.normalized.sharesightInstrumentId, "777");
  assert.equal(row?.normalized.instrumentName, "Test Co");
  assert.equal(row?.normalized.isin, "AU000TEST001");
});

test("BRK-009A transform: trade rows carry null instrument metadata when absent", () => {
  const trade = fakeTrade({ id: "trade-no-meta" });
  const result = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [trade],
    payouts: [],
    now: "2026-08-18T00:00:00.000Z",
  });
  const row = result.rows[0];
  assert.equal(row?.normalized.sharesightInstrumentId, null);
  assert.equal(row?.normalized.instrumentName, null);
  assert.equal(row?.normalized.isin, null);
});

test("BRK-009A transform: payout rows carry sharesightInstrumentId when present, instrumentName and isin always null", () => {
  const payout = fakePayout({
    id: "9999",
    sharesightInstrumentId: "555",
  });
  const result = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [],
    payouts: [payout],
    now: "2026-08-18T00:00:00.000Z",
  });
  const row = result.rows[0];
  assert.equal(row?.normalized.sharesightInstrumentId, "555");
  assert.equal(row?.normalized.instrumentName, null);
  assert.equal(row?.normalized.isin, null);
});

test("BRK-009A transform: row fingerprints are byte-identical whether instrument metadata is present or absent", () => {
  const withoutMetadata = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [fakeTrade({ id: "trade-fp" })],
    payouts: [
      fakePayout({
        id: "9001",
        holdingId: "holding-1",
        paidOnDate: "2026-08-05",
      }),
    ],
    now: "2026-08-18T00:00:00.000Z",
  });
  const withMetadata = transformSharesightSync({
    portfolioName: "Main",
    portfolioBaseCurrencyCode: "AUD",
    trades: [
      fakeTrade({
        id: "trade-fp",
        sharesightInstrumentId: "42",
        instrumentName: "Something",
        isin: "AU0001112223",
      }),
    ],
    payouts: [
      fakePayout({
        id: "9001",
        holdingId: "holding-1",
        paidOnDate: "2026-08-05",
        sharesightInstrumentId: "43",
      }),
    ],
    now: "2026-08-18T00:00:00.000Z",
  });
  assert.equal(
    withoutMetadata.rows[0]?.fingerprint,
    "sharesight-trade:trade-fp",
  );
  assert.equal(
    withMetadata.rows[0]?.fingerprint,
    withoutMetadata.rows[0]?.fingerprint,
  );
  assert.equal(
    withMetadata.rows[1]?.fingerprint,
    withoutMetadata.rows[1]?.fingerprint,
  );
});

test("BRK-009A sync: the batch digest (file fingerprint) is byte-identical whether instrument metadata is present or absent", async () => {
  // Proves `app/sharesight-sync-service.ts`'s `canonicalRowDigestFields`/
  // `canonicalFetchDigestSource` (deliberately UNTOUCHED by BRK-009A) never
  // read the new optional fields: syncing the identical core trade data
  // twice -- once with instrument metadata absent (what every batch looked
  // like before this task), once with it present -- must resolve to the
  // SAME batch (`reused: true`), which can only happen if the two runs'
  // SHA-256 digests are byte-identical.
  const database = await migratedDatabase();
  const baseTrade = {
    id: "trade-digest",
    portfolioId: "sp-1",
    holdingId: "holding-1",
    instrumentCode: "ABC",
    marketCode: "ASX",
    transactionType: "buy" as const,
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
  };
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [
      {
        ...baseTrade,
        sharesightInstrumentId: null,
        instrumentName: null,
        isin: null,
      },
    ],
    payouts: [],
  });
  const integration = { enabled: true as const, client: sharesightClient };

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const metaClient = fakeSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [
      {
        ...baseTrade,
        sharesightInstrumentId: "999",
        instrumentName: "Test Co",
        isin: "AU000TEST001",
      },
    ],
    payouts: [],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: { enabled: true, client: metaClient } },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(
    second.reused,
    true,
    "identical core trade data with only instrument metadata differing must resolve to the SAME batch",
  );
  assert.equal(second.batchId, first.batchId);
});

// ---------------------------------------------------------------------------
// (3) Resolver: domain/securities/resolve-security.ts
// ---------------------------------------------------------------------------

test("BRK-009A resolver: sharesight_instrument tier matches", () => {
  const identity = candidateIdentity({ sharesightInstrumentId: "555" });
  const identifiers = [
    identifierRow({
      scheme: "sharesight_instrument",
      value: "555",
      exchangeAlias: null,
      securityId: "sec-a",
    }),
  ];
  assert.deepEqual(resolveSecurity(identity, identifiers), {
    outcome: "matched",
    securityId: "sec-a",
    tier: "sharesight_instrument",
  });
});

test("BRK-009A resolver: isin tier matches", () => {
  const identity = candidateIdentity({ isin: "AU000000IXJ1" });
  const identifiers = [
    identifierRow({
      scheme: "isin",
      value: "AU000000IXJ1",
      exchangeAlias: null,
      securityId: "sec-a",
    }),
  ];
  assert.deepEqual(resolveSecurity(identity, identifiers), {
    outcome: "matched",
    securityId: "sec-a",
    tier: "isin",
  });
});

test("BRK-009A resolver: figi tier matches", () => {
  const identity = candidateIdentity({ figi: "BBG000BLNNH6" });
  const identifiers = [
    identifierRow({
      scheme: "figi",
      value: "BBG000BLNNH6",
      exchangeAlias: null,
      securityId: "sec-a",
    }),
  ];
  assert.deepEqual(resolveSecurity(identity, identifiers), {
    outcome: "matched",
    securityId: "sec-a",
    tier: "figi",
  });
});

test("BRK-009A resolver: active ticker+exchange tier matches (case-insensitive)", () => {
  const identity = candidateIdentity({ symbol: "zip", exchangeAlias: "asx" });
  const identifiers = [
    identifierRow({
      scheme: "ticker",
      value: "ZIP",
      exchangeAlias: "ASX",
      validTo: null,
    }),
  ];
  assert.deepEqual(resolveSecurity(identity, identifiers), {
    outcome: "matched",
    securityId: "sec-a",
    tier: "ticker_active",
  });
});

test("BRK-009A resolver: historical ticker+exchange tier matches (Z1P renamed to ZIP)", () => {
  const identity = candidateIdentity({ symbol: "Z1P", exchangeAlias: "ASX" });
  const identifiers = [
    identifierRow({
      scheme: "ticker",
      value: "ZIP",
      exchangeAlias: "ASX",
      validTo: null,
    }),
    identifierRow({
      scheme: "ticker",
      value: "Z1P",
      exchangeAlias: "ASX",
      validFrom: "2015-01-01",
      validTo: "2020-01-01",
    }),
  ];
  assert.deepEqual(resolveSecurity(identity, identifiers), {
    outcome: "matched",
    securityId: "sec-a",
    tier: "ticker_historical",
  });
});

test("BRK-009A resolver: tier precedence -- sharesight_instrument beats ticker for the same security", () => {
  const identity = candidateIdentity({ sharesightInstrumentId: "555" });
  const identifiers = [
    identifierRow({
      scheme: "sharesight_instrument",
      value: "555",
      exchangeAlias: null,
      securityId: "sec-a",
    }),
    identifierRow({
      scheme: "ticker",
      value: "ZIP",
      exchangeAlias: "ASX",
      validTo: null,
      securityId: "sec-a",
    }),
  ];
  const outcome = resolveSecurity(identity, identifiers);
  assert.equal(outcome.outcome, "matched");
  if (outcome.outcome === "matched") {
    assert.equal(outcome.tier, "sharesight_instrument");
    assert.equal(outcome.securityId, "sec-a");
  }
});

test("BRK-009A resolver: currency disagreement on an otherwise-matching tier is a conflict, not a skip", () => {
  const identity = candidateIdentity({
    isin: "AU000000IXJ1",
    currencyCode: "AUD",
  });
  const identifiers = [
    identifierRow({
      scheme: "isin",
      value: "AU000000IXJ1",
      exchangeAlias: null,
      securityId: "sec-a",
      primaryCurrencyCode: "USD",
    }),
  ];
  assert.deepEqual(resolveSecurity(identity, identifiers), {
    outcome: "conflict",
    tiers: ["isin"],
    securityIds: ["sec-a"],
  });
});

test("BRK-009A resolver: two tiers resolving to different securities is a conflict", () => {
  const identity = candidateIdentity({
    sharesightInstrumentId: "555",
    isin: "AU000000IXJ1",
  });
  const identifiers = [
    identifierRow({
      scheme: "sharesight_instrument",
      value: "555",
      exchangeAlias: null,
      securityId: "sec-a",
    }),
    identifierRow({
      scheme: "isin",
      value: "AU000000IXJ1",
      exchangeAlias: null,
      securityId: "sec-b",
    }),
  ];
  assert.deepEqual(resolveSecurity(identity, identifiers), {
    outcome: "conflict",
    tiers: ["sharesight_instrument", "isin"],
    securityIds: ["sec-a", "sec-b"],
  });
});

test("BRK-009A resolver: two rows within the same tier resolving to different securities is a conflict", () => {
  const identity = candidateIdentity({ sharesightInstrumentId: "555" });
  const identifiers = [
    identifierRow({
      scheme: "sharesight_instrument",
      value: "555",
      exchangeAlias: null,
      securityId: "sec-a",
    }),
    identifierRow({
      scheme: "sharesight_instrument",
      value: "555",
      exchangeAlias: null,
      securityId: "sec-b",
    }),
  ];
  assert.deepEqual(resolveSecurity(identity, identifiers), {
    outcome: "conflict",
    tiers: ["sharesight_instrument"],
    securityIds: ["sec-a", "sec-b"],
  });
});

test("BRK-009A resolver: same ticker text on a different exchange never matches", () => {
  const identity = candidateIdentity({ symbol: "ZIP", exchangeAlias: "ASX" });
  const identifiers = [
    identifierRow({
      scheme: "ticker",
      value: "ZIP",
      exchangeAlias: "NZX",
      validTo: null,
    }),
  ];
  assert.deepEqual(resolveSecurity(identity, identifiers), {
    outcome: "no_match",
  });
});

test("BRK-009A resolver: a ticker match with no exchange evidence at all never matches", () => {
  const identity = candidateIdentity({ symbol: "ZIP", exchangeAlias: null });
  const identifiers = [
    identifierRow({
      scheme: "ticker",
      value: "ZIP",
      exchangeAlias: "ASX",
      validTo: null,
    }),
  ];
  assert.deepEqual(resolveSecurity(identity, identifiers), {
    outcome: "no_match",
  });
});

test("BRK-009A resolver: no identifying evidence at all resolves to no match", () => {
  const identity = candidateIdentity({ symbol: "ZIP", exchangeAlias: "ASX" });
  assert.deepEqual(resolveSecurity(identity, []), { outcome: "no_match" });
});

// ---------------------------------------------------------------------------
// (3) Migration: partial unique indexes for the new identifier schemes
// ---------------------------------------------------------------------------

function insertSecurity(database: DatabaseSync, id: string): void {
  database
    .prepare(
      `INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
       VALUES (?, 'equity', 'AUD', ?, 'active', '2026-08-18', '2026-08-18')`,
    )
    .run(id, `Security ${id}`);
}

function insertIdentifier(
  database: DatabaseSync,
  row: {
    id: string;
    securityId: string;
    scheme: string;
    value: string;
    validFrom: string;
    validTo: string | null;
    source?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, valid_to, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.securityId,
      row.scheme,
      row.value,
      row.validFrom,
      row.validTo,
      row.source ?? "sharesight",
    );
}

test("BRK-009A migration: full chain applies cleanly and creates the three new partial unique indexes", async () => {
  const database = await migratedDatabase();
  const names = database
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'security_identifiers_%unique'`,
    )
    .all() as { name: string }[];
  const indexNames = names.map((row) => row.name).sort();
  assert.deepEqual(indexNames, [
    "security_identifiers_figi_scheme_unique",
    "security_identifiers_isin_scheme_unique",
    "security_identifiers_owner_attested_ticker_unique",
    "security_identifiers_sharesight_instrument_unique",
  ]);
});

test("BRK-009A migration: security_identifiers_sharesight_instrument_unique rejects a second active row for the same value", async () => {
  const database = await migratedDatabase();
  insertSecurity(database, "sec-a");
  insertSecurity(database, "sec-b");
  insertIdentifier(database, {
    id: "id-1",
    securityId: "sec-a",
    scheme: "sharesight_instrument",
    value: "555",
    validFrom: "2026-08-18",
    validTo: null,
  });
  assert.throws(() => {
    insertIdentifier(database, {
      id: "id-2",
      securityId: "sec-b",
      scheme: "sharesight_instrument",
      value: "555",
      validFrom: "2026-08-18",
      validTo: null,
    });
  });
});

test("BRK-009A migration: security_identifiers_isin_scheme_unique rejects a second active row for the same value", async () => {
  const database = await migratedDatabase();
  insertSecurity(database, "sec-a");
  insertSecurity(database, "sec-b");
  insertIdentifier(database, {
    id: "id-1",
    securityId: "sec-a",
    scheme: "isin",
    value: "AU000000IXJ1",
    validFrom: "2026-08-18",
    validTo: null,
  });
  assert.throws(() => {
    insertIdentifier(database, {
      id: "id-2",
      securityId: "sec-b",
      scheme: "isin",
      value: "AU000000IXJ1",
      validFrom: "2026-08-18",
      validTo: null,
    });
  });
});

test("BRK-009A migration: security_identifiers_figi_scheme_unique rejects a second active row for the same value", async () => {
  const database = await migratedDatabase();
  insertSecurity(database, "sec-a");
  insertSecurity(database, "sec-b");
  insertIdentifier(database, {
    id: "id-1",
    securityId: "sec-a",
    scheme: "figi",
    value: "BBG000BLNNH6",
    validFrom: "2026-08-18",
    validTo: null,
  });
  assert.throws(() => {
    insertIdentifier(database, {
      id: "id-2",
      securityId: "sec-b",
      scheme: "figi",
      value: "BBG000BLNNH6",
      validFrom: "2026-08-18",
      validTo: null,
    });
  });
});

test("BRK-009A migration: a closed (historical) row does not block a new active row for the same value", async () => {
  const database = await migratedDatabase();
  insertSecurity(database, "sec-a");
  insertSecurity(database, "sec-b");
  insertIdentifier(database, {
    id: "id-1",
    securityId: "sec-a",
    scheme: "sharesight_instrument",
    value: "555",
    validFrom: "2026-01-01",
    validTo: "2026-06-01",
  });
  // Does not throw: the closed row is outside the partial index's
  // `WHERE valid_to IS NULL` scope.
  insertIdentifier(database, {
    id: "id-2",
    securityId: "sec-b",
    scheme: "sharesight_instrument",
    value: "555",
    validFrom: "2026-06-01",
    validTo: null,
  });
  const rows = database
    .prepare(
      `SELECT security_id FROM security_identifiers WHERE scheme = 'sharesight_instrument' AND value = '555' ORDER BY valid_from`,
    )
    .all() as { security_id: string }[];
  assert.deepEqual(
    rows.map((row) => row.security_id),
    ["sec-a", "sec-b"],
  );
});

test("BRK-009A migration idempotent re-apply: 0039 applies cleanly onto a database already migrated through 0038", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (file.startsWith("0039")) continue; // apply everything up to 0038 only
    database.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  const migration0039 = files.find((file) => file.startsWith("0039"));
  assert.ok(migration0039, "expected migration 0039 to exist");
  // Applying 0039 alone onto an already-0038 database must not throw.
  database.exec(
    await readFile(
      new URL(`../drizzle/${migration0039}`, import.meta.url),
      "utf8",
    ),
  );
  database.exec(
    `INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
     VALUES ('AUD', 36, 'Australian dollar', 2, 1);`,
  );
  insertSecurity(database, "sec-a");
  insertSecurity(database, "sec-b");
  insertIdentifier(database, {
    id: "id-1",
    securityId: "sec-a",
    scheme: "figi",
    value: "BBG000BLNNH6",
    validFrom: "2026-08-18",
    validTo: null,
  });
  assert.throws(() => {
    insertIdentifier(database, {
      id: "id-2",
      securityId: "sec-b",
      scheme: "figi",
      value: "BBG000BLNNH6",
      validFrom: "2026-08-18",
      validTo: null,
    });
  });
});
