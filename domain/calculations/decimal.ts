import Decimal from "decimal.js";

export const DECIMAL_LIMITS = Object.freeze({
  inputDigits: 64,
  inputScale: 24,
  exactResultDigits: 256,
  resultScale: 96,
  allocationScale: 24,
  workingPrecision: 320,
});

const FinancialDecimal = Decimal.clone({
  precision: DECIMAL_LIMITS.workingPrecision,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -1_000,
  toExpPos: 1_000,
  minE: -1_000,
  maxE: 1_000,
});

/**
 * Opaque exact-decimal value. The legacy name is retained for callers, but the
 * implementation is decimal.js rather than a bespoke fraction type.
 */
const DECIMAL_VALUE: unique symbol = Symbol("financial-decimal-value");
const DECIMAL_SOURCE_SCALE: unique symbol = Symbol("financial-decimal-scale");
const DECIMAL_EXACT_DIGITS: unique symbol = Symbol("financial-decimal-digits");

export type DecimalFraction = Readonly<{
  [DECIMAL_VALUE]: Decimal;
  [DECIMAL_SOURCE_SCALE]: number | null;
  [DECIMAL_EXACT_DIGITS]: number | null;
}>;

export type DecimalRoundingMode = "half-even";

type DecimalOptions = Readonly<{
  trimTrailingZeros?: boolean;
}>;

export type ProportionalAllocationInput = Readonly<{
  totalDecimal: string;
  partDecimal: string;
  denominatorDecimal: string;
  allocatedDecimal?: string;
  isFinal?: boolean;
  scale?: number;
}>;

export type ProportionalAllocationResult =
  | { ok: true; valueDecimal: string; nextAllocatedDecimal: string }
  | {
      ok: false;
      reason:
        | "invalid_decimal"
        | "invalid_scale"
        | "negative_total"
        | "invalid_allocated"
        | "non_positive_denominator"
        | "part_exceeds_denominator";
    };

const DECIMAL_PATTERN = /^-?(0|[1-9]\d*)(?:\.(\d+))?$/;

function validScale(scale: number, maximum: number): boolean {
  return Number.isSafeInteger(scale) && scale >= 0 && scale <= maximum;
}

function wrap(
  decimal: Decimal,
  sourceScale: number | null,
  exactDigits: number | null,
): DecimalFraction {
  if (!decimal.isFinite()) throw new Error("Invalid decimal result.");
  if (exactDigits !== null && exactDigits > DECIMAL_LIMITS.exactResultDigits) {
    throw new Error("Decimal result precision exceeds the supported boundary.");
  }
  return Object.freeze({
    [DECIMAL_VALUE]: decimal,
    [DECIMAL_SOURCE_SCALE]: sourceScale,
    [DECIMAL_EXACT_DIGITS]: exactDigits,
  });
}

const decimalValue = (value: DecimalFraction): Decimal => value[DECIMAL_VALUE];
const sourceScale = (value: DecimalFraction): number | null =>
  value[DECIMAL_SOURCE_SCALE];
const exactDigitCount = (value: DecimalFraction): number | null =>
  value[DECIMAL_EXACT_DIGITS];

function combinedScale(
  left: DecimalFraction,
  right: DecimalFraction,
  operation: "add" | "multiply",
): number | null {
  if (sourceScale(left) === null || sourceScale(right) === null) return null;
  const scale =
    operation === "add"
      ? Math.max(sourceScale(left)!, sourceScale(right)!)
      : sourceScale(left)! + sourceScale(right)!;
  if (!validScale(scale, DECIMAL_LIMITS.resultScale)) {
    throw new Error("Decimal result scale exceeds the supported boundary.");
  }
  return scale;
}

function trimFixed(value: string): string {
  const trimmed = value
    .replace(/(?:\.0+|(\.\d+?)0+)$/, "$1")
    .replace(/\.$/, "");
  return trimmed === "-0" ? "0" : trimmed;
}

function parseBoundedDecimal(
  value: string,
  digitLimit: number,
  scaleLimit: number,
  kind: "input" | "result",
): DecimalFraction {
  const match = DECIMAL_PATTERN.exec(value);
  if (match === null) throw new Error("Invalid decimal string.");
  if (/^-0(?:\.0+)?$/.test(value)) {
    throw new Error("Invalid decimal string: negative zero is not canonical.");
  }
  const fraction = match[2] ?? "";
  const digitCount = value.replace("-", "").replace(".", "").length;
  if (digitCount > digitLimit || fraction.length > scaleLimit) {
    throw new Error(`Invalid decimal ${kind}: supported boundary exceeded.`);
  }
  const decimal = new FinancialDecimal(value);
  return wrap(decimal, fraction.length, decimal.sd());
}

export function parseDecimal(value: string): DecimalFraction {
  return parseBoundedDecimal(
    value,
    DECIMAL_LIMITS.inputDigits,
    DECIMAL_LIMITS.inputScale,
    "input",
  );
}

/**
 * Parse a canonical decimal transported between calculation stages. This
 * deliberately accepts the wider exact-result boundary, while source facts
 * continue to use parseDecimal's narrower validation.
 */
export function parseDecimalResult(value: string): DecimalFraction {
  return parseBoundedDecimal(
    value,
    DECIMAL_LIMITS.exactResultDigits,
    DECIMAL_LIMITS.resultScale,
    "result",
  );
}

export function fromInteger(value: bigint): DecimalFraction {
  const text = value.toString();
  if (text.replace("-", "").length > DECIMAL_LIMITS.inputDigits) {
    throw new Error("Invalid decimal integer: supported boundary exceeded.");
  }
  const decimal = new FinancialDecimal(text);
  return wrap(decimal, 0, decimal.sd());
}

export function isZero(value: DecimalFraction): boolean {
  return decimalValue(value).isZero();
}

export function compareDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): number {
  return decimalValue(left).comparedTo(decimalValue(right));
}

export function addDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): DecimalFraction {
  return wrap(
    decimalValue(left).plus(decimalValue(right)),
    combinedScale(left, right, "add"),
    exactDigitCount(left) === null || exactDigitCount(right) === null
      ? null
      : decimalValue(left).plus(decimalValue(right)).sd(),
  );
}

export function negateDecimal(value: DecimalFraction): DecimalFraction {
  return wrap(
    decimalValue(value).negated(),
    sourceScale(value),
    exactDigitCount(value),
  );
}

export function subtractDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): DecimalFraction {
  return wrap(
    decimalValue(left).minus(decimalValue(right)),
    combinedScale(left, right, "add"),
    exactDigitCount(left) === null || exactDigitCount(right) === null
      ? null
      : decimalValue(left).minus(decimalValue(right)).sd(),
  );
}

export function multiplyDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): DecimalFraction {
  const productDigitBound =
    exactDigitCount(left) === null || exactDigitCount(right) === null
      ? null
      : exactDigitCount(left)! + exactDigitCount(right)!;
  if (
    productDigitBound !== null &&
    productDigitBound > DECIMAL_LIMITS.exactResultDigits
  ) {
    throw new Error("Decimal result precision exceeds the supported boundary.");
  }
  const product = decimalValue(left).times(decimalValue(right));
  return wrap(
    product,
    combinedScale(left, right, "multiply"),
    productDigitBound === null ? null : product.sd(),
  );
}

export function divideDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): DecimalFraction {
  if (decimalValue(right).isZero()) throw new Error("Cannot divide by zero.");
  return wrap(decimalValue(left).dividedBy(decimalValue(right)), null, null);
}

export function roundDecimal(
  value: DecimalFraction,
  scale: number,
  _mode: DecimalRoundingMode = "half-even",
): DecimalFraction {
  void _mode;
  if (!validScale(scale, DECIMAL_LIMITS.resultScale)) {
    throw new Error("Decimal scale is outside the supported boundary.");
  }
  return wrap(
    decimalValue(value).toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN),
    scale,
    decimalValue(value).toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN).sd(),
  );
}

export function formatDecimalFixed(
  value: DecimalFraction,
  scale: number,
): string {
  if (!validScale(scale, DECIMAL_LIMITS.resultScale)) {
    throw new Error("Decimal scale is outside the supported boundary.");
  }
  const formatted = decimalValue(value).toFixed(scale, Decimal.ROUND_HALF_EVEN);
  return /^-0(?:\.0+)?$/.test(formatted)
    ? formatted.replace("-", "")
    : formatted;
}

export function formatDecimalTrimmed(
  value: DecimalFraction,
  scale: number,
  options: DecimalOptions = {},
): string {
  const fixed = formatDecimalFixed(value, scale);
  return options.trimTrailingZeros === false ? fixed : trimFixed(fixed);
}

export function formatDecimalExact(value: DecimalFraction): string {
  if (sourceScale(value) === null) {
    throw new Error("An explicit rounding scale is required for division.");
  }
  return trimFixed(
    decimalValue(value).toFixed(sourceScale(value)!, Decimal.ROUND_HALF_EVEN),
  );
}

export function toDecimal(
  value: string | bigint | DecimalFraction,
): DecimalFraction {
  if (typeof value === "bigint") return fromInteger(value);
  if (typeof value === "string") return parseDecimal(value);
  return wrap(
    new FinancialDecimal(decimalValue(value)),
    sourceScale(value),
    exactDigitCount(value),
  );
}

export function toIntegerString(value: DecimalFraction): string {
  return formatDecimalFixed(value, 0);
}

export function allocateProportional(
  input: ProportionalAllocationInput,
): ProportionalAllocationResult {
  const scale = input.scale ?? 18;
  if (!validScale(scale, DECIMAL_LIMITS.allocationScale)) {
    return { ok: false, reason: "invalid_scale" };
  }

  let total: DecimalFraction;
  let part: DecimalFraction;
  let denominator: DecimalFraction;
  let allocated: DecimalFraction;
  try {
    total = parseDecimal(input.totalDecimal);
    part = parseDecimal(input.partDecimal);
    denominator = parseDecimal(input.denominatorDecimal);
    allocated = parseDecimal(input.allocatedDecimal ?? "0");
  } catch {
    return { ok: false, reason: "invalid_decimal" };
  }
  const zero = fromInteger(0n);
  if (compareDecimal(total, zero) < 0) {
    return { ok: false, reason: "negative_total" };
  }
  if (
    compareDecimal(allocated, zero) < 0 ||
    compareDecimal(allocated, total) > 0
  ) {
    return { ok: false, reason: "invalid_allocated" };
  }
  if (compareDecimal(denominator, zero) <= 0) {
    return { ok: false, reason: "non_positive_denominator" };
  }
  if (compareDecimal(part, zero) < 0 || compareDecimal(part, denominator) > 0) {
    return { ok: false, reason: "part_exceeds_denominator" };
  }

  const value = input.isFinal
    ? subtractDecimal(total, allocated)
    : roundDecimal(
        divideDecimal(multiplyDecimal(total, part), denominator),
        scale,
      );
  const valueDecimal = formatDecimalTrimmed(value, scale);
  return {
    ok: true,
    valueDecimal,
    nextAllocatedDecimal: formatDecimalTrimmed(
      addDecimal(allocated, parseDecimal(valueDecimal)),
      scale,
    ),
  };
}
