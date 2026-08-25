/**
 * BUG-003 (owner browser-console evidence): the Overview chart table's
 * `<th scope="row">` hydration-mismatched -- server (workerd) rendered
 * "1 June 2026" while the browser rendered "1 Jun 2026" for the SAME
 * `toLocaleDateString("en-AU", { month: "short", timeZone: "UTC" })` call,
 * same pinned timezone. `en-AU` abbreviated month names are a known CLDR
 * quirk: some ICU/CLDR data versions abbreviate June/July as "June"/"July",
 * others as "Jun"/"Jul". Locale-DATA-dependent formatting (anything routed
 * through `Intl`/`toLocaleDateString`/`toLocaleTimeString`/`toLocaleString`
 * for a TEXTUAL field such as a month name) can never be hydration-safe in
 * a "use client" component, even with every explicit option (locale,
 * timeZone) pinned identically server- and client-side -- the server and
 * the browser can each ship a different CLDR snapshot. A prior investigation
 * (Node vs miniflare) missed this because both LOCAL dev runtimes share one
 * ICU build; only a real browser vs. workerd comparison exposed it.
 *
 * This module is the one place client-rendered date DISPLAY TEXT comes
 * from: a fixed, in-code English month-abbreviation table with zero
 * Intl/locale-data dependency, so the server-rendered HTML and the
 * browser's hydration render byte-for-byte identically regardless of ICU
 * version skew. See `docs/ARCHITECTURE.md`'s BUG-003 entry.
 *
 * The table matches the BROWSER's modern short form ("Jun"/"Jul") -- the
 * owner's own browser is what actually rendered "1 Jun 2026"; BUG-003's
 * tie-break picks the shorter/modern CLDR form as the product's display
 * form, matching what the owner has actually been looking at.
 *
 * Display-only: never feed this back into parsing/storage -- dates are
 * stored as validated ISO (YYYY-MM-DD) strings elsewhere (see
 * `docs/DATA_MODEL.md`).
 */
const MONTH_ABBREVIATIONS: readonly string[] = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads the 1-based calendar month straight out of a YYYY-MM-DD string's own
 * digits (`slice`, never `Date`/`Intl` parsing) so this never touches
 * locale data even indirectly, and never needs a UTC-midnight `Date` object
 * (with its own timezone-conversion footguns) just to read back the exact
 * calendar date the caller already has as a string. `null` for anything
 * that is not a plain ISO calendar date.
 */
function monthAbbreviationFromIsoDate(date: string): string | null {
  if (!ISO_DATE_PATTERN.test(date)) return null;
  const monthIndex = Number(date.slice(5, 7)) - 1;
  return MONTH_ABBREVIATIONS[monthIndex] ?? null;
}

/**
 * "1 Jun 2026" -- unpadded day, fixed-table month abbreviation, full year.
 * Matches the pre-BUG-003 `chartDate` helpers in
 * `portfolio-value-chart.tsx`/`holding-price-chart.tsx` byte-for-byte (a
 * price/value series can span decades, so the year is always spelled out).
 * Malformed input passes through unchanged, matching those callers'
 * pre-existing behaviour.
 */
export function formatDayMonthYear(date: string): string {
  const month = monthAbbreviationFromIsoDate(date);
  if (month === null) return date;
  const day = Number(date.slice(8, 10));
  return `${day} ${month} ${date.slice(0, 4)}`;
}

/**
 * "01 Jun" -- day exactly as it appears in the ISO string (zero-padded,
 * matching the pre-BUG-003 `overviewDate` helper in `portfolio-shell.tsx`
 * byte-for-byte), fixed-table month abbreviation, no year. Malformed input
 * passes through unchanged.
 */
export function formatDayMonth(date: string): string {
  const month = monthAbbreviationFromIsoDate(date);
  if (month === null) return date;
  return `${date.slice(8, 10)} ${month}`;
}
