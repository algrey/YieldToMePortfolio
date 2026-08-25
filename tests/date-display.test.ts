/**
 * Unit tests for `app/date-display.ts` -- the BUG-003 fix's Intl/locale-
 * data-free date DISPLAY TEXT formatter (see that module's header comment
 * for the root cause: workerd vs. browser CLDR skew for `en-AU` abbreviated
 * month names hydration-mismatched the Overview chart table). Pins the
 * fixed month-abbreviation table across all 12 months plus edge dates
 * (year boundaries, a leap-year Feb 29, single- and double-digit days), and
 * the two callers' exact pre-existing visible formats.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { formatDayMonth, formatDayMonthYear } from "../app/date-display.ts";

const ALL_MONTHS: readonly [string, string][] = [
  ["2026-01-15", "Jan"],
  ["2026-02-15", "Feb"],
  ["2026-03-15", "Mar"],
  ["2026-04-15", "Apr"],
  ["2026-05-15", "May"],
  ["2026-06-15", "Jun"],
  ["2026-07-15", "Jul"],
  ["2026-08-15", "Aug"],
  ["2026-09-15", "Sep"],
  ["2026-10-15", "Oct"],
  ["2026-11-15", "Nov"],
  ["2026-12-15", "Dec"],
];

test("formatDayMonthYear: all 12 months use the fixed, browser-modern short abbreviation (never a full month name)", () => {
  for (const [date, month] of ALL_MONTHS) {
    assert.equal(formatDayMonthYear(date), `15 ${month} 2026`);
  }
});

test("formatDayMonthYear: BUG-003's exact reported case -- 1 June 2026 must render as the SHORT form, not the full month name", () => {
  assert.equal(formatDayMonthYear("2026-06-01"), "1 Jun 2026");
  assert.notEqual(formatDayMonthYear("2026-06-01"), "1 June 2026");
});

test("formatDayMonthYear: day is unpadded (matches the pre-BUG-003 chartDate helpers byte-for-byte)", () => {
  assert.equal(formatDayMonthYear("2026-06-05"), "5 Jun 2026");
  assert.equal(formatDayMonthYear("2026-06-25"), "25 Jun 2026");
});

test("formatDayMonthYear: month/year boundary dates", () => {
  assert.equal(formatDayMonthYear("2026-01-01"), "1 Jan 2026");
  assert.equal(formatDayMonthYear("2026-12-31"), "31 Dec 2026");
  assert.equal(formatDayMonthYear("1998-03-12"), "12 Mar 1998");
});

test("formatDayMonthYear: leap-year 29 February", () => {
  assert.equal(formatDayMonthYear("2024-02-29"), "29 Feb 2024");
});

test("formatDayMonthYear: malformed input passes through unchanged", () => {
  assert.equal(formatDayMonthYear("not-a-date"), "not-a-date");
  assert.equal(formatDayMonthYear("2026-13-01"), "2026-13-01");
  assert.equal(formatDayMonthYear(""), "");
});

test("formatDayMonth: day is zero-padded exactly as it appears in the ISO string, no year (matches the pre-BUG-003 overviewDate helper byte-for-byte)", () => {
  assert.equal(formatDayMonth("2026-06-01"), "01 Jun");
  assert.equal(formatDayMonth("2026-06-25"), "25 Jun");
  assert.equal(formatDayMonth("2026-12-31"), "31 Dec");
});

test("formatDayMonth: all 12 months", () => {
  for (const [date, month] of ALL_MONTHS) {
    assert.equal(formatDayMonth(date), `15 ${month}`);
  }
});

test("formatDayMonth: malformed input passes through unchanged", () => {
  assert.equal(formatDayMonth("not-a-date"), "not-a-date");
  assert.equal(formatDayMonth(""), "");
});
