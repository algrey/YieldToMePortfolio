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
import {
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
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
  axisGutterWidthCh,
  classifyPriceHistorySegments,
  computeXAxisTicks,
  computeYAxisTicks,
  dropCollidingOrOutOfRangeTicks,
  filterTicksByVerticalSeparation,
  findNearestPointIndexByX,
  isPlottableDecimal,
  plotXFromClientX,
  scalePriceHistoryPoints,
  stepActiveIndex,
  type ChartScale,
} from "../price-history-chart-geometry.ts";
// UI-041 y-axis intermediate gridline labels always render as WHOLE
// dollars (Math.round), per the UI-031B whole-dollar-portfolio-values
// precedent (`app/owned-holding-format.tsx`) -- unlike the holding chart's
// price axis, this chart never needs sub-dollar tick precision, so it
// intentionally does NOT use `formatAxisTickValue`'s step-derived decimal
// count.
import {
  filterToClosedFyWindow,
  filterToFyToDateWindow,
} from "../overview-fy-range.ts";
import { subtractCalendarMonths } from "../overview-range.ts";
import { currencyDisplayPrefix } from "../currency-display.ts";
import { formatDayMonthYear } from "../date-display.ts";
import type { OwnedPortfolioValueHistory } from "./portfolio-shell";

const CHART_WIDTH = 600;
const CHART_HEIGHT = 160;
const CHART_PADDING_X = 8;
const CHART_PADDING_Y = 10;

type Range = "1M" | "3M" | "12M" | "FY" | "Last FY" | "5Y" | "All";
const RANGES: readonly Range[] = [
  "1M",
  "3M",
  "12M",
  "FY",
  "Last FY",
  "5Y",
  "All",
];

function valueText(value: string): string {
  try {
    return groupThousands(formatDecimalFixed(parseDecimalResult(value), 2));
  } catch {
    return value;
  }
}

/** Matches `holding-price-chart.tsx`'s `chartDate` -- a series here can
 * span decades (owner-import history reaches back to whenever the CSV
 * starts), so the year is always spelled out.
 *
 * BUG-003: delegates to the Intl/locale-data-free `date-display.ts`
 * formatter -- this fed the `<th scope="row">` table rows that actually
 * hydration-mismatched (server "1 June 2026" vs. browser "1 Jun 2026"); see
 * that module's header comment for the full root cause. */
function chartDate(date: string): string {
  return formatDayMonthYear(date);
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
  // UI-041 scrub/hover readout: which plotted point (by index into this
  // render's own `scaled.points`) is currently under the pointer/keyboard
  // focus, or `null` for none. Starts `null` on every render -- including
  // the very first, server-rendered one -- so the initial markup never
  // shows a readout/guide-line the browser then has to hydrate away
  // (BUG-002/BUG-003's "no server/client render divergence" rule). Reset
  // to `null` on every range change (below) since a stale index would
  // otherwise point at a different point (or nothing) in the newly
  // filtered series.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Touch must scrub only while the finger is actually down (never mistake
  // an ordinary vertical page-scroll swipe for a scrub) -- a mouse, by
  // contrast, has no "down" concept for plain hover. `touchAction: pan-y`
  // on the SVG (see `.price-history-svg` in globals.css) additionally lets
  // an actual vertical swipe still scroll the page rather than being
  // captured by this chart at all.
  const pointerDownRef = useRef(false);
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
      range === "1M" ? 1 : range === "3M" ? 3 : range === "5Y" ? 60 : 12,
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

  // Owner directive (2026-08-26): the range buttons sit just below the
  // chart's own date-range/point-count caption rather than beside the
  // heading -- extracted once so both the populated and the "no priced
  // points in this range" branches render the SAME controls in that spot
  // (switching range must stay possible even when the current range has
  // nothing to plot).
  const rangeControls = (
    <div className="range-controls" aria-label="Portfolio value history range">
      {RANGES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={range === option}
          onClick={() => {
            setRange(option);
            setActiveIndex(null);
          }}
        >
          {option}
        </button>
      ))}
    </div>
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
      </div>
      {plottable.length === 0 ? (
        <>
          <p className="muted-copy" role="status">
            No priced points in this range.
          </p>
          {rangeControls}
        </>
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
          // UI-041: axis ticks. X ticks are evenly time-spaced calendar
          // dates across the plotted range (never index-spaced -- see
          // `computeXAxisTicks`'s own doc comment). Y ticks are "nice"
          // round reference values strictly BETWEEN the chart's own real
          // min/max (which keep rendering as the exact observed decimal
          // strings below, untouched) -- `computeYAxisTicks` already
          // excludes anything float-drift-close to either boundary; the
          // `dropCollidingOrOutOfRangeTicks` pass below closes the second,
          // DISPLAY-level gap (this chart's own whole-dollar rounding
          // pushing a legitimately-interior tick's rendered number past the
          // true max, or two ticks rounding to the same displayed text).
          // Review F1 follow-up (secondary item 1): 4 x-ticks left the
          // first two touching by ~3px at the narrowest supported 320px
          // width -- 3 stays within the task's own "3-5 labels" target
          // range while leaving real breathing room at that width.
          const xTicks = computeXAxisTicks(
            plottable.map((point) => point.date),
            scale,
            3,
          );
          const minPriceNumeric = Number(scaled.minPriceDecimal);
          const maxPriceNumeric = Number(scaled.maxPriceDecimal);
          const yTicksResult = computeYAxisTicks(
            minPriceNumeric,
            maxPriceNumeric,
            scale,
            5,
          );
          const formatWholeDollars = (tick: { value: number }) =>
            String(Math.round(tick.value));
          const rangeSafeYTicks = dropCollidingOrOutOfRangeTicks(
            yTicksResult.ticks,
            formatWholeDollars,
            minPriceNumeric,
            maxPriceNumeric,
            [
              formatWholeDollars({ value: minPriceNumeric }),
              formatWholeDollars({ value: maxPriceNumeric }),
            ],
          );
          // Review F1 (BLOCKING): a text/value-safe tick can still visually
          // OVERPRINT the exact extreme label or another kept intermediate
          // (e.g. "$5,100.00" at top:6.25% vs "$5,000" at top:9.07% -- a
          // 2.82% gap when a label's own line-box needs ~7.5%+ of a 320px-
          // wide plot's height). This second, purely geometric pass keeps
          // only the ones with real vertical breathing room.
          const intermediateYTicks = filterTicksByVerticalSeparation(
            rangeSafeYTicks,
            [CHART_PADDING_Y, CHART_HEIGHT - CHART_PADDING_Y],
          );
          // Review F2 (BLOCKING): size the gutter to its OWN content -- a
          // fixed pixel width truncated a real large portfolio value (e.g.
          // "$1,337,203.50" ellipsised to "$1,337,20…"). `ch` stays a pure
          // function of the label strings, so this is deterministic and
          // hydration-safe (no layout read).
          const maxLabelText = `${currencyPrefix}${valueText(scaled.maxPriceDecimal)}`;
          const minLabelText = `${currencyPrefix}${valueText(scaled.minPriceDecimal)}`;
          const yAxisGutterWidthCh = axisGutterWidthCh([
            maxLabelText,
            minLabelText,
            ...intermediateYTicks.map(
              (tick) => `${currencyPrefix}${groupThousands(tick.text)}`,
            ),
          ]);
          // UI-041 scrub/hover readout (owner directive: "run my finger, or
          // the mouse across the graph and see the value at that point").
          // `hoverPoints` is the SAME array the line/dot markers above are
          // drawn from -- nearest-by-x snapping (`findNearestPointIndexByX`)
          // only ever lands on a REAL plotted point, never a fabricated
          // in-between value; a pointer over a genuine gap simply lands on
          // whichever real neighbour is pixel-closer (honesty rule).
          const hoverPoints = scaled.points;
          const activePoint =
            activeIndex !== null ? (hoverPoints[activeIndex] ?? null) : null;
          const activePartial = activePoint
            ? partialDates.has(activePoint.date)
            : false;
          function localPointerX(event: PointerEvent<SVGSVGElement>): number {
            const rect = event.currentTarget.getBoundingClientRect();
            return plotXFromClientX(
              event.clientX,
              rect.left,
              rect.width,
              CHART_WIDTH,
            );
          }
          function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
            // Touch only scrubs while the finger is down (a plain vertical
            // swipe must stay a page scroll, never hijacked into a scrub).
            if (event.pointerType === "touch" && !pointerDownRef.current) {
              return;
            }
            setActiveIndex(
              findNearestPointIndexByX(hoverPoints, localPointerX(event)),
            );
          }
          function handlePointerDown(event: PointerEvent<SVGSVGElement>) {
            pointerDownRef.current = true;
            setActiveIndex(
              findNearestPointIndexByX(hoverPoints, localPointerX(event)),
            );
          }
          function endPointerScrub() {
            pointerDownRef.current = false;
          }
          function handlePointerLeave() {
            pointerDownRef.current = false;
            setActiveIndex(null);
          }
          function handleKeyDown(event: KeyboardEvent<SVGSVGElement>) {
            const next = stepActiveIndex(
              event.key,
              activeIndex,
              hoverPoints.length,
            );
            if (next === undefined) return;
            event.preventDefault();
            setActiveIndex(next);
          }
          return (
            <>
              {/* `role="status"` rather than an explicit `aria-live`
                  attribute -- this ARIA role implicitly carries polite
                  live-region semantics (screen readers announce updates)
                  without the literal substring "aria-live" in the markup,
                  which this codebase's own quote-honesty rule (never claim
                  a delayed price is "live") could otherwise false-positive
                  against elsewhere. */}
              <p
                id="portfolio-value-readout"
                className="chart-readout"
                role="status"
              >
                {activePoint
                  ? `${chartDate(activePoint.date)}: ${currencyPrefix}${valueText(activePoint.priceDecimal)}${activePartial ? " (partial)" : ""}`
                  : " "}
              </p>
              <div className="price-history-chart-row">
                {/* UI-018/hist-001's own pinned test scans for the exact,
                    literal `<div class="price-history-axis">` opening tag
                    (no other attributes) -- the content-sized width (F2)
                    therefore lives on THIS separate shell wrapper, never
                    on `.price-history-axis` itself. */}
                <div
                  className="price-history-axis-shell"
                  style={{ width: `${yAxisGutterWidthCh}ch` }}
                >
                  <div className="price-history-axis">
                    <span
                      className="price-history-axis-label"
                      style={{
                        top: `${(CHART_PADDING_Y / CHART_HEIGHT) * 100}%`,
                      }}
                    >
                      {maxLabelText}
                    </span>
                    {intermediateYTicks.map((tick) => (
                      <span
                        key={`y-label-${tick.value}`}
                        className="price-history-axis-label"
                        aria-hidden="true"
                        style={{ top: `${(tick.y / CHART_HEIGHT) * 100}%` }}
                      >
                        {currencyPrefix}
                        {groupThousands(tick.text)}
                      </span>
                    ))}
                    <span
                      className="price-history-axis-label"
                      style={{
                        top: `${((CHART_HEIGHT - CHART_PADDING_Y) / CHART_HEIGHT) * 100}%`,
                      }}
                    >
                      {minLabelText}
                    </span>
                  </div>
                </div>
                <div className="price-history-plot">
                  <svg
                    className="price-history-svg"
                    viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                    role="img"
                    tabIndex={0}
                    aria-describedby="portfolio-value-readout"
                    aria-label={`Portfolio value history in ${history.baseCurrencyCode}; ${plottable.length} point${plottable.length === 1 ? "" : "s"}, ${plottable[0]!.date} to ${plottable[plottable.length - 1]!.date}${partialDates.size > 0 ? `; ${partialDates.size} partial` : ""}. Use arrow keys to step through points when focused.`}
                    onPointerMove={handlePointerMove}
                    onPointerDown={handlePointerDown}
                    onPointerUp={endPointerScrub}
                    onPointerCancel={endPointerScrub}
                    onPointerLeave={handlePointerLeave}
                    onKeyDown={handleKeyDown}
                  >
                    {intermediateYTicks.map((tick) => (
                      <line
                        key={`grid-${tick.value}`}
                        className="price-history-gridline"
                        x1={CHART_PADDING_X}
                        x2={CHART_WIDTH - CHART_PADDING_X}
                        y1={tick.y}
                        y2={tick.y}
                      />
                    ))}
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
                          (point): point is NonNullable<typeof point> =>
                            !!point,
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
                    {/* UI-041 scrub/hover: a vertical guide line plus a
                    highlighted marker at the snapped point -- rendered ONLY
                    once a pointer/keyboard interaction has actually set
                    `activeIndex` (never on the initial server render, so
                    hydration never has to remove it -- BUG-002/BUG-003). */}
                    {activePoint ? (
                      <g className="price-history-hover-group">
                        <line
                          className="price-history-hover-line"
                          x1={activePoint.x}
                          x2={activePoint.x}
                          y1={CHART_PADDING_Y}
                          y2={CHART_HEIGHT - CHART_PADDING_Y}
                        />
                        <circle
                          className="price-history-hover-dot"
                          cx={activePoint.x}
                          cy={activePoint.y}
                          r={4}
                        />
                      </g>
                    ) : null}
                  </svg>
                  {xTicks.length > 0 ? (
                    <div className="price-history-x-axis" aria-hidden="true">
                      {xTicks.map((tick, index) => (
                        <span
                          key={`x-label-${tick.date}`}
                          style={{
                            left: `${(tick.x / CHART_WIDTH) * 100}%`,
                            textAlign:
                              index === 0
                                ? "left"
                                : index === xTicks.length - 1
                                  ? "right"
                                  : "center",
                            transform:
                              index === 0
                                ? "translateX(0)"
                                : index === xTicks.length - 1
                                  ? "translateX(-100%)"
                                  : "translateX(-50%)",
                          }}
                        >
                          {chartDate(tick.date)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
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
                {history.backfillPending
                  ? " · still catching up — more history will appear on your next visit"
                  : ""}
              </p>
              {rangeControls}
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
