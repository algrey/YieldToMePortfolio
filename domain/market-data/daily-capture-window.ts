// MKT-011A: pure, DB/network-free window math for the daily intraday-price
// capture sweep -- no I/O, independently unit-testable for the DST/weekday
// edge cases the owner ruling calls out explicitly (TASKS.md): "capture per
// stock on market days from 10:25 to 16:25 local market time... DST-safe
// (AEST/AEDT both fire at :25 -- use a proper IANA-zone local-time
// derivation, not fixed UTC offsets)".
//
// `Intl.DateTimeFormat` with an explicit IANA `timeZone` is the ONLY correct
// way to derive local wall-clock time here: a fixed UTC-offset arithmetic
// approach would silently break across every DST transition (Sydney's own
// AEST/AEDT switch, live-evidenced in
// `domain/sharesight/price-accretion.ts`'s header comment) -- this module
// deliberately never does offset arithmetic itself.

/** Local market-open capture start, inclusive: 10:25. Exported (MKT-011C) so
 * the per-holding chart's day/week-range time-axis geometry
 * (`app/price-history-chart-geometry.ts`) can position intraday ticks
 * against the SAME window boundary this module gates capture with, rather
 * than a second hard-coded 10:25/16:25 pair drifting out of sync with it. */
export const WINDOW_OPEN_MINUTES = 10 * 60 + 25;
/** Local market-close capture end, inclusive: 16:25 -- the LAST scheduled
 * capture tick of the trading day (the `25,55 * * * *` cron's :25 slot). */
export const WINDOW_CLOSE_MINUTES = 16 * 60 + 25;

const WEEKEND_DAYS = new Set(["Sat", "Sun"]);

export type DailyCaptureWindowStatus = Readonly<{
  /** YYYY-MM-DD, the security's own local calendar date at `nowInstant`. */
  localDate: string;
  /** Minutes since local midnight (0-1439). */
  localMinutesOfDay: number;
  isWeekday: boolean;
  /** True exactly when a NEW capture tick should fire for this security:
   * a weekday AND 10:25 <= local time <= 16:25 inclusive. */
  isWithinCaptureWindow: boolean;
  /** True once local time has passed 16:25 -- the signal ROLLUP uses to
   * decide "today's window has closed, promote today's last point" (see
   * `db/repositories/intraday-price-capture.ts`'s
   * `resolveDailyCaptureRollupCandidates`). Deliberately NOT also gated on
   * `isWeekday`: a non-trading day never accumulates intraday points to roll
   * up in the first place, so this flag being `true` on a weekend is
   * harmless (nothing to promote) rather than an incorrect state. */
  isPastCaptureWindowClose: boolean;
}>;

/**
 * Returns `null` (never throws, never guesses) when `nowInstant` fails to
 * parse or `timezone` is not a timezone `Intl.DateTimeFormat` recognizes --
 * both honest "cannot evaluate this security's window right now" states, per
 * this task's "missing data is never zero" discipline: a caller receiving
 * `null` must skip the security for this tick, never assume open or closed.
 */
export function resolveDailyCaptureWindowStatus(
  nowInstant: string,
  timezone: string,
): DailyCaptureWindowStatus | null {
  const instant = new Date(nowInstant);
  if (!Number.isFinite(instant.getTime())) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short",
    }).formatToParts(instant);
  } catch {
    return null;
  }
  const map = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const year = map.get("year");
  const month = map.get("month");
  const day = map.get("day");
  const hourRaw = map.get("hour");
  const minuteRaw = map.get("minute");
  const weekday = map.get("weekday");
  if (!year || !month || !day || !hourRaw || !minuteRaw || !weekday) {
    return null;
  }
  const localDate = `${year}-${month}-${day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) return null;
  // Some locales/environments render midnight as "24" under hour12:false;
  // normalize to the standard 0-23 range.
  const hour = hourRaw === "24" ? 0 : Number(hourRaw);
  const minute = Number(minuteRaw);
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }
  const localMinutesOfDay = hour * 60 + minute;
  const isWeekday = !WEEKEND_DAYS.has(weekday);
  return {
    localDate,
    localMinutesOfDay,
    isWeekday,
    isWithinCaptureWindow:
      isWeekday &&
      localMinutesOfDay >= WINDOW_OPEN_MINUTES &&
      localMinutesOfDay <= WINDOW_CLOSE_MINUTES,
    isPastCaptureWindowClose: localMinutesOfDay > WINDOW_CLOSE_MINUTES,
  };
}

/**
 * Rollup eligibility for one cached (security, market_date) pair, given the
 * security's OWN market-timezone window status "now": a PRIOR local trading
 * day is always eligible (crash/missed-tick recovery -- the owner ruling's
 * "first sweep of a later day rolls up yesterday's last point before
 * purging"); TODAY is only eligible once the window has closed (16:25
 * local). A `marketDate` that is somehow in the FUTURE relative to today
 * (clock skew, a malformed source timestamp that slipped through) is never
 * eligible -- fails closed rather than promoting a not-yet-real day.
 */
export function isDailyCaptureRollupEligible(
  marketDate: string,
  windowStatus: DailyCaptureWindowStatus,
): boolean {
  if (marketDate < windowStatus.localDate) return true;
  if (marketDate > windowStatus.localDate) return false;
  return windowStatus.isPastCaptureWindowClose;
}
