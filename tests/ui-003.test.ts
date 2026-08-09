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
  assert.match(shell, /parseDecimalResult/);
  assert.match(shell, /native fallback/);
  assert.match(shell, /OwnedHoldingsScreen/);
  assert.match(shell, /<dialog[\s\S]*onCancel=/);
  assert.match(shell, /Display .* values in native or home currency/);
  assert.match(shell, /Price unavailable/);
  assert.match(shell, /Cash separate/);
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

test("UI-003 provider and supplied-direction mismatches invalidate movement", async () => {
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
  assert.equal(priceMismatch.rows[0]?.dailyMovement.status, "unavailable");
  assert.equal(priceMismatch.rows[0]?.actionStatus, "incomparable");
  priceDb.close();

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
  assert.match(shell, /openerRef/);
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
    INSERT INTO market_data_providers (id,code,name,capabilities_json,rate_limit_json) VALUES ('yahoo-compatible','yahoo','Yahoo','{}','{}');
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
