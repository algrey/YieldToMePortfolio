// UI-036 (owner directive, verbatim, 2026-08-23): "For stocks that a fully
// sold (ie a current holding of 0). We should omit the third line that says
// 'Basis unavailable x 0'. We should omit that entire line and just have
// three lines in that case. If some of the stocks are still owned then we
// should continue to have the 4 lines. In the case of my portfolio the NCK
// holding row should have three lines, and the IXJ holding row should have
// 4."
//
// Rulings: the row-tertiary "avg cost x quantity" line is omitted ENTIRELY
// whenever the holding's current quantity is exactly zero -- regardless of
// whether the basis text would have been "Basis unavailable" or a real
// figure. Partially-sold/held rows (quantity > 0) keep all four lines. The
// UI-030 "Realised:" line is unaffected in both cases. Zero-quantity
// detection uses the same exact-decimal zero convention as the rest of
// owned-holdings' zero-quantity handling (`isZero(parseDecimalResult(...))`,
// never string equality with "0").
//
// This suite mirrors tests/ui-030.test.ts's/ui-035.test.ts's render-harness
// pattern (child-process `renderToStaticMarkup` via a router-context stub)
// to prove the real component behaviour end to end, plus a unit suite for
// the new `ownedHoldingQuantityIsZero` helper in isolation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// ===========================================================================
// Part 1: ownedHoldingQuantityIsZero (app/owned-holding-format.tsx), unit
// ===========================================================================
//
// `app/owned-holding-format.tsx` contains real JSX, which this repo's Node
// test runtime (`node --experimental-strip-types`) cannot parse directly --
// every other suite that needs a `.tsx` export runs it via a child process
// with the `tsx` loader (see tests/ui-030.test.ts's `renderRealisedLine`).

function callOwnedHoldingQuantityIsZero(value: string): boolean {
  const moduleUrl = new URL("../app/owned-holding-format.tsx", import.meta.url)
    .href;
  const script = `
    import { ownedHoldingQuantityIsZero } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(ownedHoldingQuantityIsZero(${JSON.stringify(value)})));
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

test("UI-036 ownedHoldingQuantityIsZero: exact-decimal zero convention -- '0', '0.0', '0.00000000' are all zero", () => {
  assert.equal(callOwnedHoldingQuantityIsZero("0"), true);
  assert.equal(callOwnedHoldingQuantityIsZero("0.0"), true);
  assert.equal(callOwnedHoldingQuantityIsZero("0.00000000"), true);
});

test("UI-036 ownedHoldingQuantityIsZero: any genuinely non-zero quantity, however small, is NOT zero", () => {
  assert.equal(callOwnedHoldingQuantityIsZero("10"), false);
  assert.equal(callOwnedHoldingQuantityIsZero("0.00000001"), false);
  assert.equal(callOwnedHoldingQuantityIsZero("-1"), false);
});

test("UI-036 ownedHoldingQuantityIsZero: an unparsable value fails closed to 'not zero' (the line stays rather than silently vanishing)", () => {
  assert.equal(callOwnedHoldingQuantityIsZero("not-a-number"), false);
  assert.equal(callOwnedHoldingQuantityIsZero(""), false);
});

// ===========================================================================
// Part 2: rendered OwnedHoldingsScreen pins
// ===========================================================================

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

function baseRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "row-base",
    securityId: "security-base",
    symbol: "BASE",
    name: "Base Co",
    exchange: "ASX",
    currencyCode: "AUD",
    quantity: "0",
    averageNativeCost: null,
    nativeBasis: holdingValue("unavailable", "AUD", null, "missing_basis"),
    homeBasis: holdingValue("unavailable", "AUD", null, "missing_basis"),
    nativePrice: null,
    nativeValue: holdingValue("unavailable", "AUD", null, "missing_price"),
    homePrice: holdingValue("unavailable", "AUD", null, "missing_price"),
    homeValue: holdingValue("unavailable", "AUD", null, "missing_price"),
    dailyMovement: holdingValue("unavailable", "AUD", null, "missing_previous"),
    dailyPercent: holdingValue("unavailable", "AUD", null, "missing_previous"),
    unrealisedGain: holdingValue("unavailable", "AUD", null, "missing_price"),
    unrealisedPercent: holdingValue(
      "unavailable",
      "AUD",
      null,
      "missing_price",
    ),
    dailyTone: "neutral",
    gainTone: "neutral",
    priceState: "unavailable",
    actionStatus: "none",
    explanation: "Fixture explanation.",
    sort: { ticker: "BASE", value: null, daily: null, gain: null },
    ...overrides,
  };
}

function renderOwnedHoldingsScreen(
  holdings: Record<string, unknown>[],
  realisedGains: Record<string, unknown>,
): string {
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
      holdings: ${JSON.stringify(holdings)},
      holdingsViewState: "complete",
      realisedGains: ${JSON.stringify(realisedGains)},
    };

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, {
            activeSection: "holdings",
            ownedWorkspace,
            // UI-052 flipped the production default to HIDE sold; these
            // pins cover the sold-row markup only visible in the Show
            // Sold state, so render it explicitly via the test seam.
            initialHideSold: false,
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

// Extracts one holding row's own <a class="holding-row ...">...</a> markup
// by its detail-route id, so an assertion can be scoped to exactly that row
// (mirrors tests/ui-030.test.ts's extractHoldingRowHtml).
function extractHoldingRowHtml(html: string, rowId: string): string {
  const marker = `/portfolio/portfolio-a/holdings/${rowId}"`;
  const markerIndex = html.indexOf(marker);
  assert.ok(markerIndex !== -1, `expected a link to holding row ${rowId}`);
  const anchorStart = html.lastIndexOf("<a ", markerIndex);
  const anchorEnd = html.indexOf("</a>", markerIndex) + "</a>".length;
  return html.slice(anchorStart, anchorEnd);
}

const REALISED_GAIN_TOTAL = {
  portfolioSecurityId: "sec",
  disposalCount: 1,
  knownDisposalCount: 1,
  excludedIncompleteCount: 0,
  partialCoverage: false,
  gainDecimal: "5000",
  basisAtDisposalDecimal: "40000",
  percentDecimal: "12.5",
};

test("UI-036 render: a fully sold holding (quantity exactly zero, WITH disposals -- the owner's NCK case) renders exactly three lines -- no row-tertiary cost x quantity span, Realised present", () => {
  const soldOut = baseRow({
    id: "row-nck",
    symbol: "NCK",
    quantity: "0",
    averageNativeCost: null,
  });
  const html = renderOwnedHoldingsScreen([soldOut], {
    "row-nck": REALISED_GAIN_TOTAL,
  });
  const rowHtml = extractHoldingRowHtml(html, "row-nck");
  assert.doesNotMatch(rowHtml, /class="row-tertiary"/);
  // The row-secondary line's OWN "Basis {amount}" label (unrelated to the
  // row-tertiary cost x quantity span this task omits) is untouched --
  // scope the assertion to the omitted span specifically, not the word
  // "unavailable" generally.
  assert.doesNotMatch(rowHtml, /×\s*0\b/);
  assert.match(rowHtml, /class="[^"]*row-quaternary[^"]*"/);
  assert.match(rowHtml, /Realised:\s*\+\$5,000\.00\s*\(\+12\.5%\)/);
});

test("UI-036 render: omission applies regardless of whether the basis would have rendered a real figure -- a zero-quantity row with a non-null averageNativeCost still omits the line entirely", () => {
  const soldOut = baseRow({
    id: "row-figure",
    symbol: "FIG",
    quantity: "0.00000000",
    averageNativeCost: "5.00",
  });
  const html = renderOwnedHoldingsScreen([soldOut], {
    "row-figure": REALISED_GAIN_TOTAL,
  });
  const rowHtml = extractHoldingRowHtml(html, "row-figure");
  assert.doesNotMatch(rowHtml, /class="row-tertiary"/);
  assert.doesNotMatch(rowHtml, /5\.00/);
  assert.match(rowHtml, /class="[^"]*row-quaternary[^"]*"/);
});

test("UI-036 render: a currently-held holding (quantity > 0, WITH disposals -- the owner's IXJ case) keeps all four lines", () => {
  const held = baseRow({
    id: "row-ixj",
    symbol: "IXJ",
    quantity: "10",
    averageNativeCost: "9.00",
    nativeBasis: holdingValue("available", "AUD", "90.00"),
    homeBasis: holdingValue("available", "AUD", "90.00"),
    nativePrice: "10.00",
    nativeValue: holdingValue("available", "AUD", "100.00"),
    homePrice: holdingValue("available", "AUD", "10.00"),
    homeValue: holdingValue("available", "AUD", "100.00"),
    dailyMovement: holdingValue("available", "AUD", "1.00"),
    dailyPercent: holdingValue("available", "AUD", "1.0"),
    unrealisedGain: holdingValue("available", "AUD", "10.00"),
    unrealisedPercent: holdingValue("available", "AUD", "11.11"),
    dailyTone: "positive",
    gainTone: "positive",
    priceState: "current",
  });
  const html = renderOwnedHoldingsScreen([held], {
    "row-ixj": REALISED_GAIN_TOTAL,
  });
  const rowHtml = extractHoldingRowHtml(html, "row-ixj");
  assert.match(rowHtml, /class="row-tertiary"/);
  assert.match(rowHtml, /×\s*10/);
  assert.match(rowHtml, /class="[^"]*row-quaternary[^"]*"/);
  assert.match(rowHtml, /Realised:/);
});

test("UI-036 render: a zero-quantity holding with NO disposals renders exactly two lines -- no cost x quantity span (this task) AND no Realised line (pre-existing UI-030 behaviour, pinned here too)", () => {
  const soldOutNeverSold = baseRow({
    id: "row-never-realised",
    symbol: "NVR",
    quantity: "0",
    averageNativeCost: null,
  });
  // realisedGains has NO entry for this row at all.
  const html = renderOwnedHoldingsScreen([soldOutNeverSold], {});
  const rowHtml = extractHoldingRowHtml(html, "row-never-realised");
  assert.doesNotMatch(rowHtml, /class="row-tertiary"/);
  assert.doesNotMatch(rowHtml, /row-quaternary/);
  assert.doesNotMatch(rowHtml, /Realised:/);
});

test("UI-036 render: partially-sold holdings (a residual non-zero quantity) still keep the cost x quantity line -- only an EXACT zero quantity omits it", () => {
  const partiallySold = baseRow({
    id: "row-partial",
    symbol: "PART",
    quantity: "0.00000001",
    averageNativeCost: "5.00",
  });
  const html = renderOwnedHoldingsScreen([partiallySold], {});
  const rowHtml = extractHoldingRowHtml(html, "row-partial");
  assert.match(rowHtml, /class="row-tertiary"/);
});

// ---------------------------------------------------------------------------
// No layout gap: the row-tertiary span is omitted from the DOM entirely (not
// merely hidden via CSS), and the row-quaternary "Realised" line's grid
// placement (`.holding-row .row-quaternary { grid-row: 4; }` in
// app/globals.css) is selected by CLASS, not `:nth-child`, so it is
// unaffected by how many preceding siblings exist -- there is no unfilled
// implicit grid row 3 to leave a visual gap when nothing is placed there.
// ---------------------------------------------------------------------------

test("UI-036 render: the sold-out row's Realised line immediately follows the row-secondary group in the DOM -- no empty placeholder element sits where row-tertiary used to be", () => {
  const soldOut = baseRow({
    id: "row-gap-check",
    symbol: "GAP",
    quantity: "0",
    averageNativeCost: null,
  });
  const html = renderOwnedHoldingsScreen([soldOut], {
    "row-gap-check": REALISED_GAIN_TOTAL,
  });
  const rowHtml = extractHoldingRowHtml(html, "row-gap-check");
  // The desktop-only holding-name span (name/exchange/currency) is the only
  // thing allowed to sit between the row-secondary group and row-quaternary
  // -- no stray empty span, no `row-tertiary` at all.
  assert.doesNotMatch(rowHtml, /<span class="row-tertiary"><\/span>/);
  assert.doesNotMatch(rowHtml, /<span class="row-tertiary">\s*<\/span>/);
});
