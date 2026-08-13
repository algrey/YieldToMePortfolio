/**
 * FY-scoped chart-consumption helpers for the overview history chart
 * (FY-001C). These are deliberately pure and framework-free so window
 * filtering, closed-window delta math, and eyebrow/tooltip copy can be
 * unit-tested without rendering `PortfolioShell`.
 *
 * The FY windows themselves always come from
 * `domain/calculations/financial-year.ts` (FY-001A) -- this module only
 * consumes an already-resolved `FyWindowResult`, never re-derives month/day
 * boundaries itself.
 */
import {
  compareDecimal,
  formatDecimalFixed,
  groupThousands,
  parseDecimalResult,
  subtractDecimal,
} from "../domain/calculations/index.ts";
import {
  fyLabel,
  type FyWindowResult,
} from "../domain/calculations/financial-year.ts";

export type OverviewHistoryLike = Readonly<{
  date: string;
  valueDecimal: string | null;
}>;

/**
 * "FY" (FY-to-date): points from the window's start date through whatever
 * the data reaches. The window's own `endDate` is "today" per FY-001A's
 * contract, which is not itself necessarily a published data point, so no
 * upper bound is applied here -- the latest available point stands in for
 * "today", exactly like the existing 1M/3M/12M ranges anchor on the latest
 * point rather than the wall clock.
 */
export function filterToFyToDateWindow<T extends OverviewHistoryLike>(
  points: readonly T[],
  fyResult: FyWindowResult | null,
): T[] {
  if (fyResult === null || !fyResult.ok) return [];
  const { startDate } = fyResult.window;
  return points.filter((point) => point.date >= startDate);
}

/**
 * "Last FY": a fully closed window, bounded on both ends (the prior FY has
 * already ended, so unlike "FY" its `endDate` is a real boundary, not a
 * stand-in for "today").
 */
export function filterToClosedFyWindow<T extends OverviewHistoryLike>(
  points: readonly T[],
  fyResult: FyWindowResult | null,
): T[] {
  if (fyResult === null || !fyResult.ok) return [];
  const { startDate, endDate } = fyResult.window;
  return points.filter(
    (point) => point.date >= startDate && point.date <= endDate,
  );
}

/**
 * The change across a filtered window: the last point's value minus the
 * first's, formatted with the same explicit-sign money style used
 * elsewhere (see `formatMoney` in app/overview-read-model.ts). Returns
 * `null` -- never a fabricated "0.00" -- whenever there is nothing to
 * compare: an empty window, a single-point window (no "change" is knowable
 * from one point; first === last would otherwise silently render 0.00 as
 * if a real flat period had been observed), or a window whose boundary
 * points both carry `valueDecimal: null`. A genuinely flat *two-or-more*
 * point window is a known fact, not missing data, and still returns
 * "0.00".
 */
export function windowChangeAmount<T extends OverviewHistoryLike>(
  points: readonly T[],
  currencyCode: string,
): string | null {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  if (first.valueDecimal === null || last.valueDecimal === null) return null;
  try {
    const delta = subtractDecimal(
      parseDecimalResult(last.valueDecimal),
      parseDecimalResult(first.valueDecimal),
    );
    const zero = parseDecimalResult("0");
    const isZero = compareDecimal(delta, zero) === 0;
    const raw = formatDecimalFixed(delta, 2);
    const negative = !isZero && raw.startsWith("-");
    const absolute = negative ? raw.slice(1) : raw;
    const sign = negative ? "−" : isZero ? "" : "+";
    return `${sign}${currencyCode} ${groupThousands(absolute)}`;
  } catch {
    return null;
  }
}

/**
 * "1 Jul 2026" -- compact FY-boundary date formatting for eyebrow/tooltip
 * copy. Reuses whatever month-abbreviation table the caller already has
 * (the settings surface's `FY_MONTH_ABBREVIATIONS`) rather than inventing a
 * second date-formatting convention or depending on `Intl` again.
 */
export function formatFyBoundaryDate(
  date: string,
  monthAbbreviations: readonly string[],
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, year, month, day] = match;
  const abbreviation = monthAbbreviations[Number(month) - 1] ?? month;
  return `${Number(day)} ${abbreviation} ${year}`;
}

/**
 * "FY27 · 1 Jul 2026 – today" for the FY-to-date window, or
 * "FY26 · 1 Jul 2025 – 30 Jun 2026" for the closed Last-FY window. Returns
 * `null` when the window could not be resolved (e.g. no history yet, or an
 * invalid stored setting), so callers can fall back to their default
 * eyebrow copy instead of rendering a broken label.
 */
export function fyRangeEyebrow(
  range: "FY" | "Last FY",
  fyResult: FyWindowResult | null,
  monthAbbreviations: readonly string[],
): string | null {
  if (fyResult === null || !fyResult.ok) return null;
  const label = fyLabel(fyResult.window);
  const start = formatFyBoundaryDate(
    fyResult.window.startDate,
    monthAbbreviations,
  );
  if (range === "FY") return `${label} · ${start} – today`;
  const end = formatFyBoundaryDate(fyResult.window.endDate, monthAbbreviations);
  return `${label} · ${start} – ${end}`;
}
