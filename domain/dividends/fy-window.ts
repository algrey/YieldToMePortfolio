// DIV-001: financial-year attribution for dividend history rows.
//
// `domain/calculations/financial-year.ts` (FY-001A) only exposes the
// CURRENT and LAST FY windows relative to "now" -- per-FY dividend totals
// need the FY window containing an arbitrary PAST calendar date (a
// dividend's payment date or ex-date), for however many years of history
// exist. This module adds that one missing piece using the identical,
// already-reviewed boundary math (`today.month >= startMonth ? today.year
// : today.year - 1`, `FyWindow`'s ending-year label convention) rather than
// reimplementing it differently.
//
// Deliberately simpler than `financial-year.ts`'s `localDateAt`: FY-001A
// resolves an INSTANT to a local calendar date because "now" is ambiguous
// without a timezone. A dividend's payment/ex-date is already a fixed
// business-date fact (`YYYY-MM-DD`, no time component) recorded by the
// provider/owner -- there is no instant-to-local-date conversion to do, so
// no timezone parameter is threaded through here. (Aggregation still uses
// the user's FY start month, which IS a per-user setting.)
import {
  fyLabel,
  isValidFinancialYearStartMonth,
  type FyWindow,
} from "../calculations/financial-year.ts";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type FyWindowForDateResult =
  | { ok: true; window: FyWindow; endingYear: number; label: string }
  | { ok: false; reason: "invalid_start_month" | "invalid_date" };

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
function pad4(value: number): string {
  return String(value).padStart(4, "0");
}
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function dayBeforeFirstOfMonth(year: number, month: number): string {
  if (month === 1) return `${pad4(year - 1)}-12-31`;
  const previousMonth = month - 1;
  return `${pad4(year)}-${pad2(previousMonth)}-${pad2(daysInMonth(year, previousMonth))}`;
}
function addOneYear(dateOnMonthDay1: string): string {
  const [year, month] = dateOnMonthDay1.split("-").map(Number);
  return `${pad4(year + 1)}-${pad2(month)}-01`;
}

/**
 * The FY window (and its FYnn label/ending year) containing `date`, a plain
 * `YYYY-MM-DD` calendar date -- no timezone/instant resolution, see the
 * module header.
 */
export function fyWindowForDate(
  date: string,
  startMonth: number,
): FyWindowForDateResult {
  if (!isValidFinancialYearStartMonth(startMonth)) {
    return { ok: false, reason: "invalid_start_month" };
  }
  if (!DATE_PATTERN.test(date)) {
    return { ok: false, reason: "invalid_date" };
  }
  const [year, month] = date.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    return { ok: false, reason: "invalid_date" };
  }
  const startYear = month >= startMonth ? year : year - 1;
  const startDate = `${pad4(startYear)}-${pad2(startMonth)}-01`;
  const nextStartDate = addOneYear(startDate);
  const [nextYear, nextMonth] = nextStartDate.split("-").map(Number);
  const endDate = dayBeforeFirstOfMonth(nextYear, nextMonth);
  const window: FyWindow = { startDate, endDate };
  return {
    ok: true,
    window,
    endingYear: startMonth === 1 ? startYear : startYear + 1,
    label: fyLabel(window),
  };
}

/**
 * The FY window (and label) for a given ENDING year -- the inverse of
 * `fyWindowForDate` (which finds the window containing an arbitrary date).
 * UI-017: the dividend list route's `?fy=<endingYear>` filter already knows
 * WHICH FY it wants (a route parameter, not a date to classify), so it
 * needs this direction instead. Reuses `fyWindowForDate`'s own boundary
 * math (rather than re-deriving start/end dates independently) by
 * constructing that FY's own start date and asking which window it falls
 * in -- by definition, itself.
 */
export function fyWindowForEndingYear(
  endingYear: number,
  startMonth: number,
): FyWindowForDateResult {
  if (!isValidFinancialYearStartMonth(startMonth)) {
    return { ok: false, reason: "invalid_start_month" };
  }
  if (!Number.isInteger(endingYear)) {
    return { ok: false, reason: "invalid_date" };
  }
  const startYear = startMonth === 1 ? endingYear : endingYear - 1;
  const anchorDate = `${pad4(startYear)}-${pad2(startMonth)}-01`;
  return fyWindowForDate(anchorDate, startMonth);
}
