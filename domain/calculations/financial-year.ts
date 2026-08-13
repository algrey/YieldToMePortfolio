/**
 * Financial-year (FY) window and label derivation.
 *
 * Owner decisions (binding, recorded in TASKS.md FY-001A):
 * - The FY start is configurable by month only (1-12); the day is always
 *   the 1st. Default is 7 (July), matching the Australian financial year.
 * - The setting is per-user (`user_settings.financial_year_start_month`);
 *   there is no per-portfolio override.
 * - The user's `user_settings.timezone` decides where the FY boundary
 *   falls everywhere, including aggregate views.
 * - "FY" means FY-to-date (mirrors YTD): it starts at the FY start date and
 *   runs to today. "Last FY" is the prior, fully closed FY window.
 * - An FY is named by its ENDING calendar year, per Australian convention
 *   (1 Jul 2025 - 30 Jun 2026 = "FY26"). A January start month produces
 *   plain calendar-year windows, so the ending year equals the start year
 *   (Jan-Dec 2026 = "FY26").
 *
 * All boundary math resolves "now" to a local calendar date in the user's
 * IANA timezone via `Intl.DateTimeFormat`, then compares calendar-date
 * strings. This deliberately avoids binary-float and naive UTC `Date`
 * arithmetic, which would shift the boundary across DST/offset changes.
 */

export type FyWindow = Readonly<{
  /** Local calendar date the FY window starts on (YYYY-MM-DD), always day 1. */
  startDate: string;
  /** Local calendar date the FY window ends on (YYYY-MM-DD), inclusive. */
  endDate: string;
}>;

export type FyWindowUnavailableReason =
  "invalid_start_month" | "invalid_timezone" | "invalid_instant";

export type FyWindowResult =
  | { ok: true; window: FyWindow }
  | { ok: false; reason: FyWindowUnavailableReason };

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// A full ISO-8601 instant: date, time, and a mandatory offset (Z or
// ±HH:MM). Offset-less datetimes (e.g. "2026-08-13T00:00:00") are
// deliberately rejected -- their instant is ambiguous without a UTC
// reference, and this module's whole point is not guessing at that.
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Validates a financial-year start month: an integer between 1 and 12. */
export function isValidFinancialYearStartMonth(
  value: unknown,
): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 12
  );
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** Rejects impossible calendar dates (e.g. 2026-02-30) that `Date.parse`
 * would otherwise silently roll over into the following month. */
function isValidCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
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
 * Resolves an instant to the local calendar date (YYYY-MM-DD) it falls on
 * in the given IANA timezone. Uses `Intl.DateTimeFormat` so DST/offset
 * transitions are resolved by the timezone database, not approximated.
 *
 * Explicit ISO-instant contract: accepts only a bare YYYY-MM-DD date
 * (treated as UTC midnight) or a full ISO-8601 datetime carrying a
 * mandatory `Z`/`±HH:MM` offset. Non-ISO strings (e.g. "13 Aug 2026"),
 * offset-less datetimes, and impossible calendar dates (e.g. 2026-02-30)
 * are all rejected as `invalid_instant` rather than silently coerced by
 * `Date.parse`'s lenient/rollover behaviour.
 */
function localDateAt(nowInstant: string, timezone: string): string | null {
  const isBareDate = DATE_ONLY_PATTERN.test(nowInstant);
  const isIsoInstant = ISO_INSTANT_PATTERN.test(nowInstant);
  if (!isBareDate && !isIsoInstant) return null;

  const [datePartYear, datePartMonth, datePartDay] = nowInstant
    .slice(0, 10)
    .split("-")
    .map(Number);
  if (!isValidCalendarDate(datePartYear, datePartMonth, datePartDay)) {
    return null;
  }

  const normalized = isBareDate ? `${nowInstant}T00:00:00Z` : nowInstant;
  const parsedMs = Date.parse(normalized);
  if (!Number.isFinite(parsedMs)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(parsedMs));
    const values = new Map(
      parts
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad4(value: number): string {
  return String(value).padStart(4, "0");
}

/** Number of days in the given Gregorian calendar month (1-12). Pure calendar math, not tied to any timezone. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The local calendar date one day before `${year}-${pad2(month)}-01`. */
function dayBeforeFirstOfMonth(year: number, month: number): string {
  if (month === 1) return `${pad4(year - 1)}-12-31`;
  const previousMonth = month - 1;
  return `${pad4(year)}-${pad2(previousMonth)}-${pad2(daysInMonth(year, previousMonth))}`;
}

type LocalToday = Readonly<{ year: number; month: number; day: number }>;

function parseLocalDate(date: string): LocalToday {
  const [year, month, day] = date.split("-").map(Number);
  return { year, month, day };
}

/** The calendar year the current FY started in, given today's local date and the start month. */
function currentFyStartYear(today: LocalToday, startMonth: number): number {
  return today.month >= startMonth ? today.year : today.year - 1;
}

type ResolvedContext =
  | { ok: true; today: LocalToday; todayDate: string }
  | { ok: false; reason: FyWindowUnavailableReason };

function resolveContext(
  nowInstant: string,
  startMonth: number,
  timezone: string,
): ResolvedContext {
  if (!isValidFinancialYearStartMonth(startMonth)) {
    return { ok: false, reason: "invalid_start_month" };
  }
  if (!isValidTimezone(timezone)) {
    return { ok: false, reason: "invalid_timezone" };
  }
  const todayDate = localDateAt(nowInstant, timezone);
  if (todayDate === null) {
    return { ok: false, reason: "invalid_instant" };
  }
  return { ok: true, today: parseLocalDate(todayDate), todayDate };
}

/**
 * The current financial year, FY-to-date: from the FY start date through
 * today (inclusive), both as local calendar dates in `timezone`.
 */
export function currentFyWindow(
  nowInstant: string,
  startMonth: number,
  timezone: string,
): FyWindowResult {
  const context = resolveContext(nowInstant, startMonth, timezone);
  if (!context.ok) return context;
  const { today, todayDate } = context;
  const startYear = currentFyStartYear(today, startMonth);
  return {
    ok: true,
    window: {
      startDate: `${pad4(startYear)}-${pad2(startMonth)}-01`,
      endDate: todayDate,
    },
  };
}

/**
 * The prior financial year: a fully closed window from that FY's start
 * date through the day before the current FY started.
 */
export function lastFyWindow(
  nowInstant: string,
  startMonth: number,
  timezone: string,
): FyWindowResult {
  const context = resolveContext(nowInstant, startMonth, timezone);
  if (!context.ok) return context;
  const { today } = context;
  const currentStartYear = currentFyStartYear(today, startMonth);
  const lastStartYear = currentStartYear - 1;
  return {
    ok: true,
    window: {
      startDate: `${pad4(lastStartYear)}-${pad2(startMonth)}-01`,
      endDate: dayBeforeFirstOfMonth(currentStartYear, startMonth),
    },
  };
}

/**
 * The "FYnn" label for a window, named by its ending calendar year per
 * Australian convention. Derived from `window.startDate` alone (its year
 * and month fully determine the FY), not from `endDate` — for an
 * FY-to-date window, `endDate` is today, not the FY's eventual close.
 */
export function fyLabel(window: FyWindow): string {
  const { year: startYear, month: startMonth } = parseLocalDate(
    window.startDate,
  );
  const endingYear = startMonth === 1 ? startYear : startYear + 1;
  return `FY${String(endingYear).slice(-2)}`;
}
