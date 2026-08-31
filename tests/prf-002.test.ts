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
  invalidateStoredValueHistoryForSecurity,
} from "../app/historical-portfolio-value.ts";
import { loadUsdAudRate } from "../app/authenticated-fx-rate.ts";
import { loadPortfolioInspectionSafely } from "../db/repositories/portfolio-inspection.ts";
import { createOwnedUserSettingsRepository } from "../db/repositories/owned-portfolios.ts";
import { createHistoricalSnapshotRepository } from "../db/repositories/snapshots.ts";
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
        return result;
      },
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

/** The "base workspace" cost EVERY `loadAuthenticatedWorkspace` call pays
 * once identity/ownership is already resolved -- user settings + the
 * UI-050 app-bar USD/AUD pill. Common to every page census below, mirroring
 * `app/authenticated-workspace.ts`'s own call order (settings, then
 * `loadUsdAudRate`) exactly. Deliberately excludes
 * `resolveAuthenticatedRequestContext` itself (JWT/`next/headers`-dependent
 * and not `.ts`-importable under plain `node --test`; see this file's
 * header) -- that cost is measured separately, once, in the "auth
 * resolution" test below, since it is identical across every page and its
 * DUPLICATION (now fixed) was a page-independent defect.
 */
async function baseWorkspaceLoad(client: SqlClient): Promise<void> {
  await createOwnedUserSettingsRepository(client).get(USER_ID);
  await loadUsdAudRate(client, USER_ID, "2026-08-01");
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
 * exactly: the HIST-001 value-history graph, a SEPARATE `loadOwnedHoldings`
 * call for the hero's securities-only summary (UI-047), and a single
 * `loadPublishedOverview` read. CALC-005 retired the snapshot pipeline (see
 * docs/ARCHITECTURE.md's CALC-005 entry) -- this no longer self-heals by
 * claiming/advancing a queued-but-unadvanced snapshot run when nothing has
 * published (that was the CALC-004 shape this census used to measure); a
 * null publication now falls straight through to the honest unavailable
 * overview state. `productionScaleFixture` still seeds a legacy queued
 * snapshot-pipeline row (`snapshot-run-1`, standing in for production's
 * real stuck run) specifically so this census proves it is truly inert
 * here -- present but never claimed, advanced, or paid for. */
async function censusRootOverviewPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  await loadHistoricalPortfolioValueSeries(client, USER_ID, PORTFOLIO_ID, NOW);
  const holdings = await loadOwnedHoldings(
    client,
    USER_ID,
    PORTFOLIO_ID,
    NOW,
    NOT_CONFIGURED_SHARESIGHT,
  );
  if (holdings.unrealisedSummary) {
    buildHoldingsSummaryFooter("AUD", holdings.unrealisedSummary, undefined);
  }
  const snapshotRepo = createHistoricalSnapshotRepository(client);
  await snapshotRepo.loadPublishedOverview(USER_ID, PORTFOLIO_ID);
}

/** `/portfolio/:id/holdings`: `loadAuthenticatedWorkspace(portfolioId,
 * {includeHoldings: true})`. */
async function censusHoldingsPage(client: SqlClient): Promise<void> {
  await baseWorkspaceLoad(client);
  const holdings = await loadOwnedHoldings(
    client,
    USER_ID,
    PORTFOLIO_ID,
    NOW,
    NOT_CONFIGURED_SHARESIGHT,
  );
  const realised = await loadOwnedRealisedGainTotals(
    client,
    USER_ID,
    PORTFOLIO_ID,
    NOW,
  ).catch(() => undefined);
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
];

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
