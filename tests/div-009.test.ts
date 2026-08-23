/**
 * DIV-009 -- the income-projection assumption grid/multi-year base reuses
 * each security's ALREADY-COMPUTED forecast TTM
 * (`SecurityDividendForecast.ttmPerShareDecimal`/`ttmSource`, which after
 * DIV-008 carries the history-derived fallback with no `history_complete_from`
 * boundary requirement) instead of re-deriving a trailing yield from raw
 * provider `dividend_events` alone. Before this fix,
 * `app/owned-income-projection.ts` fetched `dividend_events` itself and fed
 * them through `deriveTrailingDividendYield` in isolation -- a portfolio
 * with real imported dividend history but ZERO provider events (the owner's
 * actual shape: Sharesight totals-mode-only, no MKT-005 provider coverage)
 * always landed on `no_yield_coverage`, regardless of how much history it
 * had.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import {
  loadOwnedIncomeProjection,
  projectMultiYearIncomeWhatIf,
} from "../app/owned-income-projection.ts";
import {
  deriveYieldFromResolvedTtm,
  type ResolvedForecastTtm,
} from "../domain/market-data/dividend-yield.ts";
import {
  resolveSecurityFranking,
  resolveSecurityYield,
} from "../domain/dividends/projection.ts";

// ---------------------------------------------------------------------------
// a. `deriveYieldFromResolvedTtm` -- the new pure adapter from a forecast's
//    already-resolved TTM to a yield %, replacing the raw-events re-derivation.
// ---------------------------------------------------------------------------

function resolved(
  overrides: Partial<ResolvedForecastTtm>,
): ResolvedForecastTtm {
  return {
    ttmPerShareDecimal: null,
    ttmSource: null,
    currencyCode: "AUD",
    uncoveredReason: null,
    ...overrides,
  };
}

test("DIV-009: a provider-sourced forecast TTM yields a yield% and echoes 'provider_ttm' provenance through unchanged", () => {
  const result = deriveYieldFromResolvedTtm(
    resolved({ ttmPerShareDecimal: "1.5", ttmSource: "provider_ttm" }),
    { amountDecimal: "10", currencyCode: "AUD" },
  );
  assert.deepEqual(result, {
    ok: true,
    trailingYieldPercentDecimal: "15.000000",
    ttmSource: "provider_ttm",
  });
});

test("DIV-009: a history-derived forecast TTM (DIV-008 fallback, zero provider coverage) yields the SAME yield% math and is named 'history_ttm', never conflated with provider data", () => {
  const result = deriveYieldFromResolvedTtm(
    resolved({ ttmPerShareDecimal: "1.5", ttmSource: "history_ttm" }),
    { amountDecimal: "10", currencyCode: "AUD" },
  );
  assert.deepEqual(result, {
    ok: true,
    trailingYieldPercentDecimal: "15.000000",
    ttmSource: "history_ttm",
  });
});

test("DIV-009: no usable price is 'price_unavailable' even when the forecast TTM itself resolved fine -- never a fabricated yield", () => {
  const result = deriveYieldFromResolvedTtm(
    resolved({ ttmPerShareDecimal: "1.5", ttmSource: "history_ttm" }),
    null,
  );
  assert.deepEqual(result, { ok: false, reason: "price_unavailable" });
});

test("DIV-009: a provable history gap (DIV-008's most specific reason) is named 'history_gap', not collapsed into a generic 'insufficient_history'", () => {
  const result = deriveYieldFromResolvedTtm(
    resolved({ uncoveredReason: "history_gap" }),
    { amountDecimal: "10", currencyCode: "AUD" },
  );
  assert.deepEqual(result, { ok: false, reason: "history_gap" });
});

test("DIV-009: neither TTM leg produced a rate AND the forecast named no specific reason (e.g. a sold-out or fully-declared-covered security) falls back to the conservative 'insufficient_history' label, never a guess", () => {
  const result = deriveYieldFromResolvedTtm(
    resolved({ uncoveredReason: null }),
    { amountDecimal: "10", currencyCode: "AUD" },
  );
  assert.deepEqual(result, { ok: false, reason: "insufficient_history" });
});

// ---------------------------------------------------------------------------
// b. `resolveSecurityYield` -- provenance disclosure per DIV-006's
//    method-string convention.
// ---------------------------------------------------------------------------

test("DIV-009: resolveSecurityYield's output source/method distinguishes a history-derived yield from a provider one", () => {
  const franking = resolveSecurityFranking(null);
  const resolution = resolveSecurityYield(
    null,
    { ok: true, trailingYieldPercentDecimal: "15", ttmSource: "history_ttm" },
    franking,
  );
  assert.equal(resolution.source, "history_ttm");
  assert.equal(resolution.status, "ok");
  assert.match(resolution.method, /imported dividend history/);
  assert.doesNotMatch(resolution.method, /^provider/);
});

test("DIV-009: resolveSecurityYield's provider-sourced output is worded exactly as before (no regression to the pre-DIV-009 provider method text)", () => {
  const franking = resolveSecurityFranking("70");
  const resolution = resolveSecurityYield(
    null,
    { ok: true, trailingYieldPercentDecimal: "10", ttmSource: "provider_ttm" },
    franking,
  );
  assert.equal(resolution.source, "provider_ttm");
  assert.equal(
    resolution.method,
    "provider trailing 12-month cash yield grossed up using the owner's franking assumption",
  );
});

// ---------------------------------------------------------------------------
// c. Owner-shaped end-to-end service test (the OWNER ACCEPTANCE CHECK):
//    totals-mode Sharesight dividend history, ZERO dividend_events, ZERO
//    provider coverage -- the exact shape that used to read
//    `no_yield_coverage` regardless of how much real history existed.
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

async function ownerShapedFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES
      ('asx','XASX','Australian Securities Exchange','AU','Australia/Sydney','XASX');
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s','equity','asx','AUD','Owner Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa','a','pa','s','S','AUD','held','2026-08-01','2026-08-01');
    -- Provider mapping exists (needed for price_observations' FK), but NO
    -- dividend_events row is ever inserted -- zero provider dividend
    -- coverage, matching the owner's real shape.
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('mapping-a','s','yahoo-compatible','ASX','S','2026-01-01','verified');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa','buy','posted','2025-01-01T00:00:00Z','2025-01-01','100','5','AUD','500','0','0','manual','a',1,'2025-01-01');
    -- BRK-005 totals-mode Sharesight import: no per-share rate at all, only
    -- a total cash amount -- the exact shape DIV-008's fallback exists for.
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,total_cash_decimal,total_franking_decimal,import_batch_id,created_at,updated_at,version) VALUES
      ('m1','a','pa','psa','2026-03-01',NULL,NULL,NULL,'150',NULL,'batch-a','2026-03-01','2026-03-01',1);
    -- Owner growth assumptions, so the multi-year rows visibly compound
    -- year over year (proving growth application still works over the new
    -- history-derived base -- mapProjectedRow/projectMultiYearIncomeWhatIf
    -- are untouched by this task).
    INSERT INTO dividend_portfolio_assumptions(portfolio_id,user_id,value_growth_percent_decimal,portfolio_dividend_growth_percent_decimal,created_at,updated_at,version) VALUES
      ('pa','a','5','3','2026-08-01','2026-08-01',1);
    INSERT INTO calculation_runs (id,user_id,portfolio_id,range_from,range_to,calculation_version,reason,ledger_high_water_start,ledger_high_water_end,idempotency_key,created_at,updated_at,status) VALUES
      ('run-a','a','pa','2026-08-13','2026-08-13',1,'test','1','1','run-a','2026-08-13','2026-08-13','completed');
    INSERT INTO projection_publications (user_id,portfolio_id,calculation_run_id,calculation_version,ledger_high_water,published_at) VALUES
      ('a','pa','run-a',1,'1','2026-08-13T01:00:00Z');
    INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at) VALUES
      ('projection-a','a','pa','psa','100','500','500','5','complete','ready','1','run-a',1,'2026-08-13T01:00:00Z');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-a','yahoo-compatible','deployment',NULL,'deployment','mapping-a','s','eod','2026-08-13T01:00:00Z','2026-08-13','Australia/Sydney','AUD','10','10','raw','observed','2026-08-13T01:01:00Z');
  `);
  return db;
}

test("DIV-009 OWNER ACCEPTANCE CHECK: totals-mode history + zero dividend_events + zero provider coverage -- the Multi-Year tab is AVAILABLE (base rows non-zero, growth applied, what-if available)", async () => {
  const db = await ownerShapedFixture();
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );

  assert.equal(projection.status, "ok");
  assert.equal(projection.assumptionGrid.length, 1);
  const security = projection.assumptionGrid[0]!;
  // Provenance: this yield came from the security's own imported dividend
  // history, not provider data -- there IS no provider data.
  assert.equal(security.yield.source, "history_ttm");
  assert.equal(security.yield.status, "ok");
  assert.notEqual(security.yield.grossedYieldPercentDecimal, null);
  assert.match(security.yield.method, /imported dividend history/);

  assert.equal(projection.aggregateYield.status, "ok");
  assert.notEqual(projection.aggregateYield.effectiveYieldPercentDecimal, null);

  // The headline claim this task exists to fix: this used to be
  // `{ ok: false, reason: "no_yield_coverage" }` regardless of history.
  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) throw new Error("unreachable");
  assert.equal(projection.multiYear.rows.length, 10);
  for (const row of projection.multiYear.rows) {
    assert.notEqual(row.grossDividendDecimal, "0");
    assert.ok(Number(row.grossDividendDecimal) > 0);
  }
  // Growth applied across years: with 5%/3% compounding, gross dividend
  // strictly increases year over year (mapProjectedRow/projectMultiYearIncome
  // itself is untouched by this task -- this just confirms it still runs
  // correctly over the new history-derived base).
  for (let i = 1; i < projection.multiYear.rows.length; i += 1) {
    assert.ok(
      Number(projection.multiYear.rows[i]!.grossDividendDecimal) >
        Number(projection.multiYear.rows[i - 1]!.grossDividendDecimal),
    );
  }

  // What-if is available: the baseline input survived (B3's invariant --
  // present exactly when `multiYear.ok`), and a what-if overlay over it
  // succeeds too.
  assert.notEqual(projection.multiYearBaselineInput, null);
  const whatIf = projectMultiYearIncomeWhatIf(
    projection.multiYearBaselineInput!,
    { valueGrowthPercentDecimal: "8" },
  );
  assert.equal(whatIf.ok, true);
});

test("DIV-009: a security with a PROVABLE history gap (DIV-008's most specific reason) is excluded honestly from the assumption grid's yield, named via the typed status, and does not silently zero the multi-year base", async () => {
  const db = await ownerShapedFixture();
  // A second security whose ONLY history row is a provable ledger gap: a
  // dividend was received before any buy is recorded in the ledger, so
  // shares-held-at-payment resolves to zero.
  db.exec(`
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s2','equity','asx','AUD','Gap Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psb','a','pa','s2','S2','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('mapping-b','s2','yahoo-compatible','ASX','S2','2026-01-01','verified');
    -- Dividend received 2026-03-01, but the only buy is AFTER it -- a
    -- provable ledger gap, not a plain unknown amount.
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx2','a','pa','psb','buy','posted','2026-05-01T00:00:00Z','2026-05-01','50','5','AUD','250','0','0','manual','a',1,'2026-05-01');
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,total_cash_decimal,total_franking_decimal,import_batch_id,created_at,updated_at,version) VALUES
      ('m2','a','pa','psb','2026-03-01',NULL,NULL,NULL,'75',NULL,'batch-a','2026-03-01','2026-03-01',1);
    INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at) VALUES
      ('projection-b','a','pa','psb','50','250','250','5','complete','ready','1','run-a',1,'2026-08-13T01:00:00Z');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-b','yahoo-compatible','deployment',NULL,'deployment','mapping-b','s2','eod','2026-08-13T01:00:00Z','2026-08-13','Australia/Sydney','AUD','10','10','raw','observed','2026-08-13T01:01:00Z');
  `);
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );

  assert.equal(projection.assumptionGrid.length, 2);
  const gapSecurity = projection.assumptionGrid.find(
    (row) => row.portfolioSecurityId === "psb",
  )!;
  assert.equal(gapSecurity.yield.source, "none");
  assert.equal(gapSecurity.yield.status, "history_gap");
  assert.equal(gapSecurity.yield.grossedYieldPercentDecimal, null);

  // The gap security is excluded (named), never silently zeroed -- but the
  // OTHER security's real history-derived base still comes through, and the
  // aggregate/multi-year projection is still available.
  assert.equal(projection.aggregateYield.status, "ok");
  const excludedIds = projection.aggregateYield.excluded.map(
    (entry) => entry.portfolioSecurityId,
  );
  assert.ok(excludedIds.includes("psb"));
  assert.equal(projection.multiYear.ok, true);
});
