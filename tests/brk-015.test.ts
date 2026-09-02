/**
 * BRK-015 -- Incremental Sharesight sync: watermark-narrowed routine sync
 * plus an explicit full resync (owner-ruled).
 *
 * THE LOAD-BEARING CORRECTNESS PROPERTY under test throughout this file:
 * the routine sync's narrowing watermarks are derived from what has
 * actually been COMMITTED (`transactions`/`dividend_manual_records`), never
 * from `sharesight_sync_state.last_synced_at`/`last_trade_watermark` (both
 * staging-time signals -- BRK-005 ruling 4 advances `last_synced_at` on
 * successful STAGING, before the owner's separate commit step). The owner
 * confirmed staging a batch and never accepting it is a LIKELY path on this
 * account, not a remote edge case -- see "abandoned batch" below, which
 * pins exactly this hazard.
 *
 * REVIEW ROUND B1 (BLOCKING) FIX, ALSO PINNED HERE: trades and payouts get
 * TWO SEPARATE watermarks and TWO SEPARATE overlap constants, never one
 * shared value -- a shared watermark let the LEADING stream silently
 * govern the LAGGING stream's fetch window, which landed on the owner's
 * dividends specifically. See "cross-stream" test below for the reviewer's
 * exact repro.
 *
 * Fixtures largely mirror `tests/brk-005.test.ts`'s established pattern
 * (`migratedDatabase`, `fakeTrade`/`fakePayout`/`fakePortfolio`,
 * `commitBatch`), duplicated here (this codebase's established per-file
 * convention -- see e.g. `tests/brk-010.test.ts`) rather than imported,
 * except this file's own Sharesight client fake -- unlike BRK-005's, which
 * ignores `from`/`to` entirely, THIS file's fake actually filters by them,
 * since the whole point here is to prove the fetch window itself.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import {
  linkSharesightPortfolioWithContext,
  runSharesightSyncWithContext,
} from "../app/sharesight-sync-service.ts";
import {
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSqliteSqlClient,
  loadCommittedSharesightWatermarks,
  type ImportCommitInput,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  computeRoutineSyncFromDate,
  SHARESIGHT_PAYOUT_SYNC_OVERLAP_DAYS,
  SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS,
} from "../domain/sharesight-sync/index.ts";
import type {
  SharesightClient,
  SharesightListParams,
  SharesightPayout,
  SharesightPortfolio,
  SharesightTrade,
} from "../domain/sharesight/index.ts";

// ---------------------------------------------------------------------------
// Fixtures (mirrors tests/brk-005.test.ts's migratedDatabase()/fakeTrade()/
// fakePayout()/fakePortfolio()/commitBatch()).
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
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-13', '2026-08-13', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Main', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-13', '2026-08-13', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Alpha', 'equity', 'AUD', 'active', '2026-08-13', '2026-08-13');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'ABC', 'ASX', 'AUD', 'held', '2026-08-13', '2026-08-13');
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

type CapturedCall = {
  portfolioId: string;
  params: SharesightListParams | undefined;
};

/**
 * Unlike `tests/brk-005.test.ts`'s `fakeSharesightClient` (which ignores
 * `from`/`to` and always returns the full fixture), THIS fake actually
 * filters by them -- inclusive on both bounds, matching Sharesight's own
 * documented `start_date`/`end_date` semantics (`markcatley/sharesight.rs`)
 * -- and records every call's params, so tests can assert on the WINDOW
 * `runSharesightSyncWithContext` actually requested, not just on what
 * eventually got staged.
 */
function filteringSharesightClient(fixtures: {
  portfolios?: SharesightPortfolio[];
  trades?: SharesightTrade[];
  payouts?: SharesightPayout[];
}): {
  client: SharesightClient;
  calls: { trades: CapturedCall[]; payouts: CapturedCall[] };
} {
  const calls = { trades: [] as CapturedCall[], payouts: [] as CapturedCall[] };
  function inWindow(date: string, params: SharesightListParams | undefined) {
    if (params?.from && date < params.from) return false;
    if (params?.to && date > params.to) return false;
    return true;
  }
  const client: SharesightClient = {
    async listPortfolios() {
      return { ok: true, value: fixtures.portfolios ?? [] };
    },
    async getPortfolioHoldings() {
      return { ok: true, value: [] };
    },
    async listTrades(portfolioId, params) {
      calls.trades.push({ portfolioId, params });
      return {
        ok: true,
        value: (fixtures.trades ?? []).filter((t) =>
          inWindow(t.transactionDate, params),
        ),
      };
    },
    async listPayouts(portfolioId, params) {
      calls.payouts.push({ portfolioId, params });
      return {
        ok: true,
        value: (fixtures.payouts ?? []).filter((p) =>
          inWindow(p.paidOnDate, params),
        ),
      };
    },
    async listUserInstruments() {
      return { ok: true, value: [] };
    },
  };
  return { client, calls };
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

/**
 * Links `portfolio-a` to Sharesight portfolio `sp-1` ONCE, returning the
 * `SqlClient` every subsequent sync in a test reuses. Later syncs in the
 * SAME test represent "Sharesight's account state changed" -- modelled by
 * building a FRESH `filteringSharesightClient` with updated fixtures (via
 * `filteringSharesightClient` directly), never by re-linking.
 */
async function linkedFixture(
  database: DatabaseSync,
  fixtures: Parameters<typeof filteringSharesightClient>[0] = {
    portfolios: [fakePortfolio()],
  },
): Promise<{
  client: SqlClient;
  sharesightClient: SharesightClient;
  calls: { trades: CapturedCall[]; payouts: CapturedCall[] };
}> {
  const client = createSqliteSqlClient(database);
  const { client: sharesightClient, calls } =
    filteringSharesightClient(fixtures);
  const linked = await linkSharesightPortfolioWithContext(
    { client, userId: "user-a", requestId: "link-req" },
    "portfolio-a",
    { sharesightPortfolioId: "sp-1" },
    { integration: { enabled: true, client: sharesightClient } },
  );
  assert.equal(linked.ok, true);
  return { client, sharesightClient, calls };
}

const integrationOf = (sharesightClient: SharesightClient) => ({
  enabled: true as const,
  client: sharesightClient,
});

// ---------------------------------------------------------------------------
// Pure window arithmetic
// ---------------------------------------------------------------------------

test("BRK-015: computeRoutineSyncFromDate subtracts the overlap in whole calendar days, UTC, across a month/year boundary", () => {
  assert.equal(computeRoutineSyncFromDate("2026-08-20", 30), "2026-07-21");
  assert.equal(computeRoutineSyncFromDate("2026-01-05", 10), "2025-12-26");
});

test("BRK-015: computeRoutineSyncFromDate rejects a non-YYYY-MM-DD input rather than silently misparsing it", () => {
  assert.throws(() => computeRoutineSyncFromDate("not-a-date", 30));
});

test("BRK-015 review round B1 fix: SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS and SHARESIGHT_PAYOUT_SYNC_OVERLAP_DAYS are distinct, non-interchangeable constants -- there is no shared default any more", () => {
  assert.equal(SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS, 30);
  assert.equal(SHARESIGHT_PAYOUT_SYNC_OVERLAP_DAYS, 180);
  assert.notEqual(
    SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS,
    SHARESIGHT_PAYOUT_SYNC_OVERLAP_DAYS,
  );
});

// ---------------------------------------------------------------------------
// Watermarks advance only on commit, and only from committed state
// ---------------------------------------------------------------------------

test("BRK-015 (the load-bearing hazard): the committed watermarks stay null after STAGING alone, and only move once the batch is COMMITTED", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [fakeTrade({ id: "trade-1", transactionDate: "2026-07-01" })],
    payouts: [fakePayout({ id: "payout-1", paidOnDate: "2026-07-05" })],
  });

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;

  // Staged, not yet committed -- both derived watermarks must still be null.
  const beforeCommit = await loadCommittedSharesightWatermarks(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(beforeCommit.tradeWatermark, null);
  assert.equal(beforeCommit.payoutWatermark, null);

  await commitBatch(client, synced.batchId, "brk-015-commit-1");

  const afterCommit = await loadCommittedSharesightWatermarks(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(afterCommit.tradeWatermark, "2026-07-01");
  assert.equal(afterCommit.payoutWatermark, "2026-07-05");
});

test("BRK-015: loadCommittedSharesightWatermarks is owner-scoped -- a DIFFERENT user's query against the SAME portfolio id sees no watermark at all (review round follow-up 4)", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [fakeTrade({ id: "trade-1", transactionDate: "2026-07-01" })],
    payouts: [fakePayout({ id: "payout-1", paidOnDate: "2026-07-05" })],
  });
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;
  await commitBatch(client, synced.batchId, "brk-015-iso-commit");

  const owner = await loadCommittedSharesightWatermarks(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(owner.tradeWatermark, "2026-07-01");
  assert.equal(owner.payoutWatermark, "2026-07-05");

  const otherUser = await loadCommittedSharesightWatermarks(
    client,
    "user-b",
    "portfolio-a",
  );
  assert.equal(
    otherUser.tradeWatermark,
    null,
    "a different user must never see this portfolio's committed trade watermark",
  );
  assert.equal(
    otherUser.payoutWatermark,
    null,
    "a different user must never see this portfolio's committed payout watermark",
  );
});

test("BRK-015: loadCommittedSharesightWatermarks excludes a REVERSED trade and its SUPERSEDED/deleted payout (review round follow-up 4)", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [fakeTrade({ id: "trade-1", transactionDate: "2026-07-01" })],
    payouts: [fakePayout({ id: "payout-1", paidOnDate: "2026-07-05" })],
  });
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;
  await commitBatch(client, synced.batchId, "brk-015-rev-commit");

  const before = await loadCommittedSharesightWatermarks(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(before.tradeWatermark, "2026-07-01");
  assert.equal(before.payoutWatermark, "2026-07-05");

  // Reverse the WHOLE batch -- the reversal machinery's real unit (mirrors
  // tests/brk-005.test.ts's own reversal round trip). This flips the
  // trade's status away from 'posted' AND deletes the dividend record
  // outright (`db/repositories/import-reversal.ts`).
  const committedBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    synced.batchId,
  );
  const reversalRepo = createOwnedImportReversalRepository(client);
  let reversed = await reversalRepo.reverse("user-a", synced.batchId, {
    expectedVersion: committedBatch!.version,
    idempotencyKey: "brk-015-reverse",
    confirmation: true,
    requestId: "brk-015-reverse-request",
  });
  for (
    let attempt = 0;
    attempt < 10 && (!reversed.ok || reversed.status !== "reversed");
    attempt += 1
  ) {
    assert.equal(reversed.ok, true);
    reversed = await reversalRepo.reverse("user-a", synced.batchId, {
      expectedVersion: committedBatch!.version,
      idempotencyKey: "brk-015-reverse",
      confirmation: true,
      requestId: "brk-015-reverse-request",
    });
  }
  assert.equal(reversed.ok, true);
  if (reversed.ok) assert.equal(reversed.status, "reversed");

  const after = await loadCommittedSharesightWatermarks(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(
    after.tradeWatermark,
    null,
    "a reversed trade must not anchor the trade watermark",
  );
  assert.equal(
    after.payoutWatermark,
    null,
    "a reversed/deleted payout must not anchor the payout watermark",
  );
});

// ---------------------------------------------------------------------------
// REVIEW ROUND B1 (BLOCKING): the payout stream must never be narrowed by
// the trade stream's watermark, or vice versa.
// ---------------------------------------------------------------------------

test("BRK-015 REVIEW ROUND B1 (the reviewer's exact repro): a late-entered payout is not silently skipped just because the TRADE stream has advanced further -- each stream's window must come from its OWN watermark", async () => {
  const database = await migratedDatabase();
  const baselineTrade = fakeTrade({
    id: "trade-baseline",
    transactionDate: "2026-06-01",
  });
  const baselinePayout = fakePayout({
    id: "payout-baseline",
    paidOnDate: "2026-06-01",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [baselineTrade],
    payouts: [baselinePayout],
  });
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await commitBatch(client, first.batchId, "brk-015-b1-baseline");

  // Only the TRADE stream advances -- a later trade commits; no new payout.
  const laterTrade = fakeTrade({
    id: "trade-later",
    transactionDate: "2026-08-01",
  });
  const { client: sharesightClientB } = filteringSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [baselineTrade, laterTrade],
    payouts: [baselinePayout],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: integrationOf(sharesightClientB) },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  await commitBatch(client, second.batchId, "brk-015-b1-later-trade");

  const watermarks = await loadCommittedSharesightWatermarks(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(watermarks.tradeWatermark, "2026-08-01");
  assert.equal(
    watermarks.payoutWatermark,
    "2026-06-01",
    "the payout watermark must be UNCHANGED by trade-only activity -- the lagging stream",
  );

  // Sharesight late-enters a payout only 19 days past the PAYOUT
  // watermark -- well inside the payout stream's own (180-day) overlap,
  // but WOULD have been excluded by a trade-watermark-derived shared
  // window (2026-08-01 - 30 = 2026-07-02 > 2026-06-20).
  const latePayout = fakePayout({
    id: "payout-late",
    paidOnDate: "2026-06-20",
  });
  const { client: sharesightClientC, calls } = filteringSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [baselineTrade, laterTrade],
    payouts: [baselinePayout, latePayout],
  });
  const third = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-3" },
    "portfolio-a",
    { integration: integrationOf(sharesightClientC) },
  );
  assert.equal(third.ok, true);
  if (!third.ok) return;

  const expectedTradeFrom = computeRoutineSyncFromDate(
    "2026-08-01",
    SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS,
  );
  const expectedPayoutFrom = computeRoutineSyncFromDate(
    "2026-06-01",
    SHARESIGHT_PAYOUT_SYNC_OVERLAP_DAYS,
  );
  assert.notEqual(
    expectedTradeFrom,
    expectedPayoutFrom,
    "sanity: the two windows must genuinely differ for this repro to mean anything",
  );
  assert.equal(calls.trades[0]?.params?.from, expectedTradeFrom);
  assert.equal(
    calls.payouts[0]?.params?.from,
    expectedPayoutFrom,
    "the payout fetch must be governed by the PAYOUT watermark, never the trade watermark",
  );
  assert.deepEqual(third.window.trades, {
    kind: "narrowed",
    sinceDate: expectedTradeFrom,
  });
  assert.deepEqual(third.window.payouts, {
    kind: "narrowed",
    sinceDate: expectedPayoutFrom,
  });

  // The late payout must actually have been fetched/staged: 1 trade
  // (laterTrade -- baselineTrade is outside the trade window) + 2 payouts
  // (baselinePayout + latePayout, both inside the payout window) = 3.
  // Under the pre-fix shared-watermark bug this would have been 2 (the
  // late payout silently dropped).
  assert.equal(
    third.rowsStaged,
    3,
    "the late-entered payout must be present -- 2 here would mean it was silently dropped (the pre-fix bug)",
  );
});

// ---------------------------------------------------------------------------
// Routine sync narrows the fetch; unchanged account stages far fewer rows
// ---------------------------------------------------------------------------

test("BRK-015: a routine sync narrows listTrades to (committed trade watermark - trade overlap), unset upper bound", async () => {
  const database = await migratedDatabase();
  const oldTrade = fakeTrade({
    id: "trade-old",
    transactionDate: "2020-01-01",
  });
  const { client, sharesightClient, calls } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [oldTrade],
    payouts: [],
  });

  // First-ever sync: no committed watermark yet -- must be an UNBOUNDED
  // fetch for BOTH streams (mirrors today's behaviour), reported as
  // window.trades.kind === window.payouts.kind === "full".
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(calls.trades[0]?.params, undefined);
  assert.equal(first.window.trades.kind, "full");
  assert.equal(first.window.payouts.kind, "full");
  await commitBatch(client, first.batchId, "brk-015-commit-old");

  const watermarks = await loadCommittedSharesightWatermarks(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(watermarks.tradeWatermark, "2020-01-01");

  // Second sync (routine, default mode): must narrow to
  // (trade watermark - trade overlap), no upper bound.
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const expectedFrom = computeRoutineSyncFromDate(
    "2020-01-01",
    SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS,
  );
  assert.deepEqual(calls.trades[1]?.params, { from: expectedFrom });
  assert.deepEqual(second.window.trades, {
    kind: "narrowed",
    sinceDate: expectedFrom,
  });
  // No payout ever committed -- that stream stays unbounded independently.
  assert.deepEqual(calls.payouts[1]?.params, undefined);
  assert.equal(second.window.payouts.kind, "full");
});

test("BRK-015 acceptance: an unchanged account's routine sync stages far fewer rows than a full history would (226-row production symptom)", async () => {
  const database = await migratedDatabase();
  // Five OLD trades (2015-2019, well outside any recent overlap window) plus
  // one recent trade -- mirrors "syncs back to 2019 every time" being the
  // actual owner complaint this task fixes.
  const oldTrades = [2015, 2016, 2017, 2018, 2019].map((year) =>
    fakeTrade({ id: `trade-${year}`, transactionDate: `${year}-06-01` }),
  );
  const recentTrade = fakeTrade({
    id: "trade-recent",
    transactionDate: "2026-08-01",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [...oldTrades, recentTrade],
    payouts: [],
  });

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.rowsStaged, 6, "first sync sees the full 6-trade history");
  await commitBatch(client, first.batchId, "brk-015-commit-full");

  // Unchanged account: the fixture is IDENTICAL on the next sync.
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  // Only the recent trade (inside the watermark-derived window) is
  // re-fetched -- the 5 old (2015-2019) trades are outside it and never
  // re-examined. "Few", not necessarily zero (TASKS.md's own acceptance
  // wording) -- the account's own most-recent activity always sits inside
  // its own overlap window.
  assert.equal(second.rowsStaged, 1);
  assert.ok(
    second.rowsStaged < first.rowsStaged,
    "routine sync must stage strictly fewer rows than the full-history baseline",
  );
});

// ---------------------------------------------------------------------------
// A genuinely new payout since the last sync is still picked up
// ---------------------------------------------------------------------------

test("BRK-015 acceptance: a new payout dated after the committed payout watermark is still picked up by the next routine sync", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [fakePayout({ id: "payout-old", paidOnDate: "2026-08-01" })],
  });

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await commitBatch(client, first.batchId, "brk-015-commit-payout-old");

  // A genuinely NEW payout arrives, dated after the committed watermark.
  const { client: sharesightClient2 } = filteringSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [
      fakePayout({ id: "payout-old", paidOnDate: "2026-08-01" }),
      fakePayout({ id: "payout-new", paidOnDate: "2026-08-25" }),
    ],
  });

  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient2) },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(
    second.rowsStaged,
    2,
    "both the already-committed payout (inside the overlap) and the new one are re-examined",
  );
  await commitBatch(client, second.batchId, "brk-015-commit-payout-new");

  const dividendRows = database
    .prepare(
      `SELECT source_reference FROM dividend_manual_records WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a'`,
    )
    .all() as { source_reference: string }[];
  assert.ok(
    // Payout identity is keyed by (sharesightPortfolioId, holdingId,
    // paidOnDate) -- NOT the Sharesight payout `id`
    // (`domain/sharesight-sync/transform.ts`'s `payoutIdentityKey`).
    dividendRows.some((row) => row.source_reference.includes("2026-08-25")),
    "the new payout must have actually committed as a dividend record",
  );
});

// ---------------------------------------------------------------------------
// THE HAZARD: a batch staged and then abandoned is re-fetched, never
// silently skipped past.
// ---------------------------------------------------------------------------

test("BRK-015 THE HAZARD: a batch staged and then abandoned (never accepted) is still re-fetched by the next routine sync -- the watermark must not have moved past it", async () => {
  const database = await migratedDatabase();
  const baselineTrade = fakeTrade({
    id: "trade-baseline",
    transactionDate: "2026-06-01",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [baselineTrade],
    payouts: [],
  });

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await commitBatch(client, first.batchId, "brk-015-commit-baseline");

  const watermarkAfterBaseline = await loadCommittedSharesightWatermarks(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(watermarkAfterBaseline.tradeWatermark, "2026-06-01");

  // A NEW trade arrives, recent enough to fall inside the routine window --
  // this sync STAGES it but the batch is deliberately NEVER accepted
  // (abandoned), exactly the owner-confirmed likely path.
  const newTrade = fakeTrade({
    id: "trade-abandoned",
    transactionDate: "2026-06-10",
  });
  const { client: sharesightClientB } = filteringSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [baselineTrade, newTrade],
    payouts: [],
  });

  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: integrationOf(sharesightClientB) },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.ok(
    second.rowsStaged >= 2,
    "the new trade must have actually been staged, not silently dropped",
  );
  // Deliberately NOT committed -- this batch is abandoned.

  // The committed watermark must be UNCHANGED by the abandoned staging --
  // this is the hazard's exact failure mode if narrowing had keyed off a
  // staging-advanced signal instead.
  const watermarkAfterAbandon = await loadCommittedSharesightWatermarks(
    client,
    "user-a",
    "portfolio-a",
  );
  assert.equal(watermarkAfterAbandon.tradeWatermark, "2026-06-01");

  // A THIRD sync (routine) must still ask Sharesight for the abandoned
  // trade's date -- i.e. the fetch window must NOT have advanced past
  // 2026-06-10 just because a batch mentioning it was staged.
  const { client: sharesightClientC, calls } = filteringSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [baselineTrade, newTrade],
    payouts: [],
  });

  const third = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-3" },
    "portfolio-a",
    { integration: integrationOf(sharesightClientC) },
  );
  assert.equal(third.ok, true);
  if (!third.ok) return;
  const thirdFrom = calls.trades[0]?.params?.from;
  assert.ok(
    thirdFrom === undefined || thirdFrom <= "2026-06-10",
    `third sync's fetch window (from=${thirdFrom}) must still cover the abandoned trade's date`,
  );
  assert.ok(
    third.rowsStaged >= 2,
    "the abandoned trade must still be present in what Sharesight returned",
  );
});

// ---------------------------------------------------------------------------
// Overlap boundary: settled just inside vs. just outside the trade overlap
// ---------------------------------------------------------------------------

test("BRK-015: overlap boundary -- a trade dated exactly at (watermark - trade overlap) is included, one day earlier is excluded", async () => {
  const database = await migratedDatabase();
  const anchorTrade = fakeTrade({
    id: "trade-anchor",
    transactionDate: "2026-08-20",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [anchorTrade],
    payouts: [],
  });
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await commitBatch(client, first.batchId, "brk-015-commit-anchor");

  const cutoff = computeRoutineSyncFromDate(
    "2026-08-20",
    SHARESIGHT_TRADE_SYNC_OVERLAP_DAYS,
  ); // 2026-07-21
  const insideTrade = fakeTrade({
    id: "trade-inside",
    transactionDate: cutoff,
  });
  const outsideDate = new Date(
    Date.parse(`${cutoff}T00:00:00.000Z`) - 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const outsideTrade = fakeTrade({
    id: "trade-outside",
    transactionDate: outsideDate,
  });

  const { client: sharesightClientB, calls } = filteringSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [anchorTrade, insideTrade, outsideTrade],
    payouts: [],
  });

  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: integrationOf(sharesightClientB) },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(calls.trades[0]?.params?.from, cutoff);
  // anchor (=cutoff+30d, always inside) + insideTrade (=cutoff, inclusive
  // boundary) = 2; outsideTrade (cutoff - 1 day) must be excluded.
  assert.equal(second.rowsStaged, 2);
});

// ---------------------------------------------------------------------------
// Full resync preserves today's unconditional behaviour, including the
// BRK-005 finding-B1 old-record-correction case a narrowed window would miss
// ---------------------------------------------------------------------------

test("BRK-015 acceptance: a routine sync cannot see a correction to an old (out-of-window) trade, but an explicit Full resync still does", async () => {
  const database = await migratedDatabase();
  const oldTrade = fakeTrade({
    id: "trade-2020",
    transactionDate: "2020-02-27",
    quantityDecimal: "5",
    priceDecimal: "10",
    valueDecimal: "50",
  });
  const recentTrade = fakeTrade({
    id: "trade-recent",
    transactionDate: "2026-08-01",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [oldTrade, recentTrade],
    payouts: [],
  });
  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationOf(sharesightClient) },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await commitBatch(client, first.batchId, "brk-015-commit-b1-baseline");

  // Sharesight-side correction to the OLD 2020 trade -- same id, corrected
  // value (mirrors BRK-005 review finding B1's exact repro shape).
  const correctedOldTrade = fakeTrade({
    id: "trade-2020",
    transactionDate: "2020-02-27",
    quantityDecimal: "500",
    priceDecimal: "99",
    valueDecimal: "49500",
  });

  // Routine sync: the correction is OUTSIDE the narrowed window (watermark
  // is 2026-08-01, overlap only reaches back to ~2026-07-02) -- it must not
  // be visible to this call at all.
  const { client: sharesightClientB } = filteringSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [correctedOldTrade, recentTrade],
    payouts: [],
  });
  const routine = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-routine" },
    "portfolio-a",
    { integration: integrationOf(sharesightClientB) },
  );
  assert.equal(routine.ok, true);
  if (!routine.ok) return;
  assert.equal(
    routine.rowsStaged,
    1,
    "the routine window only re-examines the recent trade, never the corrected 2020 one",
  );

  // Full resync: unconditional fetch, unchanged from pre-BRK-015 behaviour
  // -- must see BOTH trades, including the correction, and (since the
  // content differs from anything already staged/committed) must create a
  // genuinely NEW batch rather than reusing an old one.
  const { client: sharesightClientC, calls } = filteringSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [correctedOldTrade, recentTrade],
    payouts: [],
  });
  const full = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-full" },
    "portfolio-a",
    { integration: integrationOf(sharesightClientC), mode: "full" },
  );
  assert.equal(full.ok, true);
  if (!full.ok) return;
  assert.deepEqual(calls.trades[0]?.params, undefined);
  assert.deepEqual(calls.payouts[0]?.params, undefined);
  assert.equal(full.window.trades.kind, "full");
  assert.equal(full.window.payouts.kind, "full");
  assert.equal(full.reused, false, "the correction must produce a NEW batch");
  assert.equal(full.rowsStaged, 2);
});
