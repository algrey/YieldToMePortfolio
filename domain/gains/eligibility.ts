// CGT-001A: capital gains discount (individual) eligibility.
//
// Informational estimate only -- NOT tax advice. See
// `docs/CALCULATIONS.md` section 14 for the full disclosure and the
// `domain/dividends/franking.ts` `AU_COMPANY_TAX_RATE` precedent this
// module follows for naming/documenting a stated ATO-adjacent constant.
//
// ATO discount-eligibility rule: an asset must be held for STRICTLY MORE
// THAN 12 months before disposal (12 months + at least one day). Disposing
// on the exact same day-of-month one year later is NOT eligible -- the
// asset must be held into at least the following day.
//
// This module implements the test using CALENDAR-MONTH arithmetic (adding
// exactly 12 months to the acquisition date), not day-counting, per the
// Orchestrator ruling (TASKS.md CGT-001A). Adding 12 months to any date is
// equivalent to incrementing the year and keeping the same month/day,
// EXCEPT for 29 February acquisitions when the destination year is not a
// leap year (the only day-of-month/month combination that can go out of
// range from a whole-year shift). Date-rolling convention for that one
// edge case: CLAMP DOWN to the last valid day of the destination month --
// 29 Feb 2024 + 12 months = 28 Feb 2025 (never 1 Mar 2025, which is what
// JavaScript's `Date` object would silently roll over to via
// `setFullYear`). This mirrors the clamp-down convention
// `domain/calculations/financial-year.ts` already uses for FY-window
// month-end arithmetic rather than introducing a second, divergent date
// convention.
//
// Eligibility is then: disposal date STRICTLY AFTER (acquisition date + 12
// months). Note eligibility is a pure function of the acquisition and
// disposal dates -- it does not depend on whether the allocation's basis
// amount is known (`basisStatus`), so it stays computable even for
// incomplete-basis allocations; `domain/gains/disposal-rows.ts` decides
// how that combines with an unknown gain/loss for the row's display label.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Standard Australian individual CGT discount rate (50%), applied to the
 * discountable portion of a net capital gain after losses are offset. Named
 * and documented rather than inlined, mirroring `AU_COMPANY_TAX_RATE`'s
 * precedent, so its provenance stays visible at every call site and in
 * `docs/CALCULATIONS.md`. This is arithmetic from a stated, named
 * assumption, not tax advice -- entities other than individuals (e.g.
 * complying superannuation funds at 33.33%, companies with no discount)
 * are NOT modelled in v1.
 */
export const CGT_INDIVIDUAL_DISCOUNT_RATE = "0.50";

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const thirtyOneDayMonths = new Set([1, 3, 5, 7, 8, 10, 12]);
  if (thirtyOneDayMonths.has(month)) return 31;
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return 30;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

function isValidCalendarDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

/**
 * `date` plus exactly 12 months, using the clamp-down convention described
 * in this module's header. Assumes `date` is already a validated
 * `YYYY-MM-DD` calendar date.
 */
export function addTwelveMonths(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const nextYear = year + 1;
  const clampedDay = Math.min(day, daysInMonth(nextYear, month));
  return `${pad4(nextYear)}-${pad2(month)}-${pad2(clampedDay)}`;
}

export type DiscountEligibilityResult =
  | { ok: true; eligible: boolean; thresholdDate: string }
  | {
      ok: false;
      reason: "invalid_acquired_date" | "invalid_disposed_date";
    };

/**
 * Whether a disposal held from `acquiredDate` through `disposedDate` (both
 * plain `YYYY-MM-DD` local calendar dates -- business dates, not instants)
 * is eligible for the individual CGT discount: STRICTLY more than 12
 * months held. `thresholdDate` (acquisition + 12 months) is returned for
 * explanation/audit purposes; eligibility is `disposedDate > thresholdDate`
 * (a same-date-one-year-later disposal is exactly AT the threshold and is
 * NOT eligible).
 */
export function evaluateDiscountEligibility(
  acquiredDate: string,
  disposedDate: string,
): DiscountEligibilityResult {
  if (!isValidCalendarDate(acquiredDate)) {
    return { ok: false, reason: "invalid_acquired_date" };
  }
  if (!isValidCalendarDate(disposedDate)) {
    return { ok: false, reason: "invalid_disposed_date" };
  }
  const thresholdDate = addTwelveMonths(acquiredDate);
  return { ok: true, eligible: disposedDate > thresholdDate, thresholdDate };
}
