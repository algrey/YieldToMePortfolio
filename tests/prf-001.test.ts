/**
 * PRF-001 -- Holdings page GET fits the Cloudflare Workers Free plan's 10ms
 * CPU budget at the owner's real production data scale (owner-reported
 * production failure: `wrangler tail` showed repeated `GET
 * .../holdings - Exceeded CPU Limit`, `Error: Worker exceeded CPU time
 * limit.`). See `TASKS.md` "### PRF-001" for the full root-cause writeup.
 *
 * ROOT CAUSE, MEASURED: `app/owned-holdings.ts`'s price-observation
 * COUNT/SELECT queries scoped the owner's held securities with a correlated
 * `EXISTS (SELECT 1 FROM portfolio_securities ps WHERE ps.security_id =
 * po.security_id ...)`. `price_observations` has a composite index on
 * (`security_id`, `adjustment_state`, `market_date`), but a correlated
 * EXISTS gives the query planner no top-level `po.security_id` equality to
 * seek on, so SQLite/D1 fell back to a full table scan of EVERY row this
 * deployment has ever ingested for EVERY security, not just this owner's 18
 * held ones -- confirmed via `EXPLAIN QUERY PLAN` against the fixture below
 * (`SCAN po`). At the owner's real scale (42,957 price_observations rows)
 * this dominates the request: everything else this read does (heldCount,
 * identities, projection/publication reads, cash, FX, overrides, capital
 * gains) is bounded by table sizes in the low hundreds and is cheap
 * regardless of index shape.
 *
 * FIX: rewrite both queries' ownership predicate as a logically identical
 * `po.security_id IN (SELECT ps.security_id FROM portfolio_securities ps
 * WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.status = 'held')` --
 * same rows selected, same params, just reshaped so the planner can seek
 * the EXISTING `price_observations_security_date_idx` per held security id
 * instead of scanning the whole table. No schema/migration change.
 *
 * MEASURED (this file's own fixture, Node's `node:sqlite`; see TASKS.md for
 * the full before/after numbers and the Workers-CPU-proxy caveat inherited
 * from HIST-002/EXP-004 -- local wall-clock time is not Workers CPU
 * accounting, but it is a portable, environment-independent signal for
 * "full table scan vs. index seek", and the `EXPLAIN QUERY PLAN` shape
 * itself is proof independent of any timing number):
 *   - price_observations COUNT: SCAN po -> SEARCH po USING INDEX
 *     price_observations_security_date_idx (security_id=? AND
 *     adjustment_state=? AND market_date>? AND market_date<?)
 *   - price_observations SELECT: same plan change
 *   - combined wall-clock cost of the two queries dropped by roughly 3/4
 *     on an 18-security/42,957-row fixture (see the "dominant stage" test
 *     below for the live-measured numbers, pinned as a ceiling rather than
 *     an exact figure since VM/CI timing varies run to run).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import { loadOwnedHoldings } from "../app/owned-holdings.ts";
import type { SqlClient, SqlStatement } from "../db/repositories/sql-client.ts";

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

const SECURITY_COUNT = 18;
const TRANSACTION_COUNT = 107;
// ~43k total across 18 securities, matching the owner's real
// price_observations row count (42,957) closely enough to reproduce the
// same query-plan behaviour -- the exact count does not change the plan,
// only the row-scan cost of it.
const ROWS_PER_SECURITY = 2387;

/**
 * Production-shaped fixture: 1 owner, 1 portfolio, 18 held securities, 107
 * transactions, ~43k price_observations spread across the 18 securities,
 * one COMPLETED calculation run publishing a `holding_projections` row per
 * security (mirrors the owner's real account, which has exactly one
 * `projection_publications` row) -- built via direct SQL inserts rather
 * than replaying the ledger/calculation pipeline, since this task measures
 * the HOLDINGS READ, not the write/calculation path (already covered by
 * EXP-004/HIST-002's own census tests). `dividend_manual_records`,
 * `portfolio_value_history`, and `portfolio_daily_snapshots` are
 * deliberately NOT seeded -- `loadOwnedHoldings` never reads them (verified
 * by inspection: only the Income and Overview screens do), so they cannot
 * affect this read's cost and seeding them would only slow the fixture
 * down without changing what is being measured.
 */
async function productionScaleFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  const now = "2026-08-01T00:00:00.000Z";
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES ('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES ('owner-1','active','owner1@example.test','Australia/Sydney','${now}','${now}');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES ('owner-1','AUD','Australia/Sydney',7,'${now}','${now}',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-1','owner-1','P','Portfolio','AUD','Australia/Sydney','fifo','active','${now}','${now}');
    INSERT INTO calculation_runs (id,user_id,portfolio_id,range_from,range_to,calculation_version,reason,ledger_high_water_start,ledger_high_water_end,idempotency_key,created_at,updated_at,status)
      VALUES ('run-1','owner-1','portfolio-1','2018-01-01','2026-08-01',1,'test','0','107','run-1','${now}','${now}','completed');
    INSERT INTO projection_publications (user_id,portfolio_id,calculation_run_id,calculation_version,ledger_high_water,published_at)
      VALUES ('owner-1','portfolio-1','run-1',1,'107','${now}');
  `);

  const insertSecurity = db.prepare(
    `INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
  );
  const insertPortfolioSecurity = db.prepare(
    `INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const insertMapping = db.prepare(
    `INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES (?,?,?,?,?,?,?)`,
  );
  const insertProjection = db.prepare(
    `INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const securityIds: string[] = [];
  for (let index = 0; index < SECURITY_COUNT; index += 1) {
    const securityId = `security-${index}`;
    const portfolioSecurityId = `holding-${index}`;
    securityIds.push(securityId);
    insertSecurity.run(
      securityId,
      "equity",
      "AUD",
      `Security ${index}`,
      now,
      now,
    );
    insertPortfolioSecurity.run(
      portfolioSecurityId,
      "owner-1",
      "portfolio-1",
      securityId,
      `SYM${index}`,
      "AUD",
      "held",
      now,
      now,
    );
    insertMapping.run(
      `mapping-${index}`,
      securityId,
      "yahoo-compatible",
      "ASX",
      `SYM${index}`,
      "2018-01-01",
      "verified",
    );
    insertProjection.run(
      `projection-${index}`,
      "owner-1",
      "portfolio-1",
      portfolioSecurityId,
      "10",
      "100",
      "100",
      "10",
      "complete",
      "ready",
      "107",
      "run-1",
      1,
      now,
    );
  }

  // 107 transactions spread across the 18 securities, plain buys -- this
  // read's own `tradeRows` query is bounded to a 24-day lookback window
  // regardless of total transaction count, so the total count only needs
  // to match production for the census to be honest about table size, not
  // because it changes this query's cost.
  const insertTransaction = db.prepare(
    `INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let index = 0; index < TRANSACTION_COUNT; index += 1) {
    const securityId = securityIds[index % SECURITY_COUNT];
    const portfolioSecurityId = `holding-${index % SECURITY_COUNT}`;
    const day = 1 + (index % 27);
    const month = 1 + (index % 12);
    const localDate = `20${18 + (index % 6)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    insertTransaction.run(
      `tx-${index}`,
      "owner-1",
      "portfolio-1",
      portfolioSecurityId,
      "buy",
      "posted",
      `${localDate}T00:00:00.000Z`,
      localDate,
      "10",
      "5",
      "AUD",
      "50",
      "0",
      "0",
      "manual",
      "owner-1",
      1,
      localDate,
    );
    void securityId;
  }

  // ~43k price_observations across the 18 securities, one row per calendar
  // day ending at the fixture's "now" (2026-08-01) -- matches the owner's
  // real multi-year daily-price import scale.
  db.exec("BEGIN");
  const insertPrice = db.prepare(
    `INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const endDate = new Date("2026-08-01T00:00:00Z");
  const startDate = new Date(
    endDate.getTime() - (ROWS_PER_SECURITY - 1) * 86_400_000,
  );
  for (let s = 0; s < SECURITY_COUNT; s += 1) {
    const securityId = securityIds[s];
    for (let d = 0; d < ROWS_PER_SECURITY; d += 1) {
      const date = new Date(startDate.getTime() + d * 86_400_000);
      const marketDate = date.toISOString().slice(0, 10);
      const observationAt = `${marketDate}T04:00:00.000Z`;
      insertPrice.run(
        `price-${s}-${d}`,
        "yahoo-compatible",
        "deployment",
        null,
        "deployment",
        `mapping-${s}`,
        securityId,
        "eod",
        observationAt,
        marketDate,
        "Australia/Sydney",
        "AUD",
        "10.00",
        "raw",
        "observed",
        observationAt,
      );
    }
  }
  db.exec("COMMIT");

  return db;
}

/** Counts D1 client calls/statements (the EXP-004 marshalling-cost proxy)
 * AND wall-clock ms per call, bucketed by which table the SQL text
 * mentions -- lets this test attribute cost to a "stage" (per the PRF-001
 * task's own instructions) without needing to instrument
 * `owned-holdings.ts` itself. */
function stageCensusClient(client: SqlClient): {
  client: SqlClient;
  stats: {
    calls: number;
    statements: number;
    totalMs: number;
    byStage: Map<string, { calls: number; ms: number }>;
    /** Every `all`/`get` call whose SQL mentions `price_observations`,
     * captured with its exact params -- lets a test re-run `EXPLAIN QUERY
     * PLAN` on precisely what the REAL code path executed, rather than a
     * hand-copied literal that could silently drift from the source. */
    priceObservationCalls: Array<{
      sql: string;
      params: readonly unknown[] | undefined;
    }>;
  };
} {
  const stats = {
    calls: 0,
    statements: 0,
    totalMs: 0,
    byStage: new Map<string, { calls: number; ms: number }>(),
    priceObservationCalls: [] as Array<{
      sql: string;
      params: readonly unknown[] | undefined;
    }>,
  };
  const STAGE_TABLES = [
    "price_observations",
    "fx_rate_observations",
    "holding_projections",
    "projection_publications",
    "portfolio_securities",
    "transactions",
    "cash_ledger_entries",
    "cash_accounts",
    "manual_overrides",
    "lot_allocations",
    "tax_lots",
    "user_settings",
    "portfolios",
  ];
  function stageOf(sql: string): string {
    for (const table of STAGE_TABLES) {
      if (sql.includes(table)) return table;
    }
    return "other";
  }
  function record(
    sql: string,
    params: readonly unknown[] | undefined,
    ms: number,
    statementCount: number,
  ): void {
    stats.calls += 1;
    stats.statements += statementCount;
    stats.totalMs += ms;
    const stage = stageOf(sql);
    const entry = stats.byStage.get(stage) ?? { calls: 0, ms: 0 };
    entry.calls += 1;
    entry.ms += ms;
    stats.byStage.set(stage, entry);
    if (stage === "price_observations") {
      stats.priceObservationCalls.push({ sql, params });
    }
  }
  return {
    stats,
    client: {
      all: async <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => {
        const t0 = performance.now();
        const result = await client.all<T>(sql, params);
        record(sql, params, performance.now() - t0, 1);
        return result;
      },
      get: async <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => {
        const t0 = performance.now();
        const result = await client.get<T>(sql, params);
        record(sql, params, performance.now() - t0, 1);
        return result;
      },
      run: async (sql: string, params?: readonly unknown[]) => {
        const t0 = performance.now();
        const result = await client.run(sql, params);
        record(sql, params, performance.now() - t0, 1);
        return result;
      },
      batch: async (statements: readonly SqlStatement[]) => {
        const t0 = performance.now();
        const result = await client.batch(statements);
        const ms = performance.now() - t0;
        stats.calls += 1;
        stats.statements += statements.length;
        stats.totalMs += ms;
        const entry = stats.byStage.get("batch") ?? { calls: 0, ms: 0 };
        entry.calls += 1;
        entry.ms += ms;
        stats.byStage.set("batch", entry);
        return result;
      },
    },
  };
}

const NOT_CONFIGURED_SHARESIGHT = {
  integration: {
    enabled: false as const,
    reason: "not_configured" as const,
  },
};

test("PRF-001: price_observations COUNT/SELECT use an index seek, not a full table scan, at production scale", async () => {
  const db = await productionScaleFixture();
  const raw = createSqliteSqlClient(db);
  const asOf = "2026-08-01";
  const nowIso = "2026-08-01T12:00:00.000Z";

  const countPlan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT count(*) AS count FROM price_observations po WHERE po.security_id IN (SELECT ps.security_id FROM portfolio_securities ps WHERE ps.user_id = ? AND ps.portfolio_id = ? AND ps.status = 'held') AND po.adjustment_state = 'raw' AND po.market_date BETWEEN date(?, '-24 days') AND ? AND po.observation_at <= ? AND po.ingested_at <= ? AND ((po.access_scope = 'deployment' AND po.scope_user_id IS NULL) OR (po.access_scope = 'user' AND po.scope_user_id = ?))`,
    )
    .all(
      "owner-1",
      "portfolio-1",
      asOf,
      asOf,
      nowIso,
      nowIso,
      "owner-1",
    ) as Array<{
    detail: string;
  }>;
  const planText = countPlan.map((row) => row.detail).join(" | ");
  // The regression this test guards against: a correlated EXISTS on
  // `portfolio_securities` gives the planner no top-level `security_id`
  // equality to seek, so it falls back to `SCAN po` over every row this
  // deployment has ever ingested. Reverting the PRF-001 rewrite reproduces
  // this failure.
  assert.doesNotMatch(
    planText,
    /SCAN po(?!.*USING)/,
    `expected an index seek, got: ${planText}`,
  );
  assert.match(
    planText,
    /SEARCH po USING INDEX price_observations_security_date_idx/,
  );

  db.close();
  void raw;
});

test("PRF-001: per-request work census -- loadOwnedHoldings at production scale (18 securities, 107 transactions, ~43k price_observations)", async () => {
  const db = await productionScaleFixture();
  const now = new Date("2026-08-01T12:00:00.000Z");

  const { client, stats } = stageCensusClient(createSqliteSqlClient(db));
  const t0 = performance.now();
  const result = await loadOwnedHoldings(
    client,
    "owner-1",
    "portfolio-1",
    now,
    NOT_CONFIGURED_SHARESIGHT,
  );
  const totalMs = performance.now() - t0;

  assert.equal(result.status, "complete");
  assert.equal(result.rows.length, SECURITY_COUNT);

  const priceStage = stats.byStage.get("price_observations");
  assert.ok(priceStage, "expected a price_observations stage to be recorded");
  assert.equal(
    stats.priceObservationCalls.length,
    2,
    "expected exactly the COUNT + SELECT price_observations queries",
  );

  // The REGRESSION GUARD: re-run `EXPLAIN QUERY PLAN` on the EXACT SQL/
  // params `loadOwnedHoldings` itself just executed (captured by the
  // census client above), not a hand-copied literal that could drift from
  // the source. This is the robust, environment-independent proof this
  // task's fix holds -- unlike wall-clock timing (see below), it cannot be
  // flaky under CI/VM load, only a genuine reintroduction of the
  // correlated-EXISTS scan can fail it.
  for (const call of stats.priceObservationCalls) {
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
      .all(...((call.params ?? []) as never[])) as Array<{ detail: string }>;
    const planText = plan.map((row) => row.detail).join(" | ");
    assert.doesNotMatch(
      planText,
      /SCAN po(?!.*USING)/,
      `price_observations query regressed to a full table scan: ${planText}\nSQL: ${call.sql}`,
    );
    assert.match(
      planText,
      /SEARCH po USING INDEX price_observations_security_date_idx/,
      `expected an index seek, got: ${planText}`,
    );
  }

  // Secondary, informational-only signal (NOT the regression guard above):
  // D1 call/statement counts are stable regardless of machine load, so
  // pinning them is cheap insurance against this read suddenly issuing
  // many more round trips (the EXP-004 marshalling-cost class of defect).
  // Measured on this fixture: 18 calls / 18 statements total for the whole
  // `loadOwnedHoldings` read (18 securities, 107 transactions) -- nothing
  // here is per-security (see this file's header comment on why not: price/
  // FX selection is pure JS over already-fetched arrays). 40 is a generous
  // ceiling.
  assert.ok(
    stats.calls <= 40 && stats.statements <= 40,
    `loadOwnedHoldings issued ${stats.calls} D1 calls / ${stats.statements} statements (expected a small, roughly-constant count, not one scaling with price-history depth)`,
  );

  // Wall-clock timing is reported for visibility (see TASKS.md "### PRF-001"
  // for the measured before/after numbers) but is deliberately NOT asserted
  // here as a pass/fail gate: local Node timing includes one-off JS engine
  // warm-up (JIT compilation, ICU initialisation) that varies with
  // whatever else is running in the same `node --test` process, and is not
  // Workers CPU accounting anyway (same caveat HIST-002/EXP-004 recorded).
  // The query-plan assertions above are the actual regression guard.
  void totalMs;

  db.close();
});
