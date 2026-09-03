/**
 * BUG-012 -- Persist "attempted, genuinely unresolvable" for a value-history
 * candidate date (BUG-010/PRF-010 follow-up).
 *
 * Before this task, a candidate date `resolveValueHistorySeries`
 * (`app/historical-portfolio-value.ts`) genuinely could not resolve a value
 * for was NEVER stored (the honesty invariant), so it stayed "missing"
 * forever and was re-attempted on every read/cron call. A CONTIGUOUS run of
 * such dates at least as long as one call's bound
 * (`MAX_DERIVE_DATES_PER_READ` = 10 on reads) permanently pinned that call's
 * bounded slice, starving every candidate date behind it -- BUG-010's own
 * entry recorded the opposite-ends read/cron sweep as a MITIGATION, not a
 * proof (runs at both ends could still stall).
 *
 * This file proves the fix: an unresolvable date is now persisted as a fact
 * in a sibling table, `portfolio_value_history_unresolvable`
 * (`db/schema.ts`'s `portfolioValueHistoryUnresolvable`), excluded from
 * `missingDates` so it can never occupy a slot in a bounded slice again --
 * and that every existing invalidation path clears the mark, in the same
 * atomic unit as its existing `portfolio_value_history` invalidation, so a
 * date that later becomes resolvable is retried rather than permanently
 * written off. See `docs/DATA_MODEL.md` and `docs/CALCULATIONS.md` for the
 * schema/behaviour record and `docs/ARCHITECTURE.md` for the historical
 * strategy entry this task adds to.
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
  backfillStoredValueHistoryForPortfolio,
  loadHistoricalPortfolioValueSeries,
  MAX_DERIVE_DATES_PER_READ,
} from "../app/historical-portfolio-value.ts";
import {
  loadPortfolioConvergenceMarker,
  loadUnresolvableValueHistoryDates,
} from "../db/repositories/portfolio-value-history.ts";
import {
  createOwnedLedgerRepository,
  type LedgerMutationResult,
} from "../db/repositories/ledger.ts";
import type { LedgerPostingInput } from "../domain/ledger/posting.ts";
import {
  confirmSinglePriceUpload,
  type PriceUploadContext,
} from "../app/price-upload-service.ts";
import { parsePriceCsv } from "../domain/market-data/price-csv.ts";
import { upsertSharesightPriceObservations } from "../db/repositories/sharesight-price-refresh.ts";
import type { SharesightPriceAccretionCandidate } from "../domain/sharesight/price-accretion.ts";

const NOW = new Date("2026-09-03T00:00:00Z");

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

function weekdays(from: string, count: number): string[] {
  const dates: string[] = [];
  let cursor = Date.parse(`${from}T00:00:00Z`);
  while (dates.length < count) {
    const day = new Date(cursor);
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6)
      dates.push(day.toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Migration shape / purge / export classification.
// ---------------------------------------------------------------------------

test("BUG-012 migration: portfolio_value_history_unresolvable has the expected columns and constraints", async () => {
  const db = await migratedDatabase();
  const columns = db
    .prepare(`PRAGMA table_info("portfolio_value_history_unresolvable")`)
    .all() as Array<{ name: string; notnull: number }>;
  const byName = new Map(columns.map((c) => [c.name, c]));
  assert.equal(byName.get("user_id")?.notnull, 1);
  assert.equal(byName.get("portfolio_id")?.notnull, 1);
  assert.equal(byName.get("value_date")?.notnull, 1);
  assert.equal(byName.get("reason")?.notnull, 1);
  assert.equal(byName.get("attempted_at")?.notnull, 1);
  assert.equal(byName.get("fingerprint")?.notnull, 0);

  const indexes = db
    .prepare(`PRAGMA index_list("portfolio_value_history_unresolvable")`)
    .all() as Array<{ name: string; unique: number }>;
  assert.ok(
    indexes.some(
      (index) =>
        index.name ===
          "portfolio_value_history_unresolvable_portfolio_date_unique" &&
        index.unique === 1,
    ),
  );
  db.close();
});

test("BUG-012 migration: the reason CHECK constraint rejects an unrecognised value", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES('owner','active','o@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES('pf','owner','A','A','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
  `);
  assert.throws(() => {
    db.exec(`
      INSERT INTO portfolio_value_history_unresolvable (id,user_id,portfolio_id,value_date,reason,attempted_at)
      VALUES ('u1','owner','pf','2026-01-01','not_a_real_reason','2026-01-01T00:00:00Z');
    `);
  }, /CHECK constraint failed/);
  db.close();
});

test("BUG-012 migration: portfolio_value_history_unresolvable has its three purge-lock triggers", async () => {
  const db = await migratedDatabase();
  const triggers = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'portfolio_value_history_unresolvable' ORDER BY name",
    )
    .all() as { name: string }[];
  assert.deepEqual(
    triggers.map((row) => row.name),
    [
      "account_purge_lock_portfolio_value_history_unresolvable_delete",
      "account_purge_lock_portfolio_value_history_unresolvable_insert",
      "account_purge_lock_portfolio_value_history_unresolvable_update",
    ],
  );
  db.close();
});

test("BUG-012 migration: the purge-lock trigger actually fires -- an in-flight purge job blocks an insert", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES('owner','active','o@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES('pf','owner','A','A','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO account_purge_jobs (
      id, owner_user_id, deletion_request_id, deletion_key_digest,
      export_job_id, manifest_digest, status, phase, eligible_at,
      confirmed_at, created_at, updated_at
    ) VALUES (
      'purge-a', 'owner', 'request-a', 'key-digest', 'export-a',
      'manifest-a', 'running', 'validate_source', '2026-08-01', '2026-08-01',
      '2026-08-01', '2026-08-01'
    );
  `);
  assert.throws(() => {
    db.exec(`
      INSERT INTO portfolio_value_history_unresolvable (id,user_id,portfolio_id,value_date,reason,attempted_at)
      VALUES ('u1','owner','pf','2026-01-01','no_holdings','2026-01-01T00:00:00Z');
    `);
  }, /account_purge_source_locked/);
  db.close();
});

test("BUG-012 export/purge: portfolio_value_history_unresolvable is classified owned, user-keyed (behavioural, against the real exported const), and appears in the purge FK-order list (source-text check -- PURGE_TABLES_IN_FK_ORDER itself is not exported)", async () => {
  const source = await readFile(
    new URL("../db/repositories/account-lifecycle.ts", import.meta.url),
    "utf8",
  );
  // `ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS` IS exported -- this asserts
  // against the real imported value, never source text.
  const { ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS } =
    await import("../db/repositories/account-lifecycle.ts");
  const classification =
    ACCOUNT_EXPORT_TABLE_CLASSIFICATIONS.portfolio_value_history_unresolvable;
  assert.ok(classification, "must be classified before an export job can run");
  assert.equal(classification.classification, "owned");
  assert.equal(classification.ownerColumn, "user_id");

  // `PURGE_TABLES_IN_FK_ORDER` is module-private (no export), so this half
  // genuinely has no behavioural alternative -- a source-text pin is the
  // only way to assert its membership without exporting a purge-internal
  // ordering list purely for a test to read.
  const purgeOrderSection = source.slice(
    source.indexOf("const PURGE_TABLES_IN_FK_ORDER"),
    source.indexOf(
      "] as const;",
      source.indexOf("const PURGE_TABLES_IN_FK_ORDER"),
    ),
  );
  assert.match(purgeOrderSection, /"portfolio_value_history_unresolvable"/);
});

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

type Trade = Readonly<{
  type: "buy" | "sell";
  date: string;
  quantity: string;
}>;

/** One security, one owner, one portfolio -- priced flat on every date in
 * `dates`, with holdings shaped by `trades` (applied in order). Mirrors
 * `tests/hist-002.test.ts`'s `investedFixture`/`tests/prf-010.test.ts`'s
 * fixtures, generalised to an arbitrary trade sequence so each test below
 * can shape WHERE the unresolvable ("nothing held") dates fall. */
async function singleSecurityFixture(
  dates: readonly string[],
  trades: readonly Trade[],
): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES('owner','active','o@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES('pf','owner','A','A','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES('asx','XASX','ASX','AU','Australia/Sydney','XASX');
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('sec-1','equity','asx','AUD','One','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_exchange_alias,source_currency_code,status,created_at,updated_at) VALUES
      ('ps-1','owner','pf','sec-1','ONE','ASX','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('map-1','sec-1','owner-import','ASX','ONE','2023-01-01','verified');
  `);
  const txRows = trades
    .map(
      (trade, index) =>
        `('tx-${index}','owner','pf','ps-1','${trade.type}','posted','${trade.date}T00:00:00Z','${trade.date}','${trade.quantity}','10','AUD','1000','0','0','manual','owner',1,'${trade.date}')`,
    )
    .join(",");
  db.exec(
    `INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES ${txRows};`,
  );
  const priceRows = dates.map(
    (date, index) =>
      `('price-${index}','owner-import','user','owner','owner','map-1','sec-1','eod','${date}T04:00:00.000Z','${date}','Australia/Sydney','AUD','10.00','raw','observed','2026-08-24T00:00:00.000Z')`,
  );
  db.exec(
    `INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES ${priceRows.join(",")};`,
  );
  return db;
}

function unresolvedRows(
  db: DatabaseSync,
  portfolioId = "pf",
): Array<{ value_date: string; reason: string }> {
  const rows = db
    .prepare(
      `SELECT value_date, reason FROM portfolio_value_history_unresolvable WHERE portfolio_id = ? ORDER BY value_date`,
    )
    .all(portfolioId) as Array<{ value_date: string; reason: string }>;
  // node:sqlite rows are null-prototype objects -- plain-object them so
  // `assert.deepEqual` (strict under node:assert/strict) can compare
  // against ordinary object literals.
  return rows.map((row) => ({
    value_date: row.value_date,
    reason: row.reason,
  }));
}

function storedDates(db: DatabaseSync, portfolioId = "pf"): string[] {
  return (
    db
      .prepare(
        `SELECT value_date FROM portfolio_value_history WHERE portfolio_id = ? ORDER BY value_date`,
      )
      .all(portfolioId) as Array<{ value_date: string }>
  ).map((row) => row.value_date);
}

// ---------------------------------------------------------------------------
// The stall hazard, closed at BOTH ends.
// ---------------------------------------------------------------------------

test("BUG-012 read path: a contiguous unresolvable run at the NEWEST end, longer than MAX_DERIVE_DATES_PER_READ, no longer blocks progress on the OLDER resolvable dates behind it", async () => {
  const dates = weekdays("2024-01-01", 30);
  assert.ok(
    30 - 15 > MAX_DERIVE_DATES_PER_READ,
    "fixture assumption: the unresolvable run must exceed the read bound",
  );
  // Held dates[0..14] (buy on day 0), sold out entirely on day 15 -- every
  // date from day 15 has price data (the security is still priced after the
  // sale) but nothing held, so it is a genuine, PERMANENT 'no_holdings' gap.
  const db = await singleSecurityFixture(dates, [
    { type: "buy", date: dates[0]!, quantity: "100" },
    { type: "sell", date: dates[15]!, quantity: "100" },
  ]);
  const client = createSqliteSqlClient(db);

  // Repeated reads, each newest-first bounded to MAX_DERIVE_DATES_PER_READ
  // (10). Pre-fix, `toDerive` would ALWAYS re-select the same newest-10
  // unresolvable dates forever (they never get stored, so they never leave
  // `missingDates`) -- the older, genuinely resolvable dates[0..14] would
  // never be reached. Post-fix, the run gets marked within
  // ceil(15/10) = 2 reads and stops competing for a slot.
  for (let i = 0; i < 5; i += 1) {
    await loadHistoricalPortfolioValueSeries(client, "owner", "pf", NOW);
  }

  assert.deepEqual(
    storedDates(db),
    dates.slice(0, 15),
    "every resolvable date behind the unresolvable run must eventually be stored",
  );
  assert.deepEqual(
    unresolvedRows(db).map((r) => r.value_date),
    dates.slice(15),
  );
  assert.ok(unresolvedRows(db).every((r) => r.reason === "no_holdings"));

  // Honesty: an unresolvable date is never fabricated. Once marked, it is
  // excluded from `toDerive` entirely, so it no longer even appears in the
  // read's own `points` array (the same "not derived this call" gap shape
  // every other absent date already renders) -- confirm neither a
  // zero-valued nor a null-valued entry sneaks in for it.
  const finalRead = await loadHistoricalPortfolioValueSeries(
    client,
    "owner",
    "pf",
    NOW,
  );
  assert.ok(finalRead);
  if (!finalRead) return;
  for (const date of dates.slice(15)) {
    assert.equal(
      finalRead.points.find((p) => p.date === date),
      undefined,
      `${date} must be honestly absent from points, never a fabricated/null entry`,
    );
  }
  for (const date of dates.slice(0, 15)) {
    assert.equal(
      finalRead.points.find((p) => p.date === date)?.valueDecimal,
      "1000", // 100 shares * 10.00
    );
  }
  db.close();
});

test("BUG-012 cron path: a contiguous unresolvable run at the OLDEST end, longer than the tick bound, no longer blocks progress on the NEWER resolvable dates ahead of it", async () => {
  const dates = weekdays("2024-01-01", 30);
  const bound = 10;
  assert.ok(
    14 > bound,
    "fixture assumption: the unresolvable run must exceed the cron's per-tick bound",
  );
  // Buy on day 0, sell IMMEDIATELY on day 1 (one day held), nothing held
  // again until a fresh buy on day 15, held forever after. Days 1..14 (14
  // dates, contiguous) are a genuine, permanent 'no_holdings' gap sitting
  // right after the range's own start (the OLDEST end of the missing set).
  const db = await singleSecurityFixture(dates, [
    { type: "buy", date: dates[0]!, quantity: "100" },
    { type: "sell", date: dates[1]!, quantity: "100" },
    { type: "buy", date: dates[15]!, quantity: "100" },
  ]);
  const client = createSqliteSqlClient(db);

  // Repeated cron ticks, oldest-first bounded to `bound`. Pre-fix, every
  // tick's `toDerive` would re-select the oldest missing dates -- which,
  // once date 0 is stored, are ALWAYS inside the 14-date unresolvable run --
  // forever, never reaching dates[15..29].
  for (let tick = 0; tick < 5; tick += 1) {
    await backfillStoredValueHistoryForPortfolio(
      client,
      "owner",
      "pf",
      bound,
      new Date(NOW.getTime() + tick * 3_600_000),
    );
  }

  assert.deepEqual(storedDates(db), [dates[0]!, ...dates.slice(15)]);
  assert.deepEqual(
    unresolvedRows(db).map((r) => r.value_date),
    dates.slice(1, 15),
  );
  db.close();
});

// ---------------------------------------------------------------------------
// The load-bearing correctness property: a cleared mark is retried.
// ---------------------------------------------------------------------------

function csvPayloadOf(text: string): {
  ticker: string;
  rows: Array<{ marketDate: string; priceDecimal: string }>;
  malformedCount: number;
} {
  const parsed = parsePriceCsv(new TextEncoder().encode(text));
  if (!parsed.ok) {
    throw new Error(`test fixture CSV failed to parse: ${parsed.message}`);
  }
  return {
    ticker: parsed.ticker,
    rows: parsed.rows.map((row) => ({
      marketDate: row.marketDate,
      priceDecimal: row.priceDecimal,
    })),
    malformedCount: parsed.malformed.length,
  };
}

function uploadContext(client: SqlClient): PriceUploadContext {
  return { client, userId: "owner" };
}

/** Two securities: `sec-1` is HELD throughout (bought on `dates[0]`, never
 * sold) but has NO price on `dates[GAP_INDEX]`; `sec-2` is a
 * `portfolio_securities` row that is NEVER bought (contributes nothing to
 * `heldSecurityCount`) but IS priced on every date, including the gap --
 * the established "candidate via a never-held security" shape
 * (`tests/prf-010.test.ts`/`tests/bug-010.test.ts`'s two-security
 * fixtures) that keeps the gap date a genuine CANDIDATE (some held
 * security's price data exists in range) while making it genuinely
 * unresolvable (the one security actually held has no price that day). */
const GAP_INDEX = 5;

async function priceGapFixture(): Promise<DatabaseSync> {
  const dates = weekdays("2024-01-01", 12);
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES('owner','active','o@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES('pf','owner','A','A','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES('asx','XASX','ASX','AU','Australia/Sydney','XASX');
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('sec-1','equity','asx','AUD','One','2026-08-01','2026-08-01'),
      ('sec-2','equity','asx','AUD','Two','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_exchange_alias,source_currency_code,status,created_at,updated_at) VALUES
      ('ps-1','owner','pf','sec-1','ONE','ASX','AUD','held','2026-08-01','2026-08-01'),
      ('ps-2','owner','pf','sec-2','TWO','ASX','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('map-1','sec-1','owner-import','ASX','ONE','2023-01-01','verified'),
      ('map-2','sec-2','owner-import','ASX','TWO','2023-01-01','verified');
    -- F1: a sharesight_instrument identifier for sec-1 only -- lets a
    -- SEPARATE test drive the real Sharesight write path
    -- (upsertSharesightPriceObservations) against this same fixture,
    -- harmless to every other test that never references it.
    INSERT INTO security_identifiers (id,security_id,scheme,value,valid_from,valid_to,source) VALUES
      ('ident-sec-1','sec-1','sharesight_instrument','9001','2023-01-01',NULL,'sharesight');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx-1','owner','pf','ps-1','buy','posted','${dates[0]}T00:00:00Z','${dates[0]}','100','10','AUD','1000','0','0','manual','owner',1,'${dates[0]}');
  `);
  const priceRows: string[] = [];
  let counter = 0;
  for (const [index, date] of dates.entries()) {
    if (index !== GAP_INDEX) {
      counter += 1;
      priceRows.push(
        `('price-sec1-${counter}','owner-import','user','owner','owner','map-1','sec-1','eod','${date}T04:00:00.000Z','${date}','Australia/Sydney','AUD','10.00','raw','observed','2026-08-24T00:00:00.000Z')`,
      );
    }
    counter += 1;
    priceRows.push(
      `('price-sec2-${counter}','owner-import','user','owner','owner','map-2','sec-2','eod','${date}T04:00:00.000Z','${date}','Australia/Sydney','AUD','20.00','raw','observed','2026-08-24T00:00:00.000Z')`,
    );
  }
  db.exec(
    `INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES ${priceRows.join(",")};`,
  );
  return db;
}

test("BUG-012 honesty + load-bearing: an unresolvable date is marked, renders honestly absent, and a LATER real price import clears the mark so the next derivation resolves it", async () => {
  const dates = weekdays("2024-01-01", 12);
  const gapDate = dates[GAP_INDEX]!;
  const db = await priceGapFixture();
  const client = createSqliteSqlClient(db);

  // First read: sec-1 (the only HELD security) has no price on `gapDate`,
  // so it is genuinely unresolvable -- marked, never fabricated.
  const before = await loadHistoricalPortfolioValueSeries(
    client,
    "owner",
    "pf",
    NOW,
  );
  assert.ok(before);
  if (!before) return;
  assert.deepEqual(unresolvedRows(db), [
    { value_date: gapDate, reason: "no_priceable_security" },
  ]);
  // This first attempt DID run the derivation for gapDate this call, so its
  // point is present with an honestly null value (the pre-existing "not yet
  // resolved" shape) -- never a fabricated number.
  assert.equal(
    before.points.find((p) => p.date === gapDate)?.valueDecimal,
    null,
  );

  // A second read must NOT re-attempt the marked date -- it is excluded
  // from `toDerive` entirely, so it is fully absent from `points` now
  // (proving it was skipped, not merely re-resolved to the same null).
  const stillMissing = await loadHistoricalPortfolioValueSeries(
    client,
    "owner",
    "pf",
    NOW,
  );
  assert.ok(stillMissing);
  if (!stillMissing) return;
  assert.equal(
    stillMissing.points.find((p) => p.date === gapDate),
    undefined,
  );

  // Real writer: a price-history upload supplies sec-1's missing price on
  // `gapDate`, via the SAME `app/price-upload-service.ts` MKT-008 confirm
  // path a real owner upload uses.
  const csv = csvPayloadOf(`DateTime,ONE\n${gapDate},11.50\n`);
  const uploaded = await confirmSinglePriceUpload(
    uploadContext(client),
    csv,
    { exchangeAlias: "ASX", currencyCode: "AUD" },
    { filename: "one.csv", sourceLabel: "intelligent-investor" },
    () => "2026-09-03T00:00:00.000Z",
  );
  assert.equal(uploaded.ok, true);
  if (!uploaded.ok) return;
  assert.equal(uploaded.value.written, 1);

  // The mark must be cleared by that SAME import -- the load-bearing
  // property this task exists to prove.
  assert.deepEqual(unresolvedRows(db), []);
  assert.equal(
    (
      await loadUnresolvableValueHistoryDates(
        client,
        "owner",
        "pf",
        gapDate,
        gapDate,
        10,
      )
    ).size,
    0,
  );

  // The NEXT derivation resolves it for real -- 100 shares * 11.50.
  const after = await loadHistoricalPortfolioValueSeries(
    client,
    "owner",
    "pf",
    NOW,
  );
  assert.ok(after);
  if (!after) return;
  assert.equal(
    after.points.find((p) => p.date === gapDate)?.valueDecimal,
    "1150",
  );
  const storedGapRow = db
    .prepare(
      `SELECT value_decimal FROM portfolio_value_history WHERE portfolio_id='pf' AND value_date=?`,
    )
    .get(gapDate) as { value_decimal: string } | undefined;
  assert.equal(
    storedGapRow?.value_decimal,
    "1150",
    "the newly-resolvable date must now be a real, persisted row",
  );
  db.close();
});

// ---------------------------------------------------------------------------
// Convergence fingerprint folds in the unresolvable set.
// ---------------------------------------------------------------------------

function ledgerInput(
  overrides: Partial<LedgerPostingInput> = {},
): LedgerPostingInput {
  return {
    portfolioId: "pf",
    type: "buy",
    portfolioSecurityId: "ps-1",
    quantityDecimal: "50",
    unitPriceDecimal: "10",
    grossAmountDecimal: null,
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: "1",
    sourceType: "manual",
    idempotencyKey: "buy-unconverge",
    tradeAt: "2024-01-01T00:00:00Z",
    localTradeDate: "2024-01-01",
    settlementDate: "2024-01-03",
    currencyCode: "AUD",
    requestId: "request-unconverge",
    ...overrides,
  };
}

function transactionId(result: LedgerMutationResult): string {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected a successful ledger mutation");
  return result.transaction.id;
}

test("BUG-012/PRF-010: the convergence marker folds in the unresolvable set -- clearing a mark via a real ledger write un-converges the portfolio", async () => {
  const dates = weekdays("2024-01-01", 30);
  const db = await singleSecurityFixture(dates, [
    { type: "buy", date: dates[0]!, quantity: "100" },
    { type: "sell", date: dates[15]!, quantity: "100" },
  ]);
  const client = createSqliteSqlClient(db);

  // Converge: dates[0..14] resolvable (15), dates[15..29] unresolvable (15).
  // Two ticks of bound 15 is enough to attempt everything once and mark the
  // whole unresolvable tail; a third proves zero missing and records the
  // marker (mirrors tests/prf-010.test.ts's analogous sequence).
  await backfillStoredValueHistoryForPortfolio(client, "owner", "pf", 30, NOW);
  const converged = await backfillStoredValueHistoryForPortfolio(
    client,
    "owner",
    "pf",
    30,
    new Date(NOW.getTime() + 3_600_000),
  );
  assert.ok(converged);
  if (!converged) return;
  assert.equal(converged.missingDates, 0);
  const markerBefore = await loadPortfolioConvergenceMarker(
    client,
    "owner",
    "pf",
  );
  assert.ok(markerBefore, "must be marked converged once missingDates hits 0");
  assert.equal(unresolvedRows(db).length, 15);

  // A THIRD tick must be a marker-shortcut skip -- proves the fixture is
  // genuinely stable before the clear.
  const skipped = await backfillStoredValueHistoryForPortfolio(
    client,
    "owner",
    "pf",
    30,
    new Date(NOW.getTime() + 7_200_000),
  );
  assert.ok(skipped);
  if (!skipped) return;
  assert.equal(skipped.skipped, true);

  // Real writer: a back-dated buy effective from dates[20] onward -- the
  // SAME `createOwnedLedgerRepository().post` path a real ledger entry
  // uses. This re-establishes a holding for dates[20..29] (10 of the 15
  // previously-unresolvable dates), and per BUG-012's fold into
  // `db/repositories/ledger.ts`'s `persist`, clears their unresolvable
  // marks in the SAME atomic batch as its `portfolio_value_history`
  // invalidation.
  const ledger = createOwnedLedgerRepository(client);
  const posted = await ledger.post(
    "owner",
    ledgerInput({
      idempotencyKey: "buy-unconverge",
      tradeAt: `${dates[20]}T00:00:00Z`,
      localTradeDate: dates[20]!,
      settlementDate: dates[20]!,
    }),
  );
  transactionId(posted);

  assert.deepEqual(
    unresolvedRows(db).map((r) => r.value_date),
    dates.slice(15, 20),
    "the 10 newly-resolvable dates must have their marks cleared, the 5 still-unresolvable ones must not",
  );

  // The marker must no longer apply -- the fingerprint changed
  // (unresolvableCount 15 -> 5), so this tick must run the real check, not
  // the shortcut, and must find genuine missing work.
  const unconverged = await backfillStoredValueHistoryForPortfolio(
    client,
    "owner",
    "pf",
    30,
    new Date(NOW.getTime() + 10_800_000),
  );
  assert.ok(unconverged);
  if (!unconverged) return;
  assert.notEqual(unconverged.skipped, true);
  assert.equal(unconverged.missingDates, 10);
  assert.equal(unconverged.rowsPersisted, 10);
  assert.deepEqual(storedDates(db), [
    ...dates.slice(0, 15),
    ...dates.slice(20),
  ]);
  db.close();
});

// ---------------------------------------------------------------------------
// Ownership isolation.
// ---------------------------------------------------------------------------

test("BUG-012 ownership: loadUnresolvableValueHistoryDates is scoped to the CALLING user's id -- a cross-owner userId argument against the real portfolio_id sees nothing", async () => {
  const dates = weekdays("2024-01-01", 20);
  const db = await singleSecurityFixture(dates, [
    { type: "buy", date: dates[0]!, quantity: "100" },
    { type: "sell", date: dates[5]!, quantity: "100" },
  ]);
  const client = createSqliteSqlClient(db);

  await loadHistoricalPortfolioValueSeries(client, "owner", "pf", NOW);
  assert.ok(unresolvedRows(db, "pf").length > 0);

  // Same portfolio_id ('pf'), a DIFFERENT (non-owning) userId -- must see
  // nothing, matching every other owner-scoped query in this repository
  // (never a client-supplied/mismatched owner id).
  const crossOwner = await loadUnresolvableValueHistoryDates(
    client,
    "someone-else",
    "pf",
    dates[0]!,
    dates[dates.length - 1]!,
    100,
  );
  assert.equal(crossOwner.size, 0);

  // The real owner's own read is unaffected.
  const owned = await loadUnresolvableValueHistoryDates(
    client,
    "owner",
    "pf",
    dates[0]!,
    dates[dates.length - 1]!,
    100,
  );
  assert.ok(owned.size > 0);
  db.close();
});

// ---------------------------------------------------------------------------
// F1 (review round 2, blocking): the Sharesight price-refresh write path
// (`upsertSharesightPriceObservations`) must clear an unresolvable mark it
// makes newly resolvable, in the SAME atomic batch as its writes -- both
// the ordinary fresh write (`app/sharesight-price-refresh-service.ts`) and
// the MKT-015 `noDowngrade: true` prior-day backfill
// (`app/sharesight-price-gate-service.ts`) share this one function.
// ---------------------------------------------------------------------------

function sharesightCandidateFor(
  securityId: string,
  marketDate: string,
  closeDecimal: string,
): SharesightPriceAccretionCandidate {
  return {
    securityId,
    instrumentCode: "ONE",
    marketCode: "ASX",
    currencyCode: "AUD",
    closeDecimal,
    marketDate,
    marketTimezone: "Australia/Sydney",
    // A Z-suffixed UTC timestamp, matching what `normalizeTimestampToUtcIso`
    // always produces in the real pipeline (never Sharesight's raw offset
    // string, per `SharesightPriceAccretionCandidate.observationAt`'s own
    // doc comment) -- `app/historical-portfolio-value.ts`'s `mapPrice`
    // requires this exact `...Z` shape (`ISO` regex) or silently drops the
    // row as malformed. Early UTC morning, matching every other fixture in
    // this file, so it stays within `marketDate`'s own Sydney calendar day.
    observationAt: `${marketDate}T04:10:00.000Z`,
  };
}

test("BUG-012 F1: a fresh Sharesight write (upsertSharesightPriceObservations, no noDowngrade) clears an unresolvable mark and the next derivation resolves the date for real", async () => {
  const dates = weekdays("2024-01-01", 12);
  const gapDate = dates[GAP_INDEX]!;
  const db = await priceGapFixture();
  const client = createSqliteSqlClient(db);

  // sec-1 (the only HELD security) has no price on gapDate -- genuinely
  // unresolvable, marked.
  await loadHistoricalPortfolioValueSeries(client, "owner", "pf", NOW);
  assert.deepEqual(unresolvedRows(db), [
    { value_date: gapDate, reason: "no_priceable_security" },
  ]);

  // The REAL write path a Sharesight cron refresh uses -- see
  // `SHARESIGHT_PRICE_REFRESH_LIMITS`'s doc comment
  // (`db/repositories/sharesight-price-refresh.ts`) for why this now also
  // appends the paired value-history invalidation into the SAME atomic
  // batch as this write.
  const written = await upsertSharesightPriceObservations(client, {
    userId: "owner",
    candidates: [sharesightCandidateFor("sec-1", gapDate, "12.34")],
    now: "2026-09-03T00:00:00.000Z",
  });
  assert.equal(written.written, 1);

  // The mark must be cleared by that SAME write -- the load-bearing
  // property F1 exists to prove (pre-fix, this write left the mark
  // untouched and never invalidated `portfolio_value_history` at all).
  assert.deepEqual(unresolvedRows(db), []);

  // The NEXT derivation resolves it for real -- 100 shares * 12.34.
  const after = await loadHistoricalPortfolioValueSeries(
    client,
    "owner",
    "pf",
    NOW,
  );
  assert.ok(after);
  if (!after) return;
  assert.equal(
    after.points.find((p) => p.date === gapDate)?.valueDecimal,
    "1234",
  );
  db.close();
});

test("BUG-012 F1: the MKT-015 prior-day backfill write (upsertSharesightPriceObservations, noDowngrade: true) also clears an unresolvable mark", async () => {
  const dates = weekdays("2024-01-01", 12);
  const gapDate = dates[GAP_INDEX]!;
  const db = await priceGapFixture();
  const client = createSqliteSqlClient(db);

  await loadHistoricalPortfolioValueSeries(client, "owner", "pf", NOW);
  assert.deepEqual(unresolvedRows(db), [
    { value_date: gapDate, reason: "no_priceable_security" },
  ]);

  // Same write function, `noDowngrade: true` -- the MKT-015 prior-day gate
  // backfill's own call shape (`app/sharesight-price-gate-service.ts`).
  // Invalidation must append regardless of this flag: it governs whether
  // an UPDATE downgrades an already-fresher row, not whether the paired
  // value-history invalidation runs at all.
  const written = await upsertSharesightPriceObservations(client, {
    userId: "owner",
    candidates: [sharesightCandidateFor("sec-1", gapDate, "13.00")],
    now: "2026-09-03T00:00:00.000Z",
    noDowngrade: true,
  });
  assert.equal(written.written, 1);
  assert.deepEqual(unresolvedRows(db), []);

  const after = await loadHistoricalPortfolioValueSeries(
    client,
    "owner",
    "pf",
    NOW,
  );
  assert.ok(after);
  if (!after) return;
  assert.equal(
    after.points.find((p) => p.date === gapDate)?.valueDecimal,
    "1300",
  );
  db.close();
});

// ---------------------------------------------------------------------------
// F2 (review round 2, blocking): an FX-only gap must never be persisted as
// unresolvable -- it must keep retrying on every read until the FX rate
// arrives, since no FX write path invalidates `portfolio_value_history`.
// ---------------------------------------------------------------------------

const FX_GAP_INDEX = 4;

/** One USD-denominated HELD security (`sec-1`), priced in USD on EVERY
 * date (never a price gap) so the only possible failure on any date is
 * the FX conversion -- `fx_rate_observations` (AUD/USD) is present on
 * every date EXCEPT `FX_GAP_INDEX`, the genuine FX-only gap this section
 * tests. */
async function fxOnlyGapFixture(): Promise<{
  db: DatabaseSync;
  dates: string[];
}> {
  const dates = weekdays("2024-01-01", 12);
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES
      ('AUD',36,'Australian dollar',2),('USD',840,'US dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES('owner','active','o@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES('pf','owner','A','A','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES('nasdaq','XNAS','NASDAQ','US','America/New_York','XNAS');
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('sec-1','equity','nasdaq','USD','One','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_exchange_alias,source_currency_code,status,created_at,updated_at) VALUES
      ('ps-1','owner','pf','sec-1','ONE','NASDAQ','USD','held','2026-08-01','2026-08-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('map-1','sec-1','owner-import','NASDAQ','ONE','2023-01-01','verified');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx-1','owner','pf','ps-1','buy','posted','${dates[0]}T00:00:00Z','${dates[0]}','100','10','USD','1000','0','0','manual','owner',1,'${dates[0]}');
  `);
  // Observation times deliberately EARLY UTC (matching every other
  // fixture in this file, e.g. `priceGapFixture`'s `T04:00:00.000Z`) so
  // `selectPriceObservation`'s look-ahead guard -- keyed on the
  // PORTFOLIO's own timezone (`Australia/Sydney`, UTC+10) -- never rejects
  // an observation as "after" its own `market_date`'s Sydney calendar day.
  const priceRows = dates.map(
    (date, index) =>
      `('price-${index}','owner-import','user','owner','owner','map-1','sec-1','eod','${date}T04:00:00.000Z','${date}','America/New_York','USD','10.00','raw','observed','2026-08-24T00:00:00.000Z')`,
  );
  db.exec(
    `INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES ${priceRows.join(",")};`,
  );
  const fxRows = dates
    .filter((_date, index) => index !== FX_GAP_INDEX)
    .map(
      (date, counter) =>
        `('fx-${counter}','yahoo-compatible','deployment',NULL,'deployment','AUD','USD','0.6700','eod','${date}T04:00:00.000Z','${date}','observed','2026-08-24T00:00:00.000Z')`,
    );
  db.exec(
    `INSERT INTO fx_rate_observations (id,provider_id,access_scope,scope_user_id,scope_key,base_currency_code,quote_currency_code,rate_decimal,interval,observed_at,market_date,quality,ingested_at) VALUES ${fxRows.join(",")};`,
  );
  return { db, dates };
}

test("BUG-012 F2: an FX-only gap (priced security, missing FX rate) is never persisted as unresolvable", async () => {
  const { db, dates } = await fxOnlyGapFixture();
  const gapDate = dates[FX_GAP_INDEX]!;
  const client = createSqliteSqlClient(db);

  const first = await loadHistoricalPortfolioValueSeries(
    client,
    "owner",
    "pf",
    NOW,
  );
  assert.ok(first);
  if (!first) return;
  // Honestly absent/null -- this call DID attempt the date, so it is
  // present with a null value, never a fabricated number.
  assert.equal(
    first.points.find((p) => p.date === gapDate)?.valueDecimal,
    null,
  );

  // The load-bearing F2 property: no row in the unresolvable table at all,
  // unlike a `no_priceable_security`/`no_holdings' gap.
  assert.deepEqual(unresolvedRows(db), []);
  db.close();
});

test("BUG-012 F2: the FX rate's later arrival resolves the gap on the very next read (never written off)", async () => {
  const { db, dates } = await fxOnlyGapFixture();
  const gapDate = dates[FX_GAP_INDEX]!;
  const client = createSqliteSqlClient(db);

  await loadHistoricalPortfolioValueSeries(client, "owner", "pf", NOW);
  assert.deepEqual(unresolvedRows(db), []);

  // A second read, still no FX for gapDate: still absent, still no mark --
  // proves this is a genuine "retry every call" gap, not a one-shot fluke.
  const stillMissing = await loadHistoricalPortfolioValueSeries(
    client,
    "owner",
    "pf",
    NOW,
  );
  assert.ok(stillMissing);
  if (!stillMissing) return;
  assert.equal(
    stillMissing.points.find((p) => p.date === gapDate)?.valueDecimal,
    null,
  );
  assert.deepEqual(unresolvedRows(db), []);

  // The FX rate arrives (a real FX import/refresh write -- direct insert
  // here since no dedicated FX-import writer exists to invoke; the
  // load-bearing property under test is the READ side never having
  // written the date off, not which writer supplies the rate).
  db.exec(
    `INSERT INTO fx_rate_observations (id,provider_id,access_scope,scope_user_id,scope_key,base_currency_code,quote_currency_code,rate_decimal,interval,observed_at,market_date,quality,ingested_at) VALUES
     ('fx-gap','yahoo-compatible','deployment',NULL,'deployment','AUD','USD','0.6800','eod','${gapDate}T04:00:00.000Z','${gapDate}','observed','2026-08-24T00:00:00.000Z');`,
  );

  const resolved = await loadHistoricalPortfolioValueSeries(
    client,
    "owner",
    "pf",
    NOW,
  );
  assert.ok(resolved);
  if (!resolved) return;
  // 100 shares * 10.00 USD / 0.6800 AUD-per-USD = 1470.5882... -- assert
  // only that it is resolved (non-null), not the exact rounding, since
  // that is FX-conversion domain logic outside this task's scope.
  assert.notEqual(
    resolved.points.find((p) => p.date === gapDate)?.valueDecimal,
    null,
  );
  const storedGapRow = db
    .prepare(
      `SELECT value_decimal FROM portfolio_value_history WHERE portfolio_id='pf' AND value_date=?`,
    )
    .get(gapDate) as { value_decimal: string } | undefined;
  assert.ok(storedGapRow, "the newly-resolvable date must now be stored");
  db.close();
});

// ---------------------------------------------------------------------------
// Review follow-up: a future-dated candidate must never be persisted as
// unresolvable -- it is "not yet due", not genuinely unresolvable, and
// nothing invalidates a mark on it just because time passes.
// ---------------------------------------------------------------------------

test("BUG-012 review follow-up: a future-dated candidate (the portfolio-timezone-vs-UTC edge, not a contrived clock) is never persisted as unresolvable", async () => {
  // A REAL trigger, not a contrived one: `resolveRange`'s `rangeTo` is
  // "today" in the PORTFOLIO's own timezone (`Australia/Sydney`, UTC+10 in
  // September -- outside AEDT), while `isFutureDate`
  // (`domain/snapshots/historical-portfolio-value.ts`) compares against
  // `now`'s UTC calendar day. At 20:00 UTC, Sydney local time has already
  // rolled over to the NEXT calendar day -- so `rangeTo` (and this
  // fixture's own priced "today" candidate) is one day AHEAD of what
  // `isFutureDate` considers "today", making that perfectly legitimate,
  // in-range, priced candidate date classify as future and return the
  // `heldSecurityCount: 0` placeholder object -- which, pre-fix,
  // `computeUnresolvedReason` reads as `'no_holdings'` and permanently
  // marks, even though the security IS held and WILL resolve once local
  // time catches up.
  const dates = weekdays("2026-08-20", 12); // dates[11] === '2026-09-04'
  assert.equal(dates[11], "2026-09-04");
  const db = await singleSecurityFixture(dates, [
    { type: "buy", date: dates[0]!, quantity: "100" },
  ]);
  const client = createSqliteSqlClient(db);
  const now = new Date("2026-09-03T20:00:00.000Z"); // Sydney local: 2026-09-04T06:00

  const read = await loadHistoricalPortfolioValueSeries(
    client,
    "owner",
    "pf",
    now,
  );
  assert.ok(read);
  if (!read) return;

  // The future-dated candidate must never be persisted as unresolvable --
  // the load-bearing property this follow-up exists to prove.
  assert.deepEqual(unresolvedRows(db), []);
  // This call DID attempt the date (it was inside `toDerive`), so -- matching
  // this file's own established "attempted this call" convention -- it is
  // present in `points` with an honestly null value, never fabricated and
  // never a stored row.
  assert.equal(
    read.points.find((p) => p.date === "2026-09-04")?.valueDecimal,
    null,
  );
  const storedFutureRow = db
    .prepare(
      `SELECT id FROM portfolio_value_history WHERE portfolio_id='pf' AND value_date='2026-09-04'`,
    )
    .get();
  assert.equal(storedFutureRow, undefined);
  db.close();
});
