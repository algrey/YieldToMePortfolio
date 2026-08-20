/**
 * BRK-012B — Sharesight becomes a price source: typed client contract,
 * price_observations accretion, hourly refresh.
 *
 * RESCOPE (TASKS.md, 2026-08-20): BRK-012A found Sharesight's only
 * documented historical-price route is a hard 406 gate for this API client
 * -- historical BACKFILL is impossible. Dailies instead ACCRETE forward:
 * each refresh upserts THAT trading day's observation from
 * `listUserInstruments`'s `current_price`/`current_price_updated_at`, one
 * observation per (security, market_date, source, scope), converging toward
 * the close within a day.
 *
 * Covers: `parseSharesightUserInstruments` (all-items validation, not just
 * the BRK-012A 8/18 sampled basis); `domain/sharesight/price-accretion.ts`
 * (market-date/offset derivation, scope-match plan); the
 * `db/repositories/sharesight-price-refresh.ts` write path (accretion
 * upsert idempotency, same-day convergence, cross-day accumulation, scope
 * filter, cross-user isolation); `app/sharesight-price-refresh-service.ts`
 * (cron gating, failure honesty, watermark, budget-safe chunking); the
 * migration chain (new index, new columns, seeded provider row).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  parseSharesightUserInstruments,
  type SharesightClient,
  type SharesightResult,
  type SharesightUserInstrument,
} from "../domain/sharesight/index.ts";
import {
  buildSharesightPriceAccretionPlan,
  deriveMarketDateFromTimestamp,
  extractOffsetSuffix,
  normalizeTimestampToUtcIso,
} from "../domain/sharesight/price-accretion.ts";
import {
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/sql-client.ts";
import {
  listEnabledSharesightUserIds,
  recordSharesightPriceRefreshWatermark,
  resolveScopedSharesightInstrumentSecurities,
  SHARESIGHT_PRICE_PROVIDER_ID,
  upsertSharesightPriceObservations,
} from "../db/repositories/sharesight-price-refresh.ts";
import { runSharesightPriceRefresh } from "../app/sharesight-price-refresh-service.ts";

// ---------------------------------------------------------------------------
// (1) parse.ts: parseSharesightUserInstruments -- all-items validation
// ---------------------------------------------------------------------------

function validRawInstrument(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    code: "ABC",
    market_code: "ASX",
    currency_code: "AUD",
    current_price: 5.1,
    current_price_updated_at: "2026-08-20T16:10:03+10:00",
    // Ignored fundamentals fields -- present on the real wire, never
    // validated or retained.
    pe_ratio: 12.3,
    sector_classification: "Financials",
    ...overrides,
  };
}

test("BRK-012B parse: a fully valid instrument parses into the typed contract, ignoring fundamentals fields", () => {
  const result = parseSharesightUserInstruments({
    instruments: [validRawInstrument()],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, [
      {
        id: "1",
        code: "ABC",
        marketCode: "ASX",
        currencyCode: "AUD",
        currentPriceDecimal: "5.1",
        currentPriceUpdatedAt: "2026-08-20T16:10:03+10:00",
      },
    ]);
  }
});

test("BRK-012B parse: EVERY item is validated, not just a sampled subset -- a later item's missing currency_code fails that item closed, closing the BRK-012A 8/18 caveat", () => {
  const result = parseSharesightUserInstruments({
    instruments: [
      validRawInstrument({ id: 1 }),
      validRawInstrument({ id: 2 }),
      validRawInstrument({ id: 3, currency_code: undefined }),
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.kind, "invalid_response");
    assert.deepEqual(result.error.itemFailure, {
      itemIndex: 2,
      fieldName: "currency_code",
      reason: "missing",
    });
  }
});

test("BRK-012B parse: a non-integer id fails the item closed as wrong_type", () => {
  const result = parseSharesightUserInstruments({
    instruments: [validRawInstrument({ id: "not-a-number" })],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.itemFailure?.fieldName, "id");
    assert.equal(result.error.itemFailure?.reason, "wrong_type");
  }
});

test("BRK-012B parse: a missing code fails the item closed as missing", () => {
  const result = parseSharesightUserInstruments({
    instruments: [validRawInstrument({ code: undefined })],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error.itemFailure, {
      itemIndex: 0,
      fieldName: "code",
      reason: "missing",
    });
  }
});

test("BRK-012B parse: a missing market_code fails the item closed as missing", () => {
  const result = parseSharesightUserInstruments({
    instruments: [validRawInstrument({ market_code: undefined })],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error.itemFailure, {
      itemIndex: 0,
      fieldName: "market_code",
      reason: "missing",
    });
  }
});

test("BRK-012B parse: a malformed (not 3-uppercase-letter) currency_code fails the item closed as invalid_format", () => {
  const result = parseSharesightUserInstruments({
    instruments: [validRawInstrument({ currency_code: "aud" })],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error.itemFailure, {
      itemIndex: 0,
      fieldName: "currency_code",
      reason: "invalid_format",
    });
  }
});

test("BRK-012B parse: a missing current_price fails the item closed as missing", () => {
  const result = parseSharesightUserInstruments({
    instruments: [validRawInstrument({ current_price: undefined })],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error.itemFailure, {
      itemIndex: 0,
      fieldName: "current_price",
      reason: "missing",
    });
  }
});

test("BRK-012B parse: a non-decimal-shaped current_price fails the item closed as invalid_decimal", () => {
  const result = parseSharesightUserInstruments({
    instruments: [validRawInstrument({ current_price: "not-a-price" })],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error.itemFailure, {
      itemIndex: 0,
      fieldName: "current_price",
      reason: "invalid_decimal",
    });
  }
});

test("BRK-012B parse: current_price_updated_at without a UTC offset fails the item closed as invalid_format", () => {
  const result = parseSharesightUserInstruments({
    instruments: [
      validRawInstrument({ current_price_updated_at: "2026-08-20T16:10:03" }),
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.error.itemFailure, {
      itemIndex: 0,
      fieldName: "current_price_updated_at",
      reason: "invalid_format",
    });
  }
});

test("BRK-012B parse: current_price_updated_at is preserved verbatim, offset included -- never reformatted to UTC", () => {
  const result = parseSharesightUserInstruments({
    instruments: [
      validRawInstrument({
        current_price_updated_at: "2026-08-20T23:59:59+10:00",
      }),
    ],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(
      result.value[0]?.currentPriceUpdatedAt,
      "2026-08-20T23:59:59+10:00",
    );
  }
});

test("BRK-012B parse: an empty instruments list parses successfully as an empty array", () => {
  const result = parseSharesightUserInstruments({ instruments: [] });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, []);
});

test("BRK-012B parse: a missing instruments envelope key fails closed, never defaults to empty", () => {
  const result = parseSharesightUserInstruments({});
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// (2) price-accretion.ts: pure market-date/offset derivation + scope plan
// ---------------------------------------------------------------------------

test("BRK-012B accretion: a +10:00 evening timestamp derives its OWN calendar date, never the UTC-shifted date", () => {
  // In UTC this instant is 2026-08-20T06:10:03Z -- still the 20th in UTC
  // too here, but the point is the derivation reads the STRING's own date
  // digits, not a UTC conversion; the next test proves the divergent case.
  assert.equal(
    deriveMarketDateFromTimestamp("2026-08-20T16:10:03+10:00"),
    "2026-08-20",
  );
});

test("BRK-012B accretion: a late-evening +10:00 timestamp stays on ITS OWN date even though UTC conversion would roll it back a day", () => {
  // 2026-08-20T23:50:00+10:00 is 2026-08-20T13:50:00Z in UTC (same day this
  // time), but 2026-08-20T01:00:00+10:00 is 2026-08-19T15:00:00Z in UTC --
  // an EARLIER calendar day. Naive UTC conversion would misreport the
  // trading day as the 19th; the derivation must report the 20th, the date
  // Sharesight's own timestamp names.
  assert.equal(
    deriveMarketDateFromTimestamp("2026-08-20T01:00:00+10:00"),
    "2026-08-20",
  );
});

test("BRK-012B accretion: a midnight-boundary timestamp (00:00:00) derives the date it names, not the day before or after", () => {
  assert.equal(
    deriveMarketDateFromTimestamp("2026-08-20T00:00:00+10:00"),
    "2026-08-20",
  );
});

test("BRK-012B accretion: a Z-offset (UTC) timestamp derives its own date the same way", () => {
  assert.equal(
    deriveMarketDateFromTimestamp("2026-08-20T23:59:59Z"),
    "2026-08-20",
  );
});

test("BRK-012B accretion (F5): deriveMarketDateFromTimestamp fails CLOSED (null) on an unparseable input, never echoing a sliced-garbage value", () => {
  assert.equal(deriveMarketDateFromTimestamp("not-a-timestamp"), null);
  assert.equal(deriveMarketDateFromTimestamp(""), null);
  assert.equal(deriveMarketDateFromTimestamp("2026-08-20T16:10:03"), null); // missing offset
  assert.equal(
    deriveMarketDateFromTimestamp("2026-13-40T99:99:99+10:00"),
    null,
  ); // out-of-range
});

test("BRK-012B accretion (B1(a)): normalizeTimestampToUtcIso converts a +10:00 offset timestamp to its exact UTC instant", () => {
  assert.equal(
    normalizeTimestampToUtcIso("2026-08-20T16:10:03+10:00"),
    "2026-08-20T06:10:03.000Z",
  );
  assert.equal(
    normalizeTimestampToUtcIso("2026-08-20T23:59:59Z"),
    "2026-08-20T23:59:59.000Z",
  );
});

test("BRK-012B accretion (F5): normalizeTimestampToUtcIso fails CLOSED (null) on an unparseable input, never echoing a garbage value", () => {
  assert.equal(normalizeTimestampToUtcIso("not-a-timestamp"), null);
  assert.equal(normalizeTimestampToUtcIso(""), null);
  assert.equal(normalizeTimestampToUtcIso("2026-08-20T16:10:03"), null); // missing offset
});

test("BRK-012B accretion: extractOffsetSuffix reads the +HH:MM offset and the Z marker verbatim", () => {
  assert.equal(extractOffsetSuffix("2026-08-20T16:10:03+10:00"), "+10:00");
  assert.equal(extractOffsetSuffix("2026-08-20T23:59:59Z"), "Z");
  assert.equal(extractOffsetSuffix("2026-08-20T16:10:03-05:00"), "-05:00");
});

function fakeInstrument(
  overrides: Partial<SharesightUserInstrument> = {},
): SharesightUserInstrument {
  return {
    id: "1",
    code: "ABC",
    marketCode: "ASX",
    currencyCode: "AUD",
    currentPriceDecimal: "5.1",
    currentPriceUpdatedAt: "2026-08-20T16:10:03+10:00",
    ...overrides,
  };
}

test("BRK-012B accretion plan: a matched instrument produces exactly one candidate carrying the resolved security id", () => {
  const plan = buildSharesightPriceAccretionPlan(
    [fakeInstrument()],
    new Map([["1", "security-a"]]),
  );
  assert.equal(plan.matchedCount, 1);
  assert.equal(plan.unmatchedCount, 0);
  assert.deepEqual(plan.candidates, [
    {
      securityId: "security-a",
      instrumentCode: "ABC",
      marketCode: "ASX",
      currencyCode: "AUD",
      closeDecimal: "5.1",
      marketDate: "2026-08-20",
      marketTimezone: "+10:00",
      // BRK-012B review B1(a): normalized to UTC Z-form for storage, NEVER
      // the raw +10:00 offset string -- see
      // `normalizeTimestampToUtcIso`'s doc comment.
      observationAt: "2026-08-20T06:10:03.000Z",
    },
  ]);
  assert.equal(plan.invalidTimestampCount, 0);
  assert.deepEqual(plan.invalidTimestampInstrumentIds, []);
});

test("BRK-012B accretion plan: an unmatched instrument is ignored -- no candidate -- but counted and named by id", () => {
  const plan = buildSharesightPriceAccretionPlan(
    [fakeInstrument({ id: "999" })],
    new Map([["1", "security-a"]]),
  );
  assert.equal(plan.matchedCount, 0);
  assert.equal(plan.unmatchedCount, 1);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.unmatchedInstrumentIds, ["999"]);
});

test("BRK-012B accretion plan (F5): a matched instrument with an unparseable timestamp is excluded -- never written with a guessed date, counted separately from unmatchedCount", () => {
  const plan = buildSharesightPriceAccretionPlan(
    [
      fakeInstrument({
        id: "1",
        currentPriceUpdatedAt: "not-a-real-timestamp",
      }),
    ],
    new Map([["1", "security-a"]]),
  );
  assert.equal(plan.matchedCount, 0);
  assert.equal(plan.unmatchedCount, 0);
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.invalidTimestampCount, 1);
  assert.deepEqual(plan.invalidTimestampInstrumentIds, ["1"]);
});

test("BRK-012B accretion plan: a mix of matched and unmatched instruments is split correctly", () => {
  const plan = buildSharesightPriceAccretionPlan(
    [
      fakeInstrument({ id: "1" }),
      fakeInstrument({ id: "2" }),
      fakeInstrument({ id: "999" }),
    ],
    new Map([
      ["1", "security-a"],
      ["2", "security-b"],
    ]),
  );
  assert.equal(plan.matchedCount, 2);
  assert.equal(plan.unmatchedCount, 1);
  assert.deepEqual(plan.unmatchedInstrumentIds, ["999"]);
});

// ---------------------------------------------------------------------------
// (3) Repository layer: db/repositories/sharesight-price-refresh.ts
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  return db;
}

/** Two owners ('user-a', 'user-b'), one portfolio each, one security each
 * (linked via a distinct `sharesight_instrument` identifier), plus an
 * enabled `sharesight_sync_state` link for each -- the shared fixture every
 * repository/service test below builds on. */
async function ownedFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1),
           ('user-b', 'active', 'b@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1),
           ('portfolio-b', 'user-b', 'B', 'B portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-b', 'Beta', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('membership-b', 'user-b', 'portfolio-b', 'security-b', 'DEF', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
    INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, valid_to, source)
    VALUES ('ident-a', 'security-a', 'sharesight_instrument', '101', '2026-08-01', NULL, 'sharesight'),
           ('ident-b', 'security-b', 'sharesight_instrument', '202', '2026-08-01', NULL, 'sharesight');
    INSERT INTO sharesight_sync_state (
      id, user_id, portfolio_id, sharesight_portfolio_id, enabled,
      last_synced_at, last_trade_watermark, created_at, updated_at, version
    ) VALUES
      ('sync-a', 'user-a', 'portfolio-a', 'sp-a', 1, NULL, NULL, '2026-08-01', '2026-08-01', 1),
      ('sync-b', 'user-b', 'portfolio-b', 'sp-b', 1, NULL, NULL, '2026-08-01', '2026-08-01', 1);
  `);
  return db;
}

function candidateFor(
  securityId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    securityId,
    instrumentCode: "ABC",
    marketCode: "ASX",
    currencyCode: "AUD",
    closeDecimal: "5.10",
    marketDate: "2026-08-20",
    marketTimezone: "+10:00",
    observationAt: "2026-08-20T16:10:03+10:00",
    ...overrides,
  };
}

test("BRK-012B repository: resolveScopedSharesightInstrumentSecurities is owner-scoped -- user-a's map contains only user-a's instrument, never user-b's", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  const mapA = await resolveScopedSharesightInstrumentSecurities(
    client,
    "user-a",
  );
  assert.deepEqual([...mapA.entries()], [["101", "security-a"]]);
  const mapB = await resolveScopedSharesightInstrumentSecurities(
    client,
    "user-b",
  );
  assert.deepEqual([...mapB.entries()], [["202", "security-b"]]);
});

test("BRK-012B repository: resolveScopedSharesightInstrumentSecurities includes an exited (hidden, still resolved) holding -- any status except unresolved is in-scope", async () => {
  const database = await ownedFixture();
  database.exec(
    `UPDATE portfolio_securities SET status = 'hidden' WHERE id = 'membership-a'`,
  );
  const client = createSqliteSqlClient(database);
  const map = await resolveScopedSharesightInstrumentSecurities(
    client,
    "user-a",
  );
  assert.deepEqual([...map.entries()], [["101", "security-a"]]);
});

test("BRK-012B repository: upsertSharesightPriceObservations writes exactly one price_observations row for one candidate, scoped user/user-a, source sharesight", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  const result = await upsertSharesightPriceObservations(client, {
    userId: "user-a",
    candidates: [candidateFor("security-a")],
    now: "2026-08-20T17:00:00.000Z",
  });
  assert.equal(result.written, 1);
  const rows = database
    .prepare(
      `SELECT provider_id, access_scope, scope_user_id, scope_key, security_id,
              interval, market_date, market_timezone, currency_code,
              close_decimal, observation_at, adjustment_state, quality
         FROM price_observations`,
    )
    .all();
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0] },
    {
      provider_id: SHARESIGHT_PRICE_PROVIDER_ID,
      access_scope: "user",
      scope_user_id: "user-a",
      scope_key: "user-a",
      security_id: "security-a",
      interval: "delayed",
      market_date: "2026-08-20",
      market_timezone: "+10:00",
      currency_code: "AUD",
      close_decimal: "5.10",
      observation_at: "2026-08-20T16:10:03+10:00",
      adjustment_state: "raw",
      quality: "observed",
    },
  );
});

test("BRK-012B repository: the first write for a security guard-creates exactly one security_provider_mappings row for the sharesight provider", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  await upsertSharesightPriceObservations(client, {
    userId: "user-a",
    candidates: [candidateFor("security-a")],
    now: "2026-08-20T17:00:00.000Z",
  });
  const rows = database
    .prepare(
      `SELECT provider_id, security_id, provider_exchange, provider_symbol, status
         FROM security_provider_mappings WHERE provider_id = ?`,
    )
    .all(SHARESIGHT_PRICE_PROVIDER_ID);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0] },
    {
      provider_id: SHARESIGHT_PRICE_PROVIDER_ID,
      security_id: "security-a",
      provider_exchange: "ASX",
      provider_symbol: "ABC",
      status: "candidate",
    },
  );
});

test("BRK-012B repository: re-upserting the IDENTICAL observation is idempotent -- one row, unchanged values, no duplicate mapping row", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  const candidate = candidateFor("security-a");
  const first = await upsertSharesightPriceObservations(client, {
    userId: "user-a",
    candidates: [candidate],
    now: "2026-08-20T17:00:00.000Z",
  });
  const second = await upsertSharesightPriceObservations(client, {
    userId: "user-a",
    candidates: [candidate],
    now: "2026-08-20T18:00:00.000Z",
  });
  // BRK-012B review finding F3: `written` reflects rows the database
  // actually affected (via RETURNING), not merely the input candidate
  // count -- both the INSERT (first call) and the ON CONFLICT DO UPDATE
  // (second call, same candidate) affect exactly 1 row.
  assert.equal(first.written, 1);
  assert.equal(second.written, 1);
  const observationRows = database
    .prepare(`SELECT close_decimal FROM price_observations`)
    .all();
  assert.equal(observationRows.length, 1);
  const mappingRows = database
    .prepare(
      `SELECT COUNT(*) AS n FROM security_provider_mappings WHERE provider_id = ?`,
    )
    .get(SHARESIGHT_PRICE_PROVIDER_ID) as { n: number };
  assert.equal(mappingRows.n, 1);
});

test("BRK-012B repository: a same-day re-fetch with a LATER observation_at and a different price OVERWRITES the existing row -- converges toward the close, never duplicates", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  await upsertSharesightPriceObservations(client, {
    userId: "user-a",
    candidates: [
      candidateFor("security-a", {
        closeDecimal: "5.00",
        observationAt: "2026-08-20T14:00:00+10:00",
      }),
    ],
    now: "2026-08-20T14:05:00.000Z",
  });
  await upsertSharesightPriceObservations(client, {
    userId: "user-a",
    candidates: [
      candidateFor("security-a", {
        closeDecimal: "5.25",
        observationAt: "2026-08-20T16:10:03+10:00",
      }),
    ],
    now: "2026-08-20T16:15:00.000Z",
  });
  const rows = database
    .prepare(
      `SELECT close_decimal, observation_at FROM price_observations WHERE security_id = 'security-a'`,
    )
    .all();
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0] },
    {
      close_decimal: "5.25",
      observation_at: "2026-08-20T16:10:03+10:00",
    },
  );
});

test("BRK-012B repository: a write for a DIFFERENT market_date accumulates as a SECOND distinct row -- cross-day accretion, not overwritten", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  await upsertSharesightPriceObservations(client, {
    userId: "user-a",
    candidates: [
      candidateFor("security-a", {
        marketDate: "2026-08-19",
        observationAt: "2026-08-19T16:10:03+10:00",
        closeDecimal: "4.90",
      }),
    ],
    now: "2026-08-19T16:15:00.000Z",
  });
  await upsertSharesightPriceObservations(client, {
    userId: "user-a",
    candidates: [
      candidateFor("security-a", {
        marketDate: "2026-08-20",
        observationAt: "2026-08-20T16:10:03+10:00",
        closeDecimal: "5.25",
      }),
    ],
    now: "2026-08-20T16:15:00.000Z",
  });
  const rows = database
    .prepare(
      `SELECT market_date, close_decimal FROM price_observations WHERE security_id = 'security-a' ORDER BY market_date ASC`,
    )
    .all();
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { market_date: "2026-08-19", close_decimal: "4.90" },
      { market_date: "2026-08-20", close_decimal: "5.25" },
    ],
  );
});

test("BRK-012B repository: cross-user isolation -- a write scoped to user-a produces zero rows visible to user-b's scope query", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  await upsertSharesightPriceObservations(client, {
    userId: "user-a",
    candidates: [candidateFor("security-a")],
    now: "2026-08-20T17:00:00.000Z",
  });
  const userBRows = database
    .prepare(`SELECT * FROM price_observations WHERE scope_user_id = 'user-b'`)
    .all();
  assert.equal(userBRows.length, 0);
});

test("BRK-012B repository: a chunk-crossing batch (30 candidates, exceeding the 25-per-chunk budget) writes every candidate correctly", async () => {
  const database = await ownedFixture();
  // Extend the fixture with 30 distinct securities all owned by user-a.
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 999, 'dup', 2, 1) ON CONFLICT DO NOTHING;
  `);
  const insertSecurity = database.prepare(
    `INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
     VALUES (?, ?, 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01')`,
  );
  const insertMembership = database.prepare(
    `INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
     VALUES (?, 'user-a', 'portfolio-a', ?, ?, 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01')`,
  );
  const candidates = [];
  for (let index = 0; index < 30; index += 1) {
    const securityId = `chunk-security-${index}`;
    insertSecurity.run(securityId, `Chunk ${index}`);
    insertMembership.run(
      `chunk-membership-${index}`,
      securityId,
      `SYM${index}`,
    );
    candidates.push(
      candidateFor(securityId, { instrumentCode: `SYM${index}` }),
    );
  }
  const client = createSqliteSqlClient(database);
  const result = await upsertSharesightPriceObservations(client, {
    userId: "user-a",
    candidates,
    now: "2026-08-20T17:00:00.000Z",
  });
  assert.equal(result.written, 30);
  const count = database
    .prepare(
      `SELECT COUNT(*) AS n FROM price_observations WHERE market_date = '2026-08-20'`,
    )
    .get() as { n: number };
  assert.equal(count.n, 30);
});

test("BRK-012B repository: recordSharesightPriceRefreshWatermark writes an honest failed status + error kind, never partial-silent", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "user-a",
    status: "failed",
    errorKind: "rate_limit",
    now: "2026-08-20T17:00:00.000Z",
  });
  const row = database
    .prepare(
      `SELECT last_price_refresh_at, last_price_refresh_status, last_price_refresh_error_kind
         FROM sharesight_sync_state WHERE user_id = 'user-a'`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...row },
    {
      last_price_refresh_at: "2026-08-20T17:00:00.000Z",
      last_price_refresh_status: "failed",
      last_price_refresh_error_kind: "rate_limit",
    },
  );
});

test("BRK-012B repository: recordSharesightPriceRefreshWatermark only updates ENABLED rows for the owner", async () => {
  const database = await ownedFixture();
  database.exec(
    `UPDATE sharesight_sync_state SET enabled = 0 WHERE id = 'sync-a'`,
  );
  const client = createSqliteSqlClient(database);
  await recordSharesightPriceRefreshWatermark(client, {
    userId: "user-a",
    status: "ok",
    errorKind: null,
    now: "2026-08-20T17:00:00.000Z",
  });
  const row = database
    .prepare(
      `SELECT last_price_refresh_status FROM sharesight_sync_state WHERE id = 'sync-a'`,
    )
    .get() as { last_price_refresh_status: string | null };
  assert.equal(row.last_price_refresh_status, null);
});

test("BRK-012B repository (F4): recordSharesightPriceRefreshWatermark rejects a status outside 'ok'/'failed' at RUNTIME, not merely via the TypeScript type", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  await assert.rejects(
    () =>
      recordSharesightPriceRefreshWatermark(client, {
        userId: "user-a",
        // Cast bypasses the TypeScript union -- proves the runtime guard,
        // not the compiler, is what actually rejects this.
        status: "not-a-real-status" as unknown as "ok" | "failed",
        errorKind: null,
        now: "2026-08-20T17:00:00.000Z",
      }),
    /invalid_sharesight_price_refresh_status/,
  );
  const row = database
    .prepare(
      `SELECT last_price_refresh_status FROM sharesight_sync_state WHERE user_id = 'user-a'`,
    )
    .get() as { last_price_refresh_status: string | null };
  assert.equal(
    row.last_price_refresh_status,
    null,
    "the rejected call must never have written anything",
  );
});

test("BRK-012B repository (F3): resolveScopedSharesightInstrumentSecurities returns results in deterministic, sorted order", async () => {
  const database = await ownedFixture();
  database.exec(`
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-z', 'Zeta', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-z', 'user-a', 'portfolio-a', 'security-z', 'XYZ', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
    INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, valid_to, source)
    VALUES ('ident-z', 'security-z', 'sharesight_instrument', '999', '2026-08-01', NULL, 'sharesight');
  `);
  const client = createSqliteSqlClient(database);
  const map = await resolveScopedSharesightInstrumentSecurities(
    client,
    "user-a",
  );
  // Insertion order put '999' (security-z) after '101' (security-a) in the
  // fixture, but string-sorted instrument-id order is '101' < '999' --
  // asserting the Map's OWN iteration order (insertion order in a JS Map)
  // matches the query's ORDER BY, not accidental table scan order.
  assert.deepEqual(
    [...map.entries()],
    [
      ["101", "security-a"],
      ["999", "security-z"],
    ],
  );
});

test("BRK-012B repository: listEnabledSharesightUserIds returns only owners with an enabled link, distinct, sorted", async () => {
  const database = await ownedFixture();
  database.exec(
    `UPDATE sharesight_sync_state SET enabled = 0 WHERE id = 'sync-b'`,
  );
  const client = createSqliteSqlClient(database);
  const userIds = await listEnabledSharesightUserIds(client);
  assert.deepEqual(userIds, ["user-a"]);
});

// ---------------------------------------------------------------------------
// (4) Service layer: app/sharesight-price-refresh-service.ts
// ---------------------------------------------------------------------------

function fakeSharesightClient(
  result: SharesightResult<SharesightUserInstrument[]>,
): { client: SharesightClient; state: { callCount: number } } {
  const state = { callCount: 0 };
  const client: SharesightClient = {
    async listPortfolios() {
      return { ok: true, value: [] };
    },
    async getPortfolioHoldings() {
      return { ok: true, value: [] };
    },
    async listTrades() {
      return { ok: true, value: [] };
    },
    async listPayouts() {
      return { ok: true, value: [] };
    },
    async listUserInstruments() {
      state.callCount += 1;
      return result;
    },
  };
  return { client, state };
}

test("BRK-012B service: cron gating -- no Sharesight client configured is a skip, zero DB reads, zero fetch", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  const result = await runSharesightPriceRefresh({
    client,
    sharesightClient: null,
    now: () => "2026-08-20T17:00:00.000Z",
  });
  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    usersProcessed: 0,
    usersFailed: 0,
    matchedCount: 0,
    unmatchedCount: 0,
    invalidTimestampCount: 0,
    observationsWritten: 0,
  });
});

test("BRK-012B service: cron gating -- credentials configured but NO enabled link anywhere is a skip -- listUserInstruments is never called", async () => {
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
  `);
  const client = createSqliteSqlClient(database);
  const fake = fakeSharesightClient({ ok: true, value: [] });
  const result = await runSharesightPriceRefresh({
    client,
    sharesightClient: fake.client,
    now: () => "2026-08-20T17:00:00.000Z",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.skipped, true);
  assert.equal(fake.state.callCount, 0);
});

test("BRK-012B service: a successful run writes an observation, records an ok watermark, and reports matched/unmatched counts", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  const fake = fakeSharesightClient({
    ok: true,
    value: [
      {
        id: "101",
        code: "ABC",
        marketCode: "ASX",
        currencyCode: "AUD",
        currentPriceDecimal: "5.25",
        currentPriceUpdatedAt: "2026-08-20T16:10:03+10:00",
      },
      {
        id: "999",
        code: "ZZZ",
        marketCode: "NYSE",
        currencyCode: "USD",
        currentPriceDecimal: "10.00",
        currentPriceUpdatedAt: "2026-08-20T16:10:03+10:00",
      },
    ],
  });
  const result = await runSharesightPriceRefresh({
    client,
    sharesightClient: fake.client,
    now: () => "2026-08-20T17:00:00.000Z",
  });
  assert.equal(fake.state.callCount, 1);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.skipped, false);
    assert.equal(result.usersProcessed, 2);
    assert.equal(result.usersFailed, 0);
    assert.equal(result.invalidTimestampCount, 0);
    // instrument 101 matches user-a's security-a; instrument 202 (user-b's)
    // is absent from THIS fixture's fake response, so user-b's pass sees
    // zero matches; instrument 999 matches nobody. matchedCount/unmatchedCount
    // are summed across both owners' passes.
    assert.equal(result.matchedCount, 1);
    assert.equal(result.observationsWritten, 1);
  }
  const observationRow = database
    .prepare(
      `SELECT scope_user_id, close_decimal FROM price_observations WHERE security_id = 'security-a'`,
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...observationRow },
    {
      scope_user_id: "user-a",
      close_decimal: "5.25",
    },
  );
  const watermarkA = database
    .prepare(
      `SELECT last_price_refresh_status FROM sharesight_sync_state WHERE user_id = 'user-a'`,
    )
    .get() as { last_price_refresh_status: string };
  assert.equal(watermarkA.last_price_refresh_status, "ok");
});

test("BRK-012B service: an unmatched instrument (no owner's identifiers reference it) is ignored, never fabricated onto a security", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  const fake = fakeSharesightClient({
    ok: true,
    value: [
      {
        id: "999",
        code: "ZZZ",
        marketCode: "NYSE",
        currencyCode: "USD",
        currentPriceDecimal: "10.00",
        currentPriceUpdatedAt: "2026-08-20T16:10:03+10:00",
      },
    ],
  });
  const result = await runSharesightPriceRefresh({
    client,
    sharesightClient: fake.client,
    now: () => "2026-08-20T17:00:00.000Z",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.matchedCount, 0);
    assert.equal(result.unmatchedCount, 2); // once per owner's pass
    assert.equal(result.observationsWritten, 0);
  }
  const count = database
    .prepare(`SELECT COUNT(*) AS n FROM price_observations`)
    .get() as { n: number };
  assert.equal(count.n, 0);
});

test("BRK-012B service: cross-user isolation -- user-a's matched instrument never produces a row scoped to user-b, even though both have enabled links", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  const fake = fakeSharesightClient({
    ok: true,
    value: [
      {
        id: "101",
        code: "ABC",
        marketCode: "ASX",
        currencyCode: "AUD",
        currentPriceDecimal: "5.25",
        currentPriceUpdatedAt: "2026-08-20T16:10:03+10:00",
      },
    ],
  });
  await runSharesightPriceRefresh({
    client,
    sharesightClient: fake.client,
    now: () => "2026-08-20T17:00:00.000Z",
  });
  const userBRows = database
    .prepare(`SELECT * FROM price_observations WHERE scope_user_id = 'user-b'`)
    .all();
  assert.equal(userBRows.length, 0);
});

test("BRK-012B service: failure honesty -- a failed fetch records status=failed + the error kind on EVERY enabled link, never a silent no-op", async () => {
  const database = await ownedFixture();
  const client = createSqliteSqlClient(database);
  const fake = fakeSharesightClient({
    ok: false,
    error: {
      kind: "rate_limit",
      message: "too many requests",
      retryable: true,
    },
  });
  const result = await runSharesightPriceRefresh({
    client,
    sharesightClient: fake.client,
    now: () => "2026-08-20T17:00:00.000Z",
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "fetch_failed",
    errorKind: "rate_limit",
    usersMarkedFailed: 2,
  });
  const rows = database
    .prepare(
      `SELECT user_id, last_price_refresh_status, last_price_refresh_error_kind
         FROM sharesight_sync_state ORDER BY user_id ASC`,
    )
    .all();
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      {
        user_id: "user-a",
        last_price_refresh_status: "failed",
        last_price_refresh_error_kind: "rate_limit",
      },
      {
        user_id: "user-b",
        last_price_refresh_status: "failed",
        last_price_refresh_error_kind: "rate_limit",
      },
    ],
  );
  const observationCount = database
    .prepare(`SELECT COUNT(*) AS n FROM price_observations`)
    .get() as { n: number };
  assert.equal(observationCount.n, 0);
});

test("BRK-012B service (F2): a DB-write failure during the per-user resolve/write phase still records an honest failure watermark for that user, and never crashes the run for other users", async () => {
  const database = await ownedFixture();
  const realClient = createSqliteSqlClient(database);
  // `batch()` is what `upsertSharesightPriceObservations` uses for the
  // actual write -- simulating it throwing (a real D1 outage/error) while
  // `run()` (used by the watermark write) keeps working through the SAME
  // underlying database, exactly modelling "the write phase failed, but
  // the failure watermark write itself must still succeed."
  const failingClient: SqlClient = {
    all: (sql, params) => realClient.all(sql, params),
    get: (sql, params) => realClient.get(sql, params),
    run: (sql, params) => realClient.run(sql, params),
    batch: async () => {
      throw new Error("simulated_db_write_failure");
    },
  };
  const fake = fakeSharesightClient({
    ok: true,
    value: [
      {
        id: "101",
        code: "ABC",
        marketCode: "ASX",
        currencyCode: "AUD",
        currentPriceDecimal: "5.25",
        currentPriceUpdatedAt: "2026-08-20T16:10:03+10:00",
      },
    ],
  });
  const result = await runSharesightPriceRefresh({
    client: failingClient,
    sharesightClient: fake.client,
    now: () => "2026-08-20T17:00:00.000Z",
  });
  // The fetch itself succeeded -- this is NOT a fetch_failed run. Only
  // user-a's pass has any matched candidates (instrument "101" resolves to
  // user-a's security-a; user-b's identifiers never match this fixture's
  // instrument list), so only user-a's pass ever reaches
  // `upsertSharesightPriceObservations`'s `client.batch()` call at all --
  // user-b's pass short-circuits on zero candidates and succeeds normally.
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.skipped, false);
    assert.equal(result.usersProcessed, 2);
    assert.equal(result.usersFailed, 1);
    assert.equal(result.observationsWritten, 0);
  }
  const rows = database
    .prepare(
      `SELECT user_id, last_price_refresh_status, last_price_refresh_error_kind
         FROM sharesight_sync_state ORDER BY user_id ASC`,
    )
    .all();
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      {
        user_id: "user-a",
        last_price_refresh_status: "failed",
        last_price_refresh_error_kind: "database",
      },
      {
        user_id: "user-b",
        last_price_refresh_status: "ok",
        last_price_refresh_error_kind: null,
      },
    ],
  );
  const observationCount = database
    .prepare(`SELECT COUNT(*) AS n FROM price_observations`)
    .get() as { n: number };
  assert.equal(observationCount.n, 0);
});

// ---------------------------------------------------------------------------
// (5) Migration chain
// ---------------------------------------------------------------------------

test("BRK-012B migration: the date-keyed unique index exists on price_observations alongside the pre-existing observation_at-keyed one", async () => {
  const database = await migratedDatabase();
  const indexNames = database
    .prepare("PRAGMA index_list('price_observations')")
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((name) => !name.startsWith("sqlite_"))
    .sort();
  assert.deepEqual(indexNames, [
    "price_observations_provider_scope_mapping_date_unique",
    "price_observations_provider_scope_mapping_unique",
    "price_observations_security_date_idx",
    "price_observations_upload_batch_idx",
  ]);
});

test("BRK-012B migration: sharesight_sync_state gained the three price-refresh watermark columns, all nullable", async () => {
  const database = await migratedDatabase();
  const columns = database
    .prepare("PRAGMA table_info('sharesight_sync_state')")
    .all() as Array<{ name: string; notnull: number }>;
  const byName = new Map(columns.map((column) => [column.name, column]));
  assert.equal(byName.get("last_price_refresh_at")?.notnull, 0);
  assert.equal(byName.get("last_price_refresh_status")?.notnull, 0);
  assert.equal(byName.get("last_price_refresh_error_kind")?.notnull, 0);
});

test("BRK-012B migration: sharesight_sync_state's three purge-lock triggers survived the ADD COLUMN migration (no rebuild)", async () => {
  const database = await migratedDatabase();
  const triggerNames = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='sharesight_sync_state' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(triggerNames, [
    "account_purge_lock_sharesight_sync_state_delete",
    "account_purge_lock_sharesight_sync_state_insert",
    "account_purge_lock_sharesight_sync_state_update",
  ]);
});

test("BRK-012B migration: the sharesight market_data_providers row is seeded, enabled, alongside yahoo-compatible", async () => {
  const database = await migratedDatabase();
  const row = database
    .prepare(
      `SELECT id, code, status, capabilities_json, rate_limit_json
         FROM market_data_providers WHERE id = ?`,
    )
    .get(SHARESIGHT_PRICE_PROVIDER_ID) as Record<string, unknown> | undefined;
  assert.ok(row, "expected the migration to seed the sharesight row");
  assert.equal(row!.code, "sharesight");
  assert.equal(row!.status, "enabled");
  assert.equal(row!.capabilities_json, "{}");
  assert.equal(row!.rate_limit_json, "{}");
});

test("BRK-012B migration: price_observations still has a hard FK to security_provider_mappings -- a write with no mapping row and a wrong-shaped guard fails, proving the FK is live", async () => {
  const database = await ownedFixture();
  assert.throws(() => {
    database.exec(`
      INSERT INTO price_observations (
        id, provider_id, access_scope, scope_user_id, scope_key, mapping_id,
        security_id, interval, observation_at, market_date, market_timezone,
        currency_code, close_decimal, adjustment_state, quality, ingested_at
      ) VALUES (
        'orphan-1', '${SHARESIGHT_PRICE_PROVIDER_ID}', 'user', 'user-a', 'user-a',
        'nonexistent-mapping-id', 'security-a', 'delayed', '2026-08-20T16:10:03+10:00',
        '2026-08-20', '+10:00', 'AUD', '5.10', 'raw', 'observed', '2026-08-20T17:00:00.000Z'
      );
    `);
  });
});
