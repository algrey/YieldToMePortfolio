/**
 * UI-018: pure, framework-free window/derivation helpers for the per-holding
 * price-history chart. Deliberately mirrors the existing FY/range-helper
 * split (`app/overview-range.ts`, `app/overview-fy-range.ts`,
 * `domain/calculations/financial-year.ts`) so the actual boundary math is
 * shared rather than re-invented: this module only composes those existing
 * pieces plus the small amount of NEW calendar math (day/week subtraction)
 * this chart's range set needs that nothing else already exports.
 *
 * Kept DB-free and pure so window derivation, the per-date provider
 * selection rule, and server-side downsampling can all be unit-tested
 * directly, without a database, under the plain node test runner.
 */
import type { FyWindowResult } from "../domain/calculations/financial-year.ts";
import { subtractCalendarMonths } from "./overview-range.ts";

export type PriceHistoryRange =
  "day" | "week" | "month" | "ytd" | "fy" | "year" | "5y" | "all";

/** Exact order the range buttons render in (TASKS.md UI-018 ruling). */
export const PRICE_HISTORY_RANGES: readonly PriceHistoryRange[] = [
  "day",
  "week",
  "month",
  "ytd",
  "fy",
  "year",
  "5y",
  "all",
];

/** Owner directive: the dialog opens on "Year" by default. */
export const DEFAULT_PRICE_HISTORY_RANGE: PriceHistoryRange = "year";

/** Server-side downsampling cap (TASKS.md UI-018 ruling: "e.g. <=400"). */
export const MAX_PRICE_HISTORY_POINTS = 400;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses the route's `?range=` value, degrading an absent/unrecognised
 * value to the default rather than erroring -- mirrors
 * `app/dividend-list-query.ts`'s `parseDividendListFilter` clamp-not-crash
 * convention. `invalidRangeRequested` lets the caller disclose the
 * fallback honestly instead of silently ignoring a bad link.
 */
export function parsePriceHistoryRangeParam(value: string | null): {
  range: PriceHistoryRange;
  invalidRangeRequested: boolean;
} {
  if (
    value !== null &&
    (PRICE_HISTORY_RANGES as readonly string[]).includes(value)
  ) {
    return { range: value as PriceHistoryRange, invalidRangeRequested: false };
  }
  return {
    range: DEFAULT_PRICE_HISTORY_RANGE,
    invalidRangeRequested: value !== null,
  };
}

/**
 * Calendar-month subtraction with day-of-month clamping (e.g. 31 Mar minus
 * one month is 28/29 Feb, never a rolled-over 3 Mar). Operates purely on
 * calendar-date strings already resolved to the portfolio's local timezone
 * by the caller -- no further timezone conversion happens here, so this is
 * safe to reuse for the "month"/"year"/"5y" ranges without re-deriving
 * `app/overview-range.ts`'s existing `subtractCalendarMonths` (kept as a
 * separate re-export below rather than a duplicate implementation).
 */
export { subtractCalendarMonths };

/** Calendar-day subtraction on a local calendar-date string. No existing
 * helper covers this (the FY/overview helpers only ever subtract months),
 * so it is new, small, and pure. */
export function subtractCalendarDays(date: string, days: number): string {
  const match = DATE_PATTERN.exec(date);
  if (!match) return date;
  const [year, month, day] = date.split("-").map(Number);
  const ms = Date.UTC(year!, month! - 1, day!) - days * 86_400_000;
  const result = new Date(ms);
  return `${String(result.getUTCFullYear()).padStart(4, "0")}-${String(
    result.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(result.getUTCDate()).padStart(2, "0")}`;
}

export type PriceHistoryWindow = Readonly<{
  /** Inclusive lower bound, or `null` for "All" (no lower bound). */
  fromDate: string | null;
  /** Inclusive upper bound -- always "today" in the portfolio's timezone. */
  toDate: string;
}>;

/**
 * Resolves a range button to a `[fromDate, toDate]` calendar window, given
 * "today" already resolved to the portfolio's local timezone.
 *
 * Window choices (TASKS.md UI-018 ruling: "Windows anchor on the portfolio
 * timezone; FY uses the owner's financial-year start month; YTD = calendar
 * year"):
 * - day: today only (the loader separately supplements this with the
 *   nearest earlier observation for "previous close" context -- see
 *   `app/owned-price-history.ts`'s doc comment; this function only derives
 *   the calendar window, not that supplemental fetch).
 * - week: the trailing 7 calendar days (today - 6 .. today).
 * - month/year/5y: the trailing calendar month/year/5-years via the shared
 *   `subtractCalendarMonths` (1/12/60 months back), day-of-month clamped.
 * - ytd: 1 Jan of the current local year through today.
 * - fy: the FY-to-date window from `currentFyWindow`
 *   (`domain/calculations/financial-year.ts`), passed in already-resolved
 *   as `fyResult` so this module never re-derives FY boundary math itself.
 *   An unresolved/invalid FY setting degrades to the YTD window rather
 *   than failing the whole chart -- documented, not silent: the loader
 *   only takes this path when `currentFyWindow` itself returned `ok:
 *   false`, which given a valid per-user `financial_year_start_month`
 *   CHECK constraint and a portfolio row that already resolved a valid
 *   timezone (both verified before this function is called) should not be
 *   reachable in production; it exists purely as a documented fail-safe.
 * - all: no lower bound -- every observation up to today.
 */
export function priceHistoryWindow(
  range: PriceHistoryRange,
  today: string,
  fyResult: FyWindowResult | null,
): PriceHistoryWindow {
  switch (range) {
    case "day":
      return { fromDate: today, toDate: today };
    case "week":
      return { fromDate: subtractCalendarDays(today, 6), toDate: today };
    case "month":
      return { fromDate: subtractCalendarMonths(today, 1), toDate: today };
    case "ytd":
      return { fromDate: `${today.slice(0, 4)}-01-01`, toDate: today };
    case "fy":
      if (fyResult && fyResult.ok) {
        return { fromDate: fyResult.window.startDate, toDate: today };
      }
      return { fromDate: `${today.slice(0, 4)}-01-01`, toDate: today };
    case "year":
      return { fromDate: subtractCalendarMonths(today, 12), toDate: today };
    case "5y":
      return { fromDate: subtractCalendarMonths(today, 60), toDate: today };
    case "all":
      return { fromDate: null, toDate: today };
  }
}

export type RawPricePoint = Readonly<{
  marketDate: string;
  priceDecimal: string;
  currencyCode: string;
  providerId: string;
  interval: "eod" | "delayed" | "intraday";
  observationAt: string;
}>;

/**
 * Per-market-date provider selection ("the per-date winner rule" TASKS.md
 * UI-018 asks for, "the EXISTING ranking or a documented simpler rule").
 * DOCUMENTED CHOICE: rather than importing `domain/market-data/selection.ts`'s
 * internal `providerRank` (not exported, and designed for a single
 * as-of-date fallback-window selection with overrides -- a materially
 * different problem from reducing a whole multi-year series to one point
 * per date), this reuses only its DIRECTIONAL intent -- an end-of-day close
 * is preferred over a delayed intraday quote for a HISTORY chart -- as a
 * small standalone rule:
 *   1. `eod` beats everything else (a real closing price for that date).
 *   2. Otherwise, the most recently observed row wins (`observationAt`
 *      descending) -- e.g. a `delayed` Sharesight quote beats an older
 *      `intraday` row for the same date.
 *   3. Ties (identical `observationAt`) break on `providerId` DESCENDING --
 *      the LEXICOGRAPHICALLY GREATEST id wins (review round-1 fix, B2: an
 *      earlier version of this comment said "ascending", which was simply
 *      wrong -- `isBetterDailyCandidate` replaces the stored candidate
 *      whenever `candidate.providerId > current.providerId`, so scanning
 *      all same-`observationAt` rows converges on the maximum, not the
 *      minimum). Purely for determinism; no provider is meant to be
 *      preferred over another by this tie-break.
 * Input does not need to be pre-sorted; output is sorted by `marketDate`
 * ascending (chart/table order).
 */
export function selectDailyWinners(
  rows: readonly RawPricePoint[],
): RawPricePoint[] {
  const byDate = new Map<string, RawPricePoint>();
  for (const row of rows) {
    const existing = byDate.get(row.marketDate);
    if (!existing || isBetterDailyCandidate(row, existing)) {
      byDate.set(row.marketDate, row);
    }
  }
  return [...byDate.values()].sort((left, right) =>
    left.marketDate < right.marketDate
      ? -1
      : left.marketDate > right.marketDate
        ? 1
        : 0,
  );
}

function isBetterDailyCandidate(
  candidate: RawPricePoint,
  current: RawPricePoint,
): boolean {
  const candidateIsEod = candidate.interval === "eod";
  const currentIsEod = current.interval === "eod";
  if (candidateIsEod !== currentIsEod) return candidateIsEod;
  if (candidate.observationAt !== current.observationAt) {
    return candidate.observationAt > current.observationAt;
  }
  return candidate.providerId > current.providerId;
}

export type DownsampleResult = Readonly<{
  points: readonly RawPricePoint[];
  bucketSize: number;
}>;

/**
 * Bounds a chronologically-sorted point series to at most `maxPoints`
 * points via LAST-OBSERVATION-PER-BUCKET (never averaged, never a fabricated
 * interpolated value -- TASKS.md UI-018 ruling). Method, documented:
 * - `bucketSize = ceil(points.length / maxPoints)` consecutive input points
 *   per output point.
 * - Each bucket contributes its OWN last (chronologically latest) point,
 *   verbatim -- an actual observation, never a computed one.
 * - The very last input point is always the last point of the final
 *   bucket, so the series' latest fact is never dropped.
 * A no-op (bucketSize 1, all points returned) when already within budget.
 */
export function downsamplePriceHistoryPoints(
  points: readonly RawPricePoint[],
  maxPoints = MAX_PRICE_HISTORY_POINTS,
): DownsampleResult {
  if (points.length <= maxPoints || maxPoints < 1) {
    return { points: [...points], bucketSize: 1 };
  }
  const bucketSize = Math.ceil(points.length / maxPoints);
  const sampled: RawPricePoint[] = [];
  for (let start = 0; start < points.length; start += bucketSize) {
    const end = Math.min(start + bucketSize, points.length);
    sampled.push(points[end - 1]!);
  }
  return { points: sampled, bucketSize };
}
