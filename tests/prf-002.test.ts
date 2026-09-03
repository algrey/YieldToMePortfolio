/**
 * PRF-002 -- every authenticated page fits the Cloudflare Workers Free
 * plan's 10ms CPU budget at the owner's real production data scale.
 * Owner report verbatim (after PRF-001 fixed the Holdings page's
 * `price_observations` full-table-scan defect): "Improved, now it works
 * most of the time. But still getting error 1102." `wrangler tail` showed
 * intermittent `Exceeded CPU Limit` kills across EVERY authenticated page --
 * `/`, `/portfolio/:id/holdings` (still, occasionally),
 * `/portfolio/:id/quotes`, `/portfolio/:id/details`,
 * `/portfolio/:id/gains`, `/portfolio/:id/income/dividends`, and their
 * `.rsc` navigation variants.
 *
 * ROOT CAUSES, MEASURED (this file's own production-shaped fixture, driven
 * through the REAL per-page loader composition under a stage-attributing
 * counting `SqlClient`, per the PRF-001/EXP-004/HIST-002 census method --
 * `app/authenticated-workspace.ts` itself cannot be imported directly under
 * plain `node --test` since it pulls in `next/headers`, so each page's
 * function below reproduces its EXACT call sequence against a resolved
 * client/userId instead, exactly like PRF-001 drove `loadOwnedHoldings`
 * directly rather than through the page component):
 *
 * (1) SIX section pages under `/portfolio/:id/*` (gains, income,
 *     income/dividends, income/assumptions, income/multi-year, and
 *     `details` via `app/portfolio-inspection.ts`) called
 *     `loadAuthenticatedWorkspace(portfolioId)` PURELY as an auth/ownership
 *     gate and then called `app/portfolio-actions.ts`'s
 *     `getAuthenticatedSqlContext(portfolioId)` a SECOND time to obtain the
 *     `SqlClient`/`userId` their own section-specific loader needed --
 *     re-running `resolveAuthenticatedRequestContext` (an identity lookup
 *     PLUS `touchWithAudit`'s 3-statement UPDATE/UPDATE/INSERT batch)
 *     twice, on every one of those page loads, for the SAME principal
 *     against the SAME portfolio id in the SAME request. FIXED: an optional
 *     `sqlContextOut` output slot on `loadAuthenticatedWorkspace` lets those
 *     six pages recover the client/userId their first (and now only) call
 *     already resolved -- see `app/authenticated-workspace.ts`'s
 *     `AuthenticatedWorkspaceSqlContext` doc comment and each page's own
 *     PRF-002 comment.
 *
 * (2) `app/historical-portfolio-value.ts`'s `loadHistoricalPortfolioValueSeries`
 *     (the root `/` Overview page's history-graph read) called the FULL
 *     `loadFacts` -- every `transactions` row, every `price_observations`
 *     column (`mapPrice`-validated), every `fx_rate_observations` row --
 *     UNCONDITIONALLY, on every single call, purely to compute
 *     `observedDates`. In the overwhelmingly common STEADY-STATE case (every
 *     candidate date already stored in `portfolio_value_history` from a
 *     prior read), that entire read was immediately discarded: the
 *     `missingDates.length === 0` fast path never even looks at
 *     `facts.securities`/`facts.fxObservations`. At the owner's real scale
 *     this meant re-fetching and re-validating tens of thousands of
 *     `price_observations` rows, plus every `transactions` and
 *     `fx_rate_observations` row, on EVERY Overview page load, for data
 *     that was never used. FIXED: a new `loadCandidateDates` answers "which
 *     dates have price data in range" with a single `DISTINCT market_date`
 *     read (same security-id-scoped/`PRICE_SCOPE` predicate as the real
 *     price query, so it matches the identical row set) -- the full
 *     `loadFacts` read now only runs once genuine derivation work is known
 *     to exist.
 *
 * See TASKS.md's "### PRF-002" entry for the full per-page before/after
 * census table and the CALC-004 snapshot-pipeline finding this task
 * measured but deliberately did not fix (that pipeline's executor
 * semantics were out of this task's scope). CALC-005 later retired that
 * pipeline entirely (docs/ARCHITECTURE.md's CALC-005 entry) -- this file's
 * root-overview census and its dedicated regression test below now assert
 * the resulting DROP instead of measuring the finding.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import { loadOwnedHoldings } from "../app/owned-holdings.ts";
import {
  loadOwnedCapitalGains,
  loadOwnedRealisedGainTotals,
} from "../app/owned-capital-gains.ts";
import { loadOwnedDividendList } from "../app/owned-dividend-list.ts";
import { loadOwnedWatchlist } from "../app/owned-watchlist.ts";
import { buildHoldingsSummaryFooter } from "../app/owned-holdings-summary.ts";
import {
  loadHistoricalPortfolioValueSeries,
  loadHistoricalPortfolioValueAtDates,
  invalidateStoredValueHistoryForSecurity,
} from "../app/historical-portfolio-value.ts";
import { loadUsdAudRate } from "../app/authenticated-fx-rate.ts";
import { loadPortfolioInspectionSafely } from "../db/repositories/portfolio-inspection.ts";
import { createOwnedUserSettingsRepository } from "../db/repositories/owned-portfolios.ts";
// PRF-005: the Income area's uncensused pages (never covered by PRF-002,
// which only censused `/income/dividends`).
import { loadOwnedIncomeProjection } from "../app/owned-income-projection.ts";
import { loadOwnedIncomeScenarios } from "../app/owned-income-scenarios.ts";
import { loadOwnedDividendAssumptions } from "../app/owned-dividend-assumptions.ts";
import { createDividendFyOverrideRepository } from "../db/repositories/dividends.ts";
import {
  loadOwnedHoldingIdentity,
  loadOwnedHoldingTransactions,
} from "../app/owned-holding-transactions.ts";
import { loadOwnedSecurityDividendDetail } from "../app/owned-security-dividends.ts";
import {
  DEFAULT_YEARS_BACK,
  DEFAULT_YEARS_FORWARD,
} from "../app/income-year-range.ts";
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
// ~60k across 18 securities -- the owner's real price_observations count
// (42,957 when PRF-001 shipped) is growing daily via cron capture; this
// task's own instructions ask to test at 60k to leave headroom rather than
// pin the exact current figure. One row per CALENDAR day (not just trading
// days) per security, ending at the fixture's "now" (2026-08-01) -- a
// fixture design choice for simplicity, not a claim that production prices
// weekends; it does not change the query-plan/marshalling-cost behaviour
// being measured, only the row-scan volume (upward, conservatively).
const ROWS_PER_SECURITY = 3_334;
const DIVIDEND_MANUAL_RECORD_COUNT = 119;
// PRF-005: one PAID provider `dividend_events` row per held security --
// realistic coverage so the Income area's TTM-yield derivation
// (`deriveYieldFromResolvedTtm`/`computeSecurityDividendForecast`) resolves
// a REAL provider-sourced rate for every security instead of silently
// falling through to the history-derived fallback for all 18 (which the
// pre-existing `dividend_manual_records` fixture already exercises via
// `/income/dividends`, but the projection/assumptions paths this task
// censuses also read `dividend_events` directly -- see
// `owned-income-projection.ts`'s DIV-009 header). One `dividend_security_assumptions`
// override on a THIRD of the securities exercises the assumptions-editor
// read path with real owner-entered rows, not just the empty-table case.
const DIVIDEND_EVENT_COUNT = SECURITY_COUNT;
const DIVIDEND_SECURITY_ASSUMPTION_COUNT = 6;

/**
 * Production-shaped fixture, extending PRF-001's own: 1 owner, 1 portfolio,
 * 18 held securities, 107 transactions, ~60,012 price_observations spread
 * across the 18 securities, one COMPLETED projection publication (mirrors
 * PRF-001's fixture exactly), PLUS (new for PRF-002) 119
 * dividend_manual_records, one fx_rate_observation (USD/AUD, for the
 * app-bar pill), one watchlist_entry, and `portfolio_value_history` rows
 * covering EVERY observed price date (the steady-state "nothing left to
 * backfill" shape the Overview page sees on every read once HIST-002's
 * backfill has caught up -- matching the production account's own fully-
 * caught-up state).
 *
 * Deliberately NOT seeded: `portfolio_daily_snapshots`/
 * `holding_daily_snapshots` rows for the CALC-004 snapshot pipeline's own
 * partial progress. Production had 69 such rows from a run that kept
 * getting re-claimed and re-advancing without ever completing, at the time
 * this fixture was written for the PRF-002 investigation -- CALC-005 later
 * retired that pipeline entirely (docs/ARCHITECTURE.md's CALC-005 entry),
 * so reproducing its exact stuck-but-progressing internal state is no
 * longer a live production concern. This fixture still seeds ONE legacy
 * queued snapshot-pipeline row (`snapshot-run-1` below) standing in for
 * that same stuck-run shape -- not to measure its cost any more (there is
 * none: nothing ever claims or advances it now), but so the root-overview
 * census and its dedicated regression test below can prove it stays
 * completely untouched, never resurrected by a future regression.
 */
async function productionScaleFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  const now = "2026-08-01T00:00:00.000Z";
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES ('AUD',36,'Australian dollar',2),('USD',840,'US dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES ('owner-1','active','owner1@example.test','Australia/Sydney','${now}','${now}');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES ('owner-1','AUD','Australia/Sydney',7,'${now}','${now}',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-1','owner-1','P','Portfolio','AUD','Australia/Sydney','fifo','active','${now}','${now}');
    INSERT INTO calculation_runs (id,user_id,portfolio_id,range_from,range_to,calculation_version,reason,ledger_high_water_start,ledger_high_water_end,idempotency_key,created_at,updated_at,status)
      VALUES ('run-1','owner-1','portfolio-1','2018-01-01','2026-08-01',1,'test','0','107','run-1','${now}','${now}','completed');
    INSERT INTO projection_publications (user_id,portfolio_id,calculation_run_id,calculation_version,ledger_high_water,published_at)
      VALUES ('owner-1','portfolio-1','run-1',1,'107','${now}');
    INSERT INTO fx_rate_observations (id,provider_id,access_scope,scope_user_id,scope_key,base_currency_code,quote_currency_code,rate_decimal,interval,observed_at,market_date,quality,ingested_at)
      VALUES ('fx-usd-aud','yahoo-compatible','deployment',NULL,'deployment','USD','AUD','1.55','eod','${now}','2026-08-01','observed','${now}');
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
  const portfolioSecurityIds: string[] = [];
  for (let index = 0; index < SECURITY_COUNT; index += 1) {
    const securityId = `security-${index}`;
    const portfolioSecurityId = `holding-${index}`;
    securityIds.push(securityId);
    portfolioSecurityIds.push(portfolioSecurityId);
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
      "2015-01-01",
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

  // 107 transactions spread across the 18 securities, plain buys -- matches
  // PRF-001's own fixture exactly (this read's own `tradeRows`-style
  // queries are bounded to a short lookback window regardless of total
  // transaction count; the total only needs to match production for the
  // census to be honest about table size).
  const insertTransaction = db.prepare(
    `INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let index = 0; index < TRANSACTION_COUNT; index += 1) {
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
  }

  // PRF-011: one active disposal against `holding-0` (its opening lot is
  // `tx-0`, the loop's first buy above -- 2018-01-01, quantity 10) so
  // `/gains` is actually measured by the census below instead of hitting
  // `loadOwnedCapitalGains`'s zero-active-sell short-circuit (see that
  // function's own empty-state comment). Published under the SAME `run-1`
  // publication every other census page already reads.
  db.exec(`
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at)
      VALUES ('tx-cgt-sell','owner-1','portfolio-1','holding-0','sell','posted','2026-07-15T00:00:00.000Z','2026-07-15','5','20','AUD','100','0','0','manual','owner-1',1,'2026-07-15');
    INSERT INTO tax_lots (id,user_id,portfolio_id,portfolio_security_id,opening_transaction_id,acquired_at,original_quantity_decimal,open_quantity_decimal,native_basis_decimal,base_basis_decimal,basis_status,status,calculation_run_id,calculation_version,rebuilt_at)
      VALUES ('tax-lot-cgt','owner-1','portfolio-1','holding-0','tx-0','2018-01-01T00:00:00.000Z','10','5','50','50','complete','open','run-1',1,'${now}');
    INSERT INTO lot_allocations (id,user_id,portfolio_id,portfolio_security_id,sell_transaction_id,tax_lot_id,allocation_sequence,matched_quantity_decimal,allocated_base_basis_decimal,base_net_proceeds_decimal,fee_base_decimal,tax_base_decimal,base_realised_gain_decimal,basis_status,calculation_run_id,calculation_version)
      VALUES ('lot-alloc-cgt','owner-1','portfolio-1','holding-0','tx-cgt-sell','tax-lot-cgt',1,'5','25','100','0','0','75','complete','run-1',1);
  `);

  // 119 dividend_manual_records spread across the 18 securities.
  const insertDividend = db.prepare(
    `INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,created_at,updated_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let index = 0; index < DIVIDEND_MANUAL_RECORD_COUNT; index += 1) {
    const portfolioSecurityId = `holding-${index % SECURITY_COUNT}`;
    const year = 2020 + (index % 6);
    const month = 1 + (index % 12);
    const day = 1 + (index % 27);
    const paymentDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    insertDividend.run(
      `div-${index}`,
      "owner-1",
      "portfolio-1",
      portfolioSecurityId,
      paymentDate,
      "10",
      "0.50",
      "0.21",
      now,
      now,
      1,
    );
  }

  // One watchlist entry (security-kind, watching security-0).
  db.prepare(
    `INSERT INTO watchlist_entries (id,user_id,kind,security_id,display_order,created_at,version) VALUES (?,?,?,?,?,?,?)`,
  ).run("watch-1", "owner-1", "security", "security-0", 0, now, 1);

  // PRF-005: one PAID `dividend_events` row per security -- see this
  // function's own PRF-005 doc comment above.
  const insertDividendEvent = db.prepare(
    `INSERT INTO dividend_events (id,security_id,provider_id,kind,status,ex_date,record_date,payment_date,declaration_date,currency_code,gross_per_share_decimal,franking_percent_decimal,franking_credit_per_share_decimal,observed_at,ingested_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let index = 0; index < DIVIDEND_EVENT_COUNT; index += 1) {
    const securityId = `security-${index}`;
    insertDividendEvent.run(
      `dividend-event-${index}`,
      securityId,
      "yahoo-compatible",
      "cash",
      "paid",
      "2026-06-01",
      "2026-06-02",
      "2026-06-15",
      "2026-05-20",
      "AUD",
      "0.30",
      "1.00",
      "0.1286",
      now,
      now,
      now,
    );
  }

  // PRF-005: a real owner-entered assumption override on a third of the
  // securities.
  const insertSecurityAssumption = db.prepare(
    `INSERT INTO dividend_security_assumptions (id,user_id,portfolio_id,portfolio_security_id,dividend_yield_percent_decimal,franking_percent_decimal,dividend_growth_percent_decimal,created_at,updated_at,version) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let index = 0; index < DIVIDEND_SECURITY_ASSUMPTION_COUNT; index += 1) {
    insertSecurityAssumption.run(
      `security-assumption-${index}`,
      "owner-1",
      "portfolio-1",
      `holding-${index}`,
      "4.50",
      "100",
      "2.00",
      now,
      now,
      1,
    );
  }

  // ~60,012 price_observations across the 18 securities, one row per
  // calendar day ending at the fixture's "now" (2026-08-01).
  const endDate = new Date("2026-08-01T00:00:00Z");
  const startDate = new Date(
    endDate.getTime() - (ROWS_PER_SECURITY - 1) * 86_400_000,
  );
  const observedDates: string[] = [];
  for (let d = 0; d < ROWS_PER_SECURITY; d += 1) {
    const date = new Date(startDate.getTime() + d * 86_400_000);
    observedDates.push(date.toISOString().slice(0, 10));
  }

  db.exec("BEGIN");
  const insertPrice = db.prepare(
    `INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (let s = 0; s < SECURITY_COUNT; s += 1) {
    const securityId = securityIds[s];
    for (let d = 0; d < ROWS_PER_SECURITY; d += 1) {
      const marketDate = observedDates[d];
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

  // PRF-002 (HIST-002 steady state): `portfolio_value_history` already
  // covers EVERY observed price date -- the "nothing left to backfill" fast
  // path the fix above targets. Values are structurally valid but not
  // numerically meaningful (this census measures per-request D1/JS work,
  // not the derivation's own arithmetic -- already covered by
  // tests/hist-002.test.ts).
  db.exec("BEGIN");
  const insertHistory = db.prepare(
    `INSERT INTO portfolio_value_history (id,user_id,portfolio_id,value_date,value_decimal,completeness,held_security_count,priced_security_count,computed_at) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (let d = 0; d < observedDates.length; d += 1) {
    insertHistory.run(
      `phv-${d}`,
      "owner-1",
      "portfolio-1",
      observedDates[d],
      "1800.00",
      "complete",
      SECURITY_COUNT,
      SECURITY_COUNT,
      now,
    );
  }
  db.exec("COMMIT");

  // CALC-005 (see this function's own doc comment above): a legacy queued
  // snapshot-pipeline row over the SAME realistic ledger/price-history
  // range, standing in for the production account's own never-completing
  // run from before the pipeline was retired. Its exact field values no
  // longer matter functionally (nothing ever claims/advances/reads it by
  // pipeline any more) -- it exists purely so tests can assert it is left
  // completely alone.
  db.exec(`
    INSERT INTO calculation_runs (id,user_id,portfolio_id,range_from,range_to,calculation_version,reason,pipeline,status,attempt,ledger_high_water_start,idempotency_key,created_at,updated_at)
      VALUES ('snapshot-run-1','owner-1','portfolio-1','2018-01-01','2026-08-01',1,'test','snapshot','queued',0,'0','snapshot-run-1','${now}','${now}');
  `);

  return db;
}

/** Counts D1 client calls/statements (the EXP-004 marshalling-cost proxy)
 * AND wall-clock ms per call, bucketed by which table the SQL text
 * mentions -- lets a test attribute cost to a "stage" without needing to
 * instrument each loader module itself. Extends PRF-001's own version to
 * cover every table this task's census needs to reason about. */
function stageCensusClient(client: SqlClient): {
  client: SqlClient;
  stats: {
    calls: number;
    statements: number;
    totalMs: number;
    byStage: Map<string, { calls: number; ms: number }>;
    /** Every `all`/`get` call, captured with its exact SQL/params -- lets a
     * test re-run `EXPLAIN QUERY PLAN` on precisely what the REAL code path
     * just executed, rather than a hand-copied literal that could drift
     * from the source (PRF-001 review follow-up (b)). */
    calls_: Array<{ sql: string; params: readonly unknown[] | undefined }>;
  };
} {
  const stats = {
    calls: 0,
    statements: 0,
    totalMs: 0,
    byStage: new Map<string, { calls: number; ms: number }>(),
    calls_: [] as Array<{
      sql: string;
      params: readonly unknown[] | undefined;
    }>,
  };
  const STAGE_TABLES = [
    "price_observations",
    "fx_rate_observations",
    "holding_projections",
    "projection_publications",
    "snapshot_publications",
    "portfolio_securities",
    "transactions",
    "dividend_manual_records",
    "dividend_events",
    "dividend_receipts",
    "dividend_security_assumptions",
    "dividend_event_overrides",
    "dividend_fy_overrides",
    "dividend_portfolio_assumptions",
    "dividend_import_franking_overrides",
    "portfolio_value_history",
    "portfolio_daily_snapshots",
    "holding_daily_snapshots",
    "calculation_runs",
    "watchlist_entries",
    "cash_ledger_entries",
    "cash_accounts",
    "manual_overrides",
    "lot_allocations",
    "tax_lots",
    "user_settings",
    "portfolios",
    "securities",
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
    stats.calls_.push({ sql, params });
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
        // PRF-006 (closing CALC-005's own recorded review follow-up (a):
        // "the census client misses batch calls"): each batched statement's
        // sql/params is captured here too, exactly like `record()` does for
        // `all`/`get`/`run` above -- without this, a call moved from
        // `client.all` to `client.batch` (as PRF-006's `/income` rows_read
        // fix does for loadFacts's 2+-window price/FX reads) would silently
        // vanish from every `stats.calls_`-driven assertion (the
        // EXPLAIN QUERY PLAN scan check, the "exactly one price read"
        // filters below), not because the regression guard passed but
        // because it never saw the query at all.
        for (const statement of statements) {
          stats.calls_.push({ sql: statement.sql, params: statement.params });
        }
        return result;
      },
    },
  };
}

/** PRF-003 (owner-reported slow tab navigation, "shortest 3 seconds and
 * longest 20 seconds" per tab change): measures SEQUENTIAL DEPTH -- the
 * length of the LONGEST CHAIN of D1 round trips a page's REAL loader chain
 * issues, where each link in the chain genuinely waits for the previous one
 * to finish -- rather than raw call/statement counts (PRF-001/PRF-002's
 * metric). On Cloudflare Workers Free, D1 is not co-located with every
 * Worker invocation and has no read replication, so EACH such link pays a
 * real, non-negligible latency tax regardless of how few rows/statements it
 * touches; two calls issued via `Promise.all` (or one `batch()`) pay that
 * tax ONCE, together, and so do not extend the chain.
 *
 * Method: every `all`/`get`/`run`/`batch` call has an identical small delay
 * (`DEPTH_PROBE_DELAY_MS`) appended AFTER it resolves, before this wrapper's
 * own promise resolves -- large enough that two genuinely concurrent calls'
 * [start, end) wall-clock intervals reliably overlap despite real-machine
 * timing jitter (the underlying in-memory SQLite calls themselves resolve
 * near-instantly, so without an added delay concurrent and sequential calls
 * would be nearly indistinguishable by timestamp alone), small enough that
 * even a few dozen calls finish in well under a second.
 *
 * `depth` is computed via a longest-non-overlapping-chain DP over the
 * captured intervals (review fold -- an EARLIER version of this harness
 * instead merged any transitively-overlapping intervals into one
 * "connected component" and called ITS count "depth": that undercounts
 * whenever a short call sits beside a longer sibling and a third call
 * starts after the short one ends but before the long one does -- the
 * short-then-third pair is a genuine 2-deep SEQUENTIAL chain, but the
 * merge conflates it with the long sibling's single wave and reports only
 * 1. Sorted by END time ascending (no two intervals can mutually satisfy
 * `end_j <= start_i` and `end_i <= start_j` for i != j, so this order is a
 * valid evaluation order -- every `j` a given `i` could depend on has
 * already been finalized by the time `i` is processed): `best[i] = 1 +
 * max(best[j] | end_j <= start_i)`, `depth = max(best[i])`. This is the
 * TRUE critical path length -- the number of round trips that could not
 * have been avoided by ANY reordering/batching given the concurrency the
 * code actually exhibited. `concurrencyGroups` (see `waveSizes`/
 * `waveLabels` below) is kept as a SEPARATE, purely informational figure --
 * the old merged-component count -- and must never be called "depth". */
const DEPTH_PROBE_DELAY_MS = 8;
const MODELED_ROUND_TRIP_MS = 40;
function depthCensusClient(client: SqlClient): {
  client: SqlClient;
  waves(): {
    depth: number;
    chain: string[];
    modeledWallMs: number;
    waveSizes: number[];
    waveLabels: string[][];
  };
} {
  const intervals: Array<{ start: number; end: number; label: string }> = [];
  function label(sql: string): string {
    const match = /\b(from|into|update)\s+(\w+)/i.exec(sql);
    return match ? match[2]!.toLowerCase() : "batch";
  }
  async function timed<T>(run: () => Promise<T>, sql: string): Promise<T> {
    const start = performance.now();
    const result = await run();
    await new Promise((resolve) => setTimeout(resolve, DEPTH_PROBE_DELAY_MS));
    intervals.push({ start, end: performance.now(), label: label(sql) });
    return result;
  }
  return {
    client: {
      all: <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => timed(() => client.all<T>(sql, params), sql),
      get: <T extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ) => timed(() => client.get<T>(sql, params), sql),
      run: (sql: string, params?: readonly unknown[]) =>
        timed(() => client.run(sql, params), sql),
      batch: (statements: readonly SqlStatement[]) =>
        timed(() => client.batch(statements), statements[0]?.sql ?? ""),
    },
    waves() {
      // TRUE depth: longest non-overlapping chain (critical path), per
      // this function's own doc comment above.
      const byEnd = [...intervals].sort((a, b) => a.end - b.end);
      const best = new Array<number>(byEnd.length).fill(1);
      const prevIndex = new Array<number>(byEnd.length).fill(-1);
      for (let i = 0; i < byEnd.length; i += 1) {
        for (let j = 0; j < i; j += 1) {
          if (byEnd[j]!.end <= byEnd[i]!.start && best[j]! + 1 > best[i]!) {
            best[i] = best[j]! + 1;
            prevIndex[i] = j;
          }
        }
      }
      let depth = 0;
      let maxIndex = -1;
      for (let i = 0; i < best.length; i += 1) {
        if (best[i]! > depth) {
          depth = best[i]!;
          maxIndex = i;
        }
      }
      const chain: string[] = [];
      for (let cur = maxIndex; cur !== -1; cur = prevIndex[cur]!) {
        chain.unshift(byEnd[cur]!.label);
      }

      // INFORMATIONAL ONLY, never "depth": the old merged-connected-
      // component count -- how many maximal clusters of mutually
      // overlapping intervals occurred, useful for eyeballing where
      // concurrency happened, but NOT a sound measure of the critical
      // path (see this function's doc comment).
      const byStart = [...intervals].sort((a, b) => a.start - b.start);
      let currentEnd = -Infinity;
      let currentSize = 0;
      const waveSizes: number[] = [];
      const waveLabels: string[][] = [];
      let currentLabels: string[] = [];
      for (const interval of byStart) {
        if (interval.start >= currentEnd) {
          if (currentSize > 0) {
            waveSizes.push(currentSize);
            waveLabels.push(currentLabels);
          }
          currentEnd = interval.end;
          currentSize = 1;
          currentLabels = [interval.label];
        } else {
          currentEnd = Math.max(currentEnd, interval.end);
          currentSize += 1;
          currentLabels.push(interval.label);
        }
      }
      if (currentSize > 0) {
        waveSizes.push(currentSize);
        waveLabels.push(currentLabels);
      }
      return {
        depth,
        chain,
        modeledWallMs: depth * MODELED_ROUND_TRIP_MS,
        waveSizes,
        waveLabels,
      };
    },
  };
}

/** Step 1's "flag ANY SCAN of price_observations, transactions,
 * portfolio_value_history, or dividend-related tables that isn't bounded by
 * a small table" instruction -- re-runs `EXPLAIN QUERY PLAN` on every
 * captured `all`/`get` call whose SQL mentions one of those tables, and
 * fails if ANY plan row (checked per-row, not a joined string -- PRF-001
 * review follow-up (a) found the joined-string form vacuous) is a `SCAN` of
 * one of them. */
const FLAGGED_TABLES = [
  "price_observations",
  "transactions",
  "portfolio_value_history",
];
function isDividendTable(table: string): boolean {
  return table.startsWith("dividend_");
}
function assertNoLargeTableScans(
  db: DatabaseSync,
  calls: Array<{ sql: string; params: readonly unknown[] | undefined }>,
): void {
  for (const call of calls) {
    const mentionsFlagged =
      FLAGGED_TABLES.some((table) => call.sql.includes(table)) ||
      /\bdividend_\w+/.test(call.sql);
    if (!mentionsFlagged) continue;
    let plan: Array<{ detail: string }>;
    try {
      plan = db
        .prepare(`EXPLAIN QUERY PLAN ${call.sql}`)
        .all(...((call.params ?? []) as never[])) as Array<{
        detail: string;
      }>;
    } catch {
      // A handful of captured statements are plain INSERT/UPDATE (from
      // opportunistic persistence, e.g. `upsertStoredValueHistory`) --
      // `EXPLAIN QUERY PLAN` on those is uninformative for scan detection
      // (no read plan) and some parameter shapes (multi-row VALUES) do not
      // replay cleanly outside their own statement; skip rather than fail
      // this census's own harness.
      continue;
    }
    for (const row of plan) {
      const match = /^SCAN\s+(\S+)/.exec(row.detail);
      if (!match) continue;
      const table = match[1]!;
      const flagged = FLAGGED_TABLES.includes(table) || isDividendTable(table);
      assert.ok(
        !flagged,
        `unbounded SCAN of large/growing table "${table}" found in a captured query:\n${call.sql}\nplan: ${row.detail}`,
      );
    }
  }
}

const NOT_CONFIGURED_SHARESIGHT = {
  integration: {
    enabled: false as const,
    reason: "not_configured" as const,
  },
};

const USER_ID = "owner-1";
const PORTFOLIO_ID = "portfolio-1";
const NOW = new Date("2026-08-01T12:00:00.000Z");
// PRF-005: an arbitrary held security for the per-holding sub-tab census
// functions below -- any of `holding-0`..`holding-17` would do equally.
const HOLDING_ID = "holding-0";

/** The "base workspace" cost EVERY `loadAuthenticatedWorkspace` call pays
 * once identity/ownership is already resolved -- user settings + the
 * UI-050 app-bar USD/AUD pill. Common to every page census below, mirroring
 * `app/authenticated-workspace.ts`'s own call SHAPE. Deliberately excludes
 * `resolveAuthenticatedRequestContext` itself (JWT/`next/headers`-dependent
 * and not `.ts`-importable under plain `node --test`; see this file's
 * header) -- that cost is measured separately, once, in the "auth
 * resolution" test below, since it is identical across every page and its
 * DUPLICATION (now fixed) was a page-independent defect. PRF-003: settings
 * and the FX pill are now fetched CONCURRENTLY in the real loader (they are
 * mutually independent reads keyed off the same userId -- see
 * `authenticated-workspace.ts`'s own PRF-003 comment), so this mirrors that
 * with a `Promise.all` rather than two sequential `await`s.
 */
async function baseWorkspaceLoad(client: SqlClient): Promise<void> {
  await Promise.all([
    createOwnedUserSettingsRepository(client).get(USER_ID),
    loadUsdAudRate(client, USER_ID, "2026-08-01"),
  ]);
}

// ---------------------------------------------------------------------------
// Per-page census functions -- each reproduces its page's REAL composed
// loader chain (see this file's header for why `authenticated-workspace.ts`
// itself cannot be imported directly).
// ---------------------------------------------------------------------------

/** `/` root workspace page: `loadAuthenticatedWorkspace(undefined,
 * {includeOverview: true})` -- ALWAYS requested for the root route
 * regardless of which section query param is present (see `app/page.tsx`).
 * Mirrors `authenticated-workspace.ts`'s `includeOverview` branch body
 * exactly: the HIST-001 value-history graph and a SEPARATE `loadOwnedHoldings`
 * call for the hero's securities-only summary (UI-047). PRF-006 (owner-
 * directed final pass): the former THIRD wave member, a `loadPublishedOverview`
 * D1 read, is gone -- CALC-005 already retired the snapshot pipeline's every
 * writer, so `snapshot_publications` can never gain a row again in this
 * codebase and that read always resolved `null`; `authenticated-workspace.ts`
 * now computes `createOverviewData(null)` directly with zero D1 cost.
 * `productionScaleFixture` still seeds a legacy queued snapshot-pipeline row
 * (`snapshot-run-1`, standing in for production's real stuck run)
 * specifically so the dedicated CALC-005 test below proves it is truly inert
 * -- present but never read, claimed, advanced, or paid for. PRF-003: the
 * two remaining reads are mutually independent (see
 * `authenticated-workspace.ts`'s own PRF-003 comment) and run concurrently in
 * the real loader -- this mirrors that with a `Promise.all` rather than two
 * sequential `await`s. */
async function censusRootOverviewPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  await Promise.all([
    loadHistoricalPortfolioValueSeries(client, USER_ID, PORTFOLIO_ID, NOW),
    loadOwnedHoldings(
      client,
      USER_ID,
      PORTFOLIO_ID,
      NOW,
      NOT_CONFIGURED_SHARESIGHT,
    ).then((holdings) => {
      if (holdings.unrealisedSummary) {
        buildHoldingsSummaryFooter(
          "AUD",
          holdings.unrealisedSummary,
          undefined,
        );
      }
    }),
  ]);
}

/** `/portfolio/:id/holdings`: `loadAuthenticatedWorkspace(portfolioId,
 * {includeHoldings: true})`. PRF-003: `holdings`/`realised` are mutually
 * independent (see `authenticated-workspace.ts`'s own PRF-003 comment) and
 * now run concurrently in the real loader. */
async function censusHoldingsPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  const [holdings, realised] = await Promise.all([
    loadOwnedHoldings(
      client,
      USER_ID,
      PORTFOLIO_ID,
      NOW,
      NOT_CONFIGURED_SHARESIGHT,
    ),
    loadOwnedRealisedGainTotals(client, USER_ID, PORTFOLIO_ID, NOW).catch(
      () => undefined,
    ),
  ]);
  if (holdings.unrealisedSummary) {
    buildHoldingsSummaryFooter(
      "AUD",
      holdings.unrealisedSummary,
      realised ? Object.fromEntries(realised.bySecurity) : undefined,
    );
  }
}

/** `/portfolio/:id/quotes` (via `[section]/page.tsx`, `includeQuotes:
 * true`) -- the `includeQuotes` branch returns BEFORE the
 * `activePortfolio === null` check, but AFTER the settings load, matching
 * `authenticated-workspace.ts`'s real order. */
async function censusQuotesPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  await loadOwnedWatchlist(client, USER_ID, {
    now: NOW,
    priceSourcePreference: "sharesight_delayed",
    baseCurrencyCode: "AUD",
  });
}

/** `/portfolio/:id/details` (via `[section]/page.tsx`'s "details" branch +
 * `app/portfolio-inspection.ts`). */
async function censusDetailsPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  await loadPortfolioInspectionSafely(client, USER_ID, PORTFOLIO_ID);
}

/** `/portfolio/:id/gains`. */
async function censusGainsPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  await loadOwnedCapitalGains(client, USER_ID, PORTFOLIO_ID, NOW).catch(
    () => undefined,
  );
}

/** `/portfolio/:id/income/dividends`. */
async function censusDividendsPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  await loadOwnedDividendList(client, USER_ID, PORTFOLIO_ID, NOW);
}

// ---------------------------------------------------------------------------
// PRF-005 -- the Income area's REMAINING pages (never censused by PRF-002,
// which covered only `/income/dividends`): `/income` (the reported Error
// 1102 -- "the first dividend tab"), `/income/multi-year`,
// `/income/assumptions`, and the four per-holding sub-tab pages.
// ---------------------------------------------------------------------------

/** `/portfolio/:id/income` (Next 12 months landing -- PRF-005's reported
 * Error 1102). Mirrors `app/portfolio/[portfolioId]/income/page.tsx`'s own
 * `{yearsBack: 5, yearsForward: 1}` call exactly. */
async function censusIncomePage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  await loadOwnedIncomeProjection(client, USER_ID, PORTFOLIO_ID, NOW, {
    yearsBack: 5,
    yearsForward: 1,
  });
}

/** `/portfolio/:id/income/multi-year`. Mirrors
 * `app/portfolio/[portfolioId]/income/multi-year/page.tsx`'s default
 * `{yearsBack: DEFAULT_YEARS_BACK, yearsForward: DEFAULT_YEARS_FORWARD}`
 * (no `?yearsBack=`/`?yearsForward=` query overrides) PLUS its own
 * concurrent `loadOwnedIncomeScenarios` read (PRF-005 parallelized this
 * page's own two independent reads -- see that page's PRF-005 comment). */
async function censusIncomeMultiYearPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  await Promise.all([
    loadOwnedIncomeProjection(client, USER_ID, PORTFOLIO_ID, NOW, {
      yearsBack: DEFAULT_YEARS_BACK,
      yearsForward: DEFAULT_YEARS_FORWARD,
    }),
    loadOwnedIncomeScenarios(client, USER_ID, PORTFOLIO_ID),
  ]);
}

/** `/portfolio/:id/income/assumptions`. Mirrors
 * `app/portfolio/[portfolioId]/income/assumptions/page.tsx`'s own
 * `loadOwnedDividendAssumptions` + FY-overrides-list pair, now concurrent
 * (PRF-005 -- see that page's own PRF-005 comment). */
async function censusIncomeAssumptionsPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  await Promise.all([
    loadOwnedDividendAssumptions(client, USER_ID, PORTFOLIO_ID, NOW),
    createDividendFyOverrideRepository(client).list(USER_ID, PORTFOLIO_ID),
  ]);
}

/** `/portfolio/:id/holdings/:holdingId` (the holding-area Details tab, via
 * `[section]/[holdingId]/page.tsx`, `includeHoldings: true`) -- mirrors
 * `censusHoldingsPage`'s own holdings+realised wave (identical
 * `loadAuthenticatedWorkspace({includeHoldings: true})` branch) PLUS the
 * page's own `loadOwnedHoldingIdentity` call. `marketDataProviderEnabled()`
 * is a `cloudflare:workers` env/runtime-config read, not a D1 call --
 * deliberately not reproduced here. */
async function censusHoldingDetailPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  await Promise.all([
    loadOwnedHoldings(
      client,
      USER_ID,
      PORTFOLIO_ID,
      NOW,
      NOT_CONFIGURED_SHARESIGHT,
    ),
    loadOwnedRealisedGainTotals(client, USER_ID, PORTFOLIO_ID, NOW).catch(
      () => undefined,
    ),
  ]);
  await loadOwnedHoldingIdentity(client, USER_ID, PORTFOLIO_ID, HOLDING_ID);
}

/** `/portfolio/:id/holdings/:holdingId/transactions`. Mirrors
 * `[holdingId]/transactions/page.tsx`'s plain `loadAuthenticatedWorkspace(portfolioId)`
 * (no `includeX` option, auth-gate only) + identity + transactions. */
async function censusHoldingTransactionsPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  const identity = await loadOwnedHoldingIdentity(
    client,
    USER_ID,
    PORTFOLIO_ID,
    HOLDING_ID,
  );
  if (!identity) return;
  await loadOwnedHoldingTransactions(client, USER_ID, PORTFOLIO_ID, HOLDING_ID);
}

/** `/portfolio/:id/holdings/:holdingId/news`. The page itself renders a
 * static embed (no further D1 read) once identity resolves -- mirrors
 * `[holdingId]/news/page.tsx`'s plain `loadAuthenticatedWorkspace(portfolioId)`
 * + identity only. */
async function censusHoldingNewsPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  await loadOwnedHoldingIdentity(client, USER_ID, PORTFOLIO_ID, HOLDING_ID);
}

/** `/portfolio/:id/holdings/:holdingId/dividends`. Mirrors
 * `[holdingId]/dividends/page.tsx`'s plain `loadAuthenticatedWorkspace(portfolioId)`
 * + identity + `loadOwnedSecurityDividendDetail`. */
async function censusHoldingDividendsPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  const identity = await loadOwnedHoldingIdentity(
    client,
    USER_ID,
    PORTFOLIO_ID,
    HOLDING_ID,
  );
  if (!identity) return;
  await loadOwnedSecurityDividendDetail(
    client,
    USER_ID,
    PORTFOLIO_ID,
    HOLDING_ID,
    NOW,
  );
}

const PAGES: Array<{
  name: string;
  run: (client: SqlClient) => Promise<void>;
}> = [
  { name: "/ (root overview)", run: censusRootOverviewPage },
  { name: "/portfolio/:id/holdings", run: censusHoldingsPage },
  { name: "/portfolio/:id/quotes", run: censusQuotesPage },
  { name: "/portfolio/:id/details", run: censusDetailsPage },
  { name: "/portfolio/:id/gains", run: censusGainsPage },
  { name: "/portfolio/:id/income/dividends", run: censusDividendsPage },
  { name: "/portfolio/:id/income", run: censusIncomePage },
  { name: "/portfolio/:id/income/multi-year", run: censusIncomeMultiYearPage },
  {
    name: "/portfolio/:id/income/assumptions",
    run: censusIncomeAssumptionsPage,
  },
  {
    name: "/portfolio/:id/holdings/:holdingId",
    run: censusHoldingDetailPage,
  },
  {
    name: "/portfolio/:id/holdings/:holdingId/transactions",
    run: censusHoldingTransactionsPage,
  },
  {
    name: "/portfolio/:id/holdings/:holdingId/news",
    run: censusHoldingNewsPage,
  },
  {
    name: "/portfolio/:id/holdings/:holdingId/dividends",
    run: censusHoldingDividendsPage,
  },
];

test("PRF-011: Holdings census with Sharesight CONFIGURED and ENABLED (fresh watermark, cache_fresh branch -- zero Sharesight fetches) issues exactly ONE sharesight_sync_state statement instead of two", async () => {
  // Every other census in this file runs with `NOT_CONFIGURED_SHARESIGHT`
  // (gate 1's own zero-fetch short-circuit), which never exercises gates
  // 2+3's `sharesight_sync_state` read at all -- this task's (c) fix only
  // has a statement to save on a load where Sharesight IS configured and
  // linked. Seeds a fresh (5-minutes-old) watermark so the gate takes the
  // `cache_fresh` branch deterministically -- no network fetch, no
  // additional writes, isolating exactly the gates-2+3 read count this
  // task changed.
  const db = await productionScaleFixture();
  db.exec(`
    INSERT INTO sharesight_sync_state (id, user_id, portfolio_id, sharesight_portfolio_id, enabled, created_at, updated_at, version, last_price_refresh_at, last_price_refresh_status)
      VALUES ('sync-1', 'owner-1', 'portfolio-1', 'sp-1', 1, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 1, '2026-08-01T11:55:00.000Z', 'ok');
  `);
  const CONFIGURED_SHARESIGHT_FRESH = {
    integration: {
      enabled: true as const,
      client: {
        listPortfolios: async () => {
          throw new Error("PRF-011 test: unexpected Sharesight call");
        },
        getPortfolioHoldings: async () => {
          throw new Error("PRF-011 test: unexpected Sharesight call");
        },
        listTrades: async () => {
          throw new Error("PRF-011 test: unexpected Sharesight call");
        },
        listPayouts: async () => {
          throw new Error("PRF-011 test: unexpected Sharesight call");
        },
        listUserInstruments: async () => {
          throw new Error(
            "PRF-011 test: no Sharesight fetch expected on the cache_fresh path",
          );
        },
      },
    },
    now: () => NOW.toISOString(),
  };
  const { client, stats } = stageCensusClient(createSqliteSqlClient(db));
  const result = await loadOwnedHoldings(
    client,
    USER_ID,
    PORTFOLIO_ID,
    NOW,
    CONFIGURED_SHARESIGHT_FRESH,
  );
  assert.equal(result.status, "complete");
  const syncStateCalls = stats.calls_.filter((call) =>
    call.sql.includes("sharesight_sync_state"),
  );
  assert.equal(
    syncStateCalls.length,
    1,
    "expected gates 2+3 to cost exactly one sharesight_sync_state read when configured and enabled",
  );
});

test("PRF-002: per-page census -- D1 calls/statements and EXPLAIN QUERY PLAN scan check at production scale (18 securities, 107 transactions, ~60k price_observations, 119 dividends, fully-backfilled portfolio_value_history)", async () => {
  const rows: string[] = [];
  for (const page of PAGES) {
    const db = await productionScaleFixture();
    const { client, stats } = stageCensusClient(createSqliteSqlClient(db));
    const t0 = performance.now();
    await page.run(client);
    const totalMs = performance.now() - t0;

    // THE REGRESSION GUARD (per PRF-001's own lesson: query-plan shape, not
    // wall-clock timing, is the robust, environment-independent proof) --
    // re-runs `EXPLAIN QUERY PLAN` on the EXACT SQL/params this page's real
    // loader chain just executed.
    assertNoLargeTableScans(db, stats.calls_);

    const stageSummary = [...stats.byStage.entries()]
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([stage, entry]) => `${stage}:${entry.calls}`)
      .join(", ");
    rows.push(
      `${page.name} -- calls=${stats.calls} statements=${stats.statements} wallMs=${totalMs.toFixed(2)} stages=[${stageSummary}]`,
    );

    // Secondary, informational-only signal (mirrors PRF-001's own ceiling):
    // D1 call/statement counts are stable regardless of machine load. A
    // generous ceiling per page -- none of these reads are per-security
    // loops over price history any more (PRF-001 fixed Holdings/gains'
    // shared price query; PRF-002's fix means Overview's steady-state read
    // no longer touches `price_observations` row data at all). The root
    // overview page previously paid an EXTRA ~150-statement
    // `READ_TIME_SNAPSHOT_CALCULATION_BUDGET` self-heal cost here on an
    // account whose snapshot pipeline had never published (ceiling 250) --
    // CALC-005 retired that self-heal entirely (docs/ARCHITECTURE.md's
    // CALC-005 entry), dropping the root page back to the same tight bound
    // as every other page; this ceiling is the DROP this retirement
    // produced, not a newly-chosen number.
    const ceiling = 60;
    assert.ok(
      stats.calls <= ceiling && stats.statements <= ceiling,
      `${page.name} issued ${stats.calls} D1 calls / ${stats.statements} statements (expected <= ${ceiling})`,
    );

    db.close();
  }
  // Printed for the TASKS.md census table / Orchestrator visibility --
  // informational, not asserted beyond the per-page bounds above (wall-clock
  // timing is not Workers CPU accounting; see PRF-001/HIST-002's own
  // caveat).
  console.log("\nPRF-002 per-page census (production-scale fixture):");
  for (const row of rows) console.log(`  ${row}`);
});

test("PRF-002: Overview's steady-state history read no longer touches transactions/fx_rate_observations or full price_observations rows once portfolio_value_history is fully backfilled", async () => {
  const db = await productionScaleFixture();
  const { client, stats } = stageCensusClient(createSqliteSqlClient(db));

  const result = await loadHistoricalPortfolioValueSeries(
    client,
    USER_ID,
    PORTFOLIO_ID,
    NOW,
  );
  assert.ok(result);
  assert.equal(result.backfillPending, false);
  assert.ok(result.points.length > 0);

  // THE FIX: the full `loadFacts` read (every `transactions` row, every
  // `fx_rate_observations` row, every `price_observations` column) never
  // runs when nothing is missing. `resolveRange` legitimately still runs
  // its OWN small, bounded `earliest_trade_date` sub-select against
  // `transactions` (needed regardless of the fast/slow path split, and
  // unrelated to this fix) -- so the guard here is that `loadFacts`'s OWN
  // dedicated transactions-row read (identifiable by its distinct column
  // list) never appears, and `fx_rate_observations` -- touched ONLY by
  // `loadFacts`, never by `resolveRange`/`loadCandidateDates` -- is
  // untouched entirely.
  const transactionCalls = stats.calls_.filter((call) =>
    call.sql.includes("transactions"),
  );
  assert.equal(
    transactionCalls.length,
    1,
    "expected only resolveRange's own bounded earliest-trade-date lookup",
  );
  assert.doesNotMatch(
    transactionCalls[0]!.sql,
    /reverses_transaction_id/,
    "loadFacts's own full transactions-row read ran on the fully-backfilled fast path",
  );
  assert.equal(
    stats.byStage.get("fx_rate_observations"),
    undefined,
    "loadHistoricalPortfolioValueSeries touched fx_rate_observations on the fully-backfilled fast path",
  );
  // The lightweight candidate-dates query still touches price_observations
  // (by design -- it is how "nothing is missing" is determined), but only
  // ever selects the single `market_date` column, never `po.*`.
  const priceCalls = stats.calls_.filter((call) =>
    call.sql.includes("price_observations"),
  );
  assert.equal(priceCalls.length, 1);
  assert.match(priceCalls[0]!.sql, /SELECT DISTINCT po\.market_date/);
  assert.doesNotMatch(priceCalls[0]!.sql, /po\.\*/);

  assertNoLargeTableScans(db, stats.calls_);
  db.close();
});

test("PRF-002: the new candidate-dates query seeks price_observations_security_date_idx, not a full table scan", async () => {
  const db = await productionScaleFixture();
  const { client, stats } = stageCensusClient(createSqliteSqlClient(db));
  await loadHistoricalPortfolioValueSeries(client, USER_ID, PORTFOLIO_ID, NOW);
  const priceCall = stats.calls_.find((call) =>
    call.sql.includes("price_observations"),
  );
  assert.ok(priceCall);
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${priceCall.sql}`)
    .all(...((priceCall.params ?? []) as never[])) as Array<{
    detail: string;
  }>;
  const planText = plan.map((row) => row.detail).join(" | ");
  for (const row of plan) {
    assert.doesNotMatch(
      row.detail,
      /^SCAN po\b/,
      `expected an index seek, got: ${planText}`,
    );
  }
  assert.match(
    planText,
    /SEARCH po USING INDEX price_observations_security_date_idx/,
  );
  db.close();
});

test("PRF-002: loadHistoricalPortfolioValueSeries still correctly derives and persists genuinely missing dates (slow path unregressed by the fast-path fix)", async () => {
  const db = await migratedDatabase();
  const now = "2026-08-01T00:00:00.000Z";
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES ('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES ('user-a','active','a@example.test','Australia/Sydney','${now}','${now}');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-a','user-a','A','A portfolio','AUD','Australia/Sydney','fifo','active','${now}','${now}');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES ('security-a','equity','AUD','Security A','${now}','${now}');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES ('ps-a','user-a','portfolio-a','security-a','SYM','AUD','held','${now}','${now}');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES ('mapping-a','security-a','yahoo-compatible','ASX','SYM','2015-01-01','verified');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES ('tx-a','user-a','portfolio-a','ps-a','buy','posted','2026-07-28T00:00:00.000Z','2026-07-28','100','10','AUD','1000','0','0','manual','user-a',1,'2026-07-28');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-1','yahoo-compatible','deployment',NULL,'deployment','mapping-a','security-a','eod','2026-07-28T04:00:00Z','2026-07-28','Australia/Sydney','AUD','10.00','raw','observed','2026-07-28T04:00:00Z'),
      ('price-2','yahoo-compatible','deployment',NULL,'deployment','mapping-a','security-a','eod','2026-07-29T04:00:00Z','2026-07-29','Australia/Sydney','AUD','11.00','raw','observed','2026-07-29T04:00:00Z'),
      ('price-3','yahoo-compatible','deployment',NULL,'deployment','mapping-a','security-a','eod','2026-07-30T04:00:00Z','2026-07-30','Australia/Sydney','AUD','12.00','raw','observed','2026-07-30T04:00:00Z');
  `);

  const client = createSqliteSqlClient(db);
  const result = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-01T12:00:00Z"),
  );
  assert.ok(result);
  assert.equal(result.backfillPending, false);
  assert.deepEqual(
    result.points.map((point) => point.date),
    ["2026-07-28", "2026-07-29", "2026-07-30"],
  );
  assert.equal(result.points[2]!.valueDecimal, "1200");

  // Persisted for next time (HIST-002's own opportunistic-persist contract,
  // unchanged by this task).
  const stored = db
    .prepare(
      `SELECT count(*) AS count FROM portfolio_value_history WHERE user_id = 'user-a' AND portfolio_id = 'portfolio-a'`,
    )
    .get() as { count: number };
  assert.equal(stored.count, 3);

  // A second read is now the fully-backfilled fast path and derives nothing
  // new (invalidate one date first to prove the fast/slow split still
  // toggles correctly on repeat reads).
  await invalidateStoredValueHistoryForSecurity(
    client,
    "user-a",
    "security-a",
    ["2026-07-30"],
  );
  const second = await loadHistoricalPortfolioValueSeries(
    client,
    "user-a",
    "portfolio-a",
    new Date("2026-08-01T12:00:00Z"),
  );
  assert.ok(second);
  assert.equal(second.backfillPending, false);
  assert.equal(second.points[2]!.valueDecimal, "1200");

  db.close();
});

test("PRF-002 (auth-resolution duplication, now fixed): resolving the SAME authenticated identity twice costs exactly double the D1 work of resolving it once", async () => {
  // This does not import `app/authenticated-workspace.ts`/`app/
  // portfolio-actions.ts` directly (both pull in `next/headers`, which does
  // not resolve under plain `node --test` -- see this file's header) --
  // instead it drives the SAME underlying identity resolution
  // (`domain/auth/identity-lifecycle.ts`'s `resolve`, via
  // `domain/auth/request-context.ts`'s `resolveAuthenticatedRequestContext`,
  // both plain `.ts` modules with no framework import) that both functions
  // call, proving the SHAPE of the duplication the six PRF-002 page fixes
  // eliminate: two resolutions of the identical principal cost exactly
  // twice one resolution's D1 calls/statements (each existing-identity
  // resolution runs `touchWithAudit`'s 2 UPDATEs + 1 conditional audit
  // INSERT, per `db/repositories/identity.ts`).
  const { resolveAuthenticatedRequestContext } =
    await import("../domain/auth/request-context.ts");
  const db = await migratedDatabase();
  const now = "2026-08-01T00:00:00.000Z";
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES ('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES ('owner-1','active','owner1@example.test','Australia/Sydney','${now}','${now}');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES ('owner-1','AUD','Australia/Sydney',7,'${now}','${now}',1);
    INSERT INTO user_identities(id,user_id,provider,issuer,subject,status,created_at,updated_at) VALUES ('identity-1','owner-1','cloudflare_access','https://issuer.example.test','subject-1','active','${now}','${now}');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-1','owner-1','P','Portfolio','AUD','Australia/Sydney','fifo','active','${now}','${now}');
  `);
  const principal = {
    tokenType: "app" as const,
    issuer: "https://issuer.example.test",
    audience: "aud",
    subject: "subject-1",
    email: "owner1@example.test",
    issuedAt: null,
    notBefore: 0,
    expiresAt: 9_999_999_999,
    keyId: "kid-1",
  };

  const once = stageCensusClient(createSqliteSqlClient(db));
  const first = await resolveAuthenticatedRequestContext(
    once.client,
    principal,
    "portfolio-1",
  );
  assert.equal(first.ok, true);
  const oneResolutionStatements = once.stats.statements;
  assert.ok(
    oneResolutionStatements > 0,
    "expected the identity touch/audit batch to cost real statements",
  );

  const twice = stageCensusClient(createSqliteSqlClient(db));
  await resolveAuthenticatedRequestContext(
    twice.client,
    principal,
    "portfolio-1",
  );
  await resolveAuthenticatedRequestContext(
    twice.client,
    principal,
    "portfolio-1",
  );
  assert.equal(twice.stats.statements, oneResolutionStatements * 2);
  db.close();
});

test("PRF-011: /import and /ledger/new now cost exactly ONE identity resolution (oneResolutionStatements) instead of two -- source-verified, since neither page.tsx can be driven directly under plain node --test (next/headers)", async () => {
  // Mirrors the test immediately above: `oneResolutionStatements` is what
  // ONE `resolveAuthenticatedRequestContext` call costs (identity lookup
  // plus `touchWithAudit`'s 2 UPDATEs + 1 conditional audit INSERT). Before
  // this task, `app/import/page.tsx` and `app/portfolio/[portfolioId]/
  // ledger/new/page.tsx` each called `loadAuthenticatedWorkspace()` (one
  // resolution) and THEN `getAuthenticatedSqlContext()` a second time (a
  // second, full resolution) purely to recover the SqlClient/userId their
  // own section-specific loader needed -- costing `oneResolutionStatements
  // * 2`, including a SECOND, duplicate audit-log row per page view. Both
  // pages now thread `loadAuthenticatedWorkspace`'s `sqlContextOut` output
  // slot instead (see `app/authenticated-workspace.ts`'s
  // `AuthenticatedWorkspaceSqlContext` doc comment), matching the SAME
  // `sqlContextOut` pattern the six PRF-002 pages already use
  // (`[section]/page.tsx`, `gains/page.tsx`). Neither page can be imported
  // and driven directly here (`next/headers` -- see this file's header), so
  // this is a source-level proof that the SECOND resolution call is gone --
  // the runtime cost of avoiding it is exactly `oneResolutionStatements`
  // above, proven generically by the "twice" test immediately above.
  const [importPage, ledgerNewPage] = await Promise.all([
    readFile(new URL("../app/import/page.tsx", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/ledger/new/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  for (const page of [importPage, ledgerNewPage]) {
    assert.match(page, /loadAuthenticatedWorkspace\(/);
    assert.match(page, /sqlContextOut/);
    assert.doesNotMatch(
      page,
      /getAuthenticatedSqlContext\(/,
      "expected the second, duplicate identity resolution to be gone",
    );
  }
});

test("PRF-002/CALC-005: the root overview census never claims, advances, or otherwise touches the legacy queued snapshot-pipeline row", async () => {
  // `productionScaleFixture` seeds `snapshot-run-1`, a legacy queued
  // snapshot-pipeline row standing in for production's real stuck run (see
  // that function's own doc comment). Before CALC-005, the root-overview
  // page's read-time self-heal would claim and spend a full
  // `READ_TIME_SNAPSHOT_CALCULATION_BUDGET` (150 statements) trying to
  // advance exactly this shape on every single load -- this proves that
  // self-heal is gone: the row is left completely untouched by a real
  // root-overview page census.
  const db = await productionScaleFixture();
  const before = db
    .prepare(
      `SELECT status, attempt, lease_owner, updated_at FROM calculation_runs WHERE id = 'snapshot-run-1'`,
    )
    .get() as {
    status: string;
    attempt: number;
    lease_owner: string | null;
    updated_at: string;
  };
  assert.equal(before.status, "queued");

  const { client, stats } = stageCensusClient(createSqliteSqlClient(db));
  await censusRootOverviewPage(client);

  const after = db
    .prepare(
      `SELECT status, attempt, lease_owner, updated_at FROM calculation_runs WHERE id = 'snapshot-run-1'`,
    )
    .get() as {
    status: string;
    attempt: number;
    lease_owner: string | null;
    updated_at: string;
  };
  assert.deepEqual(after, before);
  // No statement ever mentions the snapshot pipeline at all -- the census
  // page's own `loadOwnedHoldings`/projection-publication read legitimately
  // joins `calculation_runs` for the UNRELATED projection pipeline, so the
  // guard here is specifically that nothing filters or writes by
  // `pipeline = 'snapshot'` (a claim attempt, a supersede pre-pass, or a
  // rebuild statement all would).
  const snapshotPipelineCalls = stats.calls_.filter((call) =>
    call.sql.includes("'snapshot'"),
  );
  assert.equal(
    snapshotPipelineCalls.length,
    0,
    `expected zero snapshot-pipeline statements, saw: ${snapshotPipelineCalls.map((c) => c.sql).join(" | ")}`,
  );
  db.close();
});

// PRF-003 review round 2 (BLOCKING correction): these ceilings are the REAL
// measured critical-path depths after each task's own parallelization fixes
// -- not an aspirational target. PRF-003 left Root and Holdings at an 8-deep
// critical path (the `loadOwnedHoldings` chain:
// publication-count/publication-row/identities -> Sharesight-gate/
// holding-projections -> price-count/price-fetch -> manual_overrides ->
// cash_accounts/cash_ledger_entries).
//
// PRF-004 (owner-reported, verbatim: "It is still slow, 3 to 10+ seconds per
// page") dropped both to 6 by batching within `loadOwnedHoldings`: the
// publication-count precheck was folded into the publication-row fetch
// itself (`LIMIT 2`, so 0/1/2+ rows answers the same "exactly one?" question
// the separate `count(*)` used to -- see that query's own PRF-004 comment),
// the price/FX count-then-fetch prechecks were dropped entirely (each
// fetch's own pre-existing `LIMIT MAX_OBSERVATIONS + 1`/length check already
// answered "too many?" -- the count query could never learn anything new),
// and `cash_accounts`/`cash_ledger_entries` were hoisted into the same big
// concurrent wave as price/FX/trades/settings (neither depends on that
// wave's outputs, or on the per-security `rows` built afterward) instead of
// being fetched afterward, sequentially, inside `loadCash`. The remaining
// 6-deep chain (identities/publication -> Sharesight-gate/projections ->
// {price, FX, cash_accounts, cash_ledger_entries, transactions, settings} ->
// manual_overrides, plus, on `/` specifically, the parallel
// `resolveRange -> candidates/stored` chain from
// `loadHistoricalPortfolioValueSeries` landing in the same critical path) is
// a real, named, NOT-YET-CLOSED follow-up. These bounds exist so a FUTURE
// re-serialization regression still fires this guard, not to claim the
// target was met.
const DEPTH_CEILING: Record<string, number> = {
  "/ (root overview)": 6,
  "/portfolio/:id/holdings": 6,
  "/portfolio/:id/quotes": 4,
  "/portfolio/:id/details": 3,
  // PRF-011: raised from 4 to 5 once the fixture above gained a genuine
  // active disposal (previously `/gains` never exercised anything past
  // `loadOwnedCapitalGains`'s zero-active-sell short-circuit -- 4 was
  // calibrated to that shallow shape, not a measured disposal chain). The
  // real post-fix chain is baseWorkspaceLoad's own wave (settings/FX,
  // depth 1) then `loadOwnedCapitalGains`'s now-4-deep sequence
  // (portfolio+settings Promise.all -> activeSellCount ->
  // publication(LIMIT 2) -> allocations(LEFT JOIN, LIMIT MAX+1)) -- the
  // exact "5 statements / depth <= 4" this task's own acceptance criterion
  // names for `loadOwnedCapitalGains` alone, plus the page census's
  // pre-existing +1 for baseWorkspaceLoad.
  "/portfolio/:id/gains": 5,
  "/portfolio/:id/income/dividends": 6,
  // PRF-005: `/income`/`/income/multi-year` layer `loadHistoricalPortfolioValueAtDates`
  // (needed for `pastFinancialYears`) SEQUENTIALLY after the
  // holdings/history wave -- it genuinely cannot start earlier, since it
  // needs the FY window `loadOwnedDividendHistory`'s `today`/
  // `financialYearStartMonth` resolves first to know WHICH FY-end dates to
  // query -- stacking on top of `loadOwnedHoldings`' own already-recorded
  // 6-deep internal chain (see the comment above `DEPTH_CEILING`). This
  // task's fix targeted the dominant COST at this depth (row volume -- see
  // `historical-portfolio-value.ts`'s PRF-005 comment, the loadFacts
  // full-range-scan defect that caused the reported Error 1102, a CPU
  // limit, not a latency one); further depth reduction here is a real,
  // not-yet-closed PRF-003-class follow-up, not attempted in this task.
  "/portfolio/:id/income": 11,
  "/portfolio/:id/income/multi-year": 11,
  "/portfolio/:id/income/assumptions": 8,
  "/portfolio/:id/holdings/:holdingId": 7,
  "/portfolio/:id/holdings/:holdingId/transactions": 3,
  "/portfolio/:id/holdings/:holdingId/news": 2,
  "/portfolio/:id/holdings/:holdingId/dividends": 9,
};

test("PRF-003: per-page SEQUENTIAL DEPTH census -- critical-path length (longest non-overlapping D1 round-trip chain) and modeled wall time at a simulated 40ms round trip", async () => {
  const rows: string[] = [];
  for (const page of PAGES) {
    const db = await productionScaleFixture();
    const { client, waves } = depthCensusClient(createSqliteSqlClient(db));
    await page.run(client);
    const { depth, chain, modeledWallMs, waveSizes } = waves();
    rows.push(
      `${page.name} -- depth=${depth} modeledWallMs=${modeledWallMs} concurrencyGroups=[${waveSizes.join(",")}] criticalPath=[${chain.join(" -> ")}]`,
    );
    const ceiling = DEPTH_CEILING[page.name];
    assert.ok(
      ceiling !== undefined,
      `no depth ceiling recorded for ${page.name}`,
    );
    assert.ok(
      depth <= ceiling!,
      `${page.name} has sequential depth ${depth} (critical path: [${chain.join(" -> ")}]), expected <= ${ceiling}`,
    );
    db.close();
  }
  console.log(
    "\nPRF-003 per-page critical-path depth census (production-scale fixture, modeled at 40ms/round trip):",
  );
  for (const row of rows) console.log(`  ${row}`);
});

test("PRF-003: auth-resolution depth -- touchWithAudit no longer pays a reread round trip after its write, for an existing identity", async () => {
  const { resolveAuthenticatedRequestContext } =
    await import("../domain/auth/request-context.ts");
  const db = await migratedDatabase();
  const now = "2026-08-01T00:00:00.000Z";
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES ('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES ('owner-1','active','owner1@example.test','Australia/Sydney','${now}','${now}');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES ('owner-1','AUD','Australia/Sydney',7,'${now}','${now}',1);
    INSERT INTO user_identities(id,user_id,provider,issuer,subject,status,created_at,updated_at) VALUES ('identity-1','owner-1','cloudflare_access','https://issuer.example.test','subject-1','active','${now}','${now}');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-1','owner-1','P','Portfolio','AUD','Australia/Sydney','fifo','active','${now}','${now}');
  `);
  const principal = {
    tokenType: "app" as const,
    issuer: "https://issuer.example.test",
    audience: "aud",
    subject: "subject-1",
    email: "owner1@example.test",
    issuedAt: null,
    notBefore: 0,
    expiresAt: 9_999_999_999,
    keyId: "kid-1",
  };
  const { client, waves } = depthCensusClient(createSqliteSqlClient(db));
  const result = await resolveAuthenticatedRequestContext(
    client,
    principal,
    "portfolio-1",
  );
  assert.equal(result.ok, true);
  const { depth } = waves();
  // Before PRF-003: findAccessIdentity (wave 1) -> touchWithAudit's batch
  // (wave 2) -> the reread findAccessIdentity (wave 3) -> the portfolio
  // lookup (wave 4) = depth 4. PRF-003 removed the reread (merged in-memory
  // from already-known fields -- see db/repositories/identity.ts's PRF-003
  // comment), leaving depth 3: findAccessIdentity -> touchWithAudit's batch
  // -> portfolio lookup. PRF-004 (owner-reported: tab navigation still
  // 3-10+s on Workers Free): the portfolio lookup's SQL depends only on the
  // ALREADY-KNOWN `userId` (available the instant `findAccessIdentity`
  // resolves to an active record), never on anything `touchWithAudit`'s
  // audit-write batch produces -- `identity-lifecycle.ts`'s
  // `onIdentityKnown` hook now fires the portfolio lookup at that point, so
  // it runs CONCURRENTLY with the audit-write batch instead of strictly
  // after it. depth 2: findAccessIdentity -> {touchWithAudit batch,
  // portfolio lookup} as one wave.
  assert.equal(
    depth,
    2,
    "expected identity findAccessIdentity, then touchWithAudit's batch and the portfolio lookup running concurrently in one wave",
  );
});

test("PRF-004 review (B1, BLOCKING): a correlated D1 failure -- touchWithAudit's batch AND the eagerly-started portfolio read both failing -- rejects with the audit error and never leaves an unhandledRejection", async () => {
  // Reviewer's finding: `onIdentityKnown`'s early portfolio read is fired
  // and forgotten until the `await earlyActivePortfolio` join further down
  // `resolveAuthenticatedRequestContext` -- but that join is UNREACHABLE
  // whenever `identity.resolve()` itself rejects first (e.g. `touchWithAudit`'s
  // `client.batch` failing, the EXP-004 D1_ERROR class). If the early
  // portfolio promise ALSO rejects in that window, nothing ever observes
  // it -- a real Node `unhandledRejection` on every authenticated request
  // during a correlated D1 incident. This reproduces exactly that shape: a
  // SqlClient whose `batch()` always rejects (simulating the audit-write
  // failure) AND whose portfolio-lookup `get()` also rejects.
  const { resolveAuthenticatedRequestContext } =
    await import("../domain/auth/request-context.ts");
  const db = await migratedDatabase();
  const now = "2026-08-01T00:00:00.000Z";
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES ('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES ('owner-1','active','owner1@example.test','Australia/Sydney','${now}','${now}');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES ('owner-1','AUD','Australia/Sydney',7,'${now}','${now}',1);
    INSERT INTO user_identities(id,user_id,provider,issuer,subject,status,created_at,updated_at) VALUES ('identity-1','owner-1','cloudflare_access','https://issuer.example.test','subject-1','active','${now}','${now}');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-1','owner-1','P','Portfolio','AUD','Australia/Sydney','fifo','active','${now}','${now}');
  `);
  const principal = {
    tokenType: "app" as const,
    issuer: "https://issuer.example.test",
    audience: "aud",
    subject: "subject-1",
    email: "owner1@example.test",
    issuedAt: null,
    notBefore: 0,
    expiresAt: 9_999_999_999,
    keyId: "kid-1",
  };
  const base = createSqliteSqlClient(db);
  const AUDIT_ERROR = new Error(
    "PRF-004 B1 drill: touchWithAudit batch failure (D1_ERROR)",
  );
  const PORTFOLIO_ERROR = new Error(
    "PRF-004 B1 drill: portfolio read failure (D1_ERROR)",
  );
  const client: SqlClient = {
    all: <T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => base.all<T>(sql, params),
    get: <T extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => {
      // The early `onIdentityKnown` portfolio lookup
      // (`owned-portfolios.ts`'s `get`) is the only query joining
      // `portfolios AS p` on `p.id = ?` -- every OTHER `get`/`all` call this
      // request makes (identity resolution, `user_settings`) must keep
      // working normally so `resolve()` actually reaches, and fails inside,
      // `touchWithAudit`'s `batch()` below.
      if (sql.includes("FROM portfolios AS p") && sql.includes("p.id = ?")) {
        return Promise.reject(PORTFOLIO_ERROR) as Promise<T | undefined>;
      }
      return base.get<T>(sql, params);
    },
    run: (sql: string, params?: readonly unknown[]) => base.run(sql, params),
    batch: () => Promise.reject(AUDIT_ERROR),
  };

  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    await assert.rejects(
      () =>
        resolveAuthenticatedRequestContext(client, principal, "portfolio-1"),
      (error: unknown) => error === AUDIT_ERROR,
    );
    // Give the event loop a full turn (Node fires `unhandledRejection` on a
    // later microtask/macrotask than the rejection itself) so a genuinely
    // unobserved rejection -- the exact bug this test guards against -- has
    // a chance to surface before asserting none did.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
  assert.deepEqual(
    unhandled,
    [],
    "expected the early portfolio read's rejection to be observed (via its own .catch), never surfaced as an unhandledRejection",
  );
  db.close();
});

test("PRF-003: the confirmed 20-second-outlier theory -- after a single cron-style invalidation, Overview's slow-path price read is bounded to the invalidated date, not the portfolio's entire multi-year history", async () => {
  const db = await productionScaleFixture();
  // Simulate the owner's report: the :25/:55 cron price capture lands a
  // fresher price for one security on "today" (2026-08-01, this fixture's
  // `now`), which invalidates that one stored portfolio_value_history row
  // for every portfolio holding it (matches
  // `intraday-price-capture.ts`/`market-data-refresh.ts`'s real
  // single-security/single-date invalidation shape -- see
  // `historical-portfolio-value.ts`'s `invalidateStoredValueHistoryForSecurity`
  // doc comment). Only "security-0" is invalidated; every OTHER security's
  // stored row for that date is untouched, so this reproduces the real
  // shape exactly: ONE missing candidate date out of ~3,334 stored ones.
  const client = createSqliteSqlClient(db);
  const invalidated = await invalidateStoredValueHistoryForSecurity(
    client,
    USER_ID,
    "security-0",
    ["2026-08-01"],
  );
  assert.equal(invalidated.portfoliosInvalidated, 1);
  assert.equal(invalidated.rowsDeleted, 1);

  const { client: censusClient, stats } = stageCensusClient(
    createSqliteSqlClient(db),
  );
  const result = await loadHistoricalPortfolioValueSeries(
    censusClient,
    USER_ID,
    PORTFOLIO_ID,
    NOW,
  );
  assert.ok(result);
  // Exactly one date needed real derivation (2026-08-01) -- confirms this
  // reproduces the reported shape (a single invalidated day), not a
  // wholesale backfill.
  assert.equal(result.backfillPending, false);

  // THE FIX: the slow-path `po.*` read (loadFacts, identifiable by its
  // `po.*` column list, as opposed to the fast-path/candidate-dates
  // `SELECT DISTINCT po.market_date` query) is now bounded to the single
  // derived date's span, not the portfolio's entire multi-year
  // rangeFrom..rangeTo window.
  const fullRowPriceCalls = stats.calls_.filter(
    (call) =>
      call.sql.includes("price_observations") && call.sql.includes("po.*"),
  );
  assert.equal(
    fullRowPriceCalls.length,
    1,
    "expected exactly one loadFacts price read on the slow path",
  );
  const priceCall = fullRowPriceCalls[0]!;
  // BETWEEN params sit right after the security-id IN-list placeholders;
  // this fixture holds 18 securities.
  const betweenFrom = priceCall.params?.[SECURITY_COUNT];
  const betweenTo = priceCall.params?.[SECURITY_COUNT + 1];
  assert.equal(betweenFrom, "2026-08-01");
  assert.equal(betweenTo, "2026-08-01");

  // Prove the ROW-COUNT consequence directly against the real fixture data,
  // not just the query text: re-running the EXACT captured query returns
  // one row per security for the single invalidated date (18), not
  // anywhere near the fixture's ~60,012 total price_observations rows the
  // UNBOUNDED [rangeFrom, rangeTo] window this task fixes would have read.
  const rowsReturned = db
    .prepare(priceCall.sql)
    .all(...(priceCall.params as never[])) as unknown[];
  assert.equal(rowsReturned.length, SECURITY_COUNT);

  // Contrast figure (informational): what the OLD unconditional
  // `[rangeFrom, rangeTo]` window would have read for the SAME predicate --
  // this fixture's full ~10-year-capped history, matching the ~60,012 total
  // seeded rows (minus the one invalidated/deleted date's worth, and
  // clamped by the 10-year MAX_CANDIDATE_DATES floor `resolveRange`
  // applies -- the exact count is not the point, only the order of
  // magnitude versus the 18-row bounded read above).
  const securityIds = Array.from(
    { length: SECURITY_COUNT },
    (_, index) => `security-${index}`,
  );
  const oldUnboundedCount = db
    .prepare(
      `SELECT count(*) AS count FROM price_observations po WHERE po.security_id IN (${securityIds.map(() => "?").join(",")}) AND po.market_date BETWEEN '2017-01-01' AND '2026-08-01' AND po.adjustment_state = 'raw' AND ((po.access_scope = 'deployment' AND po.scope_user_id IS NULL) OR (po.access_scope = 'user' AND po.scope_user_id = ?))`,
    )
    .get(...securityIds, USER_ID) as { count: number };
  console.log(
    `\nPRF-003 20s-outlier fix: bounded slow-path read = ${rowsReturned.length} price_observations rows; the old unconditional full-range read would have been ${oldUnboundedCount.count} rows (~${Math.round(oldUnboundedCount.count / rowsReturned.length)}x more).`,
  );
  assert.ok(oldUnboundedCount.count > rowsReturned.length * 100);

  db.close();
});

test("PRF-005 (Error 1102 root cause): loadHistoricalPortfolioValueAtDates -- feeding the Income landing page's pastFinancialYears -- RETURNS/marshals a bounded number of rows per requested date, even though D1's own index-seek walks the full per-security range once 2+ windows are OR'd together (rows_read is NOT reduced -- see this test's own comment below)", async () => {
  // Reproduces `loadOwnedIncomeProjection`'s own `yearsBack: 5` FY-end date
  // set exactly (`/portfolio/:id/income`'s reported call shape) -- five
  // FY-end dates roughly a year apart, well within the fixture's ~9-year
  // seeded price history.
  const db = await productionScaleFixture();
  const { client, stats } = stageCensusClient(createSqliteSqlClient(db));
  const requestedDates = [
    "2026-06-30",
    "2025-06-30",
    "2024-06-30",
    "2023-06-30",
    "2022-06-30",
  ];
  const result = await loadHistoricalPortfolioValueAtDates(
    client,
    USER_ID,
    PORTFOLIO_ID,
    requestedDates,
    NOW,
  );
  assert.ok(result);
  assert.equal(result.size, requestedDates.length);

  // THE FIX (corrected framing -- review B2, BLOCKING): `loadFacts`'s
  // full-row `po.*` price read is now ONE query covering
  // `requestedDates.length` narrow (`MULTI_YEAR_PRICE_TOLERANCE_DAYS` + 1 =
  // 8 calendar days each) OR'd windows, instead of the single unconditional
  // `[boundedRangeFrom, range.rangeTo]` span that previously RETURNED
  // essentially every seeded `price_observations` row (~60,012) on EVERY
  // call regardless of how few dates were requested. This bounds rows
  // RETURNED/marshalled/JS-validated (`mapPrice`, and the D1->Worker
  // response payload) -- the real Worker-CPU cost that caused Error 1102.
  //
  // It does NOT bound D1's own `rows_read` metering (what D1 bills against
  // the Free plan's 5M-row/day allowance): the EXPLAIN QUERY PLAN assertion
  // below confirms that once 2+ windows are OR'd together, SQLite drops
  // `market_date` from the index seek itself (`security_id=? AND
  // adjustment_state=?` only) instead of the SINGLE-window case's
  // `security_id=? AND adjustment_state=? AND market_date>? AND
  // market_date<?` -- the OR'd BETWEEN clauses become a residual filter
  // applied AFTER walking every index entry for that security, so D1 still
  // walks essentially the SAME ~60,012 index entries either way. UNION ALL
  // (one BETWEEN-bounded seek per date, unioned) was evaluated and
  // rejected: repeating the `security_id IN (...)` list once per branch
  // would need `windows.length * securityIds.length` bound params -- 10
  // windows x 18 securities = 180, over D1's ~100-bound-param cap well
  // before `yearsBack`'s own 10-year ceiling is reached.
  const fullRowPriceCalls = stats.calls_.filter(
    (call) =>
      call.sql.includes("price_observations") && call.sql.includes("po.*"),
  );
  assert.equal(
    fullRowPriceCalls.length,
    1,
    "expected exactly one loadFacts price read for the whole multi-date call",
  );
  const priceCall = fullRowPriceCalls[0]!;
  const rowsReturned = db
    .prepare(priceCall.sql)
    .all(...(priceCall.params as never[])) as unknown[];
  // Upper bound: 5 dates * 8-day window * 18 securities = 720 rows max
  // (generously; most windows return far fewer since this fixture prices
  // every calendar day, so a `BETWEEN` window this narrow cannot return
  // more than window-width rows per security). This is a rows-RETURNED
  // bound, not a rows-read one.
  assert.ok(
    rowsReturned.length <= 5 * 8 * SECURITY_COUNT,
    `expected a bounded per-date-window RETURN, got ${rowsReturned.length} rows`,
  );

  // Direct proof of the B2 correction: with 2+ OR'd windows, `market_date`
  // is NOT part of the index seek -- D1 still walks the full per-security
  // range (the `rows_read` cost), only the RETURNED row count is bounded.
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${priceCall.sql}`)
    .all(...(priceCall.params as never[])) as Array<{ detail: string }>;
  const seekDetail =
    plan.find((row) => row.detail.startsWith("SEARCH po"))?.detail ?? "";
  assert.match(
    seekDetail,
    /^SEARCH po USING INDEX price_observations_security_date_idx \(security_id=\? AND adjustment_state=\?\)$/,
    `expected market_date to be dropped from the index seek once 2+ windows are OR'd together (confirms D1 rows_read is NOT reduced by this fix), got: ${seekDetail}`,
  );

  // Contrast figure: the fixture's full ~60,012-row multi-year history the
  // OLD unconditional `[rangeFrom, rangeTo]` window would have RETURNED
  // instead, for the identical predicate -- a rows-RETURNED comparison
  // (the Worker-CPU/1102 fix), NOT a rows-READ one (D1's own metering is
  // effectively unchanged, per the EXPLAIN assertion above).
  const securityIds = Array.from(
    { length: SECURITY_COUNT },
    (_, index) => `security-${index}`,
  );
  const oldUnboundedReturnedCount = db
    .prepare(
      `SELECT count(*) AS count FROM price_observations po WHERE po.security_id IN (${securityIds.map(() => "?").join(",")}) AND po.market_date BETWEEN '2017-01-01' AND '2026-08-01' AND po.adjustment_state = 'raw' AND ((po.access_scope = 'deployment' AND po.scope_user_id IS NULL) OR (po.access_scope = 'user' AND po.scope_user_id = ?))`,
    )
    .get(...securityIds, USER_ID) as { count: number };
  console.log(
    `\nPRF-005 /income root-cause fix: loadHistoricalPortfolioValueAtDates(yearsBack=5) now RETURNS/marshals ${rowsReturned.length} price_observations rows instead of ${oldUnboundedReturnedCount.count} (~${Math.round(oldUnboundedReturnedCount.count / rowsReturned.length)}x fewer rows returned/validated -- the Worker-CPU win that fixes Error 1102). D1's own rows_read stays essentially UNCHANGED (~${oldUnboundedReturnedCount.count} index entries still walked, per the EXPLAIN QUERY PLAN assertion above) -- this fix does not reduce D1 read-row billing.`,
  );
  assert.ok(oldUnboundedReturnedCount.count > rowsReturned.length * 50);

  // Every captured price/fx query still seeks the index by security_id
  // (never a bare table SCAN), even though market_date itself falls out of
  // the seek bound for the multi-window case above.
  assertNoLargeTableScans(db, stats.calls_);
  db.close();
});

test("PRF-005 review F1 (honesty-material, non-blocking): a per-date tolerance window can reach BELOW the 10-year clamp floor where the old full-range read never could -- a floor-adjacent date with only a just-below-floor price now resolves complete instead of an honest-but-avoidable gap", async () => {
  // Reviewer's exact reproduction: for `now = 2026-08-01` (this file's own
  // NOW-shaped fixtures), `resolveRange`'s `MAX_CANDIDATE_DATES`-derived
  // 10-year floor lands on 2016-07-25 -- confirmed by direct computation
  // (`earliestAllowedMs = Date.parse('2026-08-01') - (3660-1)*86_400_000`).
  // A portfolio whose earliest trade predates that floor (seeded below,
  // 2010-01-01) gets `boundedRangeFrom` CLAMPED to 2016-07-25 exactly.
  const db = await migratedDatabase();
  const now = "2026-08-01T00:00:00.000Z";
  const FLOOR_DATE = "2016-07-25";
  // Within `MULTI_YEAR_PRICE_TOLERANCE_DAYS` (7) calendar days BEFORE the
  // floor -- the OLD unconditional `[boundedRangeFrom, range.rangeTo]` read
  // could never see this row (it sits BELOW `boundedRangeFrom`); the NEW
  // per-date window (`FLOOR_DATE` minus 7 days through `FLOOR_DATE`) does.
  const JUST_BELOW_FLOOR_PRICE_DATE = "2016-07-22";
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES ('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES ('user-f1','active','f1@example.test','Australia/Sydney','${now}','${now}');
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES ('portfolio-f1','user-f1','F1','F1 portfolio','AUD','Australia/Sydney','fifo','active','${now}','${now}');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES ('security-f1','equity','AUD','Security F1','${now}','${now}');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES ('ps-f1','user-f1','portfolio-f1','security-f1','SYM','AUD','held','${now}','${now}');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES ('mapping-f1','security-f1','yahoo-compatible','ASX','SYM','2005-01-01','verified');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES ('tx-f1','user-f1','portfolio-f1','ps-f1','buy','posted','2010-01-01T00:00:00.000Z','2010-01-01','100','10','AUD','1000','0','0','manual','user-f1',1,'2010-01-01');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-f1','yahoo-compatible','deployment',NULL,'deployment','mapping-f1','security-f1','eod','${JUST_BELOW_FLOOR_PRICE_DATE}T04:00:00Z','${JUST_BELOW_FLOOR_PRICE_DATE}','Australia/Sydney','AUD','10.00','raw','observed','${JUST_BELOW_FLOOR_PRICE_DATE}T04:00:00Z');
  `);

  const client = createSqliteSqlClient(db);
  const result = await loadHistoricalPortfolioValueAtDates(
    client,
    "user-f1",
    "portfolio-f1",
    [FLOOR_DATE],
    new Date("2026-08-01T12:00:00Z"),
  );
  assert.ok(result);
  const point = result.get(FLOOR_DATE);
  assert.ok(point);

  // THE CORRECTED (new) behavior: complete, a real value -- the tolerance
  // window reaches back to the just-below-floor price.
  assert.equal(point.completeness, "complete");
  assert.equal(point.pricedSecurityCount, 1);
  assert.equal(point.valueDecimal, "1000"); // 100 shares * $10.00

  // Prove the OLD behavior's gap directly: the OLD unconditional
  // `[boundedRangeFrom, range.rangeTo]` = [FLOOR_DATE, '2026-08-01'] price
  // read (no per-date window) finds ZERO rows for this security, since the
  // only seeded price sits below `boundedRangeFrom` -- confirming the OLD
  // read would have reported this exact date as an honest-but-avoidable
  // gap (`valueDecimal: null`, `completeness: "partial"`,
  // `pricedSecurityCount: 0`), never a fabricated value either way.
  const oldRangeRowCount = db
    .prepare(
      `SELECT count(*) AS count FROM price_observations po WHERE po.security_id = 'security-f1' AND po.market_date BETWEEN ? AND '2026-08-01' AND po.adjustment_state = 'raw' AND ((po.access_scope = 'deployment' AND po.scope_user_id IS NULL) OR (po.access_scope = 'user' AND po.scope_user_id = ?))`,
    )
    .get(FLOOR_DATE, "user-f1") as { count: number };
  assert.equal(
    oldRangeRowCount.count,
    0,
    "expected the OLD full-range-only bound to see zero rows for this security (proving the old read's gap)",
  );

  db.close();
});
