/** UI-023 — Standalone per-holding detail area. Owner directive
 * (2026-08-21, competitor screenshots 01/05): clicking a holding must open
 * a full-screen view whose sub-tabs REPLACE the primary tabs (News /
 * Details / Transactions) with a prominent back arrow top-left -- not a
 * popup. Details carries the old sheet's facts + price graph; Transactions
 * lists every ledger transaction for the ticker; News is a declared
 * placeholder. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/sql-client.ts";
import {
  loadOwnedHoldingIdentity,
  loadOwnedHoldingTransactions,
} from "../app/owned-holding-transactions.ts";
import { holdingSubtitle } from "../app/holding-subtitle.ts";

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
// Part 1: owner-scoped loaders against the real migrated schema.
// ---------------------------------------------------------------------------

async function migratedDatabase() {
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
    INSERT INTO exchanges (id,mic,name,country_code,timezone,calendar_code) VALUES ('asx','XASX','Australian Securities Exchange','AU','Australia/Sydney','XASX');
    INSERT INTO securities (id,asset_type,exchange_id,primary_currency_code,canonical_name,created_at,updated_at) VALUES ('security-pls','equity','asx','AUD','Pilbara Fixture','2026-08-03','2026-08-03');
    INSERT INTO portfolio_securities (id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,display_symbol,status,created_at,updated_at) VALUES
      ('holding-pls','owner-a','portfolio-a','security-pls','PLS','AUD','PLS','held','2026-08-03','2026-08-03'),
      ('holding-unresolved','owner-a','portfolio-a',NULL,'MYST','AUD',NULL,'unresolved','2026-08-03','2026-08-03'),
      ('holding-b','owner-b','portfolio-b','security-pls','PLS','AUD','PLS','held','2026-08-03','2026-08-03');
    INSERT INTO transactions (id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('tx-buy','owner-a','portfolio-a','holding-pls','buy','posted','2026-01-05T01:00:00Z','2026-01-05','1000','1.965','AUD','1965.00','19.95','0','manual','owner-a',1,'2026-01-05'),
      ('tx-sell','owner-a','portfolio-a','holding-pls','sell','posted','2026-03-10T01:00:00Z','2026-03-10','200','4.10','AUD','820.00','0','0','csv_import','owner-a',1,'2026-03-10'),
      ('tx-open','owner-a','portfolio-a','holding-pls','opening_balance','posted','2025-12-01T01:00:00Z','2025-12-01','500',NULL,'AUD',NULL,'0','0','csv_import','owner-a',1,'2025-12-01'),
      ('tx-other-owner','owner-b','portfolio-b','holding-b','buy','posted','2026-02-02T01:00:00Z','2026-02-02','50','2.00','AUD','100.00','0','0','manual','owner-b',1,'2026-02-02');
  `);
  return db;
}

test("UI-023: loadOwnedHoldingIdentity is owner-scoped — the owner resolves it, a cross-user request gets null, never another owner's data", async () => {
  const db = await migratedDatabase();
  const client = createSqliteSqlClient(db);
  const owned = await loadOwnedHoldingIdentity(
    client,
    "owner-a",
    "portfolio-a",
    "holding-pls",
  );
  assert.ok(owned);
  assert.equal(owned!.symbol, "PLS");
  assert.equal(owned!.name, "Pilbara Fixture");
  assert.equal(owned!.exchange, "XASX");
  assert.equal(owned!.currencyCode, "AUD");
  assert.equal(holdingSubtitle(owned!), "Pilbara Fixture · XASX · AUD");

  const crossUser = await loadOwnedHoldingIdentity(
    client,
    "owner-b",
    "portfolio-a",
    "holding-pls",
  );
  assert.equal(crossUser, null);
  const crossPortfolio = await loadOwnedHoldingIdentity(
    client,
    "owner-a",
    "portfolio-b",
    "holding-pls",
  );
  assert.equal(crossPortfolio, null);
});

test("UI-023: an unresolved candidate (no canonical security) still resolves its identity from source fields, with unknown parts omitted rather than fabricated", async () => {
  const db = await migratedDatabase();
  const client = createSqliteSqlClient(db);
  const identity = await loadOwnedHoldingIdentity(
    client,
    "owner-a",
    "portfolio-a",
    "holding-unresolved",
  );
  assert.ok(identity);
  assert.equal(identity!.symbol, "MYST");
  assert.equal(identity!.exchange, "N/A");
  // No canonical security → no canonical currency; the subtitle omits it
  // entirely rather than showing a placeholder value.
  assert.equal(identity!.currencyCode, null);
  assert.doesNotMatch(holdingSubtitle(identity!), /null|undefined/);
});

test("UI-023: loadOwnedHoldingTransactions returns only this owner's rows for this security, newest first, with an honest total count", async () => {
  const db = await migratedDatabase();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedHoldingTransactions(
    client,
    "owner-a",
    "portfolio-a",
    "holding-pls",
  );
  assert.equal(result.totalCount, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.rows.map((row) => row.id),
    ["tx-sell", "tx-buy", "tx-open"],
  );
  // The null-gross opening balance stays null -- never coerced to zero.
  const opening = result.rows.find((row) => row.id === "tx-open")!;
  assert.equal(opening.grossAmountDecimal, null);
  assert.equal(opening.unitPriceDecimal, null);
  // Cross-owner isolation: owner-b sees nothing through owner-a's ids.
  const crossUser = await loadOwnedHoldingTransactions(
    client,
    "owner-b",
    "portfolio-a",
    "holding-pls",
  );
  assert.equal(crossUser.totalCount, 0);
  assert.equal(crossUser.rows.length, 0);
});

// ---------------------------------------------------------------------------
// Part 2: the Transactions screen renders honestly.
// ---------------------------------------------------------------------------

const baseTransactionRow = {
  id: "tx-1",
  type: "buy",
  status: "posted",
  businessDate: "2026-01-05",
  quantityDecimal: "1000",
  unitPriceDecimal: "1.965",
  currencyCode: "AUD",
  grossAmountDecimal: "1965.00",
  feeAmountDecimal: "19.95",
  taxAmountDecimal: "0",
  sourceType: "manual",
  reversesTransactionId: null,
  supersedesTransactionId: null,
};

function renderTransactions(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "HoldingTransactionsScreen",
    "../app/components/holding-transactions.tsx",
    {
      portfolioId: "portfolio-a",
      portfolioSecurityId: "holding-pls",
      symbol: "PLS",
      subtitle: "Pilbara Fixture · XASX · AUD",
      baseCurrencyCode: "AUD",
      rows: [baseTransactionRow],
      truncated: false,
      totalCount: 1,
      ...overrides,
    },
  );
}

test("UI-023: the Transactions screen renders the labelled buy row with quantity, price, gross value, and a fees micro-note", () => {
  const html = renderTransactions();
  assert.match(html, /<caption>Ledger transactions for PLS<\/caption>/);
  assert.match(html, /Buy/);
  // UI-027: an integral quantity ("1000") now renders with no decimal
  // places at all via the shared `ownedHoldingQuantity` formatter, not the
  // old fixed-4dp "1,000.0000" -- flipped honestly from the pre-UI-027
  // expectation.
  assert.match(html, /class="numeric">1,000<\//);
  assert.match(html, /\$1\.965/);
  assert.match(html, /\$1,965\.00/);
  assert.match(html, /fees \$19\.95/);
  assert.match(html, /Posted/);
  assert.match(html, /manual/);
});

test("UI-023: an unknown gross amount renders 'Unavailable', never a fabricated zero, and a reversal is marked in text", () => {
  const html = renderTransactions({
    rows: [
      {
        ...baseTransactionRow,
        id: "tx-null",
        type: "opening_balance",
        grossAmountDecimal: null,
        unitPriceDecimal: null,
        feeAmountDecimal: "0",
      },
      {
        ...baseTransactionRow,
        id: "tx-rev",
        type: "sell",
        status: "posted",
        reversesTransactionId: "tx-orig",
      },
    ],
    totalCount: 2,
  });
  assert.match(html, /Opening balance/);
  assert.match(html, /Unavailable/);
  assert.doesNotMatch(html, /\$0\.00<\/td>/);
  assert.match(html, /Sell \(reversal\)/);
});

test("UI-023: the empty state and the truncation banner disclose real mechanics", () => {
  const empty = renderTransactions({ rows: [], totalCount: 0 });
  assert.match(empty, /No transactions recorded for this holding yet\./);
  const truncated = renderTransactions({ truncated: true, totalCount: 750 });
  assert.match(truncated, /Showing the most recent 500 of 750 transactions/);
});

test("UI-023: every holding screen renders the sub-nav — back control to the Holdings tab plus the three sub-tabs with the active one current", () => {
  const html = renderTransactions();
  assert.match(html, /aria-label="Back to holdings"/);
  assert.match(html, /href="\/portfolio\/portfolio-a\/holdings"/);
  assert.match(
    html,
    /href="\/portfolio\/portfolio-a\/holdings\/holding-pls\/news"/,
  );
  assert.match(html, /href="\/portfolio\/portfolio-a\/holdings\/holding-pls"/);
  assert.match(html, /aria-current="page">Transactions<\/span>/);
  assert.match(html, /class="subnav-title">PLS<\/h1>/);
  assert.match(html, /Pilbara Fixture · XASX · AUD/);
});

// ---------------------------------------------------------------------------
// Part 3: the Details screen.
// ---------------------------------------------------------------------------

function holdingValue(
  status: "available" | "unavailable",
  currencyCode: string,
  value: string | null,
) {
  return { status, currencyCode, value, reason: null };
}

const detailHolding = {
  id: "holding-pls",
  securityId: "security-pls",
  symbol: "PLS",
  name: "Pilbara Fixture",
  exchange: "XASX",
  currencyCode: "USD",
  quantity: "1000",
  averageNativeCost: "1.965",
  nativeBasis: holdingValue("available", "USD", "1965.00"),
  homeBasis: holdingValue("available", "AUD", "2900.00"),
  nativePrice: "4.26",
  nativeValue: holdingValue("available", "USD", "4260.00"),
  homePrice: holdingValue("available", "AUD", "6.30"),
  homeValue: holdingValue("available", "AUD", "6300.00"),
  dailyMovement: holdingValue("available", "AUD", "120.00"),
  dailyPercent: holdingValue("available", "AUD", "2.90"),
  unrealisedGain: holdingValue("available", "AUD", "2340.00"),
  unrealisedPercent: holdingValue("available", "AUD", "117.05"),
  dailyTone: "positive",
  gainTone: "positive",
  priceState: "current",
  actionStatus: "none",
  explanation: "Fixture explanation.",
  sort: { ticker: "PLS", value: "4260.00", daily: "2.90", gain: "117.05" },
};

function renderDetail(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "HoldingDetailScreen",
    "../app/components/holding-detail.tsx",
    {
      portfolioId: "portfolio-a",
      holding: detailHolding,
      symbol: "PLS",
      subtitle: "Pilbara Fixture · XASX · USD",
      portfolioSecurityId: "holding-pls",
      homeCurrencyCode: "AUD",
      initialView: "native",
      ...overrides,
    },
  );
}

test("UI-023: the Details screen renders the sheet's facts (quantity, price, value, signed gain/percents, average cost) and the Dividends sub-tab", () => {
  const html = renderDetail();
  assert.match(html, /aria-current="page">Details<\/span>/);
  assert.match(html, /Quantity/);
  // UI-027: an integral quantity ("1000") now renders bare ("1,000"), not
  // the old fixed-4dp "1,000.0000" -- flipped honestly from the
  // pre-UI-027 expectation, via the shared `ownedHoldingQuantity`
  // formatter.
  assert.match(html, /<dd>1,000<\/dd>/);
  assert.match(html, /US\$4\.26/);
  assert.match(html, /US\$4,260\.00/);
  assert.match(html, /\$\+2,340\.00/);
  assert.match(html, /\+2\.9%/);
  assert.match(html, /\+117\.05%/);
  assert.match(html, /US\$1\.965 × 1,000</);
  assert.match(
    html,
    /href="\/portfolio\/portfolio-a\/holdings\/holding-pls\/dividends"/,
  );
  // Foreign-currency holding in an AUD workspace → the display-values
  // select is offered, exactly as the old sheet did.
  assert.match(html, /Display PLS values in native or home currency/);
});

test("UI-023: a holding with no published valuation renders an honest unavailable state — never zeros — while history links stay reachable", () => {
  const html = renderDetail({ holding: null });
  assert.match(html, /No published valuation for this holding/);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.match(
    html,
    /href="\/portfolio\/portfolio-a\/holdings\/holding-pls\/dividends"/,
  );
});

// ---------------------------------------------------------------------------
// Part 4: wiring — rows are links, routes are guarded, nav is shared.
// ---------------------------------------------------------------------------

test("UI-023: owned holdings rows are real links to the standalone detail route; the in-place dialog sheet is gone", async () => {
  const shell = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    shell,
    /href=\{`\/portfolio\/\$\{portfolioId\}\/holdings\/\$\{holding\.id\}`\}/,
  );
  assert.doesNotMatch(shell, /owned-holding-sheet-title/);
  assert.doesNotMatch(shell, /aria-haspopup="dialog"/);
});

test("UI-023: all four holding pages are force-dynamic, owner-guarded, and reject non-holdings sections; the tab pages reject the preview fixture", async () => {
  const [details, transactions, news, dividends] = await Promise.all([
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/[section]/[holdingId]/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/[section]/[holdingId]/transactions/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/[section]/[holdingId]/news/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/[section]/[holdingId]/dividends/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);
  for (const source of [details, transactions, news, dividends]) {
    assert.match(source, /export const dynamic = "force-dynamic";/);
    assert.match(source, /loadAuthenticatedWorkspace/);
    assert.match(source, /loadOwnedHoldingIdentity/);
    assert.match(source, /section !== "holdings"/);
  }
  for (const source of [transactions, news, dividends]) {
    assert.match(source, /portfolioId === "preview"/);
  }
});

test("UI-023B: the News tab embeds the owner's news site in a sandboxed, no-referrer iframe with visible source attribution, and the Worker CSP allows exactly that origin", async () => {
  const [news, csp] = await Promise.all([
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/[section]/[holdingId]/news/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../worker/response-security.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(
    news,
    /const HOLDING_NEWS_EMBED_URL = "https:\/\/greeninvestments\.au\/\?embed=1";/,
  );
  assert.match(news, /<iframe/);
  assert.match(news, /src=\{HOLDING_NEWS_EMBED_URL\}/);
  assert.match(news, /sandbox="/);
  // Portfolio URLs carry portfolio/security ids -- they must never reach
  // the news site's logs via the Referer header.
  assert.match(news, /referrerPolicy="no-referrer"/);
  // Attribution stays visible outside the frame.
  assert.match(news, /greeninvestments\.au\s*<\/a>/);
  // The CSP widening is exactly one origin, and the inverse directive
  // (nobody may embed THIS app) is untouched.
  assert.match(csp, /"frame-src 'self' https:\/\/greeninvestments\.au"/);
  assert.match(csp, /"frame-ancestors 'none'"/);
});

test("UI-023: HoldingNav and IncomeNav both render through the single shared SubNav, so the two sub-areas cannot drift apart", async () => {
  const [holdingNav, incomeNav] = await Promise.all([
    readFile(
      new URL("../app/components/holding-nav.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/income-nav.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  for (const source of [holdingNav, incomeNav]) {
    assert.match(source, /import { SubNav } from ".\/sub-nav"/);
    assert.match(source, /<SubNav/);
  }
  for (const label of ["News", "Details", "Transactions", "Dividends"]) {
    assert.match(holdingNav, new RegExp(`label: "${label}"`));
  }
});
