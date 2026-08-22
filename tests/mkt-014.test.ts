/** MKT-014 — Restore a UI entry point for on-demand market-data refresh and
 * manual overrides. Retiring the owned QuotesScreen (WLT-001) removed the
 * only owned-mode entry point for `requestMarketDataRefreshForContext`
 * (`app/market-data-actions.ts`, the sole `market_data_refresh_jobs`
 * producer -- UNCHANGED by this task) and the quote-correction dialog +
 * correction history. Per the Orchestrator's placement ruling, both now
 * live in the per-holding detail sheet
 * (`app/components/holding-detail.tsx`'s `HoldingMarketDataPanel`), reusing
 * `QuoteCorrectionDialog`/`QuoteCorrectionHistory` -- exported from
 * `app/components/portfolio-shell.tsx`, where the preview-mode
 * `QuotesScreen` also still uses them, unchanged -- rather than forking new
 * copies. Routes/backends are untouched; this suite exercises the new
 * client entry points, the reuse wiring, and the exact request shapes the
 * new panel sends through the existing producer/action.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/sql-client.ts";
import { createOwnedManualOverrideRepository } from "../db/repositories/index.ts";
import {
  requestMarketDataRefreshForContext,
  saveManualOverrideForContext,
} from "../app/market-data-actions.ts";
import { marketDataProviderEnabled } from "../app/market-data-provider-status.ts";

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
    VALUES ('user-a', 'active', 'a@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'active', 'b@example.com', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1),
           ('user-b', 'AUD', 'Australia/Sydney', '2026-08-03', '2026-08-03', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'Alice', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1),
           ('portfolio-b', 'user-b', 'B', 'Bob', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-03', '2026-08-03', 1);
    -- market_data_providers' 'yahoo-compatible' row ships as reference data
    -- via MKT-007's drizzle/0037_steady_signal.sql, applied above.
    INSERT INTO securities (id, asset_type, primary_currency_code, canonical_name, created_at, updated_at)
    VALUES ('security-a', 'equity', 'AUD', 'Security A', '2026-08-03', '2026-08-03'),
           ('security-c', 'equity', 'AUD', 'Security C', '2026-08-03', '2026-08-03');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
    VALUES ('mapping-a', 'security-a', 'yahoo-compatible', 'ASX', 'AAA.AX', '2026-01-01', 'verified'),
           ('mapping-c', 'security-c', 'yahoo-compatible', 'ASX', 'CCC.AX', '2026-01-01', 'verified');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_currency_code, display_symbol, status, created_at, updated_at)
    VALUES ('holding-a', 'user-a', 'portfolio-a', 'security-a', 'AAA', 'AUD', 'AAA', 'held', '2026-08-03', '2026-08-03'),
           ('holding-c', 'user-a', 'portfolio-a', 'security-c', 'CCC', 'AUD', 'CCC', 'held', '2026-08-03', '2026-08-03'),
           ('holding-b', 'user-b', 'portfolio-b', 'security-a', 'AAA', 'AUD', 'AAA', 'held', '2026-08-03', '2026-08-03');
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Part 1: MARKET_DATA_PROVIDER activation read (`app/market-data-provider-
// status.ts`), used ONLY by the new panel's refresh-disabled message -- the
// existing refresh producer/action is untouched.
// ---------------------------------------------------------------------------

test("MKT-014: marketDataProviderEnabled() falls closed (disabled) outside a Worker runtime, matching every other MARKET_DATA_PROVIDER-gated path under node --test", async () => {
  assert.equal(await marketDataProviderEnabled(), false);
});

// ---------------------------------------------------------------------------
// Part 2: the new entry point renders and gates correctly.
// ---------------------------------------------------------------------------

const detailHolding = {
  id: "holding-pls",
  securityId: "security-pls",
  symbol: "PLS",
  name: "Pilbara Fixture",
  exchange: "XASX",
  currencyCode: "AUD",
  quantity: "1000",
  averageNativeCost: "1.965",
  nativeBasis: {
    status: "available",
    currencyCode: "AUD",
    value: "1965.00",
    reason: null,
  },
  homeBasis: {
    status: "available",
    currencyCode: "AUD",
    value: "1965.00",
    reason: null,
  },
  nativePrice: "4.26",
  nativeValue: {
    status: "available",
    currencyCode: "AUD",
    value: "4260.00",
    reason: null,
  },
  homePrice: {
    status: "available",
    currencyCode: "AUD",
    value: "4.26",
    reason: null,
  },
  homeValue: {
    status: "available",
    currencyCode: "AUD",
    value: "4260.00",
    reason: null,
  },
  dailyMovement: {
    status: "available",
    currencyCode: "AUD",
    value: "120.00",
    reason: null,
  },
  dailyPercent: {
    status: "available",
    currencyCode: "AUD",
    value: "2.90",
    reason: null,
  },
  unrealisedGain: {
    status: "available",
    currencyCode: "AUD",
    value: "2340.00",
    reason: null,
  },
  unrealisedPercent: {
    status: "available",
    currencyCode: "AUD",
    value: "117.05",
    reason: null,
  },
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
      subtitle: "Pilbara Fixture · XASX · AUD",
      portfolioSecurityId: "holding-pls",
      homeCurrencyCode: "AUD",
      initialView: "native",
      marketDataProviderEnabled: true,
      ...overrides,
    },
  );
}

test("MKT-014: with the provider enabled, the holding sheet renders all three market-data entry points, none disabled at initial render", () => {
  const html = renderDetail({ marketDataProviderEnabled: true });
  assert.match(html, />Refresh market data</);
  assert.match(html, />Correct quote</);
  assert.match(html, />Correction history</);
  assert.doesNotMatch(html, /disabled=""/);
  assert.doesNotMatch(
    html,
    /Market-data refresh is unavailable for this deployment/,
  );
});

test("MKT-014: with the provider disabled, refresh renders an explicit non-hidden message and a disabled control -- Correct quote/Correction history stay enabled (manual correction never depends on the live provider)", () => {
  const html = renderDetail({ marketDataProviderEnabled: false });
  assert.match(
    html,
    /Market-data refresh is unavailable for this deployment\. Manual\s*\n?\s*corrections remain available below\./,
  );
  const refreshButton = html.match(
    /<button[^>]*>Refresh market data<\/button>/,
  );
  assert.ok(refreshButton, "expected to find the refresh button");
  assert.match(refreshButton![0], /disabled=""/);
  const correctButton = html.match(/<button[^>]*>Correct quote<\/button>/);
  assert.ok(correctButton, "expected to find the correct-quote button");
  assert.doesNotMatch(correctButton![0], /disabled=""/);
  const historyButton = html.match(/<button[^>]*>Correction history<\/button>/);
  assert.ok(historyButton, "expected to find the correction-history button");
  assert.doesNotMatch(historyButton![0], /disabled=""/);
});

test("MKT-014: a holding with no published valuation renders none of the market-data controls -- there is no security context to refresh or correct", () => {
  const html = renderDetail({ holding: null, marketDataProviderEnabled: true });
  assert.doesNotMatch(html, /Refresh market data/);
  assert.doesNotMatch(html, /Correct quote/);
  assert.doesNotMatch(html, /Correction history/);
});

// ---------------------------------------------------------------------------
// Part 3: reuse, not a fork -- the panel imports the SAME dialog/history
// components the preview-mode QuotesScreen still uses, rather than defining
// its own `<dialog>`/fetch logic.
// ---------------------------------------------------------------------------

test("MKT-014: holding-detail.tsx imports (reuses) QuoteCorrectionDialog/QuoteCorrectionHistory from portfolio-shell.tsx instead of forking a second <dialog> implementation", async () => {
  const detail = await readFile(
    new URL("../app/components/holding-detail.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    detail,
    /import \{\s*QuoteCorrectionDialog,\s*QuoteCorrectionHistory,?\s*\} from "\.\/portfolio-shell";/,
  );
  // No forked dialog: this file never calls showModal() or defines its own
  // <dialog> element -- both entry points render the imported components.
  assert.doesNotMatch(detail, /showModal\(/);
  assert.match(detail, /<QuoteCorrectionDialog/);
  assert.match(detail, /<QuoteCorrectionHistory/);
});

test("MKT-014: portfolio-shell.tsx exports QuoteCorrectionDialog and QuoteCorrectionHistory, and the preview-mode QuotesScreen call site is unchanged (still no targetKey, so the whole portfolio's history loads there)", async () => {
  const shell = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(shell, /export function QuoteCorrectionDialog\(/);
  assert.match(shell, /export function QuoteCorrectionHistory\(/);
  const quotesScreenStart = shell.indexOf("function QuotesScreen({");
  const quoteCorrectionDialogStart = shell.indexOf(
    "export function QuoteCorrectionDialog({",
  );
  const quotesScreenSource = shell.slice(
    quotesScreenStart,
    quoteCorrectionDialogStart,
  );
  assert.match(
    quotesScreenSource,
    /<QuoteCorrectionHistory\s*\n\s*portfolioId=\{portfolioId\}\s*\n\s*readOnly=\{readOnly\}\s*\n\s*onClose=\{\(\) => setHistoryOpen\(false\)\}\s*\n\s*onMessage=\{setActionMessage\}\s*\n\s*\/>/,
  );
});

test("MKT-014: the refresh panel's own fetch/timeout convention (FETCH_TIMEOUT_MS + AbortController + isAbortError) is present and kept local, not imported from portfolio-shell.tsx's private DIALOG_FETCH_TIMEOUT_MS (mirrors holding-price-chart.tsx's documented precedent)", async () => {
  const detail = await readFile(
    new URL("../app/components/holding-detail.tsx", import.meta.url),
    "utf8",
  );
  assert.match(detail, /const FETCH_TIMEOUT_MS = 15_000;/);
  assert.match(
    detail,
    /function isAbortError\(error: unknown\): boolean \{\s*return error instanceof DOMException && error\.name === "AbortError";/,
  );
  assert.match(detail, /new AbortController\(\)/);
  assert.match(
    detail,
    /const timeout = setTimeout\(\(\) => controller\.abort\(\), FETCH_TIMEOUT_MS\);/,
  );
  assert.match(detail, /signal: controller\.signal,/);
});

test("MKT-014: the refresh/correct-quote/correction-history buttons follow the disabled={actionPending || !isOnline} convention", async () => {
  const detail = await readFile(
    new URL("../app/components/holding-detail.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    detail,
    /const mutationsDisabled = actionPending \|\| !isOnline;/,
  );
  const buttonDisabledCount = (
    detail.match(/disabled=\{mutationsDisabled/g) ?? []
  ).length;
  assert.equal(
    buttonDisabledCount,
    3,
    "expected all three buttons (refresh, correct, history) to gate on mutationsDisabled",
  );
  assert.match(
    detail,
    /const updateConnectivity = \(\) => setIsOnline\(navigator\.onLine\);/,
  );
});

// ---------------------------------------------------------------------------
// Part 4: enqueue round trip through the real, unchanged producer/action --
// scoped to exactly the one `portfolioSecurityId` the panel sends, never a
// whole-portfolio refresh.
// ---------------------------------------------------------------------------

test("MKT-014: requestMarketDataRefreshForContext, called with the panel's exact { portfolioId, portfolioSecurityId } request shape, enqueues a job for ONLY that holding's mapping -- a sibling held security in the same portfolio is untouched", async () => {
  const db = await database();
  const client = createSqliteSqlClient(db);
  const context = { client, userId: "user-a", requestId: "request-a" };
  const now = new Date("2026-08-03T08:00:00Z");

  const result = await requestMarketDataRefreshForContext(
    context,
    { portfolioId: "portfolio-a", portfolioSecurityId: "holding-a" },
    now,
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.jobs.length, 1);
    assert.equal(result.jobs[0]?.targetKey, "mapping-a");
  }

  // Job rows are deployment-scoped (no user_id column) -- assert directly on
  // which mapping got a row: holding-c ('security-c'/'mapping-c') must NOT
  // have been touched by a request scoped to holding-a.
  const allJobs = db
    .prepare("SELECT mapping_id FROM market_data_refresh_jobs")
    .all() as Array<{ mapping_id: string }>;
  assert.deepEqual(
    allJobs.map((row) => row.mapping_id),
    ["mapping-a"],
  );
});

test("MKT-014: requesting a target from a DIFFERENT owner's portfolio_security is refused not_found -- ownership isolation for the scoped refresh is unchanged", async () => {
  const db = await database();
  const client = createSqliteSqlClient(db);
  const context = { client, userId: "user-a", requestId: "request-a" };
  const now = new Date("2026-08-03T08:00:00Z");

  const result = await requestMarketDataRefreshForContext(
    context,
    { portfolioId: "portfolio-a", portfolioSecurityId: "holding-b" },
    now,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 404);
});

// ---------------------------------------------------------------------------
// Part 5: correction history's new per-holding `targetKey` filter (the GET
// route's existing, unchanged `targetKey` query param) and ownership
// isolation -- exercised through the real save action and the real list
// repository the route delegates to.
// ---------------------------------------------------------------------------

test("MKT-014: a correction saved for one security does not appear when the holding sheet's correction history is scoped (targetKey = that security's id) to a DIFFERENT security -- and cross-user corrections never leak in either case", async () => {
  const db = await database();
  const client = createSqliteSqlClient(db);
  const now = new Date("2026-08-03T08:00:00Z");
  const contextA = { client, userId: "user-a", requestId: "request-a" };
  const contextB = { client, userId: "user-b", requestId: "request-b" };

  const savedA = await saveManualOverrideForContext(contextA, {
    portfolioId: "portfolio-a",
    type: "price",
    targetKey: "security-a",
    securityId: "security-a",
    effectiveFrom: "2026-08-01",
    valueJson: JSON.stringify({ closeDecimal: "5.00", currencyCode: "AUD" }),
    reason: "Owner-verified close.",
  });
  assert.equal(savedA.ok, true);

  const savedC = await saveManualOverrideForContext(contextA, {
    portfolioId: "portfolio-a",
    type: "price",
    targetKey: "security-c",
    securityId: "security-c",
    effectiveFrom: "2026-08-01",
    valueJson: JSON.stringify({ closeDecimal: "9.00", currencyCode: "AUD" }),
    reason: "Owner-verified close.",
  });
  assert.equal(savedC.ok, true);

  const savedB = await saveManualOverrideForContext(contextB, {
    portfolioId: "portfolio-b",
    type: "price",
    targetKey: "security-a",
    securityId: "security-a",
    effectiveFrom: "2026-08-01",
    valueJson: JSON.stringify({ closeDecimal: "6.00", currencyCode: "AUD" }),
    reason: "Owner-verified close.",
  });
  assert.equal(savedB.ok, true);
  void now;

  // The per-holding history panel's exact query: user-a's history scoped to
  // security-a's targetKey only ever returns security-a's own correction,
  // never security-c's (same owner, different holding) or user-b's
  // same-targetKey correction (different owner entirely).
  const repository = createOwnedManualOverrideRepository(client);
  const scopedToA = await repository.list("user-a", "security-a");
  assert.equal(scopedToA.length, 1);
  assert.equal(scopedToA[0]?.targetKey, "security-a");

  const scopedToC = await repository.list("user-a", "security-c");
  assert.equal(scopedToC.length, 1);
  assert.equal(scopedToC[0]?.targetKey, "security-c");

  const userBScopedToA = await repository.list("user-b", "security-a");
  assert.equal(userBScopedToA.length, 1);
  assert.equal(userBScopedToA[0]?.reason, "Owner-verified close.");
  // Confirms real isolation, not merely a coincidental same-count result.
  assert.notEqual(userBScopedToA[0]?.id, scopedToA[0]?.id);
});
