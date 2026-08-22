/** UI-027 — Share quantities display as whole numbers unless genuinely
 * fractional (owner directive, verbatim): "All numbers of stocks held
 * should be displayed as whole numbers with no decimals... if we handle
 * fractional stocks, it should display a whole number, UNLESS the stock is
 * fractional."
 *
 * Covers the ONE shared implementation (`app/quantity-format.ts`'s
 * `formatQuantityDisplay`, re-exported as `ownedHoldingQuantity` from
 * `app/owned-holding-format.tsx` for `.tsx` call sites) and every surface
 * migrated onto it: the holdings row (already delivered inline during the
 * UI-028 review -- unit-tested here via the shared helper directly, since
 * `tests/wlt-001.test.ts` already pins that exact call site's rendered
 * output), the holding Details sheet and Transactions list
 * (`app/components/holding-detail.tsx`/`holding-transactions.tsx`, both
 * previously fixed-4dp via `ownedHoldingDecimal`), a dividend history row
 * (`app/components/security-dividends-tab.tsx`'s `formatShares`, previously
 * fixed-4dp with no never-fake-zero guard), and a Capital gains row
 * (`app/components/capital-gains-screen.tsx`'s `formatQuantity`, already
 * correct pre-UI-027 but now delegating to the shared implementation
 * instead of its own duplicate).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { formatQuantityDisplay } from "../app/quantity-format.ts";
import { formatQuantity } from "../app/income-format.ts";
import { formatShares } from "../app/dividend-history-prefill.ts";

// ---------------------------------------------------------------------------
// Part 1: the shared helper, `formatQuantityDisplay`.
// ---------------------------------------------------------------------------

test("UI-027: an integral quantity renders with NO decimal places at all, however many trailing zeros the stored string carries", () => {
  assert.equal(formatQuantityDisplay("150.00000000"), "150");
  assert.equal(formatQuantityDisplay("150"), "150");
  assert.equal(formatQuantityDisplay("1000"), "1,000"); // thousands-grouped
});

test("UI-027: a genuinely fractional quantity keeps its real trimmed significant digits, never rounded to a fake whole number", () => {
  assert.equal(formatQuantityDisplay("150.10"), "150.1");
  assert.equal(formatQuantityDisplay("0.5"), "0.5");
  assert.equal(formatQuantityDisplay("150.5"), "150.5");
  assert.equal(formatQuantityDisplay("0.333300"), "0.3333");
});

// UI-027 review (2026-08-22, BLOCKING fix): the ORIGINAL implementation
// capped the trim at a fixed 6dp before trimming, which both contradicted
// `docs/CALCULATIONS.md`'s "display quantity up to the security/source
// scale" rule and silently rounded a sufficiently precise real quantity to
// a FAKE WHOLE NUMBER (e.g. "1.0000001" -> "1" -- exactly the misstatement
// UI-027 exists to prevent). Fixed by making `formatDecimalExact` (full
// source-scale precision, no fixed rounding at all) the ONLY path, so these
// drill cases -- each carrying more than 6 significant fractional digits --
// must render EXACTLY, not rounded to any cap.
test("UI-027 review drill cases: a quantity with more than 6 significant fractional digits renders at its full exact source scale, never rounded to a fixed cap", () => {
  assert.equal(formatQuantityDisplay("1.0000001"), "1.0000001");
  assert.equal(formatQuantityDisplay("0.9999999"), "0.9999999");
  assert.equal(formatQuantityDisplay("10.00000005"), "10.00000005");
  assert.equal(formatQuantityDisplay("0.12345678"), "0.12345678");
});

test("UI-027: zero renders as a bare '0', never '0.000000'", () => {
  assert.equal(formatQuantityDisplay("0"), "0");
  assert.equal(formatQuantityDisplay("0.000000"), "0");
});

test("UI-027 (never a fake zero, now structural rather than a fallback): a genuinely non-zero quantity, however tiny, never collapses to '0' -- full exact source-scale formatting never rounds a non-zero value away in the first place", () => {
  // Mirrors `app/owned-holding-format.tsx`'s `ownedHoldingDecimalNeverFakeZero`
  // precedent (AGENTS.md: a known non-zero value rounded away to nothing
  // must never render as "0") -- but here there is no rounding step to
  // guard against at all, since `formatDecimalExact` reads the value's own
  // source scale rather than a fixed display scale.
  assert.equal(formatQuantityDisplay("0.0000001"), "0.0000001");
  assert.notEqual(formatQuantityDisplay("0.0000001"), "0");
});

test("UI-027: null renders the (optionally customised) unavailable label, never a fabricated quantity", () => {
  assert.equal(formatQuantityDisplay(null), "—");
  assert.equal(formatQuantityDisplay(null, "Unknown"), "Unknown");
});

test("UI-027: a malformed decimal string falls back to the unavailable label rather than throwing during render", () => {
  assert.equal(formatQuantityDisplay("not-a-number"), "—");
  assert.equal(
    formatQuantityDisplay("not-a-number", "Unavailable"),
    "Unavailable",
  );
});

test("UI-027: a negative fractional quantity keeps its sign and trims correctly", () => {
  assert.equal(formatQuantityDisplay("-150.500"), "-150.5");
});

// `ownedHoldingQuantity` (`app/owned-holding-format.tsx`'s thin re-export
// of `formatQuantityDisplay` for `.tsx` call sites -- holdings row/sheet/
// transactions) is a real `.tsx` module and so cannot be imported directly
// by this file (this repo's `node --experimental-strip-types` test runtime
// cannot parse JSX, and `owned-holding-format.tsx` contains real JSX in
// `ownedHoldingPercent` -- see `app/quantity-format.ts`'s header comment).
// It is instead exercised end-to-end by the render-pin tests below (the
// holding Details sheet and Transactions list both call it).

test("UI-027: `formatQuantity` (app/income-format.ts, the CGT screens' formatter) delegates to the same shared trim rule, keeping its own 'Unavailable' default label", () => {
  assert.equal(formatQuantity("150.00000000"), "150");
  assert.equal(formatQuantity("150.10"), "150.1");
  assert.equal(formatQuantity(null), "Unavailable");
  assert.equal(formatQuantity(null, "Unknown"), "Unknown");
});

test("UI-027: `formatShares` (app/dividend-history-prefill.ts, the dividend forms/history formatter) delegates to the same shared trim rule, keeping its own raw-string fallback on a malformed value", () => {
  assert.equal(formatShares("150.00000000"), "150");
  assert.equal(formatShares("150.10"), "150.1");
  assert.equal(formatShares("garbage"), "garbage");
});

// ---------------------------------------------------------------------------
// Part 2: per-surface render pins.
// ---------------------------------------------------------------------------

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

function renderComponent(
  componentName: string,
  componentPath: string,
  props: unknown,
  withRouterStub = false,
): string {
  const componentUrl = new URL(componentPath, import.meta.url).href;
  const script = withRouterStub
    ? `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ${componentName} } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(${componentName}, props),
        ),
      ),
    );
  `
    : `
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

// --- Holding Details sheet --------------------------------------------------

function holdingValue(
  status: "available" | "unavailable",
  currencyCode: string,
  value: string | null,
) {
  return { status, currencyCode, value, reason: null };
}

const fractionalDetailHolding = {
  id: "holding-drp",
  securityId: "security-drp",
  symbol: "DRP",
  name: "DRP Fixture",
  exchange: "XASX",
  currencyCode: "AUD",
  quantity: "150.5", // a genuine DRP fractional share
  averageNativeCost: "9.00",
  nativeBasis: holdingValue("available", "AUD", "1354.50"),
  homeBasis: holdingValue("available", "AUD", "1354.50"),
  nativePrice: "10.00",
  nativeValue: holdingValue("available", "AUD", "1505.00"),
  homePrice: holdingValue("available", "AUD", "10.00"),
  homeValue: holdingValue("available", "AUD", "1505.00"),
  dailyMovement: holdingValue("available", "AUD", "12.34"),
  dailyPercent: holdingValue("available", "AUD", "3.5"),
  unrealisedGain: holdingValue("available", "AUD", "150.50"),
  unrealisedPercent: holdingValue("available", "AUD", "11.11"),
  dailyTone: "positive",
  gainTone: "positive",
  priceState: "current",
  actionStatus: "none",
  explanation: "Fixture explanation.",
  sort: { ticker: "DRP", value: "1505.00", daily: "3.5", gain: "11.11" },
};

test("UI-027: the holding Details sheet renders a genuinely fractional quantity's exact trimmed digits, never rounded to a fake whole number (was fixed-4dp via ownedHoldingDecimal pre-UI-027)", () => {
  const html = renderComponent(
    "HoldingDetailScreen",
    "../app/components/holding-detail.tsx",
    {
      portfolioId: "portfolio-a",
      holding: fractionalDetailHolding,
      symbol: "DRP",
      subtitle: "DRP Fixture · XASX · AUD",
      portfolioSecurityId: "holding-drp",
      homeCurrencyCode: "AUD",
      initialView: "native",
    },
  );
  assert.match(html, /<dd>150\.5<\/dd>/);
  assert.doesNotMatch(html, /150\.5000/);
  assert.match(html, /\$9 × 150\.5/);
});

test("UI-027: the holding Details sheet still renders an INTEGRAL quantity with no decimal point at all", () => {
  const html = renderComponent(
    "HoldingDetailScreen",
    "../app/components/holding-detail.tsx",
    {
      portfolioId: "portfolio-a",
      holding: { ...fractionalDetailHolding, quantity: "1000.00000000" },
      symbol: "DRP",
      subtitle: "DRP Fixture · XASX · AUD",
      portfolioSecurityId: "holding-drp",
      homeCurrencyCode: "AUD",
      initialView: "native",
    },
  );
  assert.match(html, /<dd>1,000<\/dd>/);
  assert.doesNotMatch(html, /1,000\.0/);
});

// --- Holding Transactions list ----------------------------------------------

test("UI-027: a transaction row's fractional quantity renders exact trimmed digits, never rounded to a fake whole number (was fixed-4dp via ownedHoldingDecimal pre-UI-027)", () => {
  const html = renderComponent(
    "HoldingTransactionsScreen",
    "../app/components/holding-transactions.tsx",
    {
      portfolioId: "portfolio-a",
      portfolioSecurityId: "holding-drp",
      symbol: "DRP",
      subtitle: "DRP Fixture · XASX · AUD",
      baseCurrencyCode: "AUD",
      rows: [
        {
          id: "tx-drp",
          type: "buy",
          status: "posted",
          businessDate: "2026-01-05",
          quantityDecimal: "150.500000",
          unitPriceDecimal: "9.00",
          currencyCode: "AUD",
          grossAmountDecimal: "1354.50",
          feeAmountDecimal: "0",
          taxAmountDecimal: "0",
          sourceType: "manual",
          reversesTransactionId: null,
          supersedesTransactionId: null,
        },
      ],
      truncated: false,
      totalCount: 1,
    },
  );
  assert.match(html, /class="numeric">150\.5</);
  assert.doesNotMatch(html, /150\.5000/);
});

// --- Dividend history row (security-dividends-tab.tsx via formatShares) ----

function dividendRow(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: "de1",
    portfolioSecurityId: "psa1",
    dividendEventId: "de1",
    kind: "cash",
    currencyCode: "AUD",
    exDate: "2026-06-01",
    paymentDate: "2026-06-15",
    sharesDecimal: "100",
    dividendPerShareDecimal: "1.50",
    cashDecimal: "150",
    franking: { source: "unknown", perShareDecimal: null },
    frankingTotalDecimal: null,
    grossDecimal: "150",
    grossIncludesFranking: false,
    status: "ex_date_passed",
    source: "auto",
    excluded: false,
    amountUnknown: false,
    providerGrossPerShareDecimal: "1.50",
    dominatedReceipt: null,
    dominatedImported: null,
    additionalReceiptsCount: 0,
    additionalImportedCount: 0,
    originalCurrencyCode: null,
    fxRateToPortfolioDecimal: null,
    fxRateSource: null,
    frankingDerivedZero: false,
    frankingCurrencySource: null,
    ...overrides,
  };
}

test("UI-027: a dividend history row's genuinely fractional shares-held count renders exact trimmed digits, never rounded to a fake whole number (formatShares was fixed-4dp with no never-fake-zero guard pre-UI-027)", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    {
      portfolioId: "pa",
      portfolioSecurityId: "psa1",
      symbol: "RMD",
      currencyCode: "AUD",
      baseCurrencyCode: "AUD",
      today: "2026-08-19",
      rows: [dividendRow({ sharesDecimal: "150.500000" })],
      filteredArtifactCount: 0,
      lifetimeTotals: {
        currencyCode: "AUD",
        status: "ok",
        rowCount: 1,
        excludedCount: 0,
        unknownAmountCount: 0,
        receivedCashDecimal: "150",
        receivedFrankingKnownDecimal: "0",
        receivedFrankingUnknownCount: 1,
        receivedGrossDecimal: "150",
        pendingCashDecimal: null,
        pendingFrankingKnownDecimal: null,
        pendingFrankingUnknownCount: 0,
        pendingGrossDecimal: null,
        pendingCount: 0,
      },
      overridesByEventId: {},
      manualRecordsById: {},
      assumptions: {
        dividendYieldPercentDecimal: null,
        frankingPercentDecimal: null,
        dividendGrowthPercentDecimal: null,
        version: 1,
      },
      portfolioAssumptions: {
        valueGrowthPercentDecimal: null,
        portfolioDividendGrowthPercentDecimal: null,
        version: null,
      },
      holdingsHref: "/portfolio/pa/holdings",
    },
    true, // needs the router stub (SecurityDividendsTab is "use client", calls useRouter)
  );
  assert.match(html, /class="numeric">150\.5</);
  assert.doesNotMatch(html, /150\.5000/);
});

test("UI-027: a dividend history row's INTEGRAL shares-held count renders with no decimal places at all, not padded to any fixed scale", () => {
  const html = renderComponent(
    "SecurityDividendsTab",
    "../app/components/security-dividends-tab.tsx",
    {
      portfolioId: "pa",
      portfolioSecurityId: "psa1",
      symbol: "RMD",
      currencyCode: "AUD",
      baseCurrencyCode: "AUD",
      today: "2026-08-19",
      rows: [dividendRow({ sharesDecimal: "150.000000" })],
      filteredArtifactCount: 0,
      lifetimeTotals: {
        currencyCode: "AUD",
        status: "ok",
        rowCount: 1,
        excludedCount: 0,
        unknownAmountCount: 0,
        receivedCashDecimal: "150",
        receivedFrankingKnownDecimal: "0",
        receivedFrankingUnknownCount: 1,
        receivedGrossDecimal: "150",
        pendingCashDecimal: null,
        pendingFrankingKnownDecimal: null,
        pendingFrankingUnknownCount: 0,
        pendingGrossDecimal: null,
        pendingCount: 0,
      },
      overridesByEventId: {},
      manualRecordsById: {},
      assumptions: {
        dividendYieldPercentDecimal: null,
        frankingPercentDecimal: null,
        dividendGrowthPercentDecimal: null,
        version: 1,
      },
      portfolioAssumptions: {
        valueGrowthPercentDecimal: null,
        portfolioDividendGrowthPercentDecimal: null,
        version: null,
      },
      holdingsHref: "/portfolio/pa/holdings",
    },
    true, // needs the router stub (SecurityDividendsTab is "use client", calls useRouter)
  );
  // Anchored to the exact shares-column cell boundary ("150</td>") -- a
  // loose /150\.0/ would also false-positive on the row's unrelated
  // "$150.00" cash/gross money cells, which correctly keep their own 2dp
  // money formatting untouched by this quantity-only change.
  assert.match(html, /class="numeric">150<\/td>/);
});

// --- Capital gains allocation row (capital-gains-screen.tsx via formatQuantity)

test("UI-027: a Capital gains allocation row's genuinely fractional quantity renders exact trimmed digits, never rounded to a fake whole number", () => {
  const fy = {
    endingYear: 2026,
    label: "FY26",
    window: { startDate: "2025-07-01", endDate: "2026-06-30" },
    rows: [
      {
        allocationId: "alloc-frac",
        portfolioSecurityId: "ps-frac",
        securitySymbol: "FRAC",
        securityName: "Fractional Holdings Ltd",
        acquiredDate: "2022-01-10",
        disposedDate: "2026-02-01",
        quantityDecimal: "10.250000",
        proceedsDecimal: "160.00",
        basisDecimal: "60.00",
        feeDecimal: "0",
        taxDecimal: "0",
        gainDecimal: "100.00",
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
    totalDiscountableGainsGrossDecimal: "100.00",
    totalNonDiscountableGainsGrossDecimal: "0",
    totalLossesDecimal: "0",
    lossAppliedToNonDiscountableDecimal: "0",
    lossAppliedToDiscountableDecimal: "0",
    remainingNonDiscountableAfterLossDecimal: "0",
    remainingDiscountableAfterLossDecimal: "100.00",
    discountRateDecimal: "0.50",
    discountAppliedDecimal: "50.00",
    netCapitalGainEstimateDecimal: "50.00",
    unabsorbedLossDecimal: "0",
  };
  const html = renderComponent(
    "FyDetailDialog",
    "../app/components/capital-gains-screen.tsx",
    { fy, currencyCode: "AUD", dialogRef: { current: null } },
  );
  assert.match(html, />10\.25</);
  assert.doesNotMatch(html, /10\.250000/);
});

test("UI-027: a Capital gains allocation row's INTEGRAL quantity renders with no decimal places at all, not padded to any fixed scale", () => {
  const fy = {
    endingYear: 2026,
    label: "FY26",
    window: { startDate: "2025-07-01", endDate: "2026-06-30" },
    rows: [
      {
        allocationId: "alloc-whole",
        portfolioSecurityId: "ps-whole",
        securitySymbol: "WHOLE",
        securityName: "Whole Holdings Ltd",
        acquiredDate: "2022-01-10",
        disposedDate: "2026-02-01",
        quantityDecimal: "10.000000",
        proceedsDecimal: "160.00",
        basisDecimal: "60.00",
        feeDecimal: "0",
        taxDecimal: "0",
        gainDecimal: "100.00",
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
    totalDiscountableGainsGrossDecimal: "100.00",
    totalNonDiscountableGainsGrossDecimal: "0",
    totalLossesDecimal: "0",
    lossAppliedToNonDiscountableDecimal: "0",
    lossAppliedToDiscountableDecimal: "0",
    remainingNonDiscountableAfterLossDecimal: "0",
    remainingDiscountableAfterLossDecimal: "100.00",
    discountRateDecimal: "0.50",
    discountAppliedDecimal: "50.00",
    netCapitalGainEstimateDecimal: "50.00",
    unabsorbedLossDecimal: "0",
  };
  const html = renderComponent(
    "FyDetailDialog",
    "../app/components/capital-gains-screen.tsx",
    { fy, currencyCode: "AUD", dialogRef: { current: null } },
  );
  assert.match(html, />10</);
  assert.doesNotMatch(html, /10\.0/);
});
