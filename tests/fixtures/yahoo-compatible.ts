function unix(instant: string): number {
  return Math.floor(Date.parse(instant) / 1000);
}

export const australianChartFixture = {
  chart: {
    result: [
      {
        meta: {
          currency: "AUD",
          exchangeTimezoneName: "Australia/Sydney",
          exchangeDataDelayedBy: 20,
          regularMarketPrice: 42.1,
          regularMarketPreviousClose: 41.9,
          regularMarketTime: unix("2026-07-29T06:00:00Z"),
          symbol: "BHP.AX",
        },
        timestamp: [unix("2026-07-28T06:00:00Z"), unix("2026-07-29T06:00:00Z")],
        indicators: { quote: [{ close: [41.5, 42.1] }] },
      },
    ],
    error: null,
  },
};

export const usChartFixture = {
  chart: {
    result: [
      {
        meta: {
          currency: "USD",
          exchangeTimezoneName: "America/New_York",
          exchangeDataDelayedBy: 15,
          regularMarketPrice: 188.25,
          regularMarketPreviousClose: 187.5,
          regularMarketTime: unix("2026-07-29T20:00:00Z"),
          symbol: "AAPL",
        },
        timestamp: [unix("2026-07-29T20:00:00Z")],
        indicators: { quote: [{ close: [188.25] }] },
      },
    ],
    error: null,
  },
};

export const unitedKingdomChartFixture = {
  chart: {
    result: [
      {
        meta: {
          currency: "GBp",
          exchangeTimezoneName: "Europe/London",
          regularMarketPrice: 725.5,
          regularMarketPreviousClose: 720,
          regularMarketTime: unix("2026-07-29T15:30:00Z"),
          symbol: "SHEL.L",
        },
        timestamp: [unix("2026-07-29T15:30:00Z")],
        indicators: { quote: [{ close: [725.5] }] },
      },
    ],
    error: null,
  },
};

export const searchFixture = {
  quotes: [
    {
      symbol: "BHP.AX",
      longname: "BHP Group Limited",
      exchange: "ASX",
      quoteType: "EQUITY",
      currency: "AUD",
    },
    {
      symbol: "AAPL",
      shortname: "Apple Inc.",
      exchange: "NMS",
      quoteType: "EQUITY",
      currency: "USD",
    },
    {
      symbol: "SHEL.L",
      longname: "Shell plc",
      exchange: "LSE",
      quoteType: "EQUITY",
      currency: "GBp",
    },
  ],
};

export const australianUsdFxFixture = {
  chart: {
    result: [
      {
        meta: {
          currency: "USD",
          exchangeTimezoneName: "UTC",
        },
        timestamp: [unix("2026-07-29T00:00:00Z"), unix("2026-07-30T00:00:00Z")],
        indicators: { quote: [{ close: [0.66, 0.67] }] },
      },
    ],
    error: null,
  },
};
