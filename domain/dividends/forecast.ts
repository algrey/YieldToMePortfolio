// DIV-001: 12-month baseline dividend forecast for one portfolio security --
// "declared-then-TTM" per `docs/CALCULATIONS.md` section 11's "Forecast
// hierarchy": (1) sum known, non-cancelled declared future events using
// current eligible quantity; (2) for the UNCOVERED remainder of the window,
// use a trailing-twelve-month per-share rate, prorated to the uncovered day
// count -- never re-adding the whole TTM figure on top of already-counted
// declared events (double counting), and never silently substituting 0 for
// an unavailable TTM ("respect insufficient_history").
//
// B1 fix (Orchestrator ruling, 2026-08-13): the uncovered tail must
// DISPLACE its share of the TTM annual figure, not stack the full TTM on
// top of the already-counted declared cash. A semiannual payer whose
// trailing year totalled 1000 with one 500 declared event due soon
// previously returned ~1472 (500 declared + ~972 of a nearly-full-year TTM
// tail prorated over the ~355 remaining days) -- more than the trailing
// year's ENTIRE income, because the declared event's own contribution was
// never subtracted out of the tail estimate. The tail is now
// `prorate(max(0, ttmAnnual - declaredCash), uncoveredDays / 365)`: the
// declared amount reduces what the tail assumes is still outstanding for
// the year before that remainder gets prorated across the uncovered days.
// This bounds the total at `declaredCash + (ttmAnnual - declaredCash) *
// fraction <= ttmAnnual` whenever `ttmAnnual >= declaredCash` (the common
// case for a stable payer) -- the forecast can never exceed roughly one
// year of trailing income, and reduces to the plain prorated TTM when there
// is no declared coverage at all (`declaredCash = 0`).
//
// "Current eligible quantity" for a declared-but-unpaid event with a FUTURE
// ex-date is mechanically identical to "shares held today"
// (`deriveSharesHeldAtDate` only sums transactions with `localTradeDate <=
// asOfDate`, and no transaction can be dated after today) -- so this reuses
// the `declared_pending` rows `deriveDividendHistoryForSecurity` already
// produced (override-resolved, franking-chain-resolved) rather than
// recomputing them, and only adds new math for the TTM-estimated tail.
import {
  addDecimal,
  compareDecimal,
  divideDecimal,
  formatDecimalExact,
  fromInteger,
  multiplyDecimal,
  parseDecimal,
  roundDecimal,
  subtractDecimal,
  type DecimalFraction,
} from "../calculations/decimal.ts";
import {
  deriveTrailingTwelveMonthDividend,
  type TrailingDividendEventInput,
} from "../market-data/dividend-yield.ts";
import {
  deriveSharesHeldAtDate,
  type LedgerQuantityFact,
} from "./shares-held.ts";
import { computeDefaultFrankingCredit } from "./franking.ts";
import type { DerivedDividendRow } from "./history.ts";

const FORECAST_WINDOW_DAYS = 365;
const PRORATION_SCALE = 24;
const ZERO = fromInteger(0n);

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function daysBetweenInclusive(fromDate: string, toDate: string): number {
  const msPerDay = 86_400_000;
  const diff =
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) /
    msPerDay;
  return Math.max(0, Math.round(diff) + 1);
}
function sumDecimals(values: readonly string[]): string {
  return formatDecimalExact(
    values.reduce<DecimalFraction>(
      (total, value) => addDecimal(total, parseDecimal(value)),
      ZERO,
    ),
  );
}

export type ForecastCoverageStatus =
  | "no_current_holding"
  | "fully_covered_by_declared"
  | "declared_plus_ttm"
  | "insufficient_history";

export type SecurityDividendForecast = {
  portfolioSecurityId: string;
  currencyCode: string;
  windowFromDate: string;
  windowToDate: string;
  currentSharesDecimal: string;
  status: ForecastCoverageStatus;
  declaredCashDecimal: string;
  declaredFrankingKnownDecimal: string;
  declaredFrankingUnknownCount: number;
  declaredEventCount: number;
  /** Of `declaredEventCount`, how many had an unknown per-share amount and so did not contribute to `declaredCashDecimal` (never fabricated as "0"). */
  declaredUnknownAmountCount: number;
  uncoveredDays: number;
  uncoveredCashDecimal: string | null;
  uncoveredFrankingKnownDecimal: string | null;
  uncoveredReason:
    "insufficient_history" | "mixed_currency" | "invalid_input" | null;
  /** null only when the uncovered tail is unknown AND there is no declared coverage for the full window (nothing safe to total). */
  totalCashDecimal: string | null;
  totalFrankingKnownDecimal: string | null;
  totalFrankingIncomplete: boolean;
  totalGrossDecimal: string | null;
};

export type ComputeSecurityForecastInput = {
  portfolioSecurityId: string;
  currencyCode: string;
  /** This security's full derived history rows (drives the declared-near-certain portion). */
  historyRows: readonly DerivedDividendRow[];
  /** This security's provider events (active+superseded is fine; only declared/paid cash-eligible rows qualify -- see `deriveTrailingTwelveMonthDividend`). Drives the TTM tail. */
  ttmEvents: readonly TrailingDividendEventInput[];
  transactions: readonly LedgerQuantityFact[];
  defaultFrankingPercentDecimal: string | null;
  today: string;
};

export function computeSecurityDividendForecast(
  input: ComputeSecurityForecastInput,
): SecurityDividendForecast {
  const windowFromDate = input.today;
  // Follow-up fix (review round 3): `daysBetweenInclusive` counts BOTH
  // endpoints, so `addDays(today, 365)` produced a 366-DAY inclusive window
  // (today through today+365), which then divided a 365-day-denominated
  // proration (`/ 365` below) by too few uncovered days relative to the
  // window -- a stable payer with zero declared coverage got `uncoveredDays
  // = 366`, so `tail = ttmAnnual * 366 / 365 = 1002.74` for a 1000 TTM
  // instead of exactly 1000. `addDays(today, FORECAST_WINDOW_DAYS - 1)`
  // makes the inclusive window exactly `FORECAST_WINDOW_DAYS` (365) days
  // long (today through today+364), so a fully-uncovered window divides out
  // to exactly 1.0 against the `/ 365` proration denominator.
  const windowToDate = addDays(input.today, FORECAST_WINDOW_DAYS - 1);
  const currentSharesDecimal = deriveSharesHeldAtDate(
    input.transactions,
    input.today,
  );

  // `deriveSharesHeldAtDate` always returns a canonically-trimmed decimal
  // string (see `formatDecimalExact`'s `trimFixed`), so a zero holding is
  // always the literal string "0" -- no parse-and-compare needed.
  if (currentSharesDecimal === "0") {
    return {
      portfolioSecurityId: input.portfolioSecurityId,
      currencyCode: input.currencyCode,
      windowFromDate,
      windowToDate,
      currentSharesDecimal,
      status: "no_current_holding",
      declaredCashDecimal: "0",
      declaredFrankingKnownDecimal: "0",
      declaredFrankingUnknownCount: 0,
      declaredEventCount: 0,
      declaredUnknownAmountCount: 0,
      uncoveredDays: 0,
      uncoveredCashDecimal: "0",
      uncoveredFrankingKnownDecimal: "0",
      uncoveredReason: null,
      totalCashDecimal: "0",
      totalFrankingKnownDecimal: "0",
      totalFrankingIncomplete: false,
      totalGrossDecimal: "0",
    };
  }

  const declaredRows = input.historyRows.filter(
    (row) =>
      row.status === "declared_pending" &&
      !row.excluded &&
      row.exDate !== null &&
      row.exDate >= windowFromDate &&
      row.exDate <= windowToDate,
  );
  // A declared row with an unknown amount (defensive edge case -- see
  // `history.ts`'s null `gross_per_share_decimal` handling) contributes to
  // `declaredEventCount`/coverage-date math (it IS a known future event)
  // but not to the cash sum, which must never fabricate a "0" for it.
  const declaredKnownAmountRows = declaredRows.filter(
    (row) => row.cashDecimal !== null,
  );
  const declaredCashDecimal = sumDecimals(
    declaredKnownAmountRows.map((row) => row.cashDecimal!),
  );
  const declaredFrankingKnownRows = declaredKnownAmountRows.filter(
    (row) => row.frankingTotalDecimal !== null,
  );
  const declaredFrankingKnownDecimal = sumDecimals(
    declaredFrankingKnownRows.map((row) => row.frankingTotalDecimal!),
  );
  const declaredFrankingUnknownCount =
    declaredKnownAmountRows.length - declaredFrankingKnownRows.length;
  const declaredUnknownAmountCount =
    declaredRows.length - declaredKnownAmountRows.length;
  const declaredCoverageEndDate = declaredRows.reduce<string | null>(
    (latest, row) =>
      latest === null || row.exDate! > latest ? row.exDate! : latest,
    null,
  );

  const uncoveredFromDate = declaredCoverageEndDate
    ? addDays(declaredCoverageEndDate, 1)
    : windowFromDate;
  const uncoveredDays =
    uncoveredFromDate > windowToDate
      ? 0
      : daysBetweenInclusive(uncoveredFromDate, windowToDate);

  if (uncoveredDays === 0) {
    return {
      portfolioSecurityId: input.portfolioSecurityId,
      currencyCode: input.currencyCode,
      windowFromDate,
      windowToDate,
      currentSharesDecimal,
      status: "fully_covered_by_declared",
      declaredCashDecimal,
      declaredFrankingKnownDecimal,
      declaredFrankingUnknownCount,
      declaredEventCount: declaredRows.length,
      declaredUnknownAmountCount,
      uncoveredDays: 0,
      uncoveredCashDecimal: "0",
      uncoveredFrankingKnownDecimal: "0",
      uncoveredReason: null,
      totalCashDecimal: declaredCashDecimal,
      totalFrankingKnownDecimal: declaredFrankingKnownDecimal,
      totalFrankingIncomplete: declaredFrankingUnknownCount > 0,
      totalGrossDecimal: sumDecimals([
        declaredCashDecimal,
        declaredFrankingKnownDecimal,
      ]),
    };
  }

  const ttm = deriveTrailingTwelveMonthDividend(input.ttmEvents, input.today);
  const currencyMismatch = ttm.ok && ttm.currencyCode !== input.currencyCode;
  if (!ttm.ok || currencyMismatch) {
    const reason = !ttm.ok ? ttm.reason : "mixed_currency";
    const hasDeclaredCoverage = declaredRows.length > 0;
    return {
      portfolioSecurityId: input.portfolioSecurityId,
      currencyCode: input.currencyCode,
      windowFromDate,
      windowToDate,
      currentSharesDecimal,
      status: hasDeclaredCoverage
        ? "declared_plus_ttm"
        : "insufficient_history",
      declaredCashDecimal,
      declaredFrankingKnownDecimal,
      declaredFrankingUnknownCount,
      declaredEventCount: declaredRows.length,
      declaredUnknownAmountCount,
      uncoveredDays,
      uncoveredCashDecimal: null,
      uncoveredFrankingKnownDecimal: null,
      uncoveredReason: reason,
      // Only the declared portion is safe to total; the uncovered tail is
      // genuinely unknown and must never be silently treated as 0.
      totalCashDecimal: hasDeclaredCoverage ? declaredCashDecimal : null,
      totalFrankingKnownDecimal: hasDeclaredCoverage
        ? declaredFrankingKnownDecimal
        : null,
      totalFrankingIncomplete: true,
      totalGrossDecimal: hasDeclaredCoverage
        ? sumDecimals([declaredCashDecimal, declaredFrankingKnownDecimal])
        : null,
    };
  }

  const ttmAnnualCash = multiplyDecimal(
    parseDecimal(currentSharesDecimal),
    parseDecimal(ttm.ttmPerShareDecimal),
  );
  // B1 fix: the declared cash already counted must displace its share of
  // the TTM annual figure before the remainder is prorated across the
  // uncovered days -- see the module header for the full rationale/bound.
  const declaredCashValue = parseDecimal(declaredCashDecimal);
  const remainingAnnualCash =
    compareDecimal(ttmAnnualCash, declaredCashValue) <= 0
      ? ZERO
      : subtractDecimal(ttmAnnualCash, declaredCashValue);
  const uncoveredCashDecimal = formatDecimalExact(
    roundDecimal(
      divideDecimal(
        multiplyDecimal(
          remainingAnnualCash,
          fromInteger(BigInt(uncoveredDays)),
        ),
        fromInteger(365n),
      ),
      PRORATION_SCALE,
    ),
  );
  // The uncovered tail is a single scalar cash estimate (not a per-share
  // figure across discrete events); `computeDefaultFrankingCredit` is
  // linear in its dividend-amount argument, so the same ATO gross-up
  // formula (`franking.ts`'s module header/`docs/CALCULATIONS.md` section
  // 11) applies directly to this total cash figure, sharing the exact
  // formula and rounding rule `resolveFrankingPerShare`'s default tier
  // uses -- not a separate/divergent calculation.
  const uncoveredFrankingKnownDecimal =
    input.defaultFrankingPercentDecimal !== null
      ? computeDefaultFrankingCredit(
          uncoveredCashDecimal,
          input.defaultFrankingPercentDecimal,
        )
      : null;

  const totalFrankingIncomplete =
    declaredFrankingUnknownCount > 0 || uncoveredFrankingKnownDecimal === null;
  return {
    portfolioSecurityId: input.portfolioSecurityId,
    currencyCode: input.currencyCode,
    windowFromDate,
    windowToDate,
    currentSharesDecimal,
    status: "declared_plus_ttm",
    declaredCashDecimal,
    declaredFrankingKnownDecimal,
    declaredFrankingUnknownCount,
    declaredEventCount: declaredRows.length,
    declaredUnknownAmountCount,
    uncoveredDays,
    uncoveredCashDecimal,
    uncoveredFrankingKnownDecimal,
    uncoveredReason: null,
    totalCashDecimal: sumDecimals([declaredCashDecimal, uncoveredCashDecimal]),
    totalFrankingKnownDecimal: sumDecimals([
      declaredFrankingKnownDecimal,
      uncoveredFrankingKnownDecimal ?? "0",
    ]),
    totalFrankingIncomplete,
    totalGrossDecimal: sumDecimals([
      declaredCashDecimal,
      uncoveredCashDecimal,
      declaredFrankingKnownDecimal,
      uncoveredFrankingKnownDecimal ?? "0",
    ]),
  };
}
