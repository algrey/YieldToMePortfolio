// MKT-005: pure trailing-twelve-month (TTM) per-share dividend and trailing
// yield derivation from already-ingested provider `dividend_events`. These
// feed DIV-003's assumptions grid "provider yield" column -- callers own
// fetching the security's events and a current price and pass in plain,
// already-typed values so this module stays decoupled from both the
// repository layer and the market-data selection layer (see
// `docs/CALCULATIONS.md` section 11's "Trailing cash yield" label: "actual
// gross dividends over trailing 12 months divided by current covered market
// value").
//
// This intentionally SUMS actual events observed within the trailing window
// rather than extrapolating/annualizing from a smaller sample -- per the
// task's acceptance rule, "missing/irregular dividend data yields
// unavailable, not an annualized guess". A security with zero qualifying
// events in the window is `insufficient_history`; a security with one or a
// few events reports exactly what was actually paid, never a multiplied
// estimate.
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  formatDecimalExact,
  formatDecimalFixed,
  fromInteger,
  multiplyDecimal,
  parseDecimal,
  type DecimalFraction,
} from "../calculations/decimal.ts";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TRAILING_WINDOW_DAYS = 365;
const YIELD_DISPLAY_SCALE = 6;

export type TrailingDividendEventInput = {
  exDate: string;
  currencyCode: string;
  grossPerShareDecimal: string;
  // Only 'cash' (ordinary) dividends contribute to TTM/yield -- a documented
  // MKT-005 decision so a 'capital_return' (which reduces cost basis rather
  // than being income, if a future provider ever reports one) cannot
  // inflate a trailing yield figure. IMPORTANT caveat, corrected after
  // review: the Yahoo-compatible provider carries no dividend-type
  // classification at all -- every event it reports is ingested as
  // `kind = 'cash'` (see `yahoo-compatible.ts`'s `getDividendEvents`), so an
  // economically "special" one-off dividend from THIS provider is NOT
  // excluded by this filter; it is counted as an ordinary cash dividend
  // like everything else. The 'special'/'capital_return' exclusion only
  // has an effect for a future provider that actually distinguishes them.
  kind: "cash" | "special" | "capital_return";
  // Only confirmed provider facts ('declared', 'paid') count; 'estimated'
  // rows are forecasts (DIV-002 territory, not a trailing actual), and
  // 'cancelled'/'superseded' rows are not current facts.
  status: "estimated" | "declared" | "paid" | "cancelled" | "superseded";
};

export type TtmDividendResult =
  | {
      ok: true;
      ttmPerShareDecimal: string;
      currencyCode: string;
      eventCount: number;
      windowFromDate: string;
      windowToDate: string;
    }
  | {
      ok: false;
      reason: "insufficient_history" | "mixed_currency" | "invalid_input";
    };

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

function subtractDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function qualifies(
  event: TrailingDividendEventInput,
  windowFromDate: string,
  windowToDate: string,
): boolean {
  return (
    event.kind === "cash" &&
    (event.status === "declared" || event.status === "paid") &&
    isValidDate(event.exDate) &&
    event.exDate >= windowFromDate &&
    event.exDate <= windowToDate
  );
}

/**
 * Sums actual per-share cash dividends over the trailing twelve months
 * ending `asOfDate` (inclusive). Returns the exact source-precision sum
 * (`formatDecimalExact`, never silently rounded) or a stable typed reason
 * when there is nothing safe to report.
 */
export function deriveTrailingTwelveMonthDividend(
  events: readonly TrailingDividendEventInput[],
  asOfDate: string,
): TtmDividendResult {
  if (!isValidDate(asOfDate)) {
    return { ok: false, reason: "invalid_input" };
  }
  const windowFromDate = subtractDays(asOfDate, TRAILING_WINDOW_DAYS);
  const qualifying = events.filter((event) =>
    qualifies(event, windowFromDate, asOfDate),
  );
  if (qualifying.length === 0) {
    return { ok: false, reason: "insufficient_history" };
  }
  const currencyCode = qualifying[0]!.currencyCode;
  if (qualifying.some((event) => event.currencyCode !== currencyCode)) {
    return { ok: false, reason: "mixed_currency" };
  }

  let sum: DecimalFraction;
  try {
    sum = qualifying.reduce<DecimalFraction>(
      (total, event) =>
        addDecimal(total, parseDecimal(event.grossPerShareDecimal)),
      parseDecimal("0"),
    );
  } catch {
    return { ok: false, reason: "invalid_input" };
  }

  return {
    ok: true,
    ttmPerShareDecimal: formatDecimalExact(sum),
    currencyCode,
    eventCount: qualifying.length,
    windowFromDate,
    windowToDate: asOfDate,
  };
}

export type TrailingPriceReference = {
  amountDecimal: string;
  currencyCode: string;
};

export type TrailingDividendYieldResult =
  | {
      ok: true;
      trailingYieldPercentDecimal: string;
      ttmPerShareDecimal: string;
      currencyCode: string;
      eventCount: number;
      windowFromDate: string;
      windowToDate: string;
    }
  | {
      ok: false;
      reason:
        | "insufficient_history"
        | "mixed_currency"
        | "invalid_input"
        | "price_unavailable"
        | "currency_mismatch";
    };

/**
 * Trailing cash yield = TTM per-share dividend / current price, expressed as
 * a percentage. The caller supplies the current price explicitly (per the
 * task's instruction to take price as an input rather than have this module
 * fetch one) -- this module never guesses a price and never falls back to a
 * stale/zero value.
 */
export function deriveTrailingDividendYield(
  events: readonly TrailingDividendEventInput[],
  asOfDate: string,
  price: TrailingPriceReference | null,
): TrailingDividendYieldResult {
  const ttm = deriveTrailingTwelveMonthDividend(events, asOfDate);
  if (!ttm.ok) return ttm;
  if (!price) {
    return { ok: false, reason: "price_unavailable" };
  }
  let priceDecimal: DecimalFraction;
  try {
    priceDecimal = parseDecimal(price.amountDecimal);
  } catch {
    return { ok: false, reason: "price_unavailable" };
  }
  if (compareDecimal(priceDecimal, fromInteger(0n)) <= 0) {
    return { ok: false, reason: "price_unavailable" };
  }
  if (price.currencyCode !== ttm.currencyCode) {
    return { ok: false, reason: "currency_mismatch" };
  }

  let yieldFraction: DecimalFraction;
  try {
    yieldFraction = multiplyDecimal(
      divideDecimal(parseDecimal(ttm.ttmPerShareDecimal), priceDecimal),
      fromInteger(100n),
    );
  } catch {
    return { ok: false, reason: "price_unavailable" };
  }

  return {
    ok: true,
    trailingYieldPercentDecimal: formatDecimalFixed(
      yieldFraction,
      YIELD_DISPLAY_SCALE,
    ),
    ttmPerShareDecimal: ttm.ttmPerShareDecimal,
    currencyCode: ttm.currencyCode,
    eventCount: ttm.eventCount,
    windowFromDate: ttm.windowFromDate,
    windowToDate: ttm.windowToDate,
  };
}
