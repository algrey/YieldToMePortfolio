// DIV-006: trailing-twelve-month (TTM) forecast fallback derived from the
// security's OWN imported/manual dividend history (DIV-001's derived rows)
// when the provider TTM leg (`ttmEvents`, from `dividend_events`) is
// unusable -- the owner's real state (118 imported Sharesight records across
// 14 securities, 13 excluded) has years of actual payment history with
// essentially no provider coverage, so the provider-only leg reported
// `insufficient_history` for nearly every held security.
//
// Owner ruling (2026-08-21, superseding this task's original "raw TTM cash
// total" framing): the history-derived leg forecasts on a PER-SHARE basis
// normalised to the CURRENT position, exactly like the provider leg already
// does (`ttmAnnualCash = currentShares x ttmPerShareDecimal`) -- never a raw
// trailing cash total, which would silently bake in whatever position size
// happened to be held historically. See `domain/dividends/forecast.ts`'s
// module header and `deriveHistoryTrailingTwelveMonthDividend`'s doc
// comment for the full mechanics.
import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveDividendHistoryForSecurity,
  type DividendManualRecordFact,
  type ProviderDividendEventFact,
} from "../domain/dividends/history.ts";
import {
  computeSecurityDividendForecast,
  deriveHistoryTrailingTwelveMonthDividend,
} from "../domain/dividends/forecast.ts";
import type { LedgerQuantityFact } from "../domain/dividends/shares-held.ts";
import {
  deriveTrailingTwelveMonthDividend,
  type TrailingDividendEventInput,
} from "../domain/market-data/dividend-yield.ts";

const TODAY = "2026-08-13";

function tx(
  overrides: Partial<LedgerQuantityFact> & { id: string },
): LedgerQuantityFact {
  const localTradeDate = overrides.localTradeDate ?? "2020-01-01";
  return {
    type: "buy",
    status: "posted",
    localTradeDate,
    tradeAt: `${localTradeDate}T00:00:00Z`,
    quantityDecimal: "1",
    unitPriceDecimal: null,
    reversesTransactionId: null,
    ...overrides,
  };
}

function perShareManual(
  overrides: Partial<DividendManualRecordFact> & {
    id: string;
    paymentDate: string;
  },
): DividendManualRecordFact {
  return {
    sharesDecimal: "999", // deliberately irrelevant to DPS -- see the assertion below
    dividendPerShareDecimal: "1",
    frankingCreditPerShareDecimal: null,
    importBatchId: null,
    ...overrides,
  };
}

function totalsManual(
  overrides: Partial<DividendManualRecordFact> & {
    id: string;
    paymentDate: string;
  },
): DividendManualRecordFact {
  return {
    sharesDecimal: null,
    dividendPerShareDecimal: null,
    frankingCreditPerShareDecimal: null,
    totalCashDecimal: "500",
    totalFrankingDecimal: null,
    importBatchId: "batch-a",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. History-driven TTM math, fixture-exact (direct unit tests on
//    `deriveHistoryTrailingTwelveMonthDividend`).
// ---------------------------------------------------------------------------

test("DIV-006: history TTM sums per-share-mode rows' own DPS within the trailing window, ignoring each row's own share count", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      perShareManual({
        id: "m1",
        paymentDate: "2026-02-01",
        dividendPerShareDecimal: "0.50",
      }),
      perShareManual({
        id: "m2",
        paymentDate: "2026-05-01",
        dividendPerShareDecimal: "0.60",
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const result = deriveHistoryTrailingTwelveMonthDividend(
    rows,
    [],
    "AUD",
    null,
    TODAY,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Each row's own `sharesDecimal` is "999" (fixture default) yet plays no
  // part in this sum -- DPS is a rate, not a total, exactly per the ruling.
  assert.equal(result.ttmPerShareDecimal, "1.1");
  assert.equal(result.rowCount, 2);
  assert.equal(result.incompleteRowCount, 0);
  assert.equal(result.incomplete, false);
});

test("DIV-006: zero qualifying history rows is insufficient_history, never zero or a guess", () => {
  const result = deriveHistoryTrailingTwelveMonthDividend(
    [],
    [],
    "AUD",
    null,
    TODAY,
  );
  assert.deepEqual(result, { ok: false, reason: "insufficient_history" });
});

// ---------------------------------------------------------------------------
// 2. Full-forecast integration: history fallback, provider precedence,
//    foreign-currency conversion, incompleteness, boundary, DPS
//    normalisation against the current position, and the sold-out state.
// ---------------------------------------------------------------------------

test("DIV-006: with no usable provider TTM, the forecast falls back to the security's own history, normalised to the CURRENT share count", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      perShareManual({
        id: "m1",
        paymentDate: "2026-02-01",
        dividendPerShareDecimal: "0.50",
      }),
      perShareManual({
        id: "m2",
        paymentDate: "2026-05-01",
        dividendPerShareDecimal: "0.60",
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2023-01-01", quantityDecimal: "10" }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [], // no provider coverage at all -- the DIV-006 owner-state repro
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    historyCompleteFrom: null,
    today: TODAY,
  });
  assert.equal(forecast.status, "declared_plus_ttm");
  assert.equal(forecast.ttmSource, "history_ttm");
  assert.equal(forecast.ttmIncomplete, false);
  // 10 shares x 1.10 DPS = 11, fully uncovered window.
  assert.equal(forecast.uncoveredCashDecimal, "11");
  assert.equal(forecast.totalCashDecimal, "11");
});

test("DIV-006: a usable provider TTM keeps precedence over the history fallback even when history rows are also present", () => {
  const events: ProviderDividendEventFact[] = [];
  const ttmEvents: TrailingDividendEventInput[] = [
    {
      exDate: "2026-02-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "50",
      kind: "cash",
      status: "paid",
    },
    {
      exDate: "2026-05-01",
      currencyCode: "AUD",
      grossPerShareDecimal: "50",
      kind: "cash",
      status: "paid",
    },
  ];
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events,
    overrides: [],
    receipts: [],
    // Deliberately wildly different from the provider figures, so a test
    // failure (history winning instead of the provider) is unmistakable.
    manualRecords: [
      perShareManual({
        id: "m1",
        paymentDate: "2026-02-01",
        dividendPerShareDecimal: "9999",
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2023-01-01", quantityDecimal: "10" }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents,
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    historyCompleteFrom: null,
    today: TODAY,
  });
  assert.equal(forecast.ttmSource, "provider_ttm");
  // 10 shares x (50 + 50) provider TTM = 1000 -- not the 99990 the (ignored)
  // history figure would have produced.
  assert.equal(forecast.uncoveredCashDecimal, "1000");
  assert.equal(forecast.totalCashDecimal, "1000");
});

test("DIV-006: a foreign-currency totals-mode row contributes its BRK-010-converted total, per-shared against the shares held on its own payment date", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2026-02-01",
        totalCashDecimal: "150",
        currencyCode: "USD",
        fxRateToPortfolioDecimal: "2",
        fxRateSource: "sharesight",
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
    ],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const row = rows[0]!;
  assert.equal(row.currencyCode, "AUD"); // converted -- displays as the security's own currency
  assert.equal(row.cashDecimal, "300"); // 150 USD x rate 2 = 300 AUD

  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    // Covers the row's 2026-02-01 payment date, so its shares-held-at-payment
    // (100, unchanged from today's holding) is trusted.
    historyCompleteFrom: "2020-01-01",
    today: TODAY,
  });
  assert.equal(forecast.ttmSource, "history_ttm");
  assert.equal(forecast.ttmIncomplete, false);
  // DPS = 300 AUD (converted) / 100 shares held at payment = 3; unchanged
  // position (100 shares then, 100 now) means the annualised total exactly
  // equals the converted receipt itself.
  assert.equal(forecast.uncoveredCashDecimal, "300");
});

test("DIV-006: a totals-mode row with no trustworthy shares-held-at-payment-date makes the TTM explicitly incomplete, never zero, never silently dropped", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2026-02-01",
        totalCashDecimal: "500",
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "10" }),
    ],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "10" }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    // No declared history-complete boundary -- the ledger is not PROVEN
    // complete as of the row's payment date, so its DPS cannot be trusted.
    historyCompleteFrom: null,
    today: TODAY,
  });
  assert.equal(forecast.status, "insufficient_history");
  assert.equal(
    forecast.uncoveredReason,
    "unknown_amount",
    "distinct from plain insufficient_history -- there IS trailing-window evidence, just no determinable rate",
  );
  assert.equal(forecast.ttmIncomplete, true);
  assert.equal(
    forecast.totalCashDecimal,
    null,
    "never fabricated as 0 -- nothing safe to total",
  );
});

test("DIV-006: a mix of a known-DPS row and an indeterminate totals-mode row reports the KNOWN portion, flagged incomplete rather than silently dropping the rest", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      perShareManual({
        id: "m1",
        paymentDate: "2026-02-01",
        dividendPerShareDecimal: "0.50",
      }),
      totalsManual({
        id: "m2",
        paymentDate: "2026-05-01",
        totalCashDecimal: "999",
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2023-01-01", quantityDecimal: "10" }),
    ],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2023-01-01", quantityDecimal: "10" }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    historyCompleteFrom: null, // the totals-mode row's DPS stays indeterminate
    today: TODAY,
  });
  assert.equal(forecast.status, "declared_plus_ttm");
  assert.equal(forecast.ttmSource, "history_ttm");
  assert.equal(
    forecast.ttmIncomplete,
    true,
    "one of the two trailing-window rows had no determinable rate",
  );
  // Only the known 0.50/share row contributes: 10 shares x 0.50 = 5 -- a
  // real, disclosed-partial number, never a fabricated 0 and never silently
  // dropped to nothing.
  assert.equal(forecast.uncoveredCashDecimal, "5");
});

test("DIV-006: boundary -- a history row dated exactly 365 days before today qualifies; one day earlier does not", () => {
  const emptyWindow = deriveHistoryTrailingTwelveMonthDividend(
    [],
    [],
    "AUD",
    null,
    TODAY,
  );
  assert.equal(emptyWindow.ok, false);
  if (emptyWindow.ok) return;
  // (insufficient_history with zero rows -- establishes nothing on its own;
  // the real assertions are the two boundary probes below.)

  function rowsForPaymentDate(paymentDate: string) {
    return deriveDividendHistoryForSecurity({
      portfolioSecurityId: "ps1",
      securityCurrencyCode: "AUD",
      events: [],
      overrides: [],
      receipts: [],
      manualRecords: [
        perShareManual({ id: "m1", paymentDate, dividendPerShareDecimal: "1" }),
      ],
      transactions: [],
      defaultFrankingPercentDecimal: null,
      today: TODAY,
    });
  }

  // Binary-search the exact boundary date via the function's own reported
  // `windowFromDate` rather than hand-computing a calendar offset (robust
  // against leap-year arithmetic mistakes in the test itself).
  const probe = deriveHistoryTrailingTwelveMonthDividend(
    rowsForPaymentDate(TODAY),
    [],
    "AUD",
    null,
    TODAY,
  );
  assert.equal(probe.ok, true);
  if (!probe.ok) return;
  const windowFromDate = probe.windowFromDate;

  const onBoundary = deriveHistoryTrailingTwelveMonthDividend(
    rowsForPaymentDate(windowFromDate),
    [],
    "AUD",
    null,
    TODAY,
  );
  assert.equal(onBoundary.ok, true);
  if (onBoundary.ok) assert.equal(onBoundary.rowCount, 1);

  const dayBefore = new Date(`${windowFromDate}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const beforeBoundary = deriveHistoryTrailingTwelveMonthDividend(
    rowsForPaymentDate(dayBefore.toISOString().slice(0, 10)),
    [],
    "AUD",
    null,
    TODAY,
  );
  assert.deepEqual(beforeBoundary, {
    ok: false,
    reason: "insufficient_history",
  });
});

test("DIV-006: DPS normalisation against a CHANGED position -- 100 shares at payment, 200 held today doubles the received cash", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2026-02-01",
        totalCashDecimal: "500",
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
      tx({ id: "b2", localTradeDate: "2026-06-01", quantityDecimal: "100" }), // bought AFTER the payment
    ],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
    tx({ id: "b2", localTradeDate: "2026-06-01", quantityDecimal: "100" }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    historyCompleteFrom: "2020-01-01", // covers the payment date
    today: TODAY,
  });
  assert.equal(forecast.currentSharesDecimal, "200");
  assert.equal(forecast.ttmSource, "history_ttm");
  // DPS = 500 / 100 (shares AT PAYMENT) = 5; annualised against the CURRENT
  // 200 shares = 1000 -- double the raw $500 actually received, because the
  // position doubled since that payment.
  assert.equal(forecast.uncoveredCashDecimal, "1000");
});

test("DIV-006: a fully sold-out position reports the honest zero-position state, distinct from insufficient_history", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      perShareManual({
        id: "m1",
        paymentDate: "2026-02-01",
        dividendPerShareDecimal: "0.50",
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2023-01-01", quantityDecimal: "10" }),
      tx({
        id: "s1",
        type: "sell",
        localTradeDate: "2026-06-01",
        quantityDecimal: "10",
      }),
    ],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2023-01-01", quantityDecimal: "10" }),
    tx({
      id: "s1",
      type: "sell",
      localTradeDate: "2026-06-01",
      quantityDecimal: "10",
    }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    historyCompleteFrom: null,
    today: TODAY,
  });
  assert.equal(forecast.currentSharesDecimal, "0");
  assert.equal(forecast.status, "no_current_holding");
  assert.notEqual(
    forecast.status,
    "insufficient_history",
    "sold-out is a real fact, not a data-absence state",
  );
  assert.equal(forecast.totalCashDecimal, "0");
  assert.equal(forecast.ttmSource, null);
});

// ---------------------------------------------------------------------------
// 3. Review follow-up pins: window parity between the two legs, an
//    un-converted foreign-currency (BRK-010 case C) history row, and a
//    payment date before a SET (non-null) history_complete_from boundary.
// ---------------------------------------------------------------------------

test("DIV-006 review follow-up: the provider and history TTM legs compute the IDENTICAL trailing windowFromDate/windowToDate for the same asOfDate", () => {
  const providerResult = deriveTrailingTwelveMonthDividend(
    [
      {
        exDate: "2026-02-01",
        currencyCode: "AUD",
        grossPerShareDecimal: "1",
        kind: "cash",
        status: "paid",
      },
    ],
    TODAY,
  );
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      perShareManual({
        id: "m1",
        paymentDate: "2026-02-01",
        dividendPerShareDecimal: "1",
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const historyResult = deriveHistoryTrailingTwelveMonthDividend(
    rows,
    [],
    "AUD",
    null,
    TODAY,
  );
  assert.equal(providerResult.ok, true);
  assert.equal(historyResult.ok, true);
  if (!providerResult.ok || !historyResult.ok) return;
  // TRAILING_WINDOW_DAYS/subtractDays are duplicated across
  // domain/market-data/dividend-yield.ts and domain/dividends/forecast.ts --
  // pinned here so a future edit to either module's copy alone is caught as
  // a test failure rather than silently drifting the two legs' windows apart.
  assert.equal(historyResult.windowFromDate, providerResult.windowFromDate);
  assert.equal(historyResult.windowToDate, providerResult.windowToDate);
});

test("DIV-006 review follow-up: an un-converted foreign-currency totals-mode row (BRK-010 case C -- conversion not achievable) degrades the history leg to mixed_currency, never blended", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "NZD",
    // The security's own currency differs from BOTH the payout's currency
    // (USD) and the portfolio base (AUD) -- BRK-010's case C, where no cash
    // conversion is ever attempted at all.
    portfolioBaseCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2026-02-01",
        totalCashDecimal: "150",
        currencyCode: "USD",
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const row = rows[0]!;
  assert.equal(
    row.currencyCode,
    "USD",
    "never silently relabelled as the security's own currency",
  );
  const result = deriveHistoryTrailingTwelveMonthDividend(
    rows,
    [],
    "NZD",
    null,
    TODAY,
  );
  assert.deepEqual(result, { ok: false, reason: "mixed_currency" });
});

test("DIV-006 review follow-up: a totals-mode row's payment date BEFORE a SET (non-null) history_complete_from stays indeterminate -- never zero, never silently dropped", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2026-02-01",
        totalCashDecimal: "500",
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "10" }),
    ],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "10" }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    // SET, but LATER than the row's 2026-02-01 payment date -- distinct from
    // the null-boundary case already covered above: a boundary IS declared,
    // it just does not reach back far enough to cover this row.
    historyCompleteFrom: "2026-03-01",
    today: TODAY,
  });
  assert.equal(forecast.status, "insufficient_history");
  assert.equal(forecast.uncoveredReason, "unknown_amount");
  assert.equal(forecast.ttmIncomplete, true);
  assert.equal(
    forecast.totalCashDecimal,
    null,
    "never fabricated as 0 -- nothing safe to total",
  );
});
