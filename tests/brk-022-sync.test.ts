/**
 * BRK-022 slice 2 -- sync wiring for announced-but-unpaid Sharesight
 * payouts. `runSharesightSyncWithContext` now records every future-dated,
 * not-yet-due payout `isFutureUnconfirmedPayout` would otherwise just skip
 * with a warning (`domain/sharesight-sync/transform.ts`) as its own
 * `sharesight_pending_payouts` OBSERVATION (slice 1's repository), refreshed
 * or withdrawn on every subsequent sync -- see the `### BRK-022` entry in
 * TASKS.md for the owner rulings this slice implements.
 *
 * Pattern mirrors `tests/brk-015.test.ts` (migrated in-memory D1-shape DB,
 * a fake `SharesightClient`, `linkSharesightPortfolioWithContext` then
 * `runSharesightSyncWithContext` driving the REAL sync service) and
 * `tests/brk-010.test.ts`'s `seedResolvedSecurity` helper for pre-linking a
 * security so the tiered pending-payout resolution has real evidence to
 * match against. Duplicated locally rather than imported, per this
 * codebase's established per-file fixture convention.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { formatSyncResultMessage } from "../app/sharesight-sync-panel-helpers.ts";
import {
  linkSharesightPortfolioWithContext,
  runSharesightSyncWithContext,
} from "../app/sharesight-sync-service.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSharesightPendingPayoutsRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
} from "../db/repositories/index.ts";
import type { SqlClient, SqlStatement } from "../db/repositories/sql-client.ts";
import { committedSourceReferenceForFingerprint } from "../domain/imports/index.ts";
import { invertToPortfolioConversionRate } from "../domain/sharesight-sync/index.ts";
import type {
  SharesightClient,
  SharesightPayout,
  SharesightPortfolio,
  SharesightTrade,
} from "../domain/sharesight/index.ts";

const FIXED_NOW = "2026-09-04T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures.
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

/** Mirrors `tests/brk-010.test.ts`'s `seedResolvedSecurity` -- a real,
 * already-linked `securities`/`security_identifiers`/`portfolio_securities`
 * row, exactly what an earlier sync or CSV import would have left behind,
 * so the pending-payout resolution tiers have real evidence to match. */
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

/** Unlike `tests/brk-015.test.ts`'s `filteringSharesightClient`, this fake
 * ignores `from`/`to` entirely and always returns the given fixtures
 * (matching `tests/brk-005.test.ts`'s convention) -- what matters for this
 * slice's own tests is `markWithdrawnNotObserved`'s ex_date-vs-window
 * logic, driven by what a given call's fetch actually returns, not by
 * simulating Sharesight's own date filtering (that is BRK-015's own
 * territory). */
function fakeSharesightClient(fixtures: {
  portfolios?: SharesightPortfolio[];
  trades?: SharesightTrade[];
  payouts?: SharesightPayout[];
}): SharesightClient {
  return {
    async listPortfolios() {
      return { ok: true, value: fixtures.portfolios ?? [] };
    },
    async getPortfolioHoldings() {
      return { ok: true, value: [] };
    },
    async listTrades() {
      return { ok: true, value: fixtures.trades ?? [] };
    },
    async listPayouts() {
      return { ok: true, value: fixtures.payouts ?? [] };
    },
    async listUserInstruments() {
      return { ok: true, value: [] };
    },
  };
}

const integrationOf = (client: SharesightClient) => ({
  enabled: true as const,
  client,
});

/**
 * Review round F1: wraps a real `SqlClient` so a `client.batch()` call whose
 * FIRST statement's SQL text contains `matchSubstring` throws instead of
 * executing -- mirrors `tests/mkt-011a.test.ts`'s `wrapClientWithFailingCall`
 * (there wrapping `.all()`) for the write path
 * `sharesight-pending-payouts.ts`'s `upsertObserved`/`markWithdrawnNotObserved`
 * both use. Used to simulate a genuine DB failure at exactly one of those two
 * steps without corrupting any other write this test's sync also performs
 * (staging, security resolution, sync-state upsert all use `client.batch()`
 * too, so matching on statement TEXT rather than failing every batch call is
 * required to isolate the one step under test).
 */
function wrapClientWithFailingBatch(
  client: SqlClient,
  matchSubstring: string,
): SqlClient {
  return {
    all: (sql, params) => client.all(sql, params),
    get: (sql, params) => client.get(sql, params),
    run: (sql, params) => client.run(sql, params),
    batch: (statements: readonly SqlStatement[]) => {
      if (
        statements.some((statement) => statement.sql.includes(matchSubstring))
      ) {
        throw new Error(`simulated batch failure: ${matchSubstring}`);
      }
      return client.batch(statements);
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
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(linked.ok, true);
  return { client, sharesightClient };
}

/** Mirrors `tests/brk-015.test.ts`'s `currentPreviewVersion`/`commitBatch`
 * -- drives a staged batch through ready/commit via the REAL machinery, so
 * a committed confirmed payout can establish a real payout watermark for
 * the narrowed-window tests below. */
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

async function commitBatch(
  client: SqlClient,
  batchId: string,
  idempotencyKey: string,
): Promise<void> {
  const batch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    batchId,
  );
  if (!batch) throw new Error("expected batch to exist");
  const previewVersion = await currentPreviewVersion(client, "user-a", batchId);
  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    batchId,
    { expectedVersion: batch.version, expectedPreviewVersion: previewVersion },
  );
  assert.equal(ready.ok, true, `expected ${batchId} to reach ready`);
  if (!ready.ok) return;
  const readyVersion = ready.review.batch.version;
  const commitRepo = createOwnedImportCommitRepository(client);
  const validated = await commitRepo.validate("user-a", batchId);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: readyVersion,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey,
    confirmation: true,
    requestId: `${idempotencyKey}-request`,
  };
  let commitResult = await commitRepo.commit("user-a", batchId, commitInput);
  for (
    let attempt = 0;
    attempt < 10 && (!commitResult.ok || commitResult.status !== "committed");
    attempt += 1
  ) {
    assert.equal(commitResult.ok, true);
    commitResult = await commitRepo.commit("user-a", batchId, commitInput);
  }
  assert.equal(commitResult.ok, true);
  if (commitResult.ok) assert.equal(commitResult.status, "committed");
}

// ---------------------------------------------------------------------------
// 1. A future-dated null-id payout is recorded, not staged, with the
//    expected key/values -- native (no FX) and foreign (FX inverted) cases.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2: a future-dated null-id payout is recorded as a pending observation (not staged) with the expected key and values", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [
      fakePayout({
        id: null,
        holdingId: "holding-1",
        symbol: "ABC",
        marketCode: "ASX",
        currencyCode: "AUD",
        paidOnDate: "2099-01-01",
        goesExOnDate: "2098-12-20",
        amountDecimal: "150.00",
        grossAmountDecimal: "214.29",
        frankingCreditsDecimal: "64.29",
      }),
    ],
  });

  const result = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient), now: () => FIXED_NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rowsStaged, 0, "no confirmed row to stage");
  assert.equal(result.pendingPayouts, 1);
  assert.equal(result.pendingPayoutsUnresolved, 0);
  assert.equal(result.pendingPayoutsWithdrawn, 0);
  assert.equal(result.pendingPayoutsError, null);

  const repo = createSharesightPendingPayoutsRepository(client);
  const active = await repo.listActive("user-a", "portfolio-a");
  assert.equal(active.length, 1);
  const row = active[0];
  assert.equal(
    row?.sourceReference,
    "sharesight-payout:sp-1:holding-1:2099-01-01",
  );
  assert.equal(row?.portfolioSecurityId, "sec-abc-ps");
  assert.equal(row?.paymentDate, "2099-01-01");
  assert.equal(row?.exDate, "2098-12-20");
  assert.equal(row?.totalCashDecimal, "150.00");
  assert.equal(row?.grossAmountDecimal, "214.29");
  assert.equal(row?.totalFrankingDecimal, "64.29");
  assert.equal(row?.currencyCode, "AUD");
  assert.equal(row?.fxRateToPortfolioDecimal, null);
  assert.equal(row?.fxRateSource, null);
});

test("BRK-022 slice 2: a foreign-currency pending payout's FX fields mirror import-commit.ts's inversion of Sharesight's own exchange rate", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-usd",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "XYZ",
    exchangeAlias: "NYSE",
    currencyCode: "USD",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [
      fakePayout({
        id: null,
        holdingId: "holding-usd",
        symbol: "XYZ",
        marketCode: "NYSE",
        currencyCode: "AUD", // foreign to the USD security
        paidOnDate: "2099-03-01",
        exchangeRateDecimal: "0.65",
      }),
    ],
  });

  const result = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient), now: () => FIXED_NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.pendingPayouts, 1);
  assert.equal(result.pendingPayoutsUnresolved, 0);

  const repo = createSharesightPendingPayoutsRepository(client);
  const [row] = await repo.listActive("user-a", "portfolio-a");
  const expectedRate = invertToPortfolioConversionRate("0.65");
  assert.notEqual(expectedRate, null);
  assert.equal(row?.fxRateToPortfolioDecimal, expectedRate);
  assert.equal(row?.fxRateSource, "sharesight");
});

// ---------------------------------------------------------------------------
// 2. A past-dated null-id payout still stages exactly as before -- no
//    pending row created for it.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2: a past-dated null-id payout still stages as a real row, and creates no pending observation", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [
      fakePayout({
        id: null,
        holdingId: "holding-1",
        symbol: "ABC",
        marketCode: "ASX",
        paidOnDate: "2026-08-05", // before FIXED_NOW's 2026-09-04
      }),
    ],
  });

  const result = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient), now: () => FIXED_NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rowsStaged, 1, "the past-dated payout stages normally");
  assert.equal(result.pendingPayouts, 0);
  assert.equal(result.pendingPayoutsUnresolved, 0);

  const repo = createSharesightPendingPayoutsRepository(client);
  assert.equal((await repo.listActive("user-a", "portfolio-a")).length, 0);
});

// ---------------------------------------------------------------------------
// 3. Second sync with the payout gone -> withdrawn; narrowed-window
//    covered-vs-not-covered.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2: a second (full-window) sync with the payout gone withdraws the pending row", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const { client } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [
      fakePayout({
        id: null,
        holdingId: "holding-1",
        symbol: "ABC",
        marketCode: "ASX",
        paidOnDate: "2099-01-01",
      }),
    ],
  });
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [
            fakePayout({
              id: null,
              holdingId: "holding-1",
              symbol: "ABC",
              marketCode: "ASX",
              paidOnDate: "2099-01-01",
            }),
          ],
        }),
      ),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.pendingPayouts, 1);

  // No committed Sharesight payout exists yet, so the routine sync's payout
  // window stays "full" (no watermark to narrow against).
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({ portfolios: [fakePortfolio()], payouts: [] }),
      ),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.window.payouts.kind, "full");
  assert.equal(second.pendingPayouts, 0);
  assert.equal(second.pendingPayoutsWithdrawn, 1);

  const repo = createSharesightPendingPayoutsRepository(client);
  assert.equal((await repo.listActive("user-a", "portfolio-a")).length, 0);
});

test("BRK-022 slice 2: a narrowed routine sync withdraws a pending payout whose ex_date falls inside the window, but leaves one outside the window active", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const confirmedPayout = fakePayout({
    id: "payout-confirmed",
    holdingId: "holding-confirmed",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2026-06-01", // establishes the payout watermark once committed
    amountDecimal: "10.00",
    grossAmountDecimal: "14.29",
    frankingCreditsDecimal: "4.29",
  });
  const coveredPayout = fakePayout({
    id: null,
    holdingId: "holding-covered",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-06-01",
    goesExOnDate: "2026-01-15", // >= sinceDate (2025-12-03) -- covered
  });
  const uncoveredPayout = fakePayout({
    id: null,
    holdingId: "holding-uncovered",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-07-01",
    goesExOnDate: "2025-01-15", // < sinceDate -- NOT covered
  });

  const { client } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [confirmedPayout, coveredPayout, uncoveredPayout],
  });

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [confirmedPayout, coveredPayout, uncoveredPayout],
        }),
      ),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.rowsStaged, 1, "only the confirmed payout stages");
  assert.equal(first.pendingPayouts, 2);

  await commitBatch(client, first.batchId, "brk-022-commit-1");

  // Second sync: Sharesight reports the confirmed payout only (both
  // previously-pending payouts are gone from the account). The routine
  // sync's payout window is now narrowed to sinceDate "2025-12-03"
  // (computeRoutineSyncFromDate("2026-06-01", 180)).
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [confirmedPayout],
        }),
      ),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.window.payouts, {
    kind: "narrowed",
    sinceDate: "2025-12-03",
  });
  assert.equal(second.pendingPayoutsWithdrawn, 1);

  const repo = createSharesightPendingPayoutsRepository(client);
  const active = await repo.listActive("user-a", "portfolio-a");
  assert.deepEqual(active.map((row) => row.sharesightHoldingId).sort(), [
    "holding-uncovered",
  ]);
});

// ---------------------------------------------------------------------------
// 4. A paid-date change withdraws the old key and creates the new one.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2: a paid-date change on a still-pending payout withdraws the old key and records the new one", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const { client } = await linkedFixture(database);

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [
            fakePayout({
              id: null,
              holdingId: "holding-1",
              symbol: "ABC",
              marketCode: "ASX",
              paidOnDate: "2099-01-01",
            }),
          ],
        }),
      ),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.pendingPayouts, 1);

  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [
            fakePayout({
              id: null,
              holdingId: "holding-1",
              symbol: "ABC",
              marketCode: "ASX",
              paidOnDate: "2099-02-01", // paid-date pushed out
            }),
          ],
        }),
      ),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.pendingPayouts, 1, "the new key is recorded");
  assert.equal(second.pendingPayoutsWithdrawn, 1, "the old key is withdrawn");

  const repo = createSharesightPendingPayoutsRepository(client);
  const active = await repo.listActive("user-a", "portfolio-a");
  assert.equal(active.length, 1);
  assert.equal(
    active[0]?.sourceReference,
    "sharesight-payout:sp-1:holding-1:2099-02-01",
  );
});

// ---------------------------------------------------------------------------
// 5 & 6. Resolution tiers: unresolved symbol; instrument-id tier wins over
// symbol tier; an ambiguous symbol match resolves to null.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2: a payout for an instrument with no resolvable security is stored with a null security and counted unresolved", async () => {
  const database = await migratedDatabase();
  // No seedResolvedSecurity call at all -- nothing to resolve against.
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [
      fakePayout({
        id: null,
        holdingId: "holding-1",
        symbol: "ZZZ",
        marketCode: "XYZ",
        paidOnDate: "2099-01-01",
      }),
    ],
  });

  const result = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient), now: () => FIXED_NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.pendingPayouts, 1);
  assert.equal(result.pendingPayoutsUnresolved, 1);

  const repo = createSharesightPendingPayoutsRepository(client);
  const [row] = await repo.listActive("user-a", "portfolio-a");
  assert.equal(row?.portfolioSecurityId, null);
});

test("BRK-022 slice 2: the Sharesight instrument-id tier resolves uniquely even when the symbol+exchange tier would itself be ambiguous", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
    sharesightInstrumentId: "inst-1",
  });
  // A second, unrelated security that happens to share the SAME
  // symbol+exchange but carries no Sharesight instrument id -- a symbol-tier
  // match against this pair alone would be ambiguous.
  seedResolvedSecurity(database, {
    securityId: "sec-2",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [
      fakePayout({
        id: null,
        holdingId: "holding-1",
        sharesightInstrumentId: "inst-1",
        symbol: "ABC",
        marketCode: "ASX",
        paidOnDate: "2099-01-01",
      }),
    ],
  });

  const result = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient), now: () => FIXED_NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.pendingPayoutsUnresolved, 0);

  const repo = createSharesightPendingPayoutsRepository(client);
  const [row] = await repo.listActive("user-a", "portfolio-a");
  assert.equal(row?.portfolioSecurityId, "sec-1-ps");
});

test("BRK-022 slice 2: an ambiguous symbol+exchange match (no instrument id evidence) resolves to null rather than guessing", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-1",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  seedResolvedSecurity(database, {
    securityId: "sec-2",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [
      fakePayout({
        id: null,
        holdingId: "holding-1",
        sharesightInstrumentId: null,
        symbol: "ABC",
        marketCode: "ASX",
        paidOnDate: "2099-01-01",
      }),
    ],
  });

  const result = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient), now: () => FIXED_NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.pendingPayoutsUnresolved, 1);

  const repo = createSharesightPendingPayoutsRepository(client);
  const [row] = await repo.listActive("user-a", "portfolio-a");
  assert.equal(row?.portfolioSecurityId, null);
});

// ---------------------------------------------------------------------------
// 7. The reused-batch path still upserts/withdraws.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2: a reused (byte-identical) sync still refreshes the pending observation rather than skipping it", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const fixtures = {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [
      fakePayout({
        id: null,
        holdingId: "holding-1",
        symbol: "ABC",
        marketCode: "ASX",
        paidOnDate: "2099-01-01",
      }),
    ],
  };
  const { client } = await linkedFixture(database, fixtures);

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: integrationOf(fakeSharesightClient(fixtures)),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.reused, false);
  assert.equal(first.pendingPayouts, 1);

  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: integrationOf(fakeSharesightClient(fixtures)),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(
    second.reused,
    true,
    "the identical fetch resolves to the same batch",
  );
  assert.equal(second.pendingPayouts, 1, "still refreshed, not skipped");
  assert.equal(second.pendingPayoutsWithdrawn, 0);

  const repo = createSharesightPendingPayoutsRepository(client);
  assert.equal((await repo.listActive("user-a", "portfolio-a")).length, 1);
});

// ---------------------------------------------------------------------------
// 8. A pending row belonging to another user/portfolio is never withdrawn.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2: another owner's pending payout is never touched by this sync's withdrawal pass", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const { client } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [],
  });

  const otherOwnerRepo = createSharesightPendingPayoutsRepository(client);
  const seeded = await otherOwnerRepo.upsertObserved("user-b", "portfolio-b", [
    {
      portfolioSecurityId: null,
      sourceReference: "sharesight-payout:sp-other:holding-1:2099-01-01",
      sharesightHoldingId: "holding-1",
      sharesightInstrumentId: null,
      sharesightPayoutId: null,
      symbol: "DEF",
      marketCode: "ASX",
      currencyCode: "AUD",
      paymentDate: "2099-01-01",
      exDate: null,
      totalCashDecimal: "50.00",
      grossAmountDecimal: "71.43",
      totalFrankingDecimal: null,
      residentWithholdingTaxDecimal: null,
      nonResidentWithholdingTaxDecimal: null,
      fxRateToPortfolioDecimal: null,
      fxRateSource: null,
    },
  ]);
  assert.equal(seeded.ok, true);

  const result = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({ portfolios: [fakePortfolio()], payouts: [] }),
      ),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.pendingPayoutsWithdrawn,
    0,
    "user-a has no pending rows to withdraw",
  );

  assert.equal(
    (await otherOwnerRepo.listActive("user-b", "portfolio-b")).length,
    1,
    "user-b's row survives untouched",
  );
});

// ---------------------------------------------------------------------------
// 9. Panel-helper copy for zero/nonzero/error.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2: formatSyncResultMessage omits the pending-payout line at zero, states it with the unresolved note at non-zero, and prioritises a recording error", () => {
  const base = {
    ok: true as const,
    batchId: "batch-1",
    batchStatus: "parsed",
    rowsStaged: 0,
    skippedPayouts: 0,
    newRows: 0,
    alreadyImportedRows: 0,
    reused: false,
    window: {
      trades: { kind: "full" as const },
      payouts: { kind: "full" as const },
    },
  };

  const zero = formatSyncResultMessage({
    ...base,
    pendingPayouts: 0,
    pendingPayoutsUnresolved: 0,
  });
  assert.doesNotMatch(zero, /announced dividend/);

  const nonzero = formatSyncResultMessage({
    ...base,
    pendingPayouts: 3,
    pendingPayoutsUnresolved: 1,
  });
  assert.match(
    nonzero,
    /3 announced dividends not yet paid recorded \(1 could not be matched to a holding\)/,
  );

  const errored = formatSyncResultMessage({
    ...base,
    pendingPayouts: 0,
    pendingPayoutsUnresolved: 0,
    pendingPayoutsError: "boom",
  });
  assert.match(errored, /Announced dividends could not be recorded: boom/);
});

// ---------------------------------------------------------------------------
// 10. Review round B1: withdrawal fires only on genuine ABSENCE from the
//     fetch, never merely because the pay date passed.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2 review round B1: a pending payout stays active once its pay date passes and it starts staging, and is withdrawn only once Sharesight stops listing it", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const payoutStillPending = fakePayout({
    id: null,
    holdingId: "holding-1",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2026-09-10",
  });
  const { client } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [payoutStillPending],
  });

  // Sync 1 (now = 2026-09-04): the payout is future-dated -> pending row.
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [payoutStillPending],
        }),
      ),
      now: () => "2026-09-04T00:00:00.000Z",
    },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.pendingPayouts, 1);
  assert.equal(first.rowsStaged, 0);

  // Sync 2 (now = 2026-09-20): Sharesight STILL returns the exact same
  // payout, but it is now past its pay date -> stages as a normal row. The
  // pending row must NOT be withdrawn -- Sharesight still lists the payout,
  // and nothing has COMMITTED yet (owner ruling 3).
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [payoutStillPending],
        }),
      ),
      now: () => "2026-09-20T00:00:00.000Z",
    },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.rowsStaged, 1, "the payout now stages as a normal row");
  assert.equal(second.pendingPayouts, 0, "no longer a future-dated candidate");
  assert.equal(
    second.pendingPayoutsWithdrawn,
    0,
    "still observed this sync -- must not be withdrawn",
  );

  const repo = createSharesightPendingPayoutsRepository(client);
  const stillActive = await repo.listActive("user-a", "portfolio-a");
  assert.equal(stillActive.length, 1, "the pending row is still active");
  assert.equal(
    stillActive[0]?.sourceReference,
    "sharesight-payout:sp-1:holding-1:2026-09-10",
  );

  // Sync 3 (now = 2026-09-20): Sharesight no longer lists the payout at
  // all -- NOW it is withdrawn.
  const third = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-3" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({ portfolios: [fakePortfolio()], payouts: [] }),
      ),
      now: () => "2026-09-20T00:00:00.000Z",
    },
  );
  assert.equal(third.ok, true);
  if (!third.ok) return;
  assert.equal(third.pendingPayoutsWithdrawn, 1);
  assert.equal(
    (await repo.listActive("user-a", "portfolio-a")).length,
    0,
    "withdrawn once genuinely absent from the fetch",
  );
});

// ---------------------------------------------------------------------------
// 11. Review round B2: the pending row's BARE source_reference, wrapped by
//     `committedSourceReferenceForFingerprint`, matches a REAL committed
//     row's own `source_reference` exactly.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2 review round B2: committedSourceReferenceForFingerprint(pending.sourceReference) equals the committed row's own source_reference exactly", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const payout = fakePayout({
    id: null,
    holdingId: "holding-1",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2026-09-10",
  });
  const { client } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [payout],
  });

  // Sync 1: future-dated -> pending row, bare key.
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [payout],
        }),
      ),
      now: () => "2026-09-04T00:00:00.000Z",
    },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.pendingPayouts, 1);

  // Sync 2: past its pay date -> stages, then commit it.
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [payout],
        }),
      ),
      now: () => "2026-09-20T00:00:00.000Z",
    },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.rowsStaged, 1);
  await commitBatch(client, second.batchId, "brk-022-b2-commit");

  const pendingRepo = createSharesightPendingPayoutsRepository(client);
  const [pendingRow] = await pendingRepo.listActive("user-a", "portfolio-a");
  assert.ok(pendingRow, "the pending row is still present (slice 3 territory)");

  const committedRow = await client.get<{ source_reference: string }>(
    `SELECT source_reference FROM dividend_manual_records
     WHERE user_id = ? AND portfolio_id = ?
       AND source_reference LIKE 'import-fingerprint:sharesight-payout:%'
     LIMIT 1`,
    ["user-a", "portfolio-a"],
  );
  assert.ok(committedRow, "expected a committed dividend row");

  // The load-bearing assertion: the pending row's BARE key, wrapped by the
  // shared helper, is BYTE-EQUAL to the committed row's own source_reference
  // -- not merely similar, not the bare key compared directly.
  assert.equal(
    committedSourceReferenceForFingerprint(pendingRow.sourceReference),
    committedRow?.source_reference,
  );
  assert.notEqual(
    pendingRow.sourceReference,
    committedRow?.source_reference,
    "the two are related, never byte-equal to each other directly",
  );
});

// ---------------------------------------------------------------------------
// 12. Review round F1: the two best-effort failure branches.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2 review round F1(a): an upsertObserved failure surfaces pendingPayoutsError, zeroes the counts, skips withdrawal, and never fails the sync", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const stalePayout = fakePayout({
    id: null,
    holdingId: "holding-stale",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-01-01",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [stalePayout],
  });
  const firstSync = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient), now: () => FIXED_NOW },
  );
  assert.equal(firstSync.ok, true);
  if (!firstSync.ok) return;
  assert.equal(firstSync.pendingPayouts, 1, "sanity: the stale row exists");

  const newPayout = fakePayout({
    id: null,
    holdingId: "holding-new",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-02-01",
  });
  const failingClient = wrapClientWithFailingBatch(
    client,
    "INSERT INTO sharesight_pending_payouts",
  );
  const result = await runSharesightSyncWithContext(
    { client: failingClient, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [newPayout],
        }),
      ),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(
    result.ok,
    true,
    "recording is best-effort -- never fails the sync",
  );
  if (!result.ok) return;
  assert.equal(
    result.pendingPayoutsError,
    "Could not record announced payouts -- they may be stale until the next sync.",
  );
  assert.equal(result.pendingPayouts, 0);
  assert.equal(result.pendingPayoutsUnresolved, 0);
  assert.equal(
    result.pendingPayoutsWithdrawn,
    0,
    "withdrawal must be skipped entirely, not just report zero",
  );

  const repo = createSharesightPendingPayoutsRepository(client);
  const active = await repo.listActive("user-a", "portfolio-a");
  assert.deepEqual(
    active.map((row) => row.sharesightHoldingId),
    ["holding-stale"],
    "the pre-existing row must still be active -- withdrawal never ran",
  );
});

test("BRK-022 slice 2 review round F1(b): a markWithdrawnNotObserved failure surfaces pendingPayoutsError but never fails the sync, and writes nothing", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const payout = fakePayout({
    id: null,
    holdingId: "holding-1",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-01-01",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [payout],
  });
  const firstSync = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient), now: () => FIXED_NOW },
  );
  assert.equal(firstSync.ok, true);
  if (!firstSync.ok) return;
  assert.equal(firstSync.pendingPayouts, 1);

  const failingClient = wrapClientWithFailingBatch(
    client,
    "UPDATE sharesight_pending_payouts",
  );
  const result = await runSharesightSyncWithContext(
    { client: failingClient, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({ portfolios: [fakePortfolio()], payouts: [] }),
      ),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(
    result.ok,
    true,
    "withdrawal failure is best-effort -- never fails the sync",
  );
  if (!result.ok) return;
  assert.equal(
    result.pendingPayoutsError,
    "Could not withdraw stale announced payouts -- they may still show as outstanding until the next sync.",
  );
  assert.equal(result.pendingPayoutsWithdrawn, 0);

  const repo = createSharesightPendingPayoutsRepository(client);
  const active = await repo.listActive("user-a", "portfolio-a");
  assert.equal(
    active.length,
    1,
    "the write never happened -- row is untouched",
  );
});

// ---------------------------------------------------------------------------
// 13. Review round F2: same-fetch identity collisions among future-dated
//     payouts are never recorded arbitrarily.
// ---------------------------------------------------------------------------

test("BRK-022 slice 2 review round F2: two future-dated payouts sharing one identity key are both skipped, counted, and disclosed in the panel copy", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const interim = fakePayout({
    id: null,
    holdingId: "holding-collide",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-05-01",
    amountDecimal: "10.00",
    grossAmountDecimal: "14.29",
  });
  const special = fakePayout({
    id: null,
    holdingId: "holding-collide",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-05-01", // same holding + same paid date -> same key
    amountDecimal: "25.00",
    grossAmountDecimal: "35.71",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [interim, special],
  });

  const result = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient), now: () => FIXED_NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.pendingPayouts, 0, "neither is recorded");
  assert.equal(result.pendingPayoutsUnresolved, 0);
  assert.equal(result.pendingPayoutsCollided, 2);
  assert.equal(result.pendingPayoutsError, null);

  const repo = createSharesightPendingPayoutsRepository(client);
  assert.equal((await repo.listActive("user-a", "portfolio-a")).length, 0);

  assert.match(
    formatSyncResultMessage(result),
    /2 not recorded: Sharesight lists two payouts for the same holding and date/,
  );
});

test("BRK-022 slice 2 review round F2: a colliding pair does not block an unrelated non-colliding payout from being recorded", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const colliding1 = fakePayout({
    id: null,
    holdingId: "holding-collide",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-05-01",
  });
  const colliding2 = fakePayout({
    id: null,
    holdingId: "holding-collide",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-05-01",
  });
  const clean = fakePayout({
    id: null,
    holdingId: "holding-clean",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-06-01",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [colliding1, colliding2, clean],
  });

  const result = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient), now: () => FIXED_NOW },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.pendingPayouts, 1);
  assert.equal(result.pendingPayoutsCollided, 2);

  const repo = createSharesightPendingPayoutsRepository(client);
  const active = await repo.listActive("user-a", "portfolio-a");
  assert.deepEqual(
    active.map((row) => row.sharesightHoldingId),
    ["holding-clean"],
  );
});

test("BRK-022 slice 2 review round F2: a previously-recorded row left active when its key later collides, rather than withdrawn or overwritten", async () => {
  const database = await migratedDatabase();
  seedResolvedSecurity(database, {
    securityId: "sec-abc",
    userId: "user-a",
    portfolioId: "portfolio-a",
    symbol: "ABC",
    exchangeAlias: "ASX",
    currencyCode: "AUD",
  });
  const original = fakePayout({
    id: null,
    holdingId: "holding-collide",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-05-01",
    amountDecimal: "10.00",
    grossAmountDecimal: "14.29",
  });
  const { client } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [original],
  });

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [original],
        }),
      ),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.pendingPayouts, 1);

  // Sharesight now ALSO reports a second, colliding payout for the exact
  // same holding+date -- the previously-recorded row must be left exactly
  // as it was: not withdrawn (it is still observed), not refreshed (the
  // collision makes neither payout safe to write).
  const newlyCollidingSibling = fakePayout({
    id: null,
    holdingId: "holding-collide",
    symbol: "ABC",
    marketCode: "ASX",
    paidOnDate: "2099-05-01",
    amountDecimal: "99.00",
    grossAmountDecimal: "141.43",
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    {
      integration: integrationOf(
        fakeSharesightClient({
          portfolios: [fakePortfolio()],
          payouts: [original, newlyCollidingSibling],
        }),
      ),
      now: () => FIXED_NOW,
    },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.pendingPayouts, 0);
  assert.equal(second.pendingPayoutsCollided, 2);
  assert.equal(second.pendingPayoutsWithdrawn, 0);

  const repo = createSharesightPendingPayoutsRepository(client);
  const active = await repo.listActive("user-a", "portfolio-a");
  assert.equal(active.length, 1);
  assert.equal(
    active[0]?.totalCashDecimal,
    "10.00",
    "the original value is untouched -- never overwritten by the collision",
  );
});
