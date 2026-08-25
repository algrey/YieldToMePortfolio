/**
 * HIST-002 -- Historical-valuation CPU (Layer 1: memoized timezone
 * formatting + hoisted shares-held-at-date walk) and the persisted
 * incremental value-history series (Layer 2: `portfolio_value_history`,
 * bounded backfill-on-read, import invalidation).
 *
 * See TASKS.md's HIST-002 entry, `docs/ARCHITECTURE.md`'s HIST-002 note,
 * and `app/historical-portfolio-value.ts`'s header comment for the full
 * design record. `tests/hist-001.test.ts`'s B1 pin covers the
 * backfill-to-completion drill (successive bounded reads over a large
 * fixture) -- this file focuses on what that one doesn't: Layer 1 parity,
 * import invalidation, stored-vs-derived parity, and write-count honesty.
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
  loadHistoricalPortfolioValueSeries,
  invalidateStoredValueHistoryForSecurity,
} from "../app/historical-portfolio-value.ts";
import {
  loadStoredValueHistory,
  upsertStoredValueHistory,
} from "../db/repositories/portfolio-value-history.ts";
import {
  createOwnedLedgerRepository,
  type LedgerMutationResult,
} from "../db/repositories/ledger.ts";
import type { LedgerPostingInput } from "../domain/ledger/posting.ts";
import {
  createOwnedImportCommitRepository,
  type ImportCommitInput,
} from "../db/repositories/import-commit.ts";
import { SUPPORTED_IMPORT_PARSER_VERSION } from "../domain/imports/index.ts";
import {
  computeHistoricalPortfolioValueSeries,
  type HistoricalValueSecurityFact,
} from "../domain/snapshots/historical-portfolio-value.ts";
import {
  buildSharesHeldTimeline,
  deriveSharesHeldAtDate,
  sharesHeldAtDateFromTimeline,
  type LedgerQuantityFact,
} from "../domain/dividends/shares-held.ts";
import { selectPriceObservation } from "../domain/market-data/selection.ts";
import type { PriceObservation } from "../domain/market-data/contracts.ts";
import { parsePriceCsv } from "../domain/market-data/price-csv.ts";
import { confirmSinglePriceUpload } from "../app/price-upload-service.ts";
import type { PriceUploadContext } from "../app/price-upload-service.ts";

// ---------------------------------------------------------------------------
// Layer 1a: `domain/market-data/selection.ts` -- Intl.DateTimeFormat
// memoized per timezone.
// ---------------------------------------------------------------------------

function priceObservation(
  marketDate: string,
  closeDecimal: string,
): PriceObservation {
  return {
    kind: "price",
    providerId: "owner-import",
    providerRevisionId: null,
    mappingId: "mapping",
    securityId: "sec",
    scope: { kind: "user", userId: "a" },
    interval: "eod",
    observationAt: `${marketDate}T04:00:00.000Z`,
    marketDate,
    marketTimezone: "Australia/Sydney",
    currencyCode: "AUD",
    closeDecimal,
    previousCloseDecimal: null,
    adjustmentState: "raw",
    adjustmentFactor: null,
    quality: "observed",
    delayedMinutes: null,
    ingestedAt: "2026-08-24T00:00:00Z",
    payloadSha256: null,
  };
}

test("HIST-002 Layer 1a: repeated portfolio-timezone cutoff checks reuse ONE Intl.DateTimeFormat per timezone (construction count pinned, not just behaviour)", () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  let constructions = 0;
  class CountingDateTimeFormat extends OriginalDateTimeFormat {
    constructor(...args: ConstructorParameters<typeof OriginalDateTimeFormat>) {
      super(...args);
      constructions += 1;
    }
  }
  // @ts-expect-error -- test-only global monkeypatch, restored below.
  Intl.DateTimeFormat = CountingDateTimeFormat;
  try {
    const observations = Array.from({ length: 50 }, (_, index) =>
      priceObservation(
        `2020-01-${String((index % 28) + 1).padStart(2, "0")}`,
        "1.00",
      ),
    );
    for (let i = 0; i < 50; i += 1) {
      selectPriceObservation({
        asOf: "2020-01-28",
        portfolioTimezone: "Australia/Sydney",
        targetKey: "t",
        observations,
        maxPriorCalendarDays: 5,
      });
    }
  } finally {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  }
  // 50 calls x up to 50 observations each = up to 2,500 cutoff checks; the
  // memoized formatter should construct ONCE for the single timezone used
  // (a fresh module-level cache per test run/import), not once per check.
  assert.ok(
    constructions <= 2,
    `expected at most 2 Intl.DateTimeFormat constructions for one shared timezone, got ${constructions}`,
  );
});

// ---------------------------------------------------------------------------
// Layer 1b: `domain/dividends/shares-held.ts` -- `buildSharesHeldTimeline`/
// `sharesHeldAtDateFromTimeline` parity with `deriveSharesHeldAtDate`.
// ---------------------------------------------------------------------------

function tx(
  overrides: Partial<LedgerQuantityFact> & { id: string },
): LedgerQuantityFact {
  return {
    type: "buy",
    status: "posted",
    localTradeDate: "2020-01-01",
    tradeAt: "2020-01-01T00:00:00Z",
    quantityDecimal: "100",
    unitPriceDecimal: null,
    reversesTransactionId: null,
    ...overrides,
  };
}

test("HIST-002 Layer 1b parity: buildSharesHeldTimeline + sharesHeldAtDateFromTimeline match deriveSharesHeldAtDate for EVERY query date, over buys/sells/a split/a reversed pair", () => {
  const transactions: LedgerQuantityFact[] = [
    tx({
      id: "buy1",
      type: "buy",
      localTradeDate: "2020-01-10",
      tradeAt: "2020-01-10T00:00:00Z",
      quantityDecimal: "100",
    }),
    tx({
      id: "buy2",
      type: "buy",
      localTradeDate: "2020-02-10",
      tradeAt: "2020-02-10T00:00:00Z",
      quantityDecimal: "50",
    }),
    // 2:1 split on 2020-03-01 -- doubles the running total as of that date.
    tx({
      id: "split1",
      type: "split",
      localTradeDate: "2020-03-01",
      tradeAt: "2020-03-01T00:00:00Z",
      quantityDecimal: "2",
      unitPriceDecimal: "1",
    }),
    tx({
      id: "sell1",
      type: "sell",
      localTradeDate: "2020-04-01",
      tradeAt: "2020-04-01T00:00:00Z",
      quantityDecimal: "75",
    }),
    // A reversed original + its reversal record: net zero effect, always.
    tx({
      id: "buy3",
      type: "buy",
      status: "reversed",
      localTradeDate: "2020-05-01",
      tradeAt: "2020-05-01T00:00:00Z",
      quantityDecimal: "999",
    }),
    tx({
      id: "rev3",
      type: "buy",
      localTradeDate: "2020-05-01",
      tradeAt: "2020-05-01T00:01:00Z",
      quantityDecimal: "-999",
      reversesTransactionId: "buy3",
    }),
    tx({
      id: "buy4",
      type: "buy",
      localTradeDate: "2020-06-15",
      tradeAt: "2020-06-15T00:00:00Z",
      quantityDecimal: "10",
    }),
  ];
  const timeline = buildSharesHeldTimeline(transactions);
  assert.notEqual(timeline.checkpoints, null); // this fixture IS tradeAt/localTradeDate-consistent

  const queryDates = [
    "2019-12-31", // before anything
    "2020-01-10", // exact buy1 date
    "2020-01-15",
    "2020-02-10",
    "2020-02-15",
    "2020-03-01", // exact split date
    "2020-03-02",
    "2020-04-01", // exact sell date
    "2020-04-15",
    "2020-05-01", // reversed pair's date
    "2020-06-15",
    "2020-12-31", // after everything
  ];
  for (const date of queryDates) {
    assert.equal(
      sharesHeldAtDateFromTimeline(timeline, date),
      deriveSharesHeldAtDate(transactions, date),
      `mismatch at ${date}`,
    );
  }
  // Concrete sanity values (not just self-consistency): (100+50)*2 - 75 = 225.
  assert.equal(sharesHeldAtDateFromTimeline(timeline, "2020-04-01"), "225");
  assert.equal(sharesHeldAtDateFromTimeline(timeline, "2020-06-15"), "235");
});

test("HIST-002 Layer 1b non-monotonic fallback: when localTradeDate disagrees with tradeAt order, buildSharesHeldTimeline reports checkpoints=null and sharesHeldAtDateFromTimeline STILL matches deriveSharesHeldAtDate exactly (never a wrong fast-path answer)", () => {
  const transactions: LedgerQuantityFact[] = [
    // tradeAt ascending: t1 then t2. localTradeDate DESCENDING: t1 is the
    // LATER business date -- a pathological (but not schema-forbidden)
    // mismatch between the two independently-supplied fields.
    tx({
      id: "t1",
      localTradeDate: "2020-06-01",
      tradeAt: "2020-01-01T00:00:00Z",
      quantityDecimal: "100",
    }),
    tx({
      id: "t2",
      localTradeDate: "2020-01-01",
      tradeAt: "2020-02-01T00:00:00Z",
      quantityDecimal: "30",
    }),
  ];
  const timeline = buildSharesHeldTimeline(transactions);
  assert.equal(timeline.checkpoints, null);
  for (const date of [
    "2019-12-31",
    "2020-01-01",
    "2020-03-01",
    "2020-06-01",
    "2020-12-31",
  ]) {
    assert.equal(
      sharesHeldAtDateFromTimeline(timeline, date),
      deriveSharesHeldAtDate(transactions, date),
      `mismatch at ${date}`,
    );
  }
});

test('HIST-002 Layer 1b: an empty transaction list produces a usable (non-null) empty timeline reading "0" everywhere, matching deriveSharesHeldAtDate', () => {
  const timeline = buildSharesHeldTimeline([]);
  assert.notEqual(timeline.checkpoints, null);
  assert.equal(sharesHeldAtDateFromTimeline(timeline, "2020-01-01"), "0");
  assert.equal(deriveSharesHeldAtDate([], "2020-01-01"), "0");
});

// ---------------------------------------------------------------------------
// Layer 2: DB-backed `portfolio_value_history` -- backfill write counts,
// incremental append, import invalidation, stored-vs-derived parity.
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

// Review follow-up (6): purge-lock trigger tests for `portfolio_value_history`,
// per the `income_whatif_scenarios`/DIV-014 precedent
// (tests/div-014.test.ts's two identically-shaped tests).

test("HIST-002 migration: portfolio_value_history has its three purge-lock triggers", async () => {
  const db = await migratedDatabase();
  const triggers = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'portfolio_value_history' ORDER BY name",
    )
    .all() as { name: string }[];
  assert.deepEqual(
    triggers.map((row) => row.name),
    [
      "account_purge_lock_portfolio_value_history_delete",
      "account_purge_lock_portfolio_value_history_insert",
      "account_purge_lock_portfolio_value_history_update",
    ],
  );
  db.close();
});

test("HIST-002 migration: the purge-lock trigger actually fires -- an in-flight purge job blocks a portfolio_value_history insert", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('user-a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('portfolio-a','user-a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO account_purge_jobs (
      id, owner_user_id, deletion_request_id, deletion_key_digest,
      export_job_id, manifest_digest, status, phase, eligible_at,
      confirmed_at, created_at, updated_at
    ) VALUES (
      'purge-a', 'user-a', 'request-a', 'key-digest', 'export-a',
      'manifest-a', 'running', 'validate_source', '2026-08-01', '2026-08-01',
      '2026-08-01', '2026-08-01'
    );
  `);
  assert.throws(() => {
    db.prepare(
      `INSERT INTO portfolio_value_history (id, user_id, portfolio_id, value_date, value_decimal, completeness, held_security_count, priced_security_count, computed_at)
       VALUES ('phv-locked', 'user-a', 'portfolio-a', '2020-01-02', '500', 'complete', 1, 1, '2026-08-01T00:00:00Z')`,
    ).run();
  }, /account_purge_source_locked/);
  db.close();
});

/** One owner, one portfolio, one HELD security (100 shares from
 * 2020-01-01), with a small, controlled set of daily closes -- small enough
 * that a single read fully backfills (well under MAX_DERIVE_DATES_PER_READ),
 * so these tests isolate write-count/invalidation behaviour from the
 * separate bounded-backfill-progression drill `tests/hist-001.test.ts`'s B1
 * pin already covers. */
async function investedFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('user-a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('portfolio-a','user-a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES
      ('asx','XASX','Australian Securities Exchange','AU','Australia/Sydney','XASX');
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('security-a','equity','asx','AUD','Fortescue','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_exchange_alias,source_currency_code,status,created_at,updated_at) VALUES
      ('membership-a','user-a','portfolio-a','security-a','FMG','ASX','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx-buy','user-a','portfolio-a','membership-a','buy','posted','2020-01-01T00:00:00Z','2020-01-01','100','2','AUD','200','0','0','manual','user-a',1,'2020-01-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('mapping-owner-fmg','security-a','owner-import','ASX','FMG','2020-01-01','verified');
    -- observation_at values follow the SAME midnight-exchange-timezone
    -- convention deriveMidnightObservationAtUtc computes for a real
    -- owner-import write (January is AEDT, +11 -- midnight Sydney is
    -- 13:00 UTC the PREVIOUS day), so a re-import of the same market_date
    -- through confirmSinglePriceUpload lands on the SAME ON CONFLICT
    -- target and correctly overlays, exactly like a real re-upload.
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-1','owner-import','user','user-a','user-a','mapping-owner-fmg','security-a','eod','2020-01-01T13:00:00.000Z','2020-01-02','Australia/Sydney','AUD','5.00','raw','observed','2026-08-24T00:00:00Z'),
      ('price-2','owner-import','user','user-a','user-a','mapping-owner-fmg','security-a','eod','2020-01-02T13:00:00.000Z','2020-01-03','Australia/Sydney','AUD','5.10','raw','observed','2026-08-24T00:00:00Z'),
      ('price-3','owner-import','user','user-a','user-a','mapping-owner-fmg','security-a','eod','2020-01-05T13:00:00.000Z','2020-01-06','Australia/Sydney','AUD','5.20','raw','observed','2026-08-24T00:00:00Z');
  `);
  return db;
}

const NOW = new Date("2020-06-01T00:00:00Z");

test("HIST-002 backfill: a small never-backfilled portfolio's first read fully backfills (3 candidate dates, well under the per-read bound) and persists exactly 3 rows", async () => {
  const db = await investedFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(result);
  if (!result) return;
  assert.equal(result.backfillPending, false);
  assert.deepEqual(
    result.points.map((p) => p.date),
    ["2020-01-02", "2020-01-03", "2020-01-06"],
  );
  assert.equal(result.points[0]!.valueDecimal, "500"); // 100 * 5.00
  const rows = db
    .prepare(
      `SELECT value_date, value_decimal FROM portfolio_value_history WHERE portfolio_id = 'portfolio-a' ORDER BY value_date`,
    )
    .all() as Array<{ value_date: string; value_decimal: string }>;
  assert.deepEqual(
    rows.map((r) => r.value_date),
    ["2020-01-02", "2020-01-03", "2020-01-06"],
  );
  assert.equal(rows[0]!.value_decimal, "500");
});

test("HIST-002 backfill idempotency + EFF-001-style zero-write: re-upserting the IDENTICAL points a second time writes ZERO rows (unchangedCount === written points), never re-touching computed_at needlessly", async () => {
  const db = await investedFixture();
  const client = createSqliteSqlClient(db);
  const points = computeHistoricalPortfolioValueSeries({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: NOW.toISOString(),
    dates: ["2020-01-02", "2020-01-03", "2020-01-06"],
    securities: [
      {
        portfolioSecurityId: "membership-a",
        currencyCode: "AUD",
        transactions: [
          {
            id: "tx-buy",
            type: "buy",
            status: "posted",
            localTradeDate: "2020-01-01",
            tradeAt: "2020-01-01T00:00:00Z",
            quantityDecimal: "100",
            unitPriceDecimal: null,
            reversesTransactionId: null,
          },
        ],
        priceObservations: [
          priceObservation("2020-01-02", "5.00"),
          priceObservation("2020-01-03", "5.10"),
          priceObservation("2020-01-06", "5.20"),
        ],
      } satisfies HistoricalValueSecurityFact,
    ],
    fxObservations: [],
  });
  const first = await upsertStoredValueHistory(client, {
    userId: "user-a",
    portfolioId: "portfolio-a",
    points,
    now: "2026-08-25T00:00:00.000Z",
  });
  assert.equal(first.written, 3);
  assert.equal(first.unchangedCount, 0);

  const second = await upsertStoredValueHistory(client, {
    userId: "user-a",
    portfolioId: "portfolio-a",
    points,
    now: "2026-08-25T01:00:00.000Z", // even a later `now`, the VALUE columns are unchanged
  });
  assert.equal(second.written, 0);
  assert.equal(second.unchangedCount, 3);
});

test("HIST-002 incremental append: after a full backfill, a NEW day's price appears -- the next read appends exactly that one row and leaves the previously-stored rows untouched (computed_at unchanged)", async () => {
  const db = await investedFixture();
  const client = createSqliteSqlClient(db);
  const firstRead = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(firstRead);
  if (!firstRead) return;
  assert.equal(firstRead.points.length, 3);

  const before = db
    .prepare(
      `SELECT value_date, computed_at FROM portfolio_value_history WHERE portfolio_id = 'portfolio-a' ORDER BY value_date`,
    )
    .all() as Array<{ value_date: string; computed_at: string }>;
  assert.equal(before.length, 3);

  // A new trading day's price lands (e.g. the daily capture pipeline).
  db.exec(
    `INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-4','owner-import','user','user-a','user-a','mapping-owner-fmg','security-a','eod','2020-01-06T13:00:00.000Z','2020-01-07','Australia/Sydney','AUD','5.30','raw','observed','2026-08-24T00:00:00Z');`,
  );

  const secondRead = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(secondRead);
  if (!secondRead) return;
  assert.deepEqual(
    secondRead.points.map((p) => p.date),
    ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"],
  );

  const after = db
    .prepare(
      `SELECT value_date, computed_at FROM portfolio_value_history WHERE portfolio_id = 'portfolio-a' ORDER BY value_date`,
    )
    .all() as Array<{ value_date: string; computed_at: string }>;
  assert.equal(after.length, 4);
  // The three pre-existing rows' computed_at is byte-unchanged (EFF-001
  // guard: the incremental read re-derived and re-upserted them too as part
  // of `computeHistoricalPortfolioValueSeries`'s existing candidate set, but
  // the VALUE columns matched, so the guarded upsert performed no write).
  for (const row of before) {
    const match = after.find((r) => r.value_date === row.value_date);
    assert.equal(match?.computed_at, row.computed_at);
  }
});

function context(client: SqlClient, userId: string): PriceUploadContext {
  return { client, userId };
}

test("HIST-002 import invalidation (the CALC-005 lesson, test-pinned): a price-history CSV import correcting a STORED past date deletes exactly that stored row, so the next read re-derives the CORRECTED value rather than serving the stale one", async () => {
  const db = await investedFixture();
  const client = createSqliteSqlClient(db);
  // Fully backfill first.
  const initial = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(initial);
  if (!initial) return;
  const jan2 = initial.points.find((p) => p.date === "2020-01-02");
  assert.equal(jan2?.valueDecimal, "500"); // 100 * 5.00

  const stored = await loadStoredValueHistory(
    client,
    "user-a",
    "portfolio-a",
    "2020-01-01",
    "2020-01-31",
    100,
  );
  assert.ok(stored.has("2020-01-02"));

  // A corrected CSV re-import: 2020-01-02's close was actually 6.00, not
  // 5.00 (a genuine correction, not a duplicate of the same value).
  const parsed = parsePriceCsv(
    new TextEncoder().encode("DateTime,FMG\n2020-01-02,6.00\n"),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const confirmResult = await confirmSinglePriceUpload(
    context(client, "user-a"),
    {
      ticker: parsed.ticker,
      rows: parsed.rows,
      malformedCount: parsed.malformed.length,
    },
    { exchangeAlias: "ASX", currencyCode: "AUD" },
    { filename: "correction.csv", sourceLabel: "intelligent-investor" },
    () => "2026-08-25T02:00:00.000Z",
  );
  assert.equal(confirmResult.ok, true);

  // Invalidation deletes the stored row (delta-aware -- only 2020-01-02).
  const afterImport = await loadStoredValueHistory(
    client,
    "user-a",
    "portfolio-a",
    "2020-01-01",
    "2020-01-31",
    100,
  );
  assert.equal(afterImport.has("2020-01-02"), false);
  assert.ok(afterImport.has("2020-01-03")); // untouched sibling date survives

  // The next read re-derives 2020-01-02 with the CORRECTED price.
  const after = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(after);
  if (!after) return;
  const correctedJan2 = after.points.find((p) => p.date === "2020-01-02");
  assert.equal(correctedJan2?.valueDecimal, "600"); // 100 * 6.00
});

function ledgerInput(
  overrides: Partial<LedgerPostingInput> = {},
): LedgerPostingInput {
  return {
    portfolioId: "portfolio-a",
    type: "buy",
    portfolioSecurityId: "membership-a",
    quantityDecimal: "50",
    unitPriceDecimal: "4",
    grossAmountDecimal: null,
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: "1",
    sourceType: "manual",
    idempotencyKey: "buy-backdated",
    tradeAt: "2019-12-01T00:00:00Z",
    localTradeDate: "2019-12-01",
    settlementDate: "2019-12-03",
    currencyCode: "AUD",
    requestId: "request-backdated",
    ...overrides,
  };
}

function transactionId(result: LedgerMutationResult): string {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected a successful ledger mutation");
  return result.transaction.id;
}

test("HIST-002 review B2 end-to-end: posting a BACK-DATED buy invalidates every stored value-history row from that date forward, and the next read re-derives with the NEW share count", async () => {
  const db = await investedFixture();
  const client = createSqliteSqlClient(db);
  // Fully backfill first: 100 shares * price on each of the 3 stored dates.
  const initial = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(initial);
  if (!initial) return;
  assert.equal(
    initial.points.find((p) => p.date === "2020-01-02")?.valueDecimal,
    "500", // 100 * 5.00
  );
  const storedBefore = await loadStoredValueHistory(
    client,
    "user-a",
    "portfolio-a",
    "2020-01-01",
    "2020-01-31",
    100,
  );
  assert.equal(storedBefore.size, 3);

  // A BACK-DATED buy -- 50 MORE shares, effective 2019-12-01 (before every
  // stored date), via the SAME `createOwnedLedgerRepository().post` path
  // real ledger entries use.
  const ledger = createOwnedLedgerRepository(client);
  const posted = await ledger.post(
    "user-a",
    ledgerInput({ idempotencyKey: "buy-backdated-1" }),
  );
  transactionId(posted);

  // Every stored row from 2019-12-01 onward is gone -- all 3 of this
  // fixture's stored dates qualify.
  const storedAfter = await loadStoredValueHistory(
    client,
    "user-a",
    "portfolio-a",
    "2020-01-01",
    "2020-01-31",
    100,
  );
  assert.equal(storedAfter.size, 0);

  // The next read re-derives with the NEW 150-share total (100 original +
  // 50 back-dated), never the stale 100-share figure.
  const after = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(after);
  if (!after) return;
  assert.equal(
    after.points.find((p) => p.date === "2020-01-02")?.valueDecimal,
    "750", // 150 * 5.00
  );
});

test("HIST-002 review B2 end-to-end: reversing a buy invalidates every stored value-history row from its date forward, and the next read re-derives with the REDUCED share count (down to zero held, an honest gap)", async () => {
  const db = await investedFixture();
  const client = createSqliteSqlClient(db);
  const initial = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(initial);
  if (!initial) return;
  const storedBefore = await loadStoredValueHistory(
    client,
    "user-a",
    "portfolio-a",
    "2020-01-01",
    "2020-01-31",
    100,
  );
  assert.equal(storedBefore.size, 3);

  const ledger = createOwnedLedgerRepository(client);
  const reversal = await ledger.reverse(
    "user-a",
    "portfolio-a",
    "tx-buy", // the fixture's original 100-share buy on 2020-01-01
    "reverse-tx-buy",
    "request-reverse",
  );
  transactionId(reversal);

  const storedAfter = await loadStoredValueHistory(
    client,
    "user-a",
    "portfolio-a",
    "2020-01-01",
    "2020-01-31",
    100,
  );
  assert.equal(storedAfter.size, 0);

  // Nothing held any more -- an honest gap (never a stale 100-share value,
  // never a fabricated zero-value point).
  const after = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(after);
  if (!after) return;
  const jan2 = after.points.find((p) => p.date === "2020-01-02");
  assert.equal(jan2?.valueDecimal, null);
});

test("HIST-002 invalidation is owner-scoped: invalidateStoredValueHistoryForSecurity only touches portfolios owned by the given userId", async () => {
  const db = await investedFixture();
  db.exec(`
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('user-b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('portfolio-b','user-b','B','B portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO portfolio_value_history(id,user_id,portfolio_id,value_date,value_decimal,completeness,held_security_count,priced_security_count,computed_at) VALUES
      ('phv-1','user-a','portfolio-a','2020-01-02','500','complete',1,1,'2026-08-24T00:00:00Z');
  `);
  const client = createSqliteSqlClient(db);
  const result = await invalidateStoredValueHistoryForSecurity(
    client,
    "user-b",
    "security-a",
    ["2020-01-02"],
  );
  // user-b does not hold security-a in any portfolio -- nothing touched.
  assert.equal(result.portfoliosInvalidated, 0);
  assert.equal(result.rowsDeleted, 0);
  const stillThere = db
    .prepare(
      `SELECT value_date FROM portfolio_value_history WHERE portfolio_id = 'portfolio-a'`,
    )
    .all();
  assert.equal(stillThere.length, 1);
});

test("HIST-002 review follow-up (6): an in-flight account purge makes a never-backfilled portfolio's graph read fail (the read path now WRITES its bounded backfill, so the SAME purge-lock trigger every other owner-scoped write already respects also guards this one) -- the caller's existing best-effort catch is what turns this into the honest 'unavailable' fallback, not a silent wrong answer", async () => {
  const db = await investedFixture();
  db.exec(`
    INSERT INTO account_purge_jobs (
      id, owner_user_id, deletion_request_id, deletion_key_digest,
      export_job_id, manifest_digest, status, phase, eligible_at,
      confirmed_at, created_at, updated_at
    ) VALUES (
      'purge-a', 'user-a', 'request-a', 'key-digest', 'export-a',
      'manifest-a', 'running', 'validate_source', '2026-08-01', '2026-08-01',
      '2026-08-01', '2026-08-01'
    );
  `);
  const client = createSqliteSqlClient(db);
  await assert.rejects(
    loadHistoricalPortfolioValueSeries(client, "user-a", "portfolio-a", NOW),
    /account_purge_source_locked/,
  );
});

// ---------------------------------------------------------------------------
// Stored-table round-trip parity pin.
//
// Review follow-up (4): the previous version of this test never actually
// read `portfolio_value_history` -- it compared `loadHistoricalPortfolioValueSeries`'s
// FIRST (never-backfilled, therefore derive-path) result against a raw
// domain computation, which only re-proves what the Layer 1b/domain-level
// parity tests above already cover. The genuine stored-vs-derived round
// trip (a SECOND read served entirely from the store, byte-identical to the
// first derive-path read) is what `tests/hist-001.test.ts`'s B1
// backfill-to-completion drill already pins end-to-end. This test is
// retitled and strengthened to do what its name claims: read the RAW
// `portfolio_value_history` table directly and prove its columns equal the
// pure domain derivation's own output, column for column.
// ---------------------------------------------------------------------------

test("HIST-002 stored-table round-trip parity: the RAW portfolio_value_history rows (read directly, not through the loader) are byte-identical to the pure domain derivation's own output -- the stored rows are that derivation's output, never a second formula", async () => {
  const db = await investedFixture();
  const client = createSqliteSqlClient(db);
  // First read backfills (derive path) and persists.
  const first = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(first);
  if (!first) return;
  assert.equal(first.backfillPending, false);

  const derived = computeHistoricalPortfolioValueSeries({
    baseCurrencyCode: "AUD",
    portfolioTimezone: "Australia/Sydney",
    now: NOW.toISOString(),
    dates: ["2020-01-02", "2020-01-03", "2020-01-06"],
    securities: [
      {
        portfolioSecurityId: "membership-a",
        currencyCode: "AUD",
        transactions: [
          {
            id: "tx-buy",
            type: "buy",
            status: "posted",
            localTradeDate: "2020-01-01",
            tradeAt: "2020-01-01T00:00:00Z",
            quantityDecimal: "100",
            unitPriceDecimal: null,
            reversesTransactionId: null,
          },
        ],
        priceObservations: [
          priceObservation("2020-01-02", "5.00"),
          priceObservation("2020-01-03", "5.10"),
          priceObservation("2020-01-06", "5.20"),
        ],
      } satisfies HistoricalValueSecurityFact,
    ],
    fxObservations: [],
  });

  // Read the RAW table directly -- not through loadHistoricalPortfolioValueSeries
  // (which could theoretically mask a stored-write bug by re-deriving) --
  // and compare column-for-column against the pure domain output.
  const rawRows = db
    .prepare(
      `SELECT value_date, value_decimal, completeness, held_security_count, priced_security_count
       FROM portfolio_value_history WHERE portfolio_id = 'portfolio-a' ORDER BY value_date`,
    )
    .all() as Array<{
    value_date: string;
    value_decimal: string;
    completeness: string;
    held_security_count: number;
    priced_security_count: number;
  }>;
  assert.equal(rawRows.length, derived.length);
  for (const [index, row] of rawRows.entries()) {
    const point = derived[index]!;
    assert.equal(row.value_date, point.date);
    assert.equal(row.value_decimal, point.valueDecimal);
    assert.equal(row.completeness, point.completeness);
    assert.equal(row.held_security_count, point.heldSecurityCount);
    assert.equal(row.priced_security_count, point.pricedSecurityCount);
  }

  // A SECOND read is now served entirely from the store (no re-derivation)
  // and must be byte-identical to the first, derive-path read.
  const second = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(second);
  if (!second) return;
  assert.deepEqual(second.points, first.points);
});

// ---------------------------------------------------------------------------
// Review B2 end-to-end: the ledger-CSV import-commit path
// (db/repositories/import-commit.ts's `finalize`) invalidates stored
// value-history rows too, using the SAME `valueHistoryInvalidationFromDateStatement`
// mechanism ledger.ts's direct post/reverse paths use above -- a SEPARATE
// code path (import commits never call `createOwnedLedgerRepository().post`)
// so it needs its own drill, not just its own compile-time wiring.
// ---------------------------------------------------------------------------

function stageImportBuyRow(
  db: DatabaseSync,
  rowId: string,
  physicalRowNumber: number,
  localTradeDate: string,
): void {
  const normalized = {
    id: `source-${rowId}`,
    symbol: "FMG",
    name: "Fortescue",
    displaySymbol: null,
    exchange: "ASX",
    portfolio: "A",
    currency: "AUD",
    sharesOwned: "20",
    costPerShare: "3",
    commission: "0",
    transactionDate: `${localTradeDate} GMT+1000`,
    transactionTime: "10:00:00",
    purchaseExchangeRate: null,
    type: "buy",
    accounting: "fifo",
    accountingExecutionIds: null,
    notes: null,
    tradeAtUtc: `${localTradeDate}T00:00:00.000Z`,
    localTradeDate,
    cashEvent: null,
  };
  db.prepare(
    `INSERT INTO import_rows (
       id, user_id, batch_id, physical_row_number, row_class,
       original_fields_json, normalized_fields_json, normalized_fingerprint,
       validation_status, target_portfolio_id, target_portfolio_security_id,
       commit_status, created_at, updated_at, version
     ) VALUES (?, 'user-a', 'batch-a', ?, 'transaction', '[]', ?, ?, 'valid',
       'portfolio-a', 'membership-a', 'staged', '2026-08-25', '2026-08-25', 1)`,
  ).run(
    rowId,
    physicalRowNumber,
    JSON.stringify(normalized),
    `fingerprint-${rowId}`,
  );
}

test("HIST-002 review B2 end-to-end (import-commit path): committing a ledger-CSV row invalidates every stored value-history row from its local_trade_date forward, and the next read re-derives with the imported shares included", async () => {
  const db = await investedFixture();
  db.exec(`
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO import_batches (
      id, user_id, target_portfolio_id, parser_format, parser_version, filename,
      byte_size, file_sha256, status, created_at, updated_at, version
    ) VALUES ('batch-a', 'user-a', 'portfolio-a', 'strict-versioned-csv',
      '${SUPPORTED_IMPORT_PARSER_VERSION}', 'sample.csv', 100, 'file-a', 'ready', '2026-08-25T00:00:00Z', '2026-08-25T00:00:00Z', 1);
  `);
  const client = createSqliteSqlClient(db);

  // Fully backfill the existing (100-share) fixture first.
  const initial = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(initial);
  if (!initial) return;
  assert.equal(
    initial.points.find((p) => p.date === "2020-01-02")?.valueDecimal,
    "500", // 100 * 5.00
  );

  // Stage and commit an ADDITIONAL buy (20 more shares) at a date BEFORE
  // every stored row, via the real import-commit pipeline (never
  // `createOwnedLedgerRepository().post` -- a genuinely different write
  // path).
  stageImportBuyRow(db, "row-1", 2, "2019-06-01");
  const repository = createOwnedImportCommitRepository(client);
  const validated = await repository.validate("user-a", "batch-a");
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const commitInput: ImportCommitInput = {
    expectedVersion: 1,
    expectedPreviewVersion: validated.previewVersion,
    idempotencyKey: "commit-a",
    confirmation: true,
    requestId: "request-commit",
  };
  let commitResult = await repository.commit("user-a", "batch-a", commitInput);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (commitResult.ok && commitResult.status === "committed") break;
    assert.equal(commitResult.ok, true);
    commitResult = await repository.commit("user-a", "batch-a", commitInput);
  }
  assert.equal(commitResult.ok, true);
  if (!commitResult.ok) return;
  assert.equal(commitResult.status, "committed");

  // Every stored row from 2019-06-01 onward is gone.
  const storedAfter = await loadStoredValueHistory(
    client,
    "user-a",
    "portfolio-a",
    "2020-01-01",
    "2020-01-31",
    100,
  );
  assert.equal(storedAfter.size, 0);

  // The next read re-derives with the imported shares included (120 total).
  const after = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    NOW,
  );
  assert.ok(after);
  if (!after) return;
  assert.equal(
    after.points.find((p) => p.date === "2020-01-02")?.valueDecimal,
    "600", // 120 * 5.00
  );
});
