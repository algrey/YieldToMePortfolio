import {
  addDecimal,
  compareDecimal,
  formatDecimalTrimmed,
  fromInteger,
  divideDecimal,
  multiplyDecimal,
  parseDecimal,
  subtractDecimal,
  type DecimalFraction,
} from "./decimal.ts";

export type CalculationUnavailableReason =
  | "missing_quantity"
  | "invalid_quantity"
  | "missing_price"
  | "invalid_price"
  | "missing_previous_price"
  | "invalid_previous_price"
  | "missing_basis"
  | "incomplete_basis"
  | "zero_basis"
  | "missing_proceeds"
  | "missing_matched_basis"
  | "invalid_input";

export type CalculationValue =
  | { status: "available"; valueDecimal: string }
  | { status: "unavailable"; reason: CalculationUnavailableReason };

export type HoldingLotBasis = Readonly<{
  remainingQuantityDecimal: string;
  remainingBasisDecimal: string | null;
}>;

export type SingleDateHoldingInput = Readonly<{
  quantityDecimal: string | null;
  priceDecimal: string | null;
  previousPriceDecimal?: string | null;
  openBasisDecimal: string | null;
  realisedGainDecimal?: string | null;
}>;

export type SingleDateHoldingResult = Readonly<{
  quantity: CalculationValue;
  nativeMarketValue: CalculationValue;
  previousNativeMarketValue: CalculationValue;
  dailyMovement: CalculationValue;
  openBasis: CalculationValue;
  unrealisedGain: CalculationValue;
  unrealisedPercent: CalculationValue;
  realisedGain: CalculationValue;
  totalGain: CalculationValue;
  totalPercent: CalculationValue;
}>;

const ZERO = fromInteger(0n);

function unavailable(reason: CalculationUnavailableReason): CalculationValue {
  return { status: "unavailable", reason };
}

function unavailableReason(
  value: CalculationValue,
): CalculationUnavailableReason {
  return value.status === "unavailable" ? value.reason : "invalid_input";
}

function available(value: DecimalFraction, scale = 18): CalculationValue {
  return {
    status: "available",
    valueDecimal: formatDecimalTrimmed(value, scale),
  };
}

function nonNegative(
  value: string | null,
  missing: CalculationUnavailableReason,
  invalid: CalculationUnavailableReason,
): DecimalFraction | CalculationValue {
  if (value === null) return unavailable(missing);
  try {
    const parsed = parseDecimal(value);
    return compareDecimal(parsed, ZERO) >= 0 ? parsed : unavailable(invalid);
  } catch {
    return unavailable(invalid);
  }
}

function positive(
  value: string | null,
  missing: CalculationUnavailableReason,
  invalid: CalculationUnavailableReason,
): DecimalFraction | CalculationValue {
  if (value === null) return unavailable(missing);
  try {
    const parsed = parseDecimal(value);
    return compareDecimal(parsed, ZERO) > 0 ? parsed : unavailable(invalid);
  } catch {
    return unavailable(invalid);
  }
}

function isCalculationValue(
  value: DecimalFraction | CalculationValue,
): value is CalculationValue {
  return "status" in value;
}

function calculatePercentage(
  gain: CalculationValue,
  basis: CalculationValue,
): CalculationValue {
  if (gain.status === "unavailable") return gain;
  if (basis.status === "unavailable") return basis;
  const basisDecimal = parseDecimal(basis.valueDecimal);
  if (compareDecimal(basisDecimal, ZERO) === 0)
    return unavailable("zero_basis");
  return available(
    multiplyDecimal(
      divideDecimal(parseDecimal(gain.valueDecimal), basisDecimal),
      fromInteger(100n),
    ),
    2,
  );
}

export function calculateNativeMarketValue(
  input: Readonly<{
    quantityDecimal: string | null;
    priceDecimal: string | null;
  }>,
): CalculationValue {
  const quantity = nonNegative(
    input.quantityDecimal,
    "missing_quantity",
    "invalid_quantity",
  );
  if (isCalculationValue(quantity)) return quantity;
  const price = positive(input.priceDecimal, "missing_price", "invalid_price");
  if (isCalculationValue(price)) return price;
  return available(multiplyDecimal(quantity, price));
}

export function calculateOpenBasis(
  lots: readonly HoldingLotBasis[],
): CalculationValue {
  let total = ZERO;
  for (const lot of lots) {
    if (lot.remainingBasisDecimal === null)
      return unavailable("incomplete_basis");
    const basis = nonNegative(
      lot.remainingBasisDecimal,
      "missing_basis",
      "incomplete_basis",
    );
    if (isCalculationValue(basis)) return basis;
    total = addDecimal(total, basis);
  }
  return available(total);
}

export function calculateRealisedGain(
  input: Readonly<{
    netProceedsDecimal: string | null;
    matchedBasisDecimal: string | null;
  }>,
): CalculationValue {
  const proceeds = nonNegative(
    input.netProceedsDecimal,
    "missing_proceeds",
    "invalid_input",
  );
  if (isCalculationValue(proceeds)) return proceeds;
  const basis = nonNegative(
    input.matchedBasisDecimal,
    "missing_matched_basis",
    "invalid_input",
  );
  if (isCalculationValue(basis)) return basis;
  return available(subtractDecimal(proceeds, basis));
}

export function calculateSingleDateHolding(
  input: SingleDateHoldingInput,
): SingleDateHoldingResult {
  const quantity = nonNegative(
    input.quantityDecimal,
    "missing_quantity",
    "invalid_quantity",
  );
  const nativeMarketValue = calculateNativeMarketValue(input);
  const previousNativeMarketValue =
    input.previousPriceDecimal === undefined
      ? unavailable("missing_previous_price")
      : calculateNativeMarketValue({
          quantityDecimal: input.quantityDecimal,
          priceDecimal: input.previousPriceDecimal,
        });
  const openBasis =
    input.openBasisDecimal === null
      ? unavailable("missing_basis")
      : (() => {
          const basis = nonNegative(
            input.openBasisDecimal,
            "missing_basis",
            "incomplete_basis",
          );
          return isCalculationValue(basis) ? basis : available(basis);
        })();
  const dailyMovement =
    nativeMarketValue.status === "available" &&
    previousNativeMarketValue.status === "available"
      ? available(
          subtractDecimal(
            parseDecimal(nativeMarketValue.valueDecimal),
            parseDecimal(previousNativeMarketValue.valueDecimal),
          ),
        )
      : unavailable(
          nativeMarketValue.status === "unavailable"
            ? nativeMarketValue.reason
            : unavailableReason(previousNativeMarketValue),
        );
  const unrealisedGain =
    nativeMarketValue.status === "available" && openBasis.status === "available"
      ? available(
          subtractDecimal(
            parseDecimal(nativeMarketValue.valueDecimal),
            parseDecimal(openBasis.valueDecimal),
          ),
        )
      : unavailable(
          nativeMarketValue.status === "unavailable"
            ? nativeMarketValue.reason
            : unavailableReason(openBasis),
        );
  const realisedGain =
    input.realisedGainDecimal === undefined
      ? unavailable("missing_proceeds")
      : (() => {
          if (input.realisedGainDecimal === null) {
            return unavailable("missing_proceeds");
          }
          try {
            return available(parseDecimal(input.realisedGainDecimal));
          } catch {
            return unavailable("invalid_input");
          }
        })();
  const totalGain =
    unrealisedGain.status === "available" && realisedGain.status === "available"
      ? available(
          addDecimal(
            parseDecimal(unrealisedGain.valueDecimal),
            parseDecimal(realisedGain.valueDecimal),
          ),
        )
      : unavailable(
          unrealisedGain.status === "unavailable"
            ? unrealisedGain.reason
            : unavailableReason(realisedGain),
        );

  return {
    quantity: isCalculationValue(quantity) ? quantity : available(quantity),
    nativeMarketValue,
    previousNativeMarketValue,
    dailyMovement,
    openBasis,
    unrealisedGain,
    unrealisedPercent: calculatePercentage(unrealisedGain, openBasis),
    realisedGain,
    totalGain,
    totalPercent: calculatePercentage(totalGain, openBasis),
  };
}

export const calculateHolding = calculateSingleDateHolding;
