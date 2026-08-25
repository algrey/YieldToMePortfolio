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
  computeIncomeBreakdown,
  resolveSecurityFranking,
  resolveSecurityYield,
} from "../domain/dividends/projection.ts";
import {
  computeSecurityDividendForecast,
  type SecurityDividendForecast,
} from "../domain/dividends/forecast.ts";
import {
  deriveDividendHistoryForSecurity,
  type DividendManualRecordFact,
  type ProviderDividendEventFact,
} from "../domain/dividends/history.ts";
import type { LedgerQuantityFact } from "../domain/dividends/shares-held.ts";

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
    ttmIncomplete: false,
    currencyCode: "AUD",
    uncoveredReason: null,
    hasFullDeclaredCoverage: false,
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
    ttmIncomplete: false,
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
    ttmIncomplete: false,
  });
});

test("DIV-009 review fix (B1): a PARTIALLY determinable history-derived TTM threads ttmIncomplete through to the yield result -- never silently presented as a complete figure", () => {
  const result = deriveYieldFromResolvedTtm(
    resolved({
      ttmPerShareDecimal: "1.5",
      ttmSource: "history_ttm",
      ttmIncomplete: true,
    }),
    { amountDecimal: "10", currencyCode: "AUD" },
  );
  assert.deepEqual(result, {
    ok: true,
    trailingYieldPercentDecimal: "15.000000",
    ttmSource: "history_ttm",
    ttmIncomplete: true,
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

test("DIV-009: neither TTM leg produced a rate AND the forecast named no specific reason AND declared coverage is NOT full (e.g. a sold-out security) falls back to the conservative 'insufficient_history' label, never a guess", () => {
  const result = deriveYieldFromResolvedTtm(
    resolved({ uncoveredReason: null, hasFullDeclaredCoverage: false }),
    { amountDecimal: "10", currencyCode: "AUD" },
  );
  assert.deepEqual(result, { ok: false, reason: "insufficient_history" });
});

test("DIV-009 review fix (B2): neither TTM leg produced a rate BUT the forecast's 12-month total is fully known from declared events -- reports the distinct 'fully_covered_no_ttm', never the misleading 'insufficient_history'", () => {
  const result = deriveYieldFromResolvedTtm(
    resolved({ uncoveredReason: null, hasFullDeclaredCoverage: true }),
    { amountDecimal: "10", currencyCode: "AUD" },
  );
  assert.deepEqual(result, { ok: false, reason: "fully_covered_no_ttm" });
});

// ---------------------------------------------------------------------------
// b. `resolveSecurityYield` -- provenance disclosure per DIV-006's
//    method-string convention.
// ---------------------------------------------------------------------------

test("DIV-009: resolveSecurityYield's output source/method distinguishes a history-derived yield from a provider one", () => {
  const franking = resolveSecurityFranking(null);
  const resolution = resolveSecurityYield(
    null,
    {
      ok: true,
      trailingYieldPercentDecimal: "15",
      ttmSource: "history_ttm",
      ttmIncomplete: false,
    },
    franking,
  );
  assert.equal(resolution.source, "history_ttm");
  assert.equal(resolution.status, "ok");
  assert.equal(resolution.ttmIncomplete, false);
  assert.match(resolution.method, /imported dividend history/);
  assert.doesNotMatch(resolution.method, /^provider/);
});

test("DIV-009: resolveSecurityYield's provider-sourced output is worded exactly as before (no regression to the pre-DIV-009 provider method text)", () => {
  const franking = resolveSecurityFranking("70");
  const resolution = resolveSecurityYield(
    null,
    {
      ok: true,
      trailingYieldPercentDecimal: "10",
      ttmSource: "provider_ttm",
      ttmIncomplete: false,
    },
    franking,
  );
  assert.equal(resolution.source, "provider_ttm");
  assert.equal(
    resolution.method,
    "provider trailing 12-month cash yield grossed up using the owner's franking assumption",
  );
});

test("DIV-009 review fix (B1): resolveSecurityYield names a PARTIALLY determinable history-derived yield in its own method text and typed flag, never presenting it as a clean, complete figure", () => {
  const franking = resolveSecurityFranking(null);
  const resolution = resolveSecurityYield(
    null,
    {
      ok: true,
      trailingYieldPercentDecimal: "15",
      ttmSource: "history_ttm",
      ttmIncomplete: true,
    },
    franking,
  );
  assert.equal(resolution.source, "history_ttm");
  if (
    resolution.source === "history_ttm" ||
    resolution.source === "provider_ttm"
  ) {
    assert.equal(resolution.ttmIncomplete, true);
  } else {
    assert.fail("expected an ok TTM-sourced resolution");
  }
  assert.match(resolution.method, /PARTIALLY determinable/);
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

// BUG-004 (owner-reported, 2026-08-25, real account): "Under the income tab,
// Next 12 Months subtab, it shows estimated franking credits as zero.
// Franking credits over the last 12 months were $9,082." This account's own
// shape is EXACTLY `ownerShapedFixture` above (totals-mode Sharesight
// history, zero provider `dividend_events`, no `dividend_security_assumptions`
// franking-percent row ever set) -- the real read-only D1 copy under
// investigation confirmed `dividend_security_assumptions` is completely
// empty, and confirmed the pre-fix breakdown read
// `totalFrankingKnownDecimal: "0"`/`totalFrankingIncomplete: true` against a
// real ~$9,082.46 trailing-12-month franking total in
// `dividend_manual_records`. This test pins the service-level, end-to-end
// fix on the SAME fixture shape used above, closing the DIV-011 knock-on too
// (the multi-year year-1 franking is `gross - cash` by subtraction from this
// SAME breakdown, so it inherits the fix without any separate change).
test("BUG-004 OWNER ACCEPTANCE CHECK: real per-row franking evidence (Sharesight totals-mode, no franking assumption ever set) is carried into the Next 12 Months breakdown's franking total, not $0", async () => {
  const db = await ownerShapedFixture();
  db.exec(`
    UPDATE dividend_manual_records
      SET total_franking_decimal = '64.29'
      WHERE id = 'm1';
  `);
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );

  assert.equal(projection.status, "ok");
  assert.notEqual(projection.breakdown.totalFrankingKnownDecimal, "0");
  assert.equal(projection.breakdown.totalFrankingKnownDecimal, "64.29");
  assert.equal(projection.breakdown.totalFrankingIncomplete, false);
  assert.equal(
    projection.breakdown.totalGrossDecimal,
    "214.29", // 150 cash + 64.29 franking, exactly
  );

  // DIV-011 knock-on: the multi-year year-1 row reuses this SAME breakdown
  // total verbatim, so its own franking (gross - cash) reflects the fix too,
  // with no separate change required.
  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) throw new Error("unreachable");
  const year1 = projection.multiYear.rows[0]!;
  assert.equal(year1.frankingCreditDecimal, "64.29");
  assert.notEqual(year1.frankingCreditDecimal, "0");
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

// ---------------------------------------------------------------------------
// d. Review round-1 fixes (B1/B2/B3) -- ttmIncomplete disclosure threaded
//    end-to-end, the fully_covered_by_declared regression, and both-legs
//    precedence proven all the way into the grid/multi-year.
// ---------------------------------------------------------------------------

const HOLDING_TX: LedgerQuantityFact[] = [
  {
    id: "b1",
    type: "buy",
    status: "posted",
    localTradeDate: "2020-01-01",
    tradeAt: "2020-01-01T00:00:00Z",
    quantityDecimal: "100",
    unitPriceDecimal: null,
    reversesTransactionId: null,
  },
];

function providerEvent(
  overrides: Partial<ProviderDividendEventFact> & { id: string },
): ProviderDividendEventFact {
  return {
    kind: "cash",
    status: "paid",
    exDate: "2026-01-01",
    paymentDate: null,
    currencyCode: "AUD",
    grossPerShareDecimal: "1.00",
    supersedesEventId: null,
    ...overrides,
  };
}

function addDaysUtc(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test("DIV-009 review fix (B2, BLOCKING): a security fully covered by declared events STILL exposes its resolved provider TTM rate on the forecast -- the pre-fix regression this pins (was: ttmSource/ttmPerShareDecimal hardcoded null in this branch, dead-ending the assumption grid to insufficient_history even with a real 5% trailing yield)", () => {
  const TODAY = "2026-08-13";
  // The forecast's forward window is `today` through `today + 364`
  // (`FORECAST_WINDOW_DAYS - 1`, see forecast.ts's own window comment) -- a
  // single declared event dated exactly at the window's last day fully
  // covers the whole forward year on its own.
  const windowToDate = addDaysUtc(TODAY, 364);
  const historyRows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [
      // Past, PAID -- feeds the provider TTM (trailing yield) leg.
      providerEvent({
        id: "e-past",
        exDate: "2026-01-01",
        status: "paid",
        grossPerShareDecimal: "5",
      }),
      // Future, DECLARED, dated exactly at the forward window's last day --
      // fully covers the forecast's forward 12-month window on its own.
      providerEvent({
        id: "e-future",
        exDate: windowToDate,
        status: "declared",
        grossPerShareDecimal: "5",
      }),
    ],
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const forecast: SecurityDividendForecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows,
    ttmEvents: [
      {
        exDate: "2026-01-01",
        currencyCode: "AUD",
        grossPerShareDecimal: "5",
        kind: "cash",
        status: "paid",
      },
    ],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  assert.equal(forecast.status, "fully_covered_by_declared");
  assert.equal(forecast.uncoveredReason, null);
  // The B2 fix: these are no longer hardcoded null in this branch.
  assert.equal(forecast.ttmSource, "provider_ttm");
  assert.equal(forecast.ttmPerShareDecimal, "5");
  assert.equal(forecast.ttmIncomplete, false);

  // Pin the exact regression described: pre-DIV-009 this fed a real 5%
  // provider yield into the assumption grid.
  const ttmYield = deriveYieldFromResolvedTtm(
    {
      ttmPerShareDecimal: forecast.ttmPerShareDecimal,
      ttmSource: forecast.ttmSource,
      ttmIncomplete: forecast.ttmIncomplete,
      currencyCode: forecast.currencyCode,
      uncoveredReason: forecast.uncoveredReason,
      hasFullDeclaredCoverage: forecast.status === "fully_covered_by_declared",
    },
    { amountDecimal: "100", currencyCode: "AUD" },
  );
  assert.deepEqual(ttmYield, {
    ok: true,
    trailingYieldPercentDecimal: "5.000000",
    ttmSource: "provider_ttm",
    ttmIncomplete: false,
  });
});

async function migratedDatabase2(): Promise<DatabaseSync> {
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

async function baseFixture(db: DatabaseSync): Promise<void> {
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
    INSERT INTO calculation_runs (id,user_id,portfolio_id,range_from,range_to,calculation_version,reason,ledger_high_water_start,ledger_high_water_end,idempotency_key,created_at,updated_at,status) VALUES
      ('run-a','a','pa','2026-08-13','2026-08-13',1,'test','1','1','run-a','2026-08-13','2026-08-13','completed');
    INSERT INTO projection_publications (user_id,portfolio_id,calculation_run_id,calculation_version,ledger_high_water,published_at) VALUES
      ('a','pa','run-a',1,'1','2026-08-13T01:00:00Z');
  `);
}

test("DIV-009 review fix (B3): BOTH legs usable -- provider dividend_events AND real history rows for the SAME security -- provider_ttm wins all the way into the assumption grid and multi-year, exactly as the forecast already decided (never re-derived)", async () => {
  const db = await migratedDatabase2();
  await baseFixture(db);
  db.exec(`
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s','equity','asx','AUD','Both Legs Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa','a','pa','s','S','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('mapping-a','s','yahoo-compatible','ASX','S','2026-01-01','verified');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa','buy','posted','2025-01-01T00:00:00Z','2025-01-01','100','5','AUD','500','0','0','manual','a',1,'2025-01-01');
    -- Provider event: a real trailing dividend_events row.
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de1','s','yahoo-compatible','cash','paid','2026-03-01','AUD','2','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z','2026-03-01');
    -- ALSO real history rows for the SAME security, with a WILDLY different
    -- total -- if history wrongly won, the yield would be ~99.9% instead of
    -- the provider-derived 20%, making a precedence bug loud and obvious.
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,total_cash_decimal,total_franking_decimal,import_batch_id,created_at,updated_at,version) VALUES
      ('m1','a','pa','psa','2026-04-01',NULL,NULL,NULL,'999',NULL,'batch-a','2026-04-01','2026-04-01',1);
    INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at) VALUES
      ('projection-a','a','pa','psa','100','500','500','5','complete','ready','1','run-a',1,'2026-08-13T01:00:00Z');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-a','yahoo-compatible','deployment',NULL,'deployment','mapping-a','s','eod','2026-08-13T01:00:00Z','2026-08-13','Australia/Sydney','AUD','10','10','raw','observed','2026-08-13T01:01:00Z');
  `);
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );

  assert.equal(projection.assumptionGrid.length, 1);
  const security = projection.assumptionGrid[0]!;
  assert.equal(security.yield.source, "provider_ttm");
  assert.equal(security.yield.status, "ok");
  // 2 (provider per-share) / 10 (price) * 100 = 20% -- NOT the ~99.9% a
  // wrongly-won history leg (999/100 shares = 9.99 per share) would give.
  assert.equal(Number(security.yield.cashYieldPercentDecimal), 20);
  assert.match(security.yield.method, /^provider/);

  assert.equal(projection.aggregateYield.status, "ok");
  assert.equal(
    Number(projection.aggregateYield.effectiveYieldPercentDecimal),
    20,
  );
  assert.equal(projection.multiYear.ok, true);
});

test("DIV-009 review fix (B1): a PARTIALLY determinable history-derived TTM discloses ttmIncomplete at the grid, aggregate, AND multi-year row level -- never silently presented as a complete figure at any of the three", async () => {
  const db = await migratedDatabase2();
  await baseFixture(db);
  db.exec(`
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s','equity','asx','AUD','Partial Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa','a','pa','s','S','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('mapping-a','s','yahoo-compatible','ASX','S','2026-01-01','verified');
    -- Buy AFTER the first payment but BEFORE the second: the first payment
    -- is a provable history_gap (zero shares held at that payment date),
    -- the second is determinable (100 shares held) -- ZERO provider events,
    -- forcing the history fallback.
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa','buy','posted','2025-11-01T00:00:00Z','2025-11-01','100','5','AUD','500','0','0','manual','a',1,'2025-11-01');
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,total_cash_decimal,total_franking_decimal,import_batch_id,created_at,updated_at,version) VALUES
      ('m1','a','pa','psa','2025-10-01',NULL,NULL,NULL,'50',NULL,'batch-a','2025-10-01','2025-10-01',1),
      ('m2','a','pa','psa','2026-01-15',NULL,NULL,NULL,'200',NULL,'batch-a','2026-01-15','2026-01-15',1);
    INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at) VALUES
      ('projection-a','a','pa','psa','100','500','500','5','complete','ready','1','run-a',1,'2026-08-13T01:00:00Z');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-a','yahoo-compatible','deployment',NULL,'deployment','mapping-a','s','eod','2026-08-13T01:00:00Z','2026-08-13','Australia/Sydney','AUD','10','10','raw','observed','2026-08-13T01:01:00Z');
  `);
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );

  // 1. Grid level.
  assert.equal(projection.assumptionGrid.length, 1);
  const security = projection.assumptionGrid[0]!;
  assert.equal(security.yield.source, "history_ttm");
  assert.equal(security.yield.status, "ok");
  if (
    security.yield.source === "history_ttm" ||
    security.yield.source === "provider_ttm"
  ) {
    assert.equal(security.yield.ttmIncomplete, true);
  } else {
    assert.fail("expected an ok TTM-sourced resolution");
  }
  assert.match(security.yield.method, /PARTIALLY determinable/);

  // 2. Aggregate level.
  assert.equal(projection.aggregateYield.status, "ok");
  assert.equal(projection.aggregateYield.partialTtmSecurities.length, 1);
  assert.equal(
    projection.aggregateYield.partialTtmSecurities[0]!.portfolioSecurityId,
    "psa",
  );
  assert.match(projection.aggregateYield.method, /partially determinable/);

  // 3. Multi-year ROW level (the B4/currentPortfolioValueStatus precedent --
  // what-if/standalone rows render without the aggregate alongside them, so
  // the disclosure must be baked into the row's own method string too).
  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) throw new Error("unreachable");
  assert.ok(projection.multiYear.rows.length > 0);
  for (const row of projection.multiYear.rows) {
    assert.match(
      row.method,
      /trailing-twelve-month figure is only partially determinable/,
    );
  }
  // Survives standalone what-if consumption too (same B4 precedent).
  assert.notEqual(projection.multiYearBaselineInput, null);
  const whatIf = projectMultiYearIncomeWhatIf(
    projection.multiYearBaselineInput!,
    { valueGrowthPercentDecimal: "8" },
  );
  assert.equal(whatIf.ok, true);
  if (whatIf.ok) {
    for (const row of whatIf.rows) {
      assert.match(
        row.method,
        /trailing-twelve-month figure is only partially determinable/,
      );
    }
  }
});

function totalsManual(
  overrides: Partial<DividendManualRecordFact> & {
    id: string;
    paymentDate: string;
  },
): DividendManualRecordFact {
  return {
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "500",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
    ...overrides,
  };
}

test("DIV-009 review fix (round-2, BLOCKING): fully-covered-by-declared + a PARTIALLY determinable history TTM -- the breakdown stays 'ok'/unnamed (its total is purely declared, never TTM-fed) while the YIELD surfaces still disclose the partial rate (that split is the whole point of gating on status, not the flag alone)", () => {
  const TODAY = "2026-08-13";
  const windowToDate = addDaysUtc(TODAY, 364);
  // A LOCAL transaction, not the shared `HOLDING_TX` (bought 2020) -- the
  // buy must fall BETWEEN the two payment dates below so the earlier one
  // resolves to a provable zero-shares-at-payment gap.
  const transactions: LedgerQuantityFact[] = [
    {
      id: "b1",
      type: "buy",
      status: "posted",
      localTradeDate: "2025-11-01",
      tradeAt: "2025-11-01T00:00:00Z",
      quantityDecimal: "100",
      unitPriceDecimal: null,
      reversesTransactionId: null,
    },
  ];
  const historyRows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [
      // Future, DECLARED, dated exactly at the forward window's last day --
      // fully covers the forecast's forward 12 months on its own.
      providerEvent({
        id: "e-future",
        exDate: windowToDate,
        status: "declared",
        grossPerShareDecimal: "3",
      }),
    ],
    overrides: [],
    receipts: [],
    manualRecords: [
      // Payment BEFORE the buy -- a provable history_gap, indeterminate.
      totalsManual({
        id: "m1",
        paymentDate: "2025-10-01",
        totalCashDecimal: "50",
      }),
      // Payment AFTER the buy -- determinable (100 shares held): DPS = 2.
      totalsManual({
        id: "m2",
        paymentDate: "2026-01-15",
        totalCashDecimal: "200",
      }),
    ],
    transactions,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const forecast: SecurityDividendForecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows,
    ttmEvents: [], // zero provider coverage -- forces the history fallback
    transactions,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });

  // The forecast itself: fully covered by declared events, yet the history
  // leg still resolved (partially) -- both fields real and non-contradictory.
  assert.equal(forecast.status, "fully_covered_by_declared");
  assert.equal(forecast.ttmSource, "history_ttm");
  assert.equal(forecast.ttmIncomplete, true);
  assert.equal(forecast.ttmPerShareDecimal, "2"); // only the determinable row contributes
  // The TOTAL is purely declared -- the TTM never fed it.
  assert.equal(forecast.totalCashDecimal, forecast.declaredCashDecimal);
  assert.equal(forecast.totalGrossDecimal, forecast.totalCashDecimal); // no franking assumed

  // 1. Breakdown side: NOT named, status stays "ok" -- a purely-declared,
  // fully-known total must never read as "may understate true income".
  const breakdown = computeIncomeBreakdown({
    baseCurrencyCode: "AUD",
    currentPortfolioValueDecimal: "10000",
    currentPortfolioValueStatus: "available",
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "TEST",
        currencyCode: "AUD",
        forecast,
      },
    ],
  });
  assert.equal(breakdown.status, "ok");
  assert.equal(breakdown.partialTtmSecurities.length, 0);
  assert.equal(breakdown.totalGrossDecimal, forecast.totalGrossDecimal);

  // 2. Yield side: the SAME forecast still discloses partial -- that split
  // (breakdown clean, yield partial) is the point of this fix.
  const ttmYield = deriveYieldFromResolvedTtm(
    {
      ttmPerShareDecimal: forecast.ttmPerShareDecimal,
      ttmSource: forecast.ttmSource,
      ttmIncomplete: forecast.ttmIncomplete,
      currencyCode: forecast.currencyCode,
      uncoveredReason: forecast.uncoveredReason,
      hasFullDeclaredCoverage: forecast.status === "fully_covered_by_declared",
    },
    { amountDecimal: "10", currencyCode: "AUD" },
  );
  assert.equal(ttmYield.ok, true);
  if (!ttmYield.ok) throw new Error("unreachable");
  assert.equal(ttmYield.ttmSource, "history_ttm");
  assert.equal(ttmYield.ttmIncomplete, true);

  const franking = resolveSecurityFranking(null);
  const yieldResolution = resolveSecurityYield(null, ttmYield, franking);
  assert.equal(yieldResolution.source, "history_ttm");
  assert.equal(yieldResolution.status, "ok");
  assert.equal(yieldResolution.ttmIncomplete, true);
  assert.match(yieldResolution.method, /PARTIALLY determinable/);
});
