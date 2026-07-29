import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePreviewHoldingScenario,
  loadPreviewValuationFixture,
  projectPreviewLedgerTransactions,
} from "../app/preview-valuation.ts";
import { loadPreviewPortfolioFixture } from "../app/preview-portfolio-fixture.ts";
import {
  expectedPreviewHoldings,
  expectedPreviewLedger,
  expectedPreviewPortfolioSummaries,
  expectedPreviewScenarios,
} from "./fixtures/preview-valuation-expected.ts";

function pickSummary(portfolio: {
  name: string;
  baseCurrency: string;
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
}) {
  return {
    name: portfolio.name,
    baseCurrency: portfolio.baseCurrency,
    totalHoldings: portfolio.totalHoldings,
    pricedHoldings: portfolio.pricedHoldings,
    convertedHoldings: portfolio.convertedHoldings,
    investedValue: portfolio.investedValue,
    coveredOpenBasis: portfolio.coveredOpenBasis,
    realisedGain: portfolio.realisedGain,
    unrealisedGain: portfolio.unrealisedGain,
    totalGain: portfolio.totalGain,
    portfolioValue: portfolio.portfolioValue,
    coverageLabel: portfolio.coverageLabel,
  };
}

test("builds the deterministic preview valuation fixture from the supplied CSV", async () => {
  const first = await loadPreviewValuationFixture();
  const second = await loadPreviewValuationFixture();
  assert.deepEqual(first, second);
  assert.equal(first.ok, true);
  if (!first.ok) {
    return;
  }

  assert.deepEqual(
    first.fixture.portfolios.map(pickSummary),
    expectedPreviewPortfolioSummaries,
  );

  const ausStocks = first.fixture.portfolios.find(
    (portfolio) => portfolio.name === "Aus Stocks",
  );
  assert.ok(ausStocks);
  assert.deepEqual(ausStocks?.openHoldings.length, 11);
  assert.deepEqual(
    ausStocks?.openHoldings.find((holding) => holding.symbol === "PLS.AX"),
    {
      status: "open",
      symbol: "PLS.AX",
      name: "Plsgroup Fpo [pls]",
      currency: "AUD",
      baseCurrency: "AUD",
      exchange: "ASX",
      quantity: expectedPreviewHoldings.ausStocks.pls.quantity,
      openBasis: expectedPreviewHoldings.ausStocks.pls.openBasis,
      averageCostPerShare:
        expectedPreviewHoldings.ausStocks.pls.averageCostPerShare,
      currentPrice: expectedPreviewHoldings.ausStocks.pls.currentPrice,
      previousClose: expectedPreviewHoldings.ausStocks.pls.previousClose,
      currentValue: expectedPreviewHoldings.ausStocks.pls.currentValue,
      previousValue: expectedPreviewHoldings.ausStocks.pls.previousValue,
      dailyMovement: expectedPreviewHoldings.ausStocks.pls.dailyMovement,
      realisedGain: expectedPreviewHoldings.ausStocks.pls.realisedGain,
      unrealisedGain: expectedPreviewHoldings.ausStocks.pls.unrealisedGain,
      totalGain: expectedPreviewHoldings.ausStocks.pls.totalGain,
      priceObservation: {
        currentPrice: expectedPreviewHoldings.ausStocks.pls.currentPrice,
        previousClose: expectedPreviewHoldings.ausStocks.pls.previousClose,
        currentDate: "2026-07-29",
        previousDate: "2026-07-28",
      },
      fxObservation: {
        direction: "identity",
        currentRate: "1",
        previousRate: "1",
        quoteCurrency: "AUD",
        baseCurrency: "AUD",
        currentDate: "2026-07-29",
        previousDate: "2026-07-28",
      },
      priceAvailable: true,
      fxAvailable: true,
      basisAvailable: true,
      valueAvailable: true,
      dailyAvailable: true,
      gainAvailable: true,
      sourceRowNumbers: [140, 141, 142, 143],
    },
  );

  const usa = first.fixture.portfolios.find(
    (portfolio) => portfolio.name === "USA",
  );
  assert.ok(usa);
  assert.deepEqual(
    usa?.openHoldings.find((holding) => holding.symbol === "AAPL"),
    {
      status: "open",
      symbol: "AAPL",
      name: "Apple Inc.",
      currency: "USD",
      baseCurrency: "USD",
      exchange: "NMS",
      quantity: expectedPreviewHoldings.usa.aapl.quantity,
      openBasis: expectedPreviewHoldings.usa.aapl.openBasis,
      averageCostPerShare: expectedPreviewHoldings.usa.aapl.averageCostPerShare,
      currentPrice: expectedPreviewHoldings.usa.aapl.currentPrice,
      previousClose: expectedPreviewHoldings.usa.aapl.previousClose,
      currentValue: expectedPreviewHoldings.usa.aapl.currentValue,
      previousValue: expectedPreviewHoldings.usa.aapl.previousValue,
      dailyMovement: expectedPreviewHoldings.usa.aapl.dailyMovement,
      realisedGain: expectedPreviewHoldings.usa.aapl.realisedGain,
      unrealisedGain: expectedPreviewHoldings.usa.aapl.unrealisedGain,
      totalGain: expectedPreviewHoldings.usa.aapl.totalGain,
      priceObservation: {
        currentPrice: expectedPreviewHoldings.usa.aapl.currentPrice,
        previousClose: expectedPreviewHoldings.usa.aapl.previousClose,
        currentDate: "2026-07-29",
        previousDate: "2026-07-28",
      },
      fxObservation: {
        direction: "identity",
        currentRate: "1",
        previousRate: "1",
        quoteCurrency: "USD",
        baseCurrency: "USD",
        currentDate: "2026-07-29",
        previousDate: "2026-07-28",
      },
      priceAvailable: true,
      fxAvailable: true,
      basisAvailable: true,
      valueAvailable: true,
      dailyAvailable: true,
      gainAvailable: true,
      sourceRowNumbers: [218, 219],
    },
  );

  const ausSold = first.fixture.portfolios.find(
    (portfolio) => portfolio.name === "Aus Sold",
  );
  assert.ok(ausSold);
  assert.deepEqual(
    ausSold?.realisedGain,
    expectedPreviewPortfolioSummaries[0]?.realisedGain,
  );
});

test("projects direct, inverse, identity, missing, and rounding scenarios", () => {
  assert.deepEqual(
    evaluatePreviewHoldingScenario({
      status: "open",
      symbol: "FX1",
      name: "FX holding",
      currency: "USD",
      baseCurrency: "AUD",
      exchange: null,
      quantity: "10",
      openBasis: "100.00",
      realisedGain: "5.00",
      currentPrice: "20.00",
      previousClose: "18.00",
      currentFxRate: "0.50",
      previousFxRate: "0.40",
      fxDirection: "direct",
      sourceRowNumbers: [1],
    }),
    {
      status: "open",
      symbol: "FX1",
      name: "FX holding",
      currency: "USD",
      baseCurrency: "AUD",
      exchange: null,
      quantity: "10",
      openBasis: "100.00",
      averageCostPerShare: "10",
      currentPrice: "20.00",
      previousClose: "18.00",
      currentValue: expectedPreviewScenarios.direct.currentValue,
      previousValue: expectedPreviewScenarios.direct.previousValue,
      dailyMovement: expectedPreviewScenarios.direct.dailyMovement,
      realisedGain: expectedPreviewScenarios.direct.realisedGain,
      unrealisedGain: expectedPreviewScenarios.direct.unrealisedGain,
      totalGain: expectedPreviewScenarios.direct.totalGain,
      priceObservation: {
        currentPrice: "20.00",
        previousClose: "18.00",
        currentDate: "2026-07-29",
        previousDate: "2026-07-28",
      },
      fxObservation: {
        direction: "direct",
        currentRate: "0.50",
        previousRate: "0.40",
        quoteCurrency: "USD",
        baseCurrency: "AUD",
        currentDate: "2026-07-29",
        previousDate: "2026-07-28",
      },
      priceAvailable: true,
      fxAvailable: true,
      basisAvailable: true,
      valueAvailable: true,
      dailyAvailable: true,
      gainAvailable: true,
      sourceRowNumbers: [1],
    },
  );

  assert.deepEqual(
    evaluatePreviewHoldingScenario({
      status: "open",
      symbol: "FX2",
      name: "FX inverse",
      currency: "AUD",
      baseCurrency: "USD",
      exchange: null,
      quantity: "4",
      openBasis: "40.00",
      realisedGain: "1.00",
      currentPrice: "12.00",
      previousClose: "11.00",
      currentFxRate: "1.50",
      previousFxRate: "2.00",
      fxDirection: "inverse",
      sourceRowNumbers: [2],
    }),
    {
      status: "open",
      symbol: "FX2",
      name: "FX inverse",
      currency: "AUD",
      baseCurrency: "USD",
      exchange: null,
      quantity: "4",
      openBasis: "40.00",
      averageCostPerShare: "10",
      currentPrice: "12.00",
      previousClose: "11.00",
      currentValue: expectedPreviewScenarios.inverse.currentValue,
      previousValue: expectedPreviewScenarios.inverse.previousValue,
      dailyMovement: expectedPreviewScenarios.inverse.dailyMovement,
      realisedGain: expectedPreviewScenarios.inverse.realisedGain,
      unrealisedGain: expectedPreviewScenarios.inverse.unrealisedGain,
      totalGain: expectedPreviewScenarios.inverse.totalGain,
      priceObservation: {
        currentPrice: "12.00",
        previousClose: "11.00",
        currentDate: "2026-07-29",
        previousDate: "2026-07-28",
      },
      fxObservation: {
        direction: "inverse",
        currentRate: "1.50",
        previousRate: "2.00",
        quoteCurrency: "AUD",
        baseCurrency: "USD",
        currentDate: "2026-07-29",
        previousDate: "2026-07-28",
      },
      priceAvailable: true,
      fxAvailable: true,
      basisAvailable: true,
      valueAvailable: true,
      dailyAvailable: true,
      gainAvailable: true,
      sourceRowNumbers: [2],
    },
  );

  assert.deepEqual(
    evaluatePreviewHoldingScenario({
      status: "open",
      symbol: "FX3",
      name: "FX identity",
      currency: "AUD",
      baseCurrency: "AUD",
      exchange: null,
      quantity: "3",
      openBasis: "9.00",
      realisedGain: "0.00",
      currentPrice: "4.00",
      previousClose: "3.50",
      currentFxRate: null,
      previousFxRate: null,
      fxDirection: "identity",
      sourceRowNumbers: [3],
    }),
    {
      status: "open",
      symbol: "FX3",
      name: "FX identity",
      currency: "AUD",
      baseCurrency: "AUD",
      exchange: null,
      quantity: "3",
      openBasis: "9.00",
      averageCostPerShare: "3",
      currentPrice: "4.00",
      previousClose: "3.50",
      currentValue: expectedPreviewScenarios.identity.currentValue,
      previousValue: expectedPreviewScenarios.identity.previousValue,
      dailyMovement: expectedPreviewScenarios.identity.dailyMovement,
      realisedGain: expectedPreviewScenarios.identity.realisedGain,
      unrealisedGain: expectedPreviewScenarios.identity.unrealisedGain,
      totalGain: expectedPreviewScenarios.identity.totalGain,
      priceObservation: {
        currentPrice: "4.00",
        previousClose: "3.50",
        currentDate: "2026-07-29",
        previousDate: "2026-07-28",
      },
      fxObservation: {
        direction: "identity",
        currentRate: "1",
        previousRate: "1",
        quoteCurrency: "AUD",
        baseCurrency: "AUD",
        currentDate: "2026-07-29",
        previousDate: "2026-07-28",
      },
      priceAvailable: true,
      fxAvailable: true,
      basisAvailable: true,
      valueAvailable: true,
      dailyAvailable: true,
      gainAvailable: true,
      sourceRowNumbers: [3],
    },
  );

  assert.deepEqual(
    evaluatePreviewHoldingScenario({
      status: "open",
      symbol: "FX4",
      name: "Missing price",
      currency: "USD",
      baseCurrency: "AUD",
      exchange: null,
      quantity: "7",
      openBasis: "70.00",
      realisedGain: "0.00",
      currentPrice: null,
      previousClose: null,
      currentFxRate: "0.50",
      previousFxRate: "0.45",
      fxDirection: "direct",
      sourceRowNumbers: [4],
    }),
    {
      status: "open",
      symbol: "FX4",
      name: "Missing price",
      currency: "USD",
      baseCurrency: "AUD",
      exchange: null,
      quantity: "7",
      openBasis: "70.00",
      averageCostPerShare: "10",
      currentPrice: null,
      previousClose: null,
      currentValue: expectedPreviewScenarios.missingPrice.currentValue,
      previousValue: expectedPreviewScenarios.missingPrice.previousValue,
      dailyMovement: expectedPreviewScenarios.missingPrice.dailyMovement,
      realisedGain: expectedPreviewScenarios.missingPrice.realisedGain,
      unrealisedGain: expectedPreviewScenarios.missingPrice.unrealisedGain,
      totalGain: expectedPreviewScenarios.missingPrice.totalGain,
      priceObservation: null,
      fxObservation: null,
      priceAvailable: expectedPreviewScenarios.missingPrice.priceAvailable,
      fxAvailable: expectedPreviewScenarios.missingPrice.fxAvailable,
      basisAvailable: true,
      valueAvailable: expectedPreviewScenarios.missingPrice.valueAvailable,
      dailyAvailable: expectedPreviewScenarios.missingPrice.dailyAvailable,
      gainAvailable: expectedPreviewScenarios.missingPrice.gainAvailable,
      sourceRowNumbers: [4],
    },
  );

  assert.deepEqual(
    evaluatePreviewHoldingScenario({
      status: "open",
      symbol: "FX5",
      name: "Missing FX",
      currency: "USD",
      baseCurrency: "AUD",
      exchange: null,
      quantity: "7",
      openBasis: "70.00",
      realisedGain: "0.00",
      currentPrice: "10.00",
      previousClose: "9.50",
      currentFxRate: null,
      previousFxRate: null,
      fxDirection: "direct",
      sourceRowNumbers: [5],
    }),
    {
      status: "open",
      symbol: "FX5",
      name: "Missing FX",
      currency: "USD",
      baseCurrency: "AUD",
      exchange: null,
      quantity: "7",
      openBasis: "70.00",
      averageCostPerShare: "10",
      currentPrice: null,
      previousClose: null,
      currentValue: expectedPreviewScenarios.missingFx.currentValue,
      previousValue: expectedPreviewScenarios.missingFx.previousValue,
      dailyMovement: expectedPreviewScenarios.missingFx.dailyMovement,
      realisedGain: expectedPreviewScenarios.missingFx.realisedGain,
      unrealisedGain: expectedPreviewScenarios.missingFx.unrealisedGain,
      totalGain: expectedPreviewScenarios.missingFx.totalGain,
      priceObservation: null,
      fxObservation: null,
      priceAvailable: expectedPreviewScenarios.missingFx.priceAvailable,
      fxAvailable: expectedPreviewScenarios.missingFx.fxAvailable,
      basisAvailable: true,
      valueAvailable: expectedPreviewScenarios.missingFx.valueAvailable,
      dailyAvailable: expectedPreviewScenarios.missingFx.dailyAvailable,
      gainAvailable: expectedPreviewScenarios.missingFx.gainAvailable,
      sourceRowNumbers: [5],
    },
  );

  assert.deepEqual(
    evaluatePreviewHoldingScenario({
      status: "open",
      symbol: "R1",
      name: "Rounding even",
      currency: "AUD",
      baseCurrency: "AUD",
      exchange: null,
      quantity: "1",
      openBasis: "0.00",
      realisedGain: "0.00",
      currentPrice: "1.005",
      previousClose: "1.005",
      currentFxRate: null,
      previousFxRate: null,
      fxDirection: "identity",
      sourceRowNumbers: [6],
    }).currentValue,
    expectedPreviewScenarios.roundingEven.currentValue,
  );

  assert.deepEqual(
    evaluatePreviewHoldingScenario({
      status: "open",
      symbol: "R2",
      name: "Rounding up",
      currency: "AUD",
      baseCurrency: "AUD",
      exchange: null,
      quantity: "1",
      openBasis: "0.00",
      realisedGain: "0.00",
      currentPrice: "1.015",
      previousClose: "1.015",
      currentFxRate: null,
      previousFxRate: null,
      fxDirection: "identity",
      sourceRowNumbers: [7],
    }).currentValue,
    expectedPreviewScenarios.roundingUp.currentValue,
  );
});

test("projects FIFO buy/sell ledgers and preserves rounding", () => {
  assert.deepEqual(
    projectPreviewLedgerTransactions([
      {
        rowNumber: 1,
        kind: "buy",
        quantity: "10",
        unitPrice: "2.50",
        commission: "0.50",
      },
      {
        rowNumber: 2,
        kind: "buy",
        quantity: "5",
        unitPrice: "3.00",
        commission: "0.00",
      },
      {
        rowNumber: 3,
        kind: "sell",
        quantity: "12",
        unitPrice: "4.00",
        commission: "0.20",
      },
    ]),
    expectedPreviewLedger,
  );
});

test("keeps the valuation fixture inside the local CSV boundary", async () => {
  const result = await loadPreviewPortfolioFixture();
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }

  assert.equal(result.fixture.portfolios.length, 5);
  assert.equal(result.fixture.portfolios[0]?.name, "Aus Sold");
});
