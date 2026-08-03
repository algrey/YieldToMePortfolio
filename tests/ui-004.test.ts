import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { quoteDisplayState, quoteExplanation } from "../app/quote-contract.ts";

const root = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("quote display states keep missing prices distinct from stale values", () => {
  assert.equal(quoteDisplayState("populated", false), "current");
  assert.equal(quoteDisplayState("provider-error", false), "stale");
  assert.equal(quoteDisplayState("partial", true), "unavailable");
  assert.equal(quoteDisplayState("partial", false), "current");
  assert.match(
    quoteExplanation("stale", "2026-08-03"),
    /Last-known quote.*stale.*refresh/i,
  );
  assert.match(
    quoteExplanation("unavailable", "2026-08-03"),
    /Price unavailable.*no usable price/i,
  );
});

test("quote rows expose compact data and accessible provenance explanations", async () => {
  const component = await source("app/components/portfolio-shell.tsx");
  const css = await source("app/globals.css");
  assert.match(component, /aria-describedby=\{explanationId\}/);
  assert.match(component, /quoteExplanation\(state, quote\.marketDate\)/);
  assert.match(component, /Refresh queued; current values are unchanged/);
  assert.match(component, /Preview quotes are read-only/);
  assert.match(css, /\.visually-hidden/);
  assert.match(css, /\.quote-actions/);
  assert.match(css, /min-height: 44px/);
});

test("refresh and correction endpoints are private, durable, and owner-scoped", async () => {
  const actions = await source("app/market-data-actions.ts");
  const refreshRoute = await source("app/api/market-data/refresh/route.ts");
  const overrideRoute = await source("app/api/market-data/overrides/route.ts");
  assert.match(actions, /getAuthenticatedSqlContext\(portfolioId\)/);
  assert.match(actions, /ps\.user_id = \? AND ps\.portfolio_id = \?/);
  assert.match(actions, /createMarketDataRefreshRepository/);
  assert.match(actions, /idempotencyKey/);
  assert.match(actions, /scope: \{ kind: "deployment", userId: null \}/);
  assert.match(refreshRoute, /cache-control.*private, no-store/);
  assert.match(overrideRoute, /saveManualOverrideAction/);
  assert.match(overrideRoute, /removeManualOverrideAction/);
  assert.match(overrideRoute, /listManualOverrideAction/);
  assert.match(actions, /correction history is temporarily unavailable/i);
});
