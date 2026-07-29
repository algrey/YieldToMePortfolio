export type DecimalFraction = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

type DecimalOptions = Readonly<{
  trimTrailingZeros?: boolean;
}>;

const POW10_CACHE: bigint[] = [1n];

function pow10(scale: number): bigint {
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
  if (denominator === 0n) {
    throw new Error("Decimal denominator cannot be zero.");
  }

  if (numerator === 0n) {
    return { numerator: 0n, denominator: 1n };
  }

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
  const trimmed = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) {
    throw new Error(`Invalid decimal string: ${value}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const integerDigits = match[2] ?? "0";
  const fractionalDigits = match[3] ?? "";
  const scale = fractionalDigits.length;
  const digits = `${integerDigits}${fractionalDigits}`.replace(/^0+(?=\d)/, "");
  const numerator = BigInt(digits.length > 0 ? digits : "0") * sign;

  return normalizeFraction(numerator, pow10(scale));
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
  if (leftNumerator === rightNumerator) {
    return 0;
  }

  return leftNumerator < rightNumerator ? -1 : 1;
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
  if (right.numerator === 0n) {
    throw new Error("Cannot divide by zero.");
  }

  return normalizeFraction(
    left.numerator * right.denominator,
    left.denominator * right.numerator,
  );
}

export function negateDecimal(value: DecimalFraction): DecimalFraction {
  return { numerator: -value.numerator, denominator: value.denominator };
}

export function formatDecimalFixed(
  value: DecimalFraction,
  scale: number,
): string {
  const isNegative = value.numerator < 0n;
  const absoluteNumerator = isNegative ? -value.numerator : value.numerator;
  const scaledNumerator = absoluteNumerator * pow10(scale);
  let quotient = scaledNumerator / value.denominator;
  const remainder = scaledNumerator % value.denominator;
  const doubledRemainder = remainder * 2n;
  if (doubledRemainder > value.denominator) {
    quotient += 1n;
  } else if (doubledRemainder === value.denominator && quotient % 2n === 1n) {
    quotient += 1n;
  }

  const signedQuotient = isNegative ? -quotient : quotient;
  const sign = signedQuotient < 0n ? "-" : "";
  const absoluteQuotient =
    signedQuotient < 0n ? -signedQuotient : signedQuotient;
  const integerPart = absoluteQuotient / pow10(scale);
  const fractionalPart = absoluteQuotient % pow10(scale);
  if (scale === 0) {
    return `${sign}${integerPart.toString()}`;
  }

  return `${sign}${integerPart.toString()}.${fractionalPart
    .toString()
    .padStart(scale, "0")}`;
}

export function formatDecimalTrimmed(
  value: DecimalFraction,
  scale: number,
  options: DecimalOptions = {},
): string {
  const fixed = formatDecimalFixed(value, scale);
  if (options.trimTrailingZeros === false || !fixed.includes(".")) {
    return fixed;
  }

  return fixed.replace(/(?:\.0+|(\.\d+?)0+)$/, "$1").replace(/\.$/, "");
}

export function toDecimal(
  value: string | bigint | DecimalFraction,
): DecimalFraction {
  if (typeof value === "bigint") {
    return fromInteger(value);
  }

  if (typeof value === "string") {
    return parseDecimal(value);
  }

  return normalizeFraction(value.numerator, value.denominator);
}

export function toIntegerString(value: DecimalFraction): string {
  return formatDecimalFixed(value, 0);
}
