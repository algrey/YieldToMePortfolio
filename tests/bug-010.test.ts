/**
 * BUG-010 -- Value-history cache wipe puts the site in a permanent Error
 * 1102 loop (owner-reported production OUTAGE, 2026-09-01).
 *
 * The failure, in one line: an accepted Sharesight batch committed the
 * owner's FULL trade history, so `db/repositories/import-commit.ts`'s
 * `finalize` issued its ranged `DELETE FROM portfolio_value_history ... WHERE
 * value_date >= <earliest trade date>` across essentially the whole series.
 * Every read then found ~2,600 missing candidate dates, tried to derive 400
 * of them, and was killed at the Workers-Free CPU limit BEFORE
 * `upsertStoredValueHistory` committed -- so the read persisted NOTHING and
 * the next read repeated identically. The loop could not self-heal because
 * escaping it cost more than the budget that killed it.
 *
 * These tests pin the two halves of the fix:
 *   (a) the read path's per-read derivation bound now fits the free plan's
 *       CPU allowance, so every read PERSISTS its slice and makes strictly
 *       forward progress;
 *   (b) the hourly cron (`app/value-history-backfill-service.ts`) rebuilds a
 *       wiped series with no page loads at all.
 *
 * ...and the invariant neither may break: a date the derivation cannot
 * resolve stays ABSENT and honest -- never zero, never interpolated.
 *
 * See `docs/ARCHITECTURE.md`'s BUG-010 entry for the measured basis of both
 * bounds and the verified Cloudflare CPU figures.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  backfillStoredValueHistoryForPortfolio,
  loadHistoricalPortfolioValueSeries,
  MAX_DERIVE_DATES_PER_READ,
} from "../app/historical-portfolio-value.ts";
import {
  CRON_MAX_BACKFILL_DATES_PER_TICK,
  CRON_MAX_BACKFILL_PORTFOLIOS_PER_TICK,
  sweepValueHistoryBackfill,
} from "../app/value-history-backfill-service.ts";

const NOW = new Date("2026-09-01T00:00:00Z");

/**
 * Cloudflare Workers FREE CPU allowance per invocation, VERIFIED 2026-09-01
 * against <https://developers.cloudflare.com/workers/platform/limits/>:
 *
 *     CPU time per HTTP request   Free: 10 ms   Paid: 5 min (default 30 s)
 *     CPU time per Cron Trigger   Free: 10 ms   Paid: 30 s / 15 min
 *
 * Note the CRON row: the "scheduled handler gets materially more CPU"
 * asymmetry is a PAID-plan property only. `wrangler.json` deploys production
 * with `YIELDTOME_WORKERS_PLAN: "free"`, so BOTH halves of BUG-010's fix are
 * sized against the same 10ms.
 */
const FREE_PLAN_CPU_BUDGET_MS = 10;

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

/** Starts just inside `resolveRange`'s own MAX_CANDIDATE_DATES-derived
 * ~10-year floor for `NOW`, so all 2,600 dates are genuine candidates and
 * none is silently clamped away. */
const PRODUCTION_SCALE_DATES = weekdays("2016-09-01", 2600);
const PRODUCTION_SCALE_SECURITIES = 18;

/**
 * The exact scale BUG-010's acceptance criteria name, and the same scale
 * `tests/hist-001.test.ts`'s B1 pin models one notch smaller: 18 held
 * securities (the owner's real count) sharing ~2,600 common trading dates
 * (~10 years of weekday EOD closes), 46,800 price rows. One buy per
 * security on the first date, so every candidate date is genuinely
 * resolvable -- an unresolvable-date fixture is built separately below.
 */
async function productionScaleFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  const dates = PRODUCTION_SCALE_DATES;
  const ids = Array.from(
    { length: PRODUCTION_SCALE_SECURITIES },
    (_, index) => `sec-${index}`,
  );
  db.exec(
    [
      `INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);`,
      `INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES('owner','active','owner@example.test','Australia/Sydney','2026-08-01','2026-08-01');`,
      `INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES('pf','owner','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');`,
      `INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES('asx','XASX','Australian Securities Exchange','AU','Australia/Sydney','XASX');`,
      `INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES ${ids
        .map(
          (id) =>
            `('${id}','equity','asx','AUD','Security ${id}','2026-08-01','2026-08-01')`,
        )
        .join(",")};`,
      `INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES ${ids
        .map(
          (id) =>
            `('ps-${id}','owner','pf','${id}','${id}','AUD','held','2026-08-01','2026-08-01')`,
        )
        .join(",")};`,
      `INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES ${ids
        .map(
          (id) =>
            `('map-${id}','${id}','owner-import','ASX','${id}','2015-01-01','verified')`,
        )
        .join(",")};`,
      `INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES ${ids
        .map(
          (id) =>
            `('tx-${id}','owner','pf','ps-${id}','buy','posted','${dates[0]}T00:00:00Z','${dates[0]}','100','10','AUD','1000','0','0','manual','owner',1,'${dates[0]}')`,
        )
        .join(",")};`,
    ].join("\n"),
  );
  const priceRows: string[] = [];
  let counter = 0;
  for (const id of ids) {
    for (const date of dates) {
      counter += 1;
      priceRows.push(
        `('price-${counter}','owner-import','user','owner','owner','map-${id}','${id}','eod','${date}T04:00:00.000Z','${date}','Australia/Sydney','AUD','10.${(counter % 100).toString().padStart(2, "0")}','raw','observed','2026-08-24T00:00:00.000Z')`,
      );
    }
  }
  for (let index = 0; index < priceRows.length; index += 1000) {
    db.exec(
      `INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES ${priceRows
        .slice(index, index + 1000)
        .join(",")};`,
    );
  }
  return db;
}

/** Built once -- 46,800 price rows is several seconds of fixture setup, and
 * every test below either starts from an EMPTY store (the wiped-cache shape
 * the outage produced) or restores it explicitly. */
let sharedDb: DatabaseSync | null = null;
async function productionScale(): Promise<{
  db: DatabaseSync;
  client: SqlClient;
}> {
  sharedDb ??= await productionScaleFixture();
  const db = sharedDb;
  db.exec("DELETE FROM portfolio_value_history;");
  return { db, client: createSqliteSqlClient(db) };
}

/** Splits a read's WALL time into D1 time (network wait in production, NOT
 * Worker CPU) and app-side time (row mapping/validation, derivation, upsert
 * statement construction -- the part that IS Worker CPU and the part the
 * bound has to fit). */
function timedClient(inner: SqlClient): {
  client: SqlClient;
  sqlMs: () => number;
  reset: () => void;
} {
  let sqlMs = 0;
  const wrap = <A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
  ): ((...args: A) => Promise<R>) => {
    return async (...args: A) => {
      const startedAt = performance.now();
      try {
        return await fn(...args);
      } finally {
        sqlMs += performance.now() - startedAt;
      }
    };
  };
  return {
    client: {
      all: wrap(inner.all.bind(inner)),
      get: wrap(inner.get.bind(inner)),
      run: wrap(inner.run.bind(inner)),
      batch: wrap(inner.batch.bind(inner)),
    } as SqlClient,
    sqlMs: () => sqlMs,
    reset: () => {
      sqlMs = 0;
    },
  };
}

function storedRowCount(db: DatabaseSync, portfolioId = "pf"): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM portfolio_value_history WHERE portfolio_id = ?`,
    )
    .get(portfolioId) as { c: number };
  return row.c;
}

// ---------------------------------------------------------------------------
// (a) The read path fits the free-plan CPU budget and makes forward progress.
// ---------------------------------------------------------------------------

test("BUG-010: the per-read derivation bound is sized against the Workers FREE 10ms-per-invocation CPU allowance -- raising it back toward 400 is a regression into the outage", () => {
  // Measured for BUG-010 on the production-scale fixture below (18
  // securities), separating D1 time from app-side CPU: the MARGINAL cost of
  // one more derived candidate date is ~0.26ms, of which ~0.17ms is
  // `computeHistoricalPortfolioValueSeries` itself. Linear from 10 dates to
  // 400. The ~0.05ms/date figure `docs/ARCHITECTURE.md` §9.2 recorded does
  // NOT hold for the current code -- see that file's BUG-010 entry.
  //
  // At the old bound of 400 that marginal rate alone is ~104ms: ~10x the
  // free plan's WHOLE per-invocation allowance, which is why a wiped cache
  // became a permanent Error 1102 loop rather than a slow rebuild. (A whole
  // derivation read also carries a per-read fixed cost that no bound
  // reduces; the measurement test below logs the end-to-end figure.)
  const MEASURED_MARGINAL_MS_PER_DATE = 0.26;
  const budgetShare =
    (MAX_DERIVE_DATES_PER_READ * MEASURED_MARGINAL_MS_PER_DATE) /
    FREE_PLAN_CPU_BUDGET_MS;
  assert.ok(
    budgetShare <= 0.35,
    `the per-read derive bound must leave the rest of the render its own CPU: ${MAX_DERIVE_DATES_PER_READ} dates x ${MEASURED_MARGINAL_MS_PER_DATE}ms = ${(MAX_DERIVE_DATES_PER_READ * MEASURED_MARGINAL_MS_PER_DATE).toFixed(1)}ms, ${(budgetShare * 100).toFixed(0)}% of the free plan's ${FREE_PLAN_CPU_BUDGET_MS}ms`,
  );
  // The cron tick is sized against the SAME 10ms (Cloudflare gives the
  // scheduled handler no extra CPU on the free plan) -- it may take a larger
  // share only because it has no render work of its own to pay for.
  assert.ok(
    (CRON_MAX_BACKFILL_DATES_PER_TICK * MEASURED_MARGINAL_MS_PER_DATE) /
      FREE_PLAN_CPU_BUDGET_MS <=
      0.6,
    "the cron tick's date budget must fit the same free-plan 10ms allowance",
  );
});

test("BUG-010 (the outage itself): with portfolio_value_history WIPED at production scale, every read derives a bounded slice, PERSISTS it, and strictly increases stored coverage -- the forward progress the 1102 loop destroyed", async () => {
  const { db, client } = await productionScale();
  assert.equal(storedRowCount(db), 0);

  let previousStored = 0;
  for (let read = 1; read <= 6; read += 1) {
    const result = await loadHistoricalPortfolioValueSeries(
      client,
      "owner",
      "pf",
      NOW,
    );
    assert.ok(result);
    if (!result) return;
    const stored = storedRowCount(db);
    // The defect: the read was killed before it could commit, so this count
    // never moved. It must now move on EVERY read.
    assert.ok(
      stored > previousStored,
      `read ${read} made no forward progress (stored stayed at ${stored})`,
    );
    // ...and by no more than one bound's worth, so no single read can ever
    // reintroduce a slice too large to finish.
    assert.equal(stored - previousStored, MAX_DERIVE_DATES_PER_READ);
    assert.equal(result.points.length, stored);
    assert.equal(result.backfillPending, true);
    previousStored = stored;
  }
  // Newest-first: the dates an owner is most likely looking at come back
  // first, and the series is honestly short rather than fabricated.
  const newest = PRODUCTION_SCALE_DATES[PRODUCTION_SCALE_DATES.length - 1]!;
  const covered = db
    .prepare(
      `SELECT MIN(value_date) AS lo, MAX(value_date) AS hi FROM portfolio_value_history`,
    )
    .get() as { lo: string; hi: string };
  assert.equal(covered.hi, newest);
});

test("BUG-010: one read's derivation slice at production scale costs a small fraction of the free-plan CPU budget -- the old 400-date bound measured ~104ms of app-side CPU on the same fixture", async () => {
  const { db, client: rawClient } = await productionScale();
  const timed = timedClient(rawClient);

  // Warm the code paths first (JIT), then take the MEDIAN of several slices
  // -- a single cold sample on a shared runner is noise, not a measurement.
  await loadHistoricalPortfolioValueSeries(timed.client, "owner", "pf", NOW);
  const samples: number[] = [];
  for (let slice = 0; slice < 5; slice += 1) {
    timed.reset();
    const startedAt = performance.now();
    const result = await loadHistoricalPortfolioValueSeries(
      timed.client,
      "owner",
      "pf",
      NOW,
    );
    samples.push(performance.now() - startedAt - timed.sqlMs());
    assert.ok(result);
  }
  samples.sort((left, right) => left - right);
  const appMs = samples[Math.floor(samples.length / 2)]!;
  assert.equal(storedRowCount(db), MAX_DERIVE_DATES_PER_READ * 6);

  // GENEROUS ceiling, in the style of `tests/hist-001.test.ts`'s B1 pin:
  // ~2.6ms measured on a dev machine for this bound, versus ~104ms for the
  // 400-date bound that caused the outage. 20ms still fails decisively if
  // the bound (or the per-date cost) regresses toward that shape, while
  // leaving ~7x headroom for a slower CI machine.
  assert.ok(
    appMs < 20,
    `expected the bounded derive slice to cost well under 20ms of app-side CPU, took ${appMs.toFixed(1)}ms`,
  );
  console.log(
    `BUG-010 measurement: ${appMs.toFixed(2)}ms app-side CPU to derive+persist ${MAX_DERIVE_DATES_PER_READ} candidate dates at 18 securities/${PRODUCTION_SCALE_DATES.length} candidate dates (${(appMs / MAX_DERIVE_DATES_PER_READ).toFixed(3)}ms/date).`,
  );
});

test("BUG-010: a fully-backfilled portfolio's steady-state read is unchanged -- the stored-only fast path, no derivation, no price_observations read, no writes", async () => {
  const { db, client } = await productionScale();
  // Backfill to completion through the cron entry point (the same
  // mechanism), then measure the steady-state read.
  for (let tick = 0; tick < 40; tick += 1) {
    const outcome = await backfillStoredValueHistoryForPortfolio(
      client,
      "owner",
      "pf",
      500,
      NOW,
    );
    assert.ok(outcome);
    if (!outcome?.backfillPending) break;
  }
  const storedBefore = storedRowCount(db);
  assert.equal(storedBefore, PRODUCTION_SCALE_DATES.length);

  const touchedTables: string[] = [];
  const writes: string[] = [];
  const observing: SqlClient = {
    all: async (sql, params) => {
      touchedTables.push(sql);
      return client.all(sql, params);
    },
    get: async (sql, params) => {
      touchedTables.push(sql);
      return client.get(sql, params);
    },
    run: async (sql, params) => {
      writes.push(sql);
      return client.run(sql, params);
    },
    batch: async (statements) => {
      for (const statement of statements) writes.push(statement.sql);
      return client.batch(statements);
    },
  };
  const result = await loadHistoricalPortfolioValueSeries(
    observing,
    "owner",
    "pf",
    NOW,
  );
  assert.ok(result);
  if (!result) return;
  assert.equal(result.backfillPending, false);
  assert.equal(result.points.length, PRODUCTION_SCALE_DATES.length);
  assert.equal(writes.length, 0, "a fully-backfilled read must not write");
  // PRF-002's fast path: only the lightweight DISTINCT market_date probe
  // touches price_observations, never the full column read `loadFacts` does.
  const fullPriceReads = touchedTables.filter((sql) =>
    sql.includes("SELECT po.* FROM price_observations"),
  );
  assert.equal(fullPriceReads.length, 0);
  assert.equal(storedRowCount(db), storedBefore);
});

// ---------------------------------------------------------------------------
// (b) The hourly cron rebuilds a wiped series with no page loads at all.
// ---------------------------------------------------------------------------

test("BUG-010: the hourly cron backfill converges a WIPED production-scale series with zero page loads, bounded to its per-tick date budget", async () => {
  const { db, client } = await productionScale();
  assert.equal(storedRowCount(db), 0);

  let previousStored = 0;
  let ticks = 0;
  // A full 2,600-date rebuild at the real per-tick budget is ~130 hourly
  // ticks (recorded honestly in docs/ARCHITECTURE.md's BUG-010 entry); this
  // drill proves the per-tick bound and strict forward progress over the
  // first several ticks, then finishes with a larger explicit budget to
  // prove the sweep actually reaches full coverage and then stops deriving.
  for (; ticks < 5; ticks += 1) {
    const summary = await sweepValueHistoryBackfill(
      { client },
      { now: new Date(NOW.getTime() + ticks * 3_600_000) },
    );
    assert.equal(summary.portfoliosConsidered, 1);
    assert.equal(summary.portfoliosAdvanced, 1);
    assert.equal(summary.portfoliosPending, 1);
    assert.equal(summary.portfoliosFailed, 0);
    assert.ok(
      summary.datesDerived <= CRON_MAX_BACKFILL_DATES_PER_TICK,
      `a tick derived ${summary.datesDerived} dates, over its ${CRON_MAX_BACKFILL_DATES_PER_TICK}-date budget`,
    );
    assert.equal(summary.rowsPersisted, summary.datesDerived);
    const stored = storedRowCount(db);
    assert.equal(stored - previousStored, summary.rowsPersisted);
    assert.ok(stored > previousStored, "a cron tick made no forward progress");
    previousStored = stored;
  }
  // The cron sweeps the OLDEST missing dates while the read sweeps the
  // newest -- so a wiped series rebuilds from both ends (and an unresolvable
  // run at one end cannot stall the other).
  const covered = db
    .prepare(
      `SELECT MIN(value_date) AS lo, MAX(value_date) AS hi FROM portfolio_value_history`,
    )
    .get() as { lo: string; hi: string };
  assert.equal(covered.lo, PRODUCTION_SCALE_DATES[0]);
  assert.equal(
    covered.hi,
    PRODUCTION_SCALE_DATES[CRON_MAX_BACKFILL_DATES_PER_TICK * 5 - 1],
  );

  for (let extra = 0; extra < 40; extra += 1) {
    const summary = await sweepValueHistoryBackfill(
      { client },
      { maxDatesPerTick: 500, now: NOW },
    );
    if (summary.portfoliosPending === 0) break;
  }
  assert.equal(storedRowCount(db), PRODUCTION_SCALE_DATES.length);
  // Converged: a further tick derives nothing at all and writes nothing.
  const settled = await sweepValueHistoryBackfill({ client }, { now: NOW });
  assert.equal(settled.datesDerived, 0);
  assert.equal(settled.rowsPersisted, 0);
  assert.equal(settled.portfoliosPending, 0);
  assert.equal(settled.portfoliosAdvanced, 0);
});

// ---------------------------------------------------------------------------
// Honesty, ownership, and failure isolation (small, controlled fixtures).
// ---------------------------------------------------------------------------

/** Two owners, one portfolio each, identical security/date grid -- plus, for
 * owner A only, a second security that is NEVER held but DOES have price
 * history after A sold out, so A's last few candidate dates are genuinely
 * unresolvable. */
async function twoOwnerFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  const dates = weekdays("2024-01-01", 20);
  const rows: string[] = [
    `INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);`,
    `INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
       ('owner-a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01'),
       ('owner-b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');`,
    `INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
       ('pf-a','owner-a','A','A','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
       ('pf-b','owner-b','B','B','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');`,
    `INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES('asx','XASX','ASX','AU','Australia/Sydney','XASX');`,
    `INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
       ('sec-1','equity','asx','AUD','One','2026-08-01','2026-08-01'),
       ('sec-2','equity','asx','AUD','Two','2026-08-01','2026-08-01');`,
    `INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
       ('ps-a1','owner-a','pf-a','sec-1','ONE','AUD','held','2026-08-01','2026-08-01'),
       ('ps-a2','owner-a','pf-a','sec-2','TWO','AUD','held','2026-08-01','2026-08-01'),
       ('ps-b1','owner-b','pf-b','sec-1','ONE','AUD','held','2026-08-01','2026-08-01');`,
    `INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
       ('map-1','sec-1','owner-import','ASX','ONE','2023-01-01','verified'),
       ('map-2','sec-2','owner-import','ASX','TWO','2023-01-01','verified');`,
    // Owner A buys sec-1 on day 1 and sells the WHOLE holding on day 10;
    // sec-2 is listed on the portfolio but never traded. Owner B holds
    // sec-1 throughout.
    `INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
       ('tx-a1','owner-a','pf-a','ps-a1','buy','posted','${dates[0]}T00:00:00Z','${dates[0]}','100','10','AUD','1000','0','0','manual','owner-a',1,'${dates[0]}'),
       ('tx-a2','owner-a','pf-a','ps-a1','sell','posted','${dates[9]}T00:00:00Z','${dates[9]}','100','10','AUD','1000','0','0','manual','owner-a',1,'${dates[9]}'),
       ('tx-b1','owner-b','pf-b','ps-b1','buy','posted','${dates[0]}T00:00:00Z','${dates[0]}','50','10','AUD','500','0','0','manual','owner-b',1,'${dates[0]}');`,
  ];
  db.exec(rows.join("\n"));
  const priceRows: string[] = [];
  let counter = 0;
  for (const [securityId, mappingId] of [
    ["sec-1", "map-1"],
    ["sec-2", "map-2"],
  ] as const) {
    for (const date of dates) {
      counter += 1;
      priceRows.push(
        `('price-${counter}','owner-import','deployment',NULL,'deployment','${mappingId}','${securityId}','eod','${date}T04:00:00.000Z','${date}','Australia/Sydney','AUD','10.00','raw','observed','2026-08-24T00:00:00.000Z')`,
      );
    }
  }
  db.exec(
    `INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES ${priceRows.join(",")};`,
  );
  return db;
}

test("BUG-010 honesty: a candidate date the derivation genuinely cannot resolve is never stored and never fabricated -- it stays absent, and the cron reports the shortfall rather than counting it as progress", async () => {
  const db = await twoOwnerFixture();
  const client = createSqliteSqlClient(db);
  const dates = weekdays("2024-01-01", 20);

  // Owner A sold out on `dates[9]`, so from `dates[10]` on nothing is held;
  // sec-2 still has prices there, so those dates are CANDIDATES that cannot
  // resolve to any value.
  const outcome = await backfillStoredValueHistoryForPortfolio(
    client,
    "owner-a",
    "pf-a",
    100,
    NOW,
  );
  assert.ok(outcome);
  if (!outcome) return;
  assert.equal(outcome.candidateDates, dates.length);
  assert.equal(outcome.datesDerived, dates.length);
  // The sale on `dates[9]` empties the holding AS OF that date, so only the
  // nine dates before it resolve; the eleven from `dates[9]` on are
  // candidates (sec-2 is priced there) that no held security can value.
  assert.equal(outcome.rowsPersisted, 9);
  assert.ok(outcome.rowsPersisted < outcome.datesDerived);

  const storedDates = (
    db
      .prepare(
        `SELECT value_date, value_decimal FROM portfolio_value_history WHERE portfolio_id = 'pf-a' ORDER BY value_date`,
      )
      .all() as { value_date: string; value_decimal: string }[]
  ).map((row) => row.value_date);
  assert.deepEqual(storedDates, dates.slice(0, 9));
  const fabricated = db
    .prepare(
      `SELECT COUNT(*) AS c FROM portfolio_value_history WHERE portfolio_id = 'pf-a' AND value_date >= ?`,
    )
    .get(dates[9]) as { c: number };
  assert.equal(fabricated.c, 0, "an unresolvable date must never be stored");

  const series = await loadHistoricalPortfolioValueSeries(
    client,
    "owner-a",
    "pf-a",
    NOW,
  );
  assert.ok(series);
  if (!series) return;
  for (const point of series.points) {
    if (point.date < dates[9]!) continue;
    // Present-but-unresolved renders as a genuine gap, NEVER as zero.
    assert.equal(point.valueDecimal, null);
  }
});

test("BUG-010 ownership: the cron sweep derives each portfolio strictly under its OWN owner -- a tick never writes a row attributed to another user", async () => {
  const db = await twoOwnerFixture();
  const client = createSqliteSqlClient(db);
  for (let tick = 0; tick < 6; tick += 1) {
    await sweepValueHistoryBackfill(
      { client },
      { maxDatesPerTick: 100, now: new Date(NOW.getTime() + tick * 3_600_000) },
    );
  }
  const rows = (
    db
      .prepare(
        `SELECT DISTINCT user_id, portfolio_id FROM portfolio_value_history ORDER BY portfolio_id`,
      )
      .all() as { user_id: string; portfolio_id: string }[]
  ).map((row) => ({ user_id: row.user_id, portfolio_id: row.portfolio_id }));
  assert.deepEqual(rows, [
    { user_id: "owner-a", portfolio_id: "pf-a" },
    { user_id: "owner-b", portfolio_id: "pf-b" },
  ]);
  const crossOwner = db
    .prepare(
      `SELECT COUNT(*) AS c FROM portfolio_value_history h
       JOIN portfolios p ON p.id = h.portfolio_id
       WHERE p.user_id <> h.user_id`,
    )
    .get() as { c: number };
  assert.equal(crossOwner.c, 0);
});

test("BUG-010: a portfolio whose slice throws (the account-purge lock's RAISE(ABORT) is the real case) is reported and skipped -- it never takes the whole tick down with it", async () => {
  const db = await twoOwnerFixture();
  const raw = createSqliteSqlClient(db);
  const failing: SqlClient = {
    all: raw.all.bind(raw),
    get: raw.get.bind(raw),
    run: raw.run.bind(raw),
    batch: async (statements) => {
      if (
        statements.some((statement) =>
          (statement.params ?? []).some((param) => param === "pf-a"),
        )
      ) {
        throw new Error("account_purge_source_locked");
      }
      return raw.batch(statements);
    },
  };
  const summary = await sweepValueHistoryBackfill(
    { client: failing },
    { maxDatesPerTick: 100, now: NOW },
  );
  assert.equal(summary.portfoliosFailed, 1);
  assert.ok(summary.portfoliosConsidered >= 2);
  // The OTHER owner still got their slice this tick.
  assert.ok(summary.rowsPersisted > 0);
  const rows = (
    db
      .prepare(
        `SELECT DISTINCT portfolio_id FROM portfolio_value_history ORDER BY portfolio_id`,
      )
      .all() as { portfolio_id: string }[]
  ).map((row) => row.portfolio_id);
  assert.deepEqual(rows, ["pf-b"]);
});

test("BUG-010: the cron's per-tick date budget is a TOTAL across portfolios, not a per-portfolio allowance -- a deployment with more portfolios cannot multiply the tick's CPU", async () => {
  const db = await twoOwnerFixture();
  const client = createSqliteSqlClient(db);
  const summary = await sweepValueHistoryBackfill(
    { client },
    { maxDatesPerTick: 12, now: NOW },
  );
  assert.ok(summary.portfoliosConsidered >= 1);
  assert.ok(
    summary.datesDerived <= 12,
    `derived ${summary.datesDerived} dates against a 12-date tick budget`,
  );
  assert.ok(
    CRON_MAX_BACKFILL_PORTFOLIOS_PER_TICK >= 1,
    "the per-tick portfolio cap must allow at least one portfolio",
  );
});
