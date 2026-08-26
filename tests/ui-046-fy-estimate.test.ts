// UI-046: "FY{yy} Estimate" row -- `computeCurrentFinancialYearEstimateRow`
// (`domain/dividends/projection.ts`).
//
// B1 (Orchestrator ruling, blocking review finding): the original design
// summed `computeCurrentFinancialYearRow`'s already-aggregated FY-to-date
// total (which attributes EVERY history row, regardless of status, via
// `paymentDate ?? exDate`) with the remainder forecast's own declared-near-
// certain leg -- double-counting a `declared_pending` row whose provider-
// supplied payment date is already known (a real repro: one declared $100
// dividend inflated the estimate to $200). The fix PARTITIONS BY EVENT:
// every history row feeds the estimate through exactly one of RECEIVED
// (cash in hand), GAP (ex-date passed, payment not yet posted), or
// REMAINDER (still-future declared events + the trailing-twelve-month
// tail). Per the reviewer's required test shape, every test below drives
// REAL history rows through the REAL `deriveDividendHistoryForSecurity` ->
// `computeSecurityDividendForecast` -> `computeIncomeBreakdown` pipeline
// into `computeCurrentFinancialYearEstimateRow` -- never two hand-built,
// pre-aggregated legs.
import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveDividendHistoryForSecurity,
  type DerivedDividendRow,
  type ProviderDividendEventFact,
} from "../domain/dividends/history.ts";
import {
  computeSecurityDividendForecast,
  type SecurityDividendForecast,
} from "../domain/dividends/forecast.ts";
import {
  computeCurrentFinancialYearEstimateRow,
  computeIncomeBreakdown,
  type CurrentFinancialYearEstimateSecurityInput,
} from "../domain/dividends/projection.ts";
import type { LedgerQuantityFact } from "../domain/dividends/shares-held.ts";
import type { TrailingDividendEventInput } from "../domain/market-data/dividend-yield.ts";

// FY26/27 boundary (owner's real FY start month, July): the current FY runs
// 2026-07-01 through 2027-06-30. `TODAY` sits in early FY27, matching the
// reviewer's own worked dates.
const TODAY = "2026-08-13";
const TOMORROW = "2026-08-14"; // B1's one-day-seam shift: the remainder window starts here, not TODAY.
const FY_START_MONTH = 7;
const CURRENT_ENDING_YEAR = 2027;
const FY_END_DATE = "2027-06-30";

function daysBetweenInclusive(fromDate: string, toDate: string): number {
  const msPerDay = 86_400_000;
  const diff =
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) /
    msPerDay;
  return Math.max(0, Math.round(diff) + 1);
}
const REMAINDER_WINDOW_DAYS = daysBetweenInclusive(TOMORROW, FY_END_DATE);

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

function event(
  overrides: Partial<ProviderDividendEventFact> & { id: string },
): ProviderDividendEventFact {
  return {
    kind: "cash",
    status: "declared",
    exDate: "2026-09-01",
    paymentDate: null,
    currencyCode: "AUD",
    grossPerShareDecimal: "10",
    supersedesEventId: null,
    ...overrides,
  };
}

const HOLDING_TX: LedgerQuantityFact[] = [
  tx({ id: "b1", localTradeDate: "2020-01-01", quantityDecimal: "10" }),
];

type SecurityFixture = {
  portfolioSecurityId: string;
  symbol: string;
  currencyCode: string;
  rows: DerivedDividendRow[];
  transactions: LedgerQuantityFact[];
};

function buildSecurity(
  id: string,
  symbol: string,
  currencyCode: string,
  events: ProviderDividendEventFact[],
  transactions: LedgerQuantityFact[] = HOLDING_TX,
): SecurityFixture {
  const rows = deriveDividendHistoryForSecurity({
    portfolioSecurityId: id,
    securityCurrencyCode: currencyCode,
    events,
    overrides: [],
    receipts: [],
    manualRecords: [],
    transactions,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
  });
  return { portfolioSecurityId: id, symbol, currencyCode, rows, transactions };
}

/** Drives each fixture security's REAL rows through the REAL remainder
 * forecast (windowed to TOMORROW through the FY end, matching
 * `app/owned-dividend-history.ts`'s B1 one-day-seam shift) and the REAL
 * `computeIncomeBreakdown` aggregation, then calls
 * `computeCurrentFinancialYearEstimateRow` -- the full real pipeline, never
 * two pre-computed legs. */
function computeEstimate(
  securities: SecurityFixture[],
  baseCurrencyCode = "AUD",
) {
  const forecasts = new Map<string, SecurityDividendForecast>();
  for (const security of securities) {
    // A security with at least one real event ALSO qualifies as trailing
    // (backward-looking) TTM evidence once its own ex-date/payment-date is
    // in the past -- exactly the intended design (the remainder leg
    // legitimately projects OTHER, not-yet-declared future dividends from
    // trailing cadence, per the original task spec), but it is a confound
    // for these B1 PARTITION tests, which only want to prove one EVENT is
    // never counted twice. Pin the provider TTM leg to a real, qualifying,
    // but ZERO-rate event so it deterministically contributes nothing
    // beyond the RECEIVED/GAP/declared legs already under test -- provider
    // precedence (`computeSecurityDividendForecast`'s DIV-006 rule) means
    // this also suppresses the history-TTM fallback that would otherwise
    // pick up the very same rows. A security with NO events at all is left
    // with an empty `ttmEvents` list so it still correctly resolves
    // `insufficient_history` (needed by the exclusion-disclosure tests).
    const ttmEvents: TrailingDividendEventInput[] =
      security.rows.length > 0
        ? [
            {
              exDate: TODAY,
              currencyCode: security.currencyCode,
              grossPerShareDecimal: "0",
              kind: "cash",
              status: "paid",
            },
          ]
        : [];
    forecasts.set(
      security.portfolioSecurityId,
      computeSecurityDividendForecast({
        portfolioSecurityId: security.portfolioSecurityId,
        currencyCode: security.currencyCode,
        historyRows: security.rows,
        ttmEvents,
        transactions: security.transactions,
        defaultFrankingPercentDecimal: null,
        today: TODAY,
        windowFromDate: TOMORROW,
        windowDays: REMAINDER_WINDOW_DAYS,
      }),
    );
  }
  const remainderBreakdown = computeIncomeBreakdown({
    baseCurrencyCode,
    currentPortfolioValueDecimal: null,
    currentPortfolioValueStatus: "unavailable",
    securities: securities.map((security) => ({
      portfolioSecurityId: security.portfolioSecurityId,
      symbol: security.symbol,
      currencyCode: security.currencyCode,
      forecast: forecasts.get(security.portfolioSecurityId)!,
    })),
  });
  const estimateSecurities: CurrentFinancialYearEstimateSecurityInput[] =
    securities.map((security) => ({
      portfolioSecurityId: security.portfolioSecurityId,
      symbol: security.symbol,
      currencyCode: security.currencyCode,
      rows: security.rows,
    }));
  return computeCurrentFinancialYearEstimateRow({
    baseCurrencyCode,
    startMonth: FY_START_MONTH,
    currentEndingYear: CURRENT_ENDING_YEAR,
    today: TODAY,
    securities: estimateSecurities,
    remainderBreakdown,
  });
}

test("UI-046 B1 (reviewer's exact repro): a declared dividend still in the future (ex 2026-09-01, pay 2026-09-20) is counted ONCE via the remainder leg -- estimate gross exactly 100, not 200", () => {
  const security = buildSecurity("ps1", "AAA", "AUD", [
    event({ id: "e1", exDate: "2026-09-01", paymentDate: "2026-09-20" }),
  ]);
  const result = computeEstimate([security]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.dividendGrossDecimal, "100");
  assert.equal(result.row.dividendCashDecimal, "100");
});

test("UI-046 B1 GAP CASE (ruling's exact worked example): ex-date passed but payment not yet posted (ex 2026-08-01, pay 2026-09-20, today 2026-08-13) is counted ONCE, via GAP -- never dropped, never doubled", () => {
  const security = buildSecurity("ps1", "AAA", "AUD", [
    event({ id: "e1", exDate: "2026-08-01", paymentDate: "2026-09-20" }),
  ]);
  // Sanity: this event's ex-date has already passed relative to TODAY, so
  // it can never be `declared_pending` (and therefore can never reach the
  // remainder leg's declared-near-certain sum).
  assert.equal(security.rows[0]!.status, "ex_date_passed");
  const result = computeEstimate([security]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.dividendGrossDecimal, "100");
  assert.equal(result.row.dividendCashDecimal, "100");
});

test("UI-046 B1 RECEIVED CASE: an already-paid dividend (ex + pay both in the past) is counted via RECEIVED, not GAP, not remainder -- still exactly once", () => {
  const security = buildSecurity("ps1", "AAA", "AUD", [
    event({ id: "e1", exDate: "2026-07-01", paymentDate: "2026-07-15" }),
  ]);
  const result = computeEstimate([security]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.dividendGrossDecimal, "100");
});

test("UI-046 B1: an event with exDate exactly TODAY lands in exactly one leg (GAP, since its payment date is unknown) -- never the remainder's declared leg, never doubled by the one-day window shift", () => {
  const security = buildSecurity("ps1", "AAA", "AUD", [
    event({ id: "e1", exDate: TODAY, paymentDate: null }),
  ]);
  // `exDate <= today` makes this row `"ex_date_passed"`, never
  // `"declared_pending"` -- structurally excluded from the remainder's
  // declared leg regardless of the window shift.
  assert.equal(security.rows[0]!.status, "ex_date_passed");
  const result = computeEstimate([security]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.dividendGrossDecimal, "100");
});

test("UI-046 B1: RECEIVED + GAP + a future declared event on the SAME security combine additively with no double count", () => {
  const security = buildSecurity("ps1", "AAA", "AUD", [
    event({
      id: "received",
      exDate: "2026-07-01",
      paymentDate: "2026-07-15",
      grossPerShareDecimal: "5", // 10 shares x 5 = 50
    }),
    event({
      id: "gap",
      exDate: "2026-08-01",
      paymentDate: "2026-09-20",
      grossPerShareDecimal: "3", // 10 shares x 3 = 30
    }),
    event({
      id: "future",
      exDate: "2026-09-01",
      paymentDate: "2026-09-20",
      grossPerShareDecimal: "2", // 10 shares x 2 = 20
    }),
  ]);
  const result = computeEstimate([security]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.dividendGrossDecimal, "100"); // 50 + 30 + 20
});

test("UI-046: an unavailable remainder forecast (no eligible security) still surfaces the RECEIVED/GAP actuals, flagged partial -- never dropped", () => {
  // A held security with NO events/history at all -- `insufficient_history`
  // in the remainder leg, but the received/gap leg still (correctly)
  // contributes nothing real to add, so this alone would read `ok` -- pair
  // it with a security that HAS a real received dividend to prove the
  // real figure survives while the exclusion is still named.
  const noHistory = buildSecurity("ps-none", "NON", "AUD", []);
  const withReceived = buildSecurity("ps1", "AAA", "AUD", [
    event({ id: "e1", exDate: "2026-07-01", paymentDate: "2026-07-15" }),
  ]);
  const result = computeEstimate([noHistory, withReceived]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.dividendGrossDecimal, "100");
  assert.equal(result.row.status, "partial");
  assert.deepEqual(
    result.row.excludedSecurities.map((item) => item.portfolioSecurityId),
    ["ps-none"],
  );
});

test("UI-046: both legs unavailable (no eligible security at all) reports an honest unavailable row, never a fabricated 0", () => {
  const usd = buildSecurity("ps-usd", "USA", "USD", [
    event({ id: "e1", currencyCode: "USD" }),
  ]);
  const result = computeEstimate([usd], "AUD");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.status, "unavailable");
  assert.equal(result.row.dividendGrossDecimal, null);
});

test("UI-046: a foreign-currency security is excluded and named ONCE (not duplicated across the received/gap check and the remainder leg's own exclusion)", () => {
  const usd = buildSecurity("ps-usd", "USA", "USD", [
    event({ id: "e1", currencyCode: "USD" }),
  ]);
  const aud = buildSecurity("ps1", "AAA", "AUD", [
    event({ id: "e2", exDate: "2026-07-01", paymentDate: "2026-07-15" }),
  ]);
  const result = computeEstimate([usd, aud], "AUD");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.status, "partial");
  assert.equal(result.row.excludedSecurities.length, 1);
  assert.deepEqual(result.row.excludedSecurities[0], {
    portfolioSecurityId: "ps-usd",
    symbol: "USA",
    reason: "foreign_currency",
  });
});

test("UI-046: an unknown-amount RECEIVED row is excluded from the sum (never fabricated) but flags dividendAmountIncomplete -- other real contributions still show", () => {
  const security = buildSecurity("ps1", "AAA", "AUD", [
    event({
      id: "known",
      exDate: "2026-07-01",
      paymentDate: "2026-07-15",
      grossPerShareDecimal: "5", // 10 shares x 5 = 50, known
    }),
    event({
      id: "unknown",
      exDate: "2026-07-05",
      paymentDate: "2026-07-20",
      grossPerShareDecimal: null, // unknown amount -- excluded from the sum
    }),
  ]);
  const result = computeEstimate([security]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.dividendGrossDecimal, "50");
  assert.equal(result.row.dividendAmountIncomplete, true);
  assert.equal(result.row.status, "partial");
});

test("UI-046: a degraded FY calendar (invalid start month) fails the estimate row honestly", () => {
  const security = buildSecurity("ps1", "AAA", "AUD", [
    event({ id: "e1", exDate: "2026-09-01", paymentDate: "2026-09-20" }),
  ]);
  const forecast = computeSecurityDividendForecast({
    portfolioSecurityId: "ps1",
    currencyCode: "AUD",
    historyRows: security.rows,
    ttmEvents: [],
    transactions: security.transactions,
    defaultFrankingPercentDecimal: null,
    today: TODAY,
    windowFromDate: TOMORROW,
    windowDays: REMAINDER_WINDOW_DAYS,
  });
  const remainderBreakdown = computeIncomeBreakdown({
    baseCurrencyCode: "AUD",
    currentPortfolioValueDecimal: null,
    currentPortfolioValueStatus: "unavailable",
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "AAA",
        currencyCode: "AUD",
        forecast,
      },
    ],
  });
  const result = computeCurrentFinancialYearEstimateRow({
    baseCurrencyCode: "AUD",
    startMonth: 13, // invalid
    currentEndingYear: CURRENT_ENDING_YEAR,
    today: TODAY,
    securities: [
      {
        portfolioSecurityId: "ps1",
        symbol: "AAA",
        currencyCode: "AUD",
        rows: security.rows,
      },
    ],
    remainderBreakdown,
  });
  assert.deepEqual(result, { ok: false, reason: "invalid_start_month" });
});

test("UI-046: the row's endingYear/label are derived from the FY calendar config, never hardcoded", () => {
  const security = buildSecurity("ps1", "AAA", "AUD", [
    event({ id: "e1", exDate: "2026-09-01", paymentDate: "2026-09-20" }),
  ]);
  const result = computeEstimate([security]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.endingYear, 2027);
  assert.equal(result.row.label, "FY27");
});
