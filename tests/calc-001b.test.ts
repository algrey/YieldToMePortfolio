import assert from "node:assert/strict";
import test from "node:test";
import {
  addDecimal,
  calculateCashConversion,
  calculateDailyMovement,
  calculateNativeHomeHolding,
  composePortfolioTotals,
  formatDecimalExact,
  parseDecimal,
  resolveFxRate,
  selectHoldingCurrencyPresentation,
} from "../domain/calculations/index.ts";
import {
  audUsdInverseFx,
  available,
  explicitTransactionFx,
  unavailable,
  usdAudCurrentFx,
  usdAudPreviousFx,
} from "./fixtures/calc-001b.ts";

test("CALC-001B resolves direct, inverse, and identity FX with explicit transaction precedence", () => {
  const transaction = resolveFxRate({
    purpose: "transaction",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    explicitTransactionFx,
    selectedFx: usdAudCurrentFx,
  });
  assert.equal(transaction.status, "available");
  if (transaction.status === "available") {
    assert.equal(transaction.rateDecimal, "1.55");
    assert.equal(transaction.explanation.source, "transaction");
    assert.equal(transaction.explanation.sourceId, "transaction-1");
    assert.equal(transaction.explanation.marketDate, "2026-07-15");
  }

  const sale = resolveFxRate({
    purpose: "transaction",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    explicitTransactionFx: {
      ...explicitTransactionFx,
      rateDecimal: "1.7",
      marketDate: "2026-07-20",
      sourceId: "transaction-2",
    },
    selectedFx: usdAudCurrentFx,
  });
  assert.equal(sale.status, "available");
  if (sale.status === "available") assert.equal(sale.rateDecimal, "1.7");

  const currentValuation = resolveFxRate({
    purpose: "valuation",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    selectedFx: usdAudCurrentFx,
  });
  assert.equal(currentValuation.status, "available");
  if (currentValuation.status === "available") {
    assert.equal(currentValuation.rateDecimal, "1.6");
  }

  const inverse = resolveFxRate({
    purpose: "valuation",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    selectedFx: audUsdInverseFx,
  });
  assert.equal(inverse.status, "available");
  if (inverse.status === "available") {
    assert.equal(inverse.rateDecimal, "2");
    assert.equal(inverse.explanation.inverted, true);
    assert.equal(inverse.explanation.suppliedRateDecimal, "0.5");
  }

  const identity = resolveFxRate({
    purpose: "valuation",
    nativeCurrencyCode: "AUD",
    homeCurrencyCode: "AUD",
  });
  assert.equal(identity.status, "available");
  if (identity.status === "available") {
    assert.equal(identity.rateDecimal, "1");
    assert.equal(identity.explanation.source, "identity");
  }

  const invalidExplicit = resolveFxRate({
    purpose: "transaction",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    explicitTransactionFx: {
      ...explicitTransactionFx,
      rateDecimal: "0",
    },
    selectedFx: usdAudCurrentFx,
  });
  assert.equal(invalidExplicit.status, "unavailable");
  if (invalidExplicit.status === "unavailable") {
    assert.equal(invalidExplicit.reason, "invalid_transaction_fx");
    assert.equal(invalidExplicit.explanation.source, "transaction");
  }

  const mismatched = resolveFxRate({
    purpose: "valuation",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    selectedFx: {
      ...usdAudCurrentFx,
      baseCurrencyCode: "EUR",
      quoteCurrencyCode: "GBP",
    },
  });
  assert.equal(mismatched.status, "unavailable");
  if (mismatched.status === "unavailable") {
    assert.equal(mismatched.reason, "fx_direction_mismatch");
  }
});

test("CALC-001B keeps native holding facts stable across the display toggle", () => {
  const holding = calculateNativeHomeHolding({
    quantityDecimal: "10",
    nativePriceDecimal: "20",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    valuationFx: usdAudPreviousFx,
  });
  assert.deepEqual(holding.facts.nativePrice, {
    status: "available",
    currencyCode: "USD",
    valueDecimal: "20",
  });
  assert.deepEqual(holding.facts.nativeMarketValue, {
    status: "available",
    currencyCode: "USD",
    valueDecimal: "200",
  });
  assert.deepEqual(holding.facts.homePrice, {
    status: "available",
    currencyCode: "AUD",
    valueDecimal: "30",
  });
  assert.deepEqual(holding.facts.homeMarketValue, {
    status: "available",
    currencyCode: "AUD",
    valueDecimal: "300",
  });
  const native = selectHoldingCurrencyPresentation(holding, "native");
  const home = selectHoldingCurrencyPresentation(holding, "home");
  assert.equal(native.marketValue, holding.facts.nativeMarketValue);
  assert.equal(home.marketValue, holding.facts.homeMarketValue);
  assert.equal(holding.facts.quantityDecimal, "10");
  assert.equal(
    holding.explanation.fx.explanation.observedAt,
    "2026-08-02T06:00:00Z",
  );
  assert.equal(holding.explanation.fx.explanation.sourceId, "yahoo-compatible");
  assert.doesNotMatch(JSON.stringify(home), /observedAt|sourceId|marketDate/);
});

test("CALC-001B missing FX preserves native values and cannot fabricate a home view", () => {
  const holding = calculateNativeHomeHolding({
    quantityDecimal: "2.5",
    nativePriceDecimal: "12.34",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
  });
  assert.deepEqual(holding.facts.nativeMarketValue, {
    status: "available",
    currencyCode: "USD",
    valueDecimal: "30.85",
  });
  assert.deepEqual(holding.facts.homeMarketValue, {
    status: "unavailable",
    currencyCode: "AUD",
    reason: "missing_fx",
  });
  assert.deepEqual(selectHoldingCurrencyPresentation(holding, "home"), {
    requestedView: "home",
    displayedView: "native",
    price: holding.facts.nativePrice,
    marketValue: holding.facts.nativeMarketValue,
    usedNativeFallback: true,
  });
});

test("CALC-001B daily movement reconciles flat-price, flat-FX, and combined decomposition", () => {
  const flatFx = calculateDailyMovement({
    quantityDecimal: "10",
    currentPriceDecimal: "110",
    previousPriceDecimal: "100",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    currentFx: usdAudPreviousFx,
    previousFx: usdAudPreviousFx,
    quantityTiming: "comparable",
  });
  assert.equal(flatFx.compact.homeMovement.status, "available");
  if (flatFx.compact.homeMovement.status === "available") {
    assert.equal(flatFx.compact.homeMovement.valueDecimal, "150");
  }
  assert.deepEqual(
    flatFx.decomposition.fxContributionIncludingCrossTerm,
    available("0"),
  );

  const flatPrice = calculateDailyMovement({
    quantityDecimal: "10",
    currentPriceDecimal: "100",
    previousPriceDecimal: "100",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    currentFx: usdAudCurrentFx,
    previousFx: usdAudPreviousFx,
    quantityTiming: "comparable",
  });
  assert.equal(flatPrice.compact.homeMovement.status, "available");
  if (flatPrice.compact.homeMovement.status === "available") {
    assert.equal(flatPrice.compact.homeMovement.valueDecimal, "100");
  }
  assert.deepEqual(
    flatPrice.decomposition.localPriceContribution,
    available("0"),
  );

  const combined = calculateDailyMovement({
    quantityDecimal: "10",
    currentPriceDecimal: "110",
    previousPriceDecimal: "100",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    currentFx: usdAudCurrentFx,
    previousFx: usdAudPreviousFx,
    quantityTiming: "comparable",
  });
  assert.deepEqual(combined.compact.homeMovement, {
    status: "available",
    currencyCode: "AUD",
    valueDecimal: "260",
  });
  assert.deepEqual(combined.compact.homePercent, available("17.33"));
  assert.deepEqual(
    combined.decomposition.localPriceContribution,
    available("150"),
  );
  assert.deepEqual(combined.decomposition.pureFxContribution, available("100"));
  assert.deepEqual(combined.decomposition.crossTerm, available("10"));
  assert.deepEqual(
    combined.decomposition.fxContributionIncludingCrossTerm,
    available("110"),
  );
  if (
    combined.decomposition.localPriceContribution.status === "available" &&
    combined.decomposition.fxContributionIncludingCrossTerm.status ===
      "available"
  ) {
    assert.equal(
      formatDecimalExact(
        addDecimal(
          parseDecimal(
            combined.decomposition.localPriceContribution.valueDecimal,
          ),
          parseDecimal(
            combined.decomposition.fxContributionIncludingCrossTerm
              .valueDecimal,
          ),
        ),
      ),
      combined.compact.homeMovement.status === "available"
        ? combined.compact.homeMovement.valueDecimal
        : null,
    );
  }
});

test("CALC-001B daily gaps retain native movement but make dependent home metrics unavailable", () => {
  const missingPreviousFx = calculateDailyMovement({
    quantityDecimal: "10",
    currentPriceDecimal: "110",
    previousPriceDecimal: "100",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    currentFx: usdAudCurrentFx,
    previousFx: null,
    quantityTiming: "comparable",
  });
  assert.deepEqual(missingPreviousFx.compact.nativeMovement, {
    status: "available",
    currencyCode: "USD",
    valueDecimal: "100",
  });
  assert.deepEqual(missingPreviousFx.compact.homeMovement, {
    status: "unavailable",
    currencyCode: "AUD",
    reason: "missing_previous_fx",
  });
  assert.deepEqual(
    missingPreviousFx.compact.homePercent,
    unavailable("missing_previous_fx"),
  );

  const incompleteTiming = calculateDailyMovement({
    quantityDecimal: "10",
    currentPriceDecimal: "110",
    previousPriceDecimal: "100",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    currentFx: usdAudCurrentFx,
    previousFx: usdAudPreviousFx,
    quantityTiming: "incomplete",
  });
  assert.equal(incompleteTiming.compact.homeMovement.status, "unavailable");
  if (incompleteTiming.compact.homeMovement.status === "unavailable") {
    assert.equal(
      incompleteTiming.compact.homeMovement.reason,
      "incomplete_quantity_timing",
    );
  }

  const negativeQuantity = calculateDailyMovement({
    quantityDecimal: "-1",
    currentPriceDecimal: "110",
    previousPriceDecimal: "100",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    currentFx: usdAudCurrentFx,
    previousFx: usdAudPreviousFx,
    quantityTiming: "comparable",
  });
  assert.deepEqual(negativeQuantity.compact.nativeMovement, {
    status: "unavailable",
    currencyCode: "USD",
    reason: "invalid_quantity",
  });
});

test("CALC-001B converts signed cash without rewriting the native balance", () => {
  const converted = calculateCashConversion({
    balanceDecimal: "-50.25",
    currencyCode: "USD",
    homeCurrencyCode: "AUD",
    valuationFx: usdAudPreviousFx,
  });
  assert.deepEqual(converted.compact.nativeBalance, {
    status: "available",
    currencyCode: "USD",
    valueDecimal: "-50.25",
  });
  assert.deepEqual(converted.compact.homeValue, {
    status: "available",
    currencyCode: "AUD",
    valueDecimal: "-75.375",
  });
});

test("CALC-001B partial totals align invested value and basis to the same holdings", () => {
  const totals = composePortfolioTotals({
    holdings: [
      {
        id: "aligned",
        homeMarketValue: available("300"),
        homeOpenBasis: available("200"),
      },
      {
        id: "missing-basis",
        homeMarketValue: available("100"),
        homeOpenBasis: unavailable("missing_basis"),
      },
      {
        id: "missing-value",
        homeMarketValue: unavailable("missing_fx"),
        homeOpenBasis: available("50"),
      },
    ],
    cashAccounts: [
      { id: "aud-cash", homeValue: available("50") },
      { id: "usd-cash", homeValue: unavailable("missing_fx") },
    ],
  });
  assert.equal(totals.status, "partial");
  assert.equal(totals.label, "known_value");
  assert.deepEqual(totals.amounts, {
    investedValueDecimal: "300",
    coveredOpenBasisDecimal: "200",
    unrealisedGainDecimal: "100",
    cashValueDecimal: "50",
    portfolioValueDecimal: "350",
  });
  assert.deepEqual(totals.coverage.excludedHoldingIds, [
    "missing-basis",
    "missing-value",
  ]);
  assert.deepEqual(totals.coverage.excludedCashAccountIds, ["usd-cash"]);
  assert.equal(JSON.parse(JSON.stringify(totals)).status, "partial");

  const complete = composePortfolioTotals({
    holdings: [
      {
        id: "only",
        homeMarketValue: available("300"),
        homeOpenBasis: available("200"),
      },
    ],
    cashAccounts: [{ id: "cash", homeValue: available("50") }],
  });
  assert.equal(complete.status, "complete");
  assert.equal(complete.label, "portfolio_value");

  const unavailableTotals = composePortfolioTotals({
    holdings: [
      {
        id: "unpriced",
        homeMarketValue: unavailable("missing_price"),
        homeOpenBasis: available("200"),
      },
    ],
    cashAccounts: [],
  });
  assert.deepEqual(unavailableTotals.amounts, null);
  assert.equal(unavailableTotals.status, "unavailable");
});

test("CALC-001B inversion and percentage rounding use half-even decimal boundaries", () => {
  const inverse = resolveFxRate({
    purpose: "valuation",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    selectedFx: { ...audUsdInverseFx, rateDecimal: "3" },
  });
  assert.equal(inverse.status, "available");
  if (inverse.status === "available") {
    assert.equal(inverse.rateDecimal, "0.333333333333333333");
  }

  const unsupportedScale = resolveFxRate({
    purpose: "valuation",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    selectedFx: audUsdInverseFx,
    inversionScale: 25,
  });
  assert.equal(unsupportedScale.status, "unavailable");
  if (unsupportedScale.status === "unavailable") {
    assert.equal(unsupportedScale.reason, "invalid_fx");
  }

  const roundedToZero = resolveFxRate({
    purpose: "valuation",
    nativeCurrencyCode: "USD",
    homeCurrencyCode: "AUD",
    selectedFx: { ...audUsdInverseFx, rateDecimal: "100" },
    inversionScale: 0,
  });
  assert.equal(roundedToZero.status, "unavailable");
  if (roundedToZero.status === "unavailable") {
    assert.equal(roundedToZero.reason, "invalid_fx");
  }
});
