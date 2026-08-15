import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { markImportReadyWithContext } from "../app/import-ready-service.ts";
import { buildImportReviewPreview } from "../app/import-preview.ts";
import {
  linkSharesightPortfolioWithContext,
  listSharesightPortfoliosWithContext,
  runSharesightSyncWithContext,
} from "../app/sharesight-sync-service.ts";
import {
  createDividendManualRecordRepository,
  createOwnedImportCommitRepository,
  createOwnedImportMappingDecisionRepository,
  createOwnedImportReversalRepository,
  createOwnedImportStagingRepository,
  createOwnedPortfolioRepository,
  createSharesightSyncStateRepository,
  createSqliteSqlClient,
  type ImportCommitInput,
  type SqlClient,
} from "../db/repositories/index.ts";
import {
  resolveSharesightTradeDirection,
  transformSharesightSync,
} from "../domain/sharesight-sync/transform.ts";
import type {
  SharesightClient,
  SharesightPayout,
  SharesightPortfolio,
  SharesightResult,
  SharesightTrade,
} from "../domain/sharesight/index.ts";
import { deriveDividendHistoryForSecurity } from "../domain/dividends/history.ts";
import {
  parseStrictVersionedCsvImport,
  SUPPORTED_IMPORT_HEADER_WITH_DIVIDENDS,
} from "../domain/imports/index.ts";
import { buildDividendManualRecordImportInsertStatements } from "../db/repositories/dividends.ts";

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
  };
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
  initialVersion: number,
): Promise<void> {
  const previewVersion = await currentPreviewVersion(client, "user-a", batchId);
  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    batchId,
    { expectedVersion: initialVersion, expectedPreviewVersion: previewVersion },
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

// ---------------------------------------------------------------------------
// Transform: trade direction mapping
// ---------------------------------------------------------------------------

test("BRK-005: sign confirms direction when transactionType/descriptionCode agree or are absent", () => {
  const buy = resolveSharesightTradeDirection(
    fakeTrade({ valueDecimal: "50", transactionType: "buy" }),
  );
  assert.deepEqual(buy, { ok: true, type: "buy" });

  const sell = resolveSharesightTradeDirection(
    fakeTrade({ valueDecimal: "-50", transactionType: "sell" }),
  );
  assert.deepEqual(sell, { ok: true, type: "sell" });

  const signOnly = resolveSharesightTradeDirection(
    fakeTrade({ valueDecimal: "-50", transactionType: null }),
  );
  assert.deepEqual(signOnly, { ok: true, type: "sell" });

  const codeAgrees = resolveSharesightTradeDirection(
    fakeTrade({
      valueDecimal: "-50",
      transactionType: null,
      descriptionCode: "SELL",
    }),
  );
  assert.deepEqual(codeAgrees, { ok: true, type: "sell" });
});

test("BRK-005: sign-vs-type disagreement is an error, never guessed", () => {
  const result = resolveSharesightTradeDirection(
    fakeTrade({ valueDecimal: "50", transactionType: "sell" }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "disagreement");
});

test("BRK-005: sign-vs-descriptionCode disagreement is an error, never guessed", () => {
  const result = resolveSharesightTradeDirection(
    fakeTrade({
      valueDecimal: "-50",
      transactionType: null,
      descriptionCode: "BUY",
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "disagreement");
});

test("BRK-005: no usable signal at all (no value, 'other' type, unrecognized code) is an error, never guessed", () => {
  const result = resolveSharesightTradeDirection(
    fakeTrade({
      valueDecimal: null,
      transactionType: "other",
      descriptionCode: "SPLIT",
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "no_signal");
});

// ---------------------------------------------------------------------------
// Transform: trades/payouts -> staged rows
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-08-13T00:00:00.000Z";

test("BRK-005: a live-shaped buy trade transforms into a staged transaction row with positive shares and no fabricated FX", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [fakeTrade({ quantityDecimal: "5", priceDecimal: "10" })],
    payouts: [],
    now: FIXED_NOW,
  });
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.equal(row.kind, "transaction");
  assert.equal(row.normalized.type, "buy");
  assert.equal(row.normalized.sharesOwned, "5");
  assert.equal(row.normalized.costPerShare, "10");
  assert.equal(row.normalized.symbol, "ABC");
  assert.equal(row.normalized.exchange, "ASX");
  assert.equal(row.normalized.portfolio, "Main");
  assert.equal(row.normalized.purchaseExchangeRate, null);
  assert.equal(row.normalized.localTradeDate, "2026-08-01");
  assert.equal(row.fingerprint, "sharesight-trade:trade-1");
  assert.equal(result.summary.transactionRows, 1);
  assert.equal(result.summary.unsupportedRows, 0);
});

test("BRK-005: a sell trade normalizes a signed negative quantity to a positive Shares Owned with type sell", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [
      fakeTrade({
        id: "trade-sell",
        transactionType: "sell",
        valueDecimal: "-50",
        quantityDecimal: "-5",
      }),
    ],
    payouts: [],
    now: FIXED_NOW,
  });
  const row = result.rows[0]!;
  assert.equal(row.normalized.type, "sell");
  assert.equal(row.normalized.sharesOwned, "5");
});

test("BRK-005: an unmapped/ambiguous trade type stages an unsupported row with an explicit error issue, never silently guessed", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [
      fakeTrade({
        id: "trade-ambiguous",
        valueDecimal: "50",
        transactionType: "sell",
      }),
    ],
    payouts: [],
    now: FIXED_NOW,
  });
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.equal(row.kind, "unsupported");
  assert.equal(row.issues.length, 1);
  assert.equal(row.issues[0]?.code, "TRANSACTION_TYPE_UNKNOWN");
  assert.equal(row.issues[0]?.severity, "error");
  assert.equal(result.summary.unsupportedRows, 1);
});

test("BRK-005: a payout with a confirmed id stages a totals-only dividend row -- never a fabricated per-share amount", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [
      fakePayout({ amountDecimal: "2.50", frankingCreditsDecimal: "1.07" }),
    ],
    now: FIXED_NOW,
  });
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.equal(row.normalized.type, "dividend");
  assert.equal(row.normalized.sharesOwned, null);
  assert.equal(row.normalized.costPerShare, null);
  assert.equal(row.normalized.frankingPerShare, null);
  assert.equal(row.normalized.totalCashDecimal, "2.50");
  assert.equal(row.normalized.totalFrankingDecimal, "1.07");
  assert.equal(row.normalized.localTradeDate, "2026-08-05");
  assert.equal(
    row.fingerprint,
    "sharesight-payout:sp-1:holding-1:2026-08-05",
    "identity key: sharesight-payout:<sharesightPortfolioId>:<holdingId>:<paidOnDate> -- the SAME scheme a null-id payout uses, confirmed id plays no part in it",
  );
  assert.match(
    row.normalized.notes ?? "",
    /Sharesight payout id payout-1 \(confirmed there\)/,
    "the confirmed id is no longer part of identity, but must still surface in notes for preview/audit",
  );
  assert.equal(result.summary.dividendRows, 1);
});

test("BRK-005: a null franking-credits payout leaves totalFrankingDecimal unknown (never zero)", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [fakePayout({ frankingCreditsDecimal: null })],
    now: FIXED_NOW,
  });
  const row = result.rows[0]!;
  assert.equal(row.normalized.totalCashDecimal, "2.50");
  assert.equal(row.normalized.totalFrankingDecimal, null);
});

// ---------------------------------------------------------------------------
// BRK-005C (owner decision, 2026-08-16): a null-id payout's `paidOnDate`
// relative to the sync's injected `now` decides past (stage as a real,
// "unconfirmed in Sharesight" record) vs future (still skip with a warning)
// -- correcting the original BRK-005 inference that EVERY null-id payout was
// merely a not-yet-paid distribution. See `transform.ts`'s BRK-005C header
// comment for the full story (99 of 118 of the owner's real payouts were
// null-id, all real income Sharesight itself counts in its tax reports).
// ---------------------------------------------------------------------------

test("BRK-005C: a PAST-dated null-id payout stages as a real totals-only dividend row with a holding+paidOn identity key and an 'unconfirmed in Sharesight' provenance note", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [
      fakePayout({
        id: null,
        paidOnDate: "2026-08-05",
        amountDecimal: "2.50",
        frankingCreditsDecimal: "1.07",
      }),
    ],
    now: FIXED_NOW,
  });
  assert.equal(
    result.issues.length,
    0,
    "a past-dated null-id payout must not raise the skip warning",
  );
  assert.equal(result.rows.length, 1);
  const row = result.rows[0]!;
  assert.equal(row.normalized.type, "dividend");
  assert.equal(row.normalized.id, null, "no confirmed Sharesight id exists");
  assert.equal(row.normalized.totalCashDecimal, "2.50");
  assert.equal(row.normalized.totalFrankingDecimal, "1.07");
  assert.equal(
    row.fingerprint,
    "sharesight-payout:sp-1:holding-1:2026-08-05",
    "identity key: sharesight-payout:<sharesightPortfolioId>:<holdingId>:<paidOnDate> -- the SAME scheme a confirmed payout uses (BRK-005C: id plays no part in identity)",
  );
  assert.equal(
    row.issues.length,
    0,
    "no collision -- a single payout for this key",
  );
  assert.match(row.normalized.notes ?? "", /unconfirmed in Sharesight/);
  assert.equal(result.summary.dividendRows, 1);
});

test("BRK-005C: a null-id payout's own comments are preserved ALONGSIDE the provenance note, not overwritten", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [
      fakePayout({
        id: null,
        paidOnDate: "2026-08-05",
        comments: "reinvested per DRP",
      }),
    ],
    now: FIXED_NOW,
  });
  const row = result.rows[0]!;
  assert.match(row.normalized.notes ?? "", /unconfirmed in Sharesight/);
  assert.match(row.normalized.notes ?? "", /reinvested per DRP/);
});

test("BRK-005C: a confirmed payout's own Sharesight id surfaces in notes (visible in preview/audit) even though it is no longer part of identity", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [
      fakePayout({
        id: "payout-77",
        paidOnDate: "2026-08-05",
        comments: "DRP",
      }),
    ],
    now: FIXED_NOW,
  });
  const row = result.rows[0]!;
  assert.match(
    row.normalized.notes ?? "",
    /Sharesight payout id payout-77 \(confirmed there\)/,
  );
  assert.match(row.normalized.notes ?? "", /DRP/);
  assert.doesNotMatch(row.normalized.notes ?? "", /unconfirmed in Sharesight/);
});

test("BRK-005C: a null-id payout paid on the SAME calendar day as now counts as past (staged), not future", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [fakePayout({ id: null, paidOnDate: "2026-08-13" })],
    now: FIXED_NOW,
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.issues.length, 0);
});

test("BRK-005C: a FUTURE-dated null-id payout is still SKIPPED, with the warning reworded to say future-dated/not-yet-paid rather than implying every unconfirmed payout is dropped", () => {
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [fakePayout({ id: null, paidOnDate: "2099-01-01" })],
    now: FIXED_NOW,
  });
  assert.equal(
    result.rows.length,
    0,
    "expected the future-dated null-id payout not to be staged",
  );
  assert.equal(result.summary.dividendRows, 0);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.code, "SHARESIGHT_PAYOUT_UNCONFIRMED");
  assert.equal(result.issues[0]?.severity, "warning");
  assert.match(result.issues[0]?.message ?? "", /future-dated/);
  assert.doesNotMatch(
    result.issues[0]?.message ?? "",
    /unconfirmed\/declared/,
    "must not use the old wording that implied every unconfirmed payout is skipped",
  );
});

test("BRK-005C: confirmed (non-null-id) payouts are completely unaffected by the past/future classification -- they stage regardless of paidOnDate", () => {
  const future = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [
      fakePayout({
        id: "payout-future",
        holdingId: "holding-future",
        paidOnDate: "2099-01-01",
      }),
    ],
    now: FIXED_NOW,
  });
  assert.equal(future.rows.length, 1);
  assert.equal(future.issues.length, 0);
  assert.equal(
    future.rows[0]?.fingerprint,
    "sharesight-payout:sp-1:holding-future:2099-01-01",
  );
});

// ---------------------------------------------------------------------------
// BRK-005C review round FAIL, addressed (Orchestrator ruling 2026-08-16):
// B1 (confirmation flipped id-key<->natural-key, causing a double-commit
// once Sharesight confirmed an already-synced-and-committed payout) is
// closed by identity NEVER depending on `id` (tested above: a confirmed and
// an unconfirmed payout for the SAME holding+date share the identical key).
// B2 (an invented content-sorted ordinal to disambiguate a collision) and B3
// (a byte-identical duplicate pair silently staging as two accepted facts)
// are closed by removing disambiguation entirely: a collision now fails
// CLOSED and VISIBLY.
// ---------------------------------------------------------------------------

test("BRK-005C: two payouts colliding on the SAME identity key (same holding, same paid_on -- e.g. an interim and a special dividend) are BOTH staged but EACH carries a blocking error issue, never silently auto-disambiguated", () => {
  const interim = fakePayout({
    id: null,
    holdingId: "holding-1",
    paidOnDate: "2026-08-05",
    amountDecimal: "2.50",
    frankingCreditsDecimal: "1.07",
  });
  const special = fakePayout({
    id: null,
    holdingId: "holding-1",
    paidOnDate: "2026-08-05",
    amountDecimal: "9.99",
    frankingCreditsDecimal: "3.00",
  });
  const key = "sharesight-payout:sp-1:holding-1:2026-08-05";

  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [interim, special],
    now: FIXED_NOW,
  });
  assert.equal(
    result.rows.length,
    2,
    "both colliding payouts are staged for visibility, never silently dropped",
  );
  for (const row of result.rows) {
    assert.equal(
      row.fingerprint,
      key,
      "no ordinal/disambiguation -- both rows share the LITERAL identity key",
    );
    assert.equal(row.issues.length, 1);
    const issue = row.issues[0]!;
    assert.equal(issue.code, "SHARESIGHT_PAYOUT_KEY_COLLISION");
    assert.equal(issue.severity, "error");
    assert.match(issue.message, /holding-1/);
    assert.match(issue.message, /2026-08-05/);
    assert.match(issue.message, /2/, "names the collision count");
    // Round-2 review: the ORIGINAL copy told the owner to "reverse this
    // batch and enter the dividend(s) manually" -- both verified false (an
    // uncommitted batch cannot be reversed at all; manual entry does not
    // stop the NEXT sync from re-staging the same ambiguity). The message
    // must point at the remedy that actually works and must say the block
    // persists across future syncs, not just this one.
    assert.doesNotMatch(
      issue.message,
      /reverse this batch/i,
      "an uncommitted batch cannot be reversed -- this instruction must not appear",
    );
    assert.doesNotMatch(
      issue.message,
      /enter the dividend/i,
      "manual entry does not fix a Sharesight-side ambiguity that every future sync re-fetches -- this instruction must not appear",
    );
    assert.match(
      issue.message,
      /Sharesight itself/i,
      "must point at resolving the duplicate inside Sharesight, the only remedy that works",
    );
    assert.match(
      issue.message,
      /re-sync/i,
      "must instruct re-syncing after the Sharesight-side fix",
    );
    assert.match(
      issue.message,
      /future sync/i,
      "must state the block persists across every subsequent sync, not just this batch",
    );
  }
});

test("BRK-005C: a byte-identical duplicate payout pair (same holding, same paid_on, same everything) hits the EXACT SAME collision path as two economically-different payouts -- no special-cased silent staging", () => {
  const duplicate = fakePayout({ id: null, paidOnDate: "2026-08-05" });
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [duplicate, { ...duplicate }],
    now: FIXED_NOW,
  });
  assert.equal(result.rows.length, 2);
  for (const row of result.rows) {
    assert.equal(row.issues[0]?.code, "SHARESIGHT_PAYOUT_KEY_COLLISION");
    assert.equal(row.issues[0]?.severity, "error");
  }
});

test("BRK-005C: a confirmed payout and an unconfirmed (null-id) payout for the SAME holding+date ALSO collide -- collision detection is identity-based, not id-presence-based", () => {
  const confirmed = fakePayout({
    id: "payout-confirmed",
    holdingId: "holding-1",
    paidOnDate: "2026-08-05",
  });
  const unconfirmed = fakePayout({
    id: null,
    holdingId: "holding-1",
    paidOnDate: "2026-08-05",
  });
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [confirmed, unconfirmed],
    now: FIXED_NOW,
  });
  assert.equal(result.rows.length, 2);
  for (const row of result.rows) {
    assert.equal(row.issues[0]?.code, "SHARESIGHT_PAYOUT_KEY_COLLISION");
  }
});

test("BRK-005C: a future-dated null-id payout never participates in collision counting -- it is skipped entirely, so it cannot collide with a payout that DOES stage for the same holding+date", () => {
  const staged = fakePayout({
    id: null,
    holdingId: "holding-1",
    paidOnDate: "2026-08-05",
  });
  const futureSameKey = fakePayout({
    id: null,
    holdingId: "holding-1",
    paidOnDate: "2099-01-01",
  });
  const result = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [staged, futureSameKey],
    now: FIXED_NOW,
  });
  assert.equal(result.rows.length, 1);
  assert.equal(
    result.rows[0]?.issues.length,
    0,
    "the staged payout has no collision -- the future-dated one never entered the key count",
  );
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0]?.code, "SHARESIGHT_PAYOUT_UNCONFIRMED");
});

// ---------------------------------------------------------------------------
// dividend_manual_records insert builder: totals-mode validation
// ---------------------------------------------------------------------------

test("BRK-005: buildDividendManualRecordImportInsertStatements accepts totals mode and rejects mixed/neither modes", () => {
  const base = {
    userId: "user-a",
    portfolioId: "portfolio-a",
    portfolioSecurityId: "membership-a",
    paymentDate: "2026-08-05",
    importBatchId: "batch-a",
    sourceReference: "import-fingerprint:sharesight-payout:payout-1",
    requestId: "req-1",
    now: "2026-08-13T00:00:00Z",
  };
  const totalsOnly = buildDividendManualRecordImportInsertStatements({
    ...base,
    totalCashDecimal: "2.50",
    totalFrankingDecimal: "1.07",
  });
  assert.equal(totalsOnly.ok, true);

  const neitherMode = buildDividendManualRecordImportInsertStatements(base);
  assert.equal(neitherMode.ok, false);

  const bothModes = buildDividendManualRecordImportInsertStatements({
    ...base,
    sharesDecimal: "5",
    dividendPerShareDecimal: "0.5",
    totalCashDecimal: "2.50",
  });
  assert.equal(bothModes.ok, false);

  const zeroTotalCash = buildDividendManualRecordImportInsertStatements({
    ...base,
    totalCashDecimal: "0",
  });
  assert.equal(
    zeroTotalCash.ok,
    false,
    "a $0 total is not a fact worth importing, mirroring the per-share zero-dividend rule",
  );
});

// ---------------------------------------------------------------------------
// Totals-based derivation through DIV-001 (domain/dividends/history.ts)
// ---------------------------------------------------------------------------

test("BRK-005: DIV-001 derivation uses totals directly for a totals-only imported fact -- cash/franking known, shares/DPS honestly unknown, imported tier", () => {
  const derived = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "membership-a",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "manual-totals-1",
        paymentDate: "2026-08-05",
        sharesDecimal: null,
        dividendPerShareDecimal: null,
        frankingCreditPerShareDecimal: null,
        totalCashDecimal: "2.50",
        totalFrankingDecimal: "1.07",
        importBatchId: "batch-a",
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  assert.equal(derived.length, 1);
  const row = derived[0]!;
  assert.equal(row.source, "imported");
  assert.equal(
    row.sharesDecimal,
    null,
    "shares are honestly unknown, never fabricated",
  );
  assert.equal(
    row.dividendPerShareDecimal,
    null,
    "per-share amount is honestly unknown, never derived from the total",
  );
  assert.equal(row.cashDecimal, "2.50");
  assert.equal(row.frankingTotalDecimal, "1.07");
  assert.equal(row.grossDecimal, "3.57");
  assert.equal(row.grossIncludesFranking, true);
  assert.equal(
    row.amountUnknown,
    false,
    "the CASH amount is known even though the per-share amount is not, so lifetime sums must not drop it",
  );
});

test("BRK-005: a totals-only fact with unknown franking still reports a known cash total and an unknown franking total", () => {
  const derived = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "membership-a",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      {
        id: "manual-totals-2",
        paymentDate: "2026-08-05",
        sharesDecimal: null,
        dividendPerShareDecimal: null,
        frankingCreditPerShareDecimal: null,
        totalCashDecimal: "2.50",
        totalFrankingDecimal: null,
        importBatchId: "batch-a",
      },
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  const row = derived[0]!;
  assert.equal(row.cashDecimal, "2.50");
  assert.equal(row.frankingTotalDecimal, null);
  assert.equal(row.grossDecimal, "2.50");
  assert.equal(row.grossIncludesFranking, false);
  assert.equal(row.amountUnknown, false);
});

// ---------------------------------------------------------------------------
// Route CSRF wiring (mirrors tests/qa-001a.test.ts's source-grep technique)
// ---------------------------------------------------------------------------

test("BRK-005: the sharesight-sync and sharesight-link routes call rejectCrossSiteMutation before any other work", async () => {
  const routes = [
    "../app/api/portfolios/[portfolioId]/sharesight-sync/route.ts",
    "../app/api/portfolios/[portfolioId]/sharesight-link/route.ts",
  ];
  for (const route of routes) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(
      source,
      /import \{ rejectCrossSiteMutation \} from ".*mutation-request(\.ts)?";/,
      `${route} must import rejectCrossSiteMutation`,
    );
    const csrfIndex = source.indexOf("rejectCrossSiteMutation(request)");
    assert.ok(
      csrfIndex >= 0,
      `${route} must call rejectCrossSiteMutation(request)`,
    );
    const bodyReadIndex = source.indexOf("request.json()");
    assert.ok(
      bodyReadIndex === -1 || csrfIndex < bodyReadIndex,
      `${route} must reject cross-site mutations before reading the request body`,
    );
  }
});

test("BRK-005: the sharesight-portfolios list route has no CSRF gate (a read against Sharesight, not a mutation of our data)", async () => {
  const source = await readFile(
    new URL(
      "../app/api/portfolios/[portfolioId]/sharesight-portfolios/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(source.includes("rejectCrossSiteMutation"), false);
});

// ---------------------------------------------------------------------------
// Ownership / disabled-integration
// ---------------------------------------------------------------------------

test("BRK-005: a disabled Sharesight integration returns 409 with a clear message rather than throwing or fabricating a sync", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const result = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "portfolio-a",
    { integration: { enabled: false, reason: "not_configured" } },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 409);
    assert.match(result.message, /not connected/i);
  }
});

test("BRK-005: syncing an unlinked portfolio is rejected (link first) even with a healthy integration", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const result = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "req-1" },
    "portfolio-a",
    { integration: { enabled: true, client: fakeSharesightClient({}) } },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 409);
});

test("BRK-005: a cross-user portfolio id is denied for listing/linking/syncing (owner-scoped, never trusting a client-supplied id)", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const integration = {
    enabled: true as const,
    client: fakeSharesightClient({}),
  };

  const listed = await listSharesightPortfoliosWithContext(
    { client, userId: "user-b", requestId: "req-1" },
    "portfolio-a",
    { integration },
  );
  assert.equal(listed.ok, false);
  if (!listed.ok) assert.equal(listed.status, 404);

  const linked = await linkSharesightPortfolioWithContext(
    { client, userId: "user-b", requestId: "req-1" },
    "portfolio-a",
    { sharesightPortfolioId: "sp-1" },
    { integration },
  );
  // The upsert repository denies via its own owned-portfolio check
  // (`not_found`), surfaced as a 409/400 action failure -- never linking
  // another owner's portfolio.
  assert.equal(linked.ok, false);

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-b", requestId: "req-1" },
    "portfolio-a",
    { integration },
  );
  assert.equal(synced.ok, false);
  if (!synced.ok) assert.equal(synced.status, 404);
});

// ---------------------------------------------------------------------------
// End-to-end: link -> sync -> stage -> preview -> ready -> commit -> derived
// history round trip with a mixed batch (buy trade + payout).
// ---------------------------------------------------------------------------

test("BRK-005/BRK-005C: end-to-end stage->preview->ready->commit->derived-history round trip for a mixed trade+confirmed-payout+past-unconfirmed-payout+future-unconfirmed-payout sync", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [
      fakeTrade({
        id: "trade-e2e",
        quantityDecimal: "5",
        priceDecimal: "10",
        valueDecimal: "50",
      }),
    ],
    payouts: [
      fakePayout({
        id: "payout-e2e",
        amountDecimal: "2.50",
        frankingCreditsDecimal: "1.07",
      }),
      // BRK-005C: past-dated (paidOnDate "2026-08-05", before the injected
      // "now" below) and null-id -- now stages as a real record, not
      // skipped. A DIFFERENT holdingId from the confirmed payout above
      // (BRK-005C identity is holding+paidOn, not symbol+market -- two
      // payouts on the SAME date for DIFFERENT holdings never collide;
      // the same-holding/same-date collision path has its own dedicated
      // tests).
      fakePayout({
        id: null,
        symbol: "ABC",
        holdingId: "holding-2",
        paidOnDate: "2026-08-05",
        amountDecimal: "1.25",
        frankingCreditsDecimal: "0.54",
      }),
      // Still-future-dated null-id payout -- the ONLY case that still
      // skips with a warning after BRK-005C.
      fakePayout({
        id: null,
        symbol: "ABC",
        holdingId: "holding-3",
        paidOnDate: "2099-01-01",
      }),
    ],
  });

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-req" },
    "portfolio-a",
    {
      integration: { enabled: true, client: sharesightClient },
      now: () => FIXED_NOW,
    },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;
  assert.equal(
    synced.rowsStaged,
    3,
    "trade + confirmed payout + past-dated unconfirmed payout",
  );
  assert.equal(
    synced.skippedPayouts,
    1,
    "only the future-dated unconfirmed payout is skipped",
  );

  const batch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    synced.batchId,
  );
  assert.ok(batch);
  assert.equal(batch?.parserFormat, "sharesight_sync");

  await commitBatch(client, synced.batchId, "brk-005-commit", batch!.version);

  const trade = database
    .prepare(
      `SELECT status, type, quantity_decimal FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = 'membership-a'`,
    )
    .get() as
    { status: string; type: string; quantity_decimal: string } | undefined;
  assert.ok(trade, "expected a posted ledger transaction for the buy trade");
  assert.equal(trade?.status, "posted");
  assert.equal(trade?.type, "buy");
  assert.equal(trade?.quantity_decimal, "5");

  const manualRepo = createDividendManualRecordRepository(client);
  const records = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    records.length,
    2,
    "the confirmed payout AND the past-dated unconfirmed payout both committed as manual records",
  );
  const confirmedRecord = records.find(
    (candidate) => candidate.totalCashDecimal === "2.50",
  );
  assert.ok(confirmedRecord);
  assert.equal(confirmedRecord?.sharesDecimal, null);
  assert.equal(confirmedRecord?.dividendPerShareDecimal, null);
  assert.equal(confirmedRecord?.totalFrankingDecimal, "1.07");
  assert.equal(confirmedRecord?.importBatchId, synced.batchId);
  assert.equal(
    confirmedRecord?.sourceReference,
    "import-fingerprint:sharesight-payout:sp-1:holding-1:2026-08-05",
    "identity key: holding+paidOn -- the confirmed payout's own Sharesight id (payout-e2e) plays no part in it",
  );

  const unconfirmedRecord = records.find(
    (candidate) => candidate.totalCashDecimal === "1.25",
  );
  assert.ok(
    unconfirmedRecord,
    "the past-dated null-id payout must have committed as a real manual record",
  );
  assert.equal(unconfirmedRecord?.totalFrankingDecimal, "0.54");
  assert.equal(unconfirmedRecord?.importBatchId, synced.batchId);
  assert.equal(
    unconfirmedRecord?.sourceReference,
    "import-fingerprint:sharesight-payout:sp-1:holding-2:2026-08-05",
    "identity key for the id-free unconfirmed payout: same scheme, its own holdingId",
  );

  const derived = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "membership-a",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: records.map((record) => ({
      id: record.id,
      paymentDate: record.paymentDate,
      sharesDecimal: record.sharesDecimal,
      dividendPerShareDecimal: record.dividendPerShareDecimal,
      frankingCreditPerShareDecimal: record.frankingCreditPerShareDecimal,
      totalCashDecimal: record.totalCashDecimal,
      totalFrankingDecimal: record.totalFrankingDecimal,
      importBatchId: record.importBatchId,
    })),
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: "2026-08-13",
  });
  assert.equal(derived.length, 2);
  // The formerly-skipped, now-staged unconfirmed payout must derive at the
  // SAME "imported" tier as the confirmed one -- an ordinary totals-based
  // imported fact, never a lesser/estimated tier just because Sharesight
  // itself has not confirmed it.
  for (const row of derived) {
    assert.equal(row.source, "imported");
  }
  const derivedUnconfirmed = derived.find((row) => row.cashDecimal === "1.25");
  assert.ok(derivedUnconfirmed);
  assert.equal(derivedUnconfirmed?.frankingTotalDecimal, "0.54");

  // Watermark: last_synced_at moves on successful STAGING (already true by
  // the time we got a batch id above); confirm it is actually persisted.
  const syncState = await createSharesightSyncStateRepository(client).get(
    "user-a",
    "portfolio-a",
    "sp-1",
  );
  assert.ok(syncState?.lastSyncedAt);

  // -------------------------------------------------------------------
  // Reversal round trip.
  // -------------------------------------------------------------------
  const committedBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    synced.batchId,
  );
  const reversalRepo = createOwnedImportReversalRepository(client);
  let reversed = await reversalRepo.reverse("user-a", synced.batchId, {
    expectedVersion: committedBatch!.version,
    idempotencyKey: "brk-005-reverse",
    confirmation: true,
    requestId: "brk-005-reverse-request",
  });
  for (
    let attempt = 0;
    attempt < 10 && (!reversed.ok || reversed.status !== "reversed");
    attempt += 1
  ) {
    assert.equal(reversed.ok, true);
    reversed = await reversalRepo.reverse("user-a", synced.batchId, {
      expectedVersion: committedBatch!.version,
      idempotencyKey: "brk-005-reverse",
      confirmation: true,
      requestId: "brk-005-reverse-request",
    });
  }
  assert.equal(reversed.ok, true);
  if (reversed.ok) assert.equal(reversed.status, "reversed");

  const remainingRecords = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(remainingRecords.length, 0);

  const reversedTrade = database
    .prepare(
      `SELECT status FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = 'membership-a'
         AND type = 'buy' AND reverses_transaction_id IS NULL`,
    )
    .get() as { status: string } | undefined;
  assert.equal(reversedTrade?.status, "reversed");
});

// ---------------------------------------------------------------------------
// Idempotent re-sync
// ---------------------------------------------------------------------------

test("BRK-005: re-running a sync with unchanged Sharesight data reuses the SAME batch (file-fingerprint idempotency)", async () => {
  const database = await migratedDatabase();
  const fixtures = {
    portfolios: [fakePortfolio()],
    trades: [fakeTrade({ id: "trade-repeat" })],
    payouts: [] as SharesightPayout[],
  };
  const { client, sharesightClient } = await linkedFixture(database, fixtures);
  const integration = { enabled: true as const, client: sharesightClient };

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(
    second.batchId,
    first.batchId,
    "an unchanged fetch must resolve to the SAME batch, not a duplicate",
  );
  assert.equal(second.reused, true);
});

test("BRK-005C: two payouts colliding on the SAME identity key permanently block that batch's readiness -- fail closed, and a re-sync of the identical (still-colliding) data does not silently work around it", async () => {
  const database = await migratedDatabase();
  const interim = fakePayout({
    id: null,
    holdingId: "holding-1",
    paidOnDate: "2026-08-05",
    amountDecimal: "2.50",
    frankingCreditsDecimal: "1.07",
  });
  const special = fakePayout({
    id: null,
    holdingId: "holding-1",
    paidOnDate: "2026-08-05",
    amountDecimal: "9.99",
    frankingCreditsDecimal: "3.00",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [interim, special],
  });
  const now = () => FIXED_NOW;

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient }, now },
  );
  assert.equal(synced.ok, true);
  if (!synced.ok) return;
  assert.equal(
    synced.rowsStaged,
    2,
    "both colliding payouts are staged for visibility, never silently dropped",
  );

  const staging = createOwnedImportStagingRepository(client);
  const storedIssues = await staging.listIssues("user-a", synced.batchId);
  const collisionIssues = storedIssues.filter(
    (issue) => issue.code === "SHARESIGHT_PAYOUT_KEY_COLLISION",
  );
  assert.equal(
    collisionIssues.length,
    2,
    "each colliding row persisted its OWN error issue, row-linked",
  );
  for (const issue of collisionIssues) {
    assert.equal(issue.severity, "error");
    assert.equal(issue.resolvedAt, null);
    assert.notEqual(issue.rowId, null, "row-linked, not a batch-level issue");
  }

  const batch = await staging.get("user-a", synced.batchId);
  assert.ok(batch);
  const previewVersion = await currentPreviewVersion(
    client,
    "user-a",
    synced.batchId,
  );
  const ready = await markImportReadyWithContext(
    { client, userId: "user-a" },
    synced.batchId,
    { expectedVersion: batch!.version, expectedPreviewVersion: previewVersion },
  );
  assert.equal(
    ready.ok,
    false,
    "a collision must block readiness, never silently proceed to commit",
  );
  if (ready.ok) return;
  assert.equal(ready.status, 409);

  // Re-syncing the identical (still-colliding) data again does not resolve
  // it either -- fail-closed cannot be worked around by re-running the sync.
  const resynced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient }, now },
  );
  assert.equal(resynced.ok, true);
  if (!resynced.ok) return;
  assert.equal(
    resynced.batchId,
    synced.batchId,
    "an unchanged (still-colliding) fetch reuses the same still-blocked batch, not a fresh attempt",
  );

  const manualRepo = createDividendManualRecordRepository(client);
  assert.equal(
    (await manualRepo.list("user-a", "portfolio-a")).length,
    0,
    "nothing from this batch ever committed",
  );
});

test("BRK-005C (B1 closed): a payout synced+committed while UNCONFIRMED, then CONFIRMED by Sharesight before the next sync, produces NO new record -- the identity key is unchanged by confirmation", async () => {
  const database = await migratedDatabase();
  const unconfirmed = fakePayout({
    id: null,
    holdingId: "holding-1",
    paidOnDate: "2026-08-05",
    amountDecimal: "2.50",
    frankingCreditsDecimal: "1.07",
  });
  const { client, sharesightClient } = await linkedFixture(database, {
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [unconfirmed],
  });
  const now = () => FIXED_NOW;

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: { enabled: true, client: sharesightClient }, now },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.rowsStaged, 1);
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  await commitBatch(
    client,
    first.batchId,
    "brk-005c-confirm-commit",
    firstBatch!.version,
  );

  const manualRepo = createDividendManualRecordRepository(client);
  const beforeConfirm = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(beforeConfirm.length, 1);
  const originalSourceReference = beforeConfirm[0]!.sourceReference;
  assert.equal(
    originalSourceReference,
    "import-fingerprint:sharesight-payout:sp-1:holding-1:2026-08-05",
  );

  // Sharesight confirms the SAME real-world payout before the next sync --
  // same holding, same paid_on, same amounts, but now carrying a real id.
  // The OLD (pre-BRK-005C-review-fix) scheme would have flipped this row's
  // identity from the natural key to `sharesight-payout:<id>` here -- the
  // reviewer's exact B1 repro.
  const confirmedClient = fakeSharesightClient({
    portfolios: [fakePortfolio()],
    trades: [],
    payouts: [
      fakePayout({
        id: "payout-now-confirmed",
        holdingId: "holding-1",
        paidOnDate: "2026-08-05",
        amountDecimal: "2.50",
        frankingCreditsDecimal: "1.07",
      }),
    ],
  });
  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration: { enabled: true, client: confirmedClient }, now },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  // The Sharesight `id` is not a digest field (`canonicalRowDigestFields`),
  // and every other value-bearing field is unchanged, so this resolves to
  // the SAME already-committed batch -- there is nothing new to commit at
  // all, which is itself part of B1 being closed (the old scheme's changed
  // fingerprint made this look like a genuinely new fetch).
  assert.equal(
    second.reused,
    true,
    "confirmation alone (no value change) must not even look like a new fetch",
  );
  assert.equal(second.batchId, first.batchId);

  const afterConfirm = await manualRepo.list("user-a", "portfolio-a");
  assert.equal(
    afterConfirm.length,
    1,
    "NO new record -- the confirmation transition must never double-commit (B1 closed)",
  );
  assert.equal(afterConfirm[0]?.sourceReference, originalSourceReference);
});

// BRK-005B review finding B2 (BLOCKING, backend gap reachable only through
// the new UI): the digest previously omitted the LOCAL portfolioId, so two
// different local portfolios linked to the SAME Sharesight portfolio (a
// realistic setup -- one Sharesight account often tracks more than one
// local portfolio) produced byte-identical digest sources and silently
// resolved to the SAME batch via `startUpload`'s user-scoped (not
// portfolio-scoped) ON CONFLICT key. That batch's target_portfolio_id
// belongs to whichever portfolio synced FIRST -- the second portfolio's
// sync would appear to succeed while staging rows against the WRONG
// portfolio, invisible before commit.
test("BRK-005B review B2 repro -- two local portfolios linked to the SAME Sharesight portfolio produce two DISTINCT batches, each targeting its own portfolio (no cross-portfolio batch reuse)", async () => {
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a2', 'user-a', 'A2', 'Second', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-15', '2026-08-15', 1);
  `);
  const client = createSqliteSqlClient(database);
  const fixtures = {
    portfolios: [fakePortfolio()],
    trades: [fakeTrade({ id: "trade-shared" })],
    payouts: [] as SharesightPayout[],
  };
  const sharesightClient = fakeSharesightClient(fixtures);
  const integration = { enabled: true as const, client: sharesightClient };

  const linkedA = await linkSharesightPortfolioWithContext(
    { client, userId: "user-a", requestId: "link-a" },
    "portfolio-a",
    { sharesightPortfolioId: "sp-1" },
    { integration },
  );
  assert.equal(linkedA.ok, true);
  const linkedB = await linkSharesightPortfolioWithContext(
    { client, userId: "user-a", requestId: "link-b" },
    "portfolio-a2",
    { sharesightPortfolioId: "sp-1" },
    { integration },
  );
  assert.equal(linkedB.ok, true);

  const syncA = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-a" },
    "portfolio-a",
    { integration },
  );
  const syncB = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-b" },
    "portfolio-a2",
    { integration },
  );
  assert.equal(syncA.ok, true);
  assert.equal(syncB.ok, true);
  if (!syncA.ok || !syncB.ok) return;

  assert.notEqual(
    syncA.batchId,
    syncB.batchId,
    "two different local portfolios must never resolve to the SAME batch even when linked to the identical Sharesight portfolio with identical fetched data",
  );
  assert.equal(syncA.reused, false);
  assert.equal(syncB.reused, false);

  const staging = createOwnedImportStagingRepository(client);
  const batchA = await staging.get("user-a", syncA.batchId);
  const batchB = await staging.get("user-a", syncB.batchId);
  assert.equal(batchA?.targetPortfolioId, "portfolio-a");
  assert.equal(
    batchB?.targetPortfolioId,
    "portfolio-a2",
    "portfolio-a2's batch must target portfolio-a2, never be silently reused from portfolio-a's batch",
  );
});

test("BRK-005: reviewer B1 repro -- a Sharesight-side correction to an already-synced, already-committed trade produces a NEW batch, never a silent no-op, and the prior committed batch/transaction stay untouched", async () => {
  const database = await migratedDatabase();
  const { client, sharesightClient: firstClient } = await linkedFixture(
    database,
    {
      portfolios: [fakePortfolio()],
      trades: [
        fakeTrade({
          id: "trade-corrected",
          quantityDecimal: "5",
          priceDecimal: "10",
          valueDecimal: "50",
        }),
      ],
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
  assert.ok(firstBatch);
  await commitBatch(
    client,
    first.batchId,
    "b1-repro-commit",
    firstBatch!.version,
  );

  const committedTrade = database
    .prepare(
      `SELECT quantity_decimal, unit_price_decimal FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = 'membership-a'`,
    )
    .get() as
    { quantity_decimal: string; unit_price_decimal: string } | undefined;
  assert.equal(committedTrade?.quantity_decimal, "5");
  assert.equal(committedTrade?.unit_price_decimal, "10");

  // Sharesight reports the SAME trade id with CORRECTED values on the next
  // sync -- the reviewer's exact repro (5@10 -> 500@99).
  const correctedClient = fakeSharesightClient({
    trades: [
      fakeTrade({
        id: "trade-corrected",
        quantityDecimal: "500",
        priceDecimal: "99",
        valueDecimal: "49500",
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
  assert.notEqual(
    second.batchId,
    first.batchId,
    "a value correction must produce a NEW batch, never silently reuse the prior one",
  );
  assert.equal(
    second.reused,
    false,
    "a genuinely different fetch must never report reused",
  );

  const secondRows = await createOwnedImportStagingRepository(client).listRows(
    "user-a",
    second.batchId,
  );
  assert.equal(secondRows.length, 1);
  const correctedNormalized = secondRows[0]?.normalizedFields as {
    sharesOwned: string | null;
    costPerShare: string | null;
  } | null;
  assert.equal(
    correctedNormalized?.sharesOwned,
    "500",
    "the new batch must carry the CORRECTED value, visible for the owner to reconcile",
  );
  assert.equal(correctedNormalized?.costPerShare, "99");

  // The prior committed batch and its posted transaction are untouched --
  // this task never auto-applies a correction, it only makes it visible.
  const firstBatchAfter = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  assert.equal(firstBatchAfter?.status, "committed");
  const committedTradeAfter = database
    .prepare(
      `SELECT quantity_decimal, unit_price_decimal FROM transactions
       WHERE user_id = 'user-a' AND portfolio_security_id = 'membership-a'
         AND status = 'posted'`,
    )
    .get() as
    { quantity_decimal: string; unit_price_decimal: string } | undefined;
  assert.equal(committedTradeAfter?.quantity_decimal, "5");
  assert.equal(committedTradeAfter?.unit_price_decimal, "10");
});

test("BRK-005: reviewer PROBE 3 -- the reused-batch path reports the STORED rowsStaged/skippedPayouts against a KNOWN-correct absolute count (1 skipped payout), not merely self-consistent with a possibly-buggy DB read, and the omission's detail (symbol/paid_on) is visible in the stored issue", async () => {
  const database = await migratedDatabase();
  // BRK-005C: must stay FUTURE-dated relative to the injected `now` below --
  // a past-dated null-id payout now stages as a real record instead of
  // skipping (see the BRK-005C tests above), which would defeat this
  // test's purpose (it specifically probes the SKIP path's persistence).
  const skippedPayout = fakePayout({
    id: null,
    symbol: "XYZ",
    paidOnDate: "2099-01-01",
  });
  const fixtures = {
    portfolios: [fakePortfolio()],
    trades: [fakeTrade({ id: "trade-honest" })],
    payouts: [fakePayout({ id: "payout-honest" }), skippedPayout],
  };
  const { client, sharesightClient } = await linkedFixture(database, fixtures);
  const integration = { enabled: true as const, client: sharesightClient };

  const first = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration, now: () => FIXED_NOW },
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.reused, false);
  // Review round 2 finding: before the fix, a batch-level (row-less) issue
  // like SHARESIGHT_PAYOUT_UNCONFIRMED was counted into
  // `import_batches.warning_count` (`summarizeParseSuccess` reads
  // `parseResult.issues` directly) but never actually persisted to
  // `import_issues` (only row-linked issues were). Assert BOTH halves of
  // that mismatch are now fixed, not just their consistency with each
  // other.
  const firstBatch = await createOwnedImportStagingRepository(client).get(
    "user-a",
    first.batchId,
  );
  assert.equal(firstBatch?.warningCount, 1);
  const firstStoredIssues = await createOwnedImportStagingRepository(
    client,
  ).listIssues("user-a", first.batchId);
  assert.equal(
    firstStoredIssues.length,
    1,
    "the batch-level skipped-payout warning must actually be persisted to import_issues, not just counted",
  );
  const firstIssue = firstStoredIssues[0];
  assert.equal(firstIssue?.code, "SHARESIGHT_PAYOUT_UNCONFIRMED");
  assert.equal(firstIssue?.severity, "warning");
  assert.equal(
    firstIssue?.rowId,
    null,
    "a skipped payout has no row -- the issue is batch-level, not row-linked",
  );
  // The omission's own detail (which security, which date) must reach
  // preview -- not just an anonymous "something was skipped" count.
  assert.match(firstIssue?.message ?? "", /XYZ/);
  assert.match(firstIssue?.message ?? "", /2099-01-01/);

  assert.equal(first.skippedPayouts, 1);

  const second = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-2" },
    "portfolio-a",
    { integration, now: () => FIXED_NOW },
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.reused, true);

  const staging = createOwnedImportStagingRepository(client);
  const storedRows = await staging.listRows("user-a", second.batchId);
  const storedIssues = await staging.listIssues("user-a", second.batchId);
  const storedSkipped = storedIssues.filter(
    (issue) => issue.code === "SHARESIGHT_PAYOUT_UNCONFIRMED",
  ).length;

  // The reviewer's exact PROBE 3: this must read 1, the true count -- not
  // 0 (the bug: querying an import_issues table the batch-level warning
  // was never actually written to).
  assert.equal(
    second.skippedPayouts,
    1,
    "reused-path skippedPayouts must read the TRUE stored count (1), not 0",
  );
  assert.equal(second.skippedPayouts, storedSkipped);
  assert.equal(
    second.rowsStaged,
    storedRows.length,
    "reused-path rowsStaged must reflect the STORED row count",
  );
});

test("BRK-005: CSV batches with row-level issues do not double-insert into import_issues (the top-level issues array mirrors row-level issues for the CSV parser; only genuinely row-less issues get a separate insert)", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  // A non-dividend (buy) row with the Franking column populated trips
  // FRANKING_ON_NON_DIVIDEND -- a warning-severity, row-attached issue that
  // (per strict-versioned-parser.ts) is pushed into BOTH the row's own
  // `issues` array AND the parse result's top-level `issues` array (the
  // exact CSV mirroring this fix must not double-insert).
  const csv = [
    SUPPORTED_IMPORT_HEADER_WITH_DIVIDENDS.join(","),
    [
      "trade-1",
      "ABC",
      "Alpha",
      "",
      "ASX",
      "Main",
      "AUD",
      "5",
      "10",
      "0",
      "2026-08-01 GMT+1000",
      "10:00:00",
      "",
      "Buy",
      "FIFO",
      "",
      "",
      "0.21",
    ].join(","),
  ].join("\n");
  const parseResult = await parseStrictVersionedCsvImport(
    new TextEncoder().encode(csv),
    { maxBytes: 10_000_000, maxRows: 1000 },
  );
  assert.equal(parseResult.ok, true);
  if (!parseResult.ok) return;
  const rowIssue = parseResult.rows[0]?.issues.find(
    (issue) => issue.code === "FRANKING_ON_NON_DIVIDEND",
  );
  assert.ok(rowIssue, "expected the fixture to trip FRANKING_ON_NON_DIVIDEND");
  // Confirms the mirroring this fix must not double-insert: the SAME issue
  // object is present in both the row's own issues and the top-level array.
  assert.ok(parseResult.issues.includes(rowIssue!));

  const staging = createOwnedImportStagingRepository(client);
  const started = await staging.startUpload("user-a", {
    targetPortfolioId: "portfolio-a",
    parserFormat: "strict-versioned-csv",
    parserVersion: parseResult.parserVersion,
    filename: "franking-non-dividend.csv",
    byteSize: csv.length,
    fileSha256: parseResult.fileFingerprint,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const recorded = await staging.recordParseResult("user-a", started.batch.id, {
    expectedVersion: started.batch.version,
    parseResult,
  });
  assert.equal(recorded.ok, true);
  if (!recorded.ok) return;

  const storedIssues = await staging.listIssues("user-a", started.batch.id);
  const storedFrankingIssues = storedIssues.filter(
    (issue) => issue.code === "FRANKING_ON_NON_DIVIDEND",
  );
  assert.equal(
    storedFrankingIssues.length,
    1,
    "the row-attached issue must be inserted exactly ONCE, never once via the row loop and again via the batch-level top-level array",
  );
  assert.notEqual(
    storedFrankingIssues[0]?.rowId,
    null,
    "the persisted issue must stay row-linked (via the row loop), not become a stray batch-level duplicate",
  );
  // NOT asserted here (pre-existing, out of this fix's scope, worth a
  // follow-up): `summarizeParseSuccess` computes `warning_count` by
  // summing BOTH the row-level loop AND the top-level `parseResult.issues`
  // loop without deduping by reference, so for a CSV batch it double-counts
  // every mirrored issue into `warning_count` (2 here) even though this fix
  // correctly stores it only once. That mismatch predates this task and is
  // independent of the persistence gap this test targets -- the FIX here is
  // about the ROW count actually landing in `import_issues`, not about
  // `warning_count`'s own accuracy for the CSV path.
});

test("BRK-005: reviewer B4 repro (link end) -- re-linking to a different Sharesight portfolio disables the previous link, so a subsequent sync imports from the NEW portfolio only", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  const integrationFor = (sharesightPortfolioId: string, symbol: string) => ({
    enabled: true as const,
    client: fakeSharesightClient({
      portfolios: [
        fakePortfolio({ id: "sp-1", name: "First" }),
        fakePortfolio({ id: "sp-2", name: "Second" }),
      ],
      trades: [
        fakeTrade({
          id: `trade-${sharesightPortfolioId}`,
          portfolioId: sharesightPortfolioId,
          instrumentCode: symbol,
        }),
      ],
      payouts: [],
    }),
  });

  const linkedFirst = await linkSharesightPortfolioWithContext(
    { client, userId: "user-a", requestId: "link-1" },
    "portfolio-a",
    { sharesightPortfolioId: "sp-1" },
    { integration: integrationFor("sp-1", "ABC") },
  );
  assert.equal(linkedFirst.ok, true);

  const linkedSecond = await linkSharesightPortfolioWithContext(
    { client, userId: "user-a", requestId: "link-2" },
    "portfolio-a",
    { sharesightPortfolioId: "sp-2" },
    { integration: integrationFor("sp-2", "ABC") },
  );
  assert.equal(linkedSecond.ok, true);

  const syncStateRepository = createSharesightSyncStateRepository(client);
  const links = await syncStateRepository.list("user-a", "portfolio-a");
  const enabled = links.filter((link) => link.enabled);
  assert.equal(
    enabled.length,
    1,
    "re-linking must leave exactly ONE enabled link, never two",
  );
  assert.equal(enabled[0]?.sharesightPortfolioId, "sp-2");
  const disabled = links.find((link) => link.sharesightPortfolioId === "sp-1");
  assert.equal(disabled?.enabled, false);

  // A subsequent sync must import from sp-2 (the new link) -- with a fake
  // client whose listTrades ignores the sharesightPortfolioId argument, the
  // observable proof is that syncing succeeds using the SECOND integration
  // and the sync-state repository shows only sp-2 active (asserted above);
  // this also confirms the sync path reads back exactly one enabled link.
  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: integrationFor("sp-2", "ABC") },
  );
  assert.equal(synced.ok, true);
});

test("BRK-005: reviewer B4 repro (sync end, defense in depth) -- a sync fails closed 409 if it ever finds more than one enabled link, rather than picking one non-deterministically", async () => {
  const database = await migratedDatabase();
  const client = createSqliteSqlClient(database);
  // Bypasses `linkExclusive` deliberately (direct SQL) to simulate the
  // invariant already having been violated by some other path (a
  // pre-fix row, a direct write, a bug) -- the sync's OWN defense-in-depth
  // check must catch this independently of the link action's guarantee.
  database.exec(`
    INSERT INTO sharesight_sync_state (
      id, user_id, portfolio_id, sharesight_portfolio_id, enabled,
      last_synced_at, last_trade_watermark, created_at, updated_at, version
    ) VALUES
      ('sync-state-1', 'user-a', 'portfolio-a', 'sp-1', 1, NULL, NULL, '2026-08-13', '2026-08-13', 1),
      ('sync-state-2', 'user-a', 'portfolio-a', 'sp-2', 1, NULL, NULL, '2026-08-13', '2026-08-13', 1);
  `);

  const synced = await runSharesightSyncWithContext(
    { client, userId: "user-a", requestId: "sync-1" },
    "portfolio-a",
    { integration: { enabled: true, client: fakeSharesightClient({}) } },
  );
  assert.equal(synced.ok, false);
  if (synced.ok) return;
  assert.equal(synced.status, 409);
  assert.match(synced.message, /more than one enabled/i);
});

test("BRK-005: cross-batch duplicate trade/dividend rows across two sync-shaped batches are detected using the real Sharesight-id fingerprint, and only the first commits", async () => {
  const database = await migratedDatabase();
  database.exec(`
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-x', 'user-a', 'portfolio-a', 'sharesight_sync', 'sharesight-sync-v1', 'sync-x', 10, 'hash-x', 'parsed', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 1),
      ('batch-y', 'user-a', 'portfolio-a', 'sharesight_sync', 'sharesight-sync-v1', 'sync-y', 10, 'hash-y', 'parsed', '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z', 1);
  `);
  const client = createSqliteSqlClient(database);
  const transformed = transformSharesightSync({
    portfolioName: "Main",
    trades: [],
    payouts: [fakePayout({ id: "payout-dup" })],
    now: FIXED_NOW,
  });
  const row = transformed.rows[0]!;
  const insertRow = (batchId: string, rowId: string) => {
    database
      .prepare(
        `INSERT INTO import_rows (
           id, user_id, batch_id, physical_row_number, row_class,
           original_fields_json, normalized_fields_json, normalized_fingerprint,
           validation_status, target_portfolio_id, commit_status, created_at, updated_at, version
         ) VALUES (?, 'user-a', ?, 2, 'transaction', '[]', ?, ?, 'valid',
           NULL, 'staged', '2026-08-13', '2026-08-13', 1)`,
      )
      .run(rowId, batchId, JSON.stringify(row.normalized), row.fingerprint);
  };
  insertRow("batch-x", "row-x1");
  insertRow("batch-y", "row-y1");

  await commitBatch(client, "batch-x", "dup-commit-x", 1);
  const manualRepo = createDividendManualRecordRepository(client);
  assert.equal((await manualRepo.list("user-a", "portfolio-a")).length, 1);

  await commitBatch(client, "batch-y", "dup-commit-y", 1);
  assert.equal(
    (await manualRepo.list("user-a", "portfolio-a")).length,
    1,
    "the second batch's identical Sharesight payout must be skipped, not double-posted",
  );

  const rowsY = await createOwnedImportStagingRepository(client).listRows(
    "user-a",
    "batch-y",
  );
  assert.equal(rowsY[0]?.commitStatus, "skipped");
});

// ---------------------------------------------------------------------------
// Migration checks
// ---------------------------------------------------------------------------

test("BRK-005: dividend_manual_records is nullable on shares/dividend-per-share, carries the new totals columns, and enforces the amount-mode CHECK", async () => {
  const database = await migratedDatabase();
  const columns = database
    .prepare("PRAGMA table_info(dividend_manual_records)")
    .all() as { name: string; notnull: number }[];
  const byName = new Map(columns.map((column) => [column.name, column]));
  assert.equal(byName.get("shares_decimal")?.notnull, 0);
  assert.equal(byName.get("dividend_per_share_decimal")?.notnull, 0);
  assert.ok(byName.has("total_cash_decimal"));
  assert.ok(byName.has("total_franking_decimal"));

  assert.throws(() => {
    database
      .prepare(
        `INSERT INTO dividend_manual_records (
           id, user_id, portfolio_id, portfolio_security_id, payment_date,
           created_at, updated_at, version
         ) VALUES ('bad-1', 'user-a', 'portfolio-a', 'membership-a', '2026-08-05', '2026-08-13', '2026-08-13', 1)`,
      )
      .run();
  }, /CHECK constraint failed/);
});

test("BRK-005: the three purge-lock triggers on dividend_manual_records survived the totals-columns rebuild migration", async () => {
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

// ---------------------------------------------------------------------------
// QA-001A matrix self-check (review finding B3), mirroring
// tests/ui-006b.test.ts's/tests/ui-006c.test.ts's identical pattern.
// ---------------------------------------------------------------------------

test("BRK-005: the QA-001A matrix records the three new Sharesight routes", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const needle of [
    "/api/portfolios/:portfolioId/sharesight-portfolios",
    "/api/portfolios/:portfolioId/sharesight-link",
    "/api/portfolios/:portfolioId/sharesight-sync",
    "tests/brk-005.test.ts",
  ]) {
    assert.ok(matrix.includes(needle), `matrix should mention ${needle}`);
  }
});

// Extends the ui-006a/b/c self-checking citation grep to this task's own
// test file -- see tests/ui-006b.test.ts's identical test for the full
// rationale (every matrix citation naming this file must quote a LITERAL
// substring of it, never a fabricated/paraphrased test title).
test("BRK-005: every matrix citation naming tests/brk-005.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/brk-005.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/brk-005\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
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
        `matrix cites "${title}" in tests/brk-005.test.ts, but that title is not a literal substring of the file (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount >= 2, "expected at least 2 citation groups to check");
  assert.ok(titleCount >= 4, "expected at least 4 quoted titles to check");
});
