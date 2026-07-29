import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  formatDecimalFixed,
  formatDecimalTrimmed,
  multiplyDecimal,
  parseDecimal,
  subtractDecimal,
  toIntegerString,
  type DecimalFraction,
} from "./preview-decimal.ts";
import {
  createPreviewFxObservation,
  createPreviewPriceObservation,
  previewMarketFixtureDates,
  type PreviewFxDirection,
  type PreviewFxObservation,
  type PreviewPriceObservation,
} from "./preview-market-fixtures.ts";
import {
  loadPreviewPortfolioFixture,
  type PreviewPortfolio,
  type PreviewPortfolioFixture,
  type PreviewSecurityTrace,
  type PreviewTransactionRow,
} from "./preview-portfolio-fixture.ts";

export type PreviewLedgerTransactionInput = Readonly<{
  rowNumber: number;
  kind: "buy" | "sell";
  quantity: string;
  unitPrice: string;
  commission?: string | null;
  tradeAtUtc?: string | null;
}>;

export type PreviewLedgerProjection = Readonly<{
  openQuantity: string;
  openBasis: string;
  realisedGain: string;
  remainingLots: readonly {
    quantity: string;
    basis: string;
  }[];
}>;

export type PreviewHoldingScenario = Readonly<{
  status: "open" | "closed" | "reference";
  symbol: string;
  name: string;
  currency: string;
  baseCurrency: string;
  quantity: string | null;
  openBasis: string | null;
  realisedGain: string | null;
  currentPrice: string | null;
  previousClose: string | null;
  currentFxRate: string | null;
  previousFxRate: string | null;
  fxDirection: PreviewFxDirection;
  sourceRowNumbers: readonly number[];
}>;

export type PreviewHoldingValuation = Readonly<{
  status: "open" | "closed" | "reference";
  symbol: string;
  name: string;
  currency: string;
  baseCurrency: string;
  quantity: string;
  openBasis: string | null;
  averageCostPerShare: string | null;
  currentPrice: string | null;
  previousClose: string | null;
  currentValue: string | null;
  previousValue: string | null;
  dailyMovement: string | null;
  realisedGain: string | null;
  unrealisedGain: string | null;
  totalGain: string | null;
  priceObservation: PreviewPriceObservation | null;
  fxObservation: PreviewFxObservation | null;
  priceAvailable: boolean;
  fxAvailable: boolean;
  basisAvailable: boolean;
  valueAvailable: boolean;
  dailyAvailable: boolean;
  gainAvailable: boolean;
  sourceRowNumbers: readonly number[];
}>;

export type PreviewPortfolioValuation = Readonly<{
  name: string;
  baseCurrency: string;
  openHoldings: readonly PreviewHoldingValuation[];
  closedSecurities: readonly PreviewHoldingValuation[];
  referenceSecurities: readonly PreviewHoldingValuation[];
  holdings: readonly PreviewHoldingValuation[];
  totalHoldings: number;
  pricedHoldings: number;
  convertedHoldings: number;
  investedValue: string | null;
  coveredOpenBasis: string | null;
  realisedGain: string | null;
  unrealisedGain: string | null;
  totalGain: string | null;
  portfolioValue: string | null;
  coverageLabel: string;
}>;

export type PreviewValuationFixture = Readonly<{
  marketDates: typeof previewMarketFixtureDates;
  portfolios: readonly PreviewPortfolioValuation[];
}>;

export type PreviewValuationFixtureFailure = Readonly<{
  ok: false;
  code:
    | "SOURCE_READ_FAILED"
    | "NO_PORTFOLIOS"
    | "MISSING_PRICE"
    | "UNSUPPORTED_FX"
    | "OVERSOLD";
  message: string;
}>;

export type PreviewValuationFixtureResult =
  | { ok: true; fixture: PreviewValuationFixture }
  | PreviewValuationFixtureFailure;

type DecimalLike = DecimalFraction;

type Lot = Readonly<{
  quantity: DecimalLike;
  basis: DecimalLike;
}>;

const ZERO = parseDecimal("0");
const ONE = parseDecimal("1");

function add(left: DecimalLike, right: DecimalLike): DecimalLike {
  return addDecimal(left, right);
}

function subtract(left: DecimalLike, right: DecimalLike): DecimalLike {
  return subtractDecimal(left, right);
}

function multiply(left: DecimalLike, right: DecimalLike): DecimalLike {
  return multiplyDecimal(left, right);
}

function divide(left: DecimalLike, right: DecimalLike): DecimalLike {
  return divideDecimal(left, right);
}

function compare(left: DecimalLike, right: DecimalLike): number {
  return compareDecimal(left, right);
}

function isPositive(value: DecimalLike): boolean {
  return compare(value, ZERO) > 0;
}

function formatMoney(value: DecimalLike): string {
  return formatDecimalFixed(value, 2);
}

function formatPrice(value: DecimalLike): string {
  return formatDecimalTrimmed(value, 6, { trimTrailingZeros: true });
}

function isTradeTransaction(
  transaction: PreviewTransactionRow,
): transaction is PreviewTransactionRow & {
  transactionKind: "buy" | "sell";
} {
  return (
    transaction.transactionKind === "buy" ||
    transaction.transactionKind === "sell"
  );
}

function inferBaseCurrency(portfolio: PreviewPortfolio): string {
  const openCurrencies = new Set(
    portfolio.openHoldings.map((holding) => holding.currency).filter(Boolean),
  );
  if (openCurrencies.size === 1) {
    return [...openCurrencies][0] ?? "AUD";
  }

  const transactionCurrencies = new Set(
    portfolio.transactions
      .map((transaction) => transaction.currency)
      .filter(Boolean),
  );
  if (transactionCurrencies.size === 1) {
    return [...transactionCurrencies][0] ?? "AUD";
  }

  const referenceCurrency = portfolio.referenceSecurities.find(
    (holding) => holding.currency !== null,
  )?.currency;
  return referenceCurrency ?? "AUD";
}

function projectLedger(
  transactions: readonly PreviewLedgerTransactionInput[],
): {
  openQuantity: DecimalLike;
  openBasis: DecimalLike;
  realisedGain: DecimalLike;
  remainingLots: Lot[];
} {
  const lots: Lot[] = [];
  let realisedGain = ZERO;

  const orderedTransactions = [...transactions].sort((left, right) => {
    const leftTime = left.tradeAtUtc ?? "";
    const rightTime = right.tradeAtUtc ?? "";
    return leftTime === rightTime
      ? left.rowNumber - right.rowNumber
      : leftTime.localeCompare(rightTime);
  });

  for (const transaction of orderedTransactions) {
    const quantity = parseDecimal(transaction.quantity);
    const unitPrice = parseDecimal(transaction.unitPrice);
    const commission = parseDecimal(transaction.commission ?? "0");
    if (transaction.kind === "buy") {
      lots.push({
        quantity,
        basis: add(multiply(quantity, unitPrice), commission),
      });
      continue;
    }

    const proceeds = subtract(multiply(quantity, unitPrice), commission);

    let remaining = quantity;
    let matchedBasis = ZERO;
    while (isPositive(remaining) && lots.length > 0) {
      const lot = lots[0];
      if (!lot) {
        break;
      }

      const matchedQuantity =
        compare(lot.quantity, remaining) <= 0 ? lot.quantity : remaining;
      const ratio = divide(matchedQuantity, lot.quantity);
      const matchedLotBasis = multiply(lot.basis, ratio);
      matchedBasis = add(matchedBasis, matchedLotBasis);
      const updatedQuantity = subtract(lot.quantity, matchedQuantity);
      const updatedBasis = subtract(lot.basis, matchedLotBasis);
      lots[0] = { quantity: updatedQuantity, basis: updatedBasis };
      remaining = subtract(remaining, matchedQuantity);
      if (!isPositive(updatedQuantity)) {
        lots.shift();
      }
    }

    if (isPositive(remaining)) {
      throw new Error("Preview sell quantity exceeds open lots.");
    }

    realisedGain = add(realisedGain, subtract(proceeds, matchedBasis));
  }

  return {
    openQuantity: lots.reduce((total, lot) => add(total, lot.quantity), ZERO),
    openBasis: lots.reduce((total, lot) => add(total, lot.basis), ZERO),
    realisedGain,
    remainingLots: lots,
  };
}

function projectScenario(
  scenario: PreviewHoldingScenario,
): PreviewHoldingValuation {
  const quantity =
    scenario.quantity === null ? ZERO : parseDecimal(scenario.quantity);
  const openBasis =
    scenario.openBasis === null ? null : parseDecimal(scenario.openBasis);
  const realisedGain =
    scenario.realisedGain === null ? null : parseDecimal(scenario.realisedGain);
  const priceAvailable =
    scenario.status === "open" &&
    scenario.currentPrice !== null &&
    scenario.previousClose !== null;
  const fxAvailable =
    scenario.fxDirection === "identity" ||
    (scenario.currentFxRate !== null && scenario.previousFxRate !== null);
  const basisAvailable = openBasis !== null;
  const valueAvailable =
    scenario.status === "open" && priceAvailable && fxAvailable;
  const dailyAvailable = valueAvailable;
  const gainAvailable =
    scenario.status === "open"
      ? valueAvailable && basisAvailable
      : scenario.status === "closed"
        ? realisedGain !== null
        : false;

  let priceObservation: PreviewPriceObservation | null = null;
  let fxObservation: PreviewFxObservation | null = null;
  let currentValue: DecimalLike | null = null;
  let previousValue: DecimalLike | null = null;
  let dailyMovement: DecimalLike | null = null;
  let unrealisedGain: DecimalLike | null = null;
  let totalGain: DecimalLike | null = null;
  let averageCostPerShare: string | null = null;

  if (basisAvailable && isPositive(quantity)) {
    averageCostPerShare = formatPrice(divide(openBasis, quantity));
  }

  if (scenario.status === "open" && priceAvailable && fxAvailable) {
    priceObservation = {
      currentPrice: scenario.currentPrice ?? "0",
      previousClose: scenario.previousClose ?? "0",
      currentDate: previewMarketFixtureDates.currentDate,
      previousDate: previewMarketFixtureDates.previousDate,
    };
    fxObservation = {
      direction: scenario.fxDirection,
      currentRate:
        scenario.fxDirection === "identity"
          ? "1"
          : (scenario.currentFxRate ?? "0"),
      previousRate:
        scenario.fxDirection === "identity"
          ? "1"
          : (scenario.previousFxRate ?? "0"),
      quoteCurrency: scenario.currency,
      baseCurrency: scenario.baseCurrency,
      currentDate: previewMarketFixtureDates.currentDate,
      previousDate: previewMarketFixtureDates.previousDate,
    };

    const currentPrice = parseDecimal(scenario.currentPrice ?? "0");
    const previousPrice = parseDecimal(scenario.previousClose ?? "0");
    const currentFx =
      scenario.fxDirection === "identity"
        ? ONE
        : parseDecimal(scenario.currentFxRate ?? "0");
    const previousFx =
      scenario.fxDirection === "identity"
        ? ONE
        : parseDecimal(scenario.previousFxRate ?? "0");

    const nativeCurrent = multiply(quantity, currentPrice);
    const nativePrevious = multiply(quantity, previousPrice);
    currentValue =
      scenario.fxDirection === "identity"
        ? nativeCurrent
        : multiply(nativeCurrent, currentFx);
    previousValue =
      scenario.fxDirection === "identity"
        ? nativePrevious
        : multiply(nativePrevious, previousFx);
    dailyMovement = subtract(currentValue, previousValue);
    unrealisedGain =
      openBasis === null ? null : subtract(currentValue, openBasis);
    totalGain =
      realisedGain === null
        ? unrealisedGain
        : unrealisedGain === null
          ? realisedGain
          : add(realisedGain, unrealisedGain);
  } else if (scenario.status === "closed" && realisedGain !== null) {
    totalGain = realisedGain;
  }

  return {
    status: scenario.status,
    symbol: scenario.symbol,
    name: scenario.name,
    currency: scenario.currency,
    baseCurrency: scenario.baseCurrency,
    quantity: toIntegerString(quantity),
    openBasis: openBasis === null ? null : formatMoney(openBasis),
    averageCostPerShare,
    currentPrice: priceObservation?.currentPrice ?? null,
    previousClose: priceObservation?.previousClose ?? null,
    currentValue: currentValue === null ? null : formatMoney(currentValue),
    previousValue: previousValue === null ? null : formatMoney(previousValue),
    dailyMovement: dailyMovement === null ? null : formatMoney(dailyMovement),
    realisedGain: realisedGain === null ? null : formatMoney(realisedGain),
    unrealisedGain:
      unrealisedGain === null ? null : formatMoney(unrealisedGain),
    totalGain: totalGain === null ? null : formatMoney(totalGain),
    priceObservation,
    fxObservation,
    priceAvailable,
    fxAvailable,
    basisAvailable,
    valueAvailable,
    dailyAvailable,
    gainAvailable,
    sourceRowNumbers: scenario.sourceRowNumbers,
  };
}

function projectOpenHolding(
  portfolio: PreviewPortfolio,
  holding: PreviewSecurityTrace,
): PreviewHoldingValuation {
  const baseCurrency = inferBaseCurrency(portfolio);
  const transactions = portfolio.transactions.filter(
    (
      transaction,
    ): transaction is PreviewTransactionRow & {
      transactionKind: "buy" | "sell";
    } =>
      transaction.symbol === holding.symbol && isTradeTransaction(transaction),
  );
  const ledger = projectLedger(
    transactions.map<PreviewLedgerTransactionInput>((transaction) => ({
      rowNumber: transaction.rowNumber,
      kind: transaction.transactionKind,
      quantity: transaction.sharesOwned ?? "0",
      unitPrice: transaction.costPerShare ?? "0",
      commission: transaction.commission ?? "0",
      tradeAtUtc: transaction.tradeAtUtc,
    })),
  );

  const averageCostPerShare =
    isPositive(ledger.openQuantity) && ledger.openBasis !== null
      ? formatPrice(divide(ledger.openBasis, ledger.openQuantity))
      : null;
  const priceObservation =
    averageCostPerShare === null
      ? null
      : createPreviewPriceObservation(
          averageCostPerShare,
          holding.currency ?? baseCurrency,
        );
  const fxObservation = createPreviewFxObservation(
    holding.currency ?? baseCurrency,
    baseCurrency,
  );

  return projectScenario({
    status: "open",
    symbol: holding.symbol,
    name: holding.name,
    currency: holding.currency ?? baseCurrency,
    baseCurrency,
    quantity: holding.quantity,
    openBasis: formatMoney(ledger.openBasis),
    realisedGain: formatMoney(ledger.realisedGain),
    currentPrice: priceObservation?.currentPrice ?? null,
    previousClose: priceObservation?.previousClose ?? null,
    currentFxRate: fxObservation.currentRate,
    previousFxRate: fxObservation.previousRate,
    fxDirection: fxObservation.direction,
    sourceRowNumbers: holding.sourceRowNumbers,
  });
}

function projectClosedSecurity(
  portfolio: PreviewPortfolio,
  holding: PreviewSecurityTrace,
): PreviewHoldingValuation {
  const baseCurrency = inferBaseCurrency(portfolio);
  const transactions = portfolio.transactions.filter(
    (
      transaction,
    ): transaction is PreviewTransactionRow & {
      transactionKind: "buy" | "sell";
    } =>
      transaction.symbol === holding.symbol && isTradeTransaction(transaction),
  );
  const ledger = projectLedger(
    transactions.map<PreviewLedgerTransactionInput>((transaction) => ({
      rowNumber: transaction.rowNumber,
      kind: transaction.transactionKind,
      quantity: transaction.sharesOwned ?? "0",
      unitPrice: transaction.costPerShare ?? "0",
      commission: transaction.commission ?? "0",
      tradeAtUtc: transaction.tradeAtUtc,
    })),
  );

  return projectScenario({
    status: "closed",
    symbol: holding.symbol,
    name: holding.name,
    currency: holding.currency ?? baseCurrency,
    baseCurrency,
    quantity: holding.quantity,
    openBasis: null,
    realisedGain: formatMoney(ledger.realisedGain),
    currentPrice: null,
    previousClose: null,
    currentFxRate: null,
    previousFxRate: null,
    fxDirection: "identity",
    sourceRowNumbers: holding.sourceRowNumbers,
  });
}

function projectReferenceSecurity(
  portfolio: PreviewPortfolio,
  holding: PreviewSecurityTrace,
): PreviewHoldingValuation {
  const baseCurrency = inferBaseCurrency(portfolio);
  return projectScenario({
    status: "reference",
    symbol: holding.symbol,
    name: holding.name,
    currency: holding.currency ?? baseCurrency,
    baseCurrency,
    quantity: null,
    openBasis: null,
    realisedGain: null,
    currentPrice: null,
    previousClose: null,
    currentFxRate: null,
    previousFxRate: null,
    fxDirection: "identity",
    sourceRowNumbers: holding.sourceRowNumbers,
  });
}

function evaluatePortfolio(
  portfolio: PreviewPortfolio,
): PreviewPortfolioValuation {
  const openHoldings = portfolio.openHoldings.map((holding) =>
    projectOpenHolding(portfolio, holding),
  );
  const closedSecurities = portfolio.closedSecurities.map((holding) =>
    projectClosedSecurity(portfolio, holding),
  );
  const referenceSecurities = portfolio.referenceSecurities.map((holding) =>
    projectReferenceSecurity(portfolio, holding),
  );
  const holdings = [
    ...openHoldings,
    ...closedSecurities,
    ...referenceSecurities,
  ];

  const investedValue = openHoldings.reduce(
    (total, holding) =>
      holding.currentValue === null
        ? total
        : add(total, parseDecimal(holding.currentValue)),
    ZERO,
  );
  const coveredOpenBasis = openHoldings.reduce(
    (total, holding) =>
      holding.openBasis === null
        ? total
        : add(total, parseDecimal(holding.openBasis)),
    ZERO,
  );
  const realisedGain = holdings.reduce(
    (total, holding) =>
      holding.realisedGain === null
        ? total
        : add(total, parseDecimal(holding.realisedGain)),
    ZERO,
  );
  const unrealisedGain = openHoldings.reduce(
    (total, holding) =>
      holding.unrealisedGain === null
        ? total
        : add(total, parseDecimal(holding.unrealisedGain)),
    ZERO,
  );
  const totalGain = add(realisedGain, unrealisedGain);
  const pricedHoldings = openHoldings.filter(
    (holding) => holding.priceAvailable,
  ).length;
  const convertedHoldings = openHoldings.filter(
    (holding) => holding.fxAvailable,
  ).length;

  return {
    name: portfolio.name,
    baseCurrency: inferBaseCurrency(portfolio),
    openHoldings,
    closedSecurities,
    referenceSecurities,
    holdings,
    totalHoldings: holdings.length,
    pricedHoldings,
    convertedHoldings,
    investedValue: formatMoney(investedValue),
    coveredOpenBasis: formatMoney(coveredOpenBasis),
    realisedGain: formatMoney(realisedGain),
    unrealisedGain: formatMoney(unrealisedGain),
    totalGain: formatMoney(totalGain),
    portfolioValue: formatMoney(investedValue),
    coverageLabel: `${pricedHoldings} priced holdings`,
  };
}

export function createPreviewValuationFixtureFromPortfolioFixture(
  fixture: PreviewPortfolioFixture,
): PreviewValuationFixtureResult {
  if (fixture.portfolios.length === 0) {
    return {
      ok: false,
      code: "NO_PORTFOLIOS",
      message: "The parsed preview fixture did not contain any portfolios.",
    };
  }

  return {
    ok: true,
    fixture: {
      marketDates: previewMarketFixtureDates,
      portfolios: fixture.portfolios.map((portfolio) =>
        evaluatePortfolio(portfolio),
      ),
    },
  };
}

export function evaluatePreviewHoldingScenario(
  scenario: PreviewHoldingScenario,
): PreviewHoldingValuation {
  return projectScenario(scenario);
}

export function projectPreviewLedgerTransactions(
  transactions: readonly PreviewLedgerTransactionInput[],
): PreviewLedgerProjection {
  const projection = projectLedger(transactions);

  return {
    openQuantity: toIntegerString(projection.openQuantity),
    openBasis: formatMoney(projection.openBasis),
    realisedGain: formatMoney(projection.realisedGain),
    remainingLots: projection.remainingLots.map((lot) => ({
      quantity: toIntegerString(lot.quantity),
      basis: formatMoney(lot.basis),
    })),
  };
}

export async function loadPreviewValuationFixture(): Promise<PreviewValuationFixtureResult> {
  const previewFixture = await loadPreviewPortfolioFixture();
  if (!previewFixture.ok) {
    return {
      ok: false,
      code:
        previewFixture.code === "SOURCE_READ_FAILED"
          ? "SOURCE_READ_FAILED"
          : "NO_PORTFOLIOS",
      message: previewFixture.message,
    };
  }

  return createPreviewValuationFixtureFromPortfolioFixture(
    previewFixture.fixture,
  );
}

export {
  createPreviewFxObservation,
  createPreviewPriceObservation,
  previewMarketFixtureDates,
};
