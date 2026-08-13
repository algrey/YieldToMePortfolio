/** MKT-005 — corporate-action and dividend provider capability. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createCorporateActionRefreshRepository,
  createDividendEventOverrideRepository,
  createDividendEventRepository,
  createSplitEventRepository,
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  collectEventLineageIds,
  createYahooCompatibleProvider,
  deriveTrailingDividendYield,
  deriveTrailingTwelveMonthDividend,
  ingestSecurityCorporateActionHistory,
  runDueCorporateActionRefresh,
  type DividendEventInput,
  type MarketDataProvider,
  type SplitEventInput,
  type TrailingDividendEventInput,
} from "../domain/market-data/index.ts";
import {
  australianDividendSplitChartFixture,
  malformedDividendChartFixture,
  noEventsChartFixture,
  usDividendSplitChartFixture,
} from "./fixtures/yahoo-compatible.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function providerFor(body: unknown, symbol = "BHP.AX"): MarketDataProvider {
  return createYahooCompatibleProvider({
    baseUrl: "https://provider.test",
    providerId: "yahoo-compatible",
    fetcher: async () => jsonResponse(body),
    resolveSymbol: async () => symbol,
    now: () => "2026-08-13T00:00:00Z",
  });
}

function emptySummary() {
  return {
    created: 0,
    superseded: 0,
    statusUpdated: 0,
    unchanged: 0,
    droppedDuplicates: 0,
  };
}

// ---------------------------------------------------------------------------
// Adapter: parse/validate the events payload.
// ---------------------------------------------------------------------------

test("yahoo-compatible adapter normalizes dividend and split events within the requested range", async () => {
  const provider = providerFor(australianDividendSplitChartFixture);
  assert.equal(provider.capabilities().supportsDividends, true);
  assert.equal(provider.capabilities().supportsSplits, true);

  const dividends = await provider.getDividendEvents({
    mappingId: "mapping-au",
    securityId: "security-bhp",
    from: "2026-01-01",
    to: "2026-12-31",
    scope: { kind: "deployment", userId: null },
  });
  assert.equal(dividends.ok, true);
  if (dividends.ok) {
    assert.equal(dividends.value.length, 1);
    assert.deepEqual(dividends.value[0], {
      securityId: "security-bhp",
      exDate: "2026-03-05",
      paymentDate: null,
      currencyCode: "AUD",
      amountDecimal: "1.01",
    });
  }

  const splits = await provider.getSplitEvents({
    mappingId: "mapping-au",
    securityId: "security-bhp",
    from: "2026-01-01",
    to: "2026-12-31",
    scope: { kind: "deployment", userId: null },
  });
  assert.equal(splits.ok, true);
  if (splits.ok) {
    assert.equal(splits.value.length, 1);
    assert.deepEqual(splits.value[0], {
      securityId: "security-bhp",
      effectiveDate: "2026-05-01",
      numeratorDecimal: "2",
      denominatorDecimal: "1",
    });
  }
});

test("a dividend event outside the requested range is excluded", async () => {
  const provider = providerFor(australianDividendSplitChartFixture);
  const dividends = await provider.getDividendEvents({
    mappingId: "mapping-au",
    securityId: "security-bhp",
    from: "2026-06-01",
    to: "2026-12-31",
    scope: { kind: "deployment", userId: null },
  });
  assert.equal(dividends.ok, true);
  if (dividends.ok) assert.equal(dividends.value.length, 0);
});

test("a malformed dividend entry fails closed rather than guessing", async () => {
  const provider = providerFor(malformedDividendChartFixture);
  const dividends = await provider.getDividendEvents({
    mappingId: "mapping-au",
    securityId: "security-bhp",
    from: "2026-01-01",
    to: "2026-12-31",
    scope: { kind: "deployment", userId: null },
  });
  assert.equal(dividends.ok, false);
  if (!dividends.ok) assert.equal(dividends.error.kind, "invalid_response");
});

test("a chart response with no events field is an explicit empty history, not an error", async () => {
  const provider = providerFor(noEventsChartFixture);
  const dividends = await provider.getDividendEvents({
    mappingId: "mapping-au",
    securityId: "security-bhp",
    from: "2026-01-01",
    to: "2026-12-31",
    scope: { kind: "deployment", userId: null },
  });
  assert.equal(dividends.ok, true);
  if (dividends.ok) assert.equal(dividends.value.length, 0);
  const splits = await provider.getSplitEvents({
    mappingId: "mapping-au",
    securityId: "security-bhp",
    from: "2026-01-01",
    to: "2026-12-31",
    scope: { kind: "deployment", userId: null },
  });
  assert.equal(splits.ok, true);
  if (splits.ok) assert.equal(splits.value.length, 0);
});

test("a US (America/New_York) dividend ex-date is computed in the exchange timezone, not the UTC calendar date", async () => {
  const provider = providerFor(usDividendSplitChartFixture, "AAPL");
  const dividends = await provider.getDividendEvents({
    mappingId: "mapping-us",
    securityId: "security-aapl",
    from: "2026-01-01",
    to: "2026-12-31",
    scope: { kind: "deployment", userId: null },
  });
  assert.equal(dividends.ok, true);
  if (dividends.ok) {
    assert.equal(dividends.value.length, 1);
    // 2026-03-05T02:00:00Z is still 2026-03-04 local in America/New_York
    // (EST, UTC-5, before the 2026 DST transition on March 8) -- the raw
    // UTC calendar date would wrongly say "2026-03-05".
    assert.equal(dividends.value[0]?.exDate, "2026-03-04");
  }
});

test("B5: a splits-bearing chart response still yields raw, unadjusted daily prices (no double-application path)", async () => {
  const provider = providerFor(australianDividendSplitChartFixture);
  assert.equal(provider.capabilities().supportsAdjustedPrices, false);
  const daily = await provider.getDailyPrices({
    mappingId: "mapping-au",
    securityId: "security-bhp",
    from: "2026-07-28",
    to: "2026-07-29",
    scope: { kind: "deployment", userId: null },
  });
  assert.equal(daily.ok, true);
  if (daily.ok) {
    assert.ok(daily.value.length > 0);
    for (const observation of daily.value) {
      assert.equal(observation.adjustmentState, "raw");
      assert.equal(observation.adjustmentFactor, null);
    }
  }
});

// ---------------------------------------------------------------------------
// Trailing twelve-month derivation and yield.
// ---------------------------------------------------------------------------

function cashPaid(
  exDate: string,
  grossPerShareDecimal: string,
  currencyCode = "AUD",
): TrailingDividendEventInput {
  return {
    exDate,
    currencyCode,
    grossPerShareDecimal,
    kind: "cash",
    status: "paid",
  };
}

test("TTM sums actual trailing-window events without extrapolating", async () => {
  const events: TrailingDividendEventInput[] = [
    cashPaid("2026-02-01", "0.50"),
    cashPaid("2026-05-01", "0.60"),
    cashPaid("2025-06-01", "9.99"), // outside the trailing 365-day window
  ];
  const result = deriveTrailingTwelveMonthDividend(events, "2026-08-13");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.ttmPerShareDecimal, "1.1");
    assert.equal(result.eventCount, 2);
    assert.equal(result.currencyCode, "AUD");
  }
});

test("zero qualifying events is insufficient_history, never zero or a guess", async () => {
  const result = deriveTrailingTwelveMonthDividend([], "2026-08-13");
  assert.deepEqual(result, { ok: false, reason: "insufficient_history" });

  const onlyEstimated = deriveTrailingTwelveMonthDividend(
    [
      {
        exDate: "2026-05-01",
        currencyCode: "AUD",
        grossPerShareDecimal: "1",
        kind: "cash",
        status: "estimated",
      },
    ],
    "2026-08-13",
  );
  assert.deepEqual(onlyEstimated, {
    ok: false,
    reason: "insufficient_history",
  });

  const onlySpecial = deriveTrailingTwelveMonthDividend(
    [
      {
        exDate: "2026-05-01",
        currencyCode: "AUD",
        grossPerShareDecimal: "1",
        kind: "special",
        status: "paid",
      },
    ],
    "2026-08-13",
  );
  assert.deepEqual(onlySpecial, { ok: false, reason: "insufficient_history" });
});

test("mixed currency within the window is an explicit typed reason", async () => {
  const result = deriveTrailingTwelveMonthDividend(
    [
      cashPaid("2026-02-01", "0.50", "AUD"),
      cashPaid("2026-05-01", "0.60", "USD"),
    ],
    "2026-08-13",
  );
  assert.deepEqual(result, { ok: false, reason: "mixed_currency" });
});

test("trailing yield divides TTM by a caller-supplied price and reports typed unavailable states", async () => {
  const events: TrailingDividendEventInput[] = [
    cashPaid("2026-02-01", "1"),
    cashPaid("2026-05-01", "1"),
  ];

  const withPrice = deriveTrailingDividendYield(events, "2026-08-13", {
    amountDecimal: "40",
    currencyCode: "AUD",
  });
  assert.equal(withPrice.ok, true);
  if (withPrice.ok) {
    assert.equal(withPrice.ttmPerShareDecimal, "2");
    assert.equal(withPrice.trailingYieldPercentDecimal, "5.000000");
  }

  const noPrice = deriveTrailingDividendYield(events, "2026-08-13", null);
  assert.deepEqual(noPrice, { ok: false, reason: "price_unavailable" });

  const mismatchedCurrency = deriveTrailingDividendYield(events, "2026-08-13", {
    amountDecimal: "40",
    currencyCode: "USD",
  });
  assert.deepEqual(mismatchedCurrency, {
    ok: false,
    reason: "currency_mismatch",
  });

  const insufficient = deriveTrailingDividendYield([], "2026-08-13", {
    amountDecimal: "40",
    currencyCode: "AUD",
  });
  assert.deepEqual(insufficient, { ok: false, reason: "insufficient_history" });
});

// ---------------------------------------------------------------------------
// collectEventLineageIds: pure lineage-walk helper (B3).
// ---------------------------------------------------------------------------

test("collectEventLineageIds walks the supersession chain back to the original event", async () => {
  const events = [
    { id: "v3", supersedesEventId: "v2" },
    { id: "v2", supersedesEventId: "v1" },
    { id: "v1", supersedesEventId: null },
  ];
  assert.deepEqual(collectEventLineageIds(events, "v3"), ["v3", "v2", "v1"]);
  assert.deepEqual(collectEventLineageIds(events, "v1"), ["v1"]);
  assert.deepEqual(collectEventLineageIds(events, "unknown-id"), [
    "unknown-id",
  ]);
});

// ---------------------------------------------------------------------------
// Ingestion: create / re-pull-unchanged / re-pull-changed (supersession) /
// lifecycle status transitions / concurrent-conflict recovery / owner
// overrides untouched.
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
  return database;
}

async function ownedFixtureClient(): Promise<{
  database: DatabaseSync;
  client: SqlClient;
}> {
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('security-bhp', 'equity', 'AUD', 'BHP Group', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, status, created_at, updated_at)
    VALUES ('ps-a', 'user-a', 'portfolio-a', 'security-bhp', 'BHP.AX', 'AUD', 'held', '2026-08-01', '2026-08-01');
    INSERT INTO market_data_providers (id, code, name, status, capabilities_json, rate_limit_json)
    VALUES ('yahoo-compatible', 'yahoo-best-effort', 'Yahoo', 'enabled', '{}', '{}');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status, verified_by_user_id, verified_at)
    VALUES ('mapping-bhp', 'security-bhp', 'yahoo-compatible', 'ASX', 'BHP.AX', '2026-08-01', 'verified', 'user-a', '2026-08-01T00:00:00Z');
  `);
  return { database, client: createSqliteSqlClient(database) };
}

function providerWithEvents(
  dividends: DividendEventInput[],
  splits: SplitEventInput[],
  calls: { mappingId: string; securityId: string }[] = [],
): MarketDataProvider {
  return {
    capabilities: () => ({
      exchanges: [],
      intervals: [],
      supportsRawPrices: false,
      supportsAdjustedPrices: false,
      supportsFx: false,
      supportsDividends: true,
      supportsSplits: true,
      supportsFundamentals: false,
    }),
    searchSecurities: async () => ({ ok: true, value: [] }),
    getDailyPrices: async () => ({ ok: true, value: [] }),
    getLatestObservation: async () => ({ ok: true, value: null }),
    getFxRates: async () => ({ ok: true, value: [] }),
    getDividendEvents: async (request) => {
      calls.push({
        mappingId: request.mappingId,
        securityId: request.securityId,
      });
      return { ok: true, value: dividends };
    },
    getSplitEvents: async () => ({ ok: true, value: splits }),
  };
}

test("ingestion creates dividend and split rows with franking left unpopulated", async () => {
  const { client } = await ownedFixtureClient();
  const provider = providerWithEvents(
    [
      {
        securityId: "security-bhp",
        exDate: "2026-03-05",
        paymentDate: null,
        currencyCode: "AUD",
        amountDecimal: "1.01",
      },
    ],
    [
      {
        securityId: "security-bhp",
        effectiveDate: "2026-05-01",
        numeratorDecimal: "2",
        denominatorDecimal: "1",
      },
    ],
  );

  const result = await ingestSecurityCorporateActionHistory({
    client,
    provider,
    providerId: "yahoo-compatible",
    securityId: "security-bhp",
    mappingId: "mapping-bhp",
    scope: { kind: "deployment", userId: null },
    now: () => "2026-08-13T00:00:00Z",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.summary.dividends, {
      ...emptySummary(),
      created: 1,
    });
    assert.deepEqual(result.summary.splits, { ...emptySummary(), created: 1 });
  }

  const dividendEvents =
    await createDividendEventRepository(client).listForSecurity("security-bhp");
  assert.equal(dividendEvents.length, 1);
  assert.equal(dividendEvents[0]?.status, "paid");
  assert.equal(dividendEvents[0]?.kind, "cash");
  assert.equal(dividendEvents[0]?.grossPerShareDecimal, "1.01");
  assert.equal(dividendEvents[0]?.frankingPercentDecimal, null);
  assert.equal(dividendEvents[0]?.frankingCreditPerShareDecimal, null);

  const splitEvents =
    await createSplitEventRepository(client).listForSecurity("security-bhp");
  assert.equal(splitEvents.length, 1);
  assert.equal(splitEvents[0]?.status, "effective");
  assert.equal(splitEvents[0]?.numeratorDecimal, "2");

  // A corporate-action refresh attempt was recorded for this ingestion.
  const refreshRow = await client.get<{
    last_attempted_at: string;
    last_status: string;
  }>(
    "SELECT last_attempted_at, last_status FROM corporate_action_refresh_state WHERE security_id = ?",
    ["security-bhp"],
  );
  assert.equal(refreshRow?.last_attempted_at, "2026-08-13T00:00:00Z");
  assert.equal(refreshRow?.last_status, "ok");
});

test("re-pulling identical data is a no-op: no duplicate events, idempotent", async () => {
  const { client } = await ownedFixtureClient();
  const dividends: DividendEventInput[] = [
    {
      securityId: "security-bhp",
      exDate: "2026-03-05",
      paymentDate: null,
      currencyCode: "AUD",
      amountDecimal: "1.01",
    },
  ];
  const splits: SplitEventInput[] = [
    {
      securityId: "security-bhp",
      effectiveDate: "2026-05-01",
      numeratorDecimal: "2",
      denominatorDecimal: "1",
    },
  ];
  const provider = providerWithEvents(dividends, splits);
  const ingest = () =>
    ingestSecurityCorporateActionHistory({
      client,
      provider,
      providerId: "yahoo-compatible",
      securityId: "security-bhp",
      mappingId: "mapping-bhp",
      scope: { kind: "deployment", userId: null },
      now: () => "2026-08-13T00:00:00Z",
    });

  const first = await ingest();
  assert.equal(first.ok, true);
  const second = await ingest();
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.deepEqual(second.summary.dividends, {
      ...emptySummary(),
      unchanged: 1,
    });
    assert.deepEqual(second.summary.splits, {
      ...emptySummary(),
      unchanged: 1,
    });
  }

  const dividendEvents =
    await createDividendEventRepository(client).listForSecurity("security-bhp");
  assert.equal(
    dividendEvents.length,
    1,
    "no duplicate dividend event was created",
  );
  const splitEvents =
    await createSplitEventRepository(client).listForSecurity("security-bhp");
  assert.equal(splitEvents.length, 1, "no duplicate split event was created");
});

test("re-pulling a corrected amount supersedes the prior event even though status is unchanged -- prior row preserved", async () => {
  const { client } = await ownedFixtureClient();
  const original: DividendEventInput = {
    securityId: "security-bhp",
    exDate: "2026-03-05",
    paymentDate: null,
    currencyCode: "AUD",
    amountDecimal: "1.01",
  };
  const providerOriginal = providerWithEvents([original], []);
  const first = await ingestSecurityCorporateActionHistory({
    client,
    provider: providerOriginal,
    providerId: "yahoo-compatible",
    securityId: "security-bhp",
    mappingId: "mapping-bhp",
    scope: { kind: "deployment", userId: null },
    now: () => "2026-08-13T00:00:00Z",
  });
  assert.equal(first.ok, true);
  const originalEvent = (
    await createDividendEventRepository(client).listForSecurity("security-bhp")
  )[0]!;
  assert.equal(originalEvent.status, "paid");

  const corrected: DividendEventInput = { ...original, amountDecimal: "1.15" };
  const providerCorrected = providerWithEvents([corrected], []);
  const second = await ingestSecurityCorporateActionHistory({
    client,
    provider: providerCorrected,
    providerId: "yahoo-compatible",
    securityId: "security-bhp",
    mappingId: "mapping-bhp",
    scope: { kind: "deployment", userId: null },
    // Still after the ex-date -- status would be "paid" either way, so this
    // proves a fact change (amount) supersedes independent of status.
    now: () => "2026-08-14T00:00:00Z",
  });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.deepEqual(second.summary.dividends, {
      ...emptySummary(),
      superseded: 1,
    });
  }

  const events =
    await createDividendEventRepository(client).listForSecurity("security-bhp");
  assert.equal(events.length, 2, "prior row is preserved, not deleted");
  const prior = events.find((event) => event.id === originalEvent.id)!;
  const corrected2 = events.find((event) => event.id !== originalEvent.id)!;
  assert.equal(prior.status, "superseded");
  assert.equal(
    prior.grossPerShareDecimal,
    "1.01",
    "prior value is unchanged, never rewritten",
  );
  assert.equal(corrected2.status, "paid");
  assert.equal(corrected2.grossPerShareDecimal, "1.15");
  assert.equal(corrected2.supersedesEventId, originalEvent.id);
});

test("B4: a future-dated event ingests as declared", async () => {
  const { client } = await ownedFixtureClient();
  const future: DividendEventInput = {
    securityId: "security-bhp",
    exDate: "2026-09-01",
    paymentDate: null,
    currencyCode: "AUD",
    amountDecimal: "1.01",
  };
  const result = await ingestSecurityCorporateActionHistory({
    client,
    provider: providerWithEvents([future], []),
    providerId: "yahoo-compatible",
    securityId: "security-bhp",
    mappingId: "mapping-bhp",
    scope: { kind: "deployment", userId: null },
    now: () => "2026-08-13T00:00:00Z", // before the ex-date
  });
  assert.equal(result.ok, true);
  const events =
    await createDividendEventRepository(client).listForSecurity("security-bhp");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.status, "declared");
});

test("B4: a pure status lifecycle transition (declared -> paid once the ex-date passes) updates in place -- no supersession row, no new id", async () => {
  const { client } = await ownedFixtureClient();
  const future: DividendEventInput = {
    securityId: "security-bhp",
    exDate: "2026-09-01",
    paymentDate: null,
    currencyCode: "AUD",
    amountDecimal: "1.01",
  };
  const first = await ingestSecurityCorporateActionHistory({
    client,
    provider: providerWithEvents([future], []),
    providerId: "yahoo-compatible",
    securityId: "security-bhp",
    mappingId: "mapping-bhp",
    scope: { kind: "deployment", userId: null },
    now: () => "2026-08-13T00:00:00Z", // before the ex-date -> declared
  });
  assert.equal(first.ok, true);
  const afterFirst =
    await createDividendEventRepository(client).listForSecurity("security-bhp");
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0]?.status, "declared");
  const originalId = afterFirst[0]!.id;

  const second = await ingestSecurityCorporateActionHistory({
    client,
    provider: providerWithEvents([future], []), // identical facts
    providerId: "yahoo-compatible",
    securityId: "security-bhp",
    mappingId: "mapping-bhp",
    scope: { kind: "deployment", userId: null },
    now: () => "2026-09-15T00:00:00Z", // after the ex-date -> paid
  });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.deepEqual(second.summary.dividends, {
      ...emptySummary(),
      statusUpdated: 1,
    });
  }

  const afterSecond =
    await createDividendEventRepository(client).listForSecurity("security-bhp");
  assert.equal(
    afterSecond.length,
    1,
    "no supersession row was created for a pure lifecycle transition",
  );
  assert.equal(
    afterSecond[0]?.id,
    originalId,
    "same event id -- in-place update, not a new row",
  );
  assert.equal(afterSecond[0]?.status, "paid");
  assert.equal(afterSecond[0]?.supersedesEventId, null);
});

test("B5: re-pulling a corrected split ratio supersedes the prior split event -- prior row preserved", async () => {
  const { client } = await ownedFixtureClient();
  const original: SplitEventInput = {
    securityId: "security-bhp",
    effectiveDate: "2026-05-01",
    numeratorDecimal: "2",
    denominatorDecimal: "1",
  };
  const first = await ingestSecurityCorporateActionHistory({
    client,
    provider: providerWithEvents([], [original]),
    providerId: "yahoo-compatible",
    securityId: "security-bhp",
    mappingId: "mapping-bhp",
    scope: { kind: "deployment", userId: null },
    now: () => "2026-08-13T00:00:00Z",
  });
  assert.equal(first.ok, true);
  const originalEvent = (
    await createSplitEventRepository(client).listForSecurity("security-bhp")
  )[0]!;
  assert.equal(originalEvent.numeratorDecimal, "2");

  const corrected: SplitEventInput = { ...original, numeratorDecimal: "3" };
  const second = await ingestSecurityCorporateActionHistory({
    client,
    provider: providerWithEvents([], [corrected]),
    providerId: "yahoo-compatible",
    securityId: "security-bhp",
    mappingId: "mapping-bhp",
    scope: { kind: "deployment", userId: null },
    now: () => "2026-08-14T00:00:00Z",
  });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.deepEqual(second.summary.splits, {
      ...emptySummary(),
      superseded: 1,
    });
  }

  const events =
    await createSplitEventRepository(client).listForSecurity("security-bhp");
  assert.equal(events.length, 2, "prior split row preserved, not deleted");
  const prior = events.find((event) => event.id === originalEvent.id)!;
  const updated = events.find((event) => event.id !== originalEvent.id)!;
  assert.equal(prior.status, "superseded");
  assert.equal(
    prior.numeratorDecimal,
    "2",
    "prior ratio unchanged, never rewritten",
  );
  assert.equal(updated.numeratorDecimal, "3");
  assert.equal(updated.supersedesEventId, originalEvent.id);
});

test("B1: a concurrent unique-index conflict on create is treated as benign -- re-read and proceed instead of a spurious failure", async () => {
  const { database, client } = await ownedFixtureClient();
  const concurrentId = "concurrent-dividend-1";
  let injected = false;
  const injectingClient: SqlClient = {
    ...client,
    async batch(statements) {
      const isPlainCreateInsert =
        statements.length === 1 &&
        statements[0]!.sql.includes("INSERT INTO dividend_events");
      if (!injected && isPlainCreateInsert) {
        injected = true;
        // Simulates a genuinely concurrent ingestion attempt (the IMP-004B
        // verify trigger racing the cron sweep on the same security)
        // committing the exact same active natural key a moment before this
        // attempt's own INSERT executes -- exactly the race
        // `dividend_events_active_natural_key_unique` exists to catch.
        database.exec(`
          INSERT INTO dividend_events (
            id, security_id, provider_id, kind, status, ex_date, currency_code,
            gross_per_share_decimal, observed_at, ingested_at, created_at
          ) VALUES (
            '${concurrentId}', 'security-bhp', 'yahoo-compatible', 'cash', 'paid',
            '2026-03-05', 'AUD', '1.01', '2026-08-13T00:00:00Z',
            '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z'
          );
        `);
        throw new Error("simulated_unique_index_violation");
      }
      return client.batch(statements);
    },
  };

  const result = await ingestSecurityCorporateActionHistory({
    client: injectingClient,
    provider: providerWithEvents(
      [
        {
          securityId: "security-bhp",
          exDate: "2026-03-05",
          paymentDate: null,
          currencyCode: "AUD",
          amountDecimal: "1.01",
        },
      ],
      [],
    ),
    providerId: "yahoo-compatible",
    securityId: "security-bhp",
    mappingId: "mapping-bhp",
    scope: { kind: "deployment", userId: null },
    now: () => "2026-08-13T00:00:00Z",
  });
  assert.equal(
    result.ok,
    true,
    "the benign race recovers, not a reported failure",
  );
  if (result.ok) {
    assert.deepEqual(result.summary.dividends, {
      ...emptySummary(),
      unchanged: 1,
    });
  }
  const events =
    await createDividendEventRepository(client).listForSecurity("security-bhp");
  assert.equal(
    events.length,
    1,
    "no duplicate row; the concurrent winner's row is the only one",
  );
  assert.equal(events[0]?.id, concurrentId);
});

test("owner override survives a provider correction, still keyed to the prior (now-superseded) event version -- resolving it requires walking the lineage (DIV-001)", async () => {
  const { client } = await ownedFixtureClient();
  const original: DividendEventInput = {
    securityId: "security-bhp",
    exDate: "2026-03-05",
    paymentDate: null,
    currencyCode: "AUD",
    amountDecimal: "1.01",
  };
  const first = await ingestSecurityCorporateActionHistory({
    client,
    provider: providerWithEvents([original], []),
    providerId: "yahoo-compatible",
    securityId: "security-bhp",
    mappingId: "mapping-bhp",
    scope: { kind: "deployment", userId: null },
    now: () => "2026-08-13T00:00:00Z",
  });
  assert.equal(first.ok, true);
  const originalEvent = (
    await createDividendEventRepository(client).listForSecurity("security-bhp")
  )[0]!;

  const overrideRepo = createDividendEventOverrideRepository(client);
  const overrideResult = await overrideRepo.save(
    "user-a",
    "portfolio-a",
    "ps-a",
    originalEvent.id,
    {
      dividendPerShareDecimal: "1.05",
      expectedVersion: null,
      requestId: "req-override-1",
    },
  );
  assert.equal(overrideResult.ok, true);

  const corrected: DividendEventInput = { ...original, amountDecimal: "1.20" };
  const second = await ingestSecurityCorporateActionHistory({
    client,
    provider: providerWithEvents([corrected], []),
    providerId: "yahoo-compatible",
    securityId: "security-bhp",
    mappingId: "mapping-bhp",
    scope: { kind: "deployment", userId: null },
    now: () => "2026-08-14T00:00:00Z",
  });
  assert.equal(second.ok, true);
  if (second.ok) {
    assert.deepEqual(second.summary.dividends, {
      ...emptySummary(),
      superseded: 1,
    });
  }

  // The row survives, completely unchanged, still keyed to the OLD
  // (now-superseded) event id.
  const overrideAfter = await overrideRepo.get(
    "user-a",
    "portfolio-a",
    "ps-a",
    originalEvent.id,
  );
  assert.ok(overrideAfter, "the override row survives re-pull, untouched");
  assert.equal(overrideAfter?.dividendPerShareDecimal, "1.05");
  assert.equal(
    overrideAfter?.version,
    1,
    "re-pull never mutates the override row",
  );

  // B3: a naive lookup keyed only to the CURRENT active event finds
  // nothing -- exactly the gap review finding B3 flagged ("the OPPOSITE of
  // the recorded decision"). Correct resolution requires walking the
  // lineage from the current active event backward.
  const allEvents =
    await createDividendEventRepository(client).listForSecurity("security-bhp");
  const currentActiveEvent = allEvents.find(
    (event) => event.status !== "superseded",
  )!;
  assert.notEqual(currentActiveEvent.id, originalEvent.id);

  const naiveLookup = await overrideRepo.get(
    "user-a",
    "portfolio-a",
    "ps-a",
    currentActiveEvent.id,
  );
  assert.equal(
    naiveLookup,
    null,
    "a naive current-event-only lookup misses the override entirely",
  );

  const lineage = collectEventLineageIds(allEvents, currentActiveEvent.id);
  assert.deepEqual(lineage, [currentActiveEvent.id, originalEvent.id]);
  const lineageLookup = await overrideRepo.get(
    "user-a",
    "portfolio-a",
    "ps-a",
    originalEvent.id,
  );
  assert.ok(
    lineageLookup,
    "walking the lineage back finds the override attached to the prior version",
  );
});

// ---------------------------------------------------------------------------
// Refresh candidate ordering and the bounded scheduled sweep.
// ---------------------------------------------------------------------------

test("refresh candidates rank never-attempted securities first, then oldest-attempted", async () => {
  const { database, client } = await ownedFixtureClient();
  database.exec(`
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('security-woolies', 'equity', 'AUD', 'Woolworths', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status, verified_by_user_id, verified_at)
    VALUES ('mapping-woolies', 'security-woolies', 'yahoo-compatible', 'ASX', 'WOW.AX', '2026-08-01', 'verified', 'user-a', '2026-08-01T00:00:00Z');
  `);
  const refreshRepo = createCorporateActionRefreshRepository(client);
  // security-bhp has a recorded attempt (even a no-op/empty one);
  // security-woolies has never been attempted at all and must rank first.
  await refreshRepo.recordAttempt("security-bhp", "2026-08-01T00:00:00Z", "ok");

  const candidates = await refreshRepo.listCandidates("yahoo-compatible", 10);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0]?.securityId, "security-woolies");
  assert.equal(candidates[1]?.securityId, "security-bhp");
});

test("the scheduled sweep processes a bounded batch of due securities per invocation", async () => {
  const { database, client } = await ownedFixtureClient();
  database.exec(`
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES ('security-woolies', 'equity', 'AUD', 'Woolworths', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status, verified_by_user_id, verified_at)
    VALUES ('mapping-woolies', 'security-woolies', 'yahoo-compatible', 'ASX', 'WOW.AX', '2026-08-01', 'verified', 'user-a', '2026-08-01T00:00:00Z');
  `);
  const calls: { mappingId: string; securityId: string }[] = [];
  const provider = providerWithEvents([], [], calls);

  const summary = await runDueCorporateActionRefresh({
    client,
    provider,
    providerId: "yahoo-compatible",
    scope: { kind: "deployment", userId: null },
    now: () => "2026-08-13T00:00:00Z",
    maxSecurities: 1,
  });
  assert.equal(summary.securitiesProcessed, 1);
  assert.equal(summary.securitiesFailed, 0);
  assert.equal(
    calls.length,
    1,
    "only the bounded batch size issues provider requests",
  );
});

test("B1 rotation: repeated sweeps attempt every candidate security instead of re-selecting the same one forever", async () => {
  const { database, client } = await ownedFixtureClient();
  // security-bhp is seeded by ownedFixtureClient; add two more. Every
  // security's provider fetch below returns nothing -- an "unchanged"/no-op
  // reconciliation every time, the exact scenario that never advanced the
  // old MAX(ingested_at)-derived watermark and starved every other
  // security.
  database.exec(`
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, status, created_at, updated_at)
    VALUES
      ('security-woolies', 'equity', 'AUD', 'Woolworths', 'active', '2026-08-01', '2026-08-01'),
      ('security-nonpayer', 'equity', 'AUD', 'Never Pays Ltd', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status, verified_by_user_id, verified_at)
    VALUES
      ('mapping-woolies', 'security-woolies', 'yahoo-compatible', 'ASX', 'WOW.AX', '2026-08-01', 'verified', 'user-a', '2026-08-01T00:00:00Z'),
      ('mapping-nonpayer', 'security-nonpayer', 'yahoo-compatible', 'ASX', 'NP.AX', '2026-08-01', 'verified', 'user-a', '2026-08-01T00:00:00Z');
  `);
  const provider = providerWithEvents([], []);
  const attemptedPerSweep: string[] = [];
  let tick = 0;
  const now = () => {
    tick += 1;
    return `2026-08-13T${String(tick).padStart(2, "0")}:00:00Z`;
  };

  for (let sweep = 0; sweep < 3; sweep += 1) {
    const summary = await runDueCorporateActionRefresh({
      client,
      provider,
      providerId: "yahoo-compatible",
      scope: { kind: "deployment", userId: null },
      now,
      maxSecurities: 1,
    });
    assert.equal(summary.securitiesProcessed, 1);
    const row = await client.get<{ security_id: string }>(
      `SELECT security_id FROM corporate_action_refresh_state
       ORDER BY last_attempted_at DESC LIMIT 1`,
    );
    attemptedPerSweep.push(String(row?.security_id));
  }

  assert.deepEqual(
    new Set(attemptedPerSweep),
    new Set(["security-bhp", "security-woolies", "security-nonpayer"]),
    "three bounded (batch-of-1) sweeps attempted three DIFFERENT securities, not the same one three times",
  );
  assert.equal(
    new Set(attemptedPerSweep).size,
    3,
    "no security was attempted twice before every other security got a turn",
  );
});
