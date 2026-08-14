// CGT-001A: per-financial-year realised capital gains aggregation over an
// already-derived disposal row list (`deriveCapitalGainDisposalRow`'s
// output, `disposal-rows.ts`). Every amount here is the portfolio's BASE
// currency (see `disposal-rows.ts`'s header) so, unlike
// `domain/dividends/aggregations.ts`, there is no per-security/native-
// currency scope boundary: totals are portfolio-wide.
//
// Orchestrator ruling (TASKS.md CGT-001A, BINDING) -- per-FY method:
//
//   1. Split this FY's COMPLETE-basis disposal rows into three buckets by
//      sign and discount eligibility: discountable gains (gain > 0, held
//      >12 months), non-discountable gains (gain > 0, held <=12 months),
//      and losses (gain < 0, summed as a positive magnitude).
//   2. Offset losses against gains BEFORE any discount, non-discountable
//      gains FIRST (the standard optimal-for-the-taxpayer default -- using
//      up the never-discountable gain with the loss preserves as much
//      discountable gain as possible), THEN any remaining loss against
//      discountable gains.
//   3. Apply the 50% individual discount (`CGT_INDIVIDUAL_DISCOUNT_RATE`,
//      `eligibility.ts`) to whatever discountable amount remains AFTER
//      step 2 -- never to the gross discountable total.
//   4. Net capital gain estimate = remaining non-discountable (after loss)
//      + the discounted remaining discountable amount.
//
// If losses exceed total gains for the year, every bucket is fully
// absorbed (both "remaining after loss" amounts are 0, so the net capital
// gain estimate is 0 -- there is no such thing as a negative taxable
// capital gain) and the excess is surfaced separately as
// `unabsorbedLossDecimal`. This module reports each FY STANDALONE, with no
// prior/future-year application of its own -- as of CGT-002,
// `domain/gains/carry-forward.ts`'s `computeCapitalGainsCarryChain` consumes
// this FY-by-FY output to chain `unabsorbedLossDecimal` forward across
// financial years. The two figures
// serve different, both-honest purposes: THIS module's
// `netCapitalGainEstimateDecimal`/`unabsorbedLossDecimal` are what this FY
// looked like entirely on its own; the carry module's figures are the TRUE
// carried totals once prior-year losses are applied. See
// `CGT_CARRY_FORWARD_NOTE` (`carry-forward.ts`) for the standing disclosure
// callers surface verbatim wherever a carried figure is displayed.
//
// Incomplete-basis disclosure: a row whose `basisStatus` is not
// `'complete'`, OR whose `gainDecimal` is `null` for any reason (so its
// gain is genuinely unknown -- see `disposal-rows.ts` and `hasKnownGain`
// below), is NEVER folded into any total as a zero. It is excluded from
// every sum, counted in `excludedIncompleteCount`, and its security named
// in `excludedIncompleteSecurityNames` so the FY total visibly discloses
// partial coverage rather than silently under-stating gains/losses.
//
// This is an INFORMATIONAL ESTIMATE ONLY -- NOT TAX ADVICE. See
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
import { fyWindowForDate } from "../dividends/fy-window.ts";
import type { FyWindow } from "../calculations/financial-year.ts";
import { CGT_INDIVIDUAL_DISCOUNT_RATE } from "./eligibility.ts";
import type { CapitalGainDisposalRow } from "./disposal-rows.ts";

const ZERO = fromInteger(0n);

/** Per-figure method labels, echoed alongside the totals so a consumer never has to infer the ordering rule from the numbers alone. */
export const CGT_METHOD_LABELS = {
  discountableGains:
    "Sum of realised gains on allocations held for more than 12 months, before losses are offset and before the 50% discount.",
  nonDiscountableGains:
    "Sum of realised gains on allocations held for 12 months or less -- never eligible for the discount.",
  losses:
    "Sum of realised losses this financial year, applied against non-discountable gains first, then discountable gains, before any discount.",
  netCapitalGainEstimate:
    "Non-discountable gains remaining after losses, plus 50% of the discountable gains remaining after losses. Informational estimate only -- not tax advice.",
} as const;

function sumDecimals(values: readonly string[]): DecimalFraction {
  return values.reduce<DecimalFraction>(
    (total, value) => addDecimal(total, parseDecimalResult(value)),
    ZERO,
  );
}

function minDecimal(
  left: DecimalFraction,
  right: DecimalFraction,
): DecimalFraction {
  return compareDecimal(left, right) <= 0 ? left : right;
}

/**
 * Reviewer fix (round 2): the contract between `disposal-rows.ts` and this
 * module is `basisStatus === 'complete'` <=> `gainDecimal !== null`, but
 * `CapitalGainDisposalRow` itself doesn't structurally enforce that (both
 * fields are independently settable), and a schema-permitted row CAN carry
 * `basisStatus: 'complete'` with a `null` gain (e.g. a hand-built row, or a
 * future caller that doesn't route through `deriveCapitalGainDisposalRow`).
 * Bucketing on `basisStatus` alone then fed a `null` straight into
 * `parseDecimalResult`, throwing an opaque "Invalid decimal string." deep
 * inside this function instead of disclosing the row as incomplete. This
 * type-predicate bucketing checks BOTH fields, so any row with an unknown
 * gain -- regardless of why -- is treated as incomplete/excluded rather
 * than crashing.
 */
function hasKnownGain(
  row: CapitalGainDisposalRow,
): row is CapitalGainDisposalRow & { gainDecimal: string } {
  return row.basisStatus === "complete" && row.gainDecimal !== null;
}

export type FyCapitalGainsTotal = {
  endingYear: number;
  label: string;
  window: FyWindow;
  /** Every disposal row attributed to this FY, complete and incomplete alike, for a per-disposal detail view. */
  rows: CapitalGainDisposalRow[];
  disposalCount: number;
  excludedIncompleteCount: number;
  /** Sorted, de-duplicated security names with at least one incomplete-basis row this FY. */
  excludedIncompleteSecurityNames: string[];
  partialCoverage: boolean;
  totalDiscountableGainsGrossDecimal: string;
  totalNonDiscountableGainsGrossDecimal: string;
  /** Positive magnitude (losses summed, then negated once). */
  totalLossesDecimal: string;
  lossAppliedToNonDiscountableDecimal: string;
  lossAppliedToDiscountableDecimal: string;
  remainingNonDiscountableAfterLossDecimal: string;
  remainingDiscountableAfterLossDecimal: string;
  discountRateDecimal: string;
  discountAppliedDecimal: string;
  /** Always >= 0 -- there is no negative taxable capital gain; see `unabsorbedLossDecimal` when losses exceed gains. */
  netCapitalGainEstimateDecimal: string;
  /** > 0 only when this FY's losses exceed its gains, standalone; see `domain/gains/carry-forward.ts` for the chained (carried-forward) figure this feeds into. */
  unabsorbedLossDecimal: string;
};

export type ComputeFyCapitalGainsTotalsResult =
  | { ok: true; totals: FyCapitalGainsTotal[] }
  | { ok: false; reason: "invalid_start_month" | "invalid_date" };

/**
 * Groups `rows` (already-derived per-disposal rows, ANY security, all in
 * the portfolio's base currency) into per-FY totals using the ordering
 * rule documented above. A financial year with zero disposal rows is
 * simply not returned (no fabricated zero year), mirroring
 * `domain/dividends/aggregations.ts`'s `computeFyDividendTotals`.
 */
export function computeFyCapitalGainsTotals(
  rows: readonly CapitalGainDisposalRow[],
  startMonth: number,
): ComputeFyCapitalGainsTotalsResult {
  const byYear = new Map<number, CapitalGainDisposalRow[]>();
  const sharedWindow: {
    endingYear: number;
    window: FyWindow;
    label: string;
  }[] = [];
  for (const row of rows) {
    const resolved = fyWindowForDate(row.disposedDate, startMonth);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const list = byYear.get(resolved.endingYear) ?? [];
    list.push(row);
    byYear.set(resolved.endingYear, list);
    if (
      !sharedWindow.some((entry) => entry.endingYear === resolved.endingYear)
    ) {
      sharedWindow.push({
        endingYear: resolved.endingYear,
        window: resolved.window,
        label: resolved.label,
      });
    }
  }
  const windowByYear = new Map(
    sharedWindow.map((entry) => [entry.endingYear, entry]),
  );

  const totals: FyCapitalGainsTotal[] = [];
  for (const [endingYear, yearRows] of byYear) {
    const complete = yearRows.filter(hasKnownGain);
    const incomplete = yearRows.filter((row) => !hasKnownGain(row));

    const gainRows = complete.filter(
      (row) => compareDecimal(parseDecimalResult(row.gainDecimal), ZERO) > 0,
    );
    const lossRows = complete.filter(
      (row) => compareDecimal(parseDecimalResult(row.gainDecimal), ZERO) < 0,
    );
    const discountable = gainRows.filter(
      (row) => row.holdingPeriodEligible === true,
    );
    const nonDiscountable = gainRows.filter(
      (row) => row.holdingPeriodEligible !== true,
    );

    const discountableGainsGross = sumDecimals(
      discountable.map((row) => row.gainDecimal),
    );
    const nonDiscountableGainsGross = sumDecimals(
      nonDiscountable.map((row) => row.gainDecimal),
    );
    // Loss rows carry a negative gainDecimal; sum them, then negate ONCE to
    // get a positive magnitude (never sum absolute values row-by-row,
    // which would round differently under a different scale per row).
    const lossesMagnitude = subtractDecimal(
      ZERO,
      sumDecimals(lossRows.map((row) => row.gainDecimal)),
    );

    const lossAppliedToNonDiscountable = minDecimal(
      lossesMagnitude,
      nonDiscountableGainsGross,
    );
    const remainingNonDiscountable = subtractDecimal(
      nonDiscountableGainsGross,
      lossAppliedToNonDiscountable,
    );
    const lossRemainingAfterNonDiscountable = subtractDecimal(
      lossesMagnitude,
      lossAppliedToNonDiscountable,
    );

    const lossAppliedToDiscountable = minDecimal(
      lossRemainingAfterNonDiscountable,
      discountableGainsGross,
    );
    const remainingDiscountable = subtractDecimal(
      discountableGainsGross,
      lossAppliedToDiscountable,
    );
    const unabsorbedLoss = subtractDecimal(
      lossRemainingAfterNonDiscountable,
      lossAppliedToDiscountable,
    );

    const discountRate = parseDecimal(CGT_INDIVIDUAL_DISCOUNT_RATE);
    const discountApplied = multiplyDecimal(
      remainingDiscountable,
      discountRate,
    );
    const discountedRemainingDiscountable = subtractDecimal(
      remainingDiscountable,
      discountApplied,
    );
    const netCapitalGainEstimate = addDecimal(
      remainingNonDiscountable,
      discountedRemainingDiscountable,
    );

    const excludedIncompleteSecurityNames = [
      ...new Set(incomplete.map((row) => row.securityName)),
    ].sort((left, right) => left.localeCompare(right));

    const windowEntry = windowByYear.get(endingYear)!;
    totals.push({
      endingYear,
      label: windowEntry.label,
      window: windowEntry.window,
      rows: yearRows,
      disposalCount: yearRows.length,
      excludedIncompleteCount: incomplete.length,
      excludedIncompleteSecurityNames,
      partialCoverage: incomplete.length > 0,
      totalDiscountableGainsGrossDecimal: formatDecimalExact(
        discountableGainsGross,
      ),
      totalNonDiscountableGainsGrossDecimal: formatDecimalExact(
        nonDiscountableGainsGross,
      ),
      totalLossesDecimal: formatDecimalExact(lossesMagnitude),
      lossAppliedToNonDiscountableDecimal: formatDecimalExact(
        lossAppliedToNonDiscountable,
      ),
      lossAppliedToDiscountableDecimal: formatDecimalExact(
        lossAppliedToDiscountable,
      ),
      remainingNonDiscountableAfterLossDecimal: formatDecimalExact(
        remainingNonDiscountable,
      ),
      remainingDiscountableAfterLossDecimal: formatDecimalExact(
        remainingDiscountable,
      ),
      discountRateDecimal: CGT_INDIVIDUAL_DISCOUNT_RATE,
      discountAppliedDecimal: formatDecimalExact(discountApplied),
      netCapitalGainEstimateDecimal: formatDecimalExact(netCapitalGainEstimate),
      unabsorbedLossDecimal: formatDecimalExact(unabsorbedLoss),
    });
  }

  totals.sort((left, right) => right.endingYear - left.endingYear);
  return { ok: true, totals };
}
