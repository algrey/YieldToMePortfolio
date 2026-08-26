/** UI-048 — the Income back control LEAVES the area in one step.
 *
 * Owner-reported against UI-046's plain history-back: "when I cycle through
 * the income sub-tabs, then hit back, it cycles me back through the income
 * sub-tabs (as a browser back button would do), before going back to the
 * main tab ... Ideal functionality is it goes back to the higher level tab
 * menu and land on the last main-tab you called the Income tab from. If
 * that is too hard, just go back to Holdings."
 *
 * Implemented as the ideal: `PortfolioShell` (which renders on the primary
 * tabs and nowhere else) records its pathname, and the control returns
 * there; Holdings is the fallback when nothing was remembered.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isPrimaryTabPath,
  LAST_PRIMARY_TAB_KEY,
} from "../app/last-primary-tab.ts";

test("UI-048: only real primary-tab paths are accepted, so a tampered or stale stored value can never become an open redirect", () => {
  for (const good of [
    "/",
    "/portfolio/pa/overview",
    "/portfolio/pa/holdings",
    "/portfolio/pa/quotes",
    "/portfolio/pa/details",
    "/portfolio/pa/news",
  ]) {
    assert.equal(isPrimaryTabPath(good), true, `${good} should be accepted`);
  }
  for (const bad of [
    // Not a primary tab -- these are the sub-area paths the control exists
    // to escape, so returning to one would defeat the whole feature.
    "/portfolio/pa/income",
    "/portfolio/pa/income/dividends",
    "/portfolio/pa/holdings/sec-1/dividends",
    "/portfolio/pa/gains",
    "/import",
    // Redirect vectors.
    "//evil.example/portfolio/pa/overview",
    "https://evil.example/portfolio/pa/overview",
    "/portfolio//overview",
    "/portfolio/pa/overview/extra",
    "",
    "javascript:alert(1)",
  ]) {
    assert.equal(isPrimaryTabPath(bad), false, `${bad} should be rejected`);
  }
});

test("UI-048: the remembered tab is per-tab session state holding a path only, never portfolio data", async () => {
  const source = await readFile(
    new URL("../app/last-primary-tab.ts", import.meta.url),
    "utf8",
  );
  assert.match(LAST_PRIMARY_TAB_KEY, /^yieldtome:/);
  // sessionStorage (per browser tab, cleared on close), not localStorage.
  assert.match(source, /sessionStorage/);
  assert.doesNotMatch(source, /localStorage/);
  // Blocked/private-mode storage must never throw into the render path.
  assert.match(source, /try \{[\s\S]*catch/);
  // The value is validated on READ, not merely on write.
  assert.match(
    source,
    /export function readRememberedPrimaryTab[\s\S]*isPrimaryTabPath\(raw\)/,
  );
});

test("UI-048: the shell records the primary tab, and the Income nav exits to it with Holdings as the fallback", async () => {
  const [shell, incomeNav, subNav, backControl] = await Promise.all(
    [
      "../app/components/portfolio-shell.tsx",
      "../app/components/income-nav.tsx",
      "../app/components/sub-nav.tsx",
      "../app/components/back-control.tsx",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  // The shell renders ONLY on primary tabs, so its own pathname is the
  // record; it must write on every pathname change, not just first mount.
  assert.match(shell, /rememberPrimaryTab\(pathname\)/);
  assert.match(shell, /\}, \[pathname\]\)/);

  assert.match(incomeNav, /backMode="exit"/);
  assert.match(
    incomeNav,
    /return `\/portfolio\/\$\{portfolioId\}\/holdings`/,
    "the fallback is Holdings, per the owner's instruction",
  );
  assert.match(subNav, /backMode === "exit"/);
  assert.match(subNav, /<AreaExitBackControl/);

  // A real Link: works with JS disabled, supports cmd/middle-click, and
  // needs no mounted router for a static render.
  assert.match(
    backControl,
    /export function AreaExitBackControl[\s\S]*<Link className="subnav-back"/,
  );
  // SSR snapshot is the fallback so hydration cannot mismatch.
  assert.match(
    backControl,
    /useSyncExternalStore\([\s\S]*\(\) => fallbackHref/,
  );
});

test("UI-048: the holding area keeps its static back link -- it has one definite parent", async () => {
  const holdingNav = await readFile(
    new URL("../app/components/holding-nav.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(holdingNav, /backMode/);
  assert.match(holdingNav, /return `\/portfolio\/\$\{portfolioId\}\/holdings`/);
});
