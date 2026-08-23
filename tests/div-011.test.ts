/**
 * DIV-011 -- Multi-Year base = the 12-month forecast sum; what-if growth
 * semantics; current-FY row (owner-directed, 2026-08-23).
 *
 * ROOT CAUSE (owner report: Multi-Year showed a $20,731-class figure while
 * Next-12-months showed $38,552-class): `projectMultiYearIncome`'s year 1
 * used to derive its dividend from `aggregateYield.effectiveYieldPercentDecimal
 * * currentPortfolioValueDecimal` -- a value-weighted yield averaged only
 * across securities with BOTH a known current value AND a resolved yield
 * (`aggregateSecurityYields`). A held security with real dividend history
 * but NO current price observation is excluded from that weighting (and
 * from the portfolio value total it multiplies) even though its 12-month
 * dividend FORECAST is fully real and price-independent
 * (`computeSecurityDividendForecast` needs no price at all). The
 * Next-12-months headline (`computeIncomeBreakdown`) sums every security's
 * forecast directly and so never had this gap -- hence the divergence. Fix:
 * the multi-year base's year 1 REUSES `computeIncomeBreakdown`'s own
 * `totalGrossDecimal`/`totalCashDecimal` verbatim (one derivation); future
 * years compound value and dividend independently on their own growth
 * assumptions (both defaulting to 6%/yr when unset).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import { loadOwnedIncomeProjection } from "../app/owned-income-projection.ts";

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

/**
 * Owner-shaped coverage-gap fixture: two held securities.
 * - "psa" (Priced Co): a real price observation AND real dividend history --
 *   counted by BOTH the old aggregate-yield weighting and the new forecast
 *   sum.
 * - "psb" (Unpriced Co): real dividend history (a totals-mode manual record,
 *   BRK-005-style) but NO price observation at all -- excluded from the OLD
 *   aggregate-yield base (no known current value to weight, `value_unavailable`)
 *   even though its 12-month forecast is completely real. This is the exact
 *   coverage-gap shape the root-cause investigation identified.
 *
 * No `dividend_portfolio_assumptions` row -- both portfolio growth
 * assumptions are UNSET, exercising the DIV-011 6%/6% default.
 */
async function coverageGapFixture(): Promise<DatabaseSync> {
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
      ('s','equity','asx','AUD','Priced Co','2026-08-01','2026-08-01'),
      ('s2','equity','asx','AUD','Unpriced Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa','a','pa','s','S','AUD','held','2026-08-01','2026-08-01'),
      ('psb','a','pa','s2','S2','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES
      ('mapping-a','s','yahoo-compatible','ASX','S','2026-01-01','verified');

    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa','buy','posted','2025-01-01T00:00:00Z','2025-01-01','100','5','AUD','500','0','0','manual','a',1,'2025-01-01'),
      ('tx2','a','pa','psb','buy','posted','2025-01-01T00:00:00Z','2025-01-01','50','5','AUD','250','0','0','manual','a',1,'2025-01-01');

    -- BRK-005 totals-mode Sharesight-style imports: no per-share rate, only
    -- a total cash amount -- real dividend history for BOTH securities.
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,total_cash_decimal,total_franking_decimal,import_batch_id,created_at,updated_at,version) VALUES
      ('m1','a','pa','psa','2026-03-01',NULL,NULL,NULL,'150',NULL,'batch-a','2026-03-01','2026-03-01',1),
      ('m2','a','pa','psb','2026-03-01',NULL,NULL,NULL,'300',NULL,'batch-a','2026-03-01','2026-03-01',1);

    INSERT INTO calculation_runs (id,user_id,portfolio_id,range_from,range_to,calculation_version,reason,ledger_high_water_start,ledger_high_water_end,idempotency_key,created_at,updated_at,status) VALUES
      ('run-a','a','pa','2026-08-13','2026-08-13',1,'test','2','2','run-a','2026-08-13','2026-08-13','completed');
    INSERT INTO projection_publications (user_id,portfolio_id,calculation_run_id,calculation_version,ledger_high_water,published_at) VALUES
      ('a','pa','run-a',1,'2','2026-08-13T01:00:00Z');
    INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at) VALUES
      ('projection-a','a','pa','psa','100','500','500','5','complete','ready','2','run-a',1,'2026-08-13T01:00:00Z'),
      ('projection-b','a','pa','psb','50','250','250','5','complete','ready','2','run-a',1,'2026-08-13T01:00:00Z');

    -- ONLY "psa" gets a price observation -- "psb" is genuinely unpriced
    -- (the coverage gap this fixture exercises).
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at) VALUES
      ('price-a','yahoo-compatible','deployment',NULL,'deployment','mapping-a','s','eod','2026-08-13T01:00:00Z','2026-08-13','Australia/Sydney','AUD','10','10','raw','observed','2026-08-13T01:01:00Z');
  `);
  return db;
}

test("DIV-011 EQUALITY PIN: the multi-year base (year 1) equals computeIncomeBreakdown's Next-12-months headline total, EXACTLY -- reproducing the owner's coverage-gap shape where the old aggregate-yield base used to diverge", async () => {
  const db = await coverageGapFixture();
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );

  assert.equal(projection.status, "ok");
  // The coverage gap this fixture exists to prove: the OLD aggregate-yield
  // mechanism only ever weighed in "psa" (the priced security) -- "psb" has
  // no known current value to weight.
  assert.equal(projection.aggregateYield.includedCount, 1);
  // The NEW base (computeIncomeBreakdown) counts BOTH securities -- neither
  // needs a price at all.
  assert.equal(projection.breakdown.includedSecurityCount, 2);
  assert.notEqual(projection.breakdown.totalGrossDecimal, null);

  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) throw new Error("unreachable");
  const year1 = projection.multiYear.rows[0]!;
  // THE PIN: year 1's gross/cash dividend is EXACTLY the breakdown's own
  // totals -- one derivation, never re-derived from the (gappy) aggregate
  // yield chain.
  assert.equal(
    year1.grossDividendDecimal,
    projection.breakdown.totalGrossDecimal,
  );
  assert.equal(
    year1.cashDividendDecimal,
    projection.breakdown.totalCashDecimal,
  );
  // Sanity: the reused total genuinely includes BOTH securities' $150 + $300
  // -- not just "psa" alone (which is what the old aggregate-yield base
  // would have silently collapsed to).
  assert.equal(Number(year1.grossDividendDecimal), 450);
});

test("DIV-011: both portfolio growth assumptions default to 6%/yr when unset (never the pre-DIV-011 0%), and year 1 is the UNGROWN base while year 2 compounds independently on each axis", async () => {
  const db = await coverageGapFixture();
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
    { yearsForward: 2 },
  );

  assert.equal(projection.portfolioValueGrowth.source, "none");
  assert.equal(projection.portfolioValueGrowth.growthPercentDecimal, "6");
  assert.match(projection.portfolioValueGrowth.method, /defaulting to 6%\/yr/);
  assert.equal(projection.portfolioDividendGrowth.source, "none");
  assert.equal(projection.portfolioDividendGrowth.growthPercentDecimal, "6");
  assert.match(
    projection.portfolioDividendGrowth.method,
    /defaulting to 6%\/yr/,
  );

  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) throw new Error("unreachable");
  const [year1, year2] = projection.multiYear.rows;
  // Year 1 is the ungrown base -- same value/dividend as the current
  // holdings/breakdown totals, no 6% applied yet.
  assert.equal(year1!.valueDecimal, projection.currentPortfolioValueDecimal);
  assert.equal(
    year1!.grossDividendDecimal,
    projection.breakdown.totalGrossDecimal,
  );
  // Year 2: value compounds by the 6% value-growth default; dividend
  // compounds by the 6% dividend-growth default -- INDEPENDENTLY (neither
  // derives from the other; yield is a derived display figure only).
  const expectedValue2 = (Number(year1!.valueDecimal) * 1.06).toFixed(2);
  const expectedGross2 = (Number(year1!.grossDividendDecimal) * 1.06).toFixed(
    10,
  );
  assert.equal(Number(year2!.valueDecimal).toFixed(2), expectedValue2);
  assert.ok(
    Math.abs(Number(year2!.grossDividendDecimal) - Number(expectedGross2)) <
      1e-6,
  );
  // This fixture's value-growth and dividend-growth rates are identical
  // (both default to 6%), so it does not by itself distinguish "compounds
  // independently" from "one derives the other" -- the very next test below
  // (owner-set 10%/2%, genuinely different rates) is the one that actually
  // proves independence; this test's own job is the "both default to 6%"
  // acceptance check.
});

test("DIV-011: an owner-set growth value still wins outright over the 6% default (the default only ever applies when a portfolio has NEVER set an assumption)", async () => {
  const db = await coverageGapFixture();
  db.exec(`
    INSERT INTO dividend_portfolio_assumptions(portfolio_id,user_id,value_growth_percent_decimal,portfolio_dividend_growth_percent_decimal,created_at,updated_at,version) VALUES
      ('pa','a','10','2','2026-08-01','2026-08-01',1);
  `);
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
    { yearsForward: 2 },
  );

  assert.equal(projection.portfolioValueGrowth.source, "portfolio_assumption");
  assert.equal(projection.portfolioValueGrowth.growthPercentDecimal, "10");
  assert.equal(
    projection.portfolioDividendGrowth.source,
    "portfolio_assumption",
  );
  assert.equal(projection.portfolioDividendGrowth.growthPercentDecimal, "2");

  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) throw new Error("unreachable");
  const [year1, year2] = projection.multiYear.rows;
  // Independent axes, hand-verifiable: value grows 10%, dividend grows 2% --
  // genuinely different rates, proving neither derives from the other.
  const expectedValue2 = (Number(year1!.valueDecimal) * 1.1).toFixed(2);
  const expectedGross2 = Number(year1!.grossDividendDecimal) * 1.02;
  assert.equal(Number(year2!.valueDecimal).toFixed(2), expectedValue2);
  assert.ok(
    Math.abs(Number(year2!.grossDividendDecimal) - expectedGross2) < 1e-6,
  );
  assert.notEqual(year2!.valueDecimal, year1!.valueDecimal);
  assert.notEqual(year2!.grossDividendDecimal, year1!.grossDividendDecimal);
});

test("DIV-011: year 1's endingYear IS the current financial year (FY-001 naming) -- matching computeCurrentFinancialYearRow's own endingYear, the merged current-FY row's contract", async () => {
  const db = await coverageGapFixture();
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );

  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) throw new Error("unreachable");
  assert.equal(projection.currentFinancialYear.ok, true);
  if (!projection.currentFinancialYear.ok) throw new Error("unreachable");
  // The FY containing 2026-08-13 with a July start month is FY27
  // (2026-07-01 .. 2027-06-30).
  assert.equal(projection.currentFinancialYear.row.endingYear, 2027);
  assert.equal(projection.multiYear.rows[0]!.endingYear, 2027);
  assert.equal(projection.multiYear.rows[0]!.label, "FY27");
  // The current FY row's own actuals-to-date derivation (unchanged,
  // reused, never conflated with the forward forecast above): this
  // fixture's dividend history predates the current FY (paid 2026-03-01,
  // inside FY26, before the FY27 window this "today" falls in) -- an
  // honest "no_evidence" for FY-to-date, never a fabricated "actual $0",
  // and never re-derived from the forward forecast to paper over it.
  assert.equal(
    projection.currentFinancialYear.row.dividendSource,
    "no_evidence",
  );
  assert.equal(projection.currentFinancialYear.row.dividendGrossDecimal, null);
});

test("DIV-011 merged-row contract, positive case: a real dividend paid WITHIN the current FY produces a genuine FY-to-date actual, distinct from and never summed into the forward forecast on the SAME row", async () => {
  const db = await coverageGapFixture();
  // A THIRD dividend, paid 2026-07-15 -- inside the current FY window
  // (2026-07-01..2027-06-30) -- on top of the existing 2026-03-01 history
  // (which stays in the CLOSED FY26 and still feeds the forward forecast's
  // trailing-window derivation).
  db.exec(`
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,total_cash_decimal,total_franking_decimal,import_batch_id,created_at,updated_at,version) VALUES
      ('m3','a','pa','psa','2026-07-15',NULL,NULL,NULL,'40',NULL,'batch-a','2026-07-15','2026-07-15',1);
  `);
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );

  assert.equal(projection.currentFinancialYear.ok, true);
  if (!projection.currentFinancialYear.ok) throw new Error("unreachable");
  assert.equal(
    projection.currentFinancialYear.row.dividendSource,
    "fy_to_date",
  );
  assert.equal(projection.currentFinancialYear.row.dividendGrossDecimal, "40");

  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) throw new Error("unreachable");
  const year1 = projection.multiYear.rows[0]!;
  assert.equal(
    year1.endingYear,
    projection.currentFinancialYear.row.endingYear,
  );
  // The forward forecast row is the SAME reused Next-12-months figure as
  // ever -- unaffected by, and not summed with, the $40 actual-to-date
  // figure above (two different, non-additive time windows: a rolling
  // 12-month-forward forecast from today vs FY-to-date actuals).
  assert.equal(
    year1.grossDividendDecimal,
    projection.breakdown.totalGrossDecimal,
  );
  assert.notEqual(
    year1.grossDividendDecimal,
    projection.currentFinancialYear.row.dividendGrossDecimal,
  );
});

test("DIV-011 honesty: DIV-009's partial-TTM disclosure survives the base swap -- sourced from computeIncomeBreakdown.partialTtmSecurities (the SAME aggregation feeding the base), not the old aggregateYield chain", async () => {
  const db = await coverageGapFixture();
  // A PARTIALLY determinable per-share rate is a provider/history-TTM
  // concept (div-009.test.ts's dedicated fixtures already drill the
  // per-security ttmIncomplete plumbing) that this fixture's totals-mode-only
  // shape does not produce -- so instead this test asserts the STRUCTURAL
  // wiring end-to-end: baseYieldIncludesPartialTtm is sourced from
  // breakdown.partialTtmSecurities (never re-derived from the old
  // aggregateYield chain), which this fixture's shape (totals-mode only, no
  // provider TTM) legitimately reports empty -- confirming no FALSE
  // positive leaks through the new wiring.
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );
  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) throw new Error("unreachable");
  assert.equal(
    projection.multiYearBaselineInput!.assumptions.baseYieldIncludesPartialTtm,
    projection.breakdown.partialTtmSecurities.length > 0,
  );
  assert.equal(
    projection.multiYearBaselineInput!.assumptions.baseYieldIncludesPartialTtm,
    false,
  );
  assert.doesNotMatch(
    projection.multiYear.rows[0]!.method,
    /partially determinable/,
  );
});

test("DIV-011 review fix B3, end-to-end: a several-excluded base (2 of 4 held securities contribute NOTHING to the reused forecast sum -- one foreign-currency, one with zero dividend history) is named on the multi-year row's own method, matching breakdown.excludedSecurities exactly", async () => {
  const db = await coverageGapFixture();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('USD',840,'US dollar',2);
    -- "psc": a FOREIGN-currency (USD) held security with real dividend
    -- history -- excluded from the AUD-base breakdown for foreign_currency,
    -- never mis-converted or silently omitted.
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s3','equity','asx','USD','Foreign Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psc','a','pa','s3','S3','USD','held','2026-08-01','2026-08-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx3','a','pa','psc','buy','posted','2025-01-01T00:00:00Z','2025-01-01','20','5','USD','100','0','0','manual','a',1,'2025-01-01');
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,total_cash_decimal,total_franking_decimal,import_batch_id,created_at,updated_at,version) VALUES
      ('m4','a','pa','psc','2026-03-01',NULL,NULL,NULL,'25',NULL,'batch-a','2026-03-01','2026-03-01',1);
    INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at) VALUES
      ('projection-c','a','pa','psc','20','100','130','5','complete','ready','2','run-a',1,'2026-08-13T01:00:00Z');
    -- "psd": a held AUD security with ZERO dividend history at all --
    -- excluded from the breakdown for insufficient_history.
    INSERT INTO securities(id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s4','equity','asx','AUD','No History Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psd','a','pa','s4','S4','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx4','a','pa','psd','buy','posted','2025-01-01T00:00:00Z','2025-01-01','10','5','AUD','50','0','0','manual','a',1,'2025-01-01');
    INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at) VALUES
      ('projection-d','a','pa','psd','10','50','50','5','complete','ready','2','run-a',1,'2026-08-13T01:00:00Z');
  `);
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );

  assert.equal(projection.breakdown.status, "partial");
  assert.equal(projection.breakdown.includedSecurityCount, 2); // psa, psb
  assert.equal(projection.breakdown.excludedSecurities.length, 2); // psc, psd
  const excludedIds = projection.breakdown.excludedSecurities.map(
    (entry) => entry.portfolioSecurityId,
  );
  assert.ok(excludedIds.includes("psc"));
  assert.ok(excludedIds.includes("psd"));

  assert.equal(projection.multiYear.ok, true);
  if (!projection.multiYear.ok) throw new Error("unreachable");
  assert.equal(
    projection.multiYearBaselineInput!.assumptions.baseExcludedSecurityCount,
    2,
  );
  // Named on EVERY row's own method -- travels with the row (the B1/B4
  // precedent), including a genuinely future (compounded) row, not just
  // year 1.
  for (const row of projection.multiYear.rows) {
    assert.match(row.method, /2 held securities excluded entirely/);
    assert.match(row.method, /may understate true income/);
  }
});

test("DIV-011: no held security has a usable 12-month forecast -- the multi-year gate now mirrors the reused base's OWN coverage (computeIncomeBreakdown), not the separate aggregate-yield chain", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    -- Cash-only: loadOwnedHoldings takes its early cash-only return path
    -- (no projection_publications/calculation_runs needed), giving a
    -- real, known, non-zero portfolio value with ZERO held securities --
    -- isolating "value known, no forecast coverage" (this test) from "value
    -- unknown" (a different, already-covered typed reason).
    INSERT INTO cash_accounts(id,user_id,portfolio_id,currency_code,completeness,status) VALUES
      ('ca','a','pa','AUD','complete','active');
    INSERT INTO cash_ledger_entries(id,user_id,portfolio_id,cash_account_id,transaction_id,effective_at,local_effective_date,type,signed_amount_decimal,status,created_at) VALUES
      ('cle','a','pa','ca',NULL,'2026-01-01T00:00:00Z','2026-01-01','cash_deposit','5000','posted','2026-01-01');
  `);
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );
  // No held securities at all -- an "empty" portfolio, never a fabricated
  // projection, but a real known (cash-only) value.
  assert.equal(projection.status, "empty");
  assert.equal(projection.currentPortfolioValueDecimal, "5000");
  assert.equal(projection.portfolioValueStatus, "available");
  assert.equal(projection.breakdown.status, "no_coverage");
  assert.deepEqual(projection.multiYear, {
    ok: false,
    reason: "no_yield_coverage",
  });
  assert.equal(projection.multiYearBaselineInput, null);
});
