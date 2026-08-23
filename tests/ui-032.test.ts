// UI-032 (owner directive, verbatim): "Lets get ride of the bottom/side
// panel in the holdings tab in it entirety. Remove the panel with this
// text: Cash separate / AUD reporting values / Cash is not included in
// security rows... / Securities subtotal... / Coverage..."
//
// Orchestrator rulings covered here:
// - The entire panel (the "Cash separate" heading, the "{code} reporting
//   values" line, the price/FX/basis-gaps sentence, the securities/cash/
//   known subtotals line, and both coverage lines) is gone from the owned
//   holdings screen -- panel-absence pin below.
// - Honesty preservation: the base-currency ISO identity UI-026 relied on
//   this panel's "{code} reporting values" line for must stay reachable.
//   Per-row "name · exchange · currency" labels only ever name a HELD
//   SECURITY's own currency (never guaranteed to equal the portfolio's
//   base currency -- an all-foreign-currency portfolio would show the
//   base code nowhere via those labels), so the statement was relocated
//   into `HoldingsSummaryFooterRow`'s (UI-031) explain area, unconditional
//   whenever that footer renders -- which is exactly when this screen
//   shows any base-currency dollar figure at all (see the "cash-only
//   portfolio" test below for the one case where NEITHER the footer NOR
//   any dollar figure renders, so there is honestly nothing to
//   disambiguate). UI-031B (owner directive "UI-031 has 6 lines not 4,
//   remove the extra explanatory text") since moved this statement
//   sr-only -- reachable to a screen-reader user, never a fifth visible
//   summary line. The pins below assert the sr-only wrapper.
//
// Rendering uses the same child-process `renderToStaticMarkup` trick
// tests/ui-031.test.ts and tests/ui-026.test.ts already use for this
// "use client" component.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROUTER_STUB_IMPORT = `
  import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
  const routerStub = {
    push() {},
    replace() {},
    back() {},
    forward() {},
    refresh() {},
    prefetch() {},
  };
`;

function holdingValue(
  status: "available" | "unavailable",
  currencyCode: string,
  value: string | null,
  reason: string | null = null,
) {
  return { status, currencyCode, value, reason };
}

function renderHoldingsScreen(options: {
  homeCurrencyCode: string;
  holdingsJson: string;
  holdingsViewState: "complete" | "partial" | "empty" | "unavailable";
  summaryJson: string | null;
  cashJson: string | null;
}): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    const ownedWorkspace = {
      status: "ready",
      userDisplayName: "Fixture Owner",
      homeCurrencyCode: ${JSON.stringify(options.homeCurrencyCode)},
      holdingCurrencyView: "native",
      settingsVersion: 1,
      activePortfolio: {
        id: "portfolio-a",
        name: "Fixture Portfolio",
        homeCurrencyCode: ${JSON.stringify(options.homeCurrencyCode)},
        baseCurrencyCode: ${JSON.stringify(options.homeCurrencyCode)},
        timezone: "Australia/Sydney",
        accountingMethod: "fifo",
        status: "active",
        version: 1,
      },
      portfolios: [
        {
          id: "portfolio-a",
          name: "Fixture Portfolio",
          homeCurrencyCode: ${JSON.stringify(options.homeCurrencyCode)},
          status: "active",
          version: 1,
        },
      ],
      holdings: ${options.holdingsJson},
      holdingsViewState: ${JSON.stringify(options.holdingsViewState)},
      cash: ${options.cashJson ?? "undefined"},
      holdingsSummary: ${options.summaryJson ?? "undefined"},
    };

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, {
            activeSection: "holdings",
            ownedWorkspace,
          }),
        ),
      ),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

const ONE_HELD_ROW = JSON.stringify([
  {
    id: "row-a",
    securityId: "security-a",
    symbol: "ABC",
    name: "ABC Holdings",
    exchange: "ASX",
    currencyCode: "USD",
    quantity: "10",
    averageNativeCost: "9.00",
    nativeBasis: holdingValue("available", "USD", "8000"),
    homeBasis: holdingValue("available", "AUD", "12000"),
    nativePrice: "1000.00",
    nativeValue: holdingValue("available", "USD", "10000"),
    homePrice: holdingValue("available", "AUD", "1500.00"),
    homeValue: holdingValue("available", "AUD", "15000"),
    dailyMovement: holdingValue("available", "AUD", "150"),
    dailyPercent: holdingValue("available", "%", "1.52"),
    unrealisedGain: holdingValue("available", "AUD", "2000"),
    unrealisedPercent: holdingValue("available", "%", "25"),
    dailyTone: "positive",
    gainTone: "positive",
    priceState: "current",
    actionStatus: "none",
    explanation: "Fixture explanation.",
    sort: { ticker: "ABC", value: "15000", daily: "1.52", gain: "25" },
  },
]);

const FOOTER_FIXTURE = JSON.stringify({
  currencyCode: "AUD",
  marketValue: holdingValue("available", "AUD", "15000"),
  dailyMovement: holdingValue("available", "AUD", "150"),
  unrealisedGain: holdingValue("available", "AUD", "2000"),
  costBasis: holdingValue("available", "AUD", "12000"),
  dailyPercent: holdingValue("available", "%", "1.52"),
  totalPercent: holdingValue("available", "%", "25"),
  allTimeGain: holdingValue("available", "AUD", "333000"),
  allTimePercent: holdingValue("available", "%", "33.19"),
  realisedGain: holdingValue("available", "AUD", "700"),
  realisedPercent: holdingValue("available", "%", "20"),
  valueQualifier: null,
  dailyQualifier: null,
  allTimeQualifier: null,
  realisedQualifier: null,
});

const CASH_FIXTURE = JSON.stringify({
  currencyCode: "AUD",
  securitiesSubtotal: "15000.00",
  cashSubtotal: "500.00",
  knownTotal: "15500.00",
  status: "complete",
  explanation: "Fixture cash explanation.",
  coverage: { total: 1, nonZero: 1, zero: 0, converted: 1 },
});

// ---------------------------------------------------------------------------
// Panel-absence pin: the six text elements the owner quoted verbatim, plus
// the retired aside's own aria-label, must never render again -- exercised
// with `cash` genuinely populated (the exact condition the old panel's
// subtotal/coverage lines needed to render), so a false negative from an
// unmet precondition can't hide a regression.
// ---------------------------------------------------------------------------

test("UI-032 render: the retired 'Cash separate' panel does not render, even with cash data present", () => {
  const html = renderHoldingsScreen({
    homeCurrencyCode: "AUD",
    holdingsJson: ONE_HELD_ROW,
    holdingsViewState: "complete",
    summaryJson: FOOTER_FIXTURE,
    cashJson: CASH_FIXTURE,
  });
  assert.doesNotMatch(html, /aria-label="Holdings summary"/);
  assert.doesNotMatch(html, /Cash separate/);
  assert.doesNotMatch(html, /Cash is not included in security rows/);
  assert.doesNotMatch(html, /Securities subtotal:/);
  assert.doesNotMatch(html, /Cash subtotal:/);
  assert.doesNotMatch(html, /Known total:/);
  assert.doesNotMatch(html, /cash accounts converted/);
  assert.doesNotMatch(html, /non-zero converted, .*basis-covered/);
});

// ---------------------------------------------------------------------------
// Base-currency-reachability pin: the ISO identity now lives in the UI-031
// summary footer's explain area, unconditional (not gated behind any
// incompleteness qualifier -- FOOTER_FIXTURE above has every qualifier
// null, proving it renders regardless of data completeness).
//
// UI-031B (Orchestrator ruling, owner directive "UI-031 has 6 lines not
// 4, remove the extra explanatory text"): this statement is a ROUTINE
// label under AGENTS.md's compact-view rule, so it went sr-only rather
// than a fifth visible summary line -- the pins below now assert it
// renders inside `<p class="sr-only">`, not as visible text.
// ---------------------------------------------------------------------------

test("UI-032 render: the base-currency ISO identity is reachable (sr-only, UI-031B) in the summary footer, unconditionally", () => {
  const html = renderHoldingsScreen({
    homeCurrencyCode: "AUD",
    holdingsJson: ONE_HELD_ROW,
    holdingsViewState: "complete",
    summaryJson: FOOTER_FIXTURE,
    cashJson: null,
  });
  assert.match(html, /holdings-summary-footer/);
  // Follows the CGT/income "{code} reporting values" render-pinned
  // precedent, but names the REAL rule (the ACTUAL bare marker, derived
  // via currencyDisplayPrefix, not a claim of "no prefix" -- see B1).
  // UI-031B: wrapped in `sr-only`, not a visible row-tertiary paragraph.
  assert.match(
    html,
    /<p class="sr-only"><strong>AUD reporting values<\/strong> -- amounts shown as <strong>\$<\/strong> are this portfolio(?:&#x27;|&apos;|')s base currency; other currencies are flagged/,
  );
  assert.doesNotMatch(html, /class="row-tertiary summary-qualifier"/);
});

test("UI-032 render: the reachability statement names whichever currency is actually the portfolio's base (not hardcoded)", () => {
  const usdRow = JSON.parse(ONE_HELD_ROW);
  usdRow[0].homeBasis = holdingValue("available", "USD", "8000");
  usdRow[0].homePrice = holdingValue("available", "USD", "1000.00");
  usdRow[0].homeValue = holdingValue("available", "USD", "10000");
  const usdFooter = JSON.parse(FOOTER_FIXTURE);
  usdFooter.currencyCode = "USD";
  usdFooter.marketValue = holdingValue("available", "USD", "10000");
  usdFooter.costBasis = holdingValue("available", "USD", "8000");
  const html = renderHoldingsScreen({
    homeCurrencyCode: "USD",
    holdingsJson: JSON.stringify(usdRow),
    holdingsViewState: "complete",
    summaryJson: JSON.stringify(usdFooter),
    cashJson: null,
  });
  // A USD-base portfolio's bare marker is ALSO "$" (dollar-family bare
  // rule) -- the code name in the heading is what actually distinguishes
  // it, not the marker. UI-031B: sr-only, not visible.
  assert.match(
    html,
    /<p class="sr-only"><strong>USD reporting values<\/strong>/,
  );
  assert.doesNotMatch(html, /<strong>AUD reporting values<\/strong>/);
});

test("UI-032 render: a symbol-less base currency (e.g. CHF) still gets a real, non-empty marker -- 'currencyDisplayPrefix' never returns empty (B1 review fix)", () => {
  const chfRow = JSON.parse(ONE_HELD_ROW);
  chfRow[0].homeBasis = holdingValue("available", "CHF", "8000");
  chfRow[0].homePrice = holdingValue("available", "CHF", "1000.00");
  chfRow[0].homeValue = holdingValue("available", "CHF", "10000");
  const chfFooter = JSON.parse(FOOTER_FIXTURE);
  chfFooter.currencyCode = "CHF";
  chfFooter.marketValue = holdingValue("available", "CHF", "10000");
  chfFooter.costBasis = holdingValue("available", "CHF", "8000");
  const html = renderHoldingsScreen({
    homeCurrencyCode: "CHF",
    holdingsJson: JSON.stringify(chfRow),
    holdingsViewState: "complete",
    summaryJson: JSON.stringify(chfFooter),
    cashJson: null,
  });
  // UI-031B: sr-only, not visible.
  assert.match(
    html,
    /<p class="sr-only"><strong>CHF reporting values<\/strong>/,
  );
  // The marker itself falls back to the "CODE " form (never truly empty).
  assert.match(html, /amounts shown as <strong>CHF <\/strong> are/);
});

// ---------------------------------------------------------------------------
// The one case the footer can't cover: a cash-only portfolio (no held
// securities at all) never renders the summary footer (UI-031: undefined
// whenever there are no held securities). Documented and tested here --
// this screen also shows no bare-dollar figure at all in that state (the
// owner's own ruling: the cash subtotal display is intentionally dropped
// from this surface), so there is honestly nothing left to disambiguate.
// ---------------------------------------------------------------------------

test("UI-032 render: a cash-only portfolio (no held securities) shows neither the retired panel nor a dollar figure needing disambiguation", () => {
  const html = renderHoldingsScreen({
    homeCurrencyCode: "AUD",
    holdingsJson: "[]",
    holdingsViewState: "complete",
    summaryJson: null,
    cashJson: CASH_FIXTURE,
  });
  assert.match(html, /No security holdings\. Cash is shown separately\./);
  assert.doesNotMatch(html, /holdings-summary-footer/);
  assert.doesNotMatch(html, /Cash separate/);
  assert.doesNotMatch(html, /Securities subtotal:/);
});

// ---------------------------------------------------------------------------
// Now-dead server-side composition: the `holdingCoverage` passthrough that
// fed the deleted panel is gone from both ends of the pipe. The underlying
// `loadOwnedHoldings`/`coverage` computation in app/owned-holdings.ts is
// deliberately UNTOUCHED -- it still feeds
// `app/owned-income-projection.ts`'s `portfolioValueCoverage`, a different,
// still-live, independently-tested consumer.
// ---------------------------------------------------------------------------

test("UI-032: the dead holdingCoverage passthrough is gone from the shell and the workspace composition", async () => {
  const [shell, workspace] = await Promise.all([
    readFile(
      new URL("../app/components/portfolio-shell.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/authenticated-workspace.ts", import.meta.url),
      "utf8",
    ),
  ]);
  assert.doesNotMatch(shell, /holdingCoverage/);
  assert.doesNotMatch(workspace, /holdingCoverage/);
  // The underlying coverage computation stays -- it's still consumed by
  // owned-income-projection.ts's portfolioValueCoverage.
  const holdingsModule = await readFile(
    new URL("../app/owned-holdings.ts", import.meta.url),
    "utf8",
  );
  assert.match(holdingsModule, /coverage: securityCoverage/);
});

// ---------------------------------------------------------------------------
// CSS pin (review round-2 fix B2): the mobile `122px` reservation in
// `.holdings-summary-footer` and `.holding-rows` existed solely for the
// fixed mobile cash-summary card this task deleted -- on the OWNED
// holdings screen that band is now dead, so both mobile rules drop the
// 122px term (keeping only `env(safe-area-inset-bottom)` /
// `var(--holdings-summary-h)`). The PREVIEW holdings screen still renders
// that fixed card, so the shared base `.holding-rows` rule keeps its
// 122px term -- scoped to `.owned-holdings-layout .holding-rows` instead
// of edited in place, verified below by asserting BOTH the scoped
// override and the untouched shared rule.
// ---------------------------------------------------------------------------

test("UI-032 CSS: the owned holdings screen's mobile bottom offsets drop the dead 122px cash-card reservation, without touching the shared preview-mode rule", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  // .holdings-summary-footer is exclusive to the owned screen -- edited
  // in place, no 122px anywhere in its rule.
  const footerMatch = css.match(/\.holdings-summary-footer\s*{([^}]*)}/);
  assert.ok(footerMatch, "expected a .holdings-summary-footer rule");
  assert.doesNotMatch(footerMatch![1], /122px/);
  assert.match(footerMatch![1], /bottom:\s*env\(safe-area-inset-bottom\)/);

  // The scoped owned-only override drops the 122px term.
  const ownedOverrideMatch = css.match(
    /\.owned-holdings-layout \.holding-rows\s*{([^}]*)}/,
  );
  assert.ok(
    ownedOverrideMatch,
    "expected an .owned-holdings-layout .holding-rows override",
  );
  assert.doesNotMatch(ownedOverrideMatch![1], /122px/);
  assert.match(
    ownedOverrideMatch![1],
    /padding-bottom:\s*calc\(\s*var\(--holdings-summary-h\)\s*\+\s*env\(safe-area-inset-bottom\)\s*\)/,
  );

  // The shared base `.holding-rows` rule (still used by the preview
  // screen's still-live fixed cash card) is UNTOUCHED -- still reserves
  // 122px. Matches the FIRST `.holding-rows` block only (the shared
  // rule, not the scoped owned-only override matched above).
  const sharedRuleMatch = css.match(/(?<!layout )\.holding-rows\s*{([^}]*)}/);
  assert.ok(sharedRuleMatch, "expected the shared .holding-rows rule");
  assert.match(sharedRuleMatch![1], /122px/);
});
