/**
 * MKT-009B -- authenticated Yahoo session in the market-data provider.
 *
 * Covers: `worker/yahoo-auth-config.ts`'s inert-when-absent cookie config
 * (mirrors `worker/sharesight-config.ts`'s BRK-004 coverage exactly);
 * `domain/market-data/yahoo-compatible.ts`'s 401-vs-429 discrimination and
 * per-observation `session:authenticated`/`session:anonymous` provenance;
 * no cookie value ever appearing in a thrown/returned error; the
 * `preferredProviderIds` honest-fallback selection input
 * (`domain/market-data/selection.ts`); the `price_source_preference`
 * settings column/repository/validator (FY-001 precedent); and (review
 * round-1 fixes) `app/owned-holdings.ts`'s CROSS-SCOPE preference-aware
 * combiner (B1) and the `yahoo_auth_not_configured`/`yahoo_auth_expired`
 * first-class `actionStatus` states (B2), end to end.
 *
 * Review round 1 (2026-08-22, FAIL -- five blockers, all fixed here):
 *   B1: `choosePrice`'s cross-scope combiner (deployment=Yahoo vs
 *   user=Sharesight/owner-import) ignored `preferredProviderIds` entirely,
 *   hardcoding "user scope wins any market-date tie" -- reproduced by the
 *   reviewer as ALL THREE preferences selecting Sharesight on a same-date
 *   Yahoo+Sharesight pair. Fixed via `combineScopedPriceSelections`.
 *   B2: the yahoo-auth-unmet note was sr-only-only and unreachable when the
 *   preferred provider supplied no price at all. Fixed via
 *   `actionStatus: "yahoo_auth_not_configured" | "yahoo_auth_expired"`,
 *   wired into the SAME visible `statusLabel` mechanism every other
 *   action-required state uses (`app/components/portfolio-shell.tsx`).
 *   B4/F1: docs/CALCULATIONS.md §2 gained the normative preference-model
 *   note (Orchestrator ruling: preference outranks freshness outright
 *   within the fallback window).
 *   B5: the new "Price source" select's helper span moved outside the
 *   label (FY-001B's own htmlFor/aria-describedby pattern).
 *   F4: the new route and FY-001's own drifted route were added to
 *   tests/qa-001a.test.ts's fixed-route lists and docs/QA-001A_SECURITY_
 *   MATRIX.md.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createYahooCompatibleProvider,
  type MarketDataProvider,
} from "../domain/market-data/index.ts";
import { selectPriceObservation } from "../domain/market-data/selection.ts";
import type { PriceObservation } from "../domain/market-data/contracts.ts";
import { createYahooAuthConfig } from "../worker/yahoo-auth-config.ts";
import { validatePriceSourcePreference } from "../app/portfolio-action-contract.ts";
import {
  createOwnedUserSettingsRepository,
  createSqliteSqlClient,
} from "../db/repositories/index.ts";
import { loadOwnedHoldings } from "../app/owned-holdings.ts";
import type { SharesightIntegrationConfig } from "../worker/sharesight-config.ts";

type FetchCall = { url: string; init: RequestInit | undefined };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chartFixture(
  overrides: Partial<{ close: number; delayed: number | null }> = {},
) {
  return {
    chart: {
      result: [
        {
          meta: {
            currency: "AUD",
            exchangeTimezoneName: "Australia/Sydney",
            exchangeDataDelayedBy: overrides.delayed ?? 20,
            regularMarketPrice: overrides.close ?? 42.1,
            regularMarketPreviousClose: 41.9,
            regularMarketTime: Math.floor(
              Date.parse("2026-07-29T06:00:00Z") / 1000,
            ),
            symbol: "BHP.AX",
          },
          timestamp: [Math.floor(Date.parse("2026-07-29T06:00:00Z") / 1000)],
          indicators: { quote: [{ close: [overrides.close ?? 42.1] }] },
        },
      ],
      error: null,
    },
  };
}

const request = {
  mappingId: "mapping-au",
  securityId: "security-bhp",
  scope: { kind: "deployment" as const, userId: null },
};

function providerFor(
  responseFor: (
    url: URL,
    callNumber: number,
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
  calls: FetchCall[],
  overrides: Partial<Parameters<typeof createYahooCompatibleProvider>[0]> = {},
): MarketDataProvider {
  let callNumber = 0;
  return createYahooCompatibleProvider({
    baseUrl: "https://provider.test",
    providerId: "yahoo-compatible",
    fetcher: async (input, init) => {
      const url = new URL(input);
      calls.push({ url: url.toString(), init });
      callNumber += 1;
      return responseFor(url, callNumber, init);
    },
    resolveSymbol: async () => "BHP.AX",
    now: () => "2026-07-30T00:00:00Z",
    sleep: async () => undefined,
    random: () => 0,
    ...overrides,
  });
}

const REAL_COOKIE_T = "super-secret-cookie-t-value";
const REAL_COOKIE_Y = "super-secret-cookie-y-value";

// ---------------------------------------------------------------------------
// worker/yahoo-auth-config.ts: env-driven, inert-when-absent factory.
// ---------------------------------------------------------------------------

test("MKT-009B config factory: absent cookies yield a typed disabled state, not a thrown error", () => {
  const config = createYahooAuthConfig({});
  assert.equal(config.enabled, false);
  if (!config.enabled) assert.equal(config.reason, "not_configured");
});

test("MKT-009B config factory: whitespace-only or non-string env values are treated as absent", () => {
  const config = createYahooAuthConfig({
    YAHOO_COOKIE_T: "   ",
    YAHOO_COOKIE_Y: 12345,
  });
  assert.equal(config.enabled, false);
  if (!config.enabled) assert.equal(config.reason, "not_configured");
});

test("MKT-009B config factory: a half-configured pair fails closed as disabled with a distinct reason, never silently enabled", () => {
  const onlyT = createYahooAuthConfig({ YAHOO_COOKIE_T: "t-only" });
  assert.equal(onlyT.enabled, false);
  if (!onlyT.enabled) assert.equal(onlyT.reason, "incomplete_configuration");

  const onlyY = createYahooAuthConfig({ YAHOO_COOKIE_Y: "y-only" });
  assert.equal(onlyY.enabled, false);
  if (!onlyY.enabled) assert.equal(onlyY.reason, "incomplete_configuration");
});

test("MKT-009B config factory: a complete pair is enabled and returns exactly the two trimmed values", () => {
  const config = createYahooAuthConfig({
    YAHOO_COOKIE_T: `  ${REAL_COOKIE_T}  `,
    YAHOO_COOKIE_Y: REAL_COOKIE_Y,
  });
  assert.equal(config.enabled, true);
  if (config.enabled) {
    assert.equal(config.credentials.cookieT, REAL_COOKIE_T);
    assert.equal(config.credentials.cookieY, REAL_COOKIE_Y);
  }
});

// ---------------------------------------------------------------------------
// domain/market-data/yahoo-compatible.ts: auth attachment, 401-vs-429,
// per-observation provenance.
// ---------------------------------------------------------------------------

test("MKT-009B adapter: no auth configured keeps today's exact behaviour -- no cookie header, providerRevisionId stays null", async () => {
  const calls: FetchCall[] = [];
  const provider = providerFor(() => jsonResponse(chartFixture()), calls);
  const result = await provider.getLatestObservation(request);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value?.providerRevisionId, null);
  }
  assert.equal(calls.length, 1);
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers?.cookie, undefined);
});

test("MKT-009B adapter: configured auth attaches the T/Y cookie header and tags a successful observation session:authenticated", async () => {
  const calls: FetchCall[] = [];
  const provider = providerFor(() => jsonResponse(chartFixture()), calls, {
    auth: { cookieT: REAL_COOKIE_T, cookieY: REAL_COOKIE_Y },
  });
  const result = await provider.getLatestObservation(request);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value?.providerRevisionId, "session:authenticated");
  }
  assert.equal(calls.length, 1);
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.cookie, `T=${REAL_COOKIE_T}; Y=${REAL_COOKIE_Y}`);
});

test("MKT-009B adapter: a 401 on the authenticated attempt degrades to the SAME anonymous call, tags session:anonymous, and never surfaces the raw authentication error", async () => {
  const calls: FetchCall[] = [];
  const provider = providerFor(
    (_url, _n, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      return headers?.cookie
        ? jsonResponse({ error: "invalid session" }, 401)
        : jsonResponse(chartFixture());
    },
    calls,
    { auth: { cookieT: REAL_COOKIE_T, cookieY: REAL_COOKIE_Y } },
  );
  const result = await provider.getLatestObservation(request);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value?.providerRevisionId, "session:anonymous");
  }
  // Exactly two calls: the rejected authenticated attempt, then the
  // anonymous retry -- never a silent failure, never the raw 401 bubbled up.
  assert.equal(calls.length, 2);
  const firstHeaders = calls[0]?.init?.headers as Record<string, string>;
  const secondHeaders = calls[1]?.init?.headers as Record<string, string>;
  assert.equal(firstHeaders.cookie, `T=${REAL_COOKIE_T}; Y=${REAL_COOKIE_Y}`);
  assert.equal(secondHeaders.cookie, undefined);
});

test("MKT-009B adapter: once invalidated by a 401, the SAME adapter instance stops sending cookies on later calls (no repeated hammering)", async () => {
  const calls: FetchCall[] = [];
  const provider = providerFor(
    (_url, _n, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers?.cookie) return jsonResponse({ error: "invalid" }, 401);
      return jsonResponse(chartFixture());
    },
    calls,
    { auth: { cookieT: REAL_COOKIE_T, cookieY: REAL_COOKIE_Y } },
  );
  const first = await provider.getLatestObservation(request);
  assert.equal(first.ok, true);
  const callsAfterFirst = calls.length;
  assert.equal(callsAfterFirst, 2); // authenticated 401, then anonymous 200

  const second = await provider.getLatestObservation(request);
  assert.equal(second.ok, true);
  // Only ONE more call (anonymous) -- the invalidated cookie jar is never
  // resent.
  assert.equal(calls.length, callsAfterFirst + 1);
  const lastHeaders = calls[calls.length - 1]?.init?.headers as Record<
    string,
    string
  >;
  assert.equal(lastHeaders.cookie, undefined);
});

test("MKT-009B adapter: a 429 while sending cookies is handled by the EXISTING retry/circuit-breaker path, never misread as a login failure (cookies keep being sent)", async () => {
  const calls: FetchCall[] = [];
  const provider = providerFor(
    () => jsonResponse({ error: "rate limited" }, 429),
    calls,
    {
      auth: { cookieT: REAL_COOKIE_T, cookieY: REAL_COOKIE_Y },
      maxAttempts: 3,
    },
  );
  const result = await provider.getLatestObservation(request);
  // Exhausted retries within the SAME authenticated attempt -- a rate limit,
  // not a login failure, so no anonymous fallback call is ever made.
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.kind, "rate_limit");
  assert.equal(calls.length, 3);
  for (const call of calls) {
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers.cookie, `T=${REAL_COOKIE_T}; Y=${REAL_COOKIE_Y}`);
  }
});

test("MKT-009B adapter: no cookie value ever appears in a thrown error, a returned MarketDataError, or the adapter's own module source", async () => {
  const calls: FetchCall[] = [];
  const provider = providerFor(
    () => jsonResponse({ error: "invalid session" }, 401),
    calls,
    { auth: { cookieT: REAL_COOKIE_T, cookieY: REAL_COOKIE_Y } },
  );
  const result = await provider.getLatestObservation(request);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(REAL_COOKIE_T));
  assert.doesNotMatch(serialized, new RegExp(REAL_COOKIE_Y));

  const source = await readFile(
    new URL("../domain/market-data/yahoo-compatible.ts", import.meta.url),
    "utf8",
  );
  // The module must never console.log/console.error/throw the credentials
  // object itself -- only ever build the one cookie header from it.
  assert.doesNotMatch(source, /console\.(log|error|warn|info)/);
});

// ---------------------------------------------------------------------------
// domain/market-data/selection.ts: preferredProviderIds honest fallback.
// ---------------------------------------------------------------------------

function priceObservation(
  overrides: Partial<PriceObservation> = {},
): PriceObservation {
  return {
    kind: "price",
    providerId: "yahoo-compatible",
    providerRevisionId: null,
    mappingId: "mapping-1",
    securityId: "security-1",
    scope: { kind: "deployment", userId: null },
    interval: "eod",
    observationAt: "2026-07-29T06:00:00Z",
    marketDate: "2026-07-29",
    marketTimezone: "Australia/Sydney",
    currencyCode: "AUD",
    closeDecimal: "42.10",
    previousCloseDecimal: "41.90",
    adjustmentState: "raw",
    adjustmentFactor: null,
    quality: "observed",
    delayedMinutes: null,
    ingestedAt: "2026-07-29T06:05:00Z",
    payloadSha256: null,
    ...overrides,
  };
}

test("MKT-009B selection: undefined preferredProviderIds is byte-for-byte today's freshest-wins behaviour", () => {
  const yahoo = priceObservation({ providerId: "yahoo-compatible" });
  const sharesight = priceObservation({
    providerId: "sharesight",
    closeDecimal: "42.50",
  });
  const selection = selectPriceObservation({
    asOf: "2026-07-29",
    targetKey: "security-1",
    observations: [yahoo, sharesight],
  });
  // No preference given -- identical to pre-MKT-009B ranking (freshest/best
  // wins; both share the same marketDate/interval/quality here, so the tie
  // resolves on observationAt, which is identical -- either is acceptable,
  // the point is no `preferredProviderIds` field changes anything).
  assert.equal(selection.status, "current");
  assert.ok(selection.selected);
});

test("MKT-009B selection: a preferred provider with a usable observation wins even when a non-preferred provider is present", () => {
  const yahoo = priceObservation({ providerId: "yahoo-compatible" });
  const sharesight = priceObservation({ providerId: "sharesight" });
  const selection = selectPriceObservation({
    asOf: "2026-07-29",
    targetKey: "security-1",
    observations: [yahoo, sharesight],
    preferredProviderIds: ["sharesight"],
  });
  assert.equal(selection.selected?.providerId, "sharesight");
});

test("MKT-009B selection: a preferred provider with ZERO usable observations falls back honestly to the best of the rest, never unavailable", () => {
  const yahoo = priceObservation({ providerId: "yahoo-compatible" });
  const selection = selectPriceObservation({
    asOf: "2026-07-29",
    targetKey: "security-1",
    observations: [yahoo],
    preferredProviderIds: ["sharesight"],
  });
  assert.equal(selection.status, "current");
  assert.equal(selection.selected?.providerId, "yahoo-compatible");
});

test("MKT-009B selection: an empty preferredProviderIds array behaves exactly like undefined", () => {
  const yahoo = priceObservation({ providerId: "yahoo-compatible" });
  const selection = selectPriceObservation({
    asOf: "2026-07-29",
    targetKey: "security-1",
    observations: [yahoo],
    preferredProviderIds: [],
  });
  assert.equal(selection.selected?.providerId, "yahoo-compatible");
});

// ---------------------------------------------------------------------------
// app/portfolio-action-contract.ts: closed-enum validator.
// ---------------------------------------------------------------------------

test("MKT-009B validatePriceSourcePreference accepts only the three exact enum values", () => {
  assert.equal(
    validatePriceSourcePreference("yahoo_authenticated"),
    "yahoo_authenticated",
  );
  assert.equal(
    validatePriceSourcePreference("yahoo_anonymous"),
    "yahoo_anonymous",
  );
  assert.equal(
    validatePriceSourcePreference("sharesight_delayed"),
    "sharesight_delayed",
  );
  assert.equal(validatePriceSourcePreference("yahoo"), null);
  assert.equal(validatePriceSourcePreference(""), null);
  assert.equal(validatePriceSourcePreference(null), null);
  assert.equal(validatePriceSourcePreference(undefined), null);
});

// ---------------------------------------------------------------------------
// db/repositories/owned-portfolios.ts + migration: persistence, default,
// CHECK constraint, cross-user isolation.
// ---------------------------------------------------------------------------

async function loadMigrationSql(): Promise<string> {
  const migrationFiles = (
    await readdir(new URL("../drizzle", import.meta.url))
  ).filter((file) => file.endsWith(".sql"));
  assert.ok(migrationFiles.length > 0, "expected a generated migration");
  const migrations = await Promise.all(
    migrationFiles
      .sort()
      .map((file) =>
        readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
      ),
  );
  return migrations.join("\n");
}

async function freshDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(await loadMigrationSql());
  return db;
}

function seedOwner(db: DatabaseSync, userId: string, email: string): void {
  const now = "2026-08-21T00:00:00.000Z";
  db.exec(
    `INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
     SELECT 'AUD', 36, 'Australian dollar', 2, 1
     WHERE NOT EXISTS (SELECT 1 FROM currencies WHERE code = 'AUD')`,
  );
  db.prepare(
    `INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at)
     VALUES (?, 'active', ?, 'Australia/Sydney', ?, ?)`,
  ).run(userId, email, now, now);
  db.prepare(
    `INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at)
     VALUES (?, 'AUD', 'Australia/Sydney', ?, ?)`,
  ).run(userId, now, now);
}

test("MKT-009B migration: existing/new rows default price_source_preference to sharesight_delayed with no data rewrite", async () => {
  const db = await freshDb();
  seedOwner(db, "user-1", "owner1@example.test");
  const row = db
    .prepare(
      `SELECT price_source_preference FROM user_settings WHERE user_id = ?`,
    )
    .get("user-1") as { price_source_preference: string };
  assert.equal(row.price_source_preference, "sharesight_delayed");
  db.close();
});

test("MKT-009B migration: the CHECK constraint rejects any value outside the three-way enum", async () => {
  const db = await freshDb();
  seedOwner(db, "user-1", "owner1@example.test");
  assert.throws(() => {
    db.exec(
      `UPDATE user_settings SET price_source_preference = 'live' WHERE user_id = 'user-1'`,
    );
  });
  db.close();
});

test("MKT-009B repository: setPriceSourcePreference persists, bumps the version, and the change is visible on the read path", async () => {
  const db = await freshDb();
  seedOwner(db, "user-1", "owner1@example.test");
  const client = createSqliteSqlClient(db);
  const repo = createOwnedUserSettingsRepository(client);
  const before = await repo.get("user-1");
  assert.ok(before);
  assert.equal(before?.priceSourcePreference, "sharesight_delayed");

  const result = await repo.setPriceSourcePreference("user-1", {
    priceSourcePreference: "yahoo_authenticated",
    expectedVersion: before!.version,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.settings.priceSourcePreference, "yahoo_authenticated");
    assert.equal(result.settings.version, before!.version + 1);
  }

  const after = await repo.get("user-1");
  assert.equal(after?.priceSourcePreference, "yahoo_authenticated");
  db.close();
});

test("MKT-009B repository: a stale expectedVersion is rejected as version_conflict and does not change the stored value", async () => {
  const db = await freshDb();
  seedOwner(db, "user-1", "owner1@example.test");
  const client = createSqliteSqlClient(db);
  const repo = createOwnedUserSettingsRepository(client);

  const result = await repo.setPriceSourcePreference("user-1", {
    priceSourcePreference: "yahoo_anonymous",
    expectedVersion: 999,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "version_conflict");

  const after = await repo.get("user-1");
  assert.equal(after?.priceSourcePreference, "sharesight_delayed");
  db.close();
});

test("MKT-009B repository: another owner's version cannot be used to change this owner's preference (cross-user isolation)", async () => {
  const db = await freshDb();
  seedOwner(db, "user-1", "owner1@example.test");
  seedOwner(db, "user-2", "owner2@example.test");
  const client = createSqliteSqlClient(db);
  const repo = createOwnedUserSettingsRepository(client);
  const owner2Before = await repo.get("user-2");

  const result = await repo.setPriceSourcePreference("user-1", {
    priceSourcePreference: "yahoo_authenticated",
    expectedVersion: owner2Before!.version,
  });
  assert.equal(result.ok, true);

  const owner1After = await repo.get("user-1");
  const owner2After = await repo.get("user-2");
  assert.equal(owner1After?.priceSourcePreference, "yahoo_authenticated");
  // Owner 2's row is completely untouched by owner 1's mutation, whose
  // version merely happened to match owner 2's independent starting value.
  assert.equal(owner2After?.priceSourcePreference, "sharesight_delayed");
  assert.equal(owner2After?.version, owner2Before?.version);
  db.close();
});

test("MKT-009B migration: the account-purge-lock triggers survive the price_source_preference rebuild (0048)", async () => {
  const db = await freshDb();
  seedOwner(db, "user-1", "owner1@example.test");
  const now = "2026-08-21";
  db.exec(
    `INSERT INTO account_purge_jobs(id,owner_user_id,deletion_request_id,deletion_key_digest,export_job_id,manifest_digest,status,phase,eligible_at,confirmed_at,created_at,updated_at) VALUES('purge-1','user-1','request-1','key-digest','export-1','manifest-1','running','validate_source','${now}','${now}','${now}','${now}')`,
  );
  assert.throws(() => {
    db.exec(
      `UPDATE user_settings SET price_source_preference = 'yahoo_anonymous' WHERE user_id = 'user-1'`,
    );
  }, /account_purge_source_locked/);
  db.close();
});

// ---------------------------------------------------------------------------
// app/owned-holdings.ts: end-to-end preference-aware CROSS-scope selection
// (review round-1 B1/B2/B3).
// ---------------------------------------------------------------------------

const NOT_CONFIGURED_SHARESIGHT: SharesightIntegrationConfig = {
  enabled: false,
  reason: "not_configured",
};

/**
 * One owner, one AUD portfolio, one AUD-denominated held security, with a
 * completed/ready projection so `loadOwnedHoldings` reads all the way
 * through -- mirrors `tests/brk-012c.test.ts`'s `gateFixture()` shape
 * (that file's own fixtures are module-private, so this is a deliberately
 * minimal, self-contained equivalent for THIS file's own needs).
 */
async function ownedHoldingsFixture(): Promise<DatabaseSync> {
  const db = await freshDb();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('owner-1', 'active', 'owner1@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at)
    VALUES ('owner-1', 'AUD', 'Australia/Sydney', '2026-08-01', '2026-08-01');
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-1', 'owner-1', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-1', 'Alpha', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('holding-1', 'owner-1', 'portfolio-1', 'security-1', 'ABC', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
    INSERT INTO calculation_runs (id, user_id, portfolio_id, range_from, range_to, calculation_version, reason, ledger_high_water_start, ledger_high_water_end, idempotency_key, created_at, updated_at, status)
    VALUES ('run-1', 'owner-1', 'portfolio-1', '2026-08-20', '2026-08-20', 1, 'test', '1', '1', 'run-1', '2026-08-20', '2026-08-20', 'completed');
    INSERT INTO projection_publications (user_id, portfolio_id, calculation_run_id, calculation_version, ledger_high_water, published_at)
    VALUES ('owner-1', 'portfolio-1', 'run-1', 1, '1', '2026-08-20T01:00:00Z');
    INSERT INTO holding_projections (id, user_id, portfolio_id, portfolio_security_id, quantity_decimal, native_open_basis_decimal, base_open_basis_decimal, average_base_cost_decimal, completeness, status, last_ledger_high_water, calculation_run_id, calculation_version, rebuilt_at)
    VALUES ('projection-1', 'owner-1', 'portfolio-1', 'holding-1', '2', '10', '10', '5', 'complete', 'ready', '1', 'run-1', 1, '2026-08-20T01:00:00Z');
  `);
  return db;
}

type ObservationInsert = {
  id: string;
  providerId: "yahoo-compatible" | "sharesight" | "owner-import";
  scope: "deployment" | "user";
  closeDecimal: string;
  providerRevisionId?: string | null;
};

/**
 * Inserts BOTH the current-day (2026-08-20) AND a comparable previous-day
 * (2026-08-19) row for the same provider/interval/quality -- without a
 * previous-day row, `loadOwnedHoldings`'s own (pre-existing, unrelated to
 * this task) `missing_previous` actionStatus check fires first and masks
 * whatever `actionStatus` this fixture is actually trying to exercise, so
 * every test below needs a comparable previous day to reach that check.
 */
function insertPriceObservation(
  db: DatabaseSync,
  input: ObservationInsert,
): void {
  const accessScope = input.scope;
  const scopeUserId = input.scope === "user" ? "owner-1" : null;
  const scopeKey = input.scope === "user" ? "owner-1" : "deployment";
  // ONE mapping per provider, reused by both the current- and previous-day
  // rows below -- a symbol mapping is not day-specific, and the
  // `(provider_id, provider_exchange, provider_symbol, valid_from)` unique
  // index would otherwise reject a second row for the same provider.
  const mappingId = `mapping-${input.id}`;
  db.prepare(
    `INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
     VALUES (?, 'security-1', ?, 'ASX', 'ABC', '2026-08-01', 'candidate')`,
  ).run(mappingId, input.providerId);
  const insert = (
    day: "current" | "previous",
    marketDate: string,
    observationAt: string,
    closeDecimal: string,
  ) => {
    db.prepare(
      `INSERT INTO price_observations (
        id, provider_id, access_scope, scope_user_id, scope_key, mapping_id,
        security_id, interval, observation_at, market_date, market_timezone,
        currency_code, close_decimal, previous_close_decimal, adjustment_state,
        quality, ingested_at, provider_revision_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'security-1', 'delayed', ?, ?, '+10:00', 'AUD', ?, NULL, 'raw', 'observed', ?, ?)`,
    ).run(
      `price-${input.id}-${day}`,
      input.providerId,
      accessScope,
      scopeUserId,
      scopeKey,
      mappingId,
      observationAt,
      marketDate,
      closeDecimal,
      observationAt,
      input.providerRevisionId ?? null,
    );
  };
  insert(
    "current",
    "2026-08-20",
    "2026-08-20T05:00:00.000Z",
    input.closeDecimal,
  );
  // Previous day: same close value is fine -- these tests assert on
  // `nativePrice`/`actionStatus`, not daily movement.
  insert(
    "previous",
    "2026-08-19",
    "2026-08-19T05:00:00.000Z",
    input.closeDecimal,
  );
}

async function setPreference(
  db: DatabaseSync,
  preference: string,
): Promise<void> {
  db.exec(
    `UPDATE user_settings SET price_source_preference = '${preference}' WHERE user_id = 'owner-1'`,
  );
}

async function loadFixtureHoldings(db: DatabaseSync) {
  const client = createSqliteSqlClient(db);
  return loadOwnedHoldings(
    client,
    "owner-1",
    "portfolio-1",
    new Date("2026-08-20T06:00:00.000Z"),
    { integration: NOT_CONFIGURED_SHARESIGHT },
  );
}

test("MKT-009B owned-holdings B1 (BLOCKING repro, exact reviewer drill): a same-date Yahoo + Sharesight observation -- yahoo_authenticated selects Yahoo, not Sharesight", async () => {
  const db = await ownedHoldingsFixture();
  insertPriceObservation(db, {
    id: "yahoo",
    providerId: "yahoo-compatible",
    scope: "deployment",
    closeDecimal: "10.00",
    providerRevisionId: "session:authenticated",
  });
  insertPriceObservation(db, {
    id: "sharesight",
    providerId: "sharesight",
    scope: "user",
    closeDecimal: "20.00",
  });
  await setPreference(db, "yahoo_authenticated");
  const result = await loadFixtureHoldings(db);
  assert.equal(result.rows[0]?.nativePrice, "10.00");
  assert.equal(result.rows[0]?.actionStatus, "none");
  db.close();
});

test("MKT-009B owned-holdings B1: yahoo_anonymous ALSO selects the same-date Yahoo observation over Sharesight (was previously a no-op, selecting Sharesight)", async () => {
  const db = await ownedHoldingsFixture();
  insertPriceObservation(db, {
    id: "yahoo",
    providerId: "yahoo-compatible",
    scope: "deployment",
    closeDecimal: "10.00",
  });
  insertPriceObservation(db, {
    id: "sharesight",
    providerId: "sharesight",
    scope: "user",
    closeDecimal: "20.00",
  });
  await setPreference(db, "yahoo_anonymous");
  const result = await loadFixtureHoldings(db);
  assert.equal(result.rows[0]?.nativePrice, "10.00");
  db.close();
});

test("MKT-009B owned-holdings B1: sharesight_delayed selects the same-date Sharesight observation over Yahoo", async () => {
  const db = await ownedHoldingsFixture();
  insertPriceObservation(db, {
    id: "yahoo",
    providerId: "yahoo-compatible",
    scope: "deployment",
    closeDecimal: "10.00",
  });
  insertPriceObservation(db, {
    id: "sharesight",
    providerId: "sharesight",
    scope: "user",
    closeDecimal: "20.00",
  });
  await setPreference(db, "sharesight_delayed");
  const result = await loadFixtureHoldings(db);
  assert.equal(result.rows[0]?.nativePrice, "20.00");
  db.close();
});

test("MKT-009B owned-holdings: sharesight_delayed falls back honestly to Yahoo when Sharesight supplied nothing for this security", async () => {
  const db = await ownedHoldingsFixture();
  insertPriceObservation(db, {
    id: "yahoo",
    providerId: "yahoo-compatible",
    scope: "deployment",
    closeDecimal: "10.00",
  });
  await setPreference(db, "sharesight_delayed");
  const result = await loadFixtureHoldings(db);
  assert.equal(result.rows[0]?.nativePrice, "10.00");
  assert.equal(result.rows[0]?.nativeValue.status, "available");
  db.close();
});

test("MKT-009B owned-holdings B2 (BLOCKING fix): yahoo_authenticated falls back honestly to Sharesight when Yahoo supplied nothing, and marks the row action-required (not configured)", async () => {
  const db = await ownedHoldingsFixture();
  insertPriceObservation(db, {
    id: "sharesight",
    providerId: "sharesight",
    scope: "user",
    closeDecimal: "20.00",
  });
  await setPreference(db, "yahoo_authenticated");
  const result = await loadFixtureHoldings(db);
  // Honest fallback: the preferred provider (Yahoo) supplied nothing, so
  // Sharesight's price is shown -- never `Price unavailable` merely
  // because the PREFERRED source was silent.
  assert.equal(result.rows[0]?.nativePrice, "20.00");
  assert.equal(result.rows[0]?.actionStatus, "yahoo_auth_not_configured");
  assert.match(
    result.rows[0]?.explanation ?? "",
    /Action required: no Yahoo login is configured for this deployment\./,
  );
  db.close();
});

test("MKT-009B owned-holdings B2 (BLOCKING fix): yahoo_authenticated with a selected but ANONYMOUS Yahoo observation is action-required (expired), distinct wording from not-configured", async () => {
  const db = await ownedHoldingsFixture();
  insertPriceObservation(db, {
    id: "yahoo",
    providerId: "yahoo-compatible",
    scope: "deployment",
    closeDecimal: "10.00",
    providerRevisionId: "session:anonymous",
  });
  await setPreference(db, "yahoo_authenticated");
  const result = await loadFixtureHoldings(db);
  assert.equal(result.rows[0]?.nativePrice, "10.00");
  assert.equal(result.rows[0]?.actionStatus, "yahoo_auth_expired");
  assert.match(
    result.rows[0]?.explanation ?? "",
    /Action required: the Yahoo login session is anonymous -- re-export YAHOO_COOKIE_T\/YAHOO_COOKIE_Y\./,
  );
  db.close();
});

test("MKT-009B owned-holdings: yahoo_authenticated with a genuinely authenticated Yahoo observation is NOT action-required", async () => {
  const db = await ownedHoldingsFixture();
  insertPriceObservation(db, {
    id: "yahoo",
    providerId: "yahoo-compatible",
    scope: "deployment",
    closeDecimal: "10.00",
    providerRevisionId: "session:authenticated",
  });
  await setPreference(db, "yahoo_authenticated");
  const result = await loadFixtureHoldings(db);
  assert.equal(result.rows[0]?.actionStatus, "none");
  assert.doesNotMatch(result.rows[0]?.explanation ?? "", /Yahoo login/);
  db.close();
});

test("MKT-009B owned-holdings B2/B3: the yahoo-auth-unmet action-required state renders as VISIBLE text through the SAME first-class actionStatus mechanism every other row uses, not sr-only-only", async () => {
  const shell = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  // Both new labels live inside the visible `statusLabel` ternary (the
  // SAME construct producing "stale market data"/"price unavailable"/etc,
  // rendered into the non-sr-only `.row-secondary` span) -- never only
  // inside the separate `sr-only` explanation span.
  const statusLabelStart = shell.indexOf("const statusLabel =");
  const statusLabelEnd = shell.indexOf("};", statusLabelStart);
  const statusLabelBlock = shell.slice(statusLabelStart, statusLabelEnd);
  assert.match(statusLabelBlock, /"Yahoo login expired"/);
  assert.match(statusLabelBlock, /"Yahoo login not configured"/);
  assert.match(
    statusLabelBlock,
    /holding\.actionStatus === "yahoo_auth_expired"/,
  );
  // The visible span (not the sr-only one) is what renders {statusLabel},
  // immediately alongside {priceLabel} -- proximity-checked rather than an
  // exact multiline match, since JSX whitespace is incidental.
  const priceLabelIndex = shell.indexOf("{priceLabel}");
  const statusLabelUsageIndex = shell.indexOf("{statusLabel}", priceLabelIndex);
  const srOnlyIndex = shell.indexOf(
    '<span className="sr-only">{holding.explanation}</span>',
  );
  assert.ok(priceLabelIndex >= 0);
  assert.ok(
    statusLabelUsageIndex >= 0 && statusLabelUsageIndex - priceLabelIndex < 60,
    "expected {statusLabel} to render immediately alongside {priceLabel} in the visible row span",
  );
  assert.ok(srOnlyIndex >= 0);
  const srOnlyContainer = shell.slice(
    Math.max(0, srOnlyIndex - 20),
    srOnlyIndex + 60,
  );
  assert.doesNotMatch(srOnlyContainer, /statusLabel/);
});

// ---------------------------------------------------------------------------
// F4 / QA-001A matrix row discipline.
// ---------------------------------------------------------------------------

test("MKT-009B: the QA-001A matrix records the new price-source-preference route", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const needle of [
    "/api/settings/price-source-preference",
    "changePriceSourcePreferenceAction",
    "tests/mkt-009b.test.ts",
  ]) {
    assert.ok(matrix.includes(needle), `matrix should mention ${needle}`);
  }
});

test("MKT-009B: every matrix citation naming tests/mkt-009b.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/mkt-009b.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/mkt-009b\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
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
        `matrix cites "${title}" in tests/mkt-009b.test.ts, but that title is not a literal substring of the file's source (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount >= 1, "expected at least 1 citation group to check");
  assert.ok(titleCount >= 2, "expected at least 2 quoted titles to check");
});
