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
//
// DIV-008 (owner ruling, 2026-08-23, REVISING this task): the original
// design gated a BRK-005 totals-mode row's shares-held-at-payment-date
// division on an owner-declared `portfolios.history_complete_from`
// boundary -- with no in-app way to SET that boundary, every totals-mode
// row was permanently indeterminate (the owner's real $0-projection
// report). The owner rejected a settings-form mutator for that boundary
// ("A user might want to see an incomplete history and it would be easier
// to cross ref and debug an incorrect value than a $0 or missing value")
// and the gate was REMOVED entirely: the division is now trusted whenever
// the ledger's OWN shares-held-at-payment-date resolves POSITIVE, no
// boundary required. Every test below that used to require a SET
// `historyCompleteFrom` to unlock a totals-mode row (or expected `null`
// history_complete_from to leave one indeterminate) is flipped accordingly
// -- each flip is called out at the point of the change, never silently
// re-purposed. `deriveHistoryTrailingTwelveMonthDividend`'s signature lost
// its `historyCompleteFrom` parameter; `ComputeSecurityForecastInput` lost
// its `historyCompleteFrom` field.
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
import { computeDefaultFrankingCredit } from "../domain/dividends/franking.ts";
import {
  addDecimal,
  formatDecimalExact,
  parseDecimal,
} from "../domain/calculations/decimal.ts";

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
  // DIV-008 flip: `deriveHistoryTrailingTwelveMonthDividend` no longer takes
  // a `historyCompleteFrom` 5th argument (the gate was removed) -- this
  // test's rows are per-share mode anyway, so the flip is signature-only,
  // no behaviour change.
  const result = deriveHistoryTrailingTwelveMonthDividend(
    rows,
    [],
    "AUD",
    TODAY,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Each row's own `sharesDecimal` is "999" (fixture default) yet plays no
  // part in this sum -- DPS is a rate, not a total, exactly per the ruling.
  assert.equal(result.ttmPerShareDecimal, "1.1");
  assert.equal(result.rowCount, 2);
  assert.equal(result.incompleteRowCount, 0);
  assert.equal(result.historyGapRowCount, 0);
  assert.equal(result.incomplete, false);
});

test("DIV-006: zero qualifying history rows is insufficient_history, never zero or a guess", () => {
  // DIV-008 flip: signature-only (no `historyCompleteFrom` argument).
  const result = deriveHistoryTrailingTwelveMonthDividend([], [], "AUD", TODAY);
  assert.deepEqual(result, { ok: false, reason: "insufficient_history" });
});

test("DIV-008: a per-share-mode row's DPS is used directly regardless of shares held at payment date -- even zero/negative -- the gap check never applies to it", () => {
  // Deliberately NO transactions at all, so shares-held-at-payment-date
  // resolves to "0" for every date -- if the gap check were (wrongly)
  // applied to a per-share row, this would become a provable-gap
  // exclusion. It must not: `deriveHistoryRowDps` returns the row's own
  // `dividendPerShareDecimal` before ever consulting the ledger.
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
        dividendPerShareDecimal: "0.75",
      }),
    ],
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const result = deriveHistoryTrailingTwelveMonthDividend(
    rows,
    [], // zero transactions -- shares-held-at-payment-date is "0" everywhere
    "AUD",
    TODAY,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ttmPerShareDecimal, "0.75");
  assert.equal(result.incompleteRowCount, 0);
  assert.equal(result.historyGapRowCount, 0);
});

test("DIV-008: a totals-mode row whose ledger-derived shares-held-at-payment-date is NEGATIVE (a sell with no prior buy in the ledger) is a provable gap, same as zero", () => {
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
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  // A sell with NO corresponding buy anywhere in the ledger -- an
  // incomplete import -- drives `deriveSharesHeldAtDate` negative rather
  // than clamping at zero (see `shares-held.ts`; no floor is applied).
  const NEGATIVE_SHARES_TX: LedgerQuantityFact[] = [
    tx({
      id: "s1",
      type: "sell",
      localTradeDate: "2025-06-01",
      quantityDecimal: "10",
    }),
  ];
  const result = deriveHistoryTrailingTwelveMonthDividend(
    rows,
    NEGATIVE_SHARES_TX,
    "AUD",
    TODAY,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.ttmPerShareDecimal,
    null,
    "the only qualifying row is indeterminate -- nothing to sum",
  );
  assert.equal(result.rowCount, 1);
  assert.equal(result.incompleteRowCount, 1);
  assert.equal(
    result.historyGapRowCount,
    1,
    "a negative resolved share count is a PROVABLE gap, same reason as zero -- never conflated with a genuinely unknown amount",
  );
  assert.equal(result.incomplete, true);
});

// ---------------------------------------------------------------------------
// 2. Full-forecast integration: history fallback, provider precedence,
//    foreign-currency conversion, incompleteness, and DPS normalisation
//    against the current position. DIV-008: no `historyCompleteFrom`
//    boundary is threaded through any of these any more.
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
    // DIV-008 flip: `historyCompleteFrom` no longer exists on this input --
    // these rows are per-share mode anyway, so removing it changes nothing.
    today: TODAY,
  });
  assert.equal(forecast.status, "declared_plus_ttm");
  assert.equal(forecast.ttmSource, "history_ttm");
  assert.equal(forecast.ttmIncomplete, false);
  // 10 shares x 1.10 DPS = 11, fully uncovered window.
  assert.equal(forecast.uncoveredCashDecimal, "11");
  assert.equal(forecast.totalCashDecimal, "11");
});

test("DIV-008 end-to-end (owner-shaped): a Sharesight totals-mode-only security with NO history_complete_from concept at all reports a real non-zero history_ttm headline -- the exact case that used to read $0", () => {
  // Mirrors the owner's real shape (BRK-005/BRK-005C): a Sharesight-synced
  // security with ONLY totals-mode dividend history (no per-share rate, no
  // provider dividend_events at all) and an ordinary buy in the ledger.
  // Pre-DIV-008 this required a SET `history_complete_from` boundary
  // covering the payment date to unlock at all -- with no in-app way to set
  // one, it stayed `insufficient_history` forever. DIV-008 removed that
  // requirement outright.
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2026-03-01",
        totalCashDecimal: "150",
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
    ],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [], // zero provider coverage -- forces the history fallback
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  assert.equal(forecast.ttmSource, "history_ttm");
  assert.equal(forecast.ttmIncomplete, false);
  assert.notEqual(forecast.totalGrossDecimal, null);
  assert.notEqual(forecast.totalGrossDecimal, "0");
  // DPS = 150 / 100 shares held at payment = 1.5; unchanged position (100
  // then, 100 now) annualises to exactly the received cash.
  assert.equal(forecast.uncoveredCashDecimal, "150");
  assert.equal(forecast.totalCashDecimal, "150");
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
    today: TODAY,
  });
  assert.equal(forecast.ttmSource, "provider_ttm");
  // 10 shares x (50 + 50) provider TTM = 1000 -- not the 99990 the (ignored)
  // history figure would have produced.
  assert.equal(forecast.uncoveredCashDecimal, "1000");
  assert.equal(forecast.totalCashDecimal, "1000");
});

test("DIV-008 flip (was: 'a foreign-currency totals-mode row ... trusted once history_complete_from covers the payment date'): the SAME row now derives from ledger evidence alone -- no boundary needed", () => {
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
    // DIV-008 flip: this test used to pass `historyCompleteFrom:
    // "2020-01-01"` to cover the row's 2026-02-01 payment date -- that
    // field no longer exists. The row's shares-held-at-payment-date (100,
    // from the 2025-01-01 buy above) resolves POSITIVE on ledger evidence
    // alone, so the SAME row derives with no boundary at all.
    today: TODAY,
  });
  assert.equal(forecast.ttmSource, "history_ttm");
  assert.equal(forecast.ttmIncomplete, false);
  // DPS = 300 AUD (converted) / 100 shares held at payment = 3; unchanged
  // position (100 shares then, 100 now) means the annualised total exactly
  // equals the converted receipt itself.
  assert.equal(forecast.uncoveredCashDecimal, "300");
});

test("DIV-008 flip (was: 'no trustworthy shares-held-at-payment-date ... history_complete_from null'): a totals-mode row whose ledger shows ZERO shares held at its payment date (a missing early buy) is a provable history gap, named distinctly from a plain unknown amount", () => {
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
    transactions: [],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  // The only buy in the ledger happens AFTER this row's payment date --
  // shares-held-at-payment-date resolves to "0" even though a real dividend
  // was received then. This is the PROVABLE gap DIV-008 names distinctly:
  // the ledger itself proves something (almost certainly an early buy) is
  // missing, e.g. from an incomplete CSV import.
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2026-06-01", quantityDecimal: "10" }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  assert.equal(forecast.status, "insufficient_history");
  assert.equal(
    forecast.uncoveredReason,
    "history_gap",
    "more specific than the generic unknown_amount -- the ledger PROVES a gap exists",
  );
  assert.equal(forecast.ttmIncomplete, true);
  assert.equal(
    forecast.totalCashDecimal,
    null,
    "never fabricated as 0 -- nothing safe to total",
  );
});

test("DIV-006: a mix of a known-DPS row and a provable-gap totals-mode row reports the KNOWN portion, flagged incomplete rather than silently dropping the rest", () => {
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
  // DIV-008 flip: under the old completeness-gate design, m2 stayed
  // indeterminate simply because `historyCompleteFrom` was `null` -- with
  // the SAME 2023 holding, m2's shares-held-at-payment-date would now
  // resolve POSITIVE (10) and derive fine, which would no longer exercise
  // the "mixed known+indeterminate" case this test is for. The holding is
  // reshaped instead to PROVE a real gap around m2's own payment date: sold
  // out well before it, re-bought after it (current holding is unaffected
  // -- still 10 by TODAY).
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2023-01-01", quantityDecimal: "10" }),
    tx({
      id: "s1",
      type: "sell",
      localTradeDate: "2024-01-01",
      quantityDecimal: "10",
    }), // 0 shares from here -- BEFORE m2's 2026-05-01 payment
    tx({ id: "b2", localTradeDate: "2026-06-01", quantityDecimal: "10" }), // re-bought AFTER m2's payment
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  assert.equal(forecast.currentSharesDecimal, "10");
  assert.equal(forecast.status, "declared_plus_ttm");
  assert.equal(forecast.ttmSource, "history_ttm");
  assert.equal(
    forecast.ttmIncomplete,
    true,
    "one of the two trailing-window rows (m2) is a provable gap",
  );
  // Only the known 0.50/share row (m1) contributes: 10 current shares x
  // 0.50 = 5 -- a real, disclosed-partial number, never a fabricated 0 and
  // never silently dropped to nothing.
  assert.equal(forecast.uncoveredCashDecimal, "5");
});

test("DIV-006: boundary -- a history row dated exactly 365 days before today qualifies; one day earlier does not", () => {
  const emptyWindow = deriveHistoryTrailingTwelveMonthDividend(
    [],
    [],
    "AUD",
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
    TODAY,
  );
  assert.equal(probe.ok, true);
  if (!probe.ok) return;
  const windowFromDate = probe.windowFromDate;

  const onBoundary = deriveHistoryTrailingTwelveMonthDividend(
    rowsForPaymentDate(windowFromDate),
    [],
    "AUD",
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
    // DIV-008 flip: this used to require `historyCompleteFrom:
    // "2020-01-01"` to cover the payment date -- the 100-share holding as
    // of the 2025-01-01 buy (well before the 2026-02-01 payment) now proves
    // itself directly from the ledger, no boundary declared.
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
// 3. Review follow-up pins: window parity between the two legs, and an
//    un-converted foreign-currency (BRK-010 case C) history row. DIV-008:
//    the third follow-up pin in this section (a SET-but-too-late
//    `history_complete_from` boundary) no longer has a boundary concept to
//    pin -- replaced by the dedicated provable-gap test above.
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
    TODAY,
  );
  assert.deepEqual(result, { ok: false, reason: "mixed_currency" });
});

// BUG-004 (owner-reported, 2026-08-25): "Under the income tab, Next 12
// Months subtab, it shows estimated franking credits as zero. Franking
// credits over the last 12 months were $9,082." Root cause: the uncovered
// (history-TTM) tail's franking estimate only ever consulted the security's
// OWNER-SET `dividend_security_assumptions.franking_percent_decimal`
// ASSUMPTION -- never set on the real account under investigation -- and
// never consulted the REAL per-row franking evidence already resolved onto
// every history row (`DerivedDividendRow.frankingTotalDecimal`, e.g. from
// imported Sharesight totals). Fixed by carrying that per-row evidence
// forward with the SAME per-row division discipline DIV-008 already
// established for cash (`deriveHistoryRowFrankingPerShare`).
test("BUG-004: a totals-mode security with real per-row franking evidence (Sharesight totals) and no owner franking assumption projects the uncovered tail's franking from that evidence, never $0", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2026-03-01",
        totalCashDecimal: "150",
        totalFrankingDecimal: "64.29", // real recorded franking credit, ~30% company-tax-rate-implied
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
    ],
    defaultFrankingPercentDecimal: null, // owner never set a franking assumption -- the exact real-account shape
    today: TODAY,
  });
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
    today: TODAY,
  });
  assert.equal(forecast.ttmSource, "history_ttm");
  // Franking DPS = 64.29 / 100 shares held at payment = 0.6429; unchanged
  // position (100 then, 100 now) annualises to exactly the received credit.
  assert.equal(forecast.uncoveredFrankingKnownDecimal, "64.29");
  assert.equal(forecast.totalFrankingKnownDecimal, "64.29");
  assert.equal(forecast.totalFrankingIncomplete, false);
  assert.equal(
    forecast.totalGrossDecimal,
    formatDecimalExact(
      addDecimal(
        parseDecimal(forecast.totalCashDecimal!),
        parseDecimal(forecast.totalFrankingKnownDecimal!),
      ),
    ),
  );
});

test("BUG-004: a security with real evidence of an UNFRANKED dividend (totalFrankingDecimal '0') projects a real, known $0 franking -- distinct from no evidence at all", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2026-03-01",
        totalCashDecimal: "150",
        totalFrankingDecimal: "0", // real reported zero -- an unfranked payout, not "unknown"
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
    ],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
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
    today: TODAY,
  });
  assert.equal(forecast.uncoveredFrankingKnownDecimal, "0");
  assert.equal(forecast.totalFrankingKnownDecimal, "0");
  // A REAL known zero (real evidence, all rows resolved) is complete, not
  // flagged incomplete -- distinguishable from "no evidence at all" below.
  assert.equal(forecast.totalFrankingIncomplete, false);
});

test("BUG-004: a security with genuinely NO franking evidence anywhere (no assumption, no per-row franking fact) contributes a $0 known total but is flagged incomplete, never presented as a confident zero", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      perShareManual({
        id: "m1",
        paymentDate: "2026-03-01",
        dividendPerShareDecimal: "1.50",
        sharesDecimal: "100",
        frankingCreditPerShareDecimal: null, // genuinely unknown, not zero
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
    ],
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
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
    today: TODAY,
  });
  assert.equal(forecast.ttmSource, "history_ttm");
  assert.equal(forecast.uncoveredFrankingKnownDecimal, null);
  assert.equal(forecast.totalFrankingKnownDecimal, "0");
  assert.equal(
    forecast.totalFrankingIncomplete,
    true,
    "must never present an evidence-free $0 franking total as complete",
  );
  // The cash side is entirely unaffected by the franking gap.
  assert.equal(forecast.totalCashDecimal, "150");
});

test("BUG-004: an owner-set franking assumption still wins outright over the security's own history evidence (existing precedence unchanged)", () => {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: "ps1",
    securityCurrencyCode: "AUD",
    events: [],
    overrides: [],
    receipts: [],
    manualRecords: [
      totalsManual({
        id: "m1",
        paymentDate: "2026-03-01",
        totalCashDecimal: "150",
        totalFrankingDecimal: "64.29", // real evidence -- must be OUTRANKED by the owner override below
      }),
    ],
    transactions: [
      tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
    ],
    defaultFrankingPercentDecimal: "50", // owner-set assumption wins
    today: TODAY,
  });
  const HOLDING_TX: LedgerQuantityFact[] = [
    tx({ id: "b1", localTradeDate: "2025-01-01", quantityDecimal: "100" }),
  ];
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: rows,
    ttmEvents: [],
    transactions: HOLDING_TX,
    defaultFrankingPercentDecimal: "50",
    today: TODAY,
  });
  // ATO gross-up of $150 cash at 50% franking, NOT the real $64.29 evidence.
  assert.notEqual(forecast.uncoveredFrankingKnownDecimal, "64.29");
  assert.equal(
    forecast.uncoveredFrankingKnownDecimal,
    computeDefaultFrankingCredit("150", "50"),
  );
});
