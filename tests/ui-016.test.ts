/** UI-016 — working holdings-sheet Dividends link, past FYs on the Income
 * tab, and a new portfolio-wide list of individual dividends. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import {
  loadOwnedDividendList,
  MAX_DIVIDEND_LIST_ROWS,
} from "../app/owned-dividend-list.ts";

function renderComponent(
  componentName: string,
  componentPath: string,
  props: unknown,
): string {
  const componentUrl = new URL(componentPath, import.meta.url).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ${componentName} } from ${JSON.stringify(componentUrl)};
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(createElement(${componentName}, props)),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

// ---------------------------------------------------------------------------
// Part 1: the holdings-sheet Dividends link (portfolio-shell.tsx).
// `portfolio-shell.tsx` is a large dual-mode component this suite's other
// tests already read as SOURCE rather than render (see qa-001b.test.ts's
// established convention) -- mirrored here.
// ---------------------------------------------------------------------------

test("UI-016/UI-023C: dividends are reachable from the holding Details screen via the shared nav's Dividends tab; the old inline link is gone", async () => {
  // UI-023 replaced the owned holdings <dialog> sheet with the standalone
  // Details screen; UI-023C then promoted the per-security dividends page
  // to the holding area's FOURTH sub-tab, so the Details screen's own
  // "View dividends" link became redundant chrome and was removed. The
  // reachable path is now the shared HoldingNav tab.
  const [detail, nav] = await Promise.all([
    readFile(
      new URL("../app/components/holding-detail.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/holding-nav.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.doesNotMatch(detail, /View dividends/);
  assert.doesNotMatch(detail, /dialogRef/);
  assert.match(nav, /label: "Dividends"/);
  assert.match(
    nav,
    /href: \(id, sid\) => `\/portfolio\/\$\{id\}\/holdings\/\$\{sid\}\/dividends`/,
  );
});

test("UI-016: the .sheet-back class used for the Dividends link is the existing 44px button-styled link, not new one-off styling", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const block = css.match(/\.sheet-back\s*{([^}]*)}/);
  assert.ok(block, "expected an existing .sheet-back rule in globals.css");
  assert.match(block![1], /min-height:\s*44px/);
});

// ---------------------------------------------------------------------------
// Part 2: the Income tab's past-FY section (income/page.tsx + income-landing.tsx).
// ---------------------------------------------------------------------------

test("UI-016: the Income page passes a non-zero yearsBack so past-FY rows are actually requested", async () => {
  const page = await readFile(
    new URL("../app/portfolio/[portfolioId]/income/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /yearsBack:\s*5/);
  assert.doesNotMatch(page, /yearsBack:\s*0/);
  assert.match(
    page,
    /dividendsHref=\{`\/portfolio\/\$\{portfolioId\}\/income\/dividends`\}/,
  );
});

const basePastFyRow = {
  window: { startDate: "2024-07-01", endDate: "2025-06-30" },
  includedSecurityCount: 2,
  excludedSecurities: [],
  portfolioValueDecimal: "9500.00",
  valueStatus: "available" as const,
  effectiveYieldPercentDecimal: "5.79",
};

const populatedProjection = {
  status: "ok",
  baseCurrencyCode: "AUD",
  today: "2026-08-13",
  currentPortfolioValueDecimal: "10000.00",
  portfolioValueStatus: "available",
  portfolioValueCoverage: null,
  assumptionGrid: [],
  aggregateYield: {
    status: "ok",
    effectiveYieldPercentDecimal: "4.5",
    effectiveFrankingMixPercentDecimal: "1.5",
    includedValueDecimal: "10000.00",
    includedCount: 2,
    excluded: [],
    method: "value-weighted average of every held security's resolved yield",
  },
  portfolioValueGrowth: {
    source: "none",
    growthPercentDecimal: "0",
    method: "no growth assumed",
  },
  portfolioDividendGrowth: {
    source: "none",
    growthPercentDecimal: "0",
    method: "no growth assumed",
  },
  multiYear: { ok: false, reason: "portfolio_value_unavailable" },
  multiYearBaselineInput: null,
  currentFinancialYear: { ok: false, reason: "invalid_start_month" },
  pastFinancialYears: {
    ok: true,
    rows: [
      {
        ...basePastFyRow,
        endingYear: 2025,
        label: "FY25",
        dividendSource: "actual",
        dividendGrossDecimal: "550.00",
        dividendCashDecimal: "440.00",
        dividendFrankingKnownDecimal: "110.00",
        dividendFrankingIncomplete: false,
        method:
          "sum of each security's own precedence-resolved FY total (actual)",
      },
      {
        ...basePastFyRow,
        endingYear: 2024,
        label: "FY24",
        dividendSource: "no_evidence",
        dividendGrossDecimal: null,
        dividendCashDecimal: null,
        dividendFrankingKnownDecimal: null,
        dividendFrankingIncomplete: false,
        portfolioValueDecimal: null,
        valueStatus: "unavailable",
        effectiveYieldPercentDecimal: null,
        method: "no eligible security has any fyTotals entry for this year",
      },
    ],
  },
  breakdown: {
    status: "ok",
    currencyCode: "AUD",
    totalGrossDecimal: "600.00",
    totalCashDecimal: "480.00",
    totalFrankingKnownDecimal: "120.00",
    totalFrankingIncomplete: false,
    averagePerMonthDecimal: "50.00",
    averagePerWeekDecimal: "11.54",
    incomePercentOfValueDecimal: "6.00",
    incomePercentOfValueStatus: "available",
    includedSecurityCount: 2,
    excludedSecurities: [],
    method:
      "sum of every held security's 12-month baseline forecast (gross, includes franking credits)",
  },
};

const landingProps = {
  projection: populatedProjection,
  portfolioId: "portfolio-a",
  multiYearHref: "/portfolio/portfolio-a/income/multi-year",
  assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
  dividendsHref: "/portfolio/portfolio-a/income/dividends",
};

function renderLanding(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "IncomeLanding",
    "../app/components/income-landing.tsx",
    { ...landingProps, ...overrides },
  );
}

test("UI-016: the Income landing renders past-FY rows with real figures and an 'All dividends' link, once real history is present", () => {
  const html = renderLanding();
  assert.match(html, /All dividends/);
  assert.match(
    html,
    /<a href="\/portfolio\/portfolio-a\/income\/dividends">All dividends<\/a>/,
  );
  assert.match(html, /Recent financial years/);
  assert.match(html, /<caption>Recent financial-year dividends<\/caption>/);
  assert.match(html, />FY25</);
  assert.match(html, /\$550\.00/); // FY25 gross
  assert.match(html, /\$440\.00/); // FY25 cash
  assert.match(html, /\$110\.00/); // FY25 franking
  assert.match(
    html,
    /FY25[\s\S]{0,400}<span class="income-source">actual<\/span>/,
  );
  assert.match(html, /See the full multi-year range/);
});

test("UI-016: a no_evidence past-FY row renders 'Unavailable' figures and an explicit 'no evidence' source, never a fabricated zero or 'actual'", () => {
  const html = renderLanding();
  assert.match(
    html,
    /FY24[\s\S]{0,400}<span class="income-source">no evidence<\/span>/,
  );
  // Never a $0.00 masquerading as a known figure for the no_evidence year.
  assert.doesNotMatch(html, /FY24[\s\S]{0,200}\$0\.00/);
});

test("UI-016: a degraded pastFinancialYears result (ok: false) is disclosed with an explicit banner, never a silently empty table", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      pastFinancialYears: { ok: false, reason: "invalid_years" },
    },
  });
  assert.match(html, /Past financial years unavailable/);
  assert.match(html, /The requested years-back range is invalid\./);
  assert.doesNotMatch(html, /<caption>Recent financial-year dividends/);
});

test("UI-016: an empty (but ok) pastFinancialYears result renders the honest 'no financial years in range' text", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      pastFinancialYears: { ok: true, rows: [] },
    },
  });
  assert.match(html, /No financial years in range\./);
});

test("UI-016 (review follow-up a): a past-FY row with excludedSecurities carries a compact '· partial' coverage marker, so a partial sum is never presented as complete", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      pastFinancialYears: {
        ok: true,
        rows: [
          {
            ...basePastFyRow,
            endingYear: 2025,
            label: "FY25",
            dividendSource: "actual",
            dividendGrossDecimal: "550.00",
            dividendCashDecimal: "440.00",
            dividendFrankingKnownDecimal: "110.00",
            dividendFrankingIncomplete: false,
            excludedSecurities: [
              {
                portfolioSecurityId: "sec-1",
                symbol: "ABC",
                reason: "foreign_currency",
              },
            ],
            method:
              "sum of each security's own precedence-resolved FY total (actual)",
          },
        ],
      },
    },
  });
  assert.match(html, /FY25<span class="unavailable"> · partial<\/span>/);
});

test("UI-016 (review follow-up a): a past-FY row with NO excludedSecurities renders no partial marker", () => {
  const html = renderLanding();
  // FY25 in the default fixture has excludedSecurities: [] -- its own
  // label cell carries no partial marker (FY24, the no_evidence row, is a
  // different honest state and is asserted separately).
  assert.doesNotMatch(html, /FY25<span class="unavailable"> · partial<\/span>/);
});

test("UI-016 (review follow-up b): the 'full multi-year range' link passes ?yearsBack=10 so the owner reaches the full range in one click", () => {
  const html = renderLanding();
  assert.match(
    html,
    /<a class="income-coverage-link" href="\/portfolio\/portfolio-a\/income\/multi-year\?yearsBack=10">See the full multi-year range<\/a>/,
  );
});

// ---------------------------------------------------------------------------
// Part 3: the new portfolio-wide dividends list.
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

// Fixture: one portfolio ('pa', owner 'a', AUD base) with three securities
// -- ALPHA (AUD, a known-cash paid row and a declared future/not-paid row),
// BETA (AUD security, foreign USD payout via a BRK-010-style totals-mode
// imported manual record WITH a stored rate, exercising the
// conversion-provenance display), and GAMMA (AUD security, a foreign USD
// totals-mode payout with NO stored rate -- BRK-010's fail-closed case,
// exercising a genuinely unknown cash/gross amount that is never
// fabricated as zero). A second owner 'b' with an unrelated portfolio 'pb'
// for the cross-owner denial check.
async function fixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES
      ('AUD',36,'Australian dollar',2),
      ('USD',840,'US dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01'),
      ('b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1),
      ('b','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pb','b','B','B portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s1','equity','AUD','Alpha Co','2026-08-01','2026-08-01'),
      ('s2','equity','AUD','Beta Co','2026-08-01','2026-08-01'),
      ('s3','equity','AUD','Gamma Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa1','a','pa','s1','ALPHA','AUD','held','2026-08-01','2026-08-01'),
      ('psa2','a','pa','s2','BETA','AUD','held','2026-08-01','2026-08-01'),
      ('psa3','a','pa','s3','GAMMA','AUD','held','2026-08-01','2026-08-01');

    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa1','buy','posted','2025-12-01T00:00:00Z','2025-12-01','100','5','AUD','500','0','0','manual','a',1,'2025-12-01');

    -- ALPHA: a known-cash paid dividend and a declared future (not-paid)
    -- dividend.
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,payment_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de1','s1','yahoo-compatible','cash','paid','2026-01-01','2026-01-15','AUD','1.00','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01'),
      ('de3','s1','yahoo-compatible','cash','declared','2027-01-01',NULL,'AUD','2.00','2026-08-01T00:00:00Z','2026-08-01T00:00:00Z','2026-08-01');

    -- BETA: a foreign (USD) totals-mode imported payout, converted to AUD
    -- (BETA's own currency) via BRK-010's stored Sharesight rate.
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,import_batch_id,total_cash_decimal,total_franking_decimal,currency_code,fx_rate_to_portfolio_decimal,fx_rate_source,created_at,updated_at,version) VALUES
      ('mr1','a','pa','psa2','2026-02-01',NULL,NULL,NULL,'batch-x','20.00',NULL,'USD','1.5','sharesight','2026-08-01','2026-08-01',1);

    -- GAMMA: a foreign (USD) totals-mode imported payout with NO stored
    -- rate -- BRK-010's fail-closed case (missing FX is never zero, never
    -- guessed): the derived cash/gross become genuinely unknown.
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,import_batch_id,total_cash_decimal,total_franking_decimal,currency_code,fx_rate_to_portfolio_decimal,fx_rate_source,created_at,updated_at,version) VALUES
      ('mr2','a','pa','psa3','2026-03-01',NULL,NULL,NULL,'batch-y','15.00',NULL,'USD',NULL,NULL,'2026-08-01','2026-08-01',1);
  `);
  return db;
}

const NOW = new Date("2026-08-13T00:00:00Z");

test("UI-016: loadOwnedDividendList flattens every security's rows date-descending (newest paymentDate/exDate first)", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const list = await loadOwnedDividendList(client, "a", "pa", NOW);

  // de3 (declared, ex-date 2027-01-01, no payment date yet) sorts first --
  // its ex-date is the newest known date in the set; mr2 (2026-03-01) and
  // mr1 (2026-02-01) follow; de1 (2026-01-15) is oldest.
  const order = list.rows.map((row) => row.id);
  assert.deepEqual(order, [
    "psa1:de3",
    "psa3:imported:mr2",
    "psa2:imported:mr1",
    "psa1:de1",
  ]);
});

test("UI-016: a declared-but-unpaid row is honestly marked 'not paid'; a payout with no usable FX rate renders the existing unknown representation, never a fabricated zero", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const list = await loadOwnedDividendList(client, "a", "pa", NOW);

  const pending = list.rows.find((row) => row.id === "psa1:de3");
  assert.equal(pending?.notPaid, true);

  const unknownAmount = list.rows.find((row) => row.id === "psa3:imported:mr2");
  assert.equal(unknownAmount?.notPaid, false);
  assert.equal(unknownAmount?.cashDecimal, null);
  assert.equal(unknownAmount?.grossDecimal, null);

  const knownRow = list.rows.find((row) => row.id === "psa1:de1");
  assert.equal(knownRow?.cashDecimal, "100"); // 100 shares x AUD 1.00
});

test("UI-016: a foreign-currency payout carries its conversion provenance (original currency, rate, source) alongside the already-converted cash total", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const list = await loadOwnedDividendList(client, "a", "pa", NOW);

  const converted = list.rows.find((row) => row.id === "psa2:imported:mr1");
  assert.ok(converted);
  assert.equal(converted?.originalCurrencyCode, "USD");
  assert.equal(converted?.fxRateToPortfolioDecimal, "1.5");
  assert.equal(converted?.fxRateSource, "sharesight");
  // 20.00 USD x 1.5 = 30.00 AUD, in BETA's own (AUD) currency.
  assert.equal(converted?.currencyCode, "AUD");
  assert.equal(converted?.cashDecimal, "30");
});

test("UI-016: loadOwnedDividendList denies a cross-owner portfolioId", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  await assert.rejects(
    loadOwnedDividendList(client, "b", "pa", NOW),
    /not_owned/,
  );
});

// Dedicated fixture for review finding B1: a security whose OWN currency
// (NZD) differs from the portfolio base (AUD) can never reach BRK-010's
// cash-conversion tier (case C -- `resolveImportedRecordCurrency` returns
// before ever consulting a rate), so a USD payout on it stays in ITS OWN
// (USD) currency, unconverted -- never silently relabelled as the
// security's NZD, and never the portfolio's AUD.
async function caseCFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES
      ('AUD',36,'Australian dollar',2),
      ('NZD',554,'New Zealand dollar',2),
      ('USD',840,'US dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pc','a','C','C portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s4','equity','NZD','Delta Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psc1','a','pc','s4','DELTA','NZD','held','2026-08-01','2026-08-01');
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,import_batch_id,total_cash_decimal,total_franking_decimal,currency_code,fx_rate_to_portfolio_decimal,fx_rate_source,created_at,updated_at,version) VALUES
      ('mr3','a','pc','psc1','2026-04-01',NULL,NULL,NULL,'batch-z','20.00',NULL,'USD',NULL,NULL,'2026-08-01','2026-08-01',1);
  `);
  return db;
}

test("UI-016 (review B1, reproduced): a degraded (case C) foreign payout on a security whose OWN currency differs from the portfolio base carries the ROW's true currency, never the security's own currency", async () => {
  const db = await caseCFixture();
  const client = createSqliteSqlClient(db);
  const list = await loadOwnedDividendList(client, "a", "pc", NOW);
  assert.equal(list.rows.length, 1);
  const row = list.rows[0];
  // USD, never "NZD" (DELTA's own currency) and never "AUD" (portfolio base).
  assert.equal(row?.currencyCode, "USD");
  assert.equal(row?.cashDecimal, "20.00");
  // Never converted (case C has no rate to apply), so no fake provenance.
  assert.equal(row?.originalCurrencyCode, null);
  assert.equal(row?.fxRateToPortfolioDecimal, null);
});

// Dedicated fixture for review finding B2: an owner-excluded dividend
// (`dividend_event_overrides.exclude = 1`) must carry that through, not
// render identically to a counted row.
async function excludedFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES
      ('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pd','a','D','D portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s5','equity','AUD','Epsilon Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psd1','a','pd','s5','EPSILON','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx2','a','pd','psd1','buy','posted','2025-12-01T00:00:00Z','2025-12-01','100','5','AUD','500','0','0','manual','a',1,'2025-12-01');
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,payment_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de5','s5','yahoo-compatible','cash','paid','2026-05-01','2026-05-10','AUD','1.00','2026-05-01T00:00:00Z','2026-05-01T00:00:00Z','2026-05-01');
    INSERT INTO dividend_event_overrides(id,user_id,portfolio_id,portfolio_security_id,dividend_event_id,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,exclude,created_at,updated_at,version) VALUES
      ('ov2','a','pd','psd1','de5',NULL,NULL,NULL,1,'2026-08-01','2026-08-01',1);
  `);
  return db;
}

test("UI-016 (review B2, reproduced): an owner-excluded dividend carries excluded through the flattened list, distinct from a counted row", async () => {
  const db = await excludedFixture();
  const client = createSqliteSqlClient(db);
  const list = await loadOwnedDividendList(client, "a", "pd", NOW);
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0]?.excluded, true);
});

test("UI-016: MAX_DIVIDEND_LIST_ROWS is a real positive bound (the flattened list is truncated, not unbounded)", () => {
  assert.ok(Number.isInteger(MAX_DIVIDEND_LIST_ROWS));
  assert.ok(MAX_DIVIDEND_LIST_ROWS > 0);
});

// --- Component rendering ---------------------------------------------------

const dividendListRows = [
  {
    id: "row-1",
    portfolioSecurityId: "psa1",
    symbol: "ALPHA",
    currencyCode: "AUD",
    paymentDate: "2026-02-10",
    exDate: "2026-02-01",
    notPaid: false,
    cashDecimal: null,
    frankingTotalDecimal: null,
    grossDecimal: null,
    source: "auto",
    excluded: false,
    originalCurrencyCode: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
  },
  {
    id: "row-2",
    portfolioSecurityId: "psa1",
    symbol: "ALPHA",
    currencyCode: "AUD",
    paymentDate: null,
    exDate: "2027-01-01",
    notPaid: true,
    cashDecimal: null,
    frankingTotalDecimal: null,
    grossDecimal: null,
    source: "auto",
    excluded: false,
    originalCurrencyCode: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
  },
  {
    id: "row-3",
    portfolioSecurityId: "psa2",
    symbol: "BETA",
    currencyCode: "AUD",
    paymentDate: "2026-02-01",
    exDate: null,
    notPaid: false,
    cashDecimal: "30.00",
    frankingTotalDecimal: null,
    grossDecimal: "30.00",
    source: "imported",
    excluded: false,
    originalCurrencyCode: "USD",
    fxRateToPortfolioDecimal: "1.5",
    fxRateSource: "sharesight",
  },
  {
    id: "row-4",
    portfolioSecurityId: "psa1",
    symbol: "ALPHA",
    // Review B1: this row's OWN currency (USD), distinct from ALPHA's own
    // AUD -- a degraded case-C row would carry exactly this shape.
    currencyCode: "USD",
    paymentDate: "2026-01-01",
    exDate: null,
    notPaid: false,
    cashDecimal: "12.00",
    frankingTotalDecimal: null,
    grossDecimal: "12.00",
    source: "manual",
    // Review B2: an owner-excluded row.
    excluded: true,
    originalCurrencyCode: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
  },
];

function renderList(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "OwnedDividendList",
    "../app/components/owned-dividend-list.tsx",
    {
      portfolioId: "pa",
      baseCurrencyCode: "AUD",
      today: "2026-08-13",
      rows: dividendListRows,
      truncated: false,
      totalCount: dividendListRows.length,
      ...overrides,
    },
  );
}

test("UI-016: the dividends list renders per-row links to the security's own dividends tab, a 'not paid' row, an unknown-amount row, and conversion provenance", () => {
  const html = renderList();
  assert.match(
    html,
    /<a href="\/portfolio\/pa\/holdings\/psa1\/dividends">ALPHA<\/a>/,
  );
  assert.match(
    html,
    /<a href="\/portfolio\/pa\/holdings\/psa2\/dividends">BETA<\/a>/,
  );
  assert.match(html, /class="dividend-row-not-paid"/);
  assert.match(html, /class="dividend-status-not-paid"/);
  assert.match(html, />not paid</);
  // The unknown-amount row (row-1) renders the same "Unavailable" text the
  // rest of the Income screens use for a null decimal -- never "0.00".
  assert.doesNotMatch(html, /\$0\.00/);
  assert.match(html, /Unavailable/);
  // Conversion provenance (BRK-010/UI-014 pattern).
  assert.match(html, /converted from USD @ 1\.5 \(sharesight\)/);
  assert.match(html, /\$30\.00/);
  // Review B1: row-4 carries its OWN currency (USD), not ALPHA's (AUD) --
  // UI-026: a foreign (non-base) amount renders flagged, not bare.
  assert.match(html, /US\$12\.00/);
  // Review B2: row-4 is owner-excluded -- the marker mirrors the security
  // tab's own "· excluded" text exactly.
  assert.match(html, /manual · excluded/);
});

test("UI-016: an empty dividends list renders an honest empty-state message, never a fabricated row", () => {
  const html = renderList({ rows: [], totalCount: 0 });
  assert.match(html, /No dividends found across this portfolio yet\./);
});

test("UI-016: a truncated list discloses the cap instead of silently dropping rows", () => {
  const html = renderList({ truncated: true, totalCount: 9999 });
  assert.match(html, /Showing the most recent 4 of 9,999 dividends/);
});

// --- Page wiring + QA-001A matrix ------------------------------------------

test("UI-016: the portfolio-wide dividends list page loads via the owner-scoped context and is force-dynamic", async () => {
  const page = await readFile(
    new URL(
      "../app/portfolio/[portfolioId]/income/dividends/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /loadAuthenticatedWorkspace\(portfolioId\)/);
  assert.match(page, /getAuthenticatedSqlContext\(portfolioId\)/);
  assert.match(page, /loadOwnedDividendList\(/);
  assert.match(page, /workspace\.activePortfolio === null\) notFound\(\)/);
});

test("UI-016: the QA-001A matrix records the new portfolio-wide dividends list route", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const needle of [
    "/portfolio/:id/income/dividends",
    "loadOwnedDividendList",
    "tests/ui-016.test.ts",
  ]) {
    assert.ok(matrix.includes(needle), `matrix should mention ${needle}`);
  }
});

test("UI-016: every matrix citation naming tests/ui-016.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/ui-016.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/ui-016\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
  const quotedStringPattern = /"(?:[^"\\]|\\.)*"/g;
  let groupCount = 0;
  let titleCount = 0;
  for (const match of matrix.matchAll(citationGroupPattern)) {
    groupCount += 1;
    const titles = match[2]!.match(quotedStringPattern) ?? [];
    for (const quoted of titles) {
      titleCount += 1;
      const title = quoted.slice(1, -1);
      assert.ok(
        ownSource.includes(title),
        `matrix cites "${title}" in tests/ui-016.test.ts, but that title is not a literal substring of the file's source (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount >= 1, "expected at least 1 citation group to check");
  assert.ok(titleCount >= 2, "expected at least 2 quoted titles to check");
});
