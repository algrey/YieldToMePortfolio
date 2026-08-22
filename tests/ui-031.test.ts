// UI-031 (owner directive, verbatim): "Holdings should have a summary
// row ... four lines ... static at the bottom of the page (as in the
// holdings scroll past it) but may later change my mind to have it first
// or last. It should be shaded to be obviously different from the regular
// rows." Line 1: 'Unrealised' | total current market value | total daily
// gain amount | total gain amount. Line 2: blank | total cost basis |
// total daily percent | total percent. Line 3: 'All Time' + all-time gain
// including historical sold shares and unrealised gains, format
// "+$333,000 (+33.19%)". Line 4: 'Realised' + total capital gain for sold
// shares, same format.
//
// Part 1 (pure, no DB): `domain/calculations/multi-currency.ts`'s new
// `composePortfolioDailyMovementTotal` -- portfolio-level daily movement
// and percent, aligned/excluded holdings, zero-quantity exclusion, the
// all-zero and fully-empty edges, and exact (non-approximated) previous-
// value derivation.
//
// Part 2 (pure, no DB): `domain/gains/security-totals.ts`'s new
// `computePortfolioRealisedGainTotal` -- portfolio-wide sum over UI-030's
// per-security map, incl. a loss, partial coverage, all-incomplete, and
// the "never sold anywhere" genuine-zero edge.
//
// Part 3 (pure, no DB): `app/owned-holdings-summary.ts`'s
// `buildHoldingsSummaryFooter` -- fixture math for all four lines
// (incl. a sold-out security and a loss), the honest qualifier when a
// holding lacks a price/basis, realised-gains-unavailable, never-sold,
// partial realised coverage, and the two independent alignment sets
// (value/basis vs. daily movement).
//
// Part 4 (rendered, via the same child-process trick UI-030's own test
// suite uses): `OwnedHoldingsScreen`'s sticky/shaded summary row --
// present with sr-labelled four-line structure when `holdingsSummary` is
// populated, absent for an empty portfolio, and the owner's own
// "+$333,000 (+33.19%)" format for the All Time / Realised lines.
//
// Part 5 (CSS pin, no DB): `app/globals.css`'s `.holdings-summary-footer`
// rule -- sticky positioning and a distinct background token.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  composePortfolioDailyMovementTotal,
  type PortfolioDailyMovementCoverage,
  type PortfolioDailyMovementResult,
  type PortfolioCoverage,
  type PortfolioTotalsResult,
} from "../domain/calculations/index.ts";
import {
  computePortfolioRealisedGainTotal,
  type SecurityRealisedGainTotal,
} from "../domain/gains/index.ts";
import { buildHoldingsSummaryFooter } from "../app/owned-holdings-summary.ts";
import { available, unavailable } from "./fixtures/calc-001b.ts";

// ===========================================================================
// Part 1: composePortfolioDailyMovementTotal
// ===========================================================================

test("UI-031 daily-movement total: sums movement and market value across aligned holdings, deriving previous value EXACTLY (never a floating-point approximation)", () => {
  const result = composePortfolioDailyMovementTotal({
    holdings: [
      {
        id: "a",
        quantityDecimal: "10",
        homeMarketValue: available("1000"),
        homeDailyMovement: available("100"),
      },
      {
        id: "b",
        quantityDecimal: "5",
        homeMarketValue: available("500"),
        homeDailyMovement: available("50"),
      },
    ],
  });
  assert.equal(result.status, "complete");
  assert.equal(result.amounts?.dailyMovementDecimal, "150");
  // previousValue = marketValue(1500) - movement(150) = 1350, exactly.
  assert.equal(result.amounts?.previousValueDecimal, "1350");
  // 150 / 1350 * 100 = 11.111...% -> trimmed 2dp = 11.11
  assert.equal(result.amounts?.dailyPercentDecimal, "11.11");
  assert.equal(result.coverage.alignedHoldingCount, 2);
});

test("UI-031 daily-movement total: a holding missing a comparable movement is excluded from the sum and coverage, and the status downgrades to partial", () => {
  const result = composePortfolioDailyMovementTotal({
    holdings: [
      {
        id: "a",
        quantityDecimal: "10",
        homeMarketValue: available("1000"),
        homeDailyMovement: available("100"),
      },
      {
        id: "b",
        quantityDecimal: "5",
        homeMarketValue: available("500"),
        homeDailyMovement: unavailable("missing_previous_price"),
      },
    ],
  });
  assert.equal(result.status, "partial");
  assert.equal(result.amounts?.dailyMovementDecimal, "100");
  assert.equal(result.coverage.alignedHoldingCount, 1);
  assert.equal(result.coverage.nonZeroHoldingCount, 2);
  assert.deepEqual(result.coverage.excludedHoldingIds, ["b"]);
});

test("UI-031 daily-movement total: a zero-quantity (sold-to-zero) holding is excluded from the sum entirely, not folded in as a zero", () => {
  const result = composePortfolioDailyMovementTotal({
    holdings: [
      {
        id: "a",
        quantityDecimal: "10",
        homeMarketValue: available("1000"),
        homeDailyMovement: available("100"),
      },
      {
        id: "sold-out",
        quantityDecimal: "0",
        homeMarketValue: available("0"),
        homeDailyMovement: available("0"),
      },
    ],
  });
  assert.equal(result.status, "complete");
  assert.equal(result.coverage.zeroHoldingCount, 1);
  assert.equal(result.coverage.alignedHoldingCount, 1);
  assert.equal(result.amounts?.dailyMovementDecimal, "100");
});

test("UI-031 daily-movement total: no holdings at all is unavailable; every holding explicitly zero is a genuine complete zero (never confused with 'no data')", () => {
  const noHoldings = composePortfolioDailyMovementTotal({ holdings: [] });
  assert.equal(noHoldings.status, "unavailable");
  assert.equal(noHoldings.amounts, null);

  const allZero = composePortfolioDailyMovementTotal({
    holdings: [
      {
        id: "sold-out",
        quantityDecimal: "0",
        homeMarketValue: available("0"),
        homeDailyMovement: available("0"),
      },
    ],
  });
  assert.equal(allZero.status, "complete");
  assert.equal(allZero.amounts?.dailyMovementDecimal, "0");
  assert.equal(allZero.amounts?.dailyPercentDecimal, null);
});

test("UI-031 daily-movement total: previous value summing to zero suppresses the percent rather than dividing by zero", () => {
  const result = composePortfolioDailyMovementTotal({
    holdings: [
      {
        id: "a",
        quantityDecimal: "10",
        homeMarketValue: available("100"),
        homeDailyMovement: available("100"), // previous value = 0
      },
    ],
  });
  assert.equal(result.status, "complete");
  assert.equal(result.amounts?.previousValueDecimal, "0");
  assert.equal(result.amounts?.dailyPercentDecimal, null);
});

// ===========================================================================
// Part 2: computePortfolioRealisedGainTotal
// ===========================================================================

function securityTotal(
  overrides: Partial<SecurityRealisedGainTotal>,
): SecurityRealisedGainTotal {
  return {
    portfolioSecurityId: "sec",
    disposalCount: 1,
    knownDisposalCount: 1,
    excludedIncompleteCount: 0,
    partialCoverage: false,
    gainDecimal: "0",
    basisAtDisposalDecimal: "0",
    percentDecimal: null,
    ...overrides,
  };
}

test("UI-031 portfolio realised total: sums a gain and a loss across two securities, sign-preserving", () => {
  const total = computePortfolioRealisedGainTotal([
    securityTotal({
      portfolioSecurityId: "sec-gain",
      gainDecimal: "1000",
      basisAtDisposalDecimal: "2000",
    }),
    securityTotal({
      portfolioSecurityId: "sec-loss",
      gainDecimal: "-300",
      basisAtDisposalDecimal: "1500",
    }),
  ]);
  assert.equal(total.disposalCount, 2);
  assert.equal(total.gainDecimal, "700");
  assert.equal(total.basisAtDisposalDecimal, "3500");
  // 700 / 3500 * 100 = 20 exactly.
  assert.equal(total.percentDecimal, "20");
  assert.equal(total.partialCoverage, false);
});

test("UI-031 portfolio realised total: an all-incomplete security still counts toward disposalCount/excludedIncompleteCount, but contributes zero to the known sums", () => {
  const total = computePortfolioRealisedGainTotal([
    securityTotal({
      portfolioSecurityId: "sec-known",
      gainDecimal: "500",
      basisAtDisposalDecimal: "1000",
    }),
    securityTotal({
      portfolioSecurityId: "sec-unknown",
      disposalCount: 2,
      knownDisposalCount: 0,
      excludedIncompleteCount: 2,
      partialCoverage: true,
      gainDecimal: "0",
      basisAtDisposalDecimal: "0",
    }),
  ]);
  assert.equal(total.disposalCount, 3);
  assert.equal(total.knownDisposalCount, 1);
  assert.equal(total.excludedIncompleteCount, 2);
  assert.equal(total.partialCoverage, true);
  assert.equal(total.gainDecimal, "500");
  assert.equal(total.basisAtDisposalDecimal, "1000");
});

test("UI-031 portfolio realised total: an empty input (nothing ever sold anywhere) is an honest zero, not a missing figure", () => {
  const total = computePortfolioRealisedGainTotal([]);
  assert.equal(total.disposalCount, 0);
  assert.equal(total.gainDecimal, "0");
  assert.equal(total.basisAtDisposalDecimal, "0");
  assert.equal(total.percentDecimal, null);
  assert.equal(total.partialCoverage, false);
});

// ===========================================================================
// Part 3: buildHoldingsSummaryFooter
// ===========================================================================

// UI-031 review fold (F1): `buildHoldingsSummaryFooter` reads the excluded
// count from `coverage.excludedHoldingIds.length` (the exact set both
// domain functions track), NOT `nonZeroHoldingCount - alignedHoldingCount`
// (which silently omits invalid rows) -- these fixture builders keep
// `excludedHoldingIds` in sync with that same subtraction by default, so
// every EXISTING `{ nonZeroHoldingCount, alignedHoldingCount }`-only
// override still produces the expected qualifier count, while a test can
// still pass `excludedHoldingIds` explicitly to exercise the F1 distinction
// itself (an invalid row inflating the excluded set beyond that subtraction).
function placeholderIds(count: number, prefix: string): string[] {
  return Array.from(
    { length: Math.max(count, 0) },
    (_, index) => `${prefix}-${index}`,
  );
}
function fullCoverage(
  overrides: Partial<PortfolioCoverage>,
): PortfolioCoverage {
  const nonZeroHoldingCount = overrides.nonZeroHoldingCount ?? 2;
  const alignedHoldingCount = overrides.alignedHoldingCount ?? 2;
  return {
    totalHoldingCount: 2,
    nonZeroHoldingCount,
    zeroHoldingCount: 0,
    invalidHoldingCount: 0,
    pricedAndConvertedHoldingCount: 2,
    basisCoveredHoldingCount: 2,
    alignedHoldingCount,
    totalCashAccountCount: 0,
    nonZeroCashAccountCount: 0,
    zeroCashAccountCount: 0,
    invalidCashAccountCount: 0,
    convertedCashAccountCount: 0,
    excludedHoldingIds: placeholderIds(
      nonZeroHoldingCount - alignedHoldingCount,
      "excluded",
    ),
    excludedCashAccountIds: [],
    ...overrides,
  };
}
function dailyCoverage(
  overrides: Partial<PortfolioDailyMovementCoverage>,
): PortfolioDailyMovementCoverage {
  const nonZeroHoldingCount = overrides.nonZeroHoldingCount ?? 2;
  const alignedHoldingCount = overrides.alignedHoldingCount ?? 2;
  return {
    totalHoldingCount: 2,
    nonZeroHoldingCount,
    zeroHoldingCount: 0,
    invalidHoldingCount: 0,
    alignedHoldingCount,
    excludedHoldingIds: placeholderIds(
      nonZeroHoldingCount - alignedHoldingCount,
      "daily-excluded",
    ),
    ...overrides,
  };
}
function valueResult(
  overrides: Partial<{
    status: "complete" | "partial" | "unavailable";
    investedValueDecimal: string;
    coveredOpenBasisDecimal: string;
    unrealisedGainDecimal: string;
    coverage: Partial<PortfolioCoverage>;
  }>,
): PortfolioTotalsResult {
  const status = overrides.status ?? "complete";
  const coverage = fullCoverage(overrides.coverage ?? {});
  if (status === "unavailable") {
    return {
      status: "unavailable",
      label: "value_unavailable",
      amounts: null,
      coverage,
    };
  }
  const amounts = {
    investedValueDecimal: overrides.investedValueDecimal ?? "10000",
    coveredOpenBasisDecimal: overrides.coveredOpenBasisDecimal ?? "8000",
    unrealisedGainDecimal: overrides.unrealisedGainDecimal ?? "2000",
    cashValueDecimal: "0",
    portfolioValueDecimal: overrides.investedValueDecimal ?? "10000",
  };
  return status === "complete"
    ? { status: "complete", label: "portfolio_value", amounts, coverage }
    : { status: "partial", label: "known_value", amounts, coverage };
}
function dailyResult(
  overrides: Partial<{
    status: "complete" | "partial" | "unavailable";
    dailyMovementDecimal: string;
    previousValueDecimal: string;
    dailyPercentDecimal: string | null;
    coverage: Partial<PortfolioDailyMovementCoverage>;
  }>,
): PortfolioDailyMovementResult {
  const status = overrides.status ?? "complete";
  const coverage = dailyCoverage(overrides.coverage ?? {});
  if (status === "unavailable") {
    return { status: "unavailable", amounts: null, coverage };
  }
  const amounts = {
    dailyMovementDecimal: overrides.dailyMovementDecimal ?? "150",
    previousValueDecimal: overrides.previousValueDecimal ?? "9850",
    dailyPercentDecimal:
      overrides.dailyPercentDecimal === undefined
        ? "1.52"
        : overrides.dailyPercentDecimal,
  };
  return status === "complete"
    ? { status: "complete", amounts, coverage }
    : { status: "partial", amounts, coverage };
}

test("UI-031 summary footer: fixture math for all four lines, including a sold-out security and a loss in the realised rollup", () => {
  const footer = buildHoldingsSummaryFooter(
    "AUD",
    { value: valueResult({}), daily: dailyResult({}) },
    {
      "sec-sold-out": securityTotal({
        portfolioSecurityId: "sec-sold-out",
        gainDecimal: "-300", // a loss
        basisAtDisposalDecimal: "1500",
      }),
      "sec-other": securityTotal({
        portfolioSecurityId: "sec-other",
        gainDecimal: "1000",
        basisAtDisposalDecimal: "2000",
      }),
    },
  );
  // Line 1: market value / daily movement / unrealised gain.
  assert.deepEqual(footer.marketValue, {
    status: "available",
    currencyCode: "AUD",
    value: "10000",
    reason: null,
  });
  assert.equal(footer.dailyMovement.value, "150");
  assert.equal(footer.unrealisedGain.value, "2000");
  // Line 2: cost basis / daily percent / total percent.
  assert.equal(footer.costBasis.value, "8000");
  assert.equal(footer.dailyPercent.value, "1.52");
  // 2000 / 8000 * 100 = 25 exactly.
  assert.equal(footer.totalPercent.value, "25");
  // Line 4: realised = -300 + 1000 = 700, basis 1500 + 2000 = 3500, 20%.
  assert.equal(footer.realisedGain.value, "700");
  assert.equal(footer.realisedPercent.value, "20");
  // Line 3: all-time = unrealised(2000) + realised(700) = 2700,
  // basis = 8000 + 3500 = 11500, 2700/11500*100 = 23.478... -> 23.48.
  assert.equal(footer.allTimeGain.value, "2700");
  assert.equal(footer.allTimePercent.value, "23.48");
  // Fully aligned/complete fixture -- no qualifiers anywhere.
  assert.equal(footer.valueQualifier, null);
  assert.equal(footer.dailyQualifier, null);
  assert.equal(footer.allTimeQualifier, null);
  assert.equal(footer.realisedQualifier, null);
});

test("UI-031 summary footer: a holding without both a price and a cost basis produces a reachable qualifier on the value line, independent of the (unaffected) daily line", () => {
  const footer = buildHoldingsSummaryFooter(
    "AUD",
    {
      value: valueResult({
        status: "partial",
        coverage: { nonZeroHoldingCount: 3, alignedHoldingCount: 2 },
      }),
      daily: dailyResult({}),
    },
    {},
  );
  assert.equal(footer.marketValue.status, "available");
  assert.equal(
    footer.valueQualifier,
    "excludes 1 holding without both a price and a cost basis",
  );
  assert.equal(footer.dailyQualifier, null);
});

test("UI-031 summary footer (review fold F1): the qualifier count comes from coverage.excludedHoldingIds, not nonZeroHoldingCount - alignedHoldingCount -- an invalid holding (neither zero, aligned, nor counted in the subtraction) still shows up", () => {
  const footer = buildHoldingsSummaryFooter(
    "AUD",
    {
      // 3 non-zero, only 2 aligned -- the (wrong) subtraction would say 1
      // excluded, but the real excludedHoldingIds set has 2 entries (one
      // unaligned nonzero holding AND one structurally invalid one, e.g. a
      // malformed decimal `composePortfolioTotals` rejected outright).
      value: valueResult({
        status: "partial",
        coverage: {
          nonZeroHoldingCount: 3,
          alignedHoldingCount: 2,
          invalidHoldingCount: 1,
          excludedHoldingIds: ["unaligned-1", "invalid-1"],
        },
      }),
      daily: dailyResult({}),
    },
    {},
  );
  assert.equal(
    footer.valueQualifier,
    "excludes 2 holdings without both a price and a cost basis",
  );
});

test("UI-031 summary footer: a holding without a comparable daily movement produces its OWN qualifier, distinct from the value/basis qualifier", () => {
  const footer = buildHoldingsSummaryFooter(
    "AUD",
    {
      value: valueResult({}),
      daily: dailyResult({
        status: "partial",
        coverage: { nonZeroHoldingCount: 4, alignedHoldingCount: 2 },
      }),
    },
    {},
  );
  assert.equal(footer.valueQualifier, null);
  assert.equal(
    footer.dailyQualifier,
    "excludes 2 holdings without a comparable daily movement",
  );
});

test("UI-031 summary footer: when the realised-gains enrichment itself failed to load (bySecurity undefined), lines 3 and 4 read honestly unavailable rather than guessing", () => {
  const footer = buildHoldingsSummaryFooter(
    "AUD",
    { value: valueResult({}), daily: dailyResult({}) },
    undefined,
  );
  assert.equal(footer.realisedGain.status, "unavailable");
  assert.equal(footer.realisedGain.reason, "realised_gains_unavailable");
  assert.equal(footer.realisedPercent.status, "unavailable");
  assert.equal(footer.allTimeGain.status, "unavailable");
  assert.equal(footer.allTimeGain.reason, "realised_gains_unavailable");
});

test("UI-031 summary footer: a portfolio that has never sold anything shows a genuine zero Realised line (never a missing-data marker) with the percent honestly unavailable (zero basis)", () => {
  const footer = buildHoldingsSummaryFooter(
    "AUD",
    { value: valueResult({}), daily: dailyResult({}) },
    {},
  );
  assert.deepEqual(footer.realisedGain, {
    status: "available",
    currencyCode: "AUD",
    value: "0",
    reason: null,
  });
  assert.equal(footer.realisedPercent.status, "unavailable");
  assert.equal(footer.realisedPercent.reason, "zero_basis");
  // All-time collapses to the unrealised figure alone (0 realised).
  assert.equal(footer.allTimeGain.value, "2000");
});

test("UI-031 summary footer: partial realised coverage shows the KNOWN partial sum with a visible qualifier, and suppresses (never fabricates) both the realised and all-time percent", () => {
  const footer = buildHoldingsSummaryFooter(
    "AUD",
    { value: valueResult({}), daily: dailyResult({}) },
    {
      "sec-partial": securityTotal({
        portfolioSecurityId: "sec-partial",
        disposalCount: 3,
        knownDisposalCount: 2,
        excludedIncompleteCount: 1,
        partialCoverage: true,
        gainDecimal: "400",
        basisAtDisposalDecimal: "800",
      }),
    },
  );
  assert.equal(footer.realisedGain.value, "400");
  assert.equal(footer.realisedPercent.status, "unavailable");
  assert.equal(footer.realisedPercent.reason, "incomplete_basis");
  assert.match(footer.realisedQualifier ?? "", /partial.*1 of 3 lot match/);
  // All-time still shows the (partial) combined amount, but the percent is
  // suppressed the same way, and the qualifier says why.
  assert.equal(footer.allTimeGain.value, "2400"); // 2000 + 400
  assert.equal(footer.allTimePercent.status, "unavailable");
  assert.ok(footer.allTimeQualifier);
  assert.match(footer.allTimeQualifier ?? "", /lot match/);
});

test("UI-031 summary footer: when every realised lot match anywhere is incomplete, the realised AND all-time lines are honestly unavailable (never a fabricated $0)", () => {
  const footer = buildHoldingsSummaryFooter(
    "AUD",
    { value: valueResult({}), daily: dailyResult({}) },
    {
      "sec-unknown": securityTotal({
        portfolioSecurityId: "sec-unknown",
        disposalCount: 1,
        knownDisposalCount: 0,
        excludedIncompleteCount: 1,
        partialCoverage: true,
        gainDecimal: "0",
        basisAtDisposalDecimal: "0",
      }),
    },
  );
  assert.equal(footer.realisedGain.status, "unavailable");
  assert.equal(footer.realisedGain.reason, "incomplete_basis");
  assert.equal(footer.allTimeGain.status, "unavailable");
  assert.equal(footer.allTimeGain.reason, "incomplete_basis");
});

test("UI-031 summary footer: an entirely unavailable unrealised side blocks the value line AND the all-time line, but leaves the (independently-aligned) daily line untouched", () => {
  const footer = buildHoldingsSummaryFooter(
    "AUD",
    { value: valueResult({ status: "unavailable" }), daily: dailyResult({}) },
    {
      "sec-other": securityTotal({
        portfolioSecurityId: "sec-other",
        gainDecimal: "1000",
        basisAtDisposalDecimal: "2000",
      }),
    },
  );
  assert.equal(footer.marketValue.status, "unavailable");
  assert.equal(footer.costBasis.status, "unavailable");
  assert.equal(footer.unrealisedGain.status, "unavailable");
  assert.equal(footer.totalPercent.status, "unavailable");
  assert.equal(footer.allTimeGain.status, "unavailable");
  assert.equal(footer.allTimeGain.reason, "missing_basis");
  // Realised itself is unaffected (it never depends on the unrealised side).
  assert.equal(footer.realisedGain.status, "available");
  assert.equal(footer.realisedGain.value, "1000");
  // Daily is a fully separate alignment set -- still available.
  assert.equal(footer.dailyMovement.status, "available");
  assert.equal(footer.dailyMovement.value, "150");
});

// ===========================================================================
// Part 4: rendered OwnedHoldingsScreen (sticky/shaded summary row)
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

function renderHoldingsWithSummary(
  holdingsSummaryJson: string | null,
  holdingsJson: string,
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
      holdings: ${holdingsJson},
      holdingsViewState: ${holdingsJson === "[]" ? '"empty"' : '"complete"'},
      holdingsSummary: ${holdingsSummaryJson ?? "undefined"},
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
    currencyCode: "AUD",
    quantity: "10",
    averageNativeCost: "9.00",
    nativeBasis: holdingValue("available", "AUD", "8000"),
    homeBasis: holdingValue("available", "AUD", "8000"),
    nativePrice: "1000.00",
    nativeValue: holdingValue("available", "AUD", "10000"),
    homePrice: holdingValue("available", "AUD", "1000.00"),
    homeValue: holdingValue("available", "AUD", "10000"),
    dailyMovement: holdingValue("available", "AUD", "150"),
    dailyPercent: holdingValue("available", "%", "1.52"),
    unrealisedGain: holdingValue("available", "AUD", "2000"),
    unrealisedPercent: holdingValue("available", "%", "25"),
    dailyTone: "positive",
    gainTone: "positive",
    priceState: "current",
    actionStatus: "none",
    explanation: "Fixture explanation.",
    sort: { ticker: "ABC", value: "10000", daily: "1.52", gain: "25" },
  },
]);

const FOOTER_FIXTURE = JSON.stringify({
  currencyCode: "AUD",
  marketValue: holdingValue("available", "AUD", "10000"),
  dailyMovement: holdingValue("available", "AUD", "150"),
  unrealisedGain: holdingValue("available", "AUD", "2000"),
  costBasis: holdingValue("available", "AUD", "8000"),
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

test("UI-031 render: the sticky/shaded summary row renders with all four lines, in the owner's own '+$333,000 (+33.19%)' format for All Time / Realised", () => {
  const html = renderHoldingsWithSummary(FOOTER_FIXTURE, ONE_HELD_ROW);
  assert.match(html, /class="[^"]*holdings-summary-footer[^"]*"/);
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Portfolio totals"/);
  assert.match(html, />Unrealised</);
  assert.match(html, />All Time</);
  assert.match(html, />Realised</);
  // Owner's literal example shape: sign before the currency symbol.
  assert.match(html, /\+\$333,000\.00\s*\(\+33\.19%\)/);
  assert.match(html, /\+\$700\.00\s*\(\+20%\)/);
});

test("UI-031 render: sr-labelled line structure -- each of the four sub-groups carries its own reachable aria-label", () => {
  const html = renderHoldingsWithSummary(FOOTER_FIXTURE, ONE_HELD_ROW);
  assert.match(
    html,
    /aria-label="Unrealised total value, daily gain, and total gain"/,
  );
  assert.match(
    html,
    /aria-label="Cost basis, daily percent, and total percent"/,
  );
  assert.match(html, /aria-label="All time gain"/);
  assert.match(html, /aria-label="Realised gain"/);
});

test("UI-031 render: no summary markup at all when holdingsSummary is undefined (best-effort load failed, or the CGT/holdings enrichment never ran)", () => {
  const html = renderHoldingsWithSummary(null, ONE_HELD_ROW);
  assert.doesNotMatch(html, /holdings-summary-footer/);
});

test("UI-031 render: empty portfolio (no held securities at all) renders no summary row -- an honest absence, never a fabricated all-zero footer", () => {
  const html = renderHoldingsWithSummary(FOOTER_FIXTURE, "[]");
  assert.doesNotMatch(html, /holdings-summary-footer/);
});

test("UI-031 render: a reachable qualifier renders alongside the affected line when the summary data carries one", () => {
  const qualified = JSON.parse(FOOTER_FIXTURE);
  qualified.valueQualifier =
    "excludes 1 holding without both a price and a cost basis";
  qualified.realisedQualifier =
    "partial -- excludes 1 of 3 lot matches, cost basis incomplete";
  const html = renderHoldingsWithSummary(
    JSON.stringify(qualified),
    ONE_HELD_ROW,
  );
  assert.match(
    html,
    /excludes 1 holding without both a price and a cost basis/,
  );
  assert.match(
    html,
    /partial -- excludes 1 of 3 lot matches, cost basis incomplete/,
  );
});

// ===========================================================================
// Part 5: CSS pin -- sticky positioning and a distinct shading token
// ===========================================================================

test("UI-031 CSS: .holdings-summary-footer is sticky-positioned and shaded with a distinct background token from the plain (transparent) holding rows", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const match = css.match(/\.holdings-summary-footer\s*{([^}]*)}/);
  assert.ok(match, "expected a .holdings-summary-footer rule in globals.css");
  const block = match![1];
  assert.match(block, /position:\s*sticky/);
  assert.match(block, /bottom:/);
  assert.match(block, /background:\s*var\(--forest-raised\)/);
  // The plain data rows stay transparent -- confirms the summary's shading
  // is genuinely distinct, not incidentally the same as every row.
  assert.match(css, /\.holding-row\s*{[^}]*background:\s*transparent/);
});

test("UI-031 CSS (review B1, QA-001B 320px): the longest real combined qualifier string wraps instead of overflowing -- .summary-qualifier overrides .row-tertiary's white-space: nowrap", async () => {
  // The All Time line's qualifier is the longest real string this feature
  // produces -- it names BOTH an excluded-holdings clause and an excluded-
  // lot-matches clause together (`buildHoldingsSummaryFooter`'s
  // `allTimeQualifier`, not a hand-typed approximation of it).
  const footer = buildHoldingsSummaryFooter(
    "AUD",
    {
      value: valueResult({
        status: "partial",
        coverage: { nonZeroHoldingCount: 5, alignedHoldingCount: 3 },
      }),
      daily: dailyResult({}),
    },
    {
      "sec-partial": securityTotal({
        portfolioSecurityId: "sec-partial",
        disposalCount: 7,
        knownDisposalCount: 4,
        excludedIncompleteCount: 3,
        partialCoverage: true,
        gainDecimal: "400",
        basisAtDisposalDecimal: "800",
      }),
    },
  );
  assert.ok(footer.allTimeQualifier);
  const qualifier = footer.allTimeQualifier!;
  // Same order-of-magnitude as the reviewer's own recomputation (~117
  // chars) -- comfortably longer than a 320px content box (roughly
  // 40-50 characters at this row's font size) can fit on one line.
  assert.ok(
    qualifier.length > 90,
    `expected a long combined qualifier, got ${qualifier.length} chars: "${qualifier}"`,
  );

  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  // .row-tertiary (the qualifier's OTHER class) declares nowrap -- the
  // overflow this pin guards against.
  assert.match(css, /\.row-tertiary\s*{[^}]*white-space:\s*nowrap/);
  const qualifierMatch = css.match(
    /\.holdings-summary-footer \.summary-qualifier\s*{([^}]*)}/,
  );
  assert.ok(
    qualifierMatch,
    "expected a .holdings-summary-footer .summary-qualifier rule in globals.css",
  );
  const qualifierBlock = qualifierMatch![1];
  assert.match(qualifierBlock, /white-space:\s*normal/);
  assert.match(qualifierBlock, /overflow-wrap:\s*anywhere/);
});
