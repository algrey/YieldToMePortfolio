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
// shares HELD ON THAT ROW'S OWN PAYMENT DATE (`deriveSharesHeldAtDate`) --
// never approximated with TODAY's share count, which would silently
// mis-scale the estimate whenever the position size changed between that
// payment and now.
//
// DIV-008 (owner ruling, 2026-08-23, revising DIV-006's original design):
// this division is trusted whenever the ledger-derived share count is
// POSITIVE -- the ledger as it stands IS the evidence, with no separate
// `portfolios.history_complete_from` completeness gate. A prior design
// required an owner-declared boundary date to cover the payment date before
// trusting the division at all; the owner rejected it ("A user might want
// to see an incomplete history and it would be easier to cross ref and
// debug an incorrect value than a $0 or missing value") -- a real,
// cross-checkable (possibly overstated) figure beats a permanently gated
// $0/missing state. Zero-or-negative shares at the payment date despite a
// received dividend is treated as a PROVABLE history gap (the ledger itself
// proves something is missing, e.g. an early buy never imported) and that
// ROW is excluded with a distinguishable reason -- see
// `deriveHistoryRowDps`'s doc comment for the accepted-risk trade-off this
// leaves in place (an UNDETECTABLE overstatement when a missing early buy
// still leaves the ledger-derived count positive). See
// `deriveHistoryTrailingTwelveMonthDividend`'s own doc comment for the exact
// incompleteness/currency rules. `ttmSource` on the result discloses which
// leg actually won so a consumer can label the figure "provider trailing 12
// months" vs "your own recorded dividend history".
//
// DIV-016 part B (owner-approved "override-as-bridge" ruling, TASKS.md
// DIV-016, recorded 2026-08-26): "an owner override
// (`dividend_security_assumptions` yield / franking_percent_decimal) wins
// only while the security has LESS THAN 12 months of real dividend
// history; once a full trailing year of evidence exists, history takes
// over automatically and the override is kept but marked SUPERSEDED
// (visible, not deleted), still deliberately forceable" -- motivated by
// the owner's own framing: "If I buy a new stock, I'll then want to set
// the override, but once a year worth of dividends come in, the override
// is no longer useful." `hasFullYearHistoryEvidence` below is the ONE
// place this "12 months of real evidence" determination is made -- every
// consumer (this module's own franking-tail gate, `projection.ts`'s
// `resolveSecurityYield`/`resolveSecurityFranking`, and the assumptions
// editor's per-security status column) reads THIS field rather than
// re-deriving the rule. Exact definition (both conditions required --
// span alone is NOT enough, see the "one old row" case below):
//   (a) SPAN: this security's OLDEST non-excluded `"ex_date_passed"` row
//       (post-supersession -- `historyRows` is already `list()`-filtered)
//       is attributed (`paymentDate ?? exDate`) on or before
//       `today - 365 days` -- i.e. a full year has genuinely ELAPSED
//       since the earliest evidence.
//   (b) CURRENCY: the CURRENT trailing-365-day window actually resolves a
//       usable TTM rate (`ttmSource !== null` below) -- either leg.
// Both must hold. A security with exactly one row dated 380 days ago and
// nothing since satisfies (a) (its oldest evidence is old enough) but
// fails (b) (the current trailing window is empty -- both TTM legs report
// `insufficient_history`) -- it must NOT count as having a year of USABLE
// evidence; a stale, single old data point never gets to outrank a live
// owner override. This asymmetric AND (never OR) is deliberate: the rule
// must never let a worse-evidence state (old-but-thin) beat a better one
// (a fresh owner override) -- see `docs/CALCULATIONS.md` section 11.
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
// BUG-005: extracted so the Dividends tab's own display can reuse the
// IDENTICAL per-row division rather than a second copy -- see that module's
// header for the full rationale.
import {
  deriveHistoryRowDps,
  deriveHistoryRowFrankingPerShare,
} from "./history-row-derivation.ts";

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
 * DIV-016 part B: the SPAN half of `hasFullYearHistoryEvidence` (see the
 * module header) -- the earliest attribution date (`paymentDate ?? exDate`)
 * among this security's non-excluded, actually-received (`"ex_date_passed"`)
 * rows, or `null` when there is no such evidence at all. Every source
 * (auto-derived, edited, receipt, owner-typed manual, imported) counts
 * equally, matching `deriveHistoryTrailingTwelveMonthDividend`'s own
 * qualifying-row convention.
 */
function deriveOldestDividendEvidenceDate(
  historyRows: readonly DerivedDividendRow[],
): string | null {
  let oldest: string | null = null;
  for (const row of historyRows) {
    if (row.status !== "ex_date_passed" || row.excluded) continue;
    const date = row.paymentDate ?? row.exDate;
    if (date === null) continue;
    if (oldest === null || date < oldest) oldest = date;
  }
  return oldest;
}

// BUG-005: `HistoryRowDpsResult`, `deriveHistoryRowDps`, and
// `deriveHistoryRowFrankingPerShare` moved to `./history-row-derivation.ts`
// (imported above) so the Dividends tab's own per-row display can reuse the
// IDENTICAL division this fallback relies on -- see that module's header.

export type HistoryTtmDividendResult =
  | {
      ok: true;
      /** Sum of trailing-365-day per-share rates derived from this security's own history rows -- `null` only when EVERY qualifying row's rate is indeterminate (nothing safe to total; see `incomplete`). Never a fabricated "0". */
      ttmPerShareDecimal: string | null;
      /** BUG-004 (owner-reported "estimated franking credits show $0" despite ~$9,082 of real trailing-12-month franking evidence): sum of trailing-365-day per-share FRANKING rates derived from this security's OWN history rows' real recorded franking evidence (`DerivedDividendRow.frankingTotalDecimal` -- `deriveHistoryRowFrankingPerShare`, the same per-row evidence discipline as `ttmPerShareDecimal` above), independent of `ttmPerShareDecimal`'s own completeness (a row can have a determinable cash rate but indeterminate/unknown franking, or vice versa -- see `frankingIncompleteRowCount`). `null` only when NOT ONE qualifying row's franking rate is known -- never a fabricated "0". */
      ttmFrankingPerShareDecimal: string | null;
      currencyCode: string;
      /** Count of rows within the trailing window (regardless of whether their rate was derivable). */
      rowCount: number;
      /** Of `rowCount`, how many had an indeterminate per-share rate (unknown cash amount/payment date, or a provable ledger gap -- see `historyGapRowCount`) -- excluded from `ttmPerShareDecimal`'s sum, never guessed, never silently dropped. */
      incompleteRowCount: number;
      /** DIV-008: of `incompleteRowCount`, how many were excluded specifically because the ledger PROVES a gap -- a real dividend was received but shares-held-at-payment-date resolved to zero or negative (e.g. a missing early buy), never because the amount/payment date was simply unknown. Distinguishable from the rest of `incompleteRowCount` so a consumer can tell "evidence of a missing transaction" apart from "genuinely unknown amount". */
      historyGapRowCount: number;
      incomplete: boolean;
      /** BUG-004: of `rowCount`, how many had an indeterminate per-share FRANKING rate (the row's own franking evidence is genuinely unknown -- `franking.source === "unknown"` with no total either -- or the same ledger-derived-share-count issues as `incompleteRowCount`/`historyGapRowCount` above) -- excluded from `ttmFrankingPerShareDecimal`'s sum. Tracked separately from `incompleteRowCount` because a row's cash and franking completeness are independent facts. */
      frankingIncompleteRowCount: number;
      /** BUG-004: mirrors `historyGapRowCount` for the franking rate specifically. */
      frankingHistoryGapRowCount: number;
      /** BUG-004: `true` whenever `frankingIncompleteRowCount > 0` -- at least one qualifying row's franking rate could not be established, so `ttmFrankingPerShareDecimal` (when non-null) may understate the true trailing franking rate. */
      frankingIncomplete: boolean;
      windowFromDate: string;
      windowToDate: string;
    }
  | {
      ok: false;
      reason: "insufficient_history" | "mixed_currency" | "invalid_input";
    };

/**
 * DIV-006/DIV-008: the history-derived TTM fallback, engaged by
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
 * derivable (DIV-008: no completeness boundary gates this any more --
 * `deriveHistoryRowDps` trusts any row whose ledger-derived
 * shares-held-at-payment-date is positive), and
 * `incomplete`/`incompleteRowCount`/`historyGapRowCount` disclose the rest
 * rather than dropping them -- `ttmPerShareDecimal` is `null` only in the
 * degenerate case where NOT ONE qualifying row's rate could be established.
 */
export function deriveHistoryTrailingTwelveMonthDividend(
  historyRows: readonly DerivedDividendRow[],
  transactions: readonly LedgerQuantityFact[],
  currencyCode: string,
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
  let historyGapRowCount = 0;
  const frankingDpsValues: string[] = [];
  let frankingIncompleteRowCount = 0;
  let frankingHistoryGapRowCount = 0;
  for (const row of qualifying) {
    const result = deriveHistoryRowDps(row, transactions);
    if (result.ok) {
      dpsValues.push(result.dpsDecimal);
    } else {
      incompleteRowCount += 1;
      if (result.reason === "history_gap") historyGapRowCount += 1;
    }
    // BUG-004: franking's own per-row completeness is tracked independently
    // of cash's above -- a row can have a determinable cash rate but unknown
    // franking (or the reverse), so this must never be folded into the cash
    // counters.
    const frankingResult = deriveHistoryRowFrankingPerShare(row, transactions);
    if (frankingResult.ok) {
      frankingDpsValues.push(frankingResult.dpsDecimal);
    } else {
      frankingIncompleteRowCount += 1;
      if (frankingResult.reason === "history_gap") {
        frankingHistoryGapRowCount += 1;
      }
    }
  }
  return {
    ok: true,
    ttmPerShareDecimal: dpsValues.length > 0 ? sumDecimals(dpsValues) : null,
    ttmFrankingPerShareDecimal:
      frankingDpsValues.length > 0 ? sumDecimals(frankingDpsValues) : null,
    currencyCode,
    rowCount: qualifying.length,
    incompleteRowCount,
    historyGapRowCount,
    incomplete: incompleteRowCount > 0,
    frankingIncompleteRowCount,
    frankingHistoryGapRowCount,
    frankingIncomplete: frankingIncompleteRowCount > 0,
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
    /** DIV-006: the security has trailing-window history rows, but NOT ONE of them has a determinable per-share rate, and none of that incompleteness is a provable ledger gap (see `historyGapRowCount`/`"history_gap"` below) -- distinct from `"insufficient_history"` (no trailing-window evidence at all), so a consumer can distinguish "we have nothing" from "we have evidence but can't quantify it". */
    | "unknown_amount"
    /** DIV-008: the security has trailing-window history rows, NOT ONE has a determinable per-share rate, AND at least one of those rows is a PROVABLE ledger gap (`deriveHistoryTrailingTwelveMonthDividend`'s `historyGapRowCount > 0` -- a real dividend was received but the ledger's own shares-held-at-payment-date resolved to zero or negative, e.g. a missing early buy). More actionable than the generic `"unknown_amount"`: it names a concrete, cross-checkable ledger gap rather than a merely absent figure. */
    | "history_gap"
    | null;
  /** null only when the uncovered tail is unknown AND there is no declared coverage for the full window (nothing safe to total). */
  totalCashDecimal: string | null;
  totalFrankingKnownDecimal: string | null;
  totalFrankingIncomplete: boolean;
  totalGrossDecimal: string | null;
  /** DIV-006/DIV-009 (round-2 review correction): which TTM leg RESOLVED a
   * rate -- `"provider_ttm"` (provider `dividend_events`) or `"history_ttm"`
   * (this security's own derived dividend history, engaged only when the
   * provider leg is unusable). This no longer means "fed
   * `uncoveredCashDecimal`/`totalCashDecimal`" (the pre-DIV-009 meaning) --
   * DIV-009's B2 fix populates this field even on a `fully_covered_by_declared`
   * forecast, whose total is fully known from declared events and NEVER
   * consults the TTM at all. A non-null `ttmSource` therefore only means "a
   * leg resolved a rate", independent of whether the total uses it; a
   * consumer that cares whether the total itself is TTM-derived must check
   * `status === "declared_plus_ttm" && ttmSource !== null`
   * (`computeIncomeBreakdown`'s `partialTtmSecurities` gate does exactly
   * this). `null` when no leg resolved a usable rate at all: no current
   * holding, or genuinely insufficient/unusable data from BOTH sources
   * (with or without declared coverage -- see `uncoveredReason`). */
  ttmSource: "provider_ttm" | "history_ttm" | null;
  /** `true` when a resolved (or attempted) history-derived rate is only
   * partially determinable -- at least one trailing-window history row's
   * per-share rate could not be established. DIV-009 (round-2 review
   * correction): this describes the RESOLVED RATE itself, not whether that
   * rate fed the forecast's totals -- a `fully_covered_by_declared`
   * forecast (totals purely from declared events) can carry
   * `ttmIncomplete: true` alongside a real `ttmSource`. A consumer that
   * cares whether the TOTAL is understated must check
   * `status === "declared_plus_ttm" && ttmSource !== null` alongside this
   * flag, never this flag alone (see `ttmSource`'s doc comment and
   * `computeIncomeBreakdown`'s gate). Always `false` for
   * `ttmSource === "provider_ttm"` (that leg has no partial-row concept).
   * Can also be `true` even when `ttmSource` is `null`: the "neither leg
   * usable" branch below sets it when qualifying history rows exist but NOT
   * ONE has a determinable rate (`uncoveredReason: "unknown_amount"` /
   * `"history_gap"`) -- that case likewise never feeds a total via TTM. */
  ttmIncomplete: boolean;
  /** DIV-009: the resolved TTM PER-SHARE rate that actually fed this forecast (whichever leg `ttmSource` names), in `currencyCode` -- exposed so a consumer (the income-projection assumption grid/multi-year base) can derive its own per-share yield (rate / current price) from the SAME already-decided figure, rather than re-deriving a trailing yield from raw provider events alone and silently dropping the DIV-008 history fallback. `null` exactly when `ttmSource` is `null` (no leg produced a usable rate). */
  ttmPerShareDecimal: string | null;
  /** DIV-016 part B (override-as-bridge): `true` exactly when this security
   * has a FULL TRAILING YEAR of real, USABLE dividend evidence -- see the
   * module header for the precise (span AND currently-usable-TTM) rule.
   * The single source of truth every "does the owner's assumption
   * override still bridge, or has history taken over automatically"
   * decision reads (`projection.ts`'s `resolveSecurityYield`/
   * `resolveSecurityFranking`, this function's own franking-tail gate
   * below, and the assumptions editor's status column) -- never
   * re-derived a second way. */
  hasFullYearHistoryEvidence: boolean;
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
  /** DIV-016 part B: the security's `force_assumption` flag -- `true`
   * restores the franking-tail assumption's win regardless of
   * `hasFullYearHistoryEvidence`, a deliberate owner action taken via the
   * assumptions editor. Defaults to `false` (the bridge default: history
   * takes over automatically once 12 months of evidence exists). */
  forceAssumption?: boolean;
  today: string;
  /** UI-046: overrides the forward window length (default `FORECAST_WINDOW_DAYS`,
   * 365) -- e.g. the days remaining in the current financial year, so this
   * SAME forecast composition (declared-near-certain, then a
   * declared-displaced/prorated trailing-twelve-month tail) can produce a
   * "rest of this FY" estimate instead of a rolling 12-month one, with no
   * second formula. Only the window LENGTH changes; the tail is still
   * prorated against a fixed 365-day annual denominator (an annual rate
   * scaled by a shorter or longer uncovered span), and declared-event
   * displacement/proration are otherwise unchanged. Must be a non-negative
   * integer (`0` is a legitimate, explicit "no window at all" -- e.g. today
   * IS the current FY's last day, so its remainder forecast covers zero
   * days); any other value (including `undefined`) falls back to
   * `FORECAST_WINDOW_DAYS`. */
  windowDays?: number;
  /** UI-046 (Orchestrator ruling, B1 double-count fix): overrides the
   * forward window's START date (default `today`). The FY Estimate row
   * combines this forecast's forward leg with a SEPARATE, actuals-only
   * FY-to-date leg computed directly from history rows (`computeCurrentFinancialYearEstimateRow`)
   * -- both legs would otherwise claim "today" (the forward window's
   * inclusive start date overlaps the actuals leg's inclusive end date),
   * double-counting whatever the trailing-TTM tail's smooth per-day
   * proration implicitly attributes to that one day. Passing `today + 1`
   * here (while `today` itself, used for `currentSharesDecimal` and the
   * TTM legs' own BACKWARD-looking evidence windows, is UNCHANGED) makes
   * "today" belong exclusively to the actuals leg. Declared-event
   * inclusion/exclusion and the displacement/proration math are otherwise
   * identical -- only the window boundary shifts. Falls back to `today`
   * when omitted or invalid, so every pre-existing caller (the unshifted
   * rolling Next 12 Months forecast) is unaffected. */
  windowFromDate?: string;
};

export function computeSecurityDividendForecast(
  input: ComputeSecurityForecastInput,
): SecurityDividendForecast {
  // UI-046 (B1 fix): the forward window's START date defaults to `today` but
  // a caller may shift it forward (e.g. `today + 1`, so the FY Estimate
  // row's separately-computed actuals leg exclusively owns "today") --
  // see `ComputeSecurityForecastInput.windowFromDate`'s doc comment. Falls
  // back to `today` on anything invalid/omitted, so the standard rolling
  // Next 12 Months forecast (no override) is byte-for-byte unchanged.
  const windowFromDate =
    input.windowFromDate !== undefined && isValidDate(input.windowFromDate)
      ? input.windowFromDate
      : input.today;
  // Follow-up fix (review round 3): `daysBetweenInclusive` counts BOTH
  // endpoints, so `addDays(today, 365)` produced a 366-DAY inclusive window
  // (today through today+365), which then divided a 365-day-denominated
  // proration (`/ 365` below) by too few uncovered days relative to the
  // window -- a stable payer with zero declared coverage got `uncoveredDays
  // = 366`, so `tail = ttmAnnual * 366 / 365 = 1002.74` for a 1000 TTM
  // instead of exactly 1000. `addDays(windowFromDate, windowDays - 1)` makes
  // the inclusive window exactly `windowDays` days long (windowFromDate
  // through windowFromDate+windowDays-1), so a fully-uncovered window
  // divides out to exactly 1.0 against the `/ 365` proration denominator.
  //
  // UI-046: `windowDays` defaults to `FORECAST_WINDOW_DAYS` (365, the
  // rolling Next 12 Months window) but a caller may override it (e.g. the
  // days remaining in the current financial year) to get a "rest of this
  // FY" estimate from this SAME formula -- see `ComputeSecurityForecastInput.windowDays`'s
  // doc comment. `0` is honored explicitly (an intentionally empty window,
  // e.g. today is the FY's last day) rather than falling back to the
  // default -- only a genuinely invalid (non-integer or negative) value or
  // an omitted field falls back.
  const windowDays =
    Number.isInteger(input.windowDays) && (input.windowDays as number) >= 0
      ? (input.windowDays as number)
      : FORECAST_WINDOW_DAYS;
  const windowToDate = addDays(windowFromDate, windowDays - 1);
  const currentSharesDecimal = deriveSharesHeldAtDate(
    input.transactions,
    input.today,
  );

  // DIV-009 review fix (B2, BLOCKING): the TTM legs used to be resolved
  // AFTER the `uncoveredDays === 0` early return below, so a security fully
  // covered by declared events short-circuited with `ttmSource`/
  // `ttmPerShareDecimal` hardcoded `null` even when a perfectly usable
  // provider (or history) TTM existed -- DIV-009's assumption-grid yield
  // resolution then read that `null` pair and dead-ended the security to
  // "no usable TTM" (`insufficient_history`), a REGRESSION from pre-DIV-009
  // behaviour, which computed the provider yield independently of the
  // forecast's own declared-coverage status. Resolving both legs BEFORE the
  // `fully_covered_by_declared` branch lets that branch expose the real
  // resolved rate too -- the forecast's own `status`/totals math is
  // UNCHANGED by this, only the ttm* fields exposed alongside it are now
  // populated whenever a leg resolved, regardless of whether the forecast
  // itself needed the TTM to total (declared coverage may make it strictly
  // unnecessary for the total, but the ASSUMPTION GRID/yield-% concern is a
  // separate consumer).
  //
  // DIV-016 part B: resolved even EARLIER than DIV-009 moved it to --
  // before the zero-shares (`no_current_holding`) early return below -- so
  // `hasFullYearHistoryEvidence` (which needs `resolvedTtmSource`, see the
  // module header) can be honestly disclosed on EVERY branch, including a
  // sold-out holding that still carries real dividend evidence from before
  // the sale.
  //
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
        input.today,
      );

  // Review follow-up (nit): a discriminated local the compiler can prove,
  // replacing an earlier `parseDecimal(ttmPerShareDecimal!)` non-null
  // assertion below -- after the `ttmResolution.source === null` narrowing,
  // TypeScript narrows `ttmResolution` to the two remaining variants, BOTH
  // of which carry a real (non-null) `ttmPerShareDecimal`, so no assertion
  // is needed at the point of use.
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
  const resolvedTtmSource = ttmResolution.source;
  const resolvedTtmIncomplete =
    ttmResolution.source === "history_ttm" ? ttmResolution.incomplete : false;
  const resolvedTtmPerShareDecimal =
    ttmResolution.source === null ? null : ttmResolution.ttmPerShareDecimal;

  // DIV-016 part B: see the module header for the exact rule -- SPAN (an
  // old-enough oldest evidence row) AND a CURRENTLY-usable TTM rate, both
  // required.
  const oldestEvidenceDate = deriveOldestDividendEvidenceDate(
    input.historyRows,
  );
  const fullYearSpanThresholdDate = subtractDays(
    input.today,
    TRAILING_WINDOW_DAYS,
  );
  const hasFullYearEvidenceSpan =
    oldestEvidenceDate !== null &&
    oldestEvidenceDate <= fullYearSpanThresholdDate;
  const hasFullYearHistoryEvidence =
    hasFullYearEvidenceSpan && resolvedTtmSource !== null;

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
      ttmPerShareDecimal: null,
      hasFullYearHistoryEvidence,
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

  // `providerTtm`/`historyTtm`/`ttmResolution`/`resolvedTtmSource`/
  // `resolvedTtmIncomplete`/`resolvedTtmPerShareDecimal`/
  // `hasFullYearHistoryEvidence` are all resolved ABOVE now (DIV-016 part
  // B moved this block earlier still, ahead of the zero-shares early
  // return -- see that block's own comment for why).

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
      // The forecast's own TOTAL is fully known from declared events --
      // `uncoveredReason` stays `null` (there is no uncovered-tail problem
      // to disclose here, matching this field's "why couldn't the total be
      // computed" contract). A resolvable-or-not TTM rate is a SEPARATE
      // concern, exposed via `ttmSource`/`ttmPerShareDecimal` below instead
      // of overloading this field.
      uncoveredReason: null,
      totalCashDecimal: declaredCashDecimal,
      totalFrankingKnownDecimal: declaredFrankingKnownDecimal,
      totalFrankingIncomplete: declaredFrankingUnknownCount > 0,
      totalGrossDecimal: sumDecimals([
        declaredCashDecimal,
        declaredFrankingKnownDecimal,
      ]),
      ttmSource: resolvedTtmSource,
      ttmIncomplete: resolvedTtmIncomplete,
      ttmPerShareDecimal: resolvedTtmPerShareDecimal,
      hasFullYearHistoryEvidence,
    };
  }

  if (ttmResolution.source === null) {
    // Neither leg is usable -- pick the most informative disclosed reason.
    // A history result that found trailing-window rows but could not
    // determine ANY of their rates ("unknown_amount", or DIV-008's more
    // specific "history_gap" when at least one of those rows is a PROVABLE
    // ledger gap) is more specific than a bare "insufficient_history" and
    // must not be conflated with it (DIV-006: "never silently dropped as if
    // absent"); a history-side `mixed_currency` is likewise surfaced over a
    // provider-side `insufficient_history` when it is the more concrete
    // diagnosis. Otherwise the provider leg's own reason (or
    // "mixed_currency" when the provider leg succeeded but its currency
    // didn't match this security's) is reported, matching pre-DIV-006
    // behaviour when there is no history to fall back on at all.
    let reason: SecurityDividendForecast["uncoveredReason"];
    let ttmIncomplete = false;
    if (historyTtm !== null && historyTtm.ok) {
      // DIV-008: a provable ledger gap is MORE actionable/specific than a
      // generic unknown amount -- surfaced whenever at least one of the
      // indeterminate rows is one, even if the rest are plain
      // "unknown_amount" (the most concrete diagnosis wins, same
      // specificity-ordering posture as the branches below).
      reason =
        historyTtm.historyGapRowCount > 0 ? "history_gap" : "unknown_amount";
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
      ttmPerShareDecimal: null,
      // `resolvedTtmSource` is `null` in this branch (that is exactly why
      // this branch was reached), so `hasFullYearHistoryEvidence` is always
      // `false` here regardless of `hasFullYearEvidenceSpan` -- condition
      // (b) in the module header's rule can never hold.
      hasFullYearHistoryEvidence,
    };
  }

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
  // BUG-004 (owner-reported: Next 12 Months showed $0 estimated franking
  // credits despite ~$9,082 of real trailing-12-month franking evidence):
  // precedence for the uncovered tail's franking estimate, per-security,
  // never a portfolio-blanket ratio. (1) An owner-set franking-percent
  // ASSUMPTION (`dividend_security_assumptions.franking_percent_decimal`)
  // wins -- while it is still BRIDGING (DIV-016 part B, owner-approved
  // "override-as-bridge" ruling: it wins outright only while
  // `hasFullYearHistoryEvidence` is `false`, or unconditionally when the
  // owner has set `force_assumption` -- see the module header). (2)
  // Otherwise (no assumption set at all, OR a real full year of history
  // evidence has made the assumption DORMANT and it was not forced), when
  // the TTM leg that actually won is the HISTORY leg, this security's OWN
  // trailing-window per-row franking EVIDENCE (`historyTtm.ttmFrankingPerShareDecimal`,
  // derived by `deriveHistoryTrailingTwelveMonthDividend` using the
  // identical per-row division discipline as the cash rate above -- real
  // recorded franking, e.g. from imported Sharesight totals, not a
  // fabricated percentage) is carried forward with the SAME
  // declared-displacement/proration math as cash just above, so a security
  // that actually received franked dividends projects a franked estimate --
  // this is exactly the owner's stated motivation ("once a year worth of
  // dividends come in, the override is no longer useful") taking effect
  // automatically. (3) A `provider_ttm` leg carries no per-event franking
  // data this codebase resolves, and a security with neither a winning
  // assumption nor history franking evidence has nothing safe to total --
  // `null` (unavailable), never a fabricated "0" standing in for missing
  // evidence.
  const frankingAssumptionBridging =
    input.forceAssumption === true || !hasFullYearHistoryEvidence;
  let uncoveredFrankingKnownDecimal: string | null;
  let usedHistoryFrankingEvidence = false;
  if (
    input.defaultFrankingPercentDecimal !== null &&
    frankingAssumptionBridging
  ) {
    uncoveredFrankingKnownDecimal = computeDefaultFrankingCredit(
      uncoveredCashDecimal,
      input.defaultFrankingPercentDecimal,
    );
  } else if (
    ttmResolution.source === "history_ttm" &&
    historyTtm !== null &&
    historyTtm.ok &&
    historyTtm.ttmFrankingPerShareDecimal !== null
  ) {
    usedHistoryFrankingEvidence = true;
    const frankingAnnual = multiplyDecimal(
      parseDecimal(currentSharesDecimal),
      parseDecimal(historyTtm.ttmFrankingPerShareDecimal),
    );
    const declaredFrankingValue = parseDecimal(declaredFrankingKnownDecimal);
    const remainingAnnualFranking =
      compareDecimal(frankingAnnual, declaredFrankingValue) <= 0
        ? ZERO
        : subtractDecimal(frankingAnnual, declaredFrankingValue);
    uncoveredFrankingKnownDecimal = formatDecimalExact(
      roundDecimal(
        divideDecimal(
          multiplyDecimal(
            remainingAnnualFranking,
            fromInteger(BigInt(uncoveredDays)),
          ),
          fromInteger(365n),
        ),
        PRORATION_SCALE,
      ),
    );
  } else {
    uncoveredFrankingKnownDecimal = null;
  }

  // DIV-006-style disclosure: the total is also "incomplete" when it WAS
  // computed from history evidence but that evidence itself only partially
  // covered the trailing window (`historyTtm.frankingIncomplete`) -- a real,
  // non-fabricated figure that may still understate the true rate, named
  // rather than presented as complete.
  const totalFrankingIncomplete =
    declaredFrankingUnknownCount > 0 ||
    uncoveredFrankingKnownDecimal === null ||
    (usedHistoryFrankingEvidence &&
      historyTtm !== null &&
      historyTtm.ok &&
      historyTtm.frankingIncomplete);
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
    ttmSource: resolvedTtmSource,
    ttmIncomplete: resolvedTtmIncomplete,
    ttmPerShareDecimal: resolvedTtmPerShareDecimal,
    hasFullYearHistoryEvidence,
  };
}
