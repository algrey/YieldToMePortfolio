import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  currencyDisplayPrefix,
  isBaseCurrencyDisplay,
  WATCHLIST_NO_PORTFOLIO_BASE_CURRENCY,
} from "../app/currency-display.ts";
import { formatIncomeMoney } from "../app/income-format.ts";

// UI-026 (owner directive, verbatim): "If the currency is set to AUD it
// should not show 'AUD' it should show $number (eg: $4.21). If amounts are
// USD, then it should show the USD symbol. Visa versa if the portfolio is
// set to USD it should only show the currency for AUD." Orchestrator
// ruling: relative to the ACTIVE PORTFOLIO's base currency -- a bare symbol
// for the base currency, a flagged/coded form for anything else.

// ---------------------------------------------------------------------------
// 1. The shared symbol table / rule (`app/currency-display.ts`).
// ---------------------------------------------------------------------------

test("UI-026: a base-AUD portfolio renders a bare '$' for AUD and a flagged 'US$' for USD", () => {
  assert.equal(currencyDisplayPrefix("AUD", "AUD"), "$");
  assert.equal(currencyDisplayPrefix("USD", "AUD"), "US$");
});

test("UI-026: a base-USD portfolio renders a bare '$' for USD and a flagged 'A$' for AUD", () => {
  assert.equal(currencyDisplayPrefix("USD", "USD"), "$");
  assert.equal(currencyDisplayPrefix("AUD", "USD"), "A$");
});

test("UI-026: every dollar-family currency gets its own AU-style flag when foreign, relative to whichever base is active", () => {
  assert.equal(currencyDisplayPrefix("NZD", "AUD"), "NZ$");
  assert.equal(currencyDisplayPrefix("CAD", "AUD"), "C$");
  assert.equal(currencyDisplayPrefix("SGD", "AUD"), "S$");
  assert.equal(currencyDisplayPrefix("HKD", "AUD"), "HK$");
  // And bare when each is itself the base.
  assert.equal(currencyDisplayPrefix("NZD", "NZD"), "$");
  assert.equal(currencyDisplayPrefix("CAD", "CAD"), "$");
  assert.equal(currencyDisplayPrefix("SGD", "SGD"), "$");
  assert.equal(currencyDisplayPrefix("HKD", "HKD"), "$");
});

test("UI-026: non-dollar currencies with a well-known symbol render that symbol whether base or foreign -- already unambiguous, no flag needed", () => {
  assert.equal(currencyDisplayPrefix("GBP", "AUD"), "£");
  assert.equal(currencyDisplayPrefix("GBP", "GBP"), "£");
  assert.equal(currencyDisplayPrefix("EUR", "AUD"), "€");
  assert.equal(currencyDisplayPrefix("EUR", "EUR"), "€");
  assert.equal(currencyDisplayPrefix("JPY", "AUD"), "¥");
  assert.equal(currencyDisplayPrefix("JPY", "JPY"), "¥");
});

test("UI-026: a currency with no well-known symbol keeps the pre-existing 'CODE amount' fallback form, base or foreign -- never stripped of its ISO code", () => {
  assert.equal(currencyDisplayPrefix("XAG", "AUD"), "XAG ");
  assert.equal(currencyDisplayPrefix("XAG", "XAG"), "XAG ");
  assert.equal(currencyDisplayPrefix("ZAR", "USD"), "ZAR ");
});

test("UI-026: currency codes compare case-insensitively", () => {
  assert.equal(currencyDisplayPrefix("aud", "AUD"), "$");
  assert.equal(currencyDisplayPrefix("usd", "aud"), "US$");
  assert.equal(isBaseCurrencyDisplay("aud", "AUD"), true);
  assert.equal(isBaseCurrencyDisplay("AUD", "usd"), false);
});

test("UI-026: the watchlist's documented no-portfolio fallback base is AUD", () => {
  assert.equal(WATCHLIST_NO_PORTFOLIO_BASE_CURRENCY, "AUD");
});

// ---------------------------------------------------------------------------
// 2. `formatIncomeMoney` (Income screens) -- unavailable states untouched,
//    signed figures still carry an explicit +/-, base vs foreign amounts
//    apply the shared rule.
// ---------------------------------------------------------------------------

test("UI-026: formatIncomeMoney renders a bare symbol for a base-currency amount and a flagged symbol for a foreign one", () => {
  assert.equal(formatIncomeMoney("AUD", "AUD", "1234.5"), "$1,234.50");
  assert.equal(formatIncomeMoney("USD", "AUD", "1234.5"), "US$1,234.50");
  assert.equal(formatIncomeMoney("AUD", "USD", "1234.5"), "A$1,234.50");
});

test("UI-026: formatIncomeMoney's unavailable/em-dash states are untouched by the symbol change", () => {
  assert.equal(formatIncomeMoney("AUD", "AUD", null), "Unavailable");
  assert.equal(
    formatIncomeMoney("AUD", "AUD", null, { unavailableLabel: "Unknown" }),
    "Unknown",
  );
});

test("UI-026: formatIncomeMoney still carries an explicit sign alongside the new prefix", () => {
  assert.equal(
    formatIncomeMoney("AUD", "AUD", "10", { signed: true }),
    "$+10.00",
  );
  assert.equal(formatIncomeMoney("AUD", "AUD", "-10"), "$-10.00");
});

// ---------------------------------------------------------------------------
// 3. Sweep: rendered owned-mode screens no longer show the old bare
//    "CODE amount" form for a BASE-currency figure, and still show a
//    flagged form for a genuinely foreign one. `ownedHoldingAmount` (the
//    holdings list / holding detail formatter) is exercised here through
//    the real `HoldingDetailScreen` component -- it lives in a `.tsx`
//    module, which this test runtime cannot import directly (see the
//    render-via-child-process trick every other `.tsx` component test in
//    this suite already uses).
// ---------------------------------------------------------------------------

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

// The literal old-style rendering this task replaces: an ISO code directly
// followed by a space and a digit (e.g. "AUD 4.21", "USD 10.00"). A
// genuinely foreign amount is EXPECTED to still show its code as part of a
// flagged prefix (e.g. "US$10.00") or, for a no-symbol currency, the
// pre-existing "CODE amount" fallback -- so this sweep checks specifically
// for the BASE currency's code leaking through in that old bare form,
// which must never happen once a bare "$" is available for it.
function assertNoBareCodePrefix(html: string, baseCurrencyCode: string) {
  const pattern = new RegExp(`${baseCurrencyCode} [\\d,\\-+−]`);
  assert.doesNotMatch(
    html,
    pattern,
    `expected no leftover "${baseCurrencyCode} <amount>" code-prefix form for a base-currency figure`,
  );
}

test("UI-026 sweep: the Capital gains screen (base AUD) never renders 'AUD <amount>' for its base-currency figures", () => {
  const html = renderComponent(
    "CapitalGainsScreen",
    "../app/components/capital-gains-screen.tsx",
    {
      portfolioId: "portfolio-a",
      holdingsHref: "/portfolio/portfolio-a/holdings",
      result: {
        status: "ok",
        history: {
          today: "2026-08-14",
          financialYearStartMonth: 7,
          baseCurrencyCode: "AUD",
          disposalCount: 1,
          fyTotals: [
            {
              endingYear: 2026,
              label: "FY26",
              window: { startDate: "2025-07-01", endDate: "2026-06-30" },
              rows: [
                {
                  allocationId: "alloc-a",
                  portfolioSecurityId: "ps-alpha",
                  securitySymbol: "ALPHA",
                  securityName: "Alpha Holdings Ltd",
                  acquiredDate: "2022-01-10",
                  disposedDate: "2026-02-01",
                  quantityDecimal: "100",
                  proceedsDecimal: "1600.00",
                  basisDecimal: "600.00",
                  feeDecimal: "0",
                  taxDecimal: "0",
                  gainDecimal: "1000.00",
                  basisStatus: "complete",
                  holdingPeriodEligible: true,
                  discountThresholdDate: "2023-01-11",
                  eligibility: "discount_eligible",
                },
              ],
              disposalCount: 1,
              excludedIncompleteCount: 0,
              excludedIncompleteSecurityNames: [],
              partialCoverage: false,
              totalDiscountableGainsGrossDecimal: "1000.00",
              totalNonDiscountableGainsGrossDecimal: "0",
              totalLossesDecimal: "0",
              lossAppliedToNonDiscountableDecimal: "0",
              lossAppliedToDiscountableDecimal: "0",
              remainingNonDiscountableAfterLossDecimal: "0",
              remainingDiscountableAfterLossDecimal: "1000.00",
              discountRateDecimal: "0.50",
              discountAppliedDecimal: "500.00",
              netCapitalGainEstimateDecimal: "500.00",
              unabsorbedLossDecimal: "0",
            },
          ],
          historyCompleteFrom: "2025-07-01",
        },
      },
    },
  );
  assertNoBareCodePrefix(html, "AUD");
  assert.match(html, /\$1,000\.00/);
  assert.match(html, /\$500\.00/);
  // Anchored positive assertion: an actual rendered cell boundary, not just
  // a loose substring match elsewhere in the page -- makes the base-vs-
  // foreign distinction self-evident (a foreign amount here would instead
  // render flagged, e.g. ">US$1,000.00<").
  assert.match(html, />\$1,000\.00</);
});

test("UI-026 sweep: the portfolio-wide dividends list (base AUD, one foreign USD row) never renders bare 'AUD <amount>', and flags the foreign one", () => {
  const html = renderComponent(
    "OwnedDividendList",
    "../app/components/owned-dividend-list.tsx",
    {
      portfolioId: "pa",
      baseCurrencyCode: "AUD",
      today: "2026-08-19",
      truncated: false,
      totalCount: 2,
      rows: [
        {
          id: "row-base",
          portfolioSecurityId: "psa1",
          symbol: "ALPHA",
          currencyCode: "AUD",
          paymentDate: "2026-06-15",
          exDate: null,
          notPaid: false,
          cashDecimal: "42.00",
          frankingTotalDecimal: "18.00",
          frankingDerivedZero: false,
          grossDecimal: "60.00",
          source: "auto",
          excluded: false,
          originalCurrencyCode: null,
          fxRateToPortfolioDecimal: null,
          fxRateSource: null,
        },
        {
          id: "row-foreign",
          portfolioSecurityId: "psa2",
          symbol: "BETA",
          currencyCode: "USD",
          paymentDate: "2026-05-01",
          exDate: null,
          notPaid: false,
          cashDecimal: "12.00",
          frankingTotalDecimal: null,
          frankingDerivedZero: false,
          grossDecimal: "12.00",
          source: "imported",
          excluded: false,
          originalCurrencyCode: null,
          fxRateToPortfolioDecimal: null,
          fxRateSource: null,
        },
      ],
    },
  );
  assertNoBareCodePrefix(html, "AUD");
  assert.match(html, /\$42\.00/);
  assert.match(html, /US\$12\.00/);
  // Anchored: the base row's cell is bare, the foreign row's is flagged --
  // both at real cell boundaries, not a loose substring elsewhere.
  assert.match(html, />\$42\.00</);
  assert.match(html, />US\$12\.00</);
});

test("UI-026 sweep: a holding's Details screen (base AUD, a USD holding) never renders bare 'AUD <amount>' for its home-currency figures, and flags the native USD ones", () => {
  const html = renderComponent(
    "HoldingDetailScreen",
    "../app/components/holding-detail.tsx",
    {
      portfolioId: "portfolio-a",
      portfolioSecurityId: "holding-pls",
      symbol: "PLS",
      subtitle: "Pilbara Fixture · XASX · USD",
      homeCurrencyCode: "AUD",
      initialView: "home",
      holding: {
        id: "holding-pls",
        securityId: "security-pls",
        symbol: "PLS",
        name: "Pilbara Fixture",
        exchange: "XASX",
        currencyCode: "USD",
        quantity: "1000",
        averageNativeCost: "1.965",
        nativeBasis: {
          status: "available",
          currencyCode: "USD",
          value: "1965.00",
          reason: null,
        },
        homeBasis: {
          status: "available",
          currencyCode: "AUD",
          value: "2900.00",
          reason: null,
        },
        nativePrice: "4.26",
        nativeValue: {
          status: "available",
          currencyCode: "USD",
          value: "4260.00",
          reason: null,
        },
        homePrice: {
          status: "available",
          currencyCode: "AUD",
          value: "6.30",
          reason: null,
        },
        homeValue: {
          status: "available",
          currencyCode: "AUD",
          value: "6300.00",
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
        sort: {
          ticker: "PLS",
          value: "6300.00",
          daily: "2.90",
          gain: "117.05",
        },
      },
    },
  );
  assertNoBareCodePrefix(html, "AUD");
  // Home-currency (base) figures render bare.
  assert.match(html, /\$6,300\.00/); // home value
  assert.match(html, /\$\+2,340\.00/); // unrealised gain, signed
  // Anchored: an actual rendered cell boundary, not a loose substring.
  assert.match(html, />\$6,300\.00</);
  // The average-cost line always renders in the security's own NATIVE
  // currency regardless of the home/native view toggle -- stays flagged,
  // never stripped of its USD identity. UI-027: the integral quantity
  // ("1000") now renders bare ("1,000"), not the old fixed-4dp
  // "1,000.0000" -- flipped honestly from the pre-UI-027 expectation.
  assert.match(html, /US\$1\.965 × 1,000</);
});
