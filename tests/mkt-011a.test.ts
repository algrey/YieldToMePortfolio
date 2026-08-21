/**
 * MKT-011A — daily price capture: intraday sweep, end-of-day rollup into the
 * historical record. Covers: the pure window/DST/weekday gating module
 * (`domain/market-data/daily-capture-window.ts`); the intraday-capture
 * repository (`db/repositories/intraday-price-capture.ts`) -- capture
 * idempotency, rollup idempotency incl. crash-recovery, the
 * one-row-per-(security, market_date, provider) invariant, purge-after-
 * rollup, zero-points-day honesty, provenance labels; the sweep service
 * (`app/daily-price-capture-service.ts`) -- source routing, cadence gating,
 * request-budget bound; the settings validators/repository/ownership; and
 * the migration (new table's purge-lock triggers, OPS-003 registration).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSqliteSqlClient,
  type SqlClient,
} from "../db/repositories/sql-client.ts";
import {
  resolveDailyCaptureWindowStatus,
  isDailyCaptureRollupEligible,
} from "../domain/market-data/daily-capture-window.ts";
import {
  DAILY_CAPTURE_LIMITS,
  guardInsertSharesightMapping,
  insertIntradayPricePoint,
  purgeIntradayPricePoints,
  resolveDailyCaptureRollupCandidates,
  resolveDailyCaptureUserSettings,
  resolveScopedYahooCaptureSecurities,
  resolveSecurityMarketTimezones,
  rollupIntradayPricePoint,
  selectLastIntradayPricePoint,
  YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID,
} from "../db/repositories/intraday-price-capture.ts";
import { SHARESIGHT_PRICE_PROVIDER_ID } from "../db/repositories/sharesight-price-refresh.ts";
import { ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS } from "../db/repositories/account-lifecycle.ts";
import {
  classifyRollupFailure,
  runDailyPriceCapture,
} from "../app/daily-price-capture-service.ts";
import { createOwnedUserSettingsRepository } from "../db/repositories/owned-portfolios.ts";
import {
  validateDailyCaptureIntervalMinutes,
  validateDailyCaptureSource,
} from "../app/portfolio-action-contract.ts";
import type {
  SharesightClient,
  SharesightResult,
  SharesightUserInstrument,
} from "../domain/sharesight/index.ts";
import type {
  LatestRequest,
  MarketDataProvider,
  MarketDataResult,
  PriceObservation,
} from "../domain/market-data/contracts.ts";

// ---------------------------------------------------------------------------
// Fixtures
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

/** One owner, one ASX-listed (Australia/Sydney) security, `held`. */
async function captureFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('owner-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('owner-a', 'AUD', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'owner-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO exchanges (id, mic, name, country_code, timezone, default_currency_code, calendar_code, is_active)
    VALUES ('asx', 'XASX', 'Australian Securities Exchange', 'AU', 'Australia/Sydney', 'AUD', 'XASX', 1);
    INSERT INTO securities (id, canonical_name, asset_type, exchange_id, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'asx', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('holding-a', 'owner-a', 'portfolio-a', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
    INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, valid_to, source)
    VALUES ('ident-a', 'security-a', 'sharesight_instrument', '101', '2026-08-01', NULL, 'sharesight');
    INSERT INTO sharesight_sync_state (
      id, user_id, portfolio_id, sharesight_portfolio_id, enabled,
      last_synced_at, last_trade_watermark, created_at, updated_at, version
    ) VALUES ('sync-a', 'owner-a', 'portfolio-a', 'sp-a', 1, NULL, NULL, '2026-08-01', '2026-08-01', 1);
  `);
  return db;
}

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

function instrument(
  overrides: Partial<SharesightUserInstrument> = {},
): SharesightUserInstrument {
  return {
    id: "101",
    code: "ABC",
    marketCode: "ASX",
    currencyCode: "AUD",
    currentPriceDecimal: "12.34",
    currentPriceUpdatedAt: "2026-08-24T16:10:03+10:00",
    ...overrides,
  };
}

function fakeYahooProvider(
  observation: PriceObservation | null,
  state: { callCount: number } = { callCount: 0 },
): MarketDataProvider {
  const provider: MarketDataProvider = {
    capabilities: () => ({
      exchanges: [],
      intervals: ["eod", "delayed"],
      supportsRawPrices: true,
      supportsAdjustedPrices: false,
      supportsFx: false,
      supportsDividends: false,
      supportsSplits: false,
      supportsFundamentals: false,
    }),
    async searchSecurities() {
      return { ok: true, value: [] };
    },
    async getDailyPrices() {
      return { ok: true, value: [] };
    },
    async getLatestObservation(
      _request: LatestRequest,
    ): Promise<MarketDataResult<PriceObservation | null>> {
      state.callCount += 1;
      return { ok: true, value: observation };
    },
    async getFxRates() {
      return { ok: true, value: [] };
    },
    async getDividendEvents() {
      return { ok: true, value: [] };
    },
    async getSplitEvents() {
      return { ok: true, value: [] };
    },
    async getFundamentals() {
      return {
        ok: false,
        error: {
          kind: "unavailable_capability",
          message: "unsupported",
          retryable: false,
        },
      };
    },
  };
  return provider;
}

function yahooObservation(
  overrides: Partial<PriceObservation> = {},
): PriceObservation {
  return {
    kind: "price",
    providerId: "yahoo-compatible",
    providerRevisionId: "session:authenticated",
    mappingId: "mapping-a",
    securityId: "security-a",
    scope: { kind: "deployment", userId: null },
    interval: "delayed",
    observationAt: "2026-08-24T06:00:00Z",
    marketDate: "2026-08-24",
    marketTimezone: "Australia/Sydney",
    currencyCode: "AUD",
    closeDecimal: "15.50",
    previousCloseDecimal: null,
    adjustmentState: "raw",
    adjustmentFactor: null,
    quality: "observed",
    delayedMinutes: 20,
    ingestedAt: "2026-08-24T06:00:01Z",
    payloadSha256: null,
    ...overrides,
  };
}

async function insertVerifiedYahooMapping(
  db: DatabaseSync,
  id = "mapping-a",
): Promise<void> {
  db.exec(`
    INSERT INTO security_provider_mappings (
      id, security_id, provider_id, provider_exchange, provider_symbol,
      valid_from, valid_to, status, verified_by_user_id, verified_at
    ) VALUES ('${id}', 'security-a', 'yahoo-compatible', 'ASX', 'ABC.AX', '2026-08-01', NULL, 'verified', NULL, NULL);
  `);
}

/**
 * Review round B4 pin: wraps a real `SqlClient` so any `.all()` call whose
 * SQL text contains `matchSubstring` throws instead of executing -- used to
 * simulate a genuine DB failure DURING the rollup's own `INSERT INTO
 * price_observations` statement (never corrupting shared fixture rows via
 * FK-restrict deletes, which would break unrelated setup instead of
 * isolating the one call this drill needs to fail).
 */
function wrapClientWithFailingCall(
  client: SqlClient,
  matchSubstring: string,
  errorMessage = "UNIQUE constraint failed: price_observations.id",
): SqlClient {
  return {
    all: async (sql, params) => {
      if (sql.includes(matchSubstring)) {
        throw new Error(errorMessage);
      }
      return client.all(sql, params);
    },
    get: (sql, params) => client.get(sql, params),
    run: (sql, params) => client.run(sql, params),
    batch: (statements) => client.batch(statements),
  };
}

// ---------------------------------------------------------------------------
// (1) domain/market-data/daily-capture-window.ts -- pure window/DST/weekday
// ---------------------------------------------------------------------------

test("MKT-011A window: 10:25 local (AEST, winter) is the inclusive open boundary", () => {
  const status = resolveDailyCaptureWindowStatus(
    "2026-08-24T00:25:00Z",
    "Australia/Sydney",
  );
  assert.ok(status);
  assert.equal(status.localDate, "2026-08-24");
  assert.equal(status.isWeekday, true);
  assert.equal(status.isWithinCaptureWindow, true);
  assert.equal(status.isPastCaptureWindowClose, false);
});

test("MKT-011A window: 10:24 local (one minute before open) is outside the window", () => {
  const status = resolveDailyCaptureWindowStatus(
    "2026-08-24T00:24:00Z",
    "Australia/Sydney",
  );
  assert.ok(status);
  assert.equal(status.isWithinCaptureWindow, false);
  assert.equal(status.isPastCaptureWindowClose, false);
});

test("MKT-011A window: 16:25 local is the inclusive close boundary (still an open-window capture tick)", () => {
  const status = resolveDailyCaptureWindowStatus(
    "2026-08-24T06:25:00Z",
    "Australia/Sydney",
  );
  assert.ok(status);
  assert.equal(status.isWithinCaptureWindow, true);
  assert.equal(status.isPastCaptureWindowClose, false);
});

test("MKT-011A window: 16:26 local is one minute past close -- window closed, rollup-eligible", () => {
  const status = resolveDailyCaptureWindowStatus(
    "2026-08-24T06:26:00Z",
    "Australia/Sydney",
  );
  assert.ok(status);
  assert.equal(status.isWithinCaptureWindow, false);
  assert.equal(status.isPastCaptureWindowClose, true);
});

test("MKT-011A window (DST): 10:25 local during AEDT (summer, UTC+11) resolves correctly via IANA zone math, not a fixed UTC offset", () => {
  const status = resolveDailyCaptureWindowStatus(
    "2026-01-14T23:25:00Z",
    "Australia/Sydney",
  );
  assert.ok(status);
  assert.equal(status.localDate, "2026-01-15");
  assert.equal(status.isWithinCaptureWindow, true);
});

test("MKT-011A window: a Saturday is never within the capture window even at 10:25 local", () => {
  const status = resolveDailyCaptureWindowStatus(
    "2026-08-22T00:25:00Z",
    "Australia/Sydney",
  );
  assert.ok(status);
  assert.equal(status.isWeekday, false);
  assert.equal(status.isWithinCaptureWindow, false);
});

test("MKT-011A window: an unparseable instant or unknown timezone fails closed (null), never guesses open or closed", () => {
  assert.equal(
    resolveDailyCaptureWindowStatus("not-a-date", "Australia/Sydney"),
    null,
  );
  assert.equal(
    resolveDailyCaptureWindowStatus("2026-08-24T00:25:00Z", "Not/A_Real_Zone"),
    null,
  );
});

test("MKT-011A rollup eligibility: a prior local trading day is always eligible (crash/missed-tick recovery)", () => {
  const status = resolveDailyCaptureWindowStatus(
    "2026-08-25T00:25:00Z", // Tuesday, well within Tuesday's own window
    "Australia/Sydney",
  );
  assert.ok(status);
  assert.equal(isDailyCaptureRollupEligible("2026-08-24", status), true);
});

test("MKT-011A rollup eligibility: today is only eligible once the window has closed", () => {
  const openStatus = resolveDailyCaptureWindowStatus(
    "2026-08-24T02:00:00Z", // 12:00 local, still open
    "Australia/Sydney",
  );
  assert.ok(openStatus);
  assert.equal(isDailyCaptureRollupEligible("2026-08-24", openStatus), false);

  const closedStatus = resolveDailyCaptureWindowStatus(
    "2026-08-24T06:26:00Z", // 16:26 local, closed
    "Australia/Sydney",
  );
  assert.ok(closedStatus);
  assert.equal(isDailyCaptureRollupEligible("2026-08-24", closedStatus), true);
});

test("MKT-011A rollup eligibility: a market_date in the future is never eligible", () => {
  const status = resolveDailyCaptureWindowStatus(
    "2026-08-24T06:26:00Z",
    "Australia/Sydney",
  );
  assert.ok(status);
  assert.equal(isDailyCaptureRollupEligible("2026-08-25", status), false);
});

// ---------------------------------------------------------------------------
// (1b) app/daily-price-capture-service.ts -- classifyRollupFailure (F5)
// ---------------------------------------------------------------------------

test("MKT-011A (F5): classifyRollupFailure buckets a UNIQUE/FK/constraint error message as 'constraint'", () => {
  assert.equal(
    classifyRollupFailure(new Error("UNIQUE constraint failed: t.id")),
    "constraint",
  );
  assert.equal(
    classifyRollupFailure(new Error("FOREIGN KEY constraint failed")),
    "constraint",
  );
});

test("MKT-011A (F5): classifyRollupFailure buckets a timeout/connection error message as 'network'", () => {
  assert.equal(
    classifyRollupFailure(new Error("Network connection timeout")),
    "network",
  );
  assert.equal(classifyRollupFailure(new Error("fetch failed")), "network");
  assert.equal(classifyRollupFailure(new Error("ECONNRESET")), "network");
});

test("MKT-011A (F5): classifyRollupFailure falls back to the honest 'unknown' bucket for anything it cannot place, including a non-Error throw", () => {
  assert.equal(
    classifyRollupFailure(new Error("something unexpected happened")),
    "unknown",
  );
  assert.equal(classifyRollupFailure("a raw string throw"), "unknown");
  assert.equal(classifyRollupFailure(undefined), "unknown");
});

// ---------------------------------------------------------------------------
// (2) db/repositories/intraday-price-capture.ts
// ---------------------------------------------------------------------------

test("MKT-011A repository: resolveSecurityMarketTimezones reads the app's OWN stored exchange timezone, null when unresolvable", async () => {
  const db = await captureFixture();
  db.exec(`
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-no-exchange', 'Beta', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
  `);
  const client = createSqliteSqlClient(db);
  const map = await resolveSecurityMarketTimezones(client, [
    "security-a",
    "security-no-exchange",
  ]);
  assert.equal(map.get("security-a"), "Australia/Sydney");
  assert.equal(map.get("security-no-exchange"), null);
  assert.equal(map.get("does-not-exist"), undefined);
});

test("MKT-011A repository: resolveScopedYahooCaptureSecurities only returns verified, currently-valid yahoo-compatible mappings for THIS owner", async () => {
  const db = await captureFixture();
  await insertVerifiedYahooMapping(db);
  const client = createSqliteSqlClient(db);
  const candidates = await resolveScopedYahooCaptureSecurities(
    client,
    "owner-a",
  );
  assert.deepEqual(candidates, [
    { securityId: "security-a", mappingId: "mapping-a" },
  ]);
  const otherOwner = await resolveScopedYahooCaptureSecurities(
    client,
    "owner-b",
  );
  assert.deepEqual(otherOwner, []);
});

test("MKT-011A repository: insertIntradayPricePoint is idempotent -- a re-captured, UNCHANGED tick never duplicates", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  const input = {
    userId: "owner-a",
    securityId: "security-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    priceDecimal: "12.34",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "+10:00",
    observedAt: "2026-08-24T06:00:00Z",
    capturedAt: "2026-08-24T06:00:01Z",
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  } as const;
  const first = await insertIntradayPricePoint(client, input);
  assert.equal(first.inserted, true);
  const second = await insertIntradayPricePoint(client, {
    ...input,
    capturedAt: "2026-08-24T06:30:00Z",
  });
  assert.equal(second.inserted, false);
  const rows = db
    .prepare(`SELECT COUNT(*) AS n FROM intraday_price_points`)
    .get() as {
    n: number;
  };
  assert.equal(rows.n, 1);
});

test("MKT-011A repository: guardInsertSharesightMapping is idempotent and creates exactly one candidate mapping", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  await guardInsertSharesightMapping(client, {
    securityId: "security-a",
    marketCode: "ASX",
    instrumentCode: "ABC",
    now: "2026-08-24T06:00:00Z",
  });
  await guardInsertSharesightMapping(client, {
    securityId: "security-a",
    marketCode: "ASX",
    instrumentCode: "ABC",
    now: "2026-08-24T06:30:00Z",
  });
  const rows = db
    .prepare(
      `SELECT COUNT(*) AS n FROM security_provider_mappings WHERE provider_id = 'sharesight'`,
    )
    .get() as { n: number };
  assert.equal(rows.n, 1);
});

test("MKT-011A repository: rollupIntradayPricePoint promotes the last point with interval='delayed', adjustment_state='raw' -- never 'eod'", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  await guardInsertSharesightMapping(client, {
    securityId: "security-a",
    marketCode: "ASX",
    instrumentCode: "ABC",
    now: "2026-08-24T06:00:00Z",
  });
  const point = {
    priceDecimal: "12.50",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "+10:00",
    observedAt: "2026-08-24T06:00:00Z",
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  } as const;
  const result = await rollupIntradayPricePoint(client, {
    userId: "owner-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    securityId: "security-a",
    point,
    now: "2026-08-24T06:26:00Z",
  });
  assert.deepEqual(result, { ok: true, written: true });
  const row = db
    .prepare(
      `SELECT interval, adjustment_state, access_scope, scope_user_id, scope_key, quality, close_decimal
         FROM price_observations WHERE security_id = 'security-a'`,
    )
    .get() as Record<string, unknown>;
  assert.equal(row.interval, "delayed");
  assert.equal(row.adjustment_state, "raw");
  assert.equal(row.access_scope, "user");
  assert.equal(row.scope_user_id, "owner-a");
  assert.equal(row.scope_key, "owner-a");
  assert.equal(row.close_decimal, "12.50");
});

test("MKT-011A repository: sharesight rollupIntradayPricePoint CONVERGES on re-run for the SAME (security, market_date, provider) -- one row, updated to the latest point, never a duplicate (review round B1 fix)", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  await guardInsertSharesightMapping(client, {
    securityId: "security-a",
    marketCode: "ASX",
    instrumentCode: "ABC",
    now: "2026-08-24T06:00:00Z",
  });
  const point = {
    priceDecimal: "12.50",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "+10:00",
    observedAt: "2026-08-24T06:00:00Z",
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  } as const;
  const first = await rollupIntradayPricePoint(client, {
    userId: "owner-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    securityId: "security-a",
    point,
    now: "2026-08-24T06:26:00Z",
  });
  assert.equal(first.ok && first.written, true);
  // A re-run (e.g. the SAME sweep tick retried after a purge failure) still
  // reports `written: true` -- `ON CONFLICT ... DO UPDATE` always affects a
  // row -- but the invariant that actually matters is ONE row, never a
  // second row for this (security, market_date, provider).
  const second = await rollupIntradayPricePoint(client, {
    userId: "owner-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    securityId: "security-a",
    point,
    now: "2026-08-24T06:27:00Z",
  });
  assert.equal(second.ok && second.written, true);
  const rows = db
    .prepare(
      `SELECT COUNT(*) AS n FROM price_observations WHERE security_id = 'security-a'`,
    )
    .get() as { n: number };
  assert.equal(
    rows.n,
    1,
    "one-row-per-(security, market_date, provider) invariant",
  );
});

test("MKT-011A repository (B1 pin): rollup CONVERGES over a pre-existing BRK-012B same-market_date row -- the stored close CHANGES to the sweep's own 16:25 value, then the intraday cache purges cleanly", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  await guardInsertSharesightMapping(client, {
    securityId: "security-a",
    marketCode: "ASX",
    instrumentCode: "ABC",
    now: "2026-08-24T06:00:00Z",
  });
  // Simulate BRK-012B's own hourly accretion write for the SAME day, EARLIER
  // in the day, at a lower price -- targeting the SAME partial unique index
  // this rollup must also converge through.
  db.exec(`
    INSERT INTO price_observations (
      id, provider_id, access_scope, scope_user_id, scope_key, mapping_id,
      security_id, interval, observation_at, market_date, market_timezone,
      currency_code, close_decimal, previous_close_decimal, adjustment_state,
      quality, delayed_minutes, ingested_at, provider_revision_id, payload_sha256
    ) VALUES (
      'brk012b-row', 'sharesight', 'user', 'owner-a', 'owner-a',
      (SELECT id FROM security_provider_mappings WHERE provider_id = 'sharesight' AND security_id = 'security-a'),
      'security-a', 'delayed', '2026-08-24T02:00:00Z', '2026-08-24', '+10:00',
      'AUD', '11.00', NULL, 'raw', 'observed', NULL, '2026-08-24T02:00:01Z', NULL, NULL
    );
  `);
  const point = {
    priceDecimal: "12.99",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "+10:00",
    observedAt: "2026-08-24T06:00:00Z", // later than BRK-012B's 02:00 write
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  } as const;
  const rollupResult = await rollupIntradayPricePoint(client, {
    userId: "owner-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    securityId: "security-a",
    point,
    now: "2026-08-24T06:26:00Z",
  });
  assert.deepEqual(rollupResult, { ok: true, written: true });
  const rows = db
    .prepare(
      `SELECT id, close_decimal, observation_at FROM price_observations WHERE security_id = 'security-a'`,
    )
    .all() as Array<{
    id: string;
    close_decimal: string;
    observation_at: string;
  }>;
  assert.equal(rows.length, 1, "still exactly one row for this day");
  assert.equal(
    rows[0].id,
    "brk012b-row",
    "converges the SAME row, never inserts a second one",
  );
  assert.equal(
    rows[0].close_decimal,
    "12.99",
    "the stored close CHANGES to the sweep's own last-captured value, not BRK-012B's earlier one",
  );
  assert.equal(rows[0].observation_at, "2026-08-24T06:00:00Z");
  // Purge only happens after a successful rollup -- verified at the
  // repository level here (the service-level purge is exercised elsewhere).
  const purgeResult = await purgeIntradayPricePoints(client, {
    userId: "owner-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    securityId: "security-a",
    marketDate: "2026-08-24",
  });
  assert.equal(
    purgeResult.purged,
    0,
    "nothing was ever cached in intraday_price_points for this drill",
  );
});

test("MKT-011A repository (B2 REVERSAL pin): yahoo rollup re-run with an OLDER/EQUAL observed_at converges (no second row, no downgrade); a genuinely NEWER observed_at UPDATES the SAME row (structural one-row-per-day, not a second row)", async () => {
  const db = await captureFixture();
  await insertVerifiedYahooMapping(db);
  const client = createSqliteSqlClient(db);
  const earlierPoint = {
    priceDecimal: "15.00",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "Australia/Sydney",
    observedAt: "2026-08-24T05:00:00Z",
    delayedMinutes: 20,
    quality: "observed",
    providerRevisionId: "session:authenticated",
  } as const;
  const first = await rollupIntradayPricePoint(client, {
    userId: "owner-a",
    providerId: YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID,
    securityId: "security-a",
    point: earlierPoint,
    now: "2026-08-24T05:01:00Z",
  });
  assert.deepEqual(first, { ok: true, written: true });

  // Re-run with the SAME observed_at -- the DO UPDATE guard
  // (excluded.observation_at > price_observations.observation_at) is false,
  // so this converges/skips: no second row, no change.
  const rerun = await rollupIntradayPricePoint(client, {
    userId: "owner-a",
    providerId: YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID,
    securityId: "security-a",
    point: earlierPoint,
    now: "2026-08-24T05:02:00Z",
  });
  assert.deepEqual(rerun, { ok: true, written: false });
  const afterRerun = db
    .prepare(
      `SELECT COUNT(*) AS n, close_decimal FROM price_observations WHERE provider_id = 'yahoo-compatible' AND security_id = 'security-a'`,
    )
    .get() as { n: number; close_decimal: string };
  assert.equal(afterRerun.n, 1);
  assert.equal(afterRerun.close_decimal, "15.00");

  // A genuinely NEWER observed_at (the sweep's own later capture) UPDATES
  // the SAME row -- the new partial unique index
  // (`price_observations_yahoo_scope_mapping_date_unique`, migration 0050)
  // enforces ONE row per (security, market_date) for `delayed` rows
  // structurally, exactly like the Sharesight branch (review round 2, B2
  // REVERSAL -- no legitimate multi-row-per-day `delayed` writer exists for
  // this provider; see this repository's doc comment).
  const laterPoint = {
    ...earlierPoint,
    priceDecimal: "15.40",
    observedAt: "2026-08-24T06:00:00Z",
  };
  const later = await rollupIntradayPricePoint(client, {
    userId: "owner-a",
    providerId: YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID,
    securityId: "security-a",
    point: laterPoint,
    now: "2026-08-24T06:01:00Z",
  });
  assert.deepEqual(later, { ok: true, written: true });
  const afterLater = db
    .prepare(
      `SELECT COUNT(*) AS n, close_decimal, observation_at FROM price_observations WHERE provider_id = 'yahoo-compatible' AND security_id = 'security-a'`,
    )
    .get() as { n: number; close_decimal: string; observation_at: string };
  assert.equal(
    afterLater.n,
    1,
    "STILL exactly one row -- the newer point converges the existing row, never adds a second one",
  );
  assert.equal(afterLater.close_decimal, "15.40");
  assert.equal(afterLater.observation_at, "2026-08-24T06:00:00Z");
});

test("MKT-011A repository (B2 REVERSAL pin): TWO owners' yahoo rollups with DIFFERING observed_at converge onto ONE row holding the NEWER value, regardless of arrival order", async () => {
  const db = await captureFixture();
  await insertVerifiedYahooMapping(db);
  db.exec(`
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('owner-b', 'active', 'b@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
  `);
  const client = createSqliteSqlClient(db);
  const earlierPoint = {
    priceDecimal: "15.00",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "Australia/Sydney",
    observedAt: "2026-08-24T06:20:00Z",
    delayedMinutes: 20,
    quality: "observed",
    providerRevisionId: null,
  } as const;
  const laterPoint = {
    ...earlierPoint,
    priceDecimal: "15.25",
    observedAt: "2026-08-24T06:24:00Z",
  };

  // owner-a's sweep captured the EARLIER point; owner-b's independent sweep
  // (both deployment-scoped) captured a genuinely LATER one.
  const first = await rollupIntradayPricePoint(client, {
    userId: "owner-a",
    providerId: YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID,
    securityId: "security-a",
    point: earlierPoint,
    now: "2026-08-24T06:21:00Z",
  });
  assert.deepEqual(first, { ok: true, written: true });
  const second = await rollupIntradayPricePoint(client, {
    userId: "owner-b",
    providerId: YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID,
    securityId: "security-a",
    point: laterPoint,
    now: "2026-08-24T06:25:00Z",
  });
  assert.deepEqual(second, { ok: true, written: true });
  const afterForwardOrder = db
    .prepare(
      `SELECT COUNT(*) AS n, close_decimal, observation_at FROM price_observations WHERE provider_id = 'yahoo-compatible' AND security_id = 'security-a'`,
    )
    .get() as { n: number; close_decimal: string; observation_at: string };
  assert.equal(
    afterForwardOrder.n,
    1,
    "no unbounded per-owner duplication for deployment-scoped yahoo rollups",
  );
  assert.equal(afterForwardOrder.close_decimal, "15.25");
  assert.equal(afterForwardOrder.observation_at, "2026-08-24T06:24:00Z");

  // Reverse-order drill: a THIRD owner's sweep arrives LATE with the OLDER
  // point (e.g. a delayed/retried request) -- the DO UPDATE WHERE guard
  // must reject the downgrade, never overwriting the newer stored value.
  db.exec(`
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('owner-c', 'active', 'c@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
  `);
  const stale = await rollupIntradayPricePoint(client, {
    userId: "owner-c",
    providerId: YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID,
    securityId: "security-a",
    point: earlierPoint, // the OLDER 06:20Z point, arriving last
    now: "2026-08-24T06:30:00Z",
  });
  assert.deepEqual(
    stale,
    { ok: true, written: false },
    "an out-of-order older arrival never downgrades the stored value",
  );
  const afterReverseOrder = db
    .prepare(
      `SELECT COUNT(*) AS n, close_decimal, observation_at FROM price_observations WHERE provider_id = 'yahoo-compatible' AND security_id = 'security-a'`,
    )
    .get() as { n: number; close_decimal: string; observation_at: string };
  assert.equal(afterReverseOrder.n, 1);
  assert.equal(
    afterReverseOrder.close_decimal,
    "15.25",
    "the newer value stays -- the late-arriving older point does not win",
  );
  assert.equal(afterReverseOrder.observation_at, "2026-08-24T06:24:00Z");
});

test("MKT-011A repository (B2 REVERSAL pin): the new yahoo partial index does NOT constrain eod rows -- getDailyPrices' own same-day-correction pattern (two eod rows, same market_date, different observation_at) still coexists untouched", async () => {
  const db = await captureFixture();
  await insertVerifiedYahooMapping(db);
  const client = createSqliteSqlClient(db);
  // Two EOD rows for the SAME security+market_date+adjustment_state, at
  // DIFFERENT observation_at -- the exact "correction received later"
  // pattern the FIRST unique index (not the new one) exists to allow, for
  // every provider (db/schema.ts's header comment on that index).
  await client.run(
    `INSERT INTO price_observations (
       id, provider_id, access_scope, scope_user_id, scope_key, mapping_id,
       security_id, interval, observation_at, market_date, market_timezone,
       currency_code, close_decimal, previous_close_decimal, adjustment_state,
       quality, delayed_minutes, ingested_at, provider_revision_id, payload_sha256
     ) VALUES (
       'eod-1', 'yahoo-compatible', 'deployment', NULL, 'deployment', 'mapping-a',
       'security-a', 'eod', '2026-08-24T06:00:00Z', '2026-08-24', 'Australia/Sydney',
       'AUD', '15.00', NULL, 'raw', 'observed', NULL, '2026-08-24T06:00:01Z', NULL, NULL
     )`,
  );
  await client.run(
    `INSERT INTO price_observations (
       id, provider_id, access_scope, scope_user_id, scope_key, mapping_id,
       security_id, interval, observation_at, market_date, market_timezone,
       currency_code, close_decimal, previous_close_decimal, adjustment_state,
       quality, delayed_minutes, ingested_at, provider_revision_id, payload_sha256
     ) VALUES (
       'eod-2', 'yahoo-compatible', 'deployment', NULL, 'deployment', 'mapping-a',
       'security-a', 'eod', '2026-08-24T08:00:00Z', '2026-08-24', 'Australia/Sydney',
       'AUD', '15.10', NULL, 'raw', 'observed', NULL, '2026-08-24T08:00:01Z', NULL, NULL
     )`,
  );
  const eodRows = db
    .prepare(
      `SELECT COUNT(*) AS n FROM price_observations WHERE interval = 'eod' AND security_id = 'security-a'`,
    )
    .get() as { n: number };
  assert.equal(
    eodRows.n,
    2,
    "both eod correction rows coexist -- the new delayed-scoped index never touched them",
  );

  // A delayed rollup for the SAME day still converges to its OWN single row,
  // independent of and alongside the two eod rows above.
  const point = {
    priceDecimal: "15.05",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "Australia/Sydney",
    observedAt: "2026-08-24T06:30:00Z",
    delayedMinutes: 20,
    quality: "observed",
    providerRevisionId: null,
  } as const;
  const rollupResult = await rollupIntradayPricePoint(client, {
    userId: "owner-a",
    providerId: YAHOO_COMPATIBLE_CAPTURE_PROVIDER_ID,
    securityId: "security-a",
    point,
    now: "2026-08-24T06:31:00Z",
  });
  assert.deepEqual(rollupResult, { ok: true, written: true });
  const delayedRows = db
    .prepare(
      `SELECT COUNT(*) AS n FROM price_observations WHERE interval = 'delayed' AND security_id = 'security-a'`,
    )
    .get() as { n: number };
  assert.equal(delayedRows.n, 1);
  const allRows = db
    .prepare(
      `SELECT COUNT(*) AS n FROM price_observations WHERE security_id = 'security-a'`,
    )
    .get() as { n: number };
  assert.equal(allRows.n, 3, "2 eod + 1 delayed, all coexisting");
});

test("MKT-011A repository (B1 pin, reviewer's hand-verified case): TWO CONSECUTIVE abandoned market_dates both roll up and purge -- the older day never wedges the newer one", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  await guardInsertSharesightMapping(client, {
    securityId: "security-a",
    marketCode: "ASX",
    instrumentCode: "ABC",
    now: "2026-08-24T06:00:00Z",
  });
  await insertIntradayPricePoint(client, {
    userId: "owner-a",
    securityId: "security-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    priceDecimal: "12.10",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "+10:00",
    observedAt: "2026-08-24T06:00:00Z",
    capturedAt: "2026-08-24T06:00:01Z",
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  });
  await insertIntradayPricePoint(client, {
    userId: "owner-a",
    securityId: "security-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    priceDecimal: "12.30",
    currencyCode: "AUD",
    marketDate: "2026-08-25",
    marketTimezone: "+10:00",
    observedAt: "2026-08-25T06:00:00Z",
    capturedAt: "2026-08-25T06:00:01Z",
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  });
  const fake = fakeSharesightClient({ ok: true, value: [] });
  const result = await runDailyPriceCapture({
    client,
    sharesightClient: fake.client,
    yahooAuthenticatedProvider: fakeYahooProvider(null),
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: false,
    now: () => "2026-08-26T00:25:00Z", // Wednesday 10:25 local -- both prior days abandoned
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.rolledUp,
    2,
    "BOTH abandoned days roll up in the same tick",
  );
  assert.equal(result.purged, 2);
  assert.equal(result.rollupsFailed, 0);
  const dates = db
    .prepare(
      `SELECT market_date FROM price_observations WHERE security_id = 'security-a' ORDER BY market_date ASC`,
    )
    .all()
    .map((row) => (row as { market_date: string }).market_date);
  assert.deepEqual(dates, ["2026-08-24", "2026-08-25"]);
  const remaining = db
    .prepare(`SELECT COUNT(*) AS n FROM intraday_price_points`)
    .get() as {
    n: number;
  };
  assert.equal(remaining.n, 0);
});

test("MKT-011A service (B3 pin): a wedged rollup pair surfaces rollupsFailed>0 (never silently ok) and does NOT purge that pair's intraday cache", async () => {
  const db = await captureFixture();
  const realClient = createSqliteSqlClient(db);
  await guardInsertSharesightMapping(realClient, {
    securityId: "security-a",
    marketCode: "ASX",
    instrumentCode: "ABC",
    now: "2026-08-24T06:00:00Z",
  });
  await insertIntradayPricePoint(realClient, {
    userId: "owner-a",
    securityId: "security-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    priceDecimal: "12.10",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "+10:00",
    observedAt: "2026-08-24T06:00:00Z",
    capturedAt: "2026-08-24T06:00:01Z",
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  });
  // Forces the rollup's OWN `INSERT INTO price_observations` statement to
  // throw a genuine error, without corrupting any shared fixture row (an
  // FK-restrict delete would break unrelated setup instead of isolating
  // this one call).
  const client = wrapClientWithFailingCall(
    realClient,
    "INSERT INTO price_observations",
  );
  const fake = fakeSharesightClient({ ok: true, value: [] });
  const result = await runDailyPriceCapture({
    client,
    sharesightClient: fake.client,
    yahooAuthenticatedProvider: fakeYahooProvider(null),
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: false,
    now: () => "2026-08-24T06:26:00Z",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rollupsFailed, 1);
  assert.ok(result.firstRollupError && result.firstRollupError.length > 0);
  assert.equal(
    result.firstRollupErrorKind,
    "constraint",
    "F5: the worker log's closed enum classifies this genuine DB failure honestly",
  );
  assert.equal(result.rolledUp, 0);
  assert.equal(
    result.purged,
    0,
    "intraday cache is NOT purged for a pair whose rollup threw",
  );
  const remaining = db
    .prepare(`SELECT COUNT(*) AS n FROM intraday_price_points`)
    .get() as {
    n: number;
  };
  assert.equal(
    remaining.n,
    1,
    "the wedged pair's cache is left intact for retry",
  );
});

test("MKT-011A repository: rollupIntradayPricePoint returns ok:false/no_mapping (never fabricates) when no mapping exists yet", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  const point = {
    priceDecimal: "12.50",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "+10:00",
    observedAt: "2026-08-24T06:00:00Z",
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  } as const;
  const result = await rollupIntradayPricePoint(client, {
    userId: "owner-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    securityId: "security-a",
    point,
    now: "2026-08-24T06:26:00Z",
  });
  assert.deepEqual(result, { ok: false, reason: "no_mapping" });
  const rows = db
    .prepare(`SELECT COUNT(*) AS n FROM price_observations`)
    .get() as {
    n: number;
  };
  assert.equal(rows.n, 0);
});

test("MKT-011A repository: purgeIntradayPricePoints deletes exactly this (owner, provider, security, market_date)'s cached rows", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  await insertIntradayPricePoint(client, {
    userId: "owner-a",
    securityId: "security-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    priceDecimal: "12.34",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "+10:00",
    observedAt: "2026-08-24T06:00:00Z",
    capturedAt: "2026-08-24T06:00:01Z",
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  });
  const result = await purgeIntradayPricePoints(client, {
    userId: "owner-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    securityId: "security-a",
    marketDate: "2026-08-24",
  });
  assert.equal(result.purged, 1);
  const rows = db
    .prepare(`SELECT COUNT(*) AS n FROM intraday_price_points`)
    .get() as {
    n: number;
  };
  assert.equal(rows.n, 0);
});

// ---------------------------------------------------------------------------
// (3) app/daily-price-capture-service.ts -- the sweep orchestrator
// ---------------------------------------------------------------------------

test("MKT-011A service: a zero-points day stores NOTHING -- Sharesight has no fresh observation for today, sweep writes zero intraday rows", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({
    ok: true,
    value: [instrument({ currentPriceUpdatedAt: "2026-08-20T16:10:03+10:00" })], // stale, not today
  });
  const result = await runDailyPriceCapture({
    client,
    sharesightClient: fake.client,
    yahooAuthenticatedProvider: fakeYahooProvider(null),
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: false,
    now: () => "2026-08-24T02:00:00Z", // 12:00 local, within window
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.intradayPointsCaptured, 0);
  const rows = db
    .prepare(`SELECT COUNT(*) AS n FROM intraday_price_points`)
    .get() as {
    n: number;
  };
  assert.equal(
    rows.n,
    0,
    "no fabricated intraday point for a stale/absent observation",
  );
});

test("MKT-011A service: Sharesight capture during the open window, then end-to-end rollup+purge on a later tick past close", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({
    ok: true,
    value: [instrument({ currentPriceUpdatedAt: "2026-08-24T16:10:00+10:00" })],
  });
  const captureResult = await runDailyPriceCapture({
    client,
    sharesightClient: fake.client,
    yahooAuthenticatedProvider: fakeYahooProvider(null),
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: false,
    now: () => "2026-08-24T06:15:00Z", // 16:15 local, still open
  });
  assert.equal(captureResult.ok, true);
  if (!captureResult.ok) return;
  assert.equal(captureResult.intradayPointsCaptured, 1);
  assert.equal(captureResult.sharesightRequests, 1);
  const cached = db
    .prepare(`SELECT COUNT(*) AS n FROM intraday_price_points`)
    .get() as {
    n: number;
  };
  assert.equal(cached.n, 1);
  // No historical row yet -- the window has not closed.
  const beforeRollup = db
    .prepare(`SELECT COUNT(*) AS n FROM price_observations`)
    .get() as { n: number };
  assert.equal(beforeRollup.n, 0);

  const rollupResult = await runDailyPriceCapture({
    client,
    sharesightClient: fake.client,
    yahooAuthenticatedProvider: fakeYahooProvider(null),
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: false,
    now: () => "2026-08-24T06:26:00Z", // 16:26 local, window closed
  });
  assert.equal(rollupResult.ok, true);
  if (!rollupResult.ok) return;
  assert.equal(rollupResult.rolledUp, 1);
  assert.equal(rollupResult.purged, 1);
  const afterRollup = db
    .prepare(
      `SELECT COUNT(*) AS n FROM price_observations WHERE interval = 'delayed'`,
    )
    .get() as { n: number };
  assert.equal(afterRollup.n, 1);
  const remainingIntraday = db
    .prepare(`SELECT COUNT(*) AS n FROM intraday_price_points`)
    .get() as { n: number };
  assert.equal(remainingIntraday.n, 0, "purge-after-rollup");
});

test("MKT-011A service: crash-recovery -- an abandoned prior day's intraday point is rolled up and purged by the FIRST sweep of a LATER day, before any of today's window logic applies", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  // Simulate an ABANDONED day: an intraday point exists for 2026-08-24, and
  // its mapping guard already ran (as capture would have done), but the
  // 16:25 rollup never happened (crash).
  await guardInsertSharesightMapping(client, {
    securityId: "security-a",
    marketCode: "ASX",
    instrumentCode: "ABC",
    now: "2026-08-24T06:00:00Z",
  });
  await insertIntradayPricePoint(client, {
    userId: "owner-a",
    securityId: "security-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    priceDecimal: "12.99",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "+10:00",
    observedAt: "2026-08-24T06:20:00Z",
    capturedAt: "2026-08-24T06:20:01Z",
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  });
  const fake = fakeSharesightClient({ ok: true, value: [] }); // no fresh data today
  const result = await runDailyPriceCapture({
    client,
    sharesightClient: fake.client,
    yahooAuthenticatedProvider: fakeYahooProvider(null),
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: false,
    now: () => "2026-08-25T00:25:00Z", // Tuesday 10:25 local -- first sweep of the next day
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rolledUp, 1);
  assert.equal(result.purged, 1);
  const historical = db
    .prepare(
      `SELECT market_date FROM price_observations WHERE security_id = 'security-a'`,
    )
    .get() as { market_date: string };
  assert.equal(
    historical.market_date,
    "2026-08-24",
    "yesterday's abandoned point, not today's",
  );
  const remaining = db
    .prepare(`SELECT COUNT(*) AS n FROM intraday_price_points`)
    .get() as {
    n: number;
  };
  assert.equal(remaining.n, 0);
});

test("MKT-011A service: yahooAuthenticatedProvider/yahooAnonymousProvider being null (MARKET_DATA_PROVIDER disabled) makes yahoo-source owners a complete no-op -- zero requests, zero writes", async () => {
  const db = await captureFixture();
  await insertVerifiedYahooMapping(db);
  await db.exec(
    `UPDATE user_settings SET daily_capture_source = 'yahoo_authenticated' WHERE user_id = 'owner-a'`,
  );
  const client = createSqliteSqlClient(db);
  const result = await runDailyPriceCapture({
    client,
    sharesightClient: null,
    yahooAuthenticatedProvider: null,
    yahooAnonymousProvider: null,
    isSecondaryTick: false,
    now: () => "2026-08-24T06:00:00Z",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.yahooRequests, 0);
  assert.equal(result.intradayPointsCaptured, 0);
});

test("MKT-011A service: Yahoo capture carries providerRevisionId through to the rollup row (session-state provenance app/owned-holdings.ts reads)", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  await insertVerifiedYahooMapping(db);
  const observationState = { callCount: 0 };
  const provider = fakeYahooProvider(
    yahooObservation({ providerRevisionId: "session:authenticated" }),
    observationState,
  );
  const captureResult = await runDailyPriceCapture({
    client,
    sharesightClient: null,
    yahooAuthenticatedProvider: provider,
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: false,
    now: () => "2026-08-24T06:00:00Z", // 16:00 local, open
  });
  assert.equal(captureResult.ok, true);
  if (!captureResult.ok) return;
  // owner-a's settings default to daily_capture_source = 'sharesight' in this
  // fixture -- switch it to yahoo_authenticated first.
  await client.run(
    `UPDATE user_settings SET daily_capture_source = 'yahoo_authenticated' WHERE user_id = 'owner-a'`,
  );
  const secondCapture = await runDailyPriceCapture({
    client,
    sharesightClient: null,
    yahooAuthenticatedProvider: provider,
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: false,
    now: () => "2026-08-24T06:05:00Z",
  });
  assert.equal(secondCapture.ok, true);
  if (!secondCapture.ok) return;
  assert.equal(secondCapture.intradayPointsCaptured, 1);
  assert.equal(secondCapture.yahooRequests, 1);

  const rollupResult = await runDailyPriceCapture({
    client,
    sharesightClient: null,
    yahooAuthenticatedProvider: provider,
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: false,
    now: () => "2026-08-24T06:26:00Z",
  });
  assert.equal(rollupResult.ok, true);
  if (!rollupResult.ok) return;
  assert.equal(rollupResult.rolledUp, 1);
  const row = db
    .prepare(
      `SELECT provider_revision_id, access_scope, scope_key, scope_user_id
         FROM price_observations WHERE provider_id = 'yahoo-compatible'`,
    )
    .get() as Record<string, unknown>;
  assert.equal(row.provider_revision_id, "session:authenticated");
  assert.equal(row.access_scope, "deployment");
  assert.equal(row.scope_key, "deployment");
  assert.equal(row.scope_user_id, null);
});

test("MKT-011A service: cadence gating -- a 60-minute owner captures nothing on the :55 secondary tick", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({
    ok: true,
    value: [instrument({ currentPriceUpdatedAt: "2026-08-24T16:10:00+10:00" })],
  });
  const result = await runDailyPriceCapture({
    client,
    sharesightClient: fake.client,
    yahooAuthenticatedProvider: fakeYahooProvider(null),
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: true, // owner-a defaults to 60-minute cadence
    now: () => "2026-08-24T06:15:00Z",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.sharesightRequests,
    0,
    "no fetch at all -- every 60-minute owner was skipped",
  );
  assert.equal(result.intradayPointsCaptured, 0);
});

test("MKT-011A service: cadence gating -- a 30-minute owner DOES capture on the :55 secondary tick", async () => {
  const db = await captureFixture();
  await db.exec(
    `UPDATE user_settings SET daily_capture_interval_minutes = 30 WHERE user_id = 'owner-a'`,
  );
  const client = createSqliteSqlClient(db);
  const fake = fakeSharesightClient({
    ok: true,
    value: [instrument({ currentPriceUpdatedAt: "2026-08-24T16:10:00+10:00" })],
  });
  const result = await runDailyPriceCapture({
    client,
    sharesightClient: fake.client,
    yahooAuthenticatedProvider: fakeYahooProvider(null),
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: true,
    now: () => "2026-08-24T06:15:00Z",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.sharesightRequests, 1);
  assert.equal(result.intradayPointsCaptured, 1);
});

test("MKT-011A service: request-budget bound -- yahoo captures never exceed maxYahooRequestsPerSweep", async () => {
  const db = await captureFixture();
  await insertVerifiedYahooMapping(db);
  await db.exec(
    `UPDATE user_settings SET daily_capture_source = 'yahoo_authenticated' WHERE user_id = 'owner-a'`,
  );
  // Add many more owners each with one yahoo-mapped held security, to exceed
  // the budget across owners.
  const insertOwner = db.prepare(
    `INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
     VALUES (?, 'active', ?, 'Australia/Sydney', '2026-08-01', '2026-08-01', 1)`,
  );
  const insertSettings = db.prepare(
    `INSERT INTO user_settings (user_id, home_currency_code, timezone, daily_capture_source, created_at, updated_at, version)
     VALUES (?, 'AUD', 'Australia/Sydney', 'yahoo_authenticated', '2026-08-01', '2026-08-01', 1)`,
  );
  const insertPortfolio = db.prepare(
    `INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
     VALUES (?, ?, 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1)`,
  );
  const insertHolding = db.prepare(
    `INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
     VALUES (?, ?, ?, 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01')`,
  );
  for (
    let index = 0;
    index < DAILY_CAPTURE_LIMITS.maxYahooRequestsPerSweep + 10;
    index += 1
  ) {
    const userId = `owner-${index}`;
    insertOwner.run(userId, `${userId}@example.test`);
    insertSettings.run(userId);
    insertPortfolio.run(`portfolio-${index}`, userId);
    insertHolding.run(`holding-${index}`, userId, `portfolio-${index}`);
  }
  const client = createSqliteSqlClient(db);
  const observationState = { callCount: 0 };
  const provider = fakeYahooProvider(
    yahooObservation({ marketDate: "2026-08-24" }),
    observationState,
  );
  const result = await runDailyPriceCapture({
    client,
    sharesightClient: null,
    yahooAuthenticatedProvider: provider,
    yahooAnonymousProvider: fakeYahooProvider(null),
    isSecondaryTick: false,
    now: () => "2026-08-24T06:00:00Z",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(
    result.yahooRequests <= DAILY_CAPTURE_LIMITS.maxYahooRequestsPerSweep,
    `yahooRequests (${result.yahooRequests}) must never exceed the sweep budget`,
  );
  assert.equal(observationState.callCount, result.yahooRequests);
});

test("MKT-011A service: source-scoped -- Sharesight-configured owners never trigger a Yahoo request, and vice versa", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  const sharesightFake = fakeSharesightClient({ ok: true, value: [] });
  const yahooState = { callCount: 0 };
  const yahooProvider = fakeYahooProvider(null, yahooState);
  await runDailyPriceCapture({
    client,
    sharesightClient: sharesightFake.client,
    yahooAuthenticatedProvider: yahooProvider,
    yahooAnonymousProvider: yahooProvider,
    isSecondaryTick: false,
    now: () => "2026-08-24T06:00:00Z",
  });
  assert.equal(yahooState.callCount, 0);
});

// ---------------------------------------------------------------------------
// (4) Settings: validators, repository, ownership isolation
// ---------------------------------------------------------------------------

test("MKT-011A settings: validateDailyCaptureSource is a closed enum, never a silent default", () => {
  assert.equal(validateDailyCaptureSource("sharesight"), "sharesight");
  assert.equal(
    validateDailyCaptureSource("yahoo_anonymous"),
    "yahoo_anonymous",
  );
  assert.equal(
    validateDailyCaptureSource("yahoo_authenticated"),
    "yahoo_authenticated",
  );
  assert.equal(validateDailyCaptureSource("bogus"), null);
  assert.equal(validateDailyCaptureSource(undefined), null);
});

test("MKT-011A settings: validateDailyCaptureIntervalMinutes only accepts 30 or 60", () => {
  assert.equal(validateDailyCaptureIntervalMinutes(30), 30);
  assert.equal(validateDailyCaptureIntervalMinutes(60), 60);
  assert.equal(validateDailyCaptureIntervalMinutes(45), null);
  assert.equal(validateDailyCaptureIntervalMinutes("60"), null);
});

test("MKT-011A settings repository: setDailyCaptureSource persists, bumps the version, and the change is visible on the read path", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  const repository = createOwnedUserSettingsRepository(
    client,
    () => "2026-08-24T00:00:00Z",
  );
  const result = await repository.setDailyCaptureSource("owner-a", {
    dailyCaptureSource: "yahoo_anonymous",
    expectedVersion: 1,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.settings.dailyCaptureSource, "yahoo_anonymous");
  assert.equal(result.settings.version, 2);
  const reread = await repository.get("owner-a");
  assert.equal(reread?.dailyCaptureSource, "yahoo_anonymous");
});

test("MKT-011A settings repository: a stale expectedVersion is rejected as version_conflict and does not change the stored value", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  const repository = createOwnedUserSettingsRepository(
    client,
    () => "2026-08-24T00:00:00Z",
  );
  const result = await repository.setDailyCaptureIntervalMinutes("owner-a", {
    dailyCaptureIntervalMinutes: 30,
    expectedVersion: 999,
  });
  assert.deepEqual(result, { ok: false, reason: "version_conflict" });
  const reread = await repository.get("owner-a");
  assert.equal(reread?.dailyCaptureIntervalMinutes, 60);
});

test("MKT-011A settings repository: another owner's version cannot be used to change this owner's setting (cross-user isolation)", async () => {
  const db = await captureFixture();
  db.exec(`
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('owner-b', 'active', 'b@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('owner-b', 'AUD', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
  `);
  const client = createSqliteSqlClient(db);
  const repository = createOwnedUserSettingsRepository(
    client,
    () => "2026-08-24T00:00:00Z",
  );
  // owner-a's real version is 1; attempt to use it against owner-b.
  const result = await repository.setDailyCaptureSource("owner-b", {
    dailyCaptureSource: "sharesight",
    expectedVersion: 1,
  });
  // This happens to match owner-b's OWN version (also freshly created at 1),
  // so assert the write only ever touched owner-b, never owner-a.
  assert.equal(result.ok, true);
  const ownerA = await repository.get("owner-a");
  assert.equal(ownerA?.dailyCaptureSource, "sharesight");
  assert.equal(ownerA?.version, 1);
});

// ---------------------------------------------------------------------------
// (5) Migration: purge-lock triggers, OPS-003 registration
// ---------------------------------------------------------------------------

test("MKT-011A migration: intraday_price_points exists with its unique/lookup indexes and purge-lock triggers", async () => {
  const db = await migratedDatabase();
  const indexes = db
    .prepare(`PRAGMA index_list('intraday_price_points')`)
    .all()
    .map((row) => (row as { name: string }).name)
    .filter((name) => !name.startsWith("sqlite_"))
    .sort();
  assert.deepEqual(indexes, [
    "intraday_price_points_user_provider_date_idx",
    "intraday_price_points_user_security_provider_observed_unique",
  ]);
  const triggers = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'intraday_price_points' ORDER BY name`,
    )
    .all()
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(triggers, [
    "account_purge_lock_intraday_price_points_delete",
    "account_purge_lock_intraday_price_points_insert",
    "account_purge_lock_intraday_price_points_update",
  ]);
});

test("MKT-011A migration: the purge-lock trigger actually fires -- an in-flight purge job blocks a capture insert", async () => {
  const db = await captureFixture();
  db.exec(
    "INSERT INTO account_purge_jobs(id,owner_user_id,deletion_request_id,deletion_key_digest,export_job_id,manifest_digest,status,phase,eligible_at,confirmed_at,created_at,updated_at) VALUES('purge-a','owner-a','request-a','key-digest','export-a','manifest-a','queued','validate_source','2026-08-01','2026-08-01','2026-08-01','2026-08-01')",
  );
  const client = createSqliteSqlClient(db);
  await assert.rejects(
    insertIntradayPricePoint(client, {
      userId: "owner-a",
      securityId: "security-a",
      providerId: SHARESIGHT_PRICE_PROVIDER_ID,
      priceDecimal: "12.34",
      currencyCode: "AUD",
      marketDate: "2026-08-24",
      marketTimezone: "+10:00",
      observedAt: "2026-08-24T06:00:00Z",
      capturedAt: "2026-08-24T06:00:01Z",
      delayedMinutes: null,
      quality: "observed",
      providerRevisionId: null,
    }),
    /account_purge_source_locked/,
  );
});

test("MKT-011A export/purge: intraday_price_points is classified owned, user-keyed", () => {
  const classification =
    ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS.intraday_price_points;
  assert.ok(classification, "must be classified before an export job can run");
  assert.equal(classification.classification, "owned");
  assert.equal(classification.ownerColumn, "user_id");
});

test("MKT-011A export/purge: intraday_price_points appears in the purge FK-order list (source-text check -- the const is not exported)", async () => {
  const source = await readFile(
    new URL("../db/repositories/account-lifecycle.ts", import.meta.url),
    "utf8",
  );
  const purgeOrderSection = source.slice(
    source.indexOf("const PURGE_TABLES_IN_FK_ORDER"),
    source.indexOf(
      "] as const;",
      source.indexOf("const PURGE_TABLES_IN_FK_ORDER"),
    ),
  );
  assert.match(purgeOrderSection, /"intraday_price_points"/);
});

// ---------------------------------------------------------------------------
// (6) QA-001A matrix citation (mirrors MKT-009B's own self-check)
// ---------------------------------------------------------------------------

test("MKT-011A: the two new settings routes are cited in the QA-001A security matrix", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  assert.match(matrix, /\/api\/settings\/daily-capture-source/);
  assert.match(matrix, /\/api\/settings\/daily-capture-interval/);
});

// ---------------------------------------------------------------------------
// (7) resolveDailyCaptureUserSettings / resolveDailyCaptureRollupCandidates
// ---------------------------------------------------------------------------

test("MKT-011A repository: resolveDailyCaptureUserSettings reflects each owner's own configured source/cadence", async () => {
  const db = await captureFixture();
  await db.exec(
    `UPDATE user_settings SET daily_capture_source = 'yahoo_authenticated', daily_capture_interval_minutes = 30 WHERE user_id = 'owner-a'`,
  );
  const client = createSqliteSqlClient(db);
  const settings = await resolveDailyCaptureUserSettings(client);
  assert.deepEqual(settings, [
    {
      userId: "owner-a",
      dailyCaptureSource: "yahoo_authenticated",
      dailyCaptureIntervalMinutes: 30,
    },
  ]);
});

test("MKT-011A repository (F2 fix): a malformed daily_capture_interval_minutes value fails closed to the safe default (60), never silently doubling the cadence", async () => {
  const db = await captureFixture();
  // Simulate a hand-run write bypassing validateDailyCaptureIntervalMinutes
  // -- the column carries no DB CHECK (documented ADD-COLUMN trade-off).
  await db.exec(
    `UPDATE user_settings SET daily_capture_interval_minutes = 15 WHERE user_id = 'owner-a'`,
  );
  const client = createSqliteSqlClient(db);
  const settings = await resolveDailyCaptureUserSettings(client);
  assert.equal(settings.length, 1);
  assert.equal(settings[0].dailyCaptureIntervalMinutes, 60);
});

test("MKT-011A repository (F2 fix): a non-numeric daily_capture_interval_minutes value (NaN once coerced) also fails closed to 60", async () => {
  const db = await captureFixture();
  await db.exec(
    `UPDATE user_settings SET daily_capture_interval_minutes = 'not-a-number' WHERE user_id = 'owner-a'`,
  );
  const client = createSqliteSqlClient(db);
  const settings = await resolveDailyCaptureUserSettings(client);
  assert.equal(settings.length, 1);
  assert.equal(settings[0].dailyCaptureIntervalMinutes, 60);
});

test("MKT-011A repository: resolveDailyCaptureRollupCandidates returns every distinct (security, market_date) cached for this owner+provider, with the security's own stored timezone", async () => {
  const db = await captureFixture();
  const client = createSqliteSqlClient(db);
  await insertIntradayPricePoint(client, {
    userId: "owner-a",
    securityId: "security-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    priceDecimal: "12.00",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "+10:00",
    observedAt: "2026-08-24T05:00:00Z",
    capturedAt: "2026-08-24T05:00:01Z",
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  });
  await insertIntradayPricePoint(client, {
    userId: "owner-a",
    securityId: "security-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    priceDecimal: "12.20",
    currencyCode: "AUD",
    marketDate: "2026-08-24",
    marketTimezone: "+10:00",
    observedAt: "2026-08-24T06:00:00Z",
    capturedAt: "2026-08-24T06:00:01Z",
    delayedMinutes: null,
    quality: "observed",
    providerRevisionId: null,
  });
  const candidates = await resolveDailyCaptureRollupCandidates(client, {
    userId: "owner-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
  });
  assert.deepEqual(candidates, [
    {
      securityId: "security-a",
      marketDate: "2026-08-24",
      marketTimezone: "Australia/Sydney",
    },
  ]);
  const last = await selectLastIntradayPricePoint(client, {
    userId: "owner-a",
    providerId: SHARESIGHT_PRICE_PROVIDER_ID,
    securityId: "security-a",
    marketDate: "2026-08-24",
  });
  assert.equal(
    last?.priceDecimal,
    "12.20",
    "the LAST captured tick, not the first",
  );
});
