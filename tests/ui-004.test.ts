import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/sql-client.ts";
import {
  requestMarketDataRefreshForContext,
  saveManualOverrideForContext,
} from "../app/market-data-actions.ts";
import { loadOwnedQuotes } from "../app/owned-quotes.ts";
import {
  quoteDisplayState,
  quoteExplanation,
  type QuoteRow,
} from "../app/quote-contract.ts";
import { POST as refreshPost } from "../app/api/market-data/refresh/route.ts";
import {
  DELETE as overrideDelete,
  POST as overridePost,
} from "../app/api/market-data/overrides/route.ts";

async function database(): Promise<DatabaseSync> {
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
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    -- market_data_providers' 'yahoo-compatible' row is no longer seeded
    -- here: MKT-007's drizzle/0037_steady_signal.sql migration now ships it
    -- as reference data, so the full migration chain applied above already
    -- produced it.
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, created_at, updated_at)
    VALUES ('security-a', 'equity', 'AUD', 'Security A', '2026-08-03', '2026-08-03'),
           ('security-b', 'equity', 'USD', 'Security B', '2026-08-03', '2026-08-03');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
    VALUES ('mapping-a', 'security-a', 'yahoo-compatible', 'ASX', 'AAA.AX', '2026-01-01', 'verified'),
           ('mapping-b', 'security-b', 'yahoo-compatible', 'NYSE', 'BBB', '2026-01-01', 'verified');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, display_symbol, status, created_at, updated_at)
    VALUES ('holding-a', 'user-a', 'portfolio-a', 'security-a', 'AAA', 'AUD', 'AAA', 'held', '2026-08-03', '2026-08-03'),
           ('holding-b', 'user-a', 'portfolio-a', 'security-b', 'BBB', 'USD', 'BBB', 'watch', '2026-08-03', '2026-08-03');
    INSERT INTO price_observations (
      id, provider_id, access_scope, scope_user_id, scope_key, mapping_id,
      security_id, interval, observation_at, market_date, market_timezone,
      currency_code, close_decimal, previous_close_decimal, adjustment_state,
      quality, delayed_minutes, ingested_at
    ) VALUES (
      'price-a', 'yahoo-compatible', 'deployment', NULL, 'deployment',
      'mapping-a', 'security-a', 'delayed', '2026-08-03T05:00:00Z',
      '2026-08-03', 'Australia/Sydney', 'AUD', '42.10', '41.90', 'raw',
      'observed', 20, '2026-08-03T05:01:00Z'
    );
  `);
  return db;
}

function quote(state: QuoteRow["state"]): QuoteRow {
  return {
    targetKey: "security-a",
    portfolioSecurityId: "holding-a",
    securityId: "security-a",
    symbol: "AAA",
    name: "Security A",
    currencyCode: "AUD",
    price: "AUD 42.10",
    change: "+0.20",
    percent: "+0.48%",
    tone: "positive",
    marketDate: "2026-08-03",
    state,
    provenance: {
      source: "provider",
      providerId: "yahoo-compatible",
      observationAt: "2026-08-03T05:00:00Z",
      delayedMinutes: 20,
      scope: "deployment",
      quality: "observed",
      fallbackReason: "Best validated observation selected.",
    },
    sort: { ticker: "AAA", price: "4210", change: "20" },
  };
}

test("quote state is row-owned and explanations contain full provenance", () => {
  assert.equal(quoteDisplayState("current", true), "current");
  assert.equal(quoteDisplayState("stale", true), "stale");
  assert.equal(quoteDisplayState("current", false), "unavailable");
  const explanation = quoteExplanation(quote("fallback"));
  assert.match(explanation, /provider yahoo-compatible/i);
  assert.match(explanation, /2026-08-03T05:00:00Z/);
  assert.match(explanation, /20 minute delay/);
  assert.match(explanation, /scope: deployment/);
  assert.match(explanation, /quality: observed/);
  assert.match(explanation, /fallback: Best validated observation selected/);
});

test("owner quote loader returns selected data and stable per-target gaps", async () => {
  const db = await database();
  const rows = await loadOwnedQuotes(
    createSqliteSqlClient(db),
    "user-a",
    "portfolio-a",
    new Date("2026-08-03T08:00:00Z"),
  );
  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((row) => row.securityId === "security-a")?.price,
    "AUD 42.10",
  );
  assert.equal(
    rows.find((row) => row.securityId === "security-a")?.state,
    "current",
  );
  assert.equal(
    rows.find((row) => row.securityId === "security-b")?.state,
    "unavailable",
  );
  assert.equal(
    [...rows].sort((left, right) => right.symbol.localeCompare(left.symbol))[0]
      ?.state,
    "unavailable",
  );
  db.close();
});

test("market-data mutation endpoints reject cross-site browser requests", async () => {
  for (const handler of [refreshPost, overridePost, overrideDelete]) {
    const response = await handler(
      new Request("https://yieldtome.example/api/market-data/test", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Cross-site mutation/i);
  }
});

test("refresh ranges are bounded, concurrent requests coalesce, and completion cools down", async () => {
  const db = await database();
  const client = createSqliteSqlClient(db);
  const context = { client, userId: "user-a", requestId: "request-a" };
  const now = new Date("2026-08-03T08:00:00Z");
  const unbounded = await requestMarketDataRefreshForContext(
    context,
    {
      portfolioId: "portfolio-a",
      rangeFrom: "2026-01-01",
      rangeTo: "2026-08-03",
    },
    now,
  );
  assert.equal(unbounded.ok, false);
  if (!unbounded.ok) assert.equal(unbounded.status, 400);

  const [left, right] = await Promise.all([
    requestMarketDataRefreshForContext(
      context,
      { portfolioId: "portfolio-a", portfolioSecurityId: "holding-a" },
      now,
    ),
    requestMarketDataRefreshForContext(
      context,
      { portfolioId: "portfolio-a", portfolioSecurityId: "holding-a" },
      now,
    ),
  ]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (left.ok && right.ok) assert.equal(left.jobs[0]?.id, right.jobs[0]?.id);
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM market_data_refresh_jobs")
    .get() as { count: number };
  assert.equal(count.count, 1);
  db.prepare(
    "UPDATE market_data_refresh_jobs SET status = 'completed', completed_at = ?",
  ).run(now.toISOString());
  const cooled = await requestMarketDataRefreshForContext(
    context,
    { portfolioId: "portfolio-a", portfolioSecurityId: "holding-a" },
    now,
  );
  assert.equal(cooled.ok, false);
  if (!cooled.ok) assert.equal(cooled.status, 429);
  db.close();
});

test("corrections require owner portfolio durable targets and canonical currencies", async () => {
  const db = await database();
  const context = {
    client: createSqliteSqlClient(db),
    userId: "user-a",
    requestId: "request-a",
  };
  const base = {
    portfolioId: "portfolio-a",
    type: "price",
    securityId: "security-a",
    targetKey: "security-a",
    effectiveFrom: "2026-08-03",
    reason: "Verified closing price",
  };
  const symbolTarget = await saveManualOverrideForContext(context, {
    ...base,
    targetKey: "AAA",
    valueJson: JSON.stringify({ closeDecimal: "42.20", currencyCode: "AUD" }),
  });
  assert.equal(symbolTarget.ok, false);
  const wrongCurrency = await saveManualOverrideForContext(context, {
    ...base,
    valueJson: JSON.stringify({ closeDecimal: "42.20", currencyCode: "USD" }),
  });
  assert.equal(wrongCurrency.ok, false);
  const saved = await saveManualOverrideForContext(context, {
    ...base,
    valueJson: JSON.stringify({ closeDecimal: "42.20", currencyCode: "AUD" }),
  });
  assert.equal(saved.ok, true);
  const fx = await saveManualOverrideForContext(context, {
    portfolioId: "portfolio-a",
    type: "fx_rate",
    targetKey: "USD/AUD",
    effectiveFrom: "2026-08-03",
    reason: "Verified conversion",
    valueJson: JSON.stringify({
      rateDecimal: "1.52",
      baseCurrencyCode: "USD",
      quoteCurrencyCode: "AUD",
    }),
  });
  assert.equal(fx.ok, true);
  db.close();
});
