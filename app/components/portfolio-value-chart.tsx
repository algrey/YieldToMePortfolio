"use client";

// HIST-001 (owner-directed: "There is no graph of the portfolio value over
// time... Let get this working"): portfolio-value-over-time chart on the
// Overview screen, fed by the READ-TIME derivation
// (`app/historical-portfolio-value.ts`) rather than the CALC-003/CALC-004
// persisted snapshot pipeline the existing "Published value" panel below it
// still reads from -- see `docs/ARCHITECTURE.md`'s HIST-001 entry.
//
// Data arrives already loaded in the server-rendered workspace prop (no
// client fetch -- every range is a LOCAL filter of the same bounded series,
// exactly like the existing "Published value" panel's own range buttons),
// so this component is DB-free/fetch-free. Rendering reuses UI-018's SVG
// geometry (`price-history-chart-geometry.ts`) UNMODIFIED rather than the
// Overview's own equally-spaced CSS bar strip -- a bar strip visually
// implies uniform date spacing, which would misrepresent this series' real
// sparse-monthly-to-dense-daily density change (owner directive: "monthly
// granularity pre-2018... value on the dates observations exist, never
// interpolate"); a calendar-scaled X axis makes gaps and density changes
// honestly visible instead.
import { useMemo, useState } from "react";
import {
  formatDecimalFixed,
  groupThousands,
  parseDecimalResult,
} from "../../domain/calculations/index.ts";
import {
  currentFyWindow,
  lastFyWindow,
} from "../../domain/calculations/financial-year.ts";
import {
  classifyPriceHistorySegments,
  isPlottableDecimal,
  scalePriceHistoryPoints,
  type ChartScale,
} from "../price-history-chart-geometry.ts";
import {
  filterToClosedFyWindow,
  filterToFyToDateWindow,
} from "../overview-fy-range.ts";
import { subtractCalendarMonths } from "../overview-range.ts";
import { currencyDisplayPrefix } from "../currency-display.ts";
import type { OwnedPortfolioValueHistory } from "./portfolio-shell";

const CHART_WIDTH = 600;
const CHART_HEIGHT = 160;
const CHART_PADDING_X = 8;
const CHART_PADDING_Y = 10;

type Range = "1M" | "3M" | "12M" | "FY" | "Last FY" | "All";
const RANGES: readonly Range[] = ["1M", "3M", "12M", "FY", "Last FY", "All"];

function valueText(value: string): string {
  try {
    return groupThousands(formatDecimalFixed(parseDecimalResult(value), 2));
  } catch {
    return value;
  }
}

/** Matches `holding-price-chart.tsx`'s `chartDate` -- a series here can
 * span decades (owner-import history reaches back to whenever the CSV
 * starts), so the year is always spelled out. */
function chartDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const parsed = new Date(`${date}T00:00:00Z`);
  const day = parsed.getUTCDate();
  const month = parsed.toLocaleDateString("en-AU", {
    month: "short",
    timeZone: "UTC",
  });
  return `${day} ${month} ${date.slice(0, 4)}`;
}

type Coord = { date: string; x: number; y: number };

/** Review B2b: splits an already gap/non-gap classified run of coordinates
 * into further sub-runs sharing the SAME "touches a partial point" status
 * -- an edge between two points is "partial" whenever EITHER endpoint is a
 * partial (understated) point, so a partial point's line never renders
 * solid-identical to a run of fully complete points. Boundary points are
 * shared between adjacent runs (mirrors `classifyPriceHistorySegments`'s
 * own shared-endpoint convention) so the line stays visually continuous --
 * the dash pattern marks uncertainty, not a break. */
function splitByPartialAdjacency(
  coords: readonly Coord[],
  partialDates: ReadonlySet<string>,
): { points: Coord[]; partial: boolean }[] {
  if (coords.length === 0) return [];
  if (coords.length === 1) {
    return [
      { points: [coords[0]!], partial: partialDates.has(coords[0]!.date) },
    ];
  }
  const runs: { points: Coord[]; partial: boolean }[] = [];
  let currentPoints: Coord[] = [coords[0]!];
  let currentPartial: boolean | null = null;
  for (let index = 1; index < coords.length; index += 1) {
    const edgePartial =
      partialDates.has(coords[index - 1]!.date) ||
      partialDates.has(coords[index]!.date);
    if (currentPartial === null) currentPartial = edgePartial;
    if (edgePartial !== currentPartial) {
      runs.push({ points: currentPoints, partial: currentPartial });
      currentPoints = [coords[index - 1]!];
      currentPartial = edgePartial;
    }
    currentPoints.push(coords[index]!);
  }
  runs.push({ points: currentPoints, partial: currentPartial ?? false });
  return runs;
}

export function PortfolioValueChart({
  history,
  financialYearStartMonth,
  timezone,
  nowInstant,
}: {
  history: OwnedPortfolioValueHistory;
  financialYearStartMonth: number;
  timezone: string;
  /** Threaded from the server render, never `new Date()` inside a client
   * component -- matches `PortfolioShell`'s own `nowInstant` convention
   * (FY window math must anchor on the real request instant, not stale
   * client-side clock drift). */
  nowInstant: string;
}) {
  const [range, setRange] = useState<Range>("12M");
  const currentFyResult = useMemo(
    () => currentFyWindow(nowInstant, financialYearStartMonth, timezone),
    [nowInstant, financialYearStartMonth, timezone],
  );
  const lastFyResult = useMemo(
    () => lastFyWindow(nowInstant, financialYearStartMonth, timezone),
    [nowInstant, financialYearStartMonth, timezone],
  );

  const filtered = useMemo(() => {
    const points = history.points;
    if (range === "All") return points;
    if (range === "FY") return filterToFyToDateWindow(points, currentFyResult);
    if (range === "Last FY")
      return filterToClosedFyWindow(points, lastFyResult);
    const latest = points[points.length - 1];
    if (!latest) return [];
    const cutoffDate = subtractCalendarMonths(
      latest.date,
      range === "1M" ? 1 : range === "3M" ? 3 : 12,
    );
    return points.filter((point) => point.date >= cutoffDate);
  }, [history.points, range, currentFyResult, lastFyResult]);

  if (history.status === "unavailable") {
    return (
      <section
        className="history-panel"
        aria-labelledby="portfolio-value-history-title"
      >
        <p className="eyebrow">Portfolio value over time</p>
        <h2 id="portfolio-value-history-title">Portfolio value over time</h2>
        <p className="muted-copy" role="status">
          Portfolio value history is temporarily unavailable.
        </p>
      </section>
    );
  }
  if (history.status === "empty" || history.points.length === 0) {
    return (
      <section
        className="history-panel"
        aria-labelledby="portfolio-value-history-title"
      >
        <p className="eyebrow">Portfolio value over time</p>
        <h2 id="portfolio-value-history-title">Portfolio value over time</h2>
        <p className="muted-copy" role="status">
          No priced holding dates found yet -- import price history or add
          transactions to see the portfolio&apos;s value over time.
        </p>
      </section>
    );
  }

  const plottable = filtered
    .filter((point) => point.valueDecimal !== null)
    .map((point) => ({ date: point.date, priceDecimal: point.valueDecimal! }))
    .filter((point) => isPlottableDecimal(point.priceDecimal));

  const currencyPrefix = currencyDisplayPrefix(
    history.baseCurrencyCode,
    history.baseCurrencyCode,
  );

  return (
    <section
      className="history-panel"
      aria-labelledby="portfolio-value-history-title"
    >
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Portfolio value over time</p>
          <h2 id="portfolio-value-history-title">Portfolio value over time</h2>
        </div>
        <div
          className="range-controls"
          aria-label="Portfolio value history range"
        >
          {RANGES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={range === option}
              onClick={() => setRange(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      {plottable.length === 0 ? (
        <p className="muted-copy" role="status">
          No priced points in this range.
        </p>
      ) : (
        (() => {
          const scale: ChartScale = {
            width: CHART_WIDTH,
            height: CHART_HEIGHT,
            paddingX: CHART_PADDING_X,
            paddingY: CHART_PADDING_Y,
          };
          const scaled = scalePriceHistoryPoints(plottable, scale);
          if (!scaled) {
            return (
              <p className="muted-copy" role="status">
                No priced points in this range.
              </p>
            );
          }
          // No downsampling bucket (this series is already bounded to
          // distinct OBSERVATION dates, never a synthetic daily grid, so
          // `bucketSize` stays at the pure "1" default -- a wide delta
          // between two real observation dates IS a genuine gap here, not
          // downsampled spacing).
          const segments = classifyPriceHistorySegments(plottable);
          const byDate = new Map(
            scaled.points.map((point) => [point.date, point]),
          );
          const partialPointsByDate = new Map(
            filtered
              .filter((point) => point.completeness === "partial")
              .map((point) => [point.date, point]),
          );
          const partialDates = new Set(partialPointsByDate.keys());
          // Review B2b: total unpriced-HELD-security instances across every
          // partial point currently shown -- named in the caption, not just
          // a bare "N partial" count.
          const unpricedHeldSecurityInstances = [
            ...partialPointsByDate.values(),
          ].reduce(
            (sum, point) =>
              sum +
              Math.max(0, point.heldSecurityCount - point.pricedSecurityCount),
            0,
          );
          return (
            <>
              <svg
                className="price-history-svg"
                viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                role="img"
                aria-label={`Portfolio value history in ${history.baseCurrencyCode}; ${plottable.length} point${plottable.length === 1 ? "" : "s"}, ${plottable[0]!.date} to ${plottable[plottable.length - 1]!.date}${partialDates.size > 0 ? `; ${partialDates.size} partial` : ""}.`}
              >
                <line
                  className="price-history-baseline"
                  x1={CHART_PADDING_X}
                  y1={CHART_HEIGHT - CHART_PADDING_Y}
                  x2={CHART_WIDTH - CHART_PADDING_X}
                  y2={CHART_HEIGHT - CHART_PADDING_Y}
                />
                {segments.map((segment, segmentIndex) => {
                  const coords = segment.points
                    .map((point) => byDate.get(point.date))
                    .filter(
                      (point): point is NonNullable<typeof point> => !!point,
                    );
                  if (coords.length < 2) {
                    return coords.length === 1 ? (
                      <circle
                        key={`point-${segmentIndex}`}
                        className={
                          partialDates.has(coords[0]!.date)
                            ? "price-history-dot price-history-partial"
                            : "price-history-dot"
                        }
                        cx={coords[0]!.x}
                        cy={coords[0]!.y}
                        r={2.5}
                      >
                        <title>{`${coords[0]!.date} (historical).`}</title>
                      </circle>
                    ) : null;
                  }
                  // Review B2b: a gap segment (a real date-hole, per
                  // `classifyPriceHistorySegments`) is already the
                  // strongest "uncertain" signal and stays dashed as such
                  // regardless of partial-ness; only a NON-gap segment gets
                  // further split by partial-point adjacency, so a partial
                  // point's line never renders solid-identical to a run of
                  // complete points.
                  const runs = segment.gap
                    ? [{ points: coords, partial: false }]
                    : splitByPartialAdjacency(coords, partialDates);
                  return runs.map((run, runIndex) => (
                    <polyline
                      key={`segment-${segmentIndex}-run-${runIndex}`}
                      className={
                        segment.gap
                          ? "price-history-line price-history-gap"
                          : run.partial
                            ? "price-history-line price-history-partial"
                            : "price-history-line"
                      }
                      points={run.points
                        .map((point) => `${point.x},${point.y}`)
                        .join(" ")}
                    >
                      <title>
                        {segment.gap
                          ? `No observations between ${segment.points[0]!.date} and ${segment.points[segment.points.length - 1]!.date}.`
                          : run.partial
                            ? `Partial: some held securities were unpriced between ${run.points[0]!.date} and ${run.points[run.points.length - 1]!.date}.`
                            : `${run.points[0]!.date} to ${run.points[run.points.length - 1]!.date}`}
                      </title>
                    </polyline>
                  ));
                })}
                {/* Review B2b: every partial point gets its OWN hollow
                    marker, regardless of position in the series -- the
                    dashed line segments above already distinguish a run
                    TOUCHING a partial point, but an interior partial point
                    (neither the series' latest point nor an isolated
                    single-coordinate run) would otherwise carry no
                    point-level marker of its own. */}
                {scaled.points
                  .filter((point) => partialDates.has(point.date))
                  .map((point) => (
                    <circle
                      key={`partial-${point.date}`}
                      className="price-history-dot price-history-partial"
                      cx={point.x}
                      cy={point.y}
                      r={2.5}
                    >
                      <title>
                        {`${point.date}: partial -- ${partialPointsByDate.get(point.date)?.pricedSecurityCount ?? 0} of ${partialPointsByDate.get(point.date)?.heldSecurityCount ?? 0} held securities priced.`}
                      </title>
                    </circle>
                  ))}
                {scaled.points.length > 0 ? (
                  <circle
                    className={
                      partialDates.has(
                        scaled.points[scaled.points.length - 1]!.date,
                      )
                        ? "price-history-dot price-history-latest price-history-partial"
                        : "price-history-dot price-history-latest"
                    }
                    cx={scaled.points[scaled.points.length - 1]!.x}
                    cy={scaled.points[scaled.points.length - 1]!.y}
                    r={3}
                  />
                ) : null}
              </svg>
              <div className="price-history-axis">
                <span>
                  {currencyPrefix}
                  {valueText(scaled.maxPriceDecimal)}
                </span>
                <span>
                  {currencyPrefix}
                  {valueText(scaled.minPriceDecimal)}
                </span>
              </div>
              <p className="chart-coverage">
                {chartDate(plottable[0]!.date)} –{" "}
                {chartDate(plottable[plottable.length - 1]!.date)} ·{" "}
                {plottable.length} point{plottable.length === 1 ? "" : "s"}
                {partialDates.size > 0
                  ? ` · ${partialDates.size} partial (${unpricedHeldSecurityInstances} unpriced held-security instance${unpricedHeldSecurityInstances === 1 ? "" : "s"} across them)`
                  : ""}
                {history.datesTruncated
                  ? " · older history was trimmed to keep this read bounded"
                  : ""}
              </p>
              <details className="chart-table-details">
                <summary>View history as a table</summary>
                <table>
                  <caption>Portfolio value history</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Value</th>
                      <th scope="col">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((point) => (
                      <tr key={`${point.date}-row`}>
                        <th scope="row">{chartDate(point.date)}</th>
                        <td>
                          {point.valueDecimal === null
                            ? "Unavailable"
                            : `${currencyPrefix}${valueText(point.valueDecimal)}`}
                        </td>
                        <td>
                          {point.valueDecimal === null
                            ? "gap"
                            : point.completeness === "partial"
                              ? `partial (${point.pricedSecurityCount}/${point.heldSecurityCount} held securities priced)`
                              : point.completeness}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </>
          );
        })()
      )}
    </section>
  );
}
