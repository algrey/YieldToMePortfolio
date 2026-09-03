import { ChartBody } from "yieldtome-ui";

type Loaded = Parameters<typeof ChartBody>[0]["state"];
type Point = Loaded["points"][number];
type Provenance = Loaded["provenance"];

/** Deterministic pseudo-random walk so the sheet is stable across captures. */
function walk(seed: number, start: number, steps: number, drift: number, vol: number): number[] {
  let s = seed >>> 0;
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < steps; i += 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const r = s / 4294967296 - 0.5;
    v = Math.max(0.01, v * (1 + drift + r * vol));
    out.push(v);
  }
  return out;
}

function isoFromOffset(base: string, days: number): string {
  const [y, m, d] = base.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!) + days * 86_400_000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Weekday EOD closes from `from` up to and including `to` (exclusive of weekends). */
function eodSeries(seed: number, start: number, from: string, to: string, currencyCode: string, providerId: string): Point[] {
  const values = walk(seed, start, 3200, 0.0004, 0.018);
  const points: Point[] = [];
  let i = 0;
  for (let offset = 0; ; offset += 1) {
    const date = isoFromOffset(from, offset);
    if (date > to) break;
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    points.push({
      date,
      priceDecimal: values[i]!.toFixed(2),
      currencyCode,
      providerId,
      interval: "eod",
      observedAt: `${date}T06:10:00Z`,
      quality: "observed",
    });
    i += 1;
  }
  return points;
}

function provenanceFor(points: readonly Point[], extra: Partial<Provenance> = {}): Provenance {
  const providers = [...new Set(points.map((point) => point.providerId))];
  return {
    providers,
    fromDate: points[0]?.date ?? null,
    toDate: points[points.length - 1]?.date ?? null,
    pointCountRaw: points.length,
    pointCountReturned: points.length,
    bucketSize: 1,
    excludedCurrencyCount: 0,
    excludedMalformedCount: 0,
    todayExcludedCurrencyCount: 0,
    todayExcludedMalformedCount: 0,
    ...extra,
  };
}

function loaded(points: readonly Point[], currencyCode: string, extra: Partial<Loaded> = {}): Loaded {
  return {
    status: "loaded",
    currencyCode,
    points,
    provenance: provenanceFor(points),
    latestDelayed: null,
    invalidRangeRequested: false,
    todayMarketDate: null,
    todayPoints: [],
    marketTimezone: null,
    ...extra,
  };
}

/** ASX-local intraday ticks for 2026-09-04 (AEST = UTC+10, so 00:25Z is 10:25 market-local). */
function intradayToday(seed: number, start: number, currencyCode: string): Point[] {
  const values = walk(seed, start, 40, 0.0002, 0.006);
  const points: Point[] = [];
  for (let i = 0; i < 37; i += 1) {
    const minutes = 25 + i * 10;
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    points.push({
      date: "2026-09-04",
      priceDecimal: values[i]!.toFixed(2),
      currencyCode,
      providerId: "sharesight",
      interval: "intraday",
      observedAt: `2026-09-04T${hh}:${mm}:00Z`,
      quality: i === 12 ? "stale_candidate" : i === 30 ? "indicative" : "observed",
    });
  }
  return points;
}

const VAS_YEAR = eodSeries(7, 92.4, "2025-09-04", "2026-09-03", "AUD", "eodhd");
const CBA_WEEK = eodSeries(19, 168.9, "2026-08-29", "2026-09-03", "AUD", "eodhd");
const VTS_YEAR = eodSeries(31, 412.5, "2025-09-04", "2026-09-03", "USD", "eodhd");

/** Canonical: VAS, one year of weekday EOD closes in the portfolio's own
 * base currency (AUD), so the price axis renders a bare $. */
export function ChartBodyYearAud() {
  return <ChartBody symbol="VAS" range="year" state={loaded(VAS_YEAR, "AUD")} baseCurrencyCode="AUD" />;
}

/** Day range: previous close for context plus today's intraday overlay on
 * the true 10:25-16:25 market-local time axis, including one
 * stale-candidate and one indicative tick. */
export function ChartBodyDayIntraday() {
  const previousClose = CBA_WEEK.slice(-1);
  const today = intradayToday(41, 170.15, "AUD");
  return (
    <ChartBody
      symbol="CBA"
      range="day"
      state={loaded(previousClose, "AUD", {
        todayMarketDate: "2026-09-04",
        todayPoints: today,
        marketTimezone: "Australia/Sydney",
        provenance: provenanceFor(previousClose, { providers: ["eodhd", "sharesight"] }),
      })}
      baseCurrencyCode="AUD"
    />
  );
}

/** Week range: five EOD closes plus today's intraday ticks positioned
 * within today's own calendar-day column. */
export function ChartBodyWeekIntraday() {
  const today = intradayToday(43, 170.15, "AUD");
  return (
    <ChartBody
      symbol="CBA"
      range="week"
      state={loaded(CBA_WEEK, "AUD", {
        todayMarketDate: "2026-09-04",
        todayPoints: today,
        marketTimezone: "Australia/Sydney",
        provenance: provenanceFor(CBA_WEEK, { providers: ["eodhd", "sharesight"] }),
      })}
      baseCurrencyCode="AUD"
    />
  );
}

/** Foreign-currency holding (VTS priced in USD) inside an AUD portfolio:
 * the axis flags the currency, and a delayed Sharesight quote is disclosed. */
export function ChartBodyForeignCurrencyDelayed() {
  const latestDelayed: Point = {
    date: "2026-09-03",
    priceDecimal: "418.72",
    currencyCode: "USD",
    providerId: "sharesight",
    interval: "delayed",
    observedAt: "2026-09-03T20:05:00Z",
    quality: "observed",
  };
  return (
    <ChartBody
      symbol="VTS"
      range="year"
      state={loaded(VTS_YEAR, "USD", {
        latestDelayed,
        provenance: provenanceFor(VTS_YEAR, { providers: ["eodhd", "sharesight"], excludedCurrencyCount: 3 }),
      })}
      baseCurrencyCode="AUD"
    />
  );
}

/** All range, server-downsampled (bucket of 7 from a 2,800-row raw series)
 * with malformed-row disclosure and an invalid-range fallback notice. */
export function ChartBodyAllDownsampled() {
  const full = eodSeries(53, 48.1, "2015-09-07", "2026-09-03", "AUD", "owner-import");
  const sampled = full.filter((_, index) => index % 7 === 6 || index === full.length - 1);
  return (
    <ChartBody
      symbol="WES"
      range="all"
      state={loaded(sampled, "AUD", {
        invalidRangeRequested: true,
        provenance: provenanceFor(sampled, {
          pointCountRaw: full.length,
          bucketSize: 7,
          excludedMalformedCount: 2,
        }),
      })}
      baseCurrencyCode="AUD"
    />
  );
}

/** Loaded but empty: nothing plottable in the requested window. */
export function ChartBodyNoPointsInRange() {
  return <ChartBody symbol="WES" range="month" state={loaded([], "AUD")} baseCurrencyCode="AUD" />;
}
