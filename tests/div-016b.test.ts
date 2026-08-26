// DIV-016 part B: the owner-approved "override-as-bridge" precedence
// (TASKS.md DIV-016, owner ruling 2026-08-26, quoted in full in
// `domain/dividends/forecast.ts`'s module header and
// `docs/CALCULATIONS.md` section 11's "Override-as-bridge precedence
// (DIV-016 part B)"): an owner assumption override
// (`dividend_security_assumptions` yield/franking_percent_decimal) wins
// only while the security has LESS THAN 12 months of real dividend
// history; once a full trailing year of evidence exists, history takes
// over automatically and the override is kept but marked DORMANT (visible,
// not deleted), still deliberately forceable via `force_assumption`.
//
// This file pins:
//  a. `hasFullYearHistoryEvidence`'s exact rule (`forecast.ts`) -- the
//     ~11.9 vs ~12.1 month span boundary, and the "one 380-day-old row and
//     nothing since" edge case that must NOT count as a full year.
//  b. The franking-tail bridge gate (BUG-004's mechanism in forecast.ts):
//     dormant assumption falls through to real per-row franking evidence;
//     `force_assumption` restores the assumption's win.
//  c. The assumptions editor's owner-scoped, idempotent, cross-user-safe
//     `force_assumption` mutation.
//  d. End-to-end dormant disclosure through `loadOwnedDividendAssumptions`
//     (editor read service) and `loadOwnedIncomeProjection` (assumption
//     grid).
//  e. The force-toggle's 44px touch target (QA-001B).
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import {
  deriveDividendHistoryForSecurity,
  type DividendManualRecordFact,
} from "../domain/dividends/history.ts";
import { computeSecurityDividendForecast } from "../domain/dividends/forecast.ts";
import { computeDefaultFrankingCredit } from "../domain/dividends/franking.ts";
import type { LedgerQuantityFact } from "../domain/dividends/shares-held.ts";
import {
  saveDividendAssumptionsGridWithContext,
  type DividendActionContext,
} from "../app/dividend-assumptions-actions.ts";
import { loadOwnedDividendAssumptions } from "../app/owned-dividend-assumptions.ts";
import { loadOwnedIncomeProjection } from "../app/owned-income-projection.ts";

const TODAY = "2026-08-13";

function tx(
  overrides: Partial<LedgerQuantityFact> & { id: string },
): LedgerQuantityFact {
  const localTradeDate = overrides.localTradeDate ?? "2024-01-01";
  return {
    type: "buy",
    status: "posted",
    localTradeDate,
    tradeAt: `${localTradeDate}T00:00:00Z`,
    quantityDecimal: "100",
    unitPriceDecimal: null,
    reversesTransactionId: null,
    ...overrides,
  };
}

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
    totalCashDecimal: "100",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
    ...overrides,
  };
}

const HOLDING_TX: LedgerQuantityFact[] = [tx({ id: "b1" })];

// ---------------------------------------------------------------------------
// a. hasFullYearHistoryEvidence -- the exact span-boundary rule.
// ---------------------------------------------------------------------------

test("DIV-016 part B: hasFullYearHistoryEvidence boundary -- ~11.9 months of span is NOT a full year; ~12.1 months IS (both alongside a recent within-window row so the TTM leg resolves)", () => {
  // A recent row inside the trailing 365-day window gives the TTM leg a
  // usable rate regardless of the older row's own age.
  const recent = totalsManual({
    id: "m-recent",
    paymentDate: "2026-03-01",
    totalCashDecimal: "150",
  });

  // ~11.9 months (362 days) before TODAY -- BELOW the 365-day threshold.
  const belowRows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      recent,
      totalsManual({ id: "m-old-below", paymentDate: "2025-08-16" }), // 362 days back
    ],
    transactions: [tx({ id: "b1" })],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const belowForecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: belowRows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  assert.equal(belowForecast.ttmSource, "history_ttm");
  assert.equal(
    belowForecast.hasFullYearHistoryEvidence,
    false,
    "362 days of span is under 12 months -- the override must still bridge",
  );

  // ~12.1 months (370 days) before TODAY -- AT/ABOVE the 365-day threshold.
  const aboveRows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      recent,
      totalsManual({ id: "m-old-above", paymentDate: "2025-08-08" }), // 370 days back
    ],
    transactions: [tx({ id: "b1" })],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const aboveForecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: aboveRows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  assert.equal(aboveForecast.ttmSource, "history_ttm");
  assert.equal(
    aboveForecast.hasFullYearHistoryEvidence,
    true,
    "370 days of span is 12+ months and the TTM leg resolves -- history takes over automatically",
  );
});

test("DIV-016 part B: exact boundary -- a security whose oldest row is dated exactly 365 days before today counts as a full year; one day later (364 days) does not", () => {
  const recent = totalsManual({
    id: "m-recent",
    paymentDate: "2026-03-01",
    totalCashDecimal: "150",
  });
  function forecastWithOldestRowAgeDays(days: number) {
    const date = new Date(`${TODAY}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - days);
    const oldestDate = date.toISOString().slice(0, 10);
    const rows = deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps1",
      securityCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [
        recent,
        totalsManual({ id: `m-old-${days}`, paymentDate: oldestDate }),
      ],
      transactions: [tx({ id: "b1" })],
      defaultFrankingPercentDecimal: null,
      today: TODAY,
    });
    return computeSecurityDividendForecast({
      portfolioSecurityId: "ps1",
      currencyCode: "AUD",
      historyRows: rows,
      ttmEvents: [],
      transactions: HOLDING_TX,
      defaultFrankingPercentDecimal: null,
      today: TODAY,
    });
  }
  assert.equal(
    forecastWithOldestRowAgeDays(365).hasFullYearHistoryEvidence,
    true,
  );
  assert.equal(
    forecastWithOldestRowAgeDays(364).hasFullYearHistoryEvidence,
    false,
  );
});

test("DIV-016 part B: a security with a SINGLE row dated 380 days ago and nothing since must NOT count as having a year of usable evidence (span alone is not enough -- the current trailing window is empty)", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({ id: "m-only", paymentDate: "2025-07-29" }), // 380 days before TODAY
    ],
    transactions: [tx({ id: "b1" })],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  // The current trailing 365-day window has NOTHING in it -- both TTM legs
  // report insufficient_history.
  assert.equal(forecast.ttmSource, null);
  assert.equal(
    forecast.hasFullYearHistoryEvidence,
    false,
    "a stale single old row must never outrank a live owner override",
  );
});

// ---------------------------------------------------------------------------
// b. The franking-tail bridge gate (forecast.ts's BUG-004 mechanism).
// ---------------------------------------------------------------------------

function bridgeFixtureRows() {
  return deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m-recent",
        paymentDate: "2026-03-01",
        totalCashDecimal: "150",
        totalFrankingDecimal: "64.29", // real evidence
      }),
      totalsManual({ id: "m-old", paymentDate: "2025-08-08" }), // 370 days back
    ],
    transactions: [tx({ id: "b1" })],
    defaultFrankingPercentDecimal: "50",
    today: TODAY,
  });
}

test("DIV-016 part B: once 12+ months of evidence exists, the franking-tail estimate falls through to real per-row franking evidence instead of the (now dormant) owner assumption", () => {
  const rows = bridgeFixtureRows();
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: "50",
    forceAssumption: false,
    today: TODAY,
  });
  assert.equal(forecast.hasFullYearHistoryEvidence, true);
  // Real evidence ($64.29 credit on $150 cash), NOT the 50%-assumption
  // gross-up.
  assert.notEqual(
    forecast.uncoveredFrankingKnownDecimal,
    computeDefaultFrankingCredit("150", "50"),
  );
  assert.equal(forecast.uncoveredFrankingKnownDecimal, "64.29");
});

test("DIV-016 part B: force_assumption restores the owner's franking assumption's win despite 12+ months of evidence", () => {
  const rows = bridgeFixtureRows();
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: "50",
    forceAssumption: true,
    today: TODAY,
  });
  assert.equal(forecast.hasFullYearHistoryEvidence, true);
  assert.equal(
    forecast.uncoveredFrankingKnownDecimal,
    computeDefaultFrankingCredit("150", "50"),
    "forced -- the 50% assumption wins even though real evidence exists",
  );
});

// ---------------------------------------------------------------------------
// c. Assumptions editor: owner-scoped, idempotent, cross-user-safe
//    force_assumption mutation (mirrors tests/ui-006b.test.ts's fixture).
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

async function fixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
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
      ('s1','equity','AUD','Alpha Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa1','a','pa','s1','ALPHA','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO market_data_providers(id,code,name,capabilities_json,rate_limit_json) VALUES('p','p','Provider','{}','{}');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx1','a','pa','psa1','buy','posted','2024-01-01T00:00:00Z','2024-01-01','100','5','AUD','500','0','0','manual','a',1,'2024-01-01');
  `);
  return db;
}

function contextFor(
  client: ReturnType<typeof createSqliteSqlClient>,
  userId: string,
): DividendActionContext {
  return { client, userId, requestId: "req-1" };
}

test("DIV-016 part B: grid save persists force_assumption (create), and an idempotent version-guarded update can flip it back off", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctx = contextFor(client, "a");

  const created = await saveDividendAssumptionsGridWithContext(ctx, "pa", {
    securities: [
      {
        portfolioSecurityId: "psa1",
        dividendYieldPercentDecimal: "12",
        frankingPercentDecimal: "70",
        dividendGrowthPercentDecimal: null,
        forceAssumption: true,
        expectedVersion: null,
      },
    ],
    portfolio: {
      valueGrowthPercentDecimal: null,
      portfolioDividendGrowthPercentDecimal: null,
      expectedVersion: null,
    },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const loaded1 = await loadOwnedDividendAssumptions(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(loaded1.securities[0]!.forceAssumption, true);

  // Version-guarded update flips it back off.
  const updated = await saveDividendAssumptionsGridWithContext(ctx, "pa", {
    securities: [
      {
        portfolioSecurityId: "psa1",
        dividendYieldPercentDecimal: "12",
        frankingPercentDecimal: "70",
        dividendGrowthPercentDecimal: null,
        forceAssumption: false,
        expectedVersion: created.securities[0]!.version,
      },
    ],
    portfolio: {
      valueGrowthPercentDecimal: null,
      portfolioDividendGrowthPercentDecimal: null,
      expectedVersion: created.portfolio.version,
    },
  });
  assert.equal(updated.ok, true);

  const loaded2 = await loadOwnedDividendAssumptions(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(loaded2.securities[0]!.forceAssumption, false);

  // A stale (already-consumed) version is rejected -- the version guard
  // makes a resubmit of the SAME stale payload safely inert (409, no
  // second write), matching the grid's established idempotency
  // convention.
  const stale = await saveDividendAssumptionsGridWithContext(ctx, "pa", {
    securities: [
      {
        portfolioSecurityId: "psa1",
        dividendYieldPercentDecimal: "12",
        frankingPercentDecimal: "70",
        dividendGrowthPercentDecimal: null,
        forceAssumption: true,
        expectedVersion: created.securities[0]!.version, // now stale
      },
    ],
    portfolio: {
      valueGrowthPercentDecimal: null,
      portfolioDividendGrowthPercentDecimal: null,
      expectedVersion: created.portfolio.version,
    },
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.status, 409);
  const loaded3 = await loadOwnedDividendAssumptions(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(
    loaded3.securities[0]!.forceAssumption,
    false,
    "the rejected stale write must not have applied",
  );
});

test("DIV-016 part B: cross-user probe -- user b cannot set force_assumption on user a's security (repository-level ownership re-check, not_found)", async () => {
  const db = await fixture();
  const client = createSqliteSqlClient(db);
  const ctxB = contextFor(client, "b");

  const result = await saveDividendAssumptionsGridWithContext(ctxB, "pa", {
    securities: [
      {
        portfolioSecurityId: "psa1", // owned by user a, not b
        dividendYieldPercentDecimal: "12",
        frankingPercentDecimal: "70",
        dividendGrowthPercentDecimal: null,
        forceAssumption: true,
        expectedVersion: null,
      },
    ],
    portfolio: {
      valueGrowthPercentDecimal: null,
      portfolioDividendGrowthPercentDecimal: null,
      expectedVersion: null,
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 404);

  // Nothing was created against user a's security by user b's attempt.
  const loaded = await loadOwnedDividendAssumptions(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(loaded.securities[0]!.version, null);
  assert.equal(loaded.securities[0]!.forceAssumption, false);
});

// ---------------------------------------------------------------------------
// d. End-to-end dormant disclosure (editor read service + assumption grid).
// ---------------------------------------------------------------------------

async function evidenceFixture(): Promise<DatabaseSync> {
  const db = await fixture();
  db.exec(`
    -- 12+ months of real evidence: an old row (>=365 days before TODAY,
    -- 2026-08-13) plus a recent row inside the trailing 365-day window.
    INSERT INTO dividend_manual_records(id,user_id,portfolio_id,portfolio_security_id,payment_date,shares_decimal,dividend_per_share_decimal,franking_credit_per_share_decimal,total_cash_decimal,total_franking_decimal,import_batch_id,created_at,updated_at,version) VALUES
      ('m-old','a','pa','psa1','2025-08-08',NULL,NULL,NULL,'100',NULL,'batch-a','2025-08-08','2025-08-08',1),
      ('m-recent','a','pa','psa1','2026-03-01',NULL,NULL,NULL,'150','64.29','batch-a','2026-03-01','2026-03-01',1);
    -- The owner's franking/yield assumption, set BEFORE 12 months of
    -- evidence existed -- now due to go dormant.
    INSERT INTO dividend_security_assumptions(id,user_id,portfolio_id,portfolio_security_id,dividend_yield_percent_decimal,franking_percent_decimal,dividend_growth_percent_decimal,force_assumption,created_at,updated_at,version) VALUES
      ('assump-1','a','pa','psa1','12','50',NULL,0,'2026-01-01','2026-01-01',1);
    INSERT INTO calculation_runs (id,user_id,portfolio_id,range_from,range_to,calculation_version,reason,ledger_high_water_start,ledger_high_water_end,idempotency_key,created_at,updated_at,status) VALUES
      ('run-a','a','pa','2026-08-13','2026-08-13',1,'test','1','1','run-a','2026-08-13','2026-08-13','completed');
    INSERT INTO projection_publications (user_id,portfolio_id,calculation_run_id,calculation_version,ledger_high_water,published_at) VALUES
      ('a','pa','run-a',1,'1','2026-08-13T01:00:00Z');
    INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at) VALUES
      ('projection-a','a','pa','psa1','100','500','500','5','complete','ready','1','run-a',1,'2026-08-13T01:00:00Z');
  `);
  return db;
}

test("DIV-016 part B: loadOwnedDividendAssumptions surfaces bridgeStatus 'dormant' (excluded but visible) once 12+ months of evidence exists, and 'forced' once force_assumption is set", async () => {
  const db = await evidenceFixture();
  const client = createSqliteSqlClient(db);

  const dormant = await loadOwnedDividendAssumptions(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );
  const dormantRow = dormant.securities[0]!;
  assert.equal(dormantRow.bridgeStatus, "dormant");
  assert.equal(dormantRow.forceAssumption, false);
  // The override is still shown, not deleted.
  assert.equal(dormantRow.ownerYieldPercentDecimal, "12");
  assert.equal(dormantRow.ownerFrankingPercentDecimal, "50");

  await client.run(
    `UPDATE dividend_security_assumptions SET force_assumption = 1 WHERE id = 'assump-1'`,
    [],
  );
  const forced = await loadOwnedDividendAssumptions(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );
  assert.equal(forced.securities[0]!.bridgeStatus, "forced");
});

test("DIV-016 part B: loadOwnedIncomeProjection's assumption grid excludes a dormant yield/franking override (falls through to the TTM/history leg) but a forced one still wins", async () => {
  const db = await evidenceFixture();
  const client = createSqliteSqlClient(db);

  const dormant = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );
  assert.equal(dormant.status, "ok");
  const dormantRow = dormant.assumptionGrid[0]!;
  // The 12%-owner-override is EXCLUDED -- the resolved yield source is the
  // TTM leg (history-derived, since there is no provider coverage), not
  // "owner_override".
  assert.notEqual(dormantRow.yield.source, "owner_override");
  assert.equal(dormantRow.yield.bridgeStatus, "dormant");
  assert.equal(dormantRow.franking.source, "none");
  assert.equal(dormantRow.franking.bridgeStatus, "dormant");

  await client.run(
    `UPDATE dividend_security_assumptions SET force_assumption = 1 WHERE portfolio_security_id = 'psa1'`,
    [],
  );
  const forced = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T08:00:00Z"),
  );
  assert.equal(forced.status, "ok");
  const forcedRow = forced.assumptionGrid[0]!;
  assert.equal(forcedRow.yield.source, "owner_override");
  assert.equal(forcedRow.yield.bridgeStatus, "forced");
  assert.equal(forcedRow.franking.source, "owner_override");
  assert.equal(forcedRow.franking.bridgeStatus, "forced");
});

// ---------------------------------------------------------------------------
// e. Force-toggle 44px touch target (QA-001B), matching the established
//    pin in tests/ui-006b.test.ts.
// ---------------------------------------------------------------------------

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `expected a "${selector}" rule in globals.css`);
  return match![1];
}

test("DIV-016 part B: the force-override checkbox meets the 44px touch-target minimum", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const block = extractBlock(styles, ".dividend-assumptions-force-label");
  assert.match(
    block,
    /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/,
    "the force-override label must declare min-height >= 44px",
  );
});
