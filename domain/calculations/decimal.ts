export type DecimalFraction = Readonly<{
  numerator: bigint;
  denominator: bigint;
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
        | "non_positive_denominator"
        | "part_exceeds_denominator";
    };

const POW10_CACHE: bigint[] = [1n];

function pow10(scale: number): bigint {
  if (!Number.isSafeInteger(scale) || scale < 0) {
    throw new Error("Decimal scale must be a non-negative safe integer.");
  }
  while (POW10_CACHE.length <= scale) {
    const previous = POW10_CACHE[POW10_CACHE.length - 1] ?? 1n;
    POW10_CACHE.push(previous * 10n);
  }
  return POW10_CACHE[scale] ?? 1n;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function normalizeFraction(
  numerator: bigint,
  denominator: bigint,
): DecimalFraction {
  if (denominator === 0n)
    throw new Error("Decimal denominator cannot be zero.");
  if (numerator === 0n) return { numerator: 0n, denominator: 1n };

  const sign = denominator < 0n ? -1n : 1n;
  const normalizedNumerator = numerator * sign;
  const normalizedDenominator = denominator < 0n ? -denominator : denominator;
  const divisor = gcd(normalizedNumerator, normalizedDenominator);
  return {
    numerator: normalizedNumerator / divisor,
    denominator: normalizedDenominator / divisor,
  };
}

export function parseDecimal(value: string): DecimalFraction {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) throw new Error(`Invalid decimal string: ${value}`);

  const sign = match[1] === "-" ? -1n : 1n;
  const integerDigits = match[2] ?? "0";
  const fractionDigits = match[3] ?? "";
  const digits = `${integerDigits}${fractionDigits}`.replace(/^0+(?=\d)/, "");
  return normalizeFraction(
    BigInt(digits.length > 0 ? digits : "0") * sign,
    pow10(fractionDigits.length),
  );
}

export function fromInteger(value: bigint): DecimalFraction {
  return { numerator: value, denominator: 1n };
}

export function isZero(value: DecimalFraction): boolean {
  return value.numerator === 0n;
}

export function compareDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): number {
  const leftNumerator = left.numerator * right.denominator;
  const rightNumerator = right.numerator * left.denominator;
  return leftNumerator === rightNumerator
    ? 0
    : leftNumerator < rightNumerator
      ? -1
      : 1;
}

export function addDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): DecimalFraction {
  return normalizeFraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function negateDecimal(value: DecimalFraction): DecimalFraction {
  return { numerator: -value.numerator, denominator: value.denominator };
}

export function subtractDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): DecimalFraction {
  return addDecimal(left, negateDecimal(right));
}

export function multiplyDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): DecimalFraction {
  return normalizeFraction(
    left.numerator * right.numerator,
    left.denominator * right.denominator,
  );
}

export function divideDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): DecimalFraction {
  if (right.numerator === 0n) throw new Error("Cannot divide by zero.");
  return normalizeFraction(
    left.numerator * right.denominator,
    left.denominator * right.numerator,
  );
}

function roundHalfEvenInteger(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubledRemainder = remainder * 2n;
  if (
    doubledRemainder > denominator ||
    (doubledRemainder === denominator && quotient % 2n !== 0n)
  ) {
    return quotient + 1n;
  }
  return quotient;
}

export function roundDecimal(
  value: DecimalFraction,
  scale: number,
  _mode: DecimalRoundingMode = "half-even",
): DecimalFraction {
  void _mode;
  const absoluteNumerator =
    value.numerator < 0n ? -value.numerator : value.numerator;
  const rounded = roundHalfEvenInteger(
    absoluteNumerator * pow10(scale),
    value.denominator,
  );
  return normalizeFraction(
    value.numerator < 0n ? -rounded : rounded,
    pow10(scale),
  );
}

export function formatDecimalFixed(
  value: DecimalFraction,
  scale: number,
): string {
  const divisor = pow10(scale);
  const absoluteNumerator =
    value.numerator < 0n ? -value.numerator : value.numerator;
  const roundedInteger = roundHalfEvenInteger(
    absoluteNumerator * divisor,
    value.denominator,
  );
  const signedRoundedInteger =
    value.numerator < 0n ? -roundedInteger : roundedInteger;
  const absoluteRoundedInteger =
    signedRoundedInteger < 0n ? -signedRoundedInteger : signedRoundedInteger;
  const integerPart = absoluteRoundedInteger / divisor;
  const fractionPart = absoluteRoundedInteger % divisor;
  const sign = signedRoundedInteger < 0n ? "-" : "";
  if (scale === 0) return `${sign}${integerPart}`;
  return `${sign}${integerPart}.${fractionPart.toString().padStart(scale, "0")}`;
}

export function formatDecimalTrimmed(
  value: DecimalFraction,
  scale: number,
  options: DecimalOptions = {},
): string {
  const fixed = formatDecimalFixed(value, scale);
  if (options.trimTrailingZeros === false || !fixed.includes(".")) return fixed;
  return fixed.replace(/(?:\.0+|(\.\d+?)0+)$/, "$1").replace(/\.$/, "");
}

export function toDecimal(
  value: string | bigint | DecimalFraction,
): DecimalFraction {
  if (typeof value === "bigint") return fromInteger(value);
  if (typeof value === "string") return parseDecimal(value);
  return normalizeFraction(value.numerator, value.denominator);
}

export function toIntegerString(value: DecimalFraction): string {
  return formatDecimalFixed(value, 0);
}

export function allocateProportional(
  input: ProportionalAllocationInput,
): ProportionalAllocationResult {
  const scale = input.scale ?? 18;
  if (!Number.isSafeInteger(scale) || scale < 0) {
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
  if (compareDecimal(denominator, fromInteger(0n)) <= 0) {
    return { ok: false, reason: "non_positive_denominator" };
  }
  if (
    compareDecimal(part, fromInteger(0n)) < 0 ||
    compareDecimal(part, denominator) > 0
  ) {
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
