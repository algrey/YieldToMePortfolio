/** UI-018 — Per-holding price-history graph in the holding detail sheet.
 * Owner directive: "add the graph under the 'Average cost x quantity'
 * section. At the bottom of the graph: Day, week, month, YTD, FY, Year,
 * 5 Year, All" -- motivated by the freshly imported 28-year FMG price
 * history being invisible. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/sql-client.ts";
import {
  DEFAULT_PRICE_HISTORY_RANGE,
  MAX_PRICE_HISTORY_POINTS,
  PRICE_HISTORY_RANGES,
  downsamplePriceHistoryPoints,
  parsePriceHistoryRangeParam,
  priceHistoryWindow,
  selectDailyWinners,
  subtractCalendarDays,
  type RawPricePoint,
} from "../app/price-history-range.ts";
import {
  calendarColumnWidth,
  classifyPriceHistorySegments,
  dateDayOffset,
  isPlottableDecimal,
  positionTodayPointsByObservedTime,
  scalePriceHistoryPoints,
} from "../app/price-history-chart-geometry.ts";
import { loadOwnedPriceHistory } from "../app/owned-price-history.ts";
import { currentFyWindow } from "../domain/calculations/financial-year.ts";
import { listOwnedIntradayPricePointsForDate } from "../db/repositories/intraday-price-capture.ts";
import {
  WINDOW_CLOSE_MINUTES,
  WINDOW_OPEN_MINUTES,
} from "../domain/market-data/daily-capture-window.ts";

function renderComponent(
  componentName: string,
  componentPath: string,
  props: unknown,
): string {
  const componentUrl = new URL(componentPath, import.meta.url).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { ${componentName} } from ${JSON.stringify(componentUrl)};
    const props = ${JSON.stringify(props)};
    process.stdout.write(
      renderToStaticMarkup(createElement(${componentName}, props)),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

// ---------------------------------------------------------------------------
// Part 1: `?range=` parsing (clamp, not crash).
// ---------------------------------------------------------------------------

test("UI-018: parsePriceHistoryRangeParam accepts every declared range and reports no invalidity", () => {
  for (const range of PRICE_HISTORY_RANGES) {
    const result = parsePriceHistoryRangeParam(range);
    assert.equal(result.range, range);
    assert.equal(result.invalidRangeRequested, false);
  }
});

test("UI-018: parsePriceHistoryRangeParam degrades an absent value to the default WITHOUT flagging invalidity", () => {
  const result = parsePriceHistoryRangeParam(null);
  assert.equal(result.range, DEFAULT_PRICE_HISTORY_RANGE);
  assert.equal(result.invalidRangeRequested, false);
});

test("UI-018: parsePriceHistoryRangeParam degrades an unrecognised value to the default AND flags invalidity", () => {
  for (const bad of ["decade", "YEAR", "", "5Y", "day "]) {
    const result = parsePriceHistoryRangeParam(bad);
    assert.equal(result.range, DEFAULT_PRICE_HISTORY_RANGE);
    assert.equal(result.invalidRangeRequested, true);
  }
});

test("UI-018: the range button order is exactly Day, Week, Month, YTD, FY, Year, 5 Year, All", () => {
  assert.deepEqual(PRICE_HISTORY_RANGES, [
    "day",
    "week",
    "month",
    "ytd",
    "fy",
    "year",
    "5y",
    "all",
  ]);
});

// ---------------------------------------------------------------------------
// Part 2: window derivation per range.
// ---------------------------------------------------------------------------

test("UI-018: subtractCalendarDays subtracts calendar days across a month/year boundary", () => {
  assert.equal(subtractCalendarDays("2026-08-21", 6), "2026-08-15");
  assert.equal(subtractCalendarDays("2026-01-02", 6), "2025-12-27");
  assert.equal(subtractCalendarDays("2026-03-01", 1), "2026-02-28");
  // 2028 is a leap year -- crossing 29 Feb must not be skipped.
  assert.equal(subtractCalendarDays("2028-03-01", 1), "2028-02-29");
});

test("UI-018: priceHistoryWindow -- day is today-only", () => {
  assert.deepEqual(priceHistoryWindow("day", "2026-08-21", null), {
    fromDate: "2026-08-21",
    toDate: "2026-08-21",
  });
});

test("UI-018: priceHistoryWindow -- week is the trailing 7 calendar days", () => {
  assert.deepEqual(priceHistoryWindow("week", "2026-08-21", null), {
    fromDate: "2026-08-15",
    toDate: "2026-08-21",
  });
});

test("UI-018: priceHistoryWindow -- month/year/5y are the trailing calendar month/year/5-years", () => {
  assert.deepEqual(priceHistoryWindow("month", "2026-08-21", null), {
    fromDate: "2026-07-21",
    toDate: "2026-08-21",
  });
  assert.deepEqual(priceHistoryWindow("year", "2026-08-21", null), {
    fromDate: "2025-08-21",
    toDate: "2026-08-21",
  });
  assert.deepEqual(priceHistoryWindow("5y", "2026-08-21", null), {
    fromDate: "2021-08-21",
    toDate: "2026-08-21",
  });
});

test("UI-018: priceHistoryWindow -- ytd is 1 Jan of the local year through today", () => {
  assert.deepEqual(priceHistoryWindow("ytd", "2026-08-21", null), {
    fromDate: "2026-01-01",
    toDate: "2026-08-21",
  });
});

test("UI-018: priceHistoryWindow -- fy uses the already-resolved FY-to-date window (July start)", () => {
  const fyResult = currentFyWindow(
    "2026-08-21T00:00:00Z",
    7,
    "Australia/Sydney",
  );
  assert.ok(fyResult.ok);
  const window = priceHistoryWindow("fy", "2026-08-21", fyResult);
  assert.deepEqual(window, { fromDate: "2026-07-01", toDate: "2026-08-21" });
});

test("UI-018: priceHistoryWindow -- fy respects a NON-July start month", () => {
  const fyResult = currentFyWindow("2026-02-10T00:00:00Z", 4, "UTC");
  assert.ok(fyResult.ok);
  const window = priceHistoryWindow("fy", "2026-02-10", fyResult);
  // April-start FY: 10 Feb 2026 falls in the FY that started 1 Apr 2025.
  assert.deepEqual(window, { fromDate: "2025-04-01", toDate: "2026-02-10" });
});

test("UI-018: priceHistoryWindow -- fy degrades to the YTD-shaped window when the FY result failed to resolve", () => {
  const window = priceHistoryWindow("fy", "2026-08-21", {
    ok: false,
    reason: "invalid_start_month",
  });
  assert.deepEqual(window, { fromDate: "2026-01-01", toDate: "2026-08-21" });
});

test("UI-018: priceHistoryWindow -- all has no lower bound", () => {
  assert.deepEqual(priceHistoryWindow("all", "2026-08-21", null), {
    fromDate: null,
    toDate: "2026-08-21",
  });
});

// ---------------------------------------------------------------------------
// Part 3: per-date provider selection ("the winner rule").
// ---------------------------------------------------------------------------

function rawPoint(overrides: Partial<RawPricePoint>): RawPricePoint {
  return {
    marketDate: "2026-08-20",
    priceDecimal: "10.00",
    currencyCode: "AUD",
    providerId: "owner-import",
    interval: "eod",
    observationAt: "2026-08-19T13:00:00.000Z",
    quality: "observed",
    ...overrides,
  };
}

test("UI-018: selectDailyWinners prefers an eod close over a delayed quote for the SAME date", () => {
  const eod = rawPoint({
    priceDecimal: "10.00",
    providerId: "owner-import",
    interval: "eod",
    observationAt: "2026-08-19T13:00:00.000Z",
  });
  const delayed = rawPoint({
    priceDecimal: "10.05",
    providerId: "sharesight",
    interval: "delayed",
    observationAt: "2026-08-20T05:30:00.000Z", // later in wall-clock time
  });
  const winners = selectDailyWinners([delayed, eod]);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]!.providerId, "owner-import");
  assert.equal(winners[0]!.priceDecimal, "10.00");
});

test("UI-018: selectDailyWinners -- absent an eod row, the most recently observed row wins", () => {
  const older = rawPoint({
    priceDecimal: "1.00",
    providerId: "sharesight",
    interval: "delayed",
    observationAt: "2026-08-20T01:00:00.000Z",
  });
  const newer = rawPoint({
    priceDecimal: "1.05",
    providerId: "sharesight",
    interval: "delayed",
    observationAt: "2026-08-20T05:00:00.000Z",
  });
  const winners = selectDailyWinners([older, newer]);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]!.priceDecimal, "1.05");
});

test("UI-018: selectDailyWinners breaks an exact observationAt tie on providerId descending (the greatest id wins), deterministically", () => {
  const left = rawPoint({
    providerId: "aaa",
    observationAt: "2026-08-20T00:00:00.000Z",
  });
  const right = rawPoint({
    providerId: "zzz",
    observationAt: "2026-08-20T00:00:00.000Z",
  });
  assert.equal(selectDailyWinners([left, right])[0]!.providerId, "zzz");
  assert.equal(selectDailyWinners([right, left])[0]!.providerId, "zzz");
});

test("UI-018: selectDailyWinners reduces one row per market_date and sorts ascending", () => {
  const rows = [
    rawPoint({ marketDate: "2026-08-21", priceDecimal: "3" }),
    rawPoint({ marketDate: "2026-08-19", priceDecimal: "1" }),
    rawPoint({ marketDate: "2026-08-20", priceDecimal: "2" }),
  ];
  const winners = selectDailyWinners(rows);
  assert.deepEqual(
    winners.map((point) => point.marketDate),
    ["2026-08-19", "2026-08-20", "2026-08-21"],
  );
});

// ---------------------------------------------------------------------------
// Part 4: server-side downsampling -- bounded, last-per-bucket, exact.
// ---------------------------------------------------------------------------

function sequentialPoints(count: number): RawPricePoint[] {
  const points: RawPricePoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const day = String(index + 1).padStart(2, "0");
    points.push(
      rawPoint({
        marketDate: `2020-01-${day.length > 2 ? "31" : day}`,
        priceDecimal: String(index),
      }),
    );
  }
  return points;
}

test("UI-018: downsamplePriceHistoryPoints is a no-op within budget", () => {
  const points = sequentialPoints(10);
  const result = downsamplePriceHistoryPoints(points, 400);
  assert.equal(result.bucketSize, 1);
  assert.equal(result.points.length, 10);
  assert.deepEqual(result.points, points);
});

test("UI-018: downsamplePriceHistoryPoints bounds output to <= maxPoints and never invents a value", () => {
  // 1000 distinct, ordered, exact prices -- every returned point must be
  // byte-identical to one of the RAW inputs (never averaged/interpolated).
  const points: RawPricePoint[] = [];
  for (let index = 0; index < 1000; index += 1) {
    points.push(
      rawPoint({
        marketDate: dayFromOffset(index),
        priceDecimal: `${index}.123456789`,
      }),
    );
  }
  const raw = new Set(points.map((point) => point.priceDecimal));
  const result = downsamplePriceHistoryPoints(points, 400);
  assert.ok(result.points.length <= 400);
  assert.equal(result.bucketSize, Math.ceil(1000 / 400));
  for (const point of result.points) {
    assert.ok(
      raw.has(point.priceDecimal),
      `${point.priceDecimal} was not one of the raw observed values`,
    );
  }
  // The series' final fact is never dropped.
  assert.equal(
    result.points[result.points.length - 1]!.priceDecimal,
    points[points.length - 1]!.priceDecimal,
  );
});

test("UI-018: downsamplePriceHistoryPoints -- exact last-observation-per-bucket pinned example", () => {
  // 10 points, budget 3 -> bucketSize = ceil(10/3) = 4 -> buckets [0..3],
  // [4..7], [8..9]; last-of-bucket = indices 3, 7, 9.
  const points = sequentialPoints(10);
  const result = downsamplePriceHistoryPoints(points, 3);
  assert.equal(result.bucketSize, 4);
  assert.deepEqual(
    result.points.map((point) => point.priceDecimal),
    ["3", "7", "9"],
  );
});

function dayFromOffset(offset: number): string {
  const ms = Date.UTC(2020, 0, 1) + offset * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

test("UI-018: downsamplePriceHistoryPoints caps below the default MAX_PRICE_HISTORY_POINTS of 400", () => {
  const points: RawPricePoint[] = [];
  for (let index = 0; index < 7313; index += 1) {
    points.push(
      rawPoint({ marketDate: dayFromOffset(index), priceDecimal: "1" }),
    );
  }
  const result = downsamplePriceHistoryPoints(points);
  assert.ok(result.points.length <= MAX_PRICE_HISTORY_POINTS);
});

// ---------------------------------------------------------------------------
// Part 5: chart geometry -- gap classification and pixel scaling.
// ---------------------------------------------------------------------------

test("UI-018: dateDayOffset is monotonic and returns whole-day integers", () => {
  const a = dateDayOffset("2026-08-20");
  const b = dateDayOffset("2026-08-21");
  assert.equal(b - a, 1);
});

test("UI-018: classifyPriceHistorySegments treats an ordinary daily-dominated series as one solid segment", () => {
  const points = [
    { date: "2026-08-18", priceDecimal: "1" },
    { date: "2026-08-19", priceDecimal: "1.1" },
    { date: "2026-08-20", priceDecimal: "1.2" },
    { date: "2026-08-21", priceDecimal: "1.3" },
  ];
  const segments = classifyPriceHistorySegments(points);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.gap, false);
  assert.equal(segments[0]!.points.length, 4);
});

test("UI-018: classifyPriceHistorySegments marks an outsized date gap as its own dashed segment", () => {
  const points = [
    { date: "2020-01-01", priceDecimal: "1" },
    { date: "2020-01-02", priceDecimal: "1.1" },
    { date: "2020-01-03", priceDecimal: "1.2" },
    // A 400-day hole against a ~1-day median -- unambiguously a gap.
    { date: "2021-02-07", priceDecimal: "2" },
    { date: "2021-02-08", priceDecimal: "2.1" },
  ];
  const segments = classifyPriceHistorySegments(points);
  const gapSegments = segments.filter((segment) => segment.gap);
  assert.equal(gapSegments.length, 1);
  assert.deepEqual(
    gapSegments[0]!.points.map((point) => point.date),
    ["2020-01-03", "2021-02-07"],
  );
  // Gap segment shares endpoints with its solid neighbours -- the line
  // never visibly breaks, only its dash pattern marks it uncertain.
  const solidSegments = segments.filter((segment) => !segment.gap);
  assert.equal(solidSegments.length, 2);
});

test("UI-018 (review round-1 fix, F1): classifyPriceHistorySegments flags a hole in a 2-point series, where the median-relative rule alone structurally cannot fire", () => {
  // Only ONE delta exists in a 2-point series, so it IS the median -- a
  // pure 4x-median comparison can never flag it (the reported repro: an
  // 8-year hole under the "Day" range drew a solid line). The absolute
  // floor closes this gap.
  const points = [
    { date: "2018-01-01", priceDecimal: "1" },
    { date: "2026-01-01", priceDecimal: "2" }, // ~8 years later
  ];
  const segments = classifyPriceHistorySegments(points);
  const gapSegments = segments.filter((segment) => segment.gap);
  assert.equal(gapSegments.length, 1);
  assert.deepEqual(
    gapSegments[0]!.points.map((point) => point.date),
    ["2018-01-01", "2026-01-01"],
  );
});

test("UI-018 (review round-1 fix, F1): classifyPriceHistorySegments flags a hole in a 3-point series too (2 deltas -- still degenerate for a median)", () => {
  const points = [
    { date: "2026-08-18", priceDecimal: "1" },
    { date: "2026-08-19", priceDecimal: "1.1" },
    { date: "2030-01-01", priceDecimal: "2" }, // multi-year hole after the second point
  ];
  const segments = classifyPriceHistorySegments(points);
  assert.ok(segments.some((segment) => segment.gap));
});

test("UI-018 (review round-2 fix, BLOCKING): a downsampled series' NORMAL bucket spacing is NOT flagged as a gap -- pins the F1-fix regression (the owner's 28-year FMG chart rendering as almost entirely dashed)", () => {
  // 30 points spaced ~19 TRADING days apart (~26-27 calendar days,
  // approximating a bucketSize=19 downsample of a real daily-close
  // series) -- this is exactly the shape that a flat, unscaled 10-day
  // absolute floor dashed in its entirety.
  const points: { date: string; priceDecimal: string }[] = [];
  for (let index = 0; index < 30; index += 1) {
    const ms = Date.UTC(1998, 2, 12) + index * 26 * 86_400_000;
    points.push({
      date: new Date(ms).toISOString().slice(0, 10),
      priceDecimal: String(index),
    });
  }
  const segments = classifyPriceHistorySegments(points, 19);
  const gapSegments = segments.filter((segment) => segment.gap);
  assert.equal(
    gapSegments.length,
    0,
    "normal downsampled bucket spacing must never be dashed as a gap",
  );
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.points.length, 30);
});

test("UI-018 (review round-2 fix): a GENUINE hole inside a downsampled series (many times wider than the sampling cadence) still dashes", () => {
  const points: { date: string; priceDecimal: string }[] = [
    { date: "1998-03-12", priceDecimal: "0" },
    { date: "1998-04-07", priceDecimal: "1" }, // ~26 days -- normal cadence
    { date: "1998-05-03", priceDecimal: "2" }, // ~26 days -- normal cadence
    { date: "2010-01-01", priceDecimal: "3" }, // a real, many-year hole
    { date: "2010-01-27", priceDecimal: "4" },
  ];
  const segments = classifyPriceHistorySegments(points, 19);
  const gapSegments = segments.filter((segment) => segment.gap);
  assert.equal(gapSegments.length, 1);
  assert.deepEqual(
    gapSegments[0]!.points.map((point) => point.date),
    ["1998-05-03", "2010-01-01"],
  );
});

test("UI-018 (review round-2 fix): classifyPriceHistorySegments defaults bucketSize to 1 (undownsampled) when omitted -- the F1-fix behaviour is unchanged for a plain series", () => {
  const points = [
    { date: "2018-01-01", priceDecimal: "1" },
    { date: "2026-01-01", priceDecimal: "2" },
  ];
  const withDefault = classifyPriceHistorySegments(points);
  const withExplicitOne = classifyPriceHistorySegments(points, 1);
  assert.deepEqual(withDefault, withExplicitOne);
  assert.ok(withDefault.some((segment) => segment.gap));
});

test("UI-018 (review round-2 fix): the owner-scale drill shape -- 7,313 daily points downsampled to <=400 produce a SANE segment count with few/no gap segments", async () => {
  const raw: { date: string; priceDecimal: string }[] = [];
  for (let index = 0; index < 7313; index += 1) {
    const ms = Date.UTC(1998, 2, 12) + index * 86_400_000;
    raw.push({
      date: new Date(ms).toISOString().slice(0, 10),
      priceDecimal: "1",
    });
  }
  const rawPricePoints = raw.map((point) =>
    rawPoint({ marketDate: point.date, priceDecimal: point.priceDecimal }),
  );
  const { points: downsampled, bucketSize } =
    downsamplePriceHistoryPoints(rawPricePoints);
  assert.ok(downsampled.length <= 400);
  const chartPoints = downsampled.map((point) => ({
    date: point.marketDate,
    priceDecimal: point.priceDecimal,
  }));
  const segments = classifyPriceHistorySegments(chartPoints, bucketSize);
  const gapSegments = segments.filter((segment) => segment.gap);
  assert.equal(
    gapSegments.length,
    0,
    `expected zero gap segments for a genuinely continuous 28-year daily series downsampled to bucketSize=${bucketSize}, got ${gapSegments.length}`,
  );
  // A sane segment count: one solid run, not one segment per point.
  assert.ok(segments.length < 5);
});

test("UI-018: classifyPriceHistorySegments handles 0/1-point series without throwing", () => {
  assert.deepEqual(classifyPriceHistorySegments([]), []);
  const one = classifyPriceHistorySegments([
    { date: "2026-08-21", priceDecimal: "1" },
  ]);
  assert.equal(one.length, 1);
  assert.equal(one[0]!.points.length, 1);
});

test("UI-018: scalePriceHistoryPoints scales X by calendar-date offset, not by index", () => {
  const points = [
    { date: "2020-01-01", priceDecimal: "1" },
    { date: "2020-01-02", priceDecimal: "1" },
    { date: "2025-01-01", priceDecimal: "1" }, // huge gap after two adjacent days
  ];
  const scaled = scalePriceHistoryPoints(points, {
    width: 100,
    height: 100,
    paddingX: 0,
    paddingY: 0,
  });
  assert.ok(scaled);
  const [first, second, third] = scaled!.points;
  const gapBetween12 = second!.x - first!.x;
  const gapBetween23 = third!.x - second!.x;
  // The 1-day gap must be visually tiny next to the multi-year gap -- an
  // index-spaced axis would make these EQUAL, which is the fabrication
  // this scaling exists to avoid.
  assert.ok(gapBetween23 > gapBetween12 * 100);
});

test("UI-018: scalePriceHistoryPoints -- a perfectly flat series centers vertically rather than dividing by zero", () => {
  const points = [
    { date: "2026-08-19", priceDecimal: "5.00" },
    { date: "2026-08-20", priceDecimal: "5.00" },
    { date: "2026-08-21", priceDecimal: "5.00" },
  ];
  const scaled = scalePriceHistoryPoints(points, {
    width: 100,
    height: 100,
    paddingX: 10,
    paddingY: 10,
  });
  assert.ok(scaled);
  for (const point of scaled!.points) {
    assert.equal(point.y, 10 + (100 - 20) / 2);
  }
  assert.equal(scaled!.minPriceDecimal, "5.00");
  assert.equal(scaled!.maxPriceDecimal, "5.00");
});

test("UI-018: scalePriceHistoryPoints returns the exact original decimal strings for min/max, never a float re-rendering", () => {
  const points = [
    { date: "2026-08-19", priceDecimal: "0.078520000" },
    { date: "2026-08-20", priceDecimal: "12.500000001" },
  ];
  const scaled = scalePriceHistoryPoints(points, {
    width: 100,
    height: 100,
    paddingX: 0,
    paddingY: 0,
  });
  assert.equal(scaled!.minPriceDecimal, "0.078520000");
  assert.equal(scaled!.maxPriceDecimal, "12.500000001");
});

test("UI-018: scalePriceHistoryPoints returns null for an empty series", () => {
  assert.equal(
    scalePriceHistoryPoints([], {
      width: 10,
      height: 10,
      paddingX: 0,
      paddingY: 0,
    }),
    null,
  );
});

test("UI-018: isPlottableDecimal accepts a valid non-negative decimal and rejects malformed/negative input", () => {
  assert.equal(isPlottableDecimal("0.07852"), true);
  assert.equal(isPlottableDecimal("12"), true);
  assert.equal(isPlottableDecimal("0"), true);
  assert.equal(isPlottableDecimal("-1"), false);
  assert.equal(isPlottableDecimal("1e10"), false);
  assert.equal(isPlottableDecimal("abc"), false);
  assert.equal(isPlottableDecimal("01"), false);
});

// ---------------------------------------------------------------------------
// Part 6: `loadOwnedPriceHistory` -- DB-backed, real migrated D1 schema.
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  return db;
}

/** Two owners, each with a portfolio and one held security -- the shared
 * multi-provider fixture: user-a's security-a carries BOTH an owner-import
 * daily-close history and a single sharesight delayed quote. */
async function priceHistoryFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1),
           ('user-b', 'active', 'b@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO user_settings (user_id, home_currency_code, timezone, financial_year_start_month, created_at, updated_at, version)
    VALUES ('user-a', 'AUD', 'Australia/Sydney', 7, '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1),
           ('portfolio-b', 'user-b', 'B', 'B portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Fortescue', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01'),
           ('security-b', 'Beta', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'FMG', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01'),
           ('membership-b', 'user-b', 'portfolio-b', 'security-b', 'ZZZ', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
    VALUES ('mapping-owner-import', 'security-a', 'owner-import', 'ASX', 'FMG', '2026-01-01', 'verified'),
           ('mapping-sharesight', 'security-a', 'sharesight', 'ASX', 'FMG', '2026-01-01', 'verified');
    -- Owner-import daily EOD closes, one per weekday 2026-08-10..2026-08-19.
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES
      ('price-eod-10', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-09T14:00:00.000Z', '2026-08-10', 'Australia/Sydney', 'AUD', '19.00', 'raw', 'observed', '2026-08-10T00:00:00.000Z'),
      ('price-eod-11', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-10T14:00:00.000Z', '2026-08-11', 'Australia/Sydney', 'AUD', '19.10', 'raw', 'observed', '2026-08-11T00:00:00.000Z'),
      ('price-eod-12', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-11T14:00:00.000Z', '2026-08-12', 'Australia/Sydney', 'AUD', '19.20', 'raw', 'observed', '2026-08-12T00:00:00.000Z'),
      ('price-eod-13', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-12T14:00:00.000Z', '2026-08-13', 'Australia/Sydney', 'AUD', '19.30', 'raw', 'observed', '2026-08-13T00:00:00.000Z'),
      ('price-eod-14', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-13T14:00:00.000Z', '2026-08-14', 'Australia/Sydney', 'AUD', '19.40', 'raw', 'observed', '2026-08-14T00:00:00.000Z'),
      ('price-eod-19', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-18T14:00:00.000Z', '2026-08-19', 'Australia/Sydney', 'AUD', '19.90', 'raw', 'observed', '2026-08-19T00:00:00.000Z');
    -- One Sharesight delayed quote for "today" (2026-08-20 in Sydney).
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES ('price-delayed-20', 'sharesight', 'user', 'user-a', 'user-a', 'mapping-sharesight', 'security-a', 'delayed', '2026-08-20T05:55:00.000Z', '2026-08-20', '+10:00', 'AUD', '20.05', 'raw', 'observed', '2026-08-20T05:55:00.000Z');
  `);
  return db;
}

// Fixed "now" landing on 2026-08-20T06:00:00Z, which is 2026-08-20 16:00
// in Australia/Sydney (AEST, +10:00) -- so "today" for the fixture is
// 2026-08-20, matching the sharesight delayed row and one day after the
// owner-import history's last close (2026-08-19).
const FIXTURE_NOW = new Date("2026-08-20T06:00:00.000Z");

test("UI-018: loadOwnedPriceHistory -- 'week' range returns the eod winner series plus the sharesight delayed point, honestly labelled", async () => {
  const db = await priceHistoryFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.range, "week");
  assert.equal(result.invalidRangeRequested, false);
  assert.equal(result.currencyCode, "AUD");
  // week window: 2026-08-14..2026-08-20 -- covers price-eod-14,
  // price-eod-19, and price-delayed-20 (no eod row exists for 2026-08-20
  // in this fixture).
  assert.deepEqual(
    result.points.map((point) => [
      point.date,
      point.providerId,
      point.interval,
    ]),
    [
      ["2026-08-14", "owner-import", "eod"],
      ["2026-08-19", "owner-import", "eod"],
      ["2026-08-20", "sharesight", "delayed"],
    ],
  );
  assert.equal(result.points[0]!.priceDecimal, "19.40");
  assert.equal(result.points[1]!.priceDecimal, "19.90");
  assert.equal(result.points[2]!.priceDecimal, "20.05");
  assert.deepEqual(result.provenance.providers, ["owner-import", "sharesight"]);
  assert.equal(result.provenance.fromDate, "2026-08-14");
  assert.equal(result.provenance.toDate, "2026-08-20");
  assert.equal(result.provenance.pointCountRaw, 3);
  assert.equal(result.provenance.pointCountReturned, 3);
  assert.equal(result.provenance.excludedCurrencyCount, 0);
  assert.equal(result.provenance.excludedMalformedCount, 0);
  assert.ok(result.latestDelayed);
  assert.equal(result.latestDelayed!.priceDecimal, "20.05");
  assert.equal(result.latestDelayed!.date, "2026-08-20");
});

test("UI-018: loadOwnedPriceHistory -- an eod close and a delayed quote on the SAME date resolve to one honest point (winner rule), never two conflicting lines", async () => {
  const db = await priceHistoryFixture();
  db.exec(`
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES ('price-eod-20', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-20T20:00:00.000Z', '2026-08-20', 'Australia/Sydney', 'AUD', '20.10', 'raw', 'observed', '2026-08-20T20:00:00.000Z');
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "day",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const onlyToday = result.points.filter(
    (point) => point.date === "2026-08-20",
  );
  assert.equal(onlyToday.length, 1);
  assert.equal(onlyToday[0]!.providerId, "owner-import"); // eod beats delayed
  assert.equal(onlyToday[0]!.priceDecimal, "20.10");
});

test("UI-018: loadOwnedPriceHistory -- 'day' range supplements a sparse single-day window with the previous close for honest context", async () => {
  const db = await priceHistoryFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "day",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Today (2026-08-20) only has the sharesight delayed row -- the loader
  // supplements with the nearest EARLIER date's winner (2026-08-19 eod).
  assert.deepEqual(
    result.points.map((point) => point.date),
    ["2026-08-19", "2026-08-20"],
  );
  assert.equal(result.points[0]!.priceDecimal, "19.90");
  assert.equal(result.points[1]!.priceDecimal, "20.05");
});

test("UI-018 (review round-2 follow-up): the 'day' range's previous-close lookup is currency-filtered -- a nearer foreign-currency-only date is skipped in favour of an earlier SAME-currency date", async () => {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('AUD', 36, 'Australian dollar', 2, 1),
           ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO users (id, status, primary_email, timezone, created_at, updated_at, version)
    VALUES ('user-a', 'active', 'a@example.test', 'Australia/Sydney', '2026-08-01', '2026-08-01', 1);
    INSERT INTO portfolios (id, user_id, code, name, base_currency_code, timezone, accounting_method, status, created_at, updated_at, version)
    VALUES ('portfolio-a', 'user-a', 'A', 'A portfolio', 'AUD', 'Australia/Sydney', 'fifo', 'active', '2026-08-01', '2026-08-01', 1);
    INSERT INTO securities (id, canonical_name, asset_type, primary_currency_code, status, created_at, updated_at)
    VALUES ('security-a', 'Fortescue', 'equity', 'AUD', 'active', '2026-08-01', '2026-08-01');
    INSERT INTO portfolio_securities (id, user_id, portfolio_id, security_id, source_symbol, source_exchange_alias, source_currency_code, status, created_at, updated_at)
    VALUES ('membership-a', 'user-a', 'portfolio-a', 'security-a', 'FMG', 'ASX', 'AUD', 'held', '2026-08-01', '2026-08-01');
    INSERT INTO security_provider_mappings (id, security_id, provider_id, provider_exchange, provider_symbol, valid_from, status)
    VALUES ('mapping-owner-import', 'security-a', 'owner-import', 'ASX', 'FMG', '2026-01-01', 'verified');
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES
      -- The NEAREST date before "today" has ONLY a USD row -- no AUD data
      -- that day at all.
      ('price-usd-only-19', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-18T14:00:00.000Z', '2026-08-19', 'Australia/Sydney', 'USD', '5.55', 'raw', 'observed', '2026-08-19T00:00:00.000Z'),
      -- An EARLIER date genuinely has AUD data -- the fix must reach back to it.
      ('price-aud-earlier-10', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-09T14:00:00.000Z', '2026-08-10', 'Australia/Sydney', 'AUD', '19.00', 'raw', 'observed', '2026-08-10T00:00:00.000Z'),
      -- "Today" (2026-08-20) has only an AUD observation, so the single-day
      -- window alone still needs a previous-close supplement.
      ('price-aud-today', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-20T05:00:00.000Z', '2026-08-20', 'Australia/Sydney', 'AUD', '20.00', 'raw', 'observed', '2026-08-20T05:00:00.000Z');
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "day",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.points.map((point) => point.date),
    ["2026-08-10", "2026-08-20"],
  );
  assert.equal(result.points[0]!.priceDecimal, "19.00");
  assert.ok(
    !result.points.some((point) => point.date === "2026-08-19"),
    "the USD-only date must never appear -- neither as a wrong-currency point nor as a false previous close",
  );
});

test("UI-018: loadOwnedPriceHistory -- an in-range window with zero observations is an honest empty result, never a fabricated point", async () => {
  const db = await priceHistoryFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "ytd",
    new Date("2025-06-15T00:00:00.000Z"), // long before the fixture's data
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.points, []);
  assert.equal(result.provenance.fromDate, null);
  assert.equal(result.provenance.toDate, null);
  assert.equal(result.provenance.pointCountRaw, 0);
  assert.equal(result.provenance.pointCountReturned, 0);
  assert.deepEqual(result.provenance.providers, []);
  assert.equal(result.provenance.excludedCurrencyCount, 0);
  assert.equal(result.provenance.excludedMalformedCount, 0);
});

test("UI-018: loadOwnedPriceHistory -- an unrecognised ?range= degrades to Year and discloses the fallback", async () => {
  const db = await priceHistoryFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "decade",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.range, "year");
  assert.equal(result.invalidRangeRequested, true);
});

test("UI-018: loadOwnedPriceHistory denies a cross-owner portfolioId", async () => {
  const db = await priceHistoryFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-b",
    "portfolio-a", // owned by user-a, not user-b
    "membership-a",
    "year",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
});

test("UI-018: loadOwnedPriceHistory denies a portfolioSecurityId belonging to another user", async () => {
  const db = await priceHistoryFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-b", // belongs to user-b/portfolio-b
    "year",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.status, 404);
});

test("UI-018: loadOwnedPriceHistory -- FY window uses the owner's financial_year_start_month setting", async () => {
  const db = await priceHistoryFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "fy",
    FIXTURE_NOW, // July-start FY -> FY-to-date starts 2026-07-01
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // Every fixture row from 2026-08-10 onward falls inside the July-start
  // FY-to-date window, so nothing is excluded by the FY boundary itself.
  assert.ok(result.points.length > 0);
  assert.ok(result.points.every((point) => point.date >= "2026-07-01"));
});

test("UI-018: loadOwnedPriceHistory -- downsampling caps a large in-range series to <= 400 points end-to-end", async () => {
  const db = await priceHistoryFixture();
  const values: string[] = [];
  for (let index = 0; index < 900; index += 1) {
    const ms = Date.UTC(2023, 0, 1) + index * 86_400_000;
    const date = new Date(ms).toISOString().slice(0, 10);
    values.push(
      `('price-bulk-${index}', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '${date}T14:00:00.000Z', '${date}', 'Australia/Sydney', 'AUD', '1.00', 'raw', 'observed', '${date}T14:00:00.000Z')`,
    );
  }
  db.exec(
    `INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at) VALUES ${values.join(",")};`,
  );
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "all",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.provenance.pointCountRaw > 400);
  assert.ok(result.provenance.pointCountReturned <= 400);
  assert.equal(result.points.length, result.provenance.pointCountReturned);
  assert.ok(result.provenance.bucketSize > 1);
});

test("UI-018 (review round-1 fix, B1, BLOCKING): a foreign-currency row sharing the security_id is EXCLUDED from the plotted series and disclosed, never mixed onto one line", async () => {
  const db = await priceHistoryFixture();
  // A USD row on the SAME security_id, inside the 'week' window -- a
  // realistic hazard (e.g. a mis-mapped provider row or a payout-adjacent
  // write sharing the identifier) that must never plot alongside the
  // AUD series as if it were the same unit.
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES ('price-usd-18', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-17T14:00:00.000Z', '2026-08-18', 'Australia/Sydney', 'USD', '13.00', 'raw', 'observed', '2026-08-18T00:00:00.000Z');
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.currencyCode, "AUD");
  // The USD row never appears in the plotted series at all.
  assert.ok(result.points.every((point) => point.currencyCode === "AUD"));
  assert.ok(!result.points.some((point) => point.date === "2026-08-18"));
  assert.equal(result.provenance.excludedCurrencyCount, 1);
});

test("UI-018 (review round-1 fix, B1): latestDelayed is also constrained to the holding's identity currency", async () => {
  const db = await priceHistoryFixture();
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('USD', 840, 'US dollar', 2, 1);
    -- A LATER USD delayed row than the fixture's AUD one (different
    -- market_date so it does not collide with Sharesight's one-row-per-day
    -- unique index) -- must not win latestDelayed.
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES ('price-usd-delayed', 'sharesight', 'user', 'user-a', 'user-a', 'mapping-sharesight', 'security-a', 'delayed', '2026-08-21T06:00:00.000Z', '2026-08-21', '+10:00', 'USD', '99.99', 'raw', 'observed', '2026-08-21T06:00:00.000Z');
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.latestDelayed);
  assert.equal(result.latestDelayed!.currencyCode, "AUD");
  assert.equal(result.latestDelayed!.priceDecimal, "20.05");
});

test("UI-018 (review round-1 fix, F3): the owner-visible scope predicate is pinned -- another user's user-scoped observation on THIS security never appears", async () => {
  const db = await priceHistoryFixture();
  // user-b's OWN user-scoped observation, but written against user-a's
  // security_id (e.g. a shared/duplicated security row in a future
  // multi-tenant scenario) -- same currency, same date range, so ONLY the
  // scope predicate can be responsible for excluding it.
  db.exec(`
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES ('price-cross-user', 'owner-import', 'user', 'user-b', 'user-b', 'mapping-owner-import', 'security-a', 'eod', '2026-08-18T14:00:00.000Z', '2026-08-18', 'Australia/Sydney', 'AUD', '999.99', 'raw', 'observed', '2026-08-18T00:00:00.000Z');
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(
    !result.points.some((point) => point.priceDecimal === "999.99"),
    "user-b's user-scoped observation must never appear in user-a's series",
  );
  assert.ok(!result.points.some((point) => point.date === "2026-08-18"));
});

test("UI-018 (review round-1 fix, F4): a malformed row in the window is excluded and disclosed, never silently dropped", async () => {
  const db = await priceHistoryFixture();
  // '13e1' is valid SQLite TEXT (no CHECK constrains close_decimal's
  // shape) but fails this module's own decimal-string validation
  // (exponent form) -- exactly the "passes the DB, fails the app
  // boundary" case AGENTS.md's "validate unknown at external boundaries"
  // rule exists for.
  db.exec(`
    INSERT INTO price_observations (id, provider_id, access_scope, scope_user_id, scope_key, mapping_id, security_id, interval, observation_at, market_date, market_timezone, currency_code, close_decimal, adjustment_state, quality, ingested_at)
    VALUES ('price-malformed-18', 'owner-import', 'user', 'user-a', 'user-a', 'mapping-owner-import', 'security-a', 'eod', '2026-08-17T14:00:00.000Z', '2026-08-18', 'Australia/Sydney', 'AUD', '13e1', 'raw', 'observed', '2026-08-18T00:00:00.000Z');
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(!result.points.some((point) => point.date === "2026-08-18"));
  assert.equal(result.provenance.excludedMalformedCount, 1);
});

// ---------------------------------------------------------------------------
// Part 7: rendered-markup assertions.
// ---------------------------------------------------------------------------

const CHART_COMPONENT_PATH = "../app/components/holding-price-chart.tsx";

test("UI-018: PriceHistoryChartView renders all eight range buttons with the right labels, in order", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "year",
    state: { status: "loading" },
    onRangeChange: () => {},
  });
  for (const label of [
    "Day",
    "Week",
    "Month",
    "YTD",
    "FY",
    "Year",
    "5 Year",
    "All",
  ]) {
    assert.ok(html.includes(`>${label}<`), `missing button label ${label}`);
  }
  const dayIndex = html.indexOf(">Day<");
  const allIndex = html.indexOf(">All<");
  assert.ok(
    dayIndex > 0 && dayIndex < allIndex,
    "buttons must render Day before All",
  );
});

test("UI-018: PriceHistoryChartView marks the active range with aria-pressed (text-not-color state)", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "5y",
    state: { status: "loading" },
    onRangeChange: () => {},
  });
  assert.match(html, /aria-pressed="true"[^>]*>5 Year</);
  assert.match(html, /aria-pressed="false"[^>]*>Day</);
});

test("UI-018: PriceHistoryChartView is aria-busy while loading and shows a loading message", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "year",
    state: { status: "loading" },
    onRangeChange: () => {},
  });
  assert.match(html, /aria-busy="true"/);
  assert.ok(html.includes("Loading price history"));
});

test("UI-018: PriceHistoryChartView renders an honest empty state for a loaded-but-empty series", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "ytd",
    state: {
      status: "loaded",
      currencyCode: "AUD",
      points: [],
      provenance: {
        providers: [],
        fromDate: null,
        toDate: null,
        pointCountRaw: 0,
        pointCountReturned: 0,
        bucketSize: 1,
        excludedCurrencyCount: 0,
        excludedMalformedCount: 0,
      },
      latestDelayed: null,
      invalidRangeRequested: false,
    },
    onRangeChange: () => {},
  });
  assert.match(html, /aria-busy="false"/);
  assert.ok(html.includes("No price history in this range."));
});

test("UI-018: PriceHistoryChartView renders the error state's message", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "year",
    state: { status: "error", message: "Price history could not be loaded." },
    onRangeChange: () => {},
  });
  assert.ok(html.includes("Price history unavailable"));
  assert.ok(html.includes("Price history could not be loaded."));
});

const ALL_RANGE_LOADED_PROPS = {
  symbol: "FMG",
  range: "all",
  state: {
    status: "loaded",
    currencyCode: "AUD",
    points: [
      {
        date: "1998-03-12",
        priceDecimal: "0.07852",
        currencyCode: "AUD",
        providerId: "owner-import",
        interval: "eod",
      },
      {
        date: "2026-08-20",
        priceDecimal: "20.05",
        currencyCode: "AUD",
        providerId: "sharesight",
        interval: "delayed",
      },
    ],
    provenance: {
      providers: ["owner-import", "sharesight"],
      fromDate: "1998-03-12",
      toDate: "2026-08-20",
      pointCountRaw: 7313,
      pointCountReturned: 400,
      bucketSize: 19,
      excludedCurrencyCount: 2,
      excludedMalformedCount: 1,
    },
    latestDelayed: {
      date: "2026-08-20",
      priceDecimal: "20.05",
      currencyCode: "AUD",
      providerId: "sharesight",
      interval: "delayed",
    },
    invalidRangeRequested: false,
  },
  onRangeChange: () => {},
};

test("UI-018: PriceHistoryChartView renders provenance (date range, point count, providers) and the delayed-quote disclosure compactly", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    ALL_RANGE_LOADED_PROPS,
  );
  // F6: the coverage line's dates use the SAME chartDate formatting as the
  // delayed-quote line, not raw ISO strings (the SVG's own aria-label is
  // unaffected -- F6 only asked for the visible coverage line).
  const coverageMatch = /<p class="chart-coverage">([\s\S]*?)<\/p>/.exec(html);
  assert.ok(coverageMatch, "chart-coverage paragraph must render");
  const coverageText = coverageMatch![1]!;
  assert.ok(coverageText.includes("12 Mar 1998"));
  assert.ok(coverageText.includes("20 Aug 2026"));
  assert.ok(!coverageText.includes("1998-03-12"));
  assert.ok(!coverageText.includes("2026-08-20"));
  assert.ok(html.includes("7313"));
  assert.ok(html.includes("400 shown"));
  assert.ok(html.includes("owner-import, sharesight"));
  assert.ok(html.includes("Delayed (Sharesight)"));
});

test("UI-018 (review round-1 fix, B1): PriceHistoryChartView shows the resolved currency code next to the price axis and the SVG's accessible label", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    ALL_RANGE_LOADED_PROPS,
  );
  assert.ok(html.includes("price-history-axis"));
  const axisMatch = /<div class="price-history-axis">([\s\S]*?)<\/div>/.exec(
    html,
  );
  assert.ok(axisMatch, "axis block must render");
  assert.ok(
    axisMatch![1]!.includes("AUD"),
    "axis prices must be labelled with the currency code -- no currency shown anywhere was the B1 complaint",
  );
  assert.ok(html.includes("price history in AUD"));
});

test("UI-018 (review round-1 fix, B1/F4): excluded off-currency and malformed row counts are disclosed in the rendered coverage line", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    ALL_RANGE_LOADED_PROPS,
  );
  assert.ok(html.includes("2 other-currency rows excluded"));
  assert.ok(html.includes("1 malformed row skipped"));
});

test("UI-018 (review round-2 fix, BLOCKING): a downsampled (bucketSize>1) gap segment's title never claims 'No observations between' -- that phrasing is reserved for an undownsampled series", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    ALL_RANGE_LOADED_PROPS, // bucketSize: 19, a genuine ~28-year gap between its 2 points
  );
  assert.ok(!html.includes("No observations between"));
  // Review round-3 fix: the title must NOT quote a numeric cadence figure
  // (the classification THRESHOLD, e.g. 76 days, is not this series' real
  // observed spacing, e.g. ~27 days -- stating it as "about one point per
  // N days" overstated sparsity ~2.8x). State the comparison, not a number.
  assert.ok(!html.includes("about one point per"));
  assert.ok(
    // React escapes the apostrophe in "series'" to `&#x27;` in the
    // rendered SVG <title> text node.
    html.includes(
      "Downsampled: a hole in the stored data wider than this series&#x27; sampling spacing (between 1998-03-12 and 2026-08-20).",
    ),
    "a downsampled gap's title must state the comparison honestly, never claim certainty about zero raw rows or a fabricated cadence figure",
  );
});

test("UI-018 (review round-2 fix): an UNDOWNSAMPLED (bucketSize=1) gap segment keeps the 'No observations between' title", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "day",
    state: {
      status: "loaded",
      currencyCode: "AUD",
      points: [
        {
          date: "2018-01-01",
          priceDecimal: "1.00",
          currencyCode: "AUD",
          providerId: "owner-import",
          interval: "eod",
        },
        {
          date: "2026-01-01",
          priceDecimal: "2.00",
          currencyCode: "AUD",
          providerId: "owner-import",
          interval: "eod",
        },
      ],
      provenance: {
        providers: ["owner-import"],
        fromDate: "2018-01-01",
        toDate: "2026-01-01",
        pointCountRaw: 2,
        pointCountReturned: 2,
        bucketSize: 1,
        excludedCurrencyCount: 0,
        excludedMalformedCount: 0,
      },
      latestDelayed: null,
      invalidRangeRequested: false,
    },
    onRangeChange: () => {},
  });
  assert.ok(html.includes("No observations between 2018-01-01 and 2026-01-01"));
  assert.ok(!html.includes("Downsampled:"));
});

test("UI-018 (review round-1 fix, F2): the delayed-quote label is DERIVED from providerId, never hardcoded to Sharesight", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "year",
    state: {
      status: "loaded",
      currencyCode: "AUD",
      // At least one plottable point -- an EMPTY series takes ChartBody's
      // early "No price history" return, which would never reach the
      // latestDelayed line this test is actually about.
      points: [
        {
          date: "2026-08-20",
          priceDecimal: "1.23",
          currencyCode: "AUD",
          providerId: "future-feed",
          interval: "delayed",
        },
      ],
      provenance: {
        providers: ["future-feed"],
        fromDate: "2026-08-20",
        toDate: "2026-08-20",
        pointCountRaw: 1,
        pointCountReturned: 1,
        bucketSize: 1,
        excludedCurrencyCount: 0,
        excludedMalformedCount: 0,
      },
      latestDelayed: {
        date: "2026-08-20",
        priceDecimal: "1.23",
        currencyCode: "AUD",
        providerId: "future-feed",
        interval: "delayed",
      },
      invalidRangeRequested: false,
    },
    onRangeChange: () => {},
  });
  assert.ok(html.includes("Delayed (Future Feed)"));
  assert.ok(!html.includes("Sharesight"));
});

test("UI-018: PriceHistoryChartView discloses an invalid-range fallback honestly", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "year",
    state: {
      status: "loaded",
      currencyCode: "AUD",
      points: [
        {
          date: "2026-08-20",
          priceDecimal: "20.05",
          currencyCode: "AUD",
          providerId: "sharesight",
          interval: "delayed",
        },
      ],
      provenance: {
        providers: ["sharesight"],
        fromDate: "2026-08-20",
        toDate: "2026-08-20",
        pointCountRaw: 1,
        pointCountReturned: 1,
        bucketSize: 1,
        excludedCurrencyCount: 0,
        excludedMalformedCount: 0,
      },
      latestDelayed: null,
      invalidRangeRequested: true,
    },
    onRangeChange: () => {},
  });
  assert.ok(html.includes("was not recognised"));
});

test("UI-018: the range-controls CSS declares a 44px-minimum hit target (reused by this chart's buttons)", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const match = /\.range-controls button\s*{([^}]*)}/.exec(css);
  assert.ok(match, ".range-controls button rule must exist");
  assert.match(match![1]!, /min-width:\s*(4[4-9]|[5-9]\d|\d{3,})px/);
  assert.match(match![1]!, /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/);
});

test("UI-018: the price-history CSS mirrors gap segments with a dashed line, not color alone", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.ok(css.includes(".price-history-gap"));
  assert.match(
    css,
    /\.price-history-line\.price-history-gap\s*{[^}]*stroke-dasharray/,
  );
});

// ---------------------------------------------------------------------------
// Part 8: dialog wiring -- source-level assertions (portfolio-shell.tsx).
// ---------------------------------------------------------------------------

test("UI-018/UI-023: the holding Details screen mounts HoldingPriceChart under the facts dl, before the dividends link", async () => {
  // UI-023 moved the chart's mount point from the shell's holding <dialog>
  // to the standalone Details screen; ordering and wiring are preserved.
  const source = await readFile(
    new URL("../app/components/holding-detail.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.includes(
      'import { HoldingPriceChart } from "./holding-price-chart";',
    ),
  );
  const anchor = source.indexOf("Average cost");
  const mountIndex = source.indexOf("<HoldingPriceChart");
  const dividendsLinkIndex = source.indexOf("View dividends");
  assert.ok(
    anchor > 0 && mountIndex > anchor,
    "chart must mount after the Average cost dl",
  );
  assert.ok(
    mountIndex < dividendsLinkIndex,
    "chart should render before the dividends link",
  );
  assert.ok(source.includes("portfolioSecurityId={portfolioSecurityId}"));
});

// ---------------------------------------------------------------------------
// Part 9: QA-001A matrix + self-check.
// ---------------------------------------------------------------------------

test("UI-018: the QA-001A matrix mentions the new price-history route and its owner-scoping", async () => {
  const matrix = await readFile(
    new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
    "utf8",
  );
  for (const needle of [
    "price-history",
    "priceHistoryAction",
    "loadOwnedPriceHistory",
    "tests/ui-018.test.ts",
  ]) {
    assert.ok(matrix.includes(needle), `matrix should mention ${needle}`);
  }
});

test("UI-018: every matrix citation naming tests/ui-018.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/ui-018.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/ui-018\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
  const quotedStringPattern = /"(?:[^"\\]|\\.)*"/g;
  let groupCount = 0;
  let titleCount = 0;
  for (const match of matrix.matchAll(citationGroupPattern)) {
    groupCount += 1;
    const titles = match[2]!.match(quotedStringPattern) ?? [];
    for (const quoted of titles) {
      titleCount += 1;
      const title = quoted.slice(1, -1);
      assert.ok(
        ownSource.includes(title),
        `matrix cites "${title}" in tests/ui-018.test.ts, but that title is not a literal substring of the file's source (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount >= 1, "expected at least 1 citation group to check");
  assert.ok(titleCount >= 1, "expected at least 1 quoted title to check");
});

test("UI-018: MARKET_DATA_STRATEGY documents the chart's selection/downsampling honesty", async () => {
  const doc = await readFile(
    new URL("../docs/MARKET_DATA_STRATEGY.md", import.meta.url),
    "utf8",
  );
  assert.ok(doc.includes("UI-018"));
  assert.ok(doc.toLowerCase().includes("downsampl"));
});

// ---------------------------------------------------------------------------
// Part 10 (MKT-011B): today graph from the intraday cache.
// ---------------------------------------------------------------------------

/** Links `security-a` to an ASX exchange row (`Australia/Sydney`) -- the
 * fixture's securities have no exchange linked by default (UI-018 never
 * needed one), but MKT-011B's "today" derivation for the intraday overlay
 * specifically requires `exchanges.timezone` (see
 * `domain/market-data/daily-capture-window.ts`). */
const LINK_ASX_EXCHANGE_SQL = `
  INSERT INTO exchanges (id, mic, name, country_code, timezone, default_currency_code, calendar_code, is_active)
  VALUES ('exchange-asx', 'XASX', 'ASX', 'AU', 'Australia/Sydney', 'AUD', 'ASX', 1);
  UPDATE securities SET exchange_id = 'exchange-asx' WHERE id = 'security-a';
`;

test("MKT-011B: loadOwnedPriceHistory returns today's cached intraday ticks as an ordered 'intraday' series, and DROPS the same-day historical winner (dedupe)", async () => {
  const db = await priceHistoryFixture();
  db.exec(LINK_ASX_EXCHANGE_SQL);
  // Two intraday ticks for TODAY (2026-08-20, matching FIXTURE_NOW =
  // 16:00 Sydney) -- coexisting with the fixture's OWN sharesight
  // 'delayed' price_observations row for the SAME date (price-delayed-20),
  // exactly the "rollup hasn't purged yet" hazard the dedupe rule exists
  // for.
  db.exec(`
    INSERT INTO intraday_price_points (id, user_id, security_id, provider_id, price_decimal, currency_code, market_date, market_timezone, observed_at, captured_at, delayed_minutes, quality, provider_revision_id)
    VALUES
      ('intraday-1', 'user-a', 'security-a', 'sharesight', '20.10', 'AUD', '2026-08-20', '+10:00', '2026-08-20T04:00:00.000Z', '2026-08-20T04:00:05.000Z', NULL, 'observed', NULL),
      ('intraday-2', 'user-a', 'security-a', 'sharesight', '20.30', 'AUD', '2026-08-20', '+10:00', '2026-08-20T05:30:00.000Z', '2026-08-20T05:30:05.000Z', NULL, 'observed', NULL);
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.todayMarketDate, "2026-08-20");
  assert.deepEqual(
    result.todayPoints.map((point) => [point.priceDecimal, point.interval]),
    [
      ["20.10", "intraday"],
      ["20.30", "intraday"],
    ],
    "today's ticks must be ordered by observation time, tagged 'intraday'",
  );
  // Dedupe: the historical winner series must NEVER include 2026-08-20 --
  // it is now represented exclusively by `todayPoints`.
  assert.ok(
    !result.points.some((point) => point.date === "2026-08-20"),
    "the same-day historical point must be dropped once intraday data exists for that date",
  );
  assert.deepEqual(
    result.points.map((point) => point.date),
    ["2026-08-14", "2026-08-19"],
  );
  assert.equal(result.provenance.todayExcludedCurrencyCount, 0);
  assert.equal(result.provenance.todayExcludedMalformedCount, 0);
});

test("MKT-011B: an empty intraday day renders the historical series unchanged -- no fabricated today point, honest empty overlay", async () => {
  const db = await priceHistoryFixture();
  db.exec(LINK_ASX_EXCHANGE_SQL);
  // No `intraday_price_points` rows inserted at all -- market closed,
  // capture not yet run, or the source disabled all read identically as
  // "nothing cached".
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.todayMarketDate, "2026-08-20");
  assert.deepEqual(result.todayPoints, []);
  // The historical series is UNCHANGED from the plain "week" range
  // baseline (no dedupe triggers when there is nothing to dedupe against)
  // -- including the fixture's own same-day sharesight delayed row.
  assert.deepEqual(
    result.points.map((point) => point.date),
    ["2026-08-14", "2026-08-19", "2026-08-20"],
  );
});

test("MKT-011B: an unresolvable security market timezone (no exchange linked) leaves todayMarketDate honestly null, never a guessed date", async () => {
  const db = await priceHistoryFixture();
  // Deliberately NOT linking an exchange -- `security-a.exchange_id` stays
  // NULL, matching this fixture's default shape.
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.todayMarketDate, null);
  assert.deepEqual(result.todayPoints, []);
});

test("MKT-011B: loadOwnedPriceHistory's intraday overlay is owner-scoped -- another user's cached intraday tick for the SAME security never appears in this owner's today series", async () => {
  const db = await priceHistoryFixture();
  db.exec(LINK_ASX_EXCHANGE_SQL);
  db.exec(`
    INSERT INTO intraday_price_points (id, user_id, security_id, provider_id, price_decimal, currency_code, market_date, market_timezone, observed_at, captured_at, delayed_minutes, quality, provider_revision_id)
    VALUES
      ('intraday-owner', 'user-a', 'security-a', 'sharesight', '20.10', 'AUD', '2026-08-20', '+10:00', '2026-08-20T04:00:00.000Z', '2026-08-20T04:00:05.000Z', NULL, 'observed', NULL),
      ('intraday-cross-user', 'user-b', 'security-a', 'sharesight', '999.99', 'AUD', '2026-08-20', '+10:00', '2026-08-20T04:05:00.000Z', '2026-08-20T04:05:05.000Z', NULL, 'observed', NULL);
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.todayPoints.map((point) => point.priceDecimal),
    ["20.10"],
    "user-b's cached intraday tick must never appear in user-a's today series",
  );

  // Pin the SAME guarantee directly at the repository boundary.
  const directForUserA = await listOwnedIntradayPricePointsForDate(client, {
    userId: "user-a",
    securityId: "security-a",
    marketDate: "2026-08-20",
  });
  assert.ok(directForUserA);
  assert.equal(directForUserA.points.length, 1);
  assert.equal(directForUserA.points[0]!.priceDecimal, "20.10");
  const directForUserB = await listOwnedIntradayPricePointsForDate(client, {
    userId: "user-b",
    securityId: "security-a",
    marketDate: "2026-08-20",
  });
  assert.ok(directForUserB);
  assert.equal(directForUserB.points.length, 1);
  assert.equal(directForUserB.points[0]!.priceDecimal, "999.99");
});

test("MKT-011B: an intraday price decimal string round-trips through the loader EXACTLY -- no float drift on a value beyond the usual 2-decimal precision", async () => {
  const db = await priceHistoryFixture();
  db.exec(LINK_ASX_EXCHANGE_SQL);
  db.exec(`
    INSERT INTO intraday_price_points (id, user_id, security_id, provider_id, price_decimal, currency_code, market_date, market_timezone, observed_at, captured_at, delayed_minutes, quality, provider_revision_id)
    VALUES ('intraday-precise', 'user-a', 'security-a', 'sharesight', '20.123456', 'AUD', '2026-08-20', '+10:00', '2026-08-20T04:00:00.000Z', '2026-08-20T04:00:05.000Z', NULL, 'observed', NULL);
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.todayPoints[0]!.priceDecimal, "20.123456");
});

test("MKT-011B: a today intraday row in a DIFFERENT currency is excluded from the overlay and disclosed, never mixed onto the historical-currency line", async () => {
  const db = await priceHistoryFixture();
  db.exec(LINK_ASX_EXCHANGE_SQL);
  db.exec(`
    INSERT INTO currencies (code, numeric_code, name, minor_unit_digits, is_active)
    VALUES ('USD', 840, 'US dollar', 2, 1);
    INSERT INTO intraday_price_points (id, user_id, security_id, provider_id, price_decimal, currency_code, market_date, market_timezone, observed_at, captured_at, delayed_minutes, quality, provider_revision_id)
    VALUES ('intraday-usd', 'user-a', 'security-a', 'sharesight', '13.00', 'USD', '2026-08-20', '+10:00', '2026-08-20T04:00:00.000Z', '2026-08-20T04:00:05.000Z', NULL, 'observed', NULL);
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.todayPoints, []);
  assert.equal(result.provenance.todayExcludedCurrencyCount, 1);
});

test("MKT-011B review follow-up F6: a malformed intraday price row is excluded from today's overlay and disclosed via todayExcludedMalformedCount, never silently dropped", async () => {
  const db = await priceHistoryFixture();
  db.exec(LINK_ASX_EXCHANGE_SQL);
  // '13e1' is valid SQLite TEXT (no CHECK constrains price_decimal's shape)
  // but fails this repository's own decimal-string validation (exponent
  // form) -- the same "passes the DB, fails the app boundary" case as the
  // historical series' F4 test above.
  db.exec(`
    INSERT INTO intraday_price_points (id, user_id, security_id, provider_id, price_decimal, currency_code, market_date, market_timezone, observed_at, captured_at, delayed_minutes, quality, provider_revision_id)
    VALUES ('intraday-malformed', 'user-a', 'security-a', 'sharesight', '13e1', 'AUD', '2026-08-20', '+10:00', '2026-08-20T04:00:00.000Z', '2026-08-20T04:00:05.000Z', NULL, 'observed', NULL);
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.todayPoints, []);
  assert.equal(result.provenance.todayExcludedMalformedCount, 1);
});

const TODAY_OVERLAY_LOADED_PROPS = {
  symbol: "FMG",
  range: "week",
  state: {
    status: "loaded",
    currencyCode: "AUD",
    points: [
      {
        date: "2026-08-19",
        priceDecimal: "19.90",
        currencyCode: "AUD",
        providerId: "owner-import",
        interval: "eod",
      },
    ],
    provenance: {
      providers: ["owner-import"],
      fromDate: "2026-08-19",
      toDate: "2026-08-19",
      pointCountRaw: 1,
      pointCountReturned: 1,
      bucketSize: 1,
      excludedCurrencyCount: 0,
      excludedMalformedCount: 0,
      todayExcludedCurrencyCount: 0,
      todayExcludedMalformedCount: 0,
    },
    latestDelayed: null,
    invalidRangeRequested: false,
    todayMarketDate: "2026-08-20",
    todayPoints: [
      {
        date: "2026-08-20",
        priceDecimal: "20.10",
        currencyCode: "AUD",
        providerId: "sharesight",
        interval: "intraday",
      },
      {
        date: "2026-08-20",
        priceDecimal: "20.30",
        currencyCode: "AUD",
        providerId: "sharesight",
        interval: "intraday",
      },
    ],
  },
  onRangeChange: () => {},
};

test("MKT-011B: PriceHistoryChartView renders today's intraday overlay as delineated diamond markers on a dashed line, distinct from the historical series, with accessible delayed provenance and never a 'live'/'close' claim", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    TODAY_OVERLAY_LOADED_PROPS,
  );
  assert.ok(html.includes("price-history-intraday-line"));
  assert.ok(html.includes("price-history-intraday-dot"));
  assert.ok(html.includes("price-history-intraday-latest"));
  assert.ok(
    html.includes("intraday capture, delayed -- not a close"),
    "the overlay's accessible <title> must explain what the series is, not a close",
  );
  assert.ok(html.includes("not a close"));
  assert.ok(!html.toLowerCase().includes("live"));
  // React escapes the apostrophe in "today's" to `&#x27;` in the rendered
  // attribute value (same escaping precedent as the gap-title text-node
  // assertions elsewhere in this file).
  assert.ok(html.includes("includes today&#x27;s intraday capture"));
});

test("MKT-011B: PriceHistoryChartView renders NO intraday overlay when today's series is empty -- historical-only, no fabricated today text", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    ALL_RANGE_LOADED_PROPS, // no todayPoints field at all -- defaults to empty
  );
  assert.ok(!html.includes("price-history-intraday-dot"));
  assert.ok(!html.includes("price-history-intraday-line"));
  assert.ok(!html.includes("captured -- not a close"));
});

test("MKT-011B (review round-1 fix, B1, BLOCKING): PriceHistoryChartView discloses today's exclusion counts even when EVERY intraday tick was excluded -- an all-excluded day must NOT render pixel-identical to 'nothing captured today'", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "week",
    state: {
      status: "loaded",
      currencyCode: "AUD",
      points: [
        {
          date: "2026-08-19",
          priceDecimal: "19.90",
          currencyCode: "AUD",
          providerId: "owner-import",
          interval: "eod",
        },
      ],
      provenance: {
        providers: ["owner-import"],
        fromDate: "2026-08-19",
        toDate: "2026-08-19",
        pointCountRaw: 1,
        pointCountReturned: 1,
        bucketSize: 1,
        excludedCurrencyCount: 0,
        excludedMalformedCount: 0,
        // Every cached tick for today was excluded (off-currency and/or
        // malformed) -- `todayPoints` is empty (no surviving point), but
        // these counts must still surface.
        todayExcludedCurrencyCount: 2,
        todayExcludedMalformedCount: 1,
      },
      latestDelayed: null,
      invalidRangeRequested: false,
      todayMarketDate: "2026-08-20",
      todayPoints: [],
    },
    onRangeChange: () => {},
  });
  // No plottable overlay (nothing survived to plot) -- but the paragraph
  // itself, and both exclusion counts, must still render.
  assert.ok(!html.includes("price-history-intraday-dot"));
  assert.ok(html.includes("no plottable intraday points captured"));
  assert.ok(html.includes("2 other-currency rows excluded"));
  assert.ok(html.includes("1 malformed row skipped"));
});

test("MKT-011B: the intraday overlay CSS is distinguished by SHAPE and dash pattern, not color alone", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.ok(css.includes(".price-history-intraday-dot"));
  assert.ok(css.includes(".price-history-intraday-line"));
  assert.match(css, /\.price-history-intraday-line\s*{[^}]*stroke-dasharray/);
});

test("MKT-011B: MARKET_DATA_STRATEGY documents the intraday overlay's today-derivation, empty-state honesty, and same-day dedupe choice", async () => {
  const doc = await readFile(
    new URL("../docs/MARKET_DATA_STRATEGY.md", import.meta.url),
    "utf8",
  );
  assert.ok(doc.includes("MKT-011B"));
  assert.ok(doc.toLowerCase().includes("dedupe"));
  assert.ok(doc.toLowerCase().includes("intraday"));
});

// ---------------------------------------------------------------------------
// Part 11 (MKT-011C): true intraday time axis for the today overlay.
// ---------------------------------------------------------------------------

/** Builds a UTC `observedAt` ISO instant at `minutes` past midnight on
 * `date` -- lets these tests express "10:25" / "16:25" (the capture
 * window's own boundary minutes) directly, using `marketTimezone: "UTC"` so
 * the local time equals the UTC clock time with no offset arithmetic to get
 * wrong in the test itself. */
function isoAtUtcMinutes(date: string, minutes: number): string {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `${date}T${hh}:${mm}:00.000Z`;
}

test("MKT-011C: positionTodayPointsByObservedTime places the window-OPEN and window-CLOSE ticks at the column's own edges, and a midpoint tick exactly halfway", () => {
  const midpointMinutes = (WINDOW_OPEN_MINUTES + WINDOW_CLOSE_MINUTES) / 2;
  const points = [
    {
      date: "2026-08-20",
      priceDecimal: "20.00",
      observedAt: isoAtUtcMinutes("2026-08-20", WINDOW_OPEN_MINUTES),
    },
    {
      date: "2026-08-20",
      priceDecimal: "20.10",
      observedAt: isoAtUtcMinutes("2026-08-20", midpointMinutes),
    },
    {
      date: "2026-08-20",
      priceDecimal: "20.20",
      observedAt: isoAtUtcMinutes("2026-08-20", WINDOW_CLOSE_MINUTES),
    },
  ];
  const positioned = positionTodayPointsByObservedTime(
    points,
    [50, 60, 70],
    "UTC",
    { startX: 100, width: 200 },
    { minX: 0, maxX: 1000 },
  );
  assert.equal(positioned.length, 3);
  assert.equal(positioned[0]?.x, 100, "10:25 lands at the column start");
  assert.equal(positioned[0]?.withinCaptureWindow, true);
  assert.equal(positioned[1]?.x, 200, "the midpoint lands exactly halfway");
  assert.equal(positioned[2]?.x, 300, "16:25 lands at the column end");
  assert.equal(positioned[2]?.withinCaptureWindow, true);
  // The Y values the caller supplies (already derived from the SHARED price
  // domain elsewhere) pass through untouched -- this function only ever
  // repositions X.
  assert.deepEqual(
    positioned.map((point) => point?.y),
    [50, 60, 70],
  );
});

test("MKT-011C: positionTodayPointsByObservedTime CLAMPS an out-of-window tick to the nearest window edge rather than excluding it -- a real captured observation is never dropped from the chart", () => {
  const beforeOpen = isoAtUtcMinutes("2026-08-20", WINDOW_OPEN_MINUTES - 30);
  const afterClose = isoAtUtcMinutes("2026-08-20", WINDOW_CLOSE_MINUTES + 45);
  const positioned = positionTodayPointsByObservedTime(
    [
      { date: "2026-08-20", priceDecimal: "20.00", observedAt: beforeOpen },
      { date: "2026-08-20", priceDecimal: "20.10", observedAt: afterClose },
    ],
    [10, 20],
    "UTC",
    { startX: 100, width: 200 },
    { minX: 0, maxX: 1000 },
  );
  assert.equal(
    positioned.length,
    2,
    "both ticks are still returned -- clamped, never excluded",
  );
  assert.equal(positioned[0]?.x, 100, "clamped to the window-OPEN edge");
  assert.equal(positioned[0]?.withinCaptureWindow, false);
  assert.equal(positioned[1]?.x, 300, "clamped to the window-CLOSE edge");
  assert.equal(positioned[1]?.withinCaptureWindow, false);
});

test("MKT-011C: positionTodayPointsByObservedTime returns null (never throws, never guesses) for an unresolvable timezone or a malformed observedAt", () => {
  const badTimezone = positionTodayPointsByObservedTime(
    [
      {
        date: "2026-08-20",
        priceDecimal: "20.00",
        observedAt: isoAtUtcMinutes("2026-08-20", WINDOW_OPEN_MINUTES),
      },
    ],
    [10],
    "Not/AZone",
    { startX: 100, width: 200 },
    { minX: 0, maxX: 1000 },
  );
  assert.deepEqual(badTimezone, [null]);

  const badObservedAt = positionTodayPointsByObservedTime(
    [
      {
        date: "2026-08-20",
        priceDecimal: "20.00",
        observedAt: "not-a-timestamp",
      },
    ],
    [10],
    "UTC",
    { startX: 100, width: 200 },
    { minX: 0, maxX: 1000 },
  );
  assert.deepEqual(badObservedAt, [null]);
});

test("MKT-011C review round-1 fix (F1/F6, BLOCKING): positionTodayPointsByObservedTime REJECTS a column that does not overlap bounds at all -- returns null for every point rather than bounds-clamping them all onto one misleading pixel with withinCaptureWindow left true", () => {
  // Reproduces the exact reviewer-caught shape: a caller-side sizing bug
  // (WEEK's per-day column math applied to a single-date domain) computed
  // `startX = 8 - 584 = -576`, a column that runs entirely to the LEFT of
  // the plot's own bounds ([8, 592]) -- the window-open point (fraction 0)
  // would otherwise land at -576, clamped to 8, and the window-close point
  // (fraction 1) would ALSO land at 8 (-576 + 584), stacking every tick
  // onto one pixel while `withinCaptureWindow` stayed `true` for an
  // ordinary in-window observation (a pixel-bounds clamp is not a
  // capture-window clamp).
  const points = [
    {
      date: "2026-08-20",
      priceDecimal: "20.00",
      observedAt: isoAtUtcMinutes("2026-08-20", WINDOW_OPEN_MINUTES),
    },
    {
      date: "2026-08-20",
      priceDecimal: "20.10",
      observedAt: isoAtUtcMinutes("2026-08-20", WINDOW_CLOSE_MINUTES),
    },
  ];
  const nonOverlapping = positionTodayPointsByObservedTime(
    points,
    [10, 20],
    "UTC",
    { startX: -576, width: 584 },
    { minX: 8, maxX: 592 },
  );
  assert.deepEqual(
    nonOverlapping,
    [null, null],
    "a column entirely outside bounds must be rejected wholesale, never silently clamped",
  );

  // A column that only PARTIALLY overlaps bounds is not rejected -- only a
  // column with ZERO overlap is treated as a caller-side sizing bug.
  const partiallyOverlapping = positionTodayPointsByObservedTime(
    points,
    [10, 20],
    "UTC",
    { startX: -100, width: 200 },
    { minX: 8, maxX: 592 },
  );
  assert.notEqual(partiallyOverlapping[0], null);
  assert.notEqual(partiallyOverlapping[1], null);
});

test("MKT-011C: calendarColumnWidth sizes ONE calendar day within a multi-day date-offset domain, and falls back to the full inner width for a single-day or empty domain", () => {
  const scale = { width: 600, height: 160, paddingX: 8, paddingY: 10 };
  assert.equal(
    calendarColumnWidth(["2026-08-14", "2026-08-20"], scale),
    (600 - 8 * 2) / 6,
  );
  assert.equal(
    calendarColumnWidth(["2026-08-20"], scale),
    600 - 8 * 2,
    "a single-day domain falls back to the full inner width",
  );
  assert.equal(
    calendarColumnWidth([], scale),
    600 - 8 * 2,
    "an empty domain falls back to the full inner width, never a division by zero",
  );
});

test("MKT-011C: loadOwnedPriceHistory plumbs observedAt/quality through today's points and returns the security's own market timezone", async () => {
  const db = await priceHistoryFixture();
  db.exec(LINK_ASX_EXCHANGE_SQL);
  db.exec(`
    INSERT INTO intraday_price_points (id, user_id, security_id, provider_id, price_decimal, currency_code, market_date, market_timezone, observed_at, captured_at, delayed_minutes, quality, provider_revision_id)
    VALUES ('intraday-quality', 'user-a', 'security-a', 'sharesight', '20.10', 'AUD', '2026-08-20', '+10:00', '2026-08-20T05:00:00.000Z', '2026-08-20T05:00:05.000Z', NULL, 'stale_candidate', NULL);
  `);
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.marketTimezone, "Australia/Sydney");
  assert.equal(result.todayPoints.length, 1);
  assert.equal(result.todayPoints[0]?.observedAt, "2026-08-20T05:00:00.000Z");
  assert.equal(result.todayPoints[0]?.quality, "stale_candidate");
  assert.equal(result.latestDelayed?.observedAt, "2026-08-20T05:55:00.000Z");
  assert.equal(result.latestDelayed?.quality, "observed");
});

test("MKT-011C: loadOwnedPriceHistory's marketTimezone is honestly null when the security's exchange is unresolved", async () => {
  const db = await priceHistoryFixture();
  const client = createSqliteSqlClient(db);
  const result = await loadOwnedPriceHistory(
    client,
    "user-a",
    "portfolio-a",
    "membership-a",
    "week",
    FIXTURE_NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.marketTimezone, null);
});

const DAY_RANGE_TODAY_POINTS = [
  {
    date: "2026-08-20",
    priceDecimal: "20.10",
    currencyCode: "AUD",
    providerId: "sharesight",
    interval: "intraday",
    observedAt: isoAtUtcMinutes("2026-08-20", WINDOW_OPEN_MINUTES),
    quality: "observed",
  },
  {
    date: "2026-08-20",
    priceDecimal: "20.30",
    currencyCode: "AUD",
    providerId: "sharesight",
    interval: "intraday",
    observedAt: isoAtUtcMinutes("2026-08-20", WINDOW_CLOSE_MINUTES),
    quality: "observed",
  },
];

function todayOnlyChartProps(range: string, todayPoints: unknown[]) {
  return {
    symbol: "FMG",
    range,
    state: {
      status: "loaded",
      currencyCode: "AUD",
      points: [],
      provenance: {
        providers: [],
        fromDate: null,
        toDate: null,
        pointCountRaw: 0,
        pointCountReturned: 0,
        bucketSize: 1,
        excludedCurrencyCount: 0,
        excludedMalformedCount: 0,
        todayExcludedCurrencyCount: 0,
        todayExcludedMalformedCount: 0,
      },
      latestDelayed: null,
      invalidRangeRequested: false,
      todayMarketDate: "2026-08-20",
      todayPoints,
      marketTimezone: "UTC",
    },
    onRangeChange: () => {},
  };
}

test("MKT-011C: on the DAY range, today's intraday ticks plot at their real observed time across the FULL plot width (the 10:25-16:25 window)", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    todayOnlyChartProps("day", DAY_RANGE_TODAY_POINTS),
  );
  // CHART_PADDING_X is 8 -- the window-open tick's rect x is 8 - 2.5 = 5.5;
  // the window-close tick's rect x is (600 - 8) - 2.5 = 589.5 (the FULL
  // plot width represents the window on the "day" range).
  assert.ok(html.includes('x="5.5"'), "window-open tick at the left edge");
  assert.ok(html.includes('x="589.5"'), "window-close tick at the right edge");
  assert.ok(html.includes("10:25 market-local"));
  assert.ok(html.includes("16:25 market-local"));
});

test("MKT-011C: an out-of-window intraday tick on the DAY range is still rendered (clamped, not excluded) and its title discloses the clamp -- honest, never a silently dropped real observation", () => {
  const clampedPoints = [
    ...DAY_RANGE_TODAY_POINTS,
    {
      date: "2026-08-20",
      priceDecimal: "20.50",
      currencyCode: "AUD",
      providerId: "sharesight",
      interval: "intraday",
      observedAt: isoAtUtcMinutes("2026-08-20", WINDOW_CLOSE_MINUTES + 20),
      quality: "observed",
    },
  ];
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    todayOnlyChartProps("day", clampedPoints),
  );
  // Three diamonds still render -- nothing was dropped.
  const dotCount = (html.match(/price-history-intraday-dot/g) ?? []).length;
  assert.ok(dotCount >= 3, "every captured tick still renders");
  assert.ok(
    html.includes(
      "outside the 10:25-16:25 capture window -- shown at the nearest window edge",
    ),
  );
});

test("MKT-011C: a 'stale_candidate'/'indicative' quality-tier tick renders with a distinct HOLLOW/dashed marker class AND a textual caveat, never color alone (QA-001B) -- an 'observed' tick gets neither", () => {
  const mixedQualityPoints = [
    DAY_RANGE_TODAY_POINTS[0]!,
    {
      ...DAY_RANGE_TODAY_POINTS[1]!,
      quality: "stale_candidate",
    },
  ];
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    todayOnlyChartProps("day", mixedQualityPoints),
  );
  assert.ok(html.includes("price-history-intraday-uncertain"));
  assert.ok(html.includes("stale candidate -- not a freshly confirmed price"));
});

test("MKT-011C: a 'corrected' tick gets its own textual caveat but keeps the ORDINARY filled marker -- a correction is more trustworthy than 'observed', not less, so it must not render as 'uncertain'", () => {
  const correctedPoints = [
    DAY_RANGE_TODAY_POINTS[0]!,
    {
      ...DAY_RANGE_TODAY_POINTS[1]!,
      quality: "corrected",
    },
  ];
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    todayOnlyChartProps("day", correctedPoints),
  );
  assert.ok(
    !html.includes("price-history-intraday-uncertain"),
    "'corrected' must not get the hollow/dashed 'uncertain' marker class",
  );
  assert.ok(
    html.includes("corrected"),
    "the 'corrected' tier is still named in the tick's own accessible title",
  );
});

test("MKT-011C: on the WEEK range, today's intraday ticks are spread within today's OWN calendar-day column, narrower than the full plot width and never bleeding into a neighbouring day", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "week",
    state: {
      status: "loaded",
      currencyCode: "AUD",
      points: [
        {
          date: "2026-08-14",
          priceDecimal: "19.40",
          currencyCode: "AUD",
          providerId: "owner-import",
          interval: "eod",
        },
      ],
      provenance: {
        providers: ["owner-import"],
        fromDate: "2026-08-14",
        toDate: "2026-08-14",
        pointCountRaw: 1,
        pointCountReturned: 1,
        bucketSize: 1,
        excludedCurrencyCount: 0,
        excludedMalformedCount: 0,
        todayExcludedCurrencyCount: 0,
        todayExcludedMalformedCount: 0,
      },
      latestDelayed: null,
      invalidRangeRequested: false,
      todayMarketDate: "2026-08-20",
      todayPoints: DAY_RANGE_TODAY_POINTS,
      marketTimezone: "UTC",
    },
    onRangeChange: () => {},
  });
  // The combined domain spans 2026-08-14..2026-08-20 (6 calendar days), so
  // one day's column is (600 - 8*2) / 6 = 97.33333... px, ENDING exactly at
  // today's own date position (592, the rightmost plot edge -- see
  // `calendarColumnWidth`'s doc comment). The window-CLOSE tick (16:25)
  // therefore lands exactly at 592 (rect x = 589.5, the SAME pixel the
  // pre-MKT-011C shared-column marker used to occupy); the window-OPEN
  // tick (10:25) lands a full column-width to the LEFT of that, at
  // 592 - 97.33333... = 494.66666...  (rect x = 492.16666...).
  assert.ok(
    html.includes('x="589.5"'),
    "the window-close tick still lands at today's own date position",
  );
  assert.ok(
    html.includes('x="492.1666666666667"'),
    "the window-open tick lands one day-column-width to the left, not at the day chart's full-width left edge (5.5)",
  );
  assert.ok(
    !html.includes('x="5.5"'),
    "the week range must NOT use the day range's full-width left edge",
  );
});

test("MKT-011C review round-1 fix (F1, BLOCKING): on the WEEK range, when the combined domain spans a SINGLE calendar date (a brand-new holding, or MKT-011B's dedupe removing the only historical point), today's ticks fall back to the FULL plot width and genuinely SPREAD, instead of collapsing onto one bounds-clamped pixel", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    todayOnlyChartProps("week", DAY_RANGE_TODAY_POINTS),
  );
  // Same expectation as the DAY range's full-width test: the window-open
  // tick at the left edge (rect x = 5.5) and the window-close tick at the
  // right edge (rect x = 589.5) -- two DISTINCT x values, not one stacked
  // pixel.
  assert.ok(
    html.includes('x="5.5"'),
    "the window-open tick spreads to the left edge, matching the DAY range's full-width fallback",
  );
  assert.ok(
    html.includes('x="589.5"'),
    "the window-close tick spreads to the right edge -- the two ticks are NOT stacked on one pixel",
  );
  assert.ok(
    html.includes("10:25 market-local") && html.includes("16:25 market-local"),
    "both real observed times are still disclosed, not collapsed into a single ambiguous position",
  );
});

test("MKT-011C review round-1 fix (F2, BLOCKING): the DAY range's historical 'previous close' context point renders with its OWN accessible title (naming its date) and lands visibly separate from the window-open tick, never pixel-identical to it", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "day",
    state: {
      status: "loaded",
      currencyCode: "AUD",
      points: [
        {
          date: "2026-08-19",
          priceDecimal: "19.90",
          currencyCode: "AUD",
          providerId: "owner-import",
          interval: "eod",
        },
      ],
      provenance: {
        providers: ["owner-import"],
        fromDate: "2026-08-19",
        toDate: "2026-08-19",
        pointCountRaw: 1,
        pointCountReturned: 1,
        bucketSize: 1,
        excludedCurrencyCount: 0,
        excludedMalformedCount: 0,
        todayExcludedCurrencyCount: 0,
        todayExcludedMalformedCount: 0,
      },
      latestDelayed: null,
      invalidRangeRequested: false,
      todayMarketDate: "2026-08-20",
      todayPoints: DAY_RANGE_TODAY_POINTS,
      marketTimezone: "UTC",
    },
    onRangeChange: () => {},
  });
  // The context point's own accessible title names its real date -- a
  // pre-existing gap (lone historical points had NO title at all) that
  // became actively confusing once a same-pixel intraday tick could sit
  // right where it used to render.
  assert.ok(html.includes(">2026-08-19 (historical).<"));
  // The context point (a plain circle, `scalePriceHistoryPoints`'s
  // UNMODIFIED date-offset x -- the plot's left edge, 8) is visibly
  // separated from the window-OPEN diamond, which now starts
  // DAY_CONTEXT_GAP_PX further right (rect x = 8 + 14 - 2.5 = 19.5) rather
  // than at the SAME pixel (5.5) the context circle itself sits at
  // (cx=8).
  assert.ok(
    html.includes('cx="8"'),
    "the context point stays at the plot's left edge",
  );
  assert.ok(
    html.includes('x="19.5"'),
    "the window-open tick starts to the right of a reserved gap, not on top of the context point",
  );
  assert.ok(
    !html.includes('x="5.5"'),
    "the window-open tick must NOT land at the plain left edge once a context point is present",
  );
});

test("MKT-011C: a today-only chart (no settled historical points in this range) discloses that honestly instead of a misleading 'No date range · 0 points · No provider' line while diamonds are visibly plotting", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    todayOnlyChartProps("day", DAY_RANGE_TODAY_POINTS),
  );
  assert.ok(html.includes("No settled historical points in this range"));
  assert.ok(!html.includes("No date range"));
  assert.ok(!html.includes("No provider"));
});

test("MKT-011C: the price axis attributes a min/max that came from TODAY's intraday overlay rather than the historical series", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "day",
    state: {
      status: "loaded",
      currencyCode: "AUD",
      points: [
        {
          date: "2026-08-19",
          priceDecimal: "19.90",
          currencyCode: "AUD",
          providerId: "owner-import",
          interval: "eod",
        },
      ],
      provenance: {
        providers: ["owner-import"],
        fromDate: "2026-08-19",
        toDate: "2026-08-19",
        pointCountRaw: 1,
        pointCountReturned: 1,
        bucketSize: 1,
        excludedCurrencyCount: 0,
        excludedMalformedCount: 0,
        todayExcludedCurrencyCount: 0,
        todayExcludedMalformedCount: 0,
      },
      latestDelayed: null,
      invalidRangeRequested: false,
      todayMarketDate: "2026-08-20",
      // 20.30 (today) exceeds 19.90 (the only historical point) -- the
      // displayed MAX must be attributed to today's overlay.
      todayPoints: DAY_RANGE_TODAY_POINTS,
      marketTimezone: "UTC",
    },
    onRangeChange: () => {},
  });
  assert.ok(html.includes("(today, intraday)"));
});

test("MKT-011C: the latest-delayed summary line now carries a market-local TIME (from the plumbed-through observedAt), disambiguating it from the same-date Today line", () => {
  const html = renderComponent("PriceHistoryChartView", CHART_COMPONENT_PATH, {
    symbol: "FMG",
    range: "week",
    state: {
      status: "loaded",
      currencyCode: "AUD",
      points: [
        {
          date: "2026-08-19",
          priceDecimal: "19.90",
          currencyCode: "AUD",
          providerId: "owner-import",
          interval: "eod",
        },
      ],
      provenance: {
        providers: ["owner-import"],
        fromDate: "2026-08-19",
        toDate: "2026-08-19",
        pointCountRaw: 1,
        pointCountReturned: 1,
        bucketSize: 1,
        excludedCurrencyCount: 0,
        excludedMalformedCount: 0,
        todayExcludedCurrencyCount: 0,
        todayExcludedMalformedCount: 0,
      },
      latestDelayed: {
        date: "2026-08-20",
        priceDecimal: "20.05",
        currencyCode: "AUD",
        providerId: "sharesight",
        interval: "delayed",
        observedAt: isoAtUtcMinutes("2026-08-20", WINDOW_CLOSE_MINUTES - 30),
        quality: "observed",
      },
      invalidRangeRequested: false,
      todayMarketDate: "2026-08-20",
      todayPoints: DAY_RANGE_TODAY_POINTS,
      marketTimezone: "UTC",
    },
    onRangeChange: () => {},
  });
  assert.ok(html.includes("15:55 market-local"));
});

test("MKT-011C: MARKET_DATA_STRATEGY documents the true intraday time axis, the WEEK-range column choice, the clamp-not-exclude decision, and the quality-tier distinction", async () => {
  const doc = await readFile(
    new URL("../docs/MARKET_DATA_STRATEGY.md", import.meta.url),
    "utf8",
  );
  assert.ok(doc.includes("MKT-011C"));
  assert.ok(doc.toLowerCase().includes("clamp"));
  assert.ok(doc.toLowerCase().includes("stale_candidate"));
  assert.ok(doc.toLowerCase().includes("week"));
});

test("MKT-011C: outside the DAY/WEEK ranges, today's ticks keep the pre-existing SHARED calendar-date column x -- the time axis never applies to month/year/etc. ranges even when a market timezone is known", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    CHART_COMPONENT_PATH,
    todayOnlyChartProps("month", DAY_RANGE_TODAY_POINTS),
  );
  // Both today points share ONE calendar date, so on a non-day/week range
  // they land on the SAME shared date-offset column (paddingX, the
  // single-date domain's own left edge -- `scalePriceHistoryPoints`,
  // unmodified) -- never split across the day range's two distinct
  // TIME-based x values. Both rects report x="5.5" (not just one), and the
  // day-range's window-CLOSE x (589.5) is never reached at all.
  const leftEdgeCount = (html.match(/x="5\.5"/g) ?? []).length;
  assert.equal(
    leftEdgeCount,
    2,
    "both today ticks share the SAME shared-column x, not distinct time-based positions",
  );
  assert.ok(
    !html.includes('x="589.5"'),
    "the time axis's window-close x must never appear outside day/week ranges",
  );
});
