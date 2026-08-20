// UI-017: pure, server-parsed query-parameter handling for the dividend
// list route (`/portfolio/:id/income/dividends`)'s `?fy=<endingYear>` /
// `?window=next12` filters, plus the pure row-filtering functions
// themselves. Split out of `app/owned-dividend-list.ts` (which owns
// SqlClient access) so this can be tested directly under the plain
// `node --experimental-strip-types` test runner without a DB -- mirrors
// `income-year-range.ts`'s precedent for the multi-year route's own query
// parameters.
//
// Read-only, no derivation changes: every function here only DECIDES which
// already-derived `OwnedDividendListRow`s to show, never computes a new
// money/date fact.
import { fyWindowForEndingYear } from "../domain/dividends/index.ts";
import type { FyWindow } from "../domain/calculations/financial-year.ts";
import type { OwnedDividendListRow } from "./owned-dividend-list.ts";

/** Lower sanity bound for a hand-edited `?fy=` value -- not a real product
 * constraint (no portfolio's data predates this), just a defence against
 * nonsense input reaching the filter as a "valid" year. */
export const MIN_FY_ENDING_YEAR = 1970;

/** Strict 4-digit year only -- reviewer finding (round 1): a lenient
 * `Number.parseInt` accepts "2025abc" (truncates the suffix) and "2025.9"
 * (truncates the fraction), silently REINTERPRETING a malformed value as a
 * different one the caller never typed, rather than degrading it to the
 * honest fallback. `" 2025"` is also rejected -- `parseInt` tolerates
 * leading whitespace, this filter doesn't. */
const STRICT_FY_PATTERN = /^\d{4}$/;

/** The `?window=next12` PAID leg is capped to this many days from "today" --
 * reviewer finding (round 1): an uncapped paid-leg query could in principle
 * surface a payment far beyond any reasonable "next 12 months" reading,
 * overclaiming what the heading promises. Declared/pending (`notPaid`) rows
 * stay UNCAPPED -- they are already-known future claims, not a forecast, so
 * there is no honesty reason to hide one due for payment more than a year
 * out. */
export const NEXT12_PAID_WINDOW_DAYS = 365;

export type DividendListFilter =
  | {
      mode: "all";
      /** True when an `?fy=` value WAS supplied but was unparseable or out
       * of range -- the page falls back to the honest all-years view but
       * discloses that the requested year could not be shown, rather than
       * silently ignoring the request. */
      invalidFyRequested: boolean;
    }
  | {
      mode: "fy";
      endingYear: number;
      /** "FY25" etc, from the same `fyLabel` helper every other FY surface uses. */
      label: string;
      window: FyWindow;
    }
  | { mode: "next12" };

/**
 * Parses the route's `?fy=`/`?window=` query parameters into a typed
 * filter, given the current calendar year (for clamping) and the
 * portfolio owner's FY start month (FY-001A).
 *
 * Mutual exclusivity (TASKS.md UI-017 ruling, documented choice): a
 * request carrying BOTH `fy` and `window=next12` is not rejected outright
 * -- `fy` wins, since a malformed/legacy link combining both should still
 * degrade to ONE honest, unambiguous view rather than an error page.
 *
 * An out-of-range/unparseable `fy` NEVER crashes or silently no-ops -- it
 * degrades to the honest "all years" view with `invalidFyRequested: true`
 * so the page can disclose the fallback, mirroring
 * `income-year-range.ts`'s `clampYears` fallback-on-unparseable pattern --
 * except strict, not lenient (see `STRICT_FY_PATTERN`'s doc comment).
 */
export function parseDividendListFilter(
  query: { fy?: string; window?: string },
  currentCalendarYear: number,
  financialYearStartMonth: number,
): DividendListFilter {
  if (query.fy !== undefined) {
    const wellFormed = STRICT_FY_PATTERN.test(query.fy);
    const parsed = wellFormed ? Number.parseInt(query.fy, 10) : NaN;
    const inRange =
      wellFormed &&
      parsed >= MIN_FY_ENDING_YEAR &&
      parsed <= currentCalendarYear + 1;
    if (!inRange) return { mode: "all", invalidFyRequested: true };
    const window = fyWindowForEndingYear(parsed, financialYearStartMonth);
    if (!window.ok) return { mode: "all", invalidFyRequested: true };
    return {
      mode: "fy",
      endingYear: parsed,
      label: window.label,
      window: window.window,
    };
  }
  if (query.window === "next12") return { mode: "next12" };
  return { mode: "all", invalidFyRequested: false };
}

export type FyRowFilterResult = {
  rows: OwnedDividendListRow[];
  /** Count of rows with NEITHER a payment date NOR an ex-date -- the only
   * rows that genuinely cannot be attributed to ANY financial year.
   * Reviewer finding B1 (round 1): this is computed over the FULL
   * (unfiltered) row set, not the current window, and is the SAME number
   * regardless of which `?fy=` was requested -- so the caller must present
   * it as a portfolio-wide fact ("N undated dividends across the
   * portfolio"), never as if it were specific to the requested year. */
  undatedRowCount: number;
};

/**
 * Rows attributed to the FY window (inclusive), for the `?fy=` filter.
 *
 * Reviewer finding B1 (round 1, repro-verified): attribution MUST mirror
 * `computeFyDividendTotals`'s own rule (`domain/dividends/aggregations.ts`,
 * `row.paymentDate ?? row.exDate`) -- a provider-derived row (which never
 * carries a payment date, see `domain/market-data/yahoo-compatible.ts`) is
 * counted into that year's TOTAL via its ex-date, so the drill-through list
 * for that same year must show that same row (via its ex-date), not hide
 * it. Filtering by `paymentDate` alone silently disagreed with the total
 * the owner just clicked -- and mislabelled the row as "cannot be
 * attributed to a financial year" when the aggregation had just attributed
 * it fine.
 *
 * A row with NEITHER date is the only kind that is genuinely
 * unattributable -- excluded from every FY window and counted in
 * `undatedRowCount` (see that field's doc comment for its portfolio-wide
 * scope).
 */
export function filterRowsForFyWindow(
  rows: readonly OwnedDividendListRow[],
  window: FyWindow,
): FyRowFilterResult {
  const matched: OwnedDividendListRow[] = [];
  let undatedRowCount = 0;
  for (const row of rows) {
    const attributionDate = row.paymentDate ?? row.exDate;
    if (attributionDate === null) {
      undatedRowCount += 1;
      continue;
    }
    if (
      attributionDate >= window.startDate &&
      attributionDate <= window.endDate
    ) {
      matched.push(row);
    }
  }
  return { rows: matched, undatedRowCount };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `date` (`YYYY-MM-DD`) plus `days` calendar days, computed via UTC
 * epoch-millisecond arithmetic (immune to DST -- there is no timezone
 * here, `date` is already a plain calendar date) so month/year rollovers
 * resolve correctly rather than via naive string increment. Exported so the
 * rendering layer can state the SAME paid-leg window-end date the filter
 * itself uses (round-2 review: the subtitle copy must not drift from the
 * actual filter boundary). */
export function addDaysUtc(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/**
 * Rows for the `?window=next12` filter: declared/pending not-paid rows
 * (UNCAPPED -- already-known future claims, not a forecast) PLUS rows paid
 * on/after the window start (today, per the loader's own `now`) and on/
 * before `today + 365 days` (reviewer finding, round 1: the PAID leg is
 * capped so "next 12 months" cannot be quietly overclaimed by a stray
 * far-future paid row). Deliberately NEVER includes a fabricated/forecast
 * row -- every row here is either an already-declared pending payout or an
 * already-paid one, both real DIV-001-derived facts.
 */
export function filterRowsForNext12(
  rows: readonly OwnedDividendListRow[],
  windowStartDate: string,
): OwnedDividendListRow[] {
  const windowEndDate = addDaysUtc(windowStartDate, NEXT12_PAID_WINDOW_DAYS);
  return rows.filter(
    (row) =>
      row.notPaid ||
      (row.paymentDate !== null &&
        row.paymentDate >= windowStartDate &&
        row.paymentDate <= windowEndDate),
  );
}
