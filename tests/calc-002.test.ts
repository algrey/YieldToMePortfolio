import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHistoricalSnapshots,
  type SnapshotPriceObservation,
} from "../domain/snapshots/index.ts";

function price(
  id: string,
  mappingId: string,
  marketDate: string,
  closeDecimal: string,
  currencyCode = "AUD",
  quality: SnapshotPriceObservation["quality"] = "observed",
): SnapshotPriceObservation {
  return {
    id,
    kind: "price",
    providerId: "provider",
    providerRevisionId: null,
    mappingId,
    securityId: "security-1",
    scope: { kind: "deployment", userId: null },
    interval: "eod",
    observationAt: `${marketDate}T08:00:00Z`,
    marketDate,
    marketTimezone: "UTC",
    currencyCode,
    closeDecimal,
    previousCloseDecimal: null,
    adjustmentState: "raw",
    adjustmentFactor: null,
    quality,
    delayedMinutes: null,
    ingestedAt: `${marketDate}T09:00:00Z`,
    payloadSha256: null,
  };
}

function buy(id: string, date: string, quantity: string, priceDecimal: string) {
  return {
    id,
    portfolioSecurityId: "holding-1",
    type: "buy",
    status: "posted",
    tradeAt: `${date}T01:00:00Z`,
    localDate: date,
    quantityDecimal: quantity,
    unitPriceDecimal: priceDecimal,
    grossAmountDecimal: "100",
    feeAmountDecimal: "0",
    taxAmountDecimal: "0",
    fxRateToBaseDecimal: "1",
    reversesTransactionId: null,
  } as const;
}

function baseInput(
  overrides: Partial<Parameters<typeof buildHistoricalSnapshots>[0]> = {},
) {
  return {
    userId: "user-1",
    baseCurrencyCode: "AUD",
    rangeFrom: "2026-08-01",
    rangeTo: "2026-08-03",
    calculationVersion: 1,
    ledgerHistoryCompleteFrom: "2026-08-01",
    securities: [
      {
        portfolioSecurityId: "holding-1",
        securityId: "security-1",
        mappingId: "mapping-1",
        currencyCode: "AUD",
        transactions: [buy("buy-1", "2026-08-01", "10", "10")],
        priceObservations: [
          price("price-1", "mapping-1", "2026-08-01", "10"),
          price("price-2", "mapping-1", "2026-08-02", "11"),
          price("price-3", "mapping-1", "2026-08-03", "12"),
        ],
      },
    ],
    cashAccounts: [
      {
        id: "cash-aud",
        currencyCode: "AUD",
        completeness: "complete" as const,
        entries: [],
      },
    ],
    fxObservations: [],
    ...overrides,
  };
}

test("CALC-002 derives each date from ledger facts instead of back-casting current quantity", () => {
  const input = baseInput({
    securities: [
      {
        ...baseInput().securities[0],
        transactions: [
          buy("buy-1", "2026-08-01", "10", "10"),
          {
            ...buy("sell-1", "2026-08-03", "4", "12"),
            type: "sell",
            grossAmountDecimal: "48",
          },
        ],
      },
    ],
  });
  const result = buildHistoricalSnapshots(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.points.map((point) => point.holdings[0]?.quantityDecimal),
    ["10", "10", "6"],
  );
  assert.deepEqual(
    result.points.map((point) => point.totalValueDecimal),
    ["100", "110", "72"],
  );
  assert.equal(result.points[1]?.dailyMovementDecimal, "10");
  assert.equal(result.points[2]?.dailyMovementDecimal, null);
});

test("CALC-002 marks stale FX and preserves zero components as covered", () => {
  const stale = buildHistoricalSnapshots(
    baseInput({
      securities: [
        {
          ...baseInput().securities[0],
          currencyCode: "USD",
          priceObservations: [
            price("usd-price", "mapping-1", "2026-08-01", "10", "USD"),
          ],
        },
      ],
      fxObservations: [
        {
          id: "stale-fx",
          kind: "fx",
          providerId: "provider",
          providerRevisionId: null,
          scope: { kind: "deployment", userId: null },
          baseCurrencyCode: "AUD",
          quoteCurrencyCode: "USD",
          rateDecimal: "0.65",
          interval: "eod",
          observedAt: "2026-08-01T08:00:00Z",
          marketDate: "2026-08-01",
          quality: "stale_candidate",
          delayedMinutes: null,
          ingestedAt: "2026-08-01T09:00:00Z",
          payloadSha256: null,
        },
      ],
    }),
  );
  assert.equal(stale.ok, true);
  if (!stale.ok) return;
  assert.equal(stale.points[0]?.totalValueDecimal, null);
  assert.equal(stale.points[0]?.coverage.excludedHoldingIds[0], "holding-1");
  assert.equal(stale.points[0]?.coverage.gaps[0]?.kind, "stale_fx");

  const zero = buildHistoricalSnapshots(
    baseInput({
      securities: [
        {
          ...baseInput().securities[0],
          transactions: [],
          priceObservations: [],
        },
      ],
      cashAccounts: [
        {
          id: "cash-usd",
          currencyCode: "USD",
          completeness: "incomplete",
          entries: [],
        },
      ],
    }),
  );
  assert.equal(zero.ok, true);
  if (!zero.ok) return;
  assert.equal(zero.points[0]?.totalValueDecimal, "0");
  assert.equal(zero.points[0]?.completeness, "complete");
  assert.deepEqual(zero.points[0]?.coverage.gaps, []);
});

test("CALC-002 marks partial history and uses prior-session fallback without timestamps in the chart point", () => {
  const result = buildHistoricalSnapshots(
    baseInput({
      rangeFrom: "2026-08-07",
      rangeTo: "2026-08-08",
      ledgerHistoryCompleteFrom: "2026-08-08",
      securities: [
        {
          ...baseInput().securities[0],
          transactions: [buy("buy-1", "2026-08-07", "10", "10")],
          priceObservations: [price("friday", "mapping-1", "2026-08-07", "10")],
        },
      ],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.points[0]?.completeness, "incomplete");
  assert.equal(result.points[0]?.excludedFromPerformance, true);
  assert.equal(result.points[1]?.totalValueDecimal, "100");
  assert.equal(result.points[1]?.completeness, "complete");
  assert.equal(
    result.points[1]?.coverage.marketDataStates[0]?.priceState,
    "fallback",
  );
  assert.equal("observationAt" in result.points[1]!, false);
  assert.deepEqual(
    result,
    buildHistoricalSnapshots(
      baseInput({
        rangeFrom: "2026-08-07",
        rangeTo: "2026-08-08",
        ledgerHistoryCompleteFrom: "2026-08-08",
        securities: [
          {
            ...baseInput().securities[0],
            transactions: [buy("buy-1", "2026-08-07", "10", "10")],
            priceObservations: [
              price("friday", "mapping-1", "2026-08-07", "10"),
            ],
          },
        ],
      }),
    ),
  );
});

test("CALC-002 preserves inverse FX direction and distinguishes holidays from missing sessions", () => {
  const inverse = buildHistoricalSnapshots(
    baseInput({
      securities: [
        {
          ...baseInput().securities[0],
          currencyCode: "USD",
          priceObservations: [
            price("usd-price", "mapping-1", "2026-08-01", "10", "USD"),
          ],
        },
      ],
      fxObservations: [
        {
          id: "usd-aud",
          kind: "fx",
          providerId: "provider",
          providerRevisionId: null,
          scope: { kind: "deployment", userId: null },
          baseCurrencyCode: "USD",
          quoteCurrencyCode: "AUD",
          rateDecimal: "1.25",
          interval: "eod",
          observedAt: "2026-08-01T08:00:00Z",
          marketDate: "2026-08-01",
          quality: "observed",
          delayedMinutes: null,
          ingestedAt: "2026-08-01T09:00:00Z",
          payloadSha256: null,
        },
      ],
      rangeFrom: "2026-08-01",
      rangeTo: "2026-08-01",
    }),
  );
  assert.equal(inverse.ok, true);
  if (!inverse.ok) return;
  assert.equal(inverse.points[0]?.totalValueDecimal, "125");

  const calendarInput = baseInput({
    rangeFrom: "2026-08-07",
    rangeTo: "2026-08-08",
    securities: [
      {
        ...baseInput().securities[0],
        expectedTradingDates: ["2026-08-07"],
        transactions: [buy("buy-1", "2026-08-07", "10", "10")],
        priceObservations: [price("friday", "mapping-1", "2026-08-07", "10")],
      },
    ],
  });
  const holiday = buildHistoricalSnapshots(calendarInput);
  assert.equal(holiday.ok, true);
  if (!holiday.ok) return;
  assert.equal(
    holiday.points[1]?.coverage.marketDataStates[0]?.calendarStatus,
    "holiday",
  );

  const missingSession = buildHistoricalSnapshots({
    ...calendarInput,
    securities: [
      {
        ...calendarInput.securities[0]!,
        expectedTradingDates: ["2026-08-07", "2026-08-08"],
      },
    ],
  });
  assert.equal(missingSession.ok, true);
  if (!missingSession.ok) return;
  assert.equal(
    missingSession.points[1]?.coverage.marketDataStates[0]?.calendarStatus,
    "missing_session",
  );
});

test("CALC-002 replays compensating cash reversals without double-subtracting", () => {
  const result = buildHistoricalSnapshots(
    baseInput({
      rangeTo: "2026-08-02",
      securities: [],
      cashAccounts: [
        {
          id: "cash-aud",
          currencyCode: "AUD",
          completeness: "complete",
          entries: [
            {
              id: "cash-original",
              accountId: "cash-aud",
              localDate: "2026-08-01",
              signedAmountDecimal: "100",
              status: "posted",
              reversesEntryId: null,
            },
            {
              id: "cash-reversal",
              accountId: "cash-aud",
              localDate: "2026-08-02",
              signedAmountDecimal: "-100",
              status: "posted",
              reversesEntryId: "cash-original",
            },
          ],
        },
      ],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.points.map((point) => point.cashValueDecimal),
    ["100", "0"],
  );
});

test("CALC-002 marks malformed ledger and cash facts as gaps instead of zero", () => {
  const invalidLedger = buildHistoricalSnapshots(
    baseInput({
      securities: [
        {
          ...baseInput().securities[0],
          transactions: [buy("invalid-buy", "2026-08-01", "invalid", "10")],
        },
      ],
    }),
  );
  assert.equal(invalidLedger.ok, true);
  if (!invalidLedger.ok) return;
  assert.equal(invalidLedger.points[0]?.totalValueDecimal, null);
  assert.equal(invalidLedger.points[0]?.completeness, "incomplete");
  assert.deepEqual(invalidLedger.points[0]?.coverage.excludedHoldingIds, [
    "holding-1",
  ]);
  assert.ok(
    invalidLedger.points[0]?.coverage.gaps.some(
      (gap) => gap.kind === "invalid_ledger",
    ),
  );

  const invalidCash = buildHistoricalSnapshots(
    baseInput({
      securities: [],
      cashAccounts: [
        {
          id: "cash-aud",
          currencyCode: "AUD",
          completeness: "complete",
          entries: [
            {
              id: "invalid-cash",
              accountId: "cash-aud",
              localDate: "2026-08-01",
              signedAmountDecimal: "invalid",
              status: "posted",
              reversesEntryId: null,
            },
          ],
        },
      ],
    }),
  );
  assert.equal(invalidCash.ok, true);
  if (!invalidCash.ok) return;
  assert.equal(invalidCash.points[0]?.totalValueDecimal, null);
  assert.equal(invalidCash.points[0]?.completeness, "incomplete");
  assert.deepEqual(invalidCash.points[0]?.coverage.excludedCashAccountIds, [
    "cash-aud",
  ]);
});
