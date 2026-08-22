import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/sql-client.ts";
import { loadOwnedHoldings } from "../app/owned-holdings.ts";
import {
  sortOwnedHoldings,
  type OwnedHoldingRow,
} from "../app/owned-holdings-contract.ts";
import {
  resolveScopedSharesightInstrumentSecurities,
  upsertSharesightPriceObservations,
} from "../db/repositories/sharesight-price-refresh.ts";
import { buildSharesightPriceAccretionPlan } from "../domain/sharesight/index.ts";

function row(
  symbol: string,
  value: string | null,
  quantity = "1",
): OwnedHoldingRow {
  return {
    id: symbol,
    securityId: symbol,
    symbol,
    name: `${symbol} long security name`,
    exchange: "NYSE",
    currencyCode: "USD",
    quantity,
    averageNativeCost: "10.25",
    nativeBasis: {
      status: "available",
      currencyCode: "USD",
      value: "10",
      reason: null,
    },
    nativePrice: "12.50",
    nativeValue: {
      status: "available",
      currencyCode: "USD",
      value: "12.5",
      reason: null,
    },
    homePrice: {
      status: "available",
      currencyCode: "AUD",
      value: "18.75",
      reason: null,
    },
    homeValue: {
      status: value === null ? "unavailable" : "available",
      currencyCode: "AUD",
      value,
      reason: value === null ? "missing_fx" : null,
    },
    homeBasis: {
      status: "available",
      currencyCode: "AUD",
      value: "10",
      reason: null,
    },
    dailyMovement: {
      status: "available",
      currencyCode: "AUD",
      value: "0",
      reason: null,
    },
    unrealisedGain: {
      status: "available",
      currencyCode: "AUD",
      value: "0",
      reason: null,
    },
    dailyPercent: {
      status: "unavailable",
      currencyCode: "%",
      value: null,
      reason: "zero_previous_value",
    },
    unrealisedPercent: {
      status: "unavailable",
      currencyCode: "%",
      value: null,
      reason: "zero_basis",
    },
    dailyTone: "neutral",
    gainTone: "neutral",
    priceState: "current",
    actionStatus: "none",
    explanation: "Selected provider price with attributable FX.",
    sort: { ticker: symbol, value, daily: "0", gain: "0" },
  };
}

test("UI-003 sorting keeps missing values deterministic and exact zero sortable", () => {
  const rows = [row("ZERO", "0"), row("MISSING", null), row("HIGH", "100.01")];
  assert.deepEqual(
    sortOwnedHoldings(rows, "value", "ascending").map(({ symbol }) => symbol),
    ["ZERO", "HIGH", "MISSING"],
  );
  assert.deepEqual(
    sortOwnedHoldings(rows, "value", "descending").map(({ symbol }) => symbol),
    ["HIGH", "ZERO", "MISSING"],
  );
  assert.deepEqual(
    sortOwnedHoldings(rows, "ticker", "ascending").map(({ symbol }) => symbol),
    ["HIGH", "MISSING", "ZERO"],
  );
});

test("UI-003 sorting compares canonical trailing-zero and wide signed decimals", () => {
  const values = [
    row("ONE", "1.0000000000000000000000000001"),
    row("TEN", "10.0"),
    row("NEG", "-2.50"),
    row("NEG-TIE", "-2.5000"),
    row("SMALL", "0.00000000000000000000000000001"),
  ];
  assert.deepEqual(
    sortOwnedHoldings(values, "value", "ascending").map(({ symbol }) => symbol),
    ["NEG", "NEG-TIE", "SMALL", "ONE", "TEN"],
  );
  assert.deepEqual(
    sortOwnedHoldings(values, "value", "descending").map(
      ({ symbol }) => symbol,
    ),
    ["TEN", "ONE", "SMALL", "NEG", "NEG-TIE"],
  );
});

test("UI-003 source keeps authenticated holdings owner-scoped and responsive", async () => {
  const [loader, contract, shell, styles] = await Promise.all([
    readFile(new URL("../app/owned-holdings.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/owned-holdings-contract.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/portfolio-shell.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(loader, /pp\.user_id = \? AND pp\.portfolio_id = \?/);
  assert.match(loader, /WHERE user_id = \? AND portfolio_id = \?/);
  assert.match(loader, /listBoundedRelevant/);
  assert.match(loader, /MAX_SELECTION_LOOKBACK_DAYS/);
  assert.match(loader, /supplied rate unavailable/);
  assert.doesNotMatch(contract, /db\/repositories|node:crypto|SqlClient/);
  assert.doesNotMatch(shell, /parseDecimal\(/);
  assert.match(shell, /native fallback/);
  assert.match(shell, /OwnedHoldingsScreen/);
  // UI-029: legacy "Price unavailable" display strings were realigned to
  // AGENTS.md's "unavailable" wording; this pins the standalone-cell shape
  // rather than the retired literal.
  assert.match(shell, /unavailable \? "unavailable" :/);
  assert.match(shell, /Cash separate/);
  // UI-023: the decimal formatting and the per-holding currency-view select
  // moved out of the shell with the standalone detail screen -- the honest
  // parse path and the labelled select are pinned where they now live.
  const [format, detail] = await Promise.all([
    readFile(
      new URL("../app/owned-holding-format.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/holding-detail.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.doesNotMatch(format, /parseDecimal\(/);
  assert.match(format, /parseDecimalResult/);
  assert.match(detail, /Display .* values in native or home currency/);
  assert.match(styles, /\.holdings-grid\s*\{/);
  assert.match(styles, /\.holding-row\s*\{/);
});

test("UI-003 uses fixed-parameter relevant FX predicates and bounded aggregate overrides", async () => {
  const loader = await readFile(
    new URL("../app/owned-holdings.ts", import.meta.url),
    "utf8",
  );
  assert.match(loader, /fx\.quote_currency_code IN \(/);
  assert.match(loader, /status = 'held'/);
  assert.match(loader, /s\.primary_currency_code/);
  assert.doesNotMatch(
    loader,
    /SELECT source_currency_code FROM portfolio_securities/,
  );
  assert.match(loader, /status = 'active'/);
  assert.match(loader, /listBoundedRelevant/);
  assert.doesNotMatch(loader, /fxPairTerms|pairTerms/);
  assert.match(loader, /MAX_SELECTION_LOOKBACK_DAYS/);
  assert.ok((loader.match(/\?/g) ?? []).length > 0);
});

test("UI-003 preserves timestamp trade comparison and selection-class guards", async () => {
  const loader = await readFile(
    new URL("../app/owned-holdings.ts", import.meta.url),
    "utf8",
  );
  assert.match(loader, /tradeAt: requiredText\(row, "trade_at", ISO\)/);
  assert.match(loader, /trade\.tradeAt > previousObservedAt/);
  assert.match(loader, /trade\.tradeAt <= nowIso/);
  assert.match(loader, /priceClassComparable/);
  assert.match(loader, /fxClassComparable/);
  assert.match(loader, /previousSelection\.selected\?\.source/);
});

test("UI-003 marks a post-current observation trade incomparable through the cutoff", async () => {
  const db = await holdingsDatabase();
  db.exec(`
    INSERT INTO transactions (
      id, user_id, portfolio_id, portfolio_security_id, type, status,
      trade_at, local_trade_date, currency_code, source_type,
      created_by_user_id, calculation_version, created_at
    ) VALUES (
      'trade-after-current', 'owner-a', 'portfolio-a', 'holding-a', 'buy', 'posted',
      '2026-08-03T02:00:00Z', '2026-08-03', 'USD', 'manual',
      'owner-a', 1, '2026-08-03T02:00:00Z'
    );
  `);
  const result = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(result.rows[0]?.dailyMovement.status, "unavailable");
  assert.equal(result.rows[0]?.actionStatus, "incomparable");
  db.close();
});

test("UI-003 distinguishes a missing previous FX observation in compact status", async () => {
  const db = await holdingsDatabase();
  db.exec("DELETE FROM fx_rate_observations WHERE id = 'fx-prev';");
  const result = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(result.rows[0]?.dailyMovement.status, "unavailable");
  assert.equal(result.rows[0]?.actionStatus, "missing_previous");
  assert.match(result.rows[0]?.explanation ?? "", /previous FX unavailable/);
  db.close();
});

test("UI-003 keeps a Monday quote with Friday prior-session fallback comparable", async () => {
  const db = await holdingsDatabase();
  db.exec(`
    UPDATE price_observations SET market_date = '2026-07-31', observation_at = '2026-07-31T01:00:00Z', ingested_at = '2026-07-31T01:01:00Z' WHERE id = 'price-prev';
    UPDATE fx_rate_observations SET market_date = '2026-07-31', observed_at = '2026-07-31T01:00:00Z', ingested_at = '2026-07-31T01:01:00Z' WHERE id = 'fx-prev';
  `);
  const result = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(result.rows[0]?.dailyMovement.status, "available");
  assert.equal(result.rows[0]?.actionStatus, "none");
  assert.match(result.rows[0]?.explanation ?? "", /selector fallback/);
  db.close();
});

test("UI-003 keeps fixed SQL bind and query budgets observable at runtime", async () => {
  const db = await holdingsDatabase();
  const base = createSqliteSqlClient(db);
  let queryCount = 0;
  let maxParams = 0;
  const fxQueries: string[] = [];
  const client = {
    ...base,
    all: async <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      queryCount += 1;
      maxParams = Math.max(maxParams, params.length);
      if (sql.includes("fx_rate_observations")) fxQueries.push(sql);
      return base.all<T>(sql, params);
    },
    get: async <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      queryCount += 1;
      maxParams = Math.max(maxParams, params.length);
      if (sql.includes("fx_rate_observations")) fxQueries.push(sql);
      return base.get<T>(sql, params);
    },
  };
  await loadOwnedHoldings(
    client,
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.ok(queryCount < 40);
  assert.ok(maxParams <= 100);
  assert.ok(fxQueries.length >= 2 && fxQueries.length <= 4);
  assert.ok(
    fxQueries.every(
      (sql) =>
        sql.includes("primary_currency_code") || sql.includes("cash_accounts"),
    ),
  );
  db.close();
});

test("UI-003 makes interval and quality evidence mismatches incomparable", async () => {
  const db = await holdingsDatabase();
  db.exec(
    "UPDATE price_observations SET interval = 'delayed' WHERE id = 'price-prev'; UPDATE fx_rate_observations SET interval = 'delayed', quality = 'corrected' WHERE id = 'fx-prev';",
  );
  const result = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(result.rows[0]?.dailyMovement.status, "unavailable");
  assert.equal(result.rows[0]?.actionStatus, "incomparable");
  db.close();
});

test("UI-003 uses security primary currency rather than mutable source currency", async () => {
  const db = await holdingsDatabase();
  db.exec(
    "UPDATE portfolio_securities SET source_currency_code = 'AUD' WHERE id = 'holding-a';",
  );
  const result = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(result.rows[0]?.currencyCode, "USD");
  assert.equal(result.rows[0]?.homeValue.status, "available");
  db.close();
});

test("UI-003 rejects the aggregate override budget at the 2,001st materialized fact", async () => {
  const db = await holdingsDatabase();
  const currencyInsert = db.prepare(
    "INSERT INTO currencies (code,numeric_code,name,minor_unit_digits,is_active) VALUES (?, ?, ?, 2, 1)",
  );
  const accountInsert = db.prepare(
    "INSERT INTO cash_accounts (id,user_id,portfolio_id,currency_code,completeness,status) VALUES (?, 'owner-a', 'portfolio-a', ?, 'complete', 'active')",
  );
  const currencyCodes: string[] = [];
  for (let index = 0; index < 32; index += 1) {
    const code = `Y${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`;
    currencyCodes.push(code);
    currencyInsert.run(code, 2000 + index, `Override ${code}`);
    accountInsert.run(`override-cash-${index}`, code);
  }
  const targets = [
    "security-a",
    "AUD/USD",
    ...currencyCodes
      .map((code, index) => ({ code, index }))
      .sort((left, right) =>
        `override-cash-${left.index}`.localeCompare(
          `override-cash-${right.index}`,
        ),
      )
      .map(({ code }) => `AUD/${code}`),
  ];
  const insert = db.prepare(`
    INSERT INTO manual_overrides (
      id, user_id, portfolio_id, security_id, type, target_key,
      effective_from, value_json, reason, status, created_at
    ) VALUES (?, 'owner-a', 'portfolio-a', ?, 'fx_rate', ?, '2026-08-03', '{"rate":"2"}', 'test', 'active', ?)
  `);
  for (let index = 0; index < 2001; index += 1) {
    const target = index < 1920 ? targets[index % 32] : targets[32];
    insert.run(
      `override-${index}`,
      target === "security-a" ? "security-a" : null,
      target,
      `2026-08-03T00:00:${String(index % 60).padStart(2, "0")}Z`,
    );
  }
  const base = createSqliteSqlClient(db);
  let queryCount = 0;
  let materialized = 0;
  const overrideParamCounts: number[] = [];
  const overrideLimits: number[] = [];
  const overrideRows: number[] = [];
  const client = {
    ...base,
    all: async <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      queryCount += 1;
      const rows = await base.all<T>(sql, params);
      if (sql.includes("manual_overrides")) {
        materialized += rows.length;
        overrideRows.push(rows.length);
        overrideParamCounts.push(params.length);
        overrideLimits.push(Number(params.at(-1)));
      }
      return rows;
    },
    get: async <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      queryCount += 1;
      return base.get<T>(sql, params);
    },
  };
  await assert.rejects(
    () =>
      loadOwnedHoldings(
        client,
        "owner-a",
        "portfolio-a",
        new Date("2026-08-03T08:00:00Z"),
      ),
    /too_many_overrides/,
  );
  assert.equal(materialized, 2001);
  assert.deepEqual(overrideRows, [1920, 81]);
  assert.equal(overrideParamCounts.length, 2);
  assert.deepEqual(overrideParamCounts, [34, 4]);
  assert.deepEqual(overrideLimits, [2001, 81]);
  assert.ok(queryCount < 20);
  db.close();
});

test("UI-003 identity FX remains non-inverted and fallback provenance is actionable", async () => {
  const identityDb = await holdingsDatabase();
  identityDb.exec(
    "UPDATE portfolios SET base_currency_code = 'USD' WHERE id = 'portfolio-a';",
  );
  const identity = await loadOwnedHoldings(
    createSqliteSqlClient(identityDb),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.match(identity.rows[0]?.explanation ?? "", /inverted false/);
  identityDb.close();

  const fallbackDb = await holdingsDatabase();
  fallbackDb.exec(
    "UPDATE price_observations SET market_date = '2026-07-31', observation_at = '2026-07-31T01:00:00Z', ingested_at = '2026-07-31T01:01:00Z' WHERE id = 'price-prev'; UPDATE fx_rate_observations SET market_date = '2026-07-30', observed_at = '2026-07-30T01:00:00Z', ingested_at = '2026-07-30T01:01:00Z' WHERE id = 'fx-prev';",
  );
  const fallback = await loadOwnedHoldings(
    createSqliteSqlClient(fallbackDb),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.match(
    fallback.rows[0]?.explanation ?? "",
    /previous FX.*selector fallback.*actionability explanation/,
  );
  fallbackDb.close();
});

test("MKT-016: a cross-provider EOD-vs-EOD previous close is now an acceptable baseline (owner ruling, 2026-08-22) -- FX mismatch is still refused, unchanged", async () => {
  const priceDb = await holdingsDatabase();
  priceDb.exec(
    "INSERT INTO market_data_providers (id,code,name,status,capabilities_json,rate_limit_json) VALUES ('other-provider','other','Other','enabled','{}','{}'); INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES ('mapping-other','security-a','other-provider','NYSE','AAA','2026-01-01','verified'); UPDATE price_observations SET provider_id = 'other-provider', mapping_id = 'mapping-other' WHERE id = 'price-prev';",
  );
  const priceMismatch = await loadOwnedHoldings(
    createSqliteSqlClient(priceDb),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  // Both days are `eod`-class (today: yahoo-compatible close 8; yesterday:
  // now re-attributed to a different provider/mapping, close 7 unchanged)
  // -- previously refused as a provider mismatch, now allowed because the
  // owner ruling makes ANY previous-day eod close an acceptable baseline,
  // regardless of provider. Exact fixture math: quantity 2, native
  // movement = 2*(8-7) = 2, home movement = 2/2 (AUD/USD=2 both days) = 1;
  // previous home value = 2*7/2 = 7, so percent = 1/7*100 = 14.2857...%,
  // half-even rounded to 14.29.
  assert.equal(priceMismatch.rows[0]?.dailyMovement.status, "available");
  assert.equal(priceMismatch.rows[0]?.dailyMovement.value, "1");
  assert.equal(priceMismatch.rows[0]?.dailyMovement.reason, null);
  assert.equal(priceMismatch.rows[0]?.dailyPercent.status, "available");
  assert.equal(priceMismatch.rows[0]?.dailyPercent.value, "14.29");
  assert.equal(priceMismatch.rows[0]?.actionStatus, "none");
  priceDb.close();

  // FX comparability rules are UNCHANGED by MKT-016 -- a previous-day FX
  // direction/rate mismatch still refuses the movement outright, even
  // though the price side above is now comparable.
  const fxDb = await holdingsDatabase();
  fxDb.exec(
    "UPDATE fx_rate_observations SET base_currency_code = 'USD', quote_currency_code = 'AUD', rate_decimal = '0.5' WHERE id = 'fx-prev';",
  );
  const fxMismatch = await loadOwnedHoldings(
    createSqliteSqlClient(fxDb),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(fxMismatch.rows[0]?.dailyMovement.status, "unavailable");
  assert.equal(fxMismatch.rows[0]?.actionStatus, "incomparable");
  fxDb.close();
});

test("MKT-016: cross-provider delayed-vs-delayed is still refused -- neither side is a settled closing price", async () => {
  const db = await holdingsDatabase();
  // Remove the base fixture's yahoo-compatible eod rows for security-a so
  // only the two delayed observations below compete for selection.
  db.exec("DELETE FROM price_observations WHERE security_id = 'security-a';");
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'NYSE', 'AAA', '2026-01-01', 'candidate');
    INSERT INTO market_data_providers (id,code,name,status,capabilities_json,rate_limit_json)
      VALUES ('other-provider','other','Other','enabled','{}','{}');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-other-delayed', 'security-a', 'other-provider', 'NYSE', 'AAA', '2026-01-01', 'verified');
    -- Today: Sharesight-delayed. Yesterday: a DIFFERENT provider's delayed
    -- feed (not eod) -- neither side is a settled close, so the relaxed
    -- eod-baseline branch never applies and the strict same-provider rule
    -- still refuses this pairing.
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at)
    VALUES
      ('price-sharesight-a','sharesight','user','owner-a','owner-a','mapping-sharesight-a','security-a','delayed','2026-08-03T05:00:00.000Z','2026-08-03','+10:00','USD','5000','4999','raw','observed','2026-08-03T05:01:00.000Z'),
      ('price-other-delayed-prev','other-provider','deployment',NULL,'deployment','mapping-other-delayed','security-a','delayed','2026-08-02T05:00:00.000Z','2026-08-02','+10:00','USD','4900','4800','raw','observed','2026-08-02T05:01:00.000Z');
  `);
  const result = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(result.rows[0]?.dailyMovement.status, "unavailable");
  assert.equal(result.rows[0]?.dailyMovement.reason, "price_basis_changed");
  assert.equal(result.rows[0]?.dailyPercent.status, "unavailable");
  assert.equal(result.rows[0]?.dailyPercent.reason, "price_basis_changed");
  assert.equal(result.rows[0]?.actionStatus, "incomparable");
  db.close();
});

test("MKT-016: FMG shape -- Sharesight-delayed today (17.75) vs owner-import EOD close yesterday (17.95) yields an exact -0.20 change, percent half-even rounded", async () => {
  const db = await holdingsDatabase();
  // Mirrors the owner's real data shape named in the ruling: same-currency
  // portfolio (identity FX, no conversion distortion) and quantity 1, so
  // the home-currency daily movement equals the raw native price delta.
  db.exec(
    "UPDATE portfolios SET base_currency_code = 'USD' WHERE id = 'portfolio-a'; UPDATE holding_projections SET quantity_decimal = '1'; DELETE FROM price_observations WHERE security_id = 'security-a';",
  );
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-fmg', 'security-a', 'sharesight', 'NYSE', 'AAA', '2026-01-01', 'candidate');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-owner-import-fmg', 'security-a', 'owner-import', 'NYSE', 'AAA', '2026-01-01', 'verified');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at)
    VALUES
      ('price-sharesight-fmg-today','sharesight','user','owner-a','owner-a','mapping-sharesight-fmg','security-a','delayed','2026-08-03T05:00:00.000Z','2026-08-03','+10:00','USD','17.75',NULL,'raw','observed','2026-08-03T05:01:00.000Z'),
      ('price-owner-import-fmg-prev','owner-import','user','owner-a','owner-a','mapping-owner-import-fmg','security-a','eod','2026-08-02T00:00:00.000Z','2026-08-02','+10:00','USD','17.95',NULL,'raw','observed','2026-08-02T01:00:00.000Z');
  `);
  const result = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(result.rows[0]?.nativePrice, "17.75");
  // Native movement = quantity 1 * (17.75 - 17.95) = -0.20 exactly; identity
  // FX (same currency) means the home-currency movement is the same value.
  assert.equal(result.rows[0]?.dailyMovement.status, "available");
  assert.equal(result.rows[0]?.dailyMovement.value, "-0.2");
  assert.equal(result.rows[0]?.dailyMovement.reason, null);
  // Percent = -0.20 / 17.95 * 100 = -1.11420613...%, half-even rounded to
  // -1.11 (the third decimal, 4, rounds down).
  assert.equal(result.rows[0]?.dailyPercent.status, "available");
  assert.equal(result.rows[0]?.dailyPercent.value, "-1.11");
  assert.equal(result.rows[0]?.dailyPercent.reason, null);
  assert.equal(result.rows[0]?.actionStatus, "none");
  db.close();
});

test("UI-003 maximum cash cardinality stays inside fixed bind and query budgets", async () => {
  const db = await holdingsDatabase();
  db.exec(
    "UPDATE portfolio_securities SET status = 'hidden' WHERE id = 'holding-a';",
  );
  const currencyInsert = db.prepare(
    "INSERT INTO currencies (code,numeric_code,name,minor_unit_digits,is_active) VALUES (?, ?, ?, 2, 1)",
  );
  const accountInsert = db.prepare(
    "INSERT INTO cash_accounts (id,user_id,portfolio_id,currency_code,completeness,status) VALUES (?, 'owner-a', 'portfolio-a', ?, 'complete', 'active')",
  );
  for (let index = 0; index < 100; index += 1) {
    const code = `X${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`;
    currencyInsert.run(code, 1000 + index, `Test ${code}`);
    accountInsert.run(`cash-${index}`, code);
  }
  const base = createSqliteSqlClient(db);
  let queryCount = 0;
  let maxParams = 0;
  const client = {
    ...base,
    all: async <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      queryCount += 1;
      maxParams = Math.max(maxParams, params.length);
      return base.all<T>(sql, params);
    },
    get: async <T extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      queryCount += 1;
      maxParams = Math.max(maxParams, params.length);
      return base.get<T>(sql, params);
    },
  };
  const result = await loadOwnedHoldings(
    client,
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(result.cash.coverage.total, 100);
  assert.equal(result.cash.cashSubtotal, "0");
  assert.ok(maxParams <= 100);
  assert.ok(queryCount < 20);
  db.close();
});

test("UI-003 exposes provenance inversion and stable action statuses", async () => {
  const [loader, shell] = await Promise.all([
    readFile(new URL("../app/owned-holdings.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/components/portfolio-shell.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(loader, /requested native→home/);
  assert.match(loader, /inverted/);
  assert.match(loader, /actionability/);
  assert.match(loader, /missing_previous/);
  assert.match(loader, /incomparable/);
  assert.match(shell, /Action required:/);
  assert.doesNotMatch(shell, /actionRequired/);
});

test("UI-003 malformed and wide display values remain nonthrowing at client boundaries", () => {
  const malformed = row("MALFORMED", "not-a-decimal");
  assert.doesNotThrow(() =>
    sortOwnedHoldings([malformed], "value", "ascending"),
  );
  const wide = row(
    "WIDE",
    "999999999999999999999999999999999999.12345678901234567890",
  );
  assert.doesNotThrow(() =>
    sortOwnedHoldings([wide, malformed], "value", "descending"),
  );
});

test("UI-003 narrow layout and dialog semantics retain overflow and keyboard hooks", async () => {
  const [shell, styles] = await Promise.all([
    readFile(
      new URL("../app/components/portfolio-shell.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(shell, /showModal\(\)/);
  assert.match(shell, /onCancel=/);
  // UI-023: the owned holding sheet (and its lowercase `openerRef`) is
  // gone -- rows link to the standalone detail route instead. The shell's
  // remaining dialogs keep the opener-restore pattern under their own refs.
  assert.match(shell, /OpenerRef/);
  assert.match(styles, /\.row-secondary[\s\S]*overflow: hidden/);
  assert.match(styles, /max-width: 350px/);
  assert.match(styles, /text-overflow: ellipsis/);
});

async function holdingsDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active) VALUES ('AUD',36,'Australian dollar',2,1),('USD',840,'US dollar',2,1);
    INSERT INTO users (id,status,primary_email,timezone,created_at,updated_at,version) VALUES ('owner-a','active','a@example.com','Australia/Sydney','2026-08-03','2026-08-03',1),('owner-b','active','b@example.com','Australia/Sydney','2026-08-03','2026-08-03',1);
    INSERT INTO portfolios (id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at,version) VALUES ('portfolio-a','owner-a','A','A','AUD','Australia/Sydney','fifo','active','2026-08-03','2026-08-03',1),('portfolio-b','owner-b','B','B','AUD','Australia/Sydney','fifo','active','2026-08-03','2026-08-03',1);
    -- market_data_providers' 'yahoo-compatible' row is no longer seeded
    -- here: MKT-007's drizzle/0037_steady_signal.sql migration now ships it
    -- as reference data, so the full migration chain applied above already
    -- produced it.
    INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES ('nyse','XNYS','New York Stock Exchange','US','America/New_York','XNYS');
    INSERT INTO securities (id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES ('security-a','equity','nyse','USD','Long Foreign Security','2026-08-03','2026-08-03');
    INSERT INTO security_provider_mappings (id,security_id,provider_id,provider_exchange,provider_symbol,valid_from,status) VALUES ('mapping-a','security-a','yahoo-compatible','NYSE','AAA','2026-01-01','verified');
    INSERT INTO portfolio_securities (id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,display_symbol,status,created_at,updated_at) VALUES ('holding-a','owner-a','portfolio-a','security-a','AAA','USD','AAA','held','2026-08-03','2026-08-03');
    INSERT INTO calculation_runs (id,user_id,portfolio_id,range_from,range_to,calculation_version,reason,ledger_high_water_start,ledger_high_water_end,idempotency_key,created_at,updated_at,status) VALUES ('run-a','owner-a','portfolio-a','2026-08-03','2026-08-03',1,'test','1','1','run-a','2026-08-03','2026-08-03','completed');
    INSERT INTO projection_publications (user_id,portfolio_id,calculation_run_id,calculation_version,ledger_high_water,published_at) VALUES ('owner-a','portfolio-a','run-a',1,'1','2026-08-03T01:00:00Z');
    INSERT INTO holding_projections (id,user_id,portfolio_id,portfolio_security_id,quantity_decimal,native_open_basis_decimal,base_open_basis_decimal,average_base_cost_decimal,completeness,status,last_ledger_high_water,calculation_run_id,calculation_version,rebuilt_at) VALUES ('projection-a','owner-a','portfolio-a','holding-a','2','10','15','7.5','complete','ready','1','run-a',1,'2026-08-03T01:00:00Z');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at) VALUES ('price-a','yahoo-compatible','deployment',NULL,'deployment','mapping-a','security-a','eod','2026-08-03T01:00:00Z','2026-08-03','America/New_York','USD','8','7','raw','observed','2026-08-03T01:01:00Z');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at) VALUES ('price-prev','yahoo-compatible','deployment',NULL,'deployment','mapping-a','security-a','eod','2026-08-02T01:00:00Z','2026-08-02','America/New_York','USD','7','6','raw','observed','2026-08-02T01:01:00Z');
    INSERT INTO fx_rate_observations (id,provider_id,access_scope,scope_user_id,scope_key,base_currency_code,quote_currency_code,rate_decimal,interval,observed_at,market_date,quality,ingested_at) VALUES ('fx-a','yahoo-compatible','deployment',NULL,'deployment','AUD','USD','2','eod','2026-08-03T01:00:00Z','2026-08-03','observed','2026-08-03T01:01:00Z');
    INSERT INTO fx_rate_observations (id,provider_id,access_scope,scope_user_id,scope_key,base_currency_code,quote_currency_code,rate_decimal,interval,observed_at,market_date,quality,ingested_at) VALUES ('fx-prev','yahoo-compatible','deployment',NULL,'deployment','AUD','USD','2','eod','2026-08-02T01:00:00Z','2026-08-02','observed','2026-08-02T01:01:00Z');
  `);
  return db;
}

test("UI-003 loads a published owner projection with inverse-safe FX and denies cross-owner access", async () => {
  const db = await holdingsDatabase();
  const first = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(first.status, "complete");
  assert.equal(first.rows[0]?.homeValue.value, "8");
  assert.equal(first.rows[0]?.dailyMovement.value, "1");
  assert.equal(first.cash.cashSubtotal, null);
  assert.equal(first.cash.knownTotal, "8");
  await assert.rejects(
    () =>
      loadOwnedHoldings(
        createSqliteSqlClient(db),
        "owner-b",
        "portfolio-a",
        new Date("2026-08-03T08:00:00Z"),
      ),
    /not_owned|missing_projection_publication/,
  );
  db.close();
});

test("UI-003 treats a held security without a matching published projection as unavailable", async () => {
  const db = await holdingsDatabase();
  db.exec("DELETE FROM holding_projections;");
  await assert.rejects(
    () =>
      loadOwnedHoldings(
        createSqliteSqlClient(db),
        "owner-a",
        "portfolio-a",
        new Date("2026-08-03T08:00:00Z"),
      ),
    /invalid_projection_count/,
  );
  db.close();
});

test("UI-003 preserves exact zero without requiring price or FX and keeps missing basis explicit", async () => {
  const db = await holdingsDatabase();
  db.exec(
    "UPDATE holding_projections SET quantity_decimal = '0', native_open_basis_decimal = NULL, base_open_basis_decimal = NULL; DELETE FROM price_observations; DELETE FROM fx_rate_observations;",
  );
  const zero = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(zero.rows[0]?.nativeValue.value, "0");
  assert.equal(zero.rows[0]?.homeValue.value, "0");
  assert.equal(zero.rows[0]?.averageNativeCost, null);
  assert.equal(zero.rows[0]?.homeBasis.status, "unavailable");
  db.close();
});

test("UI-003 marks a missing price as partial without turning it into zero", async () => {
  const db = await holdingsDatabase();
  db.exec("DELETE FROM price_observations;");
  const partial = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(partial.status, "partial");
  assert.equal(partial.rows[0]?.nativeValue.status, "unavailable");
  assert.equal(partial.rows[0]?.nativeValue.reason, "missing_price");
  db.close();
});

test("UI-003 renders cash-only portfolios as cash summary rather than an empty securities state", async () => {
  const db = await holdingsDatabase();
  db.exec(
    "UPDATE portfolio_securities SET status = 'hidden'; INSERT INTO cash_accounts (id,user_id,portfolio_id,currency_code,completeness,status) VALUES ('cash-a','owner-a','portfolio-a','AUD','complete','active'); INSERT INTO cash_ledger_entries (id,user_id,portfolio_id,cash_account_id,effective_at,local_effective_date,type,signed_amount_decimal,status,created_at) VALUES ('cash-entry-a','owner-a','portfolio-a','cash-a','2026-08-03T01:00:00Z','2026-08-03','opening_balance','25','posted','2026-08-03T01:00:00Z');",
  );
  const cashOnly = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(cashOnly.rows.length, 0);
  assert.equal(cashOnly.cash.cashSubtotal, "25");
  assert.equal(cashOnly.status, "complete");
  db.close();
});

// ---------------------------------------------------------------------------
// BRK-012B review B1/B3 regression: a Sharesight-sourced price_observations
// row must never blank or displace the holdings view for THIS storage-only
// slice. Reviewer drill (B1 severe): the FIRST hourly write, before the
// fix, stored `observation_at` with Sharesight's raw `+10:00` offset
// intact -- `mapPrice`'s `ISO` regex (Z-only) then failed closed on that
// row, and the failure was swallowed by the caller's `catch` into a blanked
// "unavailable" holdings view. Both parts of the fix are drilled here: (a)
// `observation_at` is now normalized to UTC `Z` at write time, and (b) a
// Sharesight row is explicitly excluded from selection regardless.
// ---------------------------------------------------------------------------

test("BRK-012B x UI-003 regression (B1 drill): a REAL Sharesight accretion write (raw +10:00 timestamp, through the actual production pipeline) leaves the owner's holdings view completely intact", async () => {
  const db = await holdingsDatabase();
  db.exec(`
    INSERT INTO security_identifiers (id, security_id, scheme, value, valid_from, valid_to, source)
    VALUES ('ident-sharesight-a', 'security-a', 'sharesight_instrument', '101', '2026-08-03', NULL, 'sharesight');
  `);
  const client = createSqliteSqlClient(db);

  // The exact production pipeline: resolve scope -> build the accretion
  // plan from a raw Sharesight instrument (offset timestamp, unconverted)
  // -> upsert. Nothing here is a shortcut/mock of the real write path.
  const scopeMap = await resolveScopedSharesightInstrumentSecurities(
    client,
    "owner-a",
  );
  const plan = buildSharesightPriceAccretionPlan(
    [
      {
        id: "101",
        code: "AAA",
        marketCode: "NYSE",
        currencyCode: "USD",
        currentPriceDecimal: "9.99",
        // Raw Sharesight offset timestamp -- the exact shape that blanked
        // the holdings view before this fix.
        currentPriceUpdatedAt: "2026-08-03T16:10:03+10:00",
      },
    ],
    scopeMap,
  );
  assert.equal(plan.matchedCount, 1);
  await upsertSharesightPriceObservations(client, {
    userId: "owner-a",
    candidates: plan.candidates,
    now: "2026-08-03T17:00:00.000Z",
  });

  // Confirm the write actually landed with a Z-suffixed observation_at
  // (B1(a)) -- proves the fix's storage side, not just its read-side
  // exclusion.
  const written = db
    .prepare(
      `SELECT observation_at FROM price_observations WHERE provider_id = 'sharesight'`,
    )
    .get() as { observation_at: string };
  assert.match(written.observation_at, /Z$/);
  assert.equal(written.observation_at, "2026-08-03T06:10:03.000Z");

  // The B1 drill itself: the holdings view must be completely unaffected --
  // not blanked, not thrown, not silently degraded -- exactly the baseline
  // `holdingsDatabase()` fixture's own established result.
  const result = await loadOwnedHoldings(
    client,
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(result.status, "complete");
  assert.equal(result.rows[0]?.homeValue.status, "available");
  assert.equal(result.rows[0]?.homeValue.value, "8");
  assert.equal(result.rows[0]?.dailyMovement.value, "1");
  db.close();
});

test("BRK-012C x UI-003 x MKT-016: a user-scoped Sharesight observation on the SAME market date as the deployment-scoped Yahoo one is now selected (exclusion lifted), and its day change vs the prior day's EOD close now computes for real", async () => {
  const db = await holdingsDatabase();
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'NYSE', 'AAA', '2026-01-01', 'candidate');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at)
    VALUES ('price-sharesight-a','sharesight','user','owner-a','owner-a','mapping-sharesight-a','security-a','delayed','2026-08-03T05:00:00.000Z','2026-08-03','+10:00','USD','5000','4999','raw','observed','2026-08-03T05:01:00.000Z');
  `);
  const result = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  // BRK-012C deliberately lifted the `provider_id <> 'sharesight'`
  // exclusion for current-holding selection: this owner-scoped Sharesight
  // observation (same market_date, delayed interval) is now a legitimate
  // selection candidate and wins -- `choosePrice`'s user-vs-deployment merge
  // prefers the user-scoped observation whenever its market date is at
  // least as recent as the deployment-scoped one, so the '5000' close
  // (not Yahoo's '8') feeds nativeValue/homeValue, labelled honestly as
  // delayed in the explanation text.
  assert.equal(result.rows[0]?.nativePrice, "5000");
  assert.equal(result.rows[0]?.nativeValue.value, "10000");
  assert.equal(result.rows[0]?.homeValue.value, "5000");
  assert.match(result.rows[0]?.explanation ?? "", /Delayed \(Sharesight\)/);
  assert.doesNotMatch(result.rows[0]?.explanation ?? "", /\blive\b/i);
  // BRK-012C review round (B3, HISTORY -- superseded by MKT-016 below):
  // today's price is Sharesight-delayed, yesterday's (price-prev) is
  // Yahoo-compatible EOD -- this was originally treated as a genuine
  // cross-basis mismatch, refused with the honest, distinct
  // `price_basis_changed` reason (never the generic `missing_previous_fx`
  // that would falsely imply the previous price/FX itself is missing --
  // it is not: both days' prices are known, only their bases differ).
  //
  // MKT-016 (owner ruling, 2026-08-22, verbatim: "This is actually fine,
  // the historical prices are closing prices. And if they are wrong it is
  // a minor and temporary issue."): this exact pairing -- Sharesight-
  // delayed today vs a previous-day `eod` close from ANY provider -- is
  // now an acceptable baseline, so the movement computes for real. Exact
  // fixture math: quantity 2, native movement = 2*(5000-7) = 9986, home
  // movement = 9986/2 (AUD/USD=2 both days) = 4993; previous home value =
  // 2*7/2 = 7, so percent = 4993/7*100 = 71328.5714...%, half-even rounded
  // to 71328.57.
  assert.equal(result.rows[0]?.dailyMovement.status, "available");
  assert.equal(result.rows[0]?.dailyMovement.value, "4993");
  assert.equal(result.rows[0]?.dailyMovement.reason, null);
  assert.equal(result.rows[0]?.dailyPercent.status, "available");
  assert.equal(result.rows[0]?.dailyPercent.value, "71328.57");
  assert.equal(result.rows[0]?.dailyPercent.reason, null);
  assert.equal(result.rows[0]?.actionStatus, "none");
  db.close();
});

test("BRK-012C review round (B3): the baseline pure-Yahoo case is unaffected -- daily movement stays a real, comparable value", async () => {
  const db = await holdingsDatabase();
  const result = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  // Restores/confirms the pre-existing baseline this review round must not
  // regress: no Sharesight data at all, both days Yahoo-compatible EOD --
  // priceClassComparable is true, the real movement computes normally.
  assert.equal(result.rows[0]?.dailyMovement.status, "available");
  assert.equal(result.rows[0]?.dailyMovement.value, "1");
  assert.equal(result.rows[0]?.dailyMovement.reason, null);
  db.close();
});

test("BRK-012C review round (B3): movement self-heals once Sharesight has accreted a SECOND daily observation -- day-2 sharesight-vs-sharesight movement computes for real", async () => {
  const db = await holdingsDatabase();
  db.exec(`
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
      VALUES ('mapping-sharesight-a', 'security-a', 'sharesight', 'NYSE', 'AAA', '2026-01-01', 'candidate');
    INSERT INTO price_observations (id,provider_id,access_scope,scope_user_id,scope_key,mapping_id,security_id,interval,observation_at,market_date,market_timezone,currency_code,close_decimal,previous_close_decimal,adjustment_state,quality,ingested_at)
    VALUES
      ('price-sharesight-day1','sharesight','user','owner-a','owner-a','mapping-sharesight-a','security-a','delayed','2026-08-03T05:00:00.000Z','2026-08-03','+10:00','USD','5000','4999','raw','observed','2026-08-03T05:01:00.000Z'),
      ('price-sharesight-day2','sharesight','user','owner-a','owner-a','mapping-sharesight-a','security-a','delayed','2026-08-04T05:00:00.000Z','2026-08-04','+10:00','USD','5200','5000','raw','observed','2026-08-04T05:01:00.000Z');
  `);
  const result = await loadOwnedHoldings(
    createSqliteSqlClient(db),
    "owner-a",
    "portfolio-a",
    new Date("2026-08-04T08:00:00Z"),
  );
  // Both today (08-04) and yesterday (08-03) now select a Sharesight-
  // delayed observation from the SAME mapping -- priceClassComparable is
  // true again, purely because both days share the same selection class,
  // no new code path. The movement is a REAL computed value, not the
  // day-1 basis-changed placeholder.
  assert.equal(result.rows[0]?.nativePrice, "5200");
  assert.equal(result.rows[0]?.dailyMovement.status, "available");
  assert.notEqual(result.rows[0]?.dailyMovement.reason, "price_basis_changed");
  assert.equal(result.rows[0]?.dailyPercent.status, "available");
  db.close();
});
