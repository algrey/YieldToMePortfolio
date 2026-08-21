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
//
// DIV-006 (owner ruling, 2026-08-21): the TTM leg now has TWO possible
// sources, tried in this precedence order: (1) PROVIDER events (`ttmEvents`,
// from `dividend_events`) -- unchanged, since a provider event carries
// declared/ex-date semantics history cannot reconstruct; (2) when the
// provider leg is unusable for this security (no qualifying events, or a
// currency mismatch), the security's OWN derived dividend HISTORY rows
// (`historyRows`, DIV-001's already-precedence-resolved rows) -- actual
// received cash the owner's imports/manual entries/receipts recorded over
// the trailing 365 days. Both legs are normalised to the SAME shape before
// they ever reach the shared `ttmAnnualCash = currentShares x
// ttmPerShareDecimal` math below: a PER-SHARE rate, summed over qualifying
// trailing-window events/rows -- never a raw cash total, which would
// silently bake in whatever position size happened to be held historically
// instead of projecting forward against the CURRENT holding. For the
// provider leg this was already true (`deriveTrailingTwelveMonthDividend`
// returns a per-share rate). For the history leg: a per-share-mode row
// already carries its own per-share amount, used directly; a BRK-005
// totals-mode row (a Sharesight payout with only a total cash figure, no
// share count) is converted to a per-share rate by dividing its total by the
// shares HELD ON THAT ROW'S OWN PAYMENT DATE (`deriveSharesHeldAtDate`,
// gated by the portfolio's declared `historyCompleteFrom` boundary --
// mirrors `domain/gains/carry-forward.ts`'s identical history-honesty gate)
// -- never approximated with TODAY's share count, which would silently
// mis-scale the estimate whenever the position size changed between that
// payment and now. See `deriveHistoryTrailingTwelveMonthDividend`'s own doc
// comment for the exact incompleteness/currency rules. `ttmSource` on the
// result discloses which leg actually won so a consumer can label the
// figure "provider trailing 12 months" vs "your own recorded dividend
// history".
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

// DIV-006: backward-looking trailing window for the history-TTM fallback --
// mirrors `domain/market-data/dividend-yield.ts`'s identically-named/valued
// `TRAILING_WINDOW_DAYS`/`subtractDays`/`isValidDate` (duplicated rather
// than imported, matching this codebase's established convention of
// re-deriving small date primitives per module rather than depending across
// a module boundary for them -- see e.g. `history.ts`'s
// `isNonZeroStoredDecimal` doc comment). A distinct constant from
// `FORECAST_WINDOW_DAYS` above even though both currently equal 365: that
// one drives the FORWARD-looking forecast window, this one the BACKWARD-
// looking trailing-history window -- conflating the two names would make a
// future change to either read as touching both.
const TRAILING_WINDOW_DAYS = 365;
const HISTORY_DPS_SCALE = 24;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function subtractDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
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

/**
 * DIV-006: per-row DPS (dividend-per-share) derivation for the history-TTM
 * fallback. A per-share-mode row (the overwhelming majority -- owner-typed
 * manual entries, receipts, per-share CSV imports, provider auto-derived
 * rows) already carries its own `dividendPerShareDecimal` directly -- the
 * row's OWN `sharesDecimal` is irrelevant to that figure (it is a rate, not
 * a total) and is deliberately never consulted here.
 *
 * A BRK-005 totals-mode row (`dividendPerShareDecimal === null` but
 * `cashDecimal !== null` -- a Sharesight payout reporting only a total cash
 * amount, no share count) has no stored rate at all; this derives one by
 * dividing that total by the shares HELD ON THE ROW'S OWN `paymentDate`
 * (`deriveSharesHeldAtDate`), never by today's current share count -- a
 * position bought/sold between that historical payment and today would
 * otherwise silently mis-scale the derived rate. This division is only
 * trusted when the portfolio's declared `historyCompleteFrom` boundary
 * covers the payment date (mirrors `domain/gains/carry-forward.ts`'s
 * identical history-honesty gate: an incomplete ledger before that date
 * could understate the true historical holding, corrupting the rate) --
 * `null` (no declared boundary), a later boundary, or a malformed value all
 * fail closed. Returns `null` -- never a fabricated "0" -- whenever the rate
 * genuinely cannot be established: unknown cash amount, no payment date, an
 * unproven-complete ledger as of that date, or (defensively) a zero
 * historical share count.
 */
function deriveHistoryRowDps(
  row: DerivedDividendRow,
  transactions: readonly LedgerQuantityFact[],
  historyCompleteFrom: string | null,
): string | null {
  if (row.dividendPerShareDecimal !== null) {
    return row.dividendPerShareDecimal;
  }
  if (row.cashDecimal === null) return null; // genuinely unknown amount
  const paymentDate = row.paymentDate;
  if (paymentDate === null) return null;
  if (
    historyCompleteFrom === null ||
    !DATE_PATTERN.test(historyCompleteFrom) ||
    paymentDate < historyCompleteFrom
  ) {
    return null;
  }
  const sharesAtPayment = deriveSharesHeldAtDate(transactions, paymentDate);
  // Review follow-up: guard `<= 0`, not just the exact string `"0"` --
  // `deriveSharesHeldAtDate` should never legitimately go negative, but this
  // is the same defence-in-depth posture the rest of this module takes
  // (e.g. `history.ts`'s F3 malformed-rate guard): a negative or zero
  // historical share count is indeterminate, never a divisor that would
  // silently produce a negative/fabricated DPS.
  if (compareDecimal(parseDecimal(sharesAtPayment), ZERO) <= 0) return null;
  return formatDecimalExact(
    roundDecimal(
      divideDecimal(
        parseDecimal(row.cashDecimal),
        parseDecimal(sharesAtPayment),
      ),
      HISTORY_DPS_SCALE,
    ),
  );
}

export type HistoryTtmDividendResult =
  | {
      ok: true;
      /** Sum of trailing-365-day per-share rates derived from this security's own history rows -- `null` only when EVERY qualifying row's rate is indeterminate (nothing safe to total; see `incomplete`). Never a fabricated "0". */
      ttmPerShareDecimal: string | null;
      currencyCode: string;
      /** Count of rows within the trailing window (regardless of whether their rate was derivable). */
      rowCount: number;
      /** Of `rowCount`, how many had an indeterminate per-share rate (unknown cash amount, or an unresolvable shares-held-at-payment-date for a totals-mode row) -- excluded from `ttmPerShareDecimal`'s sum, never guessed, never silently dropped. */
      incompleteRowCount: number;
      incomplete: boolean;
      windowFromDate: string;
      windowToDate: string;
    }
  | {
      ok: false;
      reason: "insufficient_history" | "mixed_currency" | "invalid_input";
    };

/**
 * DIV-006: the history-derived TTM fallback, engaged by
 * `computeSecurityDividendForecast` only when the PROVIDER TTM leg
 * (`deriveTrailingTwelveMonthDividend`) is unusable for this security (no
 * qualifying provider events, or a currency mismatch) -- provider events
 * keep precedence when usable. Sums qualifying rows' PER-SHARE rates
 * (`deriveHistoryRowDps`) over the identical trailing-365-day window
 * `deriveTrailingTwelveMonthDividend` uses (same inclusive boundary:
 * `subtractDays(asOfDate, 365)` through `asOfDate`), so a row dated exactly
 * 365 days before `asOfDate` qualifies -- consistent with the provider leg's
 * own boundary. A qualifying row is any non-excluded `"ex_date_passed"` row
 * (actual received cash, never a future `"declared_pending"` estimate)
 * dated -- by the same `paymentDate ?? exDate` attribution convention
 * `aggregations.ts` already establishes -- within the window; every source
 * (auto-derived, edited, receipt, owner-typed manual, imported) qualifies
 * equally, since the great majority of an owner's imported Sharesight
 * history carries `source: "manual"`/`"imported"`, not a provider `kind`
 * classification.
 *
 * Zero qualifying rows is `insufficient_history` (mirrors the provider
 * leg's identical empty-window contract). A currency mismatch among
 * qualifying rows -- e.g. an un-converted foreign-currency imported row
 * (BRK-010's un-achievable-conversion case) -- is `mixed_currency`, exactly
 * like `computeLifetimeDividendTotals`'s established convention, rather than
 * silently blending currencies. Otherwise this always succeeds
 * (`ok: true`): `ttmPerShareDecimal` sums every row whose rate WAS
 * derivable, and `incomplete`/`incompleteRowCount` disclose the rest rather
 * than dropping them -- `ttmPerShareDecimal` is `null` only in the
 * degenerate case where NOT ONE qualifying row's rate could be established.
 */
export function deriveHistoryTrailingTwelveMonthDividend(
  historyRows: readonly DerivedDividendRow[],
  transactions: readonly LedgerQuantityFact[],
  currencyCode: string,
  historyCompleteFrom: string | null,
  asOfDate: string,
): HistoryTtmDividendResult {
  if (!isValidDate(asOfDate)) {
    return { ok: false, reason: "invalid_input" };
  }
  const windowFromDate = subtractDays(asOfDate, TRAILING_WINDOW_DAYS);
  const qualifying = historyRows.filter((row) => {
    if (row.status !== "ex_date_passed" || row.excluded) return false;
    const date = row.paymentDate ?? row.exDate;
    return date !== null && date >= windowFromDate && date <= asOfDate;
  });
  if (qualifying.length === 0) {
    return { ok: false, reason: "insufficient_history" };
  }
  if (qualifying.some((row) => row.currencyCode !== currencyCode)) {
    return { ok: false, reason: "mixed_currency" };
  }
  const dpsValues: string[] = [];
  let incompleteRowCount = 0;
  for (const row of qualifying) {
    const dps = deriveHistoryRowDps(row, transactions, historyCompleteFrom);
    if (dps === null) {
      incompleteRowCount += 1;
    } else {
      dpsValues.push(dps);
    }
  }
  return {
    ok: true,
    ttmPerShareDecimal: dpsValues.length > 0 ? sumDecimals(dpsValues) : null,
    currencyCode,
    rowCount: qualifying.length,
    incompleteRowCount,
    incomplete: incompleteRowCount > 0,
    windowFromDate,
    windowToDate: asOfDate,
  };
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
    | "insufficient_history"
    | "mixed_currency"
    | "invalid_input"
    /** DIV-006: the security has trailing-window history rows, but NOT ONE of them has a determinable per-share rate (see `deriveHistoryTrailingTwelveMonthDividend`'s `incomplete`) -- distinct from `"insufficient_history"` (no trailing-window evidence at all), so a consumer can distinguish "we have nothing" from "we have evidence but can't quantify it". */
    | "unknown_amount"
    | null;
  /** null only when the uncovered tail is unknown AND there is no declared coverage for the full window (nothing safe to total). */
  totalCashDecimal: string | null;
  totalFrankingKnownDecimal: string | null;
  totalFrankingIncomplete: boolean;
  totalGrossDecimal: string | null;
  /** DIV-006: which TTM leg actually fed `uncoveredCashDecimal`/`totalCashDecimal` -- `"provider_ttm"` (provider `dividend_events`, unchanged from pre-DIV-006 behaviour) or `"history_ttm"` (this security's own derived dividend history, engaged only when the provider leg is unusable). `null` when no TTM was used at all: fully covered by declared events, no current holding, or genuinely insufficient/unusable data from BOTH sources. */
  ttmSource: "provider_ttm" | "history_ttm" | null;
  /** DIV-006: `true` when `ttmSource === "history_ttm"` and at least one trailing-window history row's per-share rate could not be established (`deriveHistoryTrailingTwelveMonthDividend`'s `incomplete`) -- the figure is real but may understate the true trailing rate. Always `false` for `"provider_ttm"` (that leg has no partial-row concept) and when `ttmSource` is `null`. */
  ttmIncomplete: boolean;
};

export type ComputeSecurityForecastInput = {
  portfolioSecurityId: string;
  currencyCode: string;
  /** This security's full derived history rows -- drives both the declared-near-certain portion AND (DIV-006) the history-TTM fallback when the provider TTM leg is unusable. */
  historyRows: readonly DerivedDividendRow[];
  /** This security's provider events (active+superseded is fine; only declared/paid cash-eligible rows qualify -- see `deriveTrailingTwelveMonthDividend`). Drives the TTM tail, with precedence over the DIV-006 history fallback whenever usable. */
  ttmEvents: readonly TrailingDividendEventInput[];
  /** Also feeds the DIV-006 history-TTM fallback's shares-held-at-payment-date derivation for a BRK-005 totals-mode row. */
  transactions: readonly LedgerQuantityFact[];
  defaultFrankingPercentDecimal: string | null;
  /** DIV-006: the portfolio's declared `history_complete_from` boundary (`portfolios.history_complete_from`) -- gates whether `deriveSharesHeldAtDate` can be trusted for a totals-mode history row's payment date; see `deriveHistoryRowDps`'s doc comment. `null` when the portfolio has no declared boundary (every totals-mode row then fails closed as incomplete, never guessed). */
  historyCompleteFrom: string | null;
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
      ttmSource: null,
      ttmIncomplete: false,
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
      ttmSource: null,
      ttmIncomplete: false,
    };
  }

  // DIV-006: provider events keep precedence; the history-derived fallback
  // is only even ATTEMPTED when the provider leg is unusable for this
  // security (no qualifying events, or a currency mismatch) -- see the
  // module header and `deriveHistoryTrailingTwelveMonthDividend`'s doc
  // comment for the full rationale.
  const providerTtm = deriveTrailingTwelveMonthDividend(
    input.ttmEvents,
    input.today,
  );
  const providerTtmUsable =
    providerTtm.ok && providerTtm.currencyCode === input.currencyCode;
  const historyTtm = providerTtmUsable
    ? null
    : deriveHistoryTrailingTwelveMonthDividend(
        input.historyRows,
        input.transactions,
        input.currencyCode,
        input.historyCompleteFrom,
        input.today,
      );

  // Review follow-up (nit): a discriminated local the compiler can prove,
  // replacing an earlier `parseDecimal(ttmPerShareDecimal!)` non-null
  // assertion below -- after the `ttmResolution.source === null` early
  // return, TypeScript narrows `ttmResolution` to the two remaining
  // variants, BOTH of which carry a real (non-null) `ttmPerShareDecimal`,
  // so no assertion is needed at the point of use.
  const ttmResolution:
    | { source: "provider_ttm"; ttmPerShareDecimal: string }
    | {
        source: "history_ttm";
        ttmPerShareDecimal: string;
        incomplete: boolean;
      }
    | { source: null } =
    providerTtm.ok && providerTtm.currencyCode === input.currencyCode
      ? {
          source: "provider_ttm",
          ttmPerShareDecimal: providerTtm.ttmPerShareDecimal,
        }
      : historyTtm !== null &&
          historyTtm.ok &&
          historyTtm.ttmPerShareDecimal !== null
        ? {
            source: "history_ttm",
            ttmPerShareDecimal: historyTtm.ttmPerShareDecimal,
            incomplete: historyTtm.incomplete,
          }
        : { source: null };

  if (ttmResolution.source === null) {
    // Neither leg is usable -- pick the most informative disclosed reason.
    // A history result that found trailing-window rows but could not
    // determine ANY of their rates ("unknown_amount") is more specific than
    // a bare "insufficient_history" and must not be conflated with it (DIV-006:
    // "never silently dropped as if absent"); a history-side `mixed_currency`
    // is likewise surfaced over a provider-side `insufficient_history` when
    // it is the more concrete diagnosis. Otherwise the provider leg's own
    // reason (or "mixed_currency" when the provider leg succeeded but its
    // currency didn't match this security's) is reported, matching
    // pre-DIV-006 behaviour when there is no history to fall back on at all.
    let reason: SecurityDividendForecast["uncoveredReason"];
    let ttmIncomplete = false;
    if (historyTtm !== null && historyTtm.ok) {
      reason = "unknown_amount";
      ttmIncomplete = true;
    } else if (
      historyTtm !== null &&
      !historyTtm.ok &&
      historyTtm.reason === "mixed_currency"
    ) {
      reason = "mixed_currency";
    } else if (!providerTtm.ok) {
      reason = providerTtm.reason;
    } else {
      reason = "mixed_currency"; // providerTtm.ok but currency mismatch
    }
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
      ttmSource: null,
      ttmIncomplete,
    };
  }

  const ttmSource = ttmResolution.source;
  const ttmIncomplete =
    ttmResolution.source === "history_ttm" ? ttmResolution.incomplete : false;

  // Both the provider and history TTM legs are normalised to the SAME
  // per-share-rate shape (see the module header), so the annualisation
  // against the CURRENT holding below is identical regardless of which leg
  // won.
  const ttmAnnualCash = multiplyDecimal(
    parseDecimal(currentSharesDecimal),
    parseDecimal(ttmResolution.ttmPerShareDecimal),
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
    ttmSource,
    ttmIncomplete,
  };
}
