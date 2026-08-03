import {
  addDecimal,
  compareDecimal,
  DECIMAL_LIMITS,
  divideDecimal,
  formatDecimalExact,
  formatDecimalTrimmed,
  fromInteger,
  multiplyDecimal,
  negateDecimal,
  parseDecimal,
  parseDecimalResult,
  roundDecimal,
  subtractDecimal,
  type DecimalFraction,
} from "./decimal.ts";
import {
  calculateNativeMarketValue,
  type CalculationUnavailableReason,
  type CalculationValue,
} from "./holding.ts";

type UnavailableCalculation = Extract<
  CalculationValue,
  { status: "unavailable" }
>;

export type FxUnavailableReason =
  | "missing_fx"
  | "missing_previous_fx"
  | "invalid_fx"
  | "invalid_transaction_fx"
  | "fx_direction_mismatch";

export type MultiCurrencyUnavailableReason = CalculationUnavailableReason;

export type FxSelectionState = "current" | "fallback" | "stale";

export type FxSelectionQuality =
  | "observed"
  | "corrected"
  | "indicative"
  | "stale_candidate"
  | "manual"
  | "transaction"
  | "identity";

export type FxActionability = "none" | "explanation" | "action_required";

export type FxEvidence = Readonly<{
  rateDecimal: string;
  baseCurrencyCode: string;
  quoteCurrencyCode: string;
  marketDate: string;
  observedAt: string | null;
  source: "transaction" | "manual" | "provider" | "identity";
  sourceId: string | null;
  selectionState: FxSelectionState;
  quality: FxSelectionQuality;
  fallback: boolean;
  selectionReason: string;
}>;

export type FxResolutionInput =
  | Readonly<{
      purpose: "transaction";
      nativeCurrencyCode: string;
      homeCurrencyCode: string;
      explicitTransactionFx?: FxEvidence | null;
      selectedFx?: FxEvidence | null;
      inversionScale?: number;
    }>
  | Readonly<{
      purpose: "valuation";
      nativeCurrencyCode: string;
      homeCurrencyCode: string;
      selectedFx?: FxEvidence | null;
      inversionScale?: number;
    }>;

export type FxExplanation = Readonly<{
  purpose: FxResolutionInput["purpose"];
  source: FxEvidence["source"] | "none";
  sourceId: string | null;
  marketDate: string | null;
  observedAt: string | null;
  suppliedBaseCurrencyCode: string | null;
  suppliedQuoteCurrencyCode: string | null;
  suppliedRateDecimal: string | null;
  inverted: boolean;
  selectionState: FxSelectionState | "unavailable";
  quality: FxSelectionQuality | null;
  fallback: boolean;
  selectionReason: string | null;
  actionability: FxActionability;
}>;

export type ResolvedFx =
  | Readonly<{
      status: "available";
      rateDecimal: string;
      nativeCurrencyCode: string;
      homeCurrencyCode: string;
      explanation: FxExplanation;
    }>
  | Readonly<{
      status: "unavailable";
      reason: FxUnavailableReason;
      nativeCurrencyCode: string;
      homeCurrencyCode: string;
      explanation: FxExplanation;
    }>;

export type CompactMoneyValue =
  | Readonly<{
      status: "available";
      currencyCode: string;
      valueDecimal: string;
    }>
  | Readonly<{
      status: "unavailable";
      currencyCode: string;
      reason: MultiCurrencyUnavailableReason;
    }>;

export type NativeHomeHoldingResult = Readonly<{
  facts: Readonly<{
    quantityDecimal: string | null;
    nativeCurrencyCode: string;
    homeCurrencyCode: string;
    nativePrice: CompactMoneyValue;
    nativeMarketValue: CompactMoneyValue;
    homePrice: CompactMoneyValue;
    homeMarketValue: CompactMoneyValue;
  }>;
  explanation: Readonly<{ fx: ResolvedFx }>;
}>;

export type HoldingCurrencyView = "native" | "home";

export type HoldingCurrencyPresentation = Readonly<{
  requestedView: HoldingCurrencyView;
  displayedView: HoldingCurrencyView;
  price: CompactMoneyValue;
  marketValue: CompactMoneyValue;
  usedNativeFallback: boolean;
}>;

export type DailyMovementResult = Readonly<{
  compact: Readonly<{
    nativeMovement: CompactMoneyValue;
    homeMovement: CompactMoneyValue;
    homePercent: CalculationValue;
  }>;
  decomposition: Readonly<{
    localPriceContribution: CalculationValue;
    pureFxContribution: CalculationValue;
    crossTerm: CalculationValue;
    fxContributionIncludingCrossTerm: CalculationValue;
  }>;
  explanation: Readonly<{
    currentFx: ResolvedFx;
    previousFx: ResolvedFx;
    quantityTiming: "comparable" | "incomplete";
  }>;
}>;

export type CashConversionResult = Readonly<{
  compact: Readonly<{
    nativeBalance: CompactMoneyValue;
    homeValue: CompactMoneyValue;
  }>;
  explanation: Readonly<{ fx: ResolvedFx }>;
}>;

export type PortfolioHoldingTotalInput = Readonly<{
  id: string;
  quantityDecimal: string;
  homeMarketValue: CalculationValue;
  homeOpenBasis: CalculationValue;
}>;

export type PortfolioCashTotalInput = Readonly<{
  id: string;
  nativeBalanceDecimal: string;
  homeValue: CalculationValue;
}>;

export type PortfolioCoverage = Readonly<{
  totalHoldingCount: number;
  nonZeroHoldingCount: number;
  zeroHoldingCount: number;
  invalidHoldingCount: number;
  pricedAndConvertedHoldingCount: number;
  basisCoveredHoldingCount: number;
  alignedHoldingCount: number;
  totalCashAccountCount: number;
  nonZeroCashAccountCount: number;
  zeroCashAccountCount: number;
  invalidCashAccountCount: number;
  convertedCashAccountCount: number;
  excludedHoldingIds: readonly string[];
  excludedCashAccountIds: readonly string[];
}>;

type AvailablePortfolioAmounts = Readonly<{
  investedValueDecimal: string;
  coveredOpenBasisDecimal: string;
  unrealisedGainDecimal: string;
  cashValueDecimal: string;
  portfolioValueDecimal: string;
}>;

export type PortfolioTotalsResult =
  | Readonly<{
      status: "complete";
      label: "portfolio_value";
      amounts: AvailablePortfolioAmounts;
      coverage: PortfolioCoverage;
    }>
  | Readonly<{
      status: "partial";
      label: "known_value";
      amounts: AvailablePortfolioAmounts;
      coverage: PortfolioCoverage;
    }>
  | Readonly<{
      status: "unavailable";
      label: "value_unavailable";
      amounts: null;
      coverage: PortfolioCoverage;
    }>;

const ZERO = fromInteger(0n);
const ONE = fromInteger(1n);
const DEFAULT_INVERSION_SCALE = 18;
const CURRENCY_CODE = /^[A-Z]{3}$/;

function unavailableCalculation(
  reason: CalculationUnavailableReason,
): UnavailableCalculation {
  return { status: "unavailable", reason };
}

function availableCalculation(value: DecimalFraction): CalculationValue {
  return { status: "available", valueDecimal: formatDecimalExact(value) };
}

function compactAvailable(
  currencyCode: string,
  valueDecimal: string,
): CompactMoneyValue {
  return { status: "available", currencyCode, valueDecimal };
}

function compactUnavailable(
  currencyCode: string,
  reason: MultiCurrencyUnavailableReason,
): CompactMoneyValue {
  return { status: "unavailable", currencyCode, reason };
}

function emptyFxExplanation(
  purpose: FxResolutionInput["purpose"],
): FxExplanation {
  return {
    purpose,
    source: "none",
    sourceId: null,
    marketDate: null,
    observedAt: null,
    suppliedBaseCurrencyCode: null,
    suppliedQuoteCurrencyCode: null,
    suppliedRateDecimal: null,
    inverted: false,
    selectionState: "unavailable",
    quality: null,
    fallback: false,
    selectionReason: null,
    actionability: "action_required",
  };
}

function evidenceExplanation(
  purpose: FxResolutionInput["purpose"],
  evidence: FxEvidence,
  inverted: boolean,
  actionability: FxActionability = fxActionability(evidence),
): FxExplanation {
  return {
    purpose,
    source: evidence.source,
    sourceId: evidence.sourceId,
    marketDate: evidence.marketDate,
    observedAt: evidence.observedAt,
    suppliedBaseCurrencyCode: evidence.baseCurrencyCode,
    suppliedQuoteCurrencyCode: evidence.quoteCurrencyCode,
    suppliedRateDecimal: evidence.rateDecimal,
    inverted,
    selectionState: evidence.selectionState,
    quality: evidence.quality,
    fallback: evidence.fallback,
    selectionReason: evidence.selectionReason,
    actionability,
  };
}

function fxActionability(evidence: FxEvidence): FxActionability {
  if (
    evidence.selectionState === "stale" ||
    evidence.selectionState === "fallback" ||
    evidence.fallback ||
    evidence.quality === "stale_candidate" ||
    evidence.quality === "manual" ||
    evidence.quality === "indicative" ||
    evidence.quality === "corrected"
  ) {
    return "explanation";
  }
  return "none";
}

function isConsistentFxEvidence(
  evidence: FxEvidence,
  explicitTransactionFact: boolean,
): boolean {
  const sourceMatchesQuality =
    (evidence.source === "provider" &&
      (evidence.quality === "observed" ||
        evidence.quality === "corrected" ||
        evidence.quality === "indicative" ||
        evidence.quality === "stale_candidate")) ||
    (evidence.source === "manual" && evidence.quality === "manual") ||
    (evidence.source === "transaction" && evidence.quality === "transaction") ||
    (evidence.source === "identity" && evidence.quality === "identity");
  const stateMatchesFallback =
    !(evidence.selectionState === "current" && evidence.fallback) &&
    !(evidence.selectionState === "fallback" && !evidence.fallback) &&
    !(
      evidence.quality === "stale_candidate" &&
      evidence.selectionState !== "stale"
    );
  const sourceMatchesPurpose = explicitTransactionFact
    ? evidence.source === "transaction" &&
      evidence.selectionState === "current" &&
      !evidence.fallback
    : evidence.source !== "transaction" && evidence.source !== "identity";
  return (
    sourceMatchesQuality &&
    stateMatchesFallback &&
    sourceMatchesPurpose &&
    evidence.selectionReason.trim().length > 0 &&
    evidence.quality !== "identity"
  );
}

function resolvedUnavailable(
  input: FxResolutionInput,
  reason: FxUnavailableReason,
  evidence?: FxEvidence,
): ResolvedFx {
  return {
    status: "unavailable",
    reason,
    nativeCurrencyCode: input.nativeCurrencyCode,
    homeCurrencyCode: input.homeCurrencyCode,
    explanation: evidence
      ? evidenceExplanation(input.purpose, evidence, false, "action_required")
      : emptyFxExplanation(input.purpose),
  };
}

export function resolveFxRate(input: FxResolutionInput): ResolvedFx {
  if (
    !CURRENCY_CODE.test(input.nativeCurrencyCode) ||
    !CURRENCY_CODE.test(input.homeCurrencyCode)
  ) {
    return resolvedUnavailable(input, "fx_direction_mismatch");
  }
  if (input.nativeCurrencyCode === input.homeCurrencyCode) {
    return {
      status: "available",
      rateDecimal: "1",
      nativeCurrencyCode: input.nativeCurrencyCode,
      homeCurrencyCode: input.homeCurrencyCode,
      explanation: {
        purpose: input.purpose,
        source: "identity",
        sourceId: null,
        marketDate: null,
        observedAt: null,
        suppliedBaseCurrencyCode: input.nativeCurrencyCode,
        suppliedQuoteCurrencyCode: input.homeCurrencyCode,
        suppliedRateDecimal: "1",
        inverted: false,
        selectionState: "current",
        quality: "identity",
        fallback: false,
        selectionReason: "Exact identity conversion applies.",
        actionability: "none",
      },
    };
  }

  const explicit =
    input.purpose === "transaction" ? input.explicitTransactionFx : undefined;
  const evidence = explicit ?? input.selectedFx;
  if (!evidence) return resolvedUnavailable(input, "missing_fx");
  if (!isConsistentFxEvidence(evidence, explicit !== undefined)) {
    return resolvedUnavailable(
      input,
      explicit ? "invalid_transaction_fx" : "invalid_fx",
      evidence,
    );
  }

  let rate: DecimalFraction;
  try {
    rate = parseDecimal(evidence.rateDecimal);
    if (compareDecimal(rate, ZERO) <= 0) {
      return resolvedUnavailable(
        input,
        explicit ? "invalid_transaction_fx" : "invalid_fx",
        evidence,
      );
    }
  } catch {
    return resolvedUnavailable(
      input,
      explicit ? "invalid_transaction_fx" : "invalid_fx",
      evidence,
    );
  }

  const direct =
    evidence.baseCurrencyCode === input.nativeCurrencyCode &&
    evidence.quoteCurrencyCode === input.homeCurrencyCode;
  const inverse =
    evidence.baseCurrencyCode === input.homeCurrencyCode &&
    evidence.quoteCurrencyCode === input.nativeCurrencyCode;
  if (!direct && !inverse) {
    return resolvedUnavailable(input, "fx_direction_mismatch", evidence);
  }

  try {
    const inversionScale = input.inversionScale ?? DEFAULT_INVERSION_SCALE;
    if (
      !Number.isSafeInteger(inversionScale) ||
      inversionScale < 0 ||
      inversionScale > DECIMAL_LIMITS.inputScale
    ) {
      return resolvedUnavailable(
        input,
        explicit ? "invalid_transaction_fx" : "invalid_fx",
        evidence,
      );
    }
    const normalized = inverse
      ? roundDecimal(divideDecimal(ONE, rate), inversionScale)
      : rate;
    if (compareDecimal(normalized, ZERO) <= 0) {
      return resolvedUnavailable(
        input,
        explicit ? "invalid_transaction_fx" : "invalid_fx",
        evidence,
      );
    }
    return {
      status: "available",
      rateDecimal: inverse
        ? formatDecimalTrimmed(normalized, inversionScale)
        : formatDecimalExact(normalized),
      nativeCurrencyCode: input.nativeCurrencyCode,
      homeCurrencyCode: input.homeCurrencyCode,
      explanation: evidenceExplanation(input.purpose, evidence, inverse),
    };
  } catch {
    return resolvedUnavailable(
      input,
      explicit ? "invalid_transaction_fx" : "invalid_fx",
      evidence,
    );
  }
}

function positiveDecimal(
  value: string | null,
  missingReason: CalculationUnavailableReason,
  invalidReason: CalculationUnavailableReason,
): DecimalFraction | UnavailableCalculation {
  if (value === null) return unavailableCalculation(missingReason);
  try {
    const parsed = parseDecimal(value);
    return compareDecimal(parsed, ZERO) > 0
      ? parsed
      : unavailableCalculation(invalidReason);
  } catch {
    return unavailableCalculation(invalidReason);
  }
}

function signedDecimal(
  value: string | null,
  missingReason: CalculationUnavailableReason,
  invalidReason: CalculationUnavailableReason,
): DecimalFraction | UnavailableCalculation {
  if (value === null) return unavailableCalculation(missingReason);
  try {
    return parseDecimal(value);
  } catch {
    return unavailableCalculation(invalidReason);
  }
}

function nonNegativeDecimal(
  value: string | null,
  missingReason: CalculationUnavailableReason,
  invalidReason: CalculationUnavailableReason,
): DecimalFraction | UnavailableCalculation {
  const parsed = signedDecimal(value, missingReason, invalidReason);
  if (isCalculationValue(parsed)) return parsed;
  return compareDecimal(parsed, ZERO) >= 0
    ? parsed
    : unavailableCalculation(invalidReason);
}

function isCalculationValue(
  value: DecimalFraction | UnavailableCalculation,
): value is UnavailableCalculation {
  return "status" in value;
}

function calculationToCompact(
  value: CalculationValue,
  currencyCode: string,
): CompactMoneyValue {
  return value.status === "available"
    ? compactAvailable(currencyCode, value.valueDecimal)
    : compactUnavailable(currencyCode, value.reason);
}

function parseCalculatedResult(
  valueDecimal: string,
): DecimalFraction | UnavailableCalculation {
  try {
    return parseDecimalResult(valueDecimal);
  } catch {
    return unavailableCalculation("invalid_input");
  }
}

function convertCalculatedValueToCompact(
  value: DecimalFraction,
  rate: DecimalFraction,
  currencyCode: string,
): CompactMoneyValue {
  try {
    return compactAvailable(
      currencyCode,
      formatDecimalExact(multiplyDecimal(value, rate)),
    );
  } catch {
    return compactUnavailable(currencyCode, "invalid_input");
  }
}

export function calculateNativeHomeHolding(
  input: Readonly<{
    quantityDecimal: string | null;
    nativePriceDecimal: string | null;
    nativeCurrencyCode: string;
    homeCurrencyCode: string;
    valuationFx?: FxEvidence | null;
    inversionScale?: number;
  }>,
): NativeHomeHoldingResult {
  let nativeMarketValue: CalculationValue;
  try {
    nativeMarketValue = calculateNativeMarketValue({
      quantityDecimal: input.quantityDecimal,
      priceDecimal: input.nativePriceDecimal,
    });
  } catch {
    nativeMarketValue = unavailableCalculation("invalid_input");
  }
  const nativePrice = positiveDecimal(
    input.nativePriceDecimal,
    "missing_price",
    "invalid_price",
  );
  const fx = resolveFxRate({
    purpose: "valuation",
    nativeCurrencyCode: input.nativeCurrencyCode,
    homeCurrencyCode: input.homeCurrencyCode,
    selectedFx: input.valuationFx,
    inversionScale: input.inversionScale,
  });

  let homePrice: CompactMoneyValue;
  let homeMarketValue: CompactMoneyValue;
  if (fx.status === "unavailable") {
    homePrice = compactUnavailable(input.homeCurrencyCode, fx.reason);
    homeMarketValue = compactUnavailable(input.homeCurrencyCode, fx.reason);
  } else if (isCalculationValue(nativePrice)) {
    homePrice = calculationToCompact(nativePrice, input.homeCurrencyCode);
    homeMarketValue = calculationToCompact(
      nativeMarketValue,
      input.homeCurrencyCode,
    );
  } else {
    let rate: DecimalFraction | null = null;
    try {
      rate = parseDecimalResult(fx.rateDecimal);
    } catch {
      // The selector result is already typed, but a malformed transport value
      // must still become a deterministic unavailable calculation.
    }
    homePrice =
      rate === null
        ? compactUnavailable(input.homeCurrencyCode, "invalid_input")
        : convertCalculatedValueToCompact(
            nativePrice,
            rate,
            input.homeCurrencyCode,
          );
    if (nativeMarketValue.status === "unavailable") {
      homeMarketValue = calculationToCompact(
        nativeMarketValue,
        input.homeCurrencyCode,
      );
    } else {
      const nativeMarketValueDecimal = parseCalculatedResult(
        nativeMarketValue.valueDecimal,
      );
      homeMarketValue =
        rate === null || isCalculationValue(nativeMarketValueDecimal)
          ? compactUnavailable(input.homeCurrencyCode, "invalid_input")
          : convertCalculatedValueToCompact(
              nativeMarketValueDecimal,
              rate,
              input.homeCurrencyCode,
            );
    }
  }

  return {
    facts: {
      quantityDecimal: input.quantityDecimal,
      nativeCurrencyCode: input.nativeCurrencyCode,
      homeCurrencyCode: input.homeCurrencyCode,
      nativePrice: isCalculationValue(nativePrice)
        ? calculationToCompact(nativePrice, input.nativeCurrencyCode)
        : compactAvailable(
            input.nativeCurrencyCode,
            formatDecimalExact(nativePrice),
          ),
      nativeMarketValue: calculationToCompact(
        nativeMarketValue,
        input.nativeCurrencyCode,
      ),
      homePrice,
      homeMarketValue,
    },
    explanation: { fx },
  };
}

export function selectHoldingCurrencyPresentation(
  result: NativeHomeHoldingResult,
  requestedView: HoldingCurrencyView,
): HoldingCurrencyPresentation {
  const homeAvailable =
    result.facts.homePrice.status === "available" &&
    result.facts.homeMarketValue.status === "available";
  const displayedView =
    requestedView === "home" && homeAvailable ? "home" : "native";
  return {
    requestedView,
    displayedView,
    price:
      displayedView === "home"
        ? result.facts.homePrice
        : result.facts.nativePrice,
    marketValue:
      displayedView === "home"
        ? result.facts.homeMarketValue
        : result.facts.nativeMarketValue,
    usedNativeFallback: requestedView === "home" && displayedView === "native",
  };
}

function absoluteDecimal(value: DecimalFraction): DecimalFraction {
  return compareDecimal(value, ZERO) < 0 ? negateDecimal(value) : value;
}

function dailyUnavailable(
  reason: CalculationUnavailableReason,
  currentFx: ResolvedFx,
  previousFx: ResolvedFx,
  quantityTiming: "comparable" | "incomplete",
  nativeMovement: CompactMoneyValue,
  homeCurrencyCode: string,
): DailyMovementResult {
  const unavailable = unavailableCalculation(reason);
  return {
    compact: {
      nativeMovement,
      homeMovement: compactUnavailable(homeCurrencyCode, reason),
      homePercent: unavailable,
    },
    decomposition: {
      localPriceContribution: unavailable,
      pureFxContribution: unavailable,
      crossTerm: unavailable,
      fxContributionIncludingCrossTerm: unavailable,
    },
    explanation: { currentFx, previousFx, quantityTiming },
  };
}

export function calculateDailyMovement(
  input: Readonly<{
    quantityDecimal: string | null;
    currentPriceDecimal: string | null;
    previousPriceDecimal: string | null;
    nativeCurrencyCode: string;
    homeCurrencyCode: string;
    currentFx?: FxEvidence | null;
    previousFx?: FxEvidence | null;
    quantityTiming: "comparable" | "incomplete";
    inversionScale?: number;
  }>,
): DailyMovementResult {
  const currentFx = resolveFxRate({
    purpose: "valuation",
    nativeCurrencyCode: input.nativeCurrencyCode,
    homeCurrencyCode: input.homeCurrencyCode,
    selectedFx: input.currentFx,
    inversionScale: input.inversionScale,
  });
  const previousFx = resolveFxRate({
    purpose: "valuation",
    nativeCurrencyCode: input.nativeCurrencyCode,
    homeCurrencyCode: input.homeCurrencyCode,
    selectedFx: input.previousFx,
    inversionScale: input.inversionScale,
  });
  const quantity = nonNegativeDecimal(
    input.quantityDecimal,
    "missing_quantity",
    "invalid_quantity",
  );
  const currentPrice = positiveDecimal(
    input.currentPriceDecimal,
    "missing_price",
    "invalid_price",
  );
  const previousPrice = positiveDecimal(
    input.previousPriceDecimal,
    "missing_previous_price",
    "invalid_previous_price",
  );
  const priceReason = isCalculationValue(quantity)
    ? quantity.reason
    : isCalculationValue(currentPrice)
      ? currentPrice.reason
      : isCalculationValue(previousPrice)
        ? previousPrice.reason
        : null;
  let nativeMovement: CompactMoneyValue;
  if (priceReason !== null) {
    nativeMovement = compactUnavailable(input.nativeCurrencyCode, priceReason);
  } else {
    try {
      nativeMovement = compactAvailable(
        input.nativeCurrencyCode,
        formatDecimalExact(
          multiplyDecimal(
            quantity as DecimalFraction,
            subtractDecimal(
              currentPrice as DecimalFraction,
              previousPrice as DecimalFraction,
            ),
          ),
        ),
      );
    } catch {
      nativeMovement = compactUnavailable(
        input.nativeCurrencyCode,
        "invalid_input",
      );
    }
  }
  if (priceReason !== null) {
    return dailyUnavailable(
      priceReason,
      currentFx,
      previousFx,
      input.quantityTiming,
      nativeMovement,
      input.homeCurrencyCode,
    );
  }
  if (nativeMovement.status === "unavailable") {
    return dailyUnavailable(
      nativeMovement.reason,
      currentFx,
      previousFx,
      input.quantityTiming,
      nativeMovement,
      input.homeCurrencyCode,
    );
  }
  if (input.quantityTiming === "incomplete") {
    return dailyUnavailable(
      "incomplete_quantity_timing",
      currentFx,
      previousFx,
      input.quantityTiming,
      nativeMovement,
      input.homeCurrencyCode,
    );
  }
  if (currentFx.status === "unavailable") {
    return dailyUnavailable(
      currentFx.reason,
      currentFx,
      previousFx,
      input.quantityTiming,
      nativeMovement,
      input.homeCurrencyCode,
    );
  }
  if (previousFx.status === "unavailable") {
    return dailyUnavailable(
      previousFx.reason === "missing_fx"
        ? "missing_previous_fx"
        : previousFx.reason,
      currentFx,
      previousFx,
      input.quantityTiming,
      nativeMovement,
      input.homeCurrencyCode,
    );
  }

  try {
    const q = quantity as DecimalFraction;
    const current = currentPrice as DecimalFraction;
    const previous = previousPrice as DecimalFraction;
    const currentRate = parseDecimalResult(currentFx.rateDecimal);
    const previousRate = parseDecimalResult(previousFx.rateDecimal);
    const priceChange = subtractDecimal(current, previous);
    const fxChange = subtractDecimal(currentRate, previousRate);
    const currentHomePrice = multiplyDecimal(current, currentRate);
    const previousHomePrice = multiplyDecimal(previous, previousRate);
    const homeMovement = multiplyDecimal(
      q,
      subtractDecimal(currentHomePrice, previousHomePrice),
    );
    const localContribution = multiplyDecimal(
      multiplyDecimal(q, priceChange),
      previousRate,
    );
    const pureFxContribution = multiplyDecimal(
      multiplyDecimal(q, previous),
      fxChange,
    );
    const crossTerm = multiplyDecimal(
      multiplyDecimal(q, priceChange),
      fxChange,
    );
    const fxIncludingCross = addDecimal(pureFxContribution, crossTerm);
    const previousValue = multiplyDecimal(q, previousHomePrice);
    const homePercent =
      compareDecimal(previousValue, ZERO) === 0
        ? unavailableCalculation("zero_previous_value")
        : {
            status: "available" as const,
            valueDecimal: formatDecimalTrimmed(
              multiplyDecimal(
                divideDecimal(homeMovement, absoluteDecimal(previousValue)),
                fromInteger(100n),
              ),
              2,
            ),
          };

    return {
      compact: {
        nativeMovement,
        homeMovement: compactAvailable(
          input.homeCurrencyCode,
          formatDecimalExact(homeMovement),
        ),
        homePercent,
      },
      decomposition: {
        localPriceContribution: availableCalculation(localContribution),
        pureFxContribution: availableCalculation(pureFxContribution),
        crossTerm: availableCalculation(crossTerm),
        fxContributionIncludingCrossTerm:
          availableCalculation(fxIncludingCross),
      },
      explanation: {
        currentFx,
        previousFx,
        quantityTiming: input.quantityTiming,
      },
    };
  } catch {
    return dailyUnavailable(
      "invalid_input",
      currentFx,
      previousFx,
      input.quantityTiming,
      nativeMovement,
      input.homeCurrencyCode,
    );
  }
}

export function calculateCashConversion(
  input: Readonly<{
    balanceDecimal: string | null;
    currencyCode: string;
    homeCurrencyCode: string;
    valuationFx?: FxEvidence | null;
    inversionScale?: number;
  }>,
): CashConversionResult {
  const balance = signedDecimal(
    input.balanceDecimal,
    "missing_balance",
    "invalid_balance",
  );
  const fx = resolveFxRate({
    purpose: "valuation",
    nativeCurrencyCode: input.currencyCode,
    homeCurrencyCode: input.homeCurrencyCode,
    selectedFx: input.valuationFx,
    inversionScale: input.inversionScale,
  });
  const nativeBalance = isCalculationValue(balance)
    ? calculationToCompact(balance, input.currencyCode)
    : compactAvailable(input.currencyCode, formatDecimalExact(balance));
  let homeValue: CompactMoneyValue;
  if (isCalculationValue(balance)) {
    homeValue = compactUnavailable(input.homeCurrencyCode, balance.reason);
  } else if (fx.status === "unavailable") {
    homeValue = compactUnavailable(input.homeCurrencyCode, fx.reason);
  } else {
    try {
      homeValue = compactAvailable(
        input.homeCurrencyCode,
        formatDecimalExact(
          multiplyDecimal(balance, parseDecimalResult(fx.rateDecimal)),
        ),
      );
    } catch {
      homeValue = compactUnavailable(input.homeCurrencyCode, "invalid_input");
    }
  }
  return { compact: { nativeBalance, homeValue }, explanation: { fx } };
}

function sumAvailable(values: readonly CalculationValue[]): string {
  let total = ZERO;
  for (const value of values) {
    if (value.status === "available") {
      total = addDecimal(total, parseDecimalResult(value.valueDecimal));
    }
  }
  return formatDecimalExact(total);
}

function hasUsableCalculatedValue(value: CalculationValue): boolean {
  return (
    value.status === "available" &&
    !isCalculationValue(parseCalculatedResult(value.valueDecimal))
  );
}

type ComponentMateriality = "zero" | "nonzero" | "invalid";

function componentMateriality(
  valueDecimal: string,
  allowNegative: boolean,
): ComponentMateriality {
  try {
    const comparison = compareDecimal(parseDecimal(valueDecimal), ZERO);
    if (comparison === 0) return "zero";
    return comparison < 0 && !allowNegative ? "invalid" : "nonzero";
  } catch {
    return "invalid";
  }
}

export function composePortfolioTotals(
  input: Readonly<{
    holdings: readonly PortfolioHoldingTotalInput[];
    cashAccounts: readonly PortfolioCashTotalInput[];
  }>,
): PortfolioTotalsResult {
  const holdingMateriality = new Map(
    input.holdings.map((holding) => [
      holding,
      componentMateriality(holding.quantityDecimal, false),
    ]),
  );
  const cashMateriality = new Map(
    input.cashAccounts.map((account) => [
      account,
      componentMateriality(account.nativeBalanceDecimal, true),
    ]),
  );
  const zeroHoldings = input.holdings.filter(
    (holding) => holdingMateriality.get(holding) === "zero",
  );
  const nonZeroHoldings = input.holdings.filter(
    (holding) => holdingMateriality.get(holding) === "nonzero",
  );
  const invalidHoldings = input.holdings.filter(
    (holding) => holdingMateriality.get(holding) === "invalid",
  );
  const zeroCashAccounts = input.cashAccounts.filter(
    (account) => cashMateriality.get(account) === "zero",
  );
  const nonZeroCashAccounts = input.cashAccounts.filter(
    (account) => cashMateriality.get(account) === "nonzero",
  );
  const invalidCashAccounts = input.cashAccounts.filter(
    (account) => cashMateriality.get(account) === "invalid",
  );
  const alignedHoldings = nonZeroHoldings.filter(
    (holding) =>
      hasUsableCalculatedValue(holding.homeMarketValue) &&
      hasUsableCalculatedValue(holding.homeOpenBasis),
  );
  const convertedCash = nonZeroCashAccounts.filter((account) =>
    hasUsableCalculatedValue(account.homeValue),
  );
  const coverage: PortfolioCoverage = {
    totalHoldingCount: input.holdings.length,
    nonZeroHoldingCount: nonZeroHoldings.length,
    zeroHoldingCount: zeroHoldings.length,
    invalidHoldingCount: invalidHoldings.length,
    pricedAndConvertedHoldingCount: nonZeroHoldings.filter((holding) =>
      hasUsableCalculatedValue(holding.homeMarketValue),
    ).length,
    basisCoveredHoldingCount: nonZeroHoldings.filter((holding) =>
      hasUsableCalculatedValue(holding.homeOpenBasis),
    ).length,
    alignedHoldingCount: alignedHoldings.length,
    totalCashAccountCount: input.cashAccounts.length,
    nonZeroCashAccountCount: nonZeroCashAccounts.length,
    zeroCashAccountCount: zeroCashAccounts.length,
    invalidCashAccountCount: invalidCashAccounts.length,
    convertedCashAccountCount: convertedCash.length,
    excludedHoldingIds: input.holdings
      .filter(
        (holding) =>
          holdingMateriality.get(holding) === "invalid" ||
          (holdingMateriality.get(holding) === "nonzero" &&
            !alignedHoldings.includes(holding)),
      )
      .map((holding) => holding.id),
    excludedCashAccountIds: input.cashAccounts
      .filter(
        (account) =>
          cashMateriality.get(account) === "invalid" ||
          (cashMateriality.get(account) === "nonzero" &&
            !convertedCash.includes(account)),
      )
      .map((account) => account.id),
  };
  const hasKnownAmount = alignedHoldings.length > 0 || convertedCash.length > 0;
  const hasExplicitComponents =
    input.holdings.length > 0 || input.cashAccounts.length > 0;
  const allComponentsAreZero =
    hasExplicitComponents &&
    nonZeroHoldings.length === 0 &&
    nonZeroCashAccounts.length === 0 &&
    invalidHoldings.length === 0 &&
    invalidCashAccounts.length === 0;
  if (!hasKnownAmount) {
    if (allComponentsAreZero) {
      return {
        status: "complete",
        label: "portfolio_value",
        amounts: {
          investedValueDecimal: "0",
          coveredOpenBasisDecimal: "0",
          unrealisedGainDecimal: "0",
          cashValueDecimal: "0",
          portfolioValueDecimal: "0",
        },
        coverage,
      };
    }
    return {
      status: "unavailable",
      label: "value_unavailable",
      amounts: null,
      coverage,
    };
  }

  let investedValueDecimal: string;
  let coveredOpenBasisDecimal: string;
  let cashValueDecimal: string;
  let unrealisedGainDecimal: string;
  let portfolioValueDecimal: string;
  try {
    investedValueDecimal = sumAvailable(
      alignedHoldings.map((holding) => holding.homeMarketValue),
    );
    coveredOpenBasisDecimal = sumAvailable(
      alignedHoldings.map((holding) => holding.homeOpenBasis),
    );
    cashValueDecimal = sumAvailable(
      convertedCash.map((account) => account.homeValue),
    );
    unrealisedGainDecimal = formatDecimalExact(
      subtractDecimal(
        parseDecimalResult(investedValueDecimal),
        parseDecimalResult(coveredOpenBasisDecimal),
      ),
    );
    portfolioValueDecimal = formatDecimalExact(
      addDecimal(
        parseDecimalResult(investedValueDecimal),
        parseDecimalResult(cashValueDecimal),
      ),
    );
  } catch {
    return {
      status: "unavailable",
      label: "value_unavailable",
      amounts: null,
      coverage,
    };
  }
  const amounts = {
    investedValueDecimal,
    coveredOpenBasisDecimal,
    unrealisedGainDecimal,
    cashValueDecimal,
    portfolioValueDecimal,
  };
  const complete =
    coverage.invalidHoldingCount === 0 &&
    coverage.invalidCashAccountCount === 0 &&
    coverage.alignedHoldingCount === coverage.nonZeroHoldingCount &&
    coverage.convertedCashAccountCount === coverage.nonZeroCashAccountCount;
  return complete
    ? { status: "complete", label: "portfolio_value", amounts, coverage }
    : { status: "partial", label: "known_value", amounts, coverage };
}
