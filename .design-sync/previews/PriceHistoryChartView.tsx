import { ChartBody, PriceHistoryChartView } from "yieldtome-ui";

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

const noop = () => undefined;

/** Canonical: loaded VAS year series with the eyebrow heading and the
 * range button row (Year pressed). */
export function PriceHistoryChartViewLoaded() {
  return <PriceHistoryChartView symbol="VAS" range="year" state={loaded(VAS_YEAR, "AUD")} onRangeChange={noop} baseCurrencyCode="AUD" />;
}

/** Loading: aria-busy section with the status copy in place of the plot. */
export function PriceHistoryChartViewLoading() {
  return <PriceHistoryChartView symbol="VAS" range="year" state={{ status: "loading" }} onRangeChange={noop} baseCurrencyCode="AUD" />;
}

/** Error: the fetch failed (timeout wording), shown as a warning banner. */
export function PriceHistoryChartViewError() {
  return (
    <PriceHistoryChartView
      symbol="CBA"
      range="5y"
      state={{ status: "error", message: "The request timed out. Try a shorter range or try again." }}
      onRangeChange={noop}
      baseCurrencyCode="AUD"
    />
  );
}

/** Loaded, empty: the Month window holds no observations for this holding. */
export function PriceHistoryChartViewEmptyRange() {
  return <PriceHistoryChartView symbol="WES" range="month" state={loaded([], "AUD")} onRangeChange={noop} baseCurrencyCode="AUD" />;
}

/** Foreign-currency holding (VTS in USD) in an AUD portfolio, with today's
 * intraday Sharesight ticks overlaid on the Week range. */
export function PriceHistoryChartViewWeekForeignIntraday() {
  const week = eodSeries(61, 412.5, "2026-08-29", "2026-09-03", "USD", "eodhd");
  return (
    <PriceHistoryChartView
      symbol="VTS"
      range="week"
      state={loaded(week, "USD", {
        todayMarketDate: "2026-09-04",
        todayPoints: intradayToday(67, 419.3, "USD"),
        marketTimezone: "Australia/Sydney",
        provenance: provenanceFor(week, { providers: ["eodhd", "sharesight"] }),
      })}
      onRangeChange={noop}
      baseCurrencyCode="AUD"
    />
  );
}
