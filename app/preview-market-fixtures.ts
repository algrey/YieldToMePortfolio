import {
  addDecimal,
  divideDecimal,
  formatDecimalTrimmed,
  isZero,
  multiplyDecimal,
  parseDecimal,
  type DecimalFraction,
} from "./preview-decimal.ts";

export type PreviewFxDirection = "identity" | "direct" | "inverse";

export type PreviewPriceObservation = Readonly<{
  currentPrice: string;
  previousClose: string;
  currentDate: string;
  previousDate: string;
}>;

export type PreviewFxObservation = Readonly<{
  direction: PreviewFxDirection;
  currentRate: string;
  previousRate: string;
  quoteCurrency: string;
  baseCurrency: string;
  currentDate: string;
  previousDate: string;
}>;

export const previewMarketFixtureDates = {
  currentDate: "2026-07-29",
  previousDate: "2026-07-28",
} as const;

export const previewMarketFixtureConfig = {
  AUD: {
    currentSpread: parseDecimal("0.125"),
    previousSpread: parseDecimal("0.085"),
  },
  USD: {
    currentSpread: parseDecimal("0.250"),
    previousSpread: parseDecimal("0.150"),
  },
} as const;

export const previewFxFixtureConfig = {
  currentDirectRate: parseDecimal("0.6584"),
  previousDirectRate: parseDecimal("0.6558"),
} as const;

function getDirectFxRate(
  direction: PreviewFxDirection,
  current: boolean,
): DecimalFraction {
  const rate = current
    ? previewFxFixtureConfig.currentDirectRate
    : previewFxFixtureConfig.previousDirectRate;
  return direction === "direct" ? rate : divideDecimal(parseDecimal("1"), rate);
}

export function createPreviewPriceObservation(
  averageCostPerShare: string,
  currency: string,
): PreviewPriceObservation {
  const spreadConfig =
    previewMarketFixtureConfig[
      currency as keyof typeof previewMarketFixtureConfig
    ] ?? previewMarketFixtureConfig.AUD;
  const basePrice = parseDecimal(averageCostPerShare);
  const currentPrice = addDecimal(basePrice, spreadConfig.currentSpread);
  const previousClose = addDecimal(
    basePrice,
    multiplyDecimal(parseDecimal("-1"), spreadConfig.previousSpread),
  );

  return {
    currentPrice: formatDecimalTrimmed(currentPrice, 6, {
      trimTrailingZeros: true,
    }),
    previousClose: formatDecimalTrimmed(previousClose, 6, {
      trimTrailingZeros: true,
    }),
    currentDate: previewMarketFixtureDates.currentDate,
    previousDate: previewMarketFixtureDates.previousDate,
  };
}

export function createPreviewFxObservation(
  quoteCurrency: string,
  baseCurrency: string,
): PreviewFxObservation {
  if (quoteCurrency === baseCurrency) {
    return {
      direction: "identity",
      currentRate: "1",
      previousRate: "1",
      quoteCurrency,
      baseCurrency,
      currentDate: previewMarketFixtureDates.currentDate,
      previousDate: previewMarketFixtureDates.previousDate,
    };
  }

  const direction: PreviewFxDirection =
    quoteCurrency === "USD" && baseCurrency === "AUD"
      ? "direct"
      : quoteCurrency === "AUD" && baseCurrency === "USD"
        ? "inverse"
        : "identity";

  const currentRate = getDirectFxRate(direction, true);
  const previousRate = getDirectFxRate(direction, false);

  return {
    direction,
    currentRate: formatDecimalTrimmed(currentRate, 6, {
      trimTrailingZeros: true,
    }),
    previousRate: formatDecimalTrimmed(previousRate, 6, {
      trimTrailingZeros: true,
    }),
    quoteCurrency,
    baseCurrency,
    currentDate: previewMarketFixtureDates.currentDate,
    previousDate: previewMarketFixtureDates.previousDate,
  };
}

export function convertValueWithFx(
  nativeValue: DecimalFraction,
  fxRate: string | null,
  direction: PreviewFxDirection,
): DecimalFraction | null {
  if (fxRate === null) {
    return null;
  }

  if (direction === "identity") {
    return nativeValue;
  }

  const rate = parseDecimal(fxRate);
  if (isZero(rate)) {
    return null;
  }

  return direction === "direct"
    ? multiplyDecimal(nativeValue, rate)
    : divideDecimal(nativeValue, rate);
}
