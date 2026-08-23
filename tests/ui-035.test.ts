// UI-035 — Holdings layout: reclaim the removed aside's column at
// intermediate widths (owner-reported).
//
// Owner report, verbatim: "Now that we removed the side/bottom summary
// element, the holding table does not squeeze down gracefully as I reduce
// the width of the browser. There is a large gap on the right that stays
// until the table is very thin. I suspect we removed the element, but left
// the box it was in."
//
// Root cause: app/globals.css's `@media (min-width: 700px)` block sets
// `.holdings-layout { grid-template-columns: minmax(0, 1fr) 318px; }` -- a
// two-column desktop grid sized for the `.portfolio-summary` aside. UI-032
// removed that aside from the OWNED holdings screen entirely, but this
// shared grid rule (still correctly used by PREVIEW mode, which still
// renders `.portfolio-summary` as its second grid child -- see
// `<PortfolioSummary>` inside the prototype `HoldingsScreen`) was left in
// place, reserving a permanent, empty 318px + 20px gap column on the right
// of the owned holdings list at every width from 700px up to whatever width
// the browser's minimum-content shrinking finally forces a wrap -- matching
// the owner's "stays until the table is very thin" report exactly (below
// 700px `.holdings-layout` has no grid rule at all and is already a single,
// full-width column).
//
// Fix: a scoped `.owned-holdings-layout { grid-template-columns: minmax(0,
// 1fr); }` override inside the same media query collapses the dead second
// column on the OWNED screen only. `.holdings-list` (and its child sticky
// `.holdings-summary-footer`, UI-031) are unpositioned/unwidthed elements
// that simply fill their grid track, so reclaiming the track's width is
// sufficient -- no separate footer width/left/right rule needed. Preview
// mode's bare `.holdings-layout` rule (no `owned-holdings-layout` class) is
// untouched and keeps its two-column behaviour.
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

function renderOwnedHoldingsScreen(): string {
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
      homeCurrencyCode: "AUD",
      holdingCurrencyView: "native",
      settingsVersion: 1,
      activePortfolio: {
        id: "portfolio-a",
        name: "Fixture Portfolio",
        homeCurrencyCode: "AUD",
        baseCurrencyCode: "AUD",
        timezone: "Australia/Sydney",
        accountingMethod: "fifo",
        status: "active",
        version: 1,
      },
      portfolios: [
        {
          id: "portfolio-a",
          name: "Fixture Portfolio",
          homeCurrencyCode: "AUD",
          status: "active",
          version: 1,
        },
      ],
      holdings: ${ONE_HELD_ROW},
      holdingsViewState: "complete",
      holdingsSummary: undefined,
      cash: undefined,
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

function renderPreviewHoldingsScreen(): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, {
            activeSection: "holdings",
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

// ---------------------------------------------------------------------------
// CSS pins
// ---------------------------------------------------------------------------

test("UI-035 CSS: the shared .holdings-layout desktop rule still reserves the 318px aside column (preview mode still needs it)", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const sharedMatch = css.match(/\.holdings-layout\s*{([^}]*)}/);
  assert.ok(sharedMatch, "expected the shared .holdings-layout rule");
  assert.match(
    sharedMatch![1],
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*318px/,
  );
});

test("UI-035 CSS: a scoped .owned-holdings-layout override collapses the dead second column to full width, inside the same 700px breakpoint", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const ownedOverrideMatch = css.match(/\.owned-holdings-layout\s*{([^}]*)}/);
  assert.ok(
    ownedOverrideMatch,
    "expected an .owned-holdings-layout grid override",
  );
  assert.match(
    ownedOverrideMatch![1],
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
  );
  assert.doesNotMatch(ownedOverrideMatch![1], /318px/);

  // Both rules live inside the same `@media (min-width: 700px)` block --
  // the override must not accidentally end up outside it (e.g. it would
  // then also need to override the sub-700px case, which already has no
  // grid rule at all).
  const mediaBlockStart = css.indexOf("@media (min-width: 700px)");
  assert.ok(mediaBlockStart >= 0, "expected the 700px breakpoint");
  const sharedIndex = css.indexOf(".holdings-layout {", mediaBlockStart);
  const overrideIndex = css.indexOf(
    ".owned-holdings-layout {",
    mediaBlockStart,
  );
  assert.ok(sharedIndex > mediaBlockStart);
  assert.ok(
    overrideIndex > sharedIndex,
    "expected the owned override to follow the shared rule inside the same breakpoint",
  );
});

test("UI-035 CSS: the UI-031 sticky summary footer still has no explicit width/left/right rule of its own (it simply fills its now-reclaimed grid track)", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const footerMatch = css.match(/\.holdings-summary-footer\s*{([^}]*)}/);
  assert.ok(footerMatch, "expected the .holdings-summary-footer rule");
  assert.doesNotMatch(footerMatch![1], /\bwidth:/);
  assert.doesNotMatch(footerMatch![1], /\bleft:/);
  assert.doesNotMatch(footerMatch![1], /\bright:/);
  // The last-row clipping reservation (UI-031/UI-032) is untouched by this
  // task -- still keyed off --holdings-summary-h, not the grid column.
  const ownedRowsMatch = css.match(
    /\.owned-holdings-layout \.holding-rows\s*{([^}]*)}/,
  );
  assert.ok(ownedRowsMatch, "expected the owned .holding-rows override");
  assert.match(
    ownedRowsMatch![1],
    /padding-bottom:\s*calc\(\s*var\(--holdings-summary-h\)\s*\+\s*env\(safe-area-inset-bottom\)\s*\)/,
  );
});

// ---------------------------------------------------------------------------
// Rendered pins
// ---------------------------------------------------------------------------

test("UI-035 render: the owned holdings screen wraps in both .holdings-layout and .owned-holdings-layout, with no .portfolio-summary aside", () => {
  const html = renderOwnedHoldingsScreen();
  assert.match(html, /class="holdings-layout owned-holdings-layout"/);
  assert.doesNotMatch(html, /class="portfolio-summary"/);
  assert.doesNotMatch(html, /aria-label="Portfolio totals"/);
});

test("UI-035 render: preview mode's holdings screen keeps its bare .holdings-layout wrapper and its .portfolio-summary aside, unchanged", () => {
  const html = renderPreviewHoldingsScreen();
  assert.match(html, /class="holdings-layout"/);
  assert.doesNotMatch(html, /class="holdings-layout owned-holdings-layout"/);
  assert.match(html, /class="portfolio-summary"/);
  assert.match(html, /aria-label="Portfolio totals"/);
});
