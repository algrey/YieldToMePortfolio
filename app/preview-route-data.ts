import {
  compareDecimal,
  divideDecimal,
  formatDecimalFixed,
  formatDecimalTrimmed,
  multiplyDecimal,
  parseDecimal,
  subtractDecimal,
  toIntegerString,
} from "./preview-decimal.ts";
import {
  type PreviewHoldingValuation,
  type PreviewPortfolioValuation,
  type PreviewValuationFixture,
} from "./preview-valuation.ts";
import {
  type Holding,
  type PortfolioPrototype,
  type Quote,
  type Tone,
} from "./prototype-data.ts";

function currencyPrefix(currency: string): string {
  switch (currency) {
    case "AUD":
      return "A$";
    case "USD":
      return "US$";
    default:
      return `${currency}$`;
  }
}

function formatUnsignedCurrency(
  amount: string | null,
  currency: string,
): string {
  if (amount === null) {
    return "Not available";
  }

  const sign = amount.startsWith("-") ? "−" : "";
  const absolute = sign.length > 0 ? amount.slice(1) : amount;
  return `${sign}${currencyPrefix(currency)}${formatDecimalFixed(
    parseDecimal(absolute),
    2,
  )}`;
}

function formatSignedCurrency(amount: string | null, currency: string): string {
  if (amount === null) {
    return "Not available";
  }

  const decimal = parseDecimal(amount);
  const sign = compareDecimal(decimal, parseDecimal("0")) > 0 ? "+" : "";
  return `${sign}${formatUnsignedCurrency(amount, currency)}`;
}

function formatPrice(amount: string | null, currency: string): string {
  if (amount === null) {
    return "Price unavailable";
  }

  const sign = amount.startsWith("-") ? "−" : amount.startsWith("+") ? "+" : "";
  const absolute = sign.length > 0 ? amount.slice(1) : amount;
  return `${sign}${currencyPrefix(currency)}${formatDecimalTrimmed(
    parseDecimal(absolute),
    6,
    { trimTrailingZeros: true },
  )}`;
}

function formatQuantity(quantity: string | null): string {
  if (quantity === null) {
    return "—";
  }

  return Number(quantity).toLocaleString("en-AU");
}

function sortKey(value: string | null): string {
  if (value === null) {
    return "0";
  }

  return toIntegerString(
    multiplyDecimal(parseDecimal(value), parseDecimal("100")),
  );
}

function toneFromAmount(amount: string | null): Tone {
  if (amount === null) {
    return "neutral";
  }

  const compared = compareDecimal(parseDecimal(amount), parseDecimal("0"));
  if (compared > 0) {
    return "positive";
  }
  if (compared < 0) {
    return "negative";
  }
  return "neutral";
}

function percentFromTotals(
  numerator: string | null,
  denominator: string | null,
): string {
  if (numerator === null || denominator === null) {
    return "—";
  }

  const ratio = divideDecimal(
    parseDecimal(numerator),
    parseDecimal(denominator),
  );
  const percent = multiplyDecimal(ratio, parseDecimal("100"));
  const sign = compareDecimal(percent, parseDecimal("0")) > 0 ? "+" : "";
  return `${sign}${formatDecimalFixed(percent, 2)}%`;
}

function holdingToQuote(holding: PreviewHoldingValuation): Quote | null {
  if (holding.currentPrice === null || holding.previousClose === null) {
    return null;
  }

  const currentPrice = parseDecimal(holding.currentPrice);
  const previousClose = parseDecimal(holding.previousClose);
  const change = subtractDecimal(currentPrice, previousClose);
  return {
    symbol: holding.symbol,
    name: holding.name,
    price: formatPrice(holding.currentPrice, holding.currency),
    change: formatSignedCurrency(
      formatDecimalFixed(change, 2),
      holding.currency,
    ),
    percent: percentFromTotals(holding.dailyMovement, holding.previousValue),
    tone: toneFromAmount(holding.dailyMovement),
    marketDate: "29 Jul",
    sort: {
      ticker: holding.symbol,
      price: sortKey(holding.currentPrice),
      change: sortKey(formatDecimalFixed(change, 2)),
    },
  };
}

function holdingToDisplay(holding: PreviewHoldingValuation): Holding {
  const quantity = formatQuantity(holding.quantity);
  const averageCost = holding.averageCostPerShare;
  const priceCurrency = holding.currency;
  const baseCurrency = holding.baseCurrency;

  return {
    symbol: holding.symbol,
    name: holding.name,
    exchange: holding.exchange ?? "N/A",
    currency: holding.currency,
    price: formatPrice(holding.currentPrice, priceCurrency),
    value: formatUnsignedCurrency(holding.currentValue, baseCurrency),
    cost: formatUnsignedCurrency(holding.openBasis, baseCurrency),
    quantityLine:
      averageCost === null
        ? `Price unavailable × ${quantity} shares`
        : `${formatPrice(averageCost, priceCurrency)} × ${quantity} shares`,
    dailyAmount: formatSignedCurrency(holding.dailyMovement, baseCurrency),
    dailyPercent: percentFromTotals(
      holding.dailyMovement,
      holding.previousValue,
    ),
    dailyTone: toneFromAmount(holding.dailyMovement),
    totalAmount: formatSignedCurrency(holding.totalGain, baseCurrency),
    totalPercent: percentFromTotals(holding.totalGain, holding.openBasis),
    totalTone: toneFromAmount(holding.totalGain),
    sort: {
      ticker: holding.symbol,
      value: sortKey(holding.currentValue),
      daily: sortKey(holding.dailyMovement),
      total: sortKey(holding.totalGain),
    },
  };
}

function toPortfolioPrototype(
  portfolio: PreviewPortfolioValuation,
): PortfolioPrototype {
  const holdings = portfolio.openHoldings.map(holdingToDisplay);
  const quotes = portfolio.openHoldings
    .map(holdingToQuote)
    .filter((quote): quote is Quote => quote !== null);

  return {
    id:
      portfolio.name === "US watch"
        ? "us-watch"
        : portfolio.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
    name: portfolio.name,
    homeCurrency: portfolio.baseCurrency,
    value: formatUnsignedCurrency(
      portfolio.portfolioValue,
      portfolio.baseCurrency,
    ),
    cost: formatUnsignedCurrency(
      portfolio.coveredOpenBasis,
      portfolio.baseCurrency,
    ),
    dailyAmount: formatSignedCurrency(
      portfolio.dailyMovement,
      portfolio.baseCurrency,
    ),
    dailyPercent:
      portfolio.dailyPercent === null ? "—" : `${portfolio.dailyPercent}%`,
    gainAmount: formatSignedCurrency(
      portfolio.unrealisedGain,
      portfolio.baseCurrency,
    ),
    gainPercent:
      portfolio.unrealisedPercent === null
        ? "—"
        : `${portfolio.unrealisedPercent}%`,
    realisedAmount: formatSignedCurrency(
      portfolio.realisedGain,
      portfolio.baseCurrency,
    ),
    realisedPercent:
      portfolio.realisedPercent === null
        ? "—"
        : `${portfolio.realisedPercent}%`,
    allTimeAmount: formatSignedCurrency(
      portfolio.totalGain,
      portfolio.baseCurrency,
    ),
    allTimePercent:
      portfolio.totalPercent === null ? "—" : `${portfolio.totalPercent}%`,
    cash: "Not available",
    holdings,
    quotes,
  };
}

export function createPreviewPortfolioPrototypes(
  fixture: PreviewValuationFixture,
): readonly PortfolioPrototype[] {
  return JSON.parse(
    JSON.stringify(fixture.portfolios.map(toPortfolioPrototype)),
  ) as readonly PortfolioPrototype[];
}
