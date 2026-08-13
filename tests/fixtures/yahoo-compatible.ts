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

// MKT-005: a chart response requested with `events=div,splits`, carrying one
// historical cash dividend and one historical split alongside the usual
// quote/meta shape.
export const australianDividendSplitChartFixture = {
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
        events: {
          dividends: {
            [String(unix("2026-03-05T06:00:00Z"))]: {
              amount: 1.01,
              date: unix("2026-03-05T06:00:00Z"),
            },
          },
          splits: {
            [String(unix("2026-05-01T06:00:00Z"))]: {
              date: unix("2026-05-01T06:00:00Z"),
              numerator: 2,
              denominator: 1,
              splitRatio: "2:1",
            },
          },
        },
      },
    ],
    error: null,
  },
};

/** Same shape but with a malformed dividend entry (missing amount). */
export const malformedDividendChartFixture = {
  chart: {
    result: [
      {
        meta: {
          currency: "AUD",
          exchangeTimezoneName: "Australia/Sydney",
          symbol: "BHP.AX",
        },
        timestamp: [unix("2026-07-28T06:00:00Z")],
        indicators: { quote: [{ close: [41.5] }] },
        events: {
          dividends: {
            [String(unix("2026-03-05T06:00:00Z"))]: {
              date: unix("2026-03-05T06:00:00Z"),
            },
          },
        },
      },
    ],
    error: null,
  },
};

/** Same shape but with no `events` field at all (no corporate actions). */
export const noEventsChartFixture = {
  chart: {
    result: [
      {
        meta: {
          currency: "AUD",
          exchangeTimezoneName: "Australia/Sydney",
          symbol: "BHP.AX",
        },
        timestamp: [unix("2026-07-28T06:00:00Z")],
        indicators: { quote: [{ close: [41.5] }] },
      },
    ],
    error: null,
  },
};

// MKT-005 review fix: a non-Australian (America/New_York) events fixture.
// The dividend timestamp (2026-03-05T02:00:00Z) is still 2026-03-04 local in
// New York (EST, UTC-5, before the 2026 DST transition on March 8), proving
// ex-date is computed in the exchange timezone rather than the raw UTC
// calendar date.
export const usDividendSplitChartFixture = {
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
        timestamp: [unix("2026-07-28T20:00:00Z"), unix("2026-07-29T20:00:00Z")],
        indicators: { quote: [{ close: [187.5, 188.25] }] },
        events: {
          dividends: {
            [String(unix("2026-03-05T02:00:00Z"))]: {
              amount: 0.25,
              date: unix("2026-03-05T02:00:00Z"),
            },
          },
        },
      },
    ],
    error: null,
  },
};
