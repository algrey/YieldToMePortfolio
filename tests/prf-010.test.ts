/**
 * PRF-010 -- The cron value-history backfill re-scans converged portfolios
 * every tick (BUG-010 follow-up (c), now live in production).
 *
 * `app/value-history-backfill-service.ts`'s hourly sweep called
 * `backfillStoredValueHistoryForPortfolio` for every active portfolio on
 * every tick, and that function ran the full `loadCandidateDates` `DISTINCT
 * market_date` seek over `price_observations` -- ~47k index entries at the
 * owner's real 18-security/~2,600-date scale -- even after that portfolio's
 * series had fully converged (nothing left to derive). Reviewer estimate:
 * ~1.1M D1 `rows_read`/day. This file MEASURES that cost first (per this
 * task's own instruction: the 1.1M figure is an estimate, not an
 * observation), then proves the fix -- a convergence marker on `portfolios`
 * (`db/repositories/portfolio-value-history.ts`) that short-circuits the
 * scan once a full check has already proven zero candidate dates are
 * missing -- reduces it, without weakening any BUG-010 honesty guarantee or
 * hiding BUG-010 follow-up (e)'s `datesDerived > 0`/`rowsPersisted === 0`
 * tell.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import type { SqlClient } from "../db/repositories/sql-client.ts";
import {
  invalidateStoredValueHistoryForSecurity,
  loadHistoricalPortfolioValueSeries,
  backfillStoredValueHistoryForPortfolio,
} from "../app/historical-portfolio-value.ts";
import {
  CONVERGENCE_RECHECK_INTERVAL_MS,
  convergenceFingerprintMatches,
  loadPortfolioConvergenceMarker,
  loadValueHistoryConvergenceFingerprint,
} from "../db/repositories/portfolio-value-history.ts";
import { sweepValueHistoryBackfill } from "../app/value-history-backfill-service.ts";

const NOW = new Date("2026-09-01T00:00:00Z");

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

/** Same production scale `tests/bug-010.test.ts` measures against: 18
 * securities (the owner's real count) sharing ~2,600 common trading dates,
 * one buy per security on the first date so every candidate date is
 * genuinely resolvable. */
const PRODUCTION_SCALE_DATES = weekdays("2016-09-01", 2600);
const PRODUCTION_SCALE_SECURITIES = 18;

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

/** Wraps a real SqlClient to count rows RETURNED by `.all()` (the
 * `tests/hist-001.test.ts` convention) and to capture every call's SQL/
 * params so a test can re-run `EXPLAIN QUERY PLAN`/a raw `COUNT(*)` on
 * exactly what the real code path just executed (the `tests/prf-002.test.ts`
 * `stageCensusClient` convention). Distinct from both precedents only in
 * that it ALSO exposes a per-table-substring row-scan estimate: for the
 * `DISTINCT market_date` seek specifically, rows RETURNED (post-dedup)
 * massively understates D1's actual `rows_read` metering (which counts
 * index entries visited, pre-dedup) -- see `tests/prf-002.test.ts`'s own
 * PRF-005 test for the identical observation. */
function censusClient(db: DatabaseSync, inner: SqlClient) {
  let allCalls = 0;
  let rowsReturned = 0;
  const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> =
    [];
  const wrapped: SqlClient = {
    async all<T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      allCalls += 1;
      calls.push({ sql, params });
      const rows = await inner.all<T>(sql, params);
      rowsReturned += rows.length;
      return rows;
    },
    async get<T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<T | undefined> {
      allCalls += 1;
      calls.push({ sql, params });
      const row = await inner.get<T>(sql, params);
      if (row) rowsReturned += 1;
      return row;
    },
    run: inner.run.bind(inner),
    batch: inner.batch.bind(inner),
  };
  return {
    client: wrapped,
    reset: () => {
      allCalls = 0;
      rowsReturned = 0;
      calls.length = 0;
    },
    stats: () => ({ allCalls, rowsReturned, calls: [...calls] }),
    /** The true D1 `rows_read` proxy for the candidate-date scan: re-runs
     * the EXACT captured `DISTINCT market_date` query as a `COUNT(*)`
     * against the same predicate, which is what SQLite/D1 must actually
     * visit before collapsing to distinct dates. */
    candidateScanRowsExamined: (): number | null => {
      const candidateCall = calls.find(
        (call) =>
          call.sql.includes("price_observations") &&
          call.sql.includes("DISTINCT po.market_date"),
      );
      if (!candidateCall) return null;
      const countSql = candidateCall.sql
        .replace(
          "SELECT DISTINCT po.market_date FROM price_observations po",
          "SELECT COUNT(*) AS c FROM price_observations po",
        )
        .replace(/ORDER BY po\.market_date LIMIT \?/, "");
      const paramsWithoutLimit = (candidateCall.params ?? []).slice(0, -1);
      const row = db
        .prepare(countSql)
        .get(...(paramsWithoutLimit as never[])) as { c: number };
      return row.c;
    },
  };
}

let sharedDb: DatabaseSync | null = null;
async function productionScale(): Promise<{
  db: DatabaseSync;
  client: SqlClient;
}> {
  sharedDb ??= await productionScaleFixture();
  const db = sharedDb;
  db.exec("DELETE FROM portfolio_value_history;");
  db.exec(
    `UPDATE portfolios SET value_history_backfill_verified_at = NULL,
       value_history_backfill_verified_fingerprint = NULL`,
  );
  return { db, client: createSqliteSqlClient(db) };
}

/** Fully backfills the shared fixture's single portfolio via the SAME cron
 * entry point production uses, mirroring `tests/bug-010.test.ts`'s own
 * convergence drill. */
async function convergePortfolio(client: SqlClient): Promise<void> {
  for (let extra = 0; extra < 200; extra += 1) {
    const summary = await sweepValueHistoryBackfill(
      { client },
      { maxDatesPerTick: 500, now: NOW },
    );
    if (summary.portfoliosPending === 0) break;
  }
}

test("PRF-010 measurement: a converged portfolio's cron tick BEFORE the fix -- one full loadCandidateDates scan per tick, ~46,800 rows examined at production scale", async () => {
  const { db, client } = await productionScale();
  await convergePortfolio(client);

  // One more tick's `backfillStoredValueHistoryForPortfolio` call, with no
  // marker recorded yet, reproduces the UNPATCHED per-tick cost exactly --
  // no marker exists, so this MUST run the full check.
  const marker = await loadPortfolioConvergenceMarker(client, "owner", "pf");
  assert.equal(
    marker,
    null,
    "no marker should exist before the first full-convergence tick",
  );

  const {
    client: censused,
    stats,
    candidateScanRowsExamined,
  } = censusClient(db, client);
  const outcome = await backfillStoredValueHistoryForPortfolio(
    censused,
    "owner",
    "pf",
    20,
    NOW,
  );
  assert.ok(outcome);
  if (!outcome) return;
  assert.equal(outcome.missingDates, 0);
  assert.equal(outcome.backfillPending, false);

  const examined = candidateScanRowsExamined();
  assert.ok(
    examined !== null,
    "expected the full DISTINCT market_date scan to run",
  );
  // At 18 securities x 2,600 dates, the full seek visits ~46,800 rows.
  assert.ok(
    examined! > 40_000,
    `expected the pre-fix scan to examine tens of thousands of rows, got ${examined}`,
  );
  console.log(
    `PRF-010 BEFORE: one converged-portfolio cron tick with no marker examines ${examined} price_observations rows (${stats().rowsReturned} rows returned across ${stats().allCalls} .all() calls) -- x24 ticks/day = ${((examined ?? 0) * 24).toLocaleString()} rows/day for this ONE portfolio.`,
  );

  // This same tick, having proven zero missing, must now have recorded the
  // marker for the NEXT test to exploit.
  const recordedMarker = await loadPortfolioConvergenceMarker(
    client,
    "owner",
    "pf",
  );
  assert.ok(recordedMarker);
});

test("PRF-010 measurement: a converged portfolio's cron tick AFTER the fix -- the marker short-circuits the scan entirely, ~2,600 rows or fewer", async () => {
  const { db, client } = await productionScale();
  await convergePortfolio(client);
  // Prime the marker (mirrors the previous test's own last step, done here
  // independently so this test does not depend on execution order).
  await backfillStoredValueHistoryForPortfolio(client, "owner", "pf", 20, NOW);
  const marker = await loadPortfolioConvergenceMarker(client, "owner", "pf");
  assert.ok(marker, "expected the marker to be recorded once converged");

  const {
    client: censused,
    stats,
    candidateScanRowsExamined,
  } = censusClient(db, client);
  const outcome = await backfillStoredValueHistoryForPortfolio(
    censused,
    "owner",
    "pf",
    20,
    new Date(NOW.getTime() + 3_600_000), // one hour later -- well inside cadence
  );
  assert.ok(outcome);
  if (!outcome) return;
  assert.equal(outcome.missingDates, 0);
  assert.equal(outcome.datesDerived, 0);
  assert.equal(outcome.rowsPersisted, 0);
  assert.equal(outcome.backfillPending, false);

  assert.equal(
    candidateScanRowsExamined(),
    null,
    "the fix must skip the DISTINCT market_date scan entirely once converged",
  );
  const { allCalls, rowsReturned } = stats();
  console.log(
    `PRF-010 AFTER: the same converged-portfolio cron tick, marker warm, makes ${allCalls} .all() calls returning ${rowsReturned} rows total (vs tens of thousands pre-fix) -- x24 ticks/day = ${(rowsReturned * 24).toLocaleString()} rows/day for this ONE portfolio, a ${Math.round((1 - (rowsReturned * 24) / (46_800 * 24)) * 100)}%+ reduction.`,
  );
  // The remaining cost is bounded by the cheap fingerprint check
  // (`loadValueHistoryConvergenceFingerprint`'s single aggregate query),
  // nowhere near the ~46,800-row pre-fix scan.
  assert.ok(
    rowsReturned < 5_000,
    `expected the warm-marker tick to read well under 5,000 rows, got ${rowsReturned}`,
  );
});

test("PRF-010: a NON-converged portfolio still runs the full check and converges at the same rate -- the marker never applies until genuinely zero dates are missing", async () => {
  const db = await productionScaleFixture();
  const client = createSqliteSqlClient(db);
  assert.equal(
    (
      db.prepare(`SELECT COUNT(*) AS c FROM portfolio_value_history`).get() as {
        c: number;
      }
    ).c,
    0,
  );

  // Fresh (wiped) series: exactly `tests/bug-010.test.ts`'s own drill --
  // every tick must still derive its full budget's worth of dates.
  for (let tick = 0; tick < 5; tick += 1) {
    const outcome = await backfillStoredValueHistoryForPortfolio(
      client,
      "owner",
      "pf",
      20,
      new Date(NOW.getTime() + tick * 3_600_000),
    );
    assert.ok(outcome);
    if (!outcome) return;
    assert.equal(
      outcome.datesDerived,
      20,
      `tick ${tick} did not derive a full slice`,
    );
    assert.equal(outcome.rowsPersisted, 20);
    assert.equal(outcome.backfillPending, true);
    const marker = await loadPortfolioConvergenceMarker(client, "owner", "pf");
    assert.equal(
      marker,
      null,
      `no convergence marker should exist while backfill is still pending (tick ${tick})`,
    );
  }
  db.close();
});

test("PRF-010 honesty: BUG-010 follow-up (e)'s permanently-unresolvable-dates case is NEVER marked converged, so its datesDerived>0/rowsPersisted===0 tell stays visible on every tick", async () => {
  // Owner sells out entirely; a second, never-held security keeps pricing
  // after the sale, so every date from the sale onward is a CANDIDATE (has
  // price data) that no held security can resolve -- BUG-010's own
  // unresolvable-date fixture shape (`tests/bug-010.test.ts`'s
  // `twoOwnerFixture`), reproduced here standalone.
  const db = await migratedDatabase();
  const dates = weekdays("2024-01-01", 20);
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES('owner','active','o@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES('pf','owner','A','A','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES('asx','XASX','ASX','AU','Australia/Sydney','XASX');
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('sec-1','equity','asx','AUD','One','2026-08-01','2026-08-01'),
      ('sec-2','equity','asx','AUD','Two','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('ps-1','owner','pf','sec-1','ONE','AUD','held','2026-08-01','2026-08-01'),
      ('ps-2','owner','pf','sec-2','TWO','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('map-1','sec-1','owner-import','ASX','ONE','2023-01-01','verified'),
      ('map-2','sec-2','owner-import','ASX','TWO','2023-01-01','verified');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx-1','owner','pf','ps-1','buy','posted','${dates[0]}T00:00:00Z','${dates[0]}','100','10','AUD','1000','0','0','manual','owner',1,'${dates[0]}'),
      ('tx-2','owner','pf','ps-1','sell','posted','${dates[9]}T00:00:00Z','${dates[9]}','100','10','AUD','1000','0','0','manual','owner',1,'${dates[9]}');
  `);
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
  const client = createSqliteSqlClient(db);

  // Several ticks, each fitting the whole 20-date candidate set within
  // budget -- BUG-010 follow-up (e)'s exact shape: 9 resolvable + 11
  // permanently unresolvable (sec-2 still priced after the sale).
  for (let tick = 0; tick < 4; tick += 1) {
    const outcome = await backfillStoredValueHistoryForPortfolio(
      client,
      "owner",
      "pf",
      100,
      new Date(NOW.getTime() + tick * 3_600_000),
    );
    assert.ok(outcome);
    if (!outcome) return;
    assert.equal(outcome.candidateDates, dates.length);
    // The tell this task must not hide: dates are derived (attempted) every
    // tick, but 11 never persist, because they are genuinely unresolvable.
    // Tick 0 attempts all 20 (nothing stored yet); every later tick still
    // has exactly those same 11 unresolvable dates missing, so it keeps
    // re-attempting exactly them, forever -- the pre-existing, deliberately
    // unfixed BUG-010 follow-up (e) shape.
    assert.equal(outcome.datesDerived, tick === 0 ? 20 : 11);
    assert.equal(outcome.rowsPersisted, tick === 0 ? 9 : 0);
    assert.ok(outcome.datesDerived > outcome.rowsPersisted);
    const marker = await loadPortfolioConvergenceMarker(client, "owner", "pf");
    assert.equal(
      marker,
      null,
      `tick ${tick}: a portfolio with permanently-unresolvable dates must never be marked converged`,
    );
  }
  db.close();
});

test("PRF-010 invalidation: a real invalidation call clears the fingerprint match, and the very next tick detects it and resumes backfilling -- no silent skip", async () => {
  const { db, client } = await productionScale();
  await convergePortfolio(client);
  await backfillStoredValueHistoryForPortfolio(client, "owner", "pf", 20, NOW);
  const markerBefore = await loadPortfolioConvergenceMarker(
    client,
    "owner",
    "pf",
  );
  assert.ok(markerBefore);

  // Simulate a REAL price-history correction landing on an OLD (interior)
  // date -- the exact `app/price-upload-service.ts` MKT-008/MKT-020 call
  // this task's own invalidation-path list names. This deletes ONLY the
  // stored row for that one date; every other stored date is untouched.
  const invalidatedDate = PRODUCTION_SCALE_DATES[500]!;
  const invalidated = await invalidateStoredValueHistoryForSecurity(
    client,
    "owner",
    "sec-0",
    [invalidatedDate],
  );
  assert.equal(invalidated.portfoliosInvalidated, 1);
  assert.equal(invalidated.rowsDeleted, 1);
  assert.equal(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM portfolio_value_history WHERE value_date = ?`,
        )
        .get(invalidatedDate) as { c: number }
    ).c,
    0,
    "the invalidation must have actually deleted the stored row",
  );

  // The stale marker (row count/max/min from BEFORE the delete) must no
  // longer match -- prove it via the SAME comparison the real code path
  // uses, not by re-deriving the logic.
  const currentFingerprint = await loadValueHistoryConvergenceFingerprint(
    client,
    "owner",
    "pf",
  );
  assert.equal(
    convergenceFingerprintMatches(markerBefore, currentFingerprint),
    false,
    "an invalidated portfolio's live fingerprint must no longer match the stale marker",
  );

  // The very next cron tick (well inside the cadence window, so it is NOT
  // the periodic re-check that forces this) must detect the mismatch, fall
  // through to the full check, and resume backfilling -- never silently
  // report converged with the gap unfilled.
  const outcome = await backfillStoredValueHistoryForPortfolio(
    client,
    "owner",
    "pf",
    20,
    new Date(NOW.getTime() + 60_000),
  );
  assert.ok(outcome);
  if (!outcome) return;
  assert.equal(outcome.missingDates, 1);
  assert.equal(outcome.datesDerived, 1);
  assert.equal(outcome.rowsPersisted, 1);
  assert.equal(outcome.backfillPending, false);
  assert.equal(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM portfolio_value_history WHERE value_date = ?`,
        )
        .get(invalidatedDate) as { c: number }
    ).c,
    1,
    "the invalidated date must have been re-backfilled, not left permanently missing",
  );
});

test("PRF-010: the marker respects a hard recheck cadence even when the fingerprint still matches", async () => {
  const { db, client } = await productionScale();
  await convergePortfolio(client);
  await backfillStoredValueHistoryForPortfolio(client, "owner", "pf", 20, NOW);
  const marker = await loadPortfolioConvergenceMarker(client, "owner", "pf");
  assert.ok(marker);

  const { client: censused, candidateScanRowsExamined } = censusClient(
    db,
    client,
  );
  // Just past the cadence window -- must fall through to the full check
  // regardless of the (still-matching) fingerprint.
  const outcome = await backfillStoredValueHistoryForPortfolio(
    censused,
    "owner",
    "pf",
    20,
    new Date(NOW.getTime() + CONVERGENCE_RECHECK_INTERVAL_MS + 1),
  );
  assert.ok(outcome);
  assert.notEqual(
    candidateScanRowsExamined(),
    null,
    "past the cadence window, the full scan must run even with a matching fingerprint",
  );
});

test("PRF-010 regression: loadHistoricalPortfolioValueSeries (the READ path) is completely unaffected -- it never consults or writes the convergence marker", async () => {
  const { db, client } = await productionScale();
  await convergePortfolio(client);
  assert.equal(
    await loadPortfolioConvergenceMarker(client, "owner", "pf"),
    null,
  );

  const result = await loadHistoricalPortfolioValueSeries(
    client,
    "owner",
    "pf",
    NOW,
  );
  assert.ok(result);
  assert.equal(result?.backfillPending, false);
  // The read path must not have recorded a marker -- only the CRON entry
  // point (`backfillStoredValueHistoryForPortfolio`) does.
  assert.equal(
    await loadPortfolioConvergenceMarker(client, "owner", "pf"),
    null,
  );
  db.close();
});
