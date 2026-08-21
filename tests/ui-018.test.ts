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
  classifyPriceHistorySegments,
  dateDayOffset,
  isPlottableDecimal,
  scalePriceHistoryPoints,
} from "../app/price-history-chart-geometry.ts";
import { loadOwnedPriceHistory } from "../app/owned-price-history.ts";
import { currentFyWindow } from "../domain/calculations/financial-year.ts";

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

test("UI-018: portfolio-shell mounts HoldingPriceChart under the Average cost x quantity dl, inside the holding dialog", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
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
    "chart should render before the dividends link (still inside the holding sheet)",
  );
  assert.ok(source.includes("portfolioSecurityId={selectedHolding.id}"));
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
