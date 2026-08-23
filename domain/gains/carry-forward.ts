// CGT-002: capital loss carry-forward chained across financial years.
//
// Consumes `computeFyCapitalGainsTotals`'s per-FY output (`fy-aggregation.ts`)
// as an opaque, already-final input -- this module never re-derives a FY's
// own current-year gain/loss buckets, it only layers a SECOND loss-offset
// pass on top of each FY's `remainingNonDiscountableAfterLossDecimal`/
// `remainingDiscountableAfterLossDecimal` (i.e. what is left of that FY's
// OWN gains after that FY's OWN current-year losses have already been
// applied -- `fy-aggregation.ts`'s steps 1-2). This structurally enforces
// the binding ordering rule below: a chained loss can only ever be applied
// AFTER current-year losses have already been subtracted, never before,
// because the pre-current-year-loss gross figures are simply not visible to
// this module.
//
// Orchestrator ruling (TASKS.md CGT-002, BINDING):
//
//   1. Chain from the EARLIEST disposal FY forward. Each FY's unabsorbed net
//      capital loss (its own current-year excess, PLUS any prior-FY loss it
//      could not itself fully absorb) carries into the NEXT FY as "losses
//      brought forward".
//   2. Within a FY, the brought-forward loss is applied AFTER that FY's own
//      current-year losses, using the SAME ordering preference: against the
//      remaining non-discountable gain first, then the remaining
//      discountable gain -- and always BEFORE the 50% discount is computed.
//   3. The 50% discount is then applied to whatever discountable amount
//      remains after BOTH current-year losses and the brought-forward loss.
//
// Ordering note (worked out and pinned by `tests/cgt-002.test.ts`): the
// relative order of "this FY's own loss" vs. "loss brought forward" cannot,
// by itself, change a FY's final remaining-gain figures -- floor-at-zero
// sequential subtraction against the same two-tier priority is associative,
// so splitting one combined loss amount into two pools applied in either
// order lands on the same (non-discountable, discountable) remainder. What
// DOES change the outcome -- and what step 2/3 above actually pin -- is
// applying the brought-forward loss against the PRE-discount discountable
// amount rather than against the already-discounted net figure. The latter
// is the natural implementation mistake (subtracting the carry-in straight
// off `netCapitalGainEstimateDecimal`, which already has the discount
// baked in) and gives a materially different, WRONG answer; see the
// discriminating fixture in the test file.
//
// History-honesty predicate: `portfolios.history_complete_from` is the
// earliest local calendar date the ledger is known to be a COMPLETE record
// (IMP-004A/reconciliation's declared opening-history boundary). The carry
// chain can only be trusted from that date onward -- a disposal FY starting
// before it may have had real, unrecorded losses in prior years that this
// chain has no way to see, so every carried figure from the very first FY
// onward is flagged, and so is the whole-period net. Complete iff
// `history_complete_from` is set AND is on or before the earliest disposal
// FY's start date; `null` or a LATER date both count as incomplete (a
// later date literally means the declared complete-record boundary sits
// inside, or after, the disposal history being charted).
//
// Partial-coverage propagation: a FY whose OWN totals already exclude
// incomplete-basis allocations (`FyCapitalGainsTotal.partialCoverage`) has
// an unknowable true gain/loss for that year -- its `remainingAfterLoss`/
// `unabsorbedLossDecimal` figures are real numbers, but only over the
// allocations that WERE resolvable, so they may understate or overstate
// what should actually carry forward. Once a FY's own coverage is partial,
// every carried figure from that FY onward is tainted and STAYS tainted for
// the rest of the chain (this module never attempts to "heal" a corrupted
// prefix) -- exactly like the history-incompleteness taint above, and
// combined with it.
//
// Informational estimate only -- NOT tax advice. See
// `docs/CALCULATIONS.md` section 14.
import {
  addDecimal,
  compareDecimal,
  formatDecimalExact,
  fromInteger,
  multiplyDecimal,
  parseDecimal,
  parseDecimalResult,
  subtractDecimal,
  type DecimalFraction,
} from "../calculations/decimal.ts";
import { CGT_INDIVIDUAL_DISCOUNT_RATE } from "./eligibility.ts";
import type { FyCapitalGainsTotal } from "./fy-aggregation.ts";

const ZERO = fromInteger(0n);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Standing disclosure for the carried chain -- replaces
 * `fy-aggregation.ts`'s old `CGT_CARRY_FORWARD_OUT_OF_SCOPE_NOTE` (renamed,
 * not merely reworded: carry-forward is no longer out of scope, so the old
 * name itself would be dishonest). Callers surface this EXACT text wherever
 * a carried figure (brought forward / applied this FY / carried out, or the
 * whole-period net) is shown, rather than paraphrasing the rule differently
 * in more than one place. Deliberately free of apostrophes and quotation
 * marks -- `renderToStaticMarkup` HTML-entity-escapes both (`'` and `"`),
 * which would otherwise break every rendered-HTML `.includes(...)` /
 * `indexOf(...)` exact-text assertion that checks for this constant.
 */
export const CGT_CARRY_FORWARD_NOTE =
  "Unapplied capital losses carry forward to future financial years. Each " +
  "financial year applies its own current-year losses first, then any " +
  "loss carried in from an earlier year -- against non-discountable gains " +
  "first, then discountable gains, always before the 50% discount. " +
  "Figures below labelled standalone are the totals for that financial " +
  "year alone, before any prior-year loss is carried in.";

/** One FY's carried (chain-adjusted) totals, keyed by `endingYear` to join back onto `FyCapitalGainsTotal`. */
export type FyCarriedCapitalGains = {
  endingYear: number;
  /** Loss carried in from the prior FY in the chain (0 for the earliest FY -- no prior data). */
  carryInLossDecimal: string;
  carryInAppliedToNonDiscountableDecimal: string;
  carryInAppliedToDiscountableDecimal: string;
  /** Sum of the two applied amounts above -- how much of `carryInLossDecimal` this FY actually used. */
  carryInAppliedDecimal: string;
  /** Pre-discount remaining discountable amount AFTER both current-year losses and the carried-in loss. */
  remainingDiscountableAfterCarryInDecimal: string;
  discountAppliedDecimal: string;
  /** This FY's TRUE net capital gain estimate once the carried-in loss is applied -- what this module exists to compute. */
  netCapitalGainEstimateDecimal: string;
  /** Unabsorbed loss carried OUT to the next FY: this FY's own current-year excess plus whatever of the carried-in loss this FY could not itself absorb. */
  carryOutLossDecimal: string;
  /** Mirrors `FyCapitalGainsTotal.partialCoverage` for this FY alone (this FY's own incomplete-basis exclusions). */
  ownPartialCoverage: boolean;
  /**
   * True once history-incompleteness OR any FY at or before this one in the
   * chain had partial coverage -- every carried figure on this row (brought
   * forward, applied, carried out, and the true net above) may be
   * understated/overstated as a result, and stays flagged for the rest of
   * the chain once triggered.
   */
  carriedFiguresPartial: boolean;
};

export type CapitalGainsCarryChainResult = {
  /** True iff `historyCompleteFrom` is set and on/before the earliest disposal FY's start date. */
  historyComplete: boolean;
  /** Human-readable disclosure when `historyComplete` is false; `null` when complete. */
  historyIncompleteMessage: string | null;
  /** Start date of the earliest disposal FY in the chain; `null` when `fyTotals` is empty. */
  earliestFyStartDate: string | null;
  /** One entry per input FY, same order as `fyTotals` (`computeFyCapitalGainsTotals`' newest-first contract). */
  perFy: FyCarriedCapitalGains[];
  /** Sum of every FY's own carried (true) net capital gain estimate -- the TRUE whole-period net, not a standalone-figure rollup. */
  lifetimeNetCapitalGainEstimateDecimal: string;
  /** True iff any carried figure anywhere in the chain (equivalently: the most recent FY's `carriedFiguresPartial`) is tainted. */
  lifetimeNetPartial: boolean;
  /** The most recent FY's `carryOutLossDecimal` -- loss still available to offset a FUTURE, not-yet-reported FY. Disclosed separately; never netted into the whole-period figure above (mirrors how a single FY's own `unabsorbedLossDecimal` is disclosed, not netted, in `fy-aggregation.ts`). */
  finalCarryOutLossDecimal: string;
};

function minDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): DecimalFraction {
  return compareDecimal(left, right) <= 0 ? left : right;
}

/**
 * The history-honesty predicate and its disclosure message, worked out
 * literally from the ruling: complete iff `historyCompleteFrom` is a valid
 * date on or before `earliestFyStartDate`; `null`, a later date, or a
 * malformed value are all incomplete (never silently treated as complete).
 *
 * Exported (CGT-004 review ruling B2/fold): `app/owned-capital-gains.ts`'s
 * `buildCapitalGainsDisplayRows` needs the exact same "is this reference
 * date covered by the completeness boundary" boolean for a SECOND purpose
 * (classifying a padded, no-real-disposal financial year as a known zero
 * vs. genuinely unknown) and reuses this function directly rather than
 * re-deriving the same comparison, so the two call sites can never drift
 * apart. That caller passes an arbitrary candidate FY's start date (not
 * necessarily the true earliest disposal FY) and a caller-resolved
 * fallback boundary in place of `historyCompleteFrom` when no boundary was
 * declared -- it uses `.complete` only; `.message` is carry-chain-specific
 * wording and not meaningful outside this module.
 */
export function evaluateHistoryCompleteness(
  historyCompleteFrom: string | null,
  earliestFyStartDate: string,
): { complete: boolean; message: string | null } {
  if (historyCompleteFrom === null) {
    return {
      complete: false,
      message:
        "Carried capital-loss figures may be incomplete -- this portfolio " +
        "has no declared history-completeness date, so prior losses before " +
        "your earliest recorded disposal are unknown.",
    };
  }
  if (!DATE_PATTERN.test(historyCompleteFrom)) {
    return {
      complete: false,
      message:
        "Carried capital-loss figures may be incomplete -- the declared " +
        "history-completeness date for this portfolio is unreadable, so " +
        "prior losses before your earliest recorded disposal are unknown.",
    };
  }
  if (historyCompleteFrom <= earliestFyStartDate) {
    return { complete: true, message: null };
  }
  return {
    complete: false,
    message:
      `Carried capital-loss figures may be incomplete -- prior losses ` +
      `before ${historyCompleteFrom} are unknown.`,
  };
}

/**
 * Chains `fyTotals` (`computeFyCapitalGainsTotals`'s per-FY output, any
 * order) from the earliest disposal FY forward, applying each FY's
 * carried-in loss AFTER that FY's own current-year losses and BEFORE its
 * discount, per the ruling above. Pure and total: an empty `fyTotals` list
 * returns an empty, vacuously-complete chain rather than throwing (mirrors
 * `computeLifetimeCapitalGainsTotal`'s empty-list contract).
 *
 * Duplicate-year contract (reviewer follow-up, cheap robustness):
 * `computeFyCapitalGainsTotals` never produces two entries with the same
 * `endingYear` by construction, so this "should not happen" for any caller
 * following that contract -- but this function accepts a bare array from
 * any caller, so it stays total rather than throwing on a malformed input.
 * DOCUMENTED FIRST-WINS: if `fyTotals` DOES contain more than one entry for
 * the same `endingYear`, only the FIRST one encountered (by original array
 * order, which stable-sorting into `ascending` preserves for equal years)
 * is chained; later duplicates are dropped from the chain but every
 * original entry still gets a `perFy` row (mapped back onto that same
 * first-wins carried result), so `perFy.length === fyTotals.length` always
 * holds.
 */
export function computeCapitalGainsCarryChain(
  fyTotals: readonly FyCapitalGainsTotal[],
  historyCompleteFrom: string | null,
): CapitalGainsCarryChainResult {
  if (fyTotals.length === 0) {
    return {
      historyComplete: true,
      historyIncompleteMessage: null,
      earliestFyStartDate: null,
      perFy: [],
      lifetimeNetCapitalGainEstimateDecimal: "0",
      lifetimeNetPartial: false,
      finalCarryOutLossDecimal: "0",
    };
  }

  const ascending = [...fyTotals].sort(
    (left, right) => left.endingYear - right.endingYear,
  );
  // Documented first-wins de-duplication -- see this function's header.
  // Stable-sort preserves each duplicate year's original relative order,
  // so "first" here is unambiguous regardless of how `fyTotals` was
  // ordered on entry.
  const seenYears = new Set<number>();
  const dedupedAscending = ascending.filter((fy) => {
    if (seenYears.has(fy.endingYear)) return false;
    seenYears.add(fy.endingYear);
    return true;
  });
  const earliestFyStartDate = dedupedAscending[0]!.window.startDate;
  const { complete: historyComplete, message: historyIncompleteMessage } =
    evaluateHistoryCompleteness(historyCompleteFrom, earliestFyStartDate);

  const discountRate = parseDecimal(CGT_INDIVIDUAL_DISCOUNT_RATE);
  const byEndingYear = new Map<number, FyCarriedCapitalGains>();

  let carryIn = ZERO;
  let runningTaint = !historyComplete;

  for (const fy of dedupedAscending) {
    const carriedFiguresPartial = runningTaint || fy.partialCoverage;
    runningTaint = carriedFiguresPartial;

    const remainingNonDiscountable = parseDecimalResult(
      fy.remainingNonDiscountableAfterLossDecimal,
    );
    const remainingDiscountable = parseDecimalResult(
      fy.remainingDiscountableAfterLossDecimal,
    );

    const carryInAppliedToNonDiscountable = minDecimal(
      carryIn,
      remainingNonDiscountable,
    );
    const afterNonDiscountable = subtractDecimal(
      remainingNonDiscountable,
      carryInAppliedToNonDiscountable,
    );
    const carryInRemainingAfterNonDiscountable = subtractDecimal(
      carryIn,
      carryInAppliedToNonDiscountable,
    );

    const carryInAppliedToDiscountable = minDecimal(
      carryInRemainingAfterNonDiscountable,
      remainingDiscountable,
    );
    const afterDiscountable = subtractDecimal(
      remainingDiscountable,
      carryInAppliedToDiscountable,
    );
    const carryInUnapplied = subtractDecimal(
      carryInRemainingAfterNonDiscountable,
      carryInAppliedToDiscountable,
    );

    const discountApplied = multiplyDecimal(afterDiscountable, discountRate);
    const discountedRemainingDiscountable = subtractDecimal(
      afterDiscountable,
      discountApplied,
    );
    const netCapitalGainEstimate = addDecimal(
      afterNonDiscountable,
      discountedRemainingDiscountable,
    );

    const ownUnabsorbedLoss = parseDecimalResult(fy.unabsorbedLossDecimal);
    const carryOut = addDecimal(ownUnabsorbedLoss, carryInUnapplied);

    byEndingYear.set(fy.endingYear, {
      endingYear: fy.endingYear,
      carryInLossDecimal: formatDecimalExact(carryIn),
      carryInAppliedToNonDiscountableDecimal: formatDecimalExact(
        carryInAppliedToNonDiscountable,
      ),
      carryInAppliedToDiscountableDecimal: formatDecimalExact(
        carryInAppliedToDiscountable,
      ),
      carryInAppliedDecimal: formatDecimalExact(
        addDecimal(
          carryInAppliedToNonDiscountable,
          carryInAppliedToDiscountable,
        ),
      ),
      remainingDiscountableAfterCarryInDecimal:
        formatDecimalExact(afterDiscountable),
      discountAppliedDecimal: formatDecimalExact(discountApplied),
      netCapitalGainEstimateDecimal: formatDecimalExact(netCapitalGainEstimate),
      carryOutLossDecimal: formatDecimalExact(carryOut),
      ownPartialCoverage: fy.partialCoverage,
      carriedFiguresPartial,
    });

    carryIn = carryOut;
  }

  const perFy = fyTotals.map((fy) => byEndingYear.get(fy.endingYear)!);
  const lifetimeNetCapitalGainEstimate = perFy.reduce<DecimalFraction>(
    (total, fy) =>
      addDecimal(total, parseDecimalResult(fy.netCapitalGainEstimateDecimal)),
    ZERO,
  );
  const mostRecent = dedupedAscending[dedupedAscending.length - 1]!;
  const mostRecentCarried = byEndingYear.get(mostRecent.endingYear)!;

  return {
    historyComplete,
    historyIncompleteMessage,
    earliestFyStartDate,
    perFy,
    lifetimeNetCapitalGainEstimateDecimal: formatDecimalExact(
      lifetimeNetCapitalGainEstimate,
    ),
    lifetimeNetPartial: mostRecentCarried.carriedFiguresPartial,
    finalCarryOutLossDecimal: mostRecentCarried.carryOutLossDecimal,
  };
}
