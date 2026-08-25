"use client";

// UI-018: per-holding price-history chart, mounted under "Average cost x
// quantity" in the holding-detail sheet (`portfolio-shell.tsx`). Mirrors
// the existing dialog fetch/abort conventions (see `DIALOG_FETCH_TIMEOUT_MS`
// in `portfolio-shell.tsx`) rather than importing them -- those constants
// are private to that file, and this component's timeout applies to a plain
// read, not a mutation submit racing a keyboard trap, so it is kept local
// rather than forcing a shared export across an unrelated concern.
import { useEffect, useState } from "react";
import {
  formatDecimalTrimmed,
  groupThousands,
  parseDecimalResult,
} from "../../domain/calculations/index.ts";
import {
  DEFAULT_PRICE_HISTORY_RANGE,
  PRICE_HISTORY_RANGES,
  type PriceHistoryRange,
} from "../price-history-range.ts";
import {
  calendarColumnWidth,
  classifyPriceHistorySegments,
  isPlottableDecimal,
  positionTodayPointsByObservedTime,
  scalePriceHistoryPoints,
  type ChartScale,
  type PlottedTimeAxisPoint,
} from "../price-history-chart-geometry.ts";
import type {
  PriceHistoryPoint,
  PriceHistoryProvenance,
} from "../owned-price-history.ts";
import { currencyDisplayPrefix } from "../currency-display.ts";
import { formatDayMonthYear } from "../date-display.ts";

const FETCH_TIMEOUT_MS = 15_000;
const CHART_WIDTH = 600;
const CHART_HEIGHT = 160;
const CHART_PADDING_X = 8;
const CHART_PADDING_Y = 10;
/** MKT-011C review round-1 fix (F2, BLOCKING): pixel gap reserved before the
 * DAY range's time axis starts, ONLY when a historical "previous close"
 * context point is present -- without it, that point's plain date-offset x
 * (the plot's left edge) is the SAME pixel the window-OPEN tick would
 * otherwise occupy. See the `range === "day"` branch below. */
const DAY_CONTEXT_GAP_PX = 14;

const RANGE_LABELS: Record<PriceHistoryRange, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  ytd: "YTD",
  fy: "FY",
  year: "Year",
  "5y": "5 Year",
  all: "All",
};

export type PriceHistoryFetchState =
  | { status: "loading" }
  | {
      status: "loaded";
      currencyCode: string;
      points: readonly PriceHistoryPoint[];
      provenance: PriceHistoryProvenance;
      latestDelayed: PriceHistoryPoint | null;
      invalidRangeRequested: boolean;
      // MKT-011B: today's intraday overlay -- see
      // `app/owned-price-history.ts`'s `PriceHistorySuccess` doc comments
      // for the honesty/dedupe rules these carry.
      todayMarketDate: string | null;
      todayPoints: readonly PriceHistoryPoint[];
      // MKT-011C: the security's own market timezone (same source as
      // `todayMarketDate`) -- lets the day/week-range time axis convert each
      // today point's `observedAt` into a market-local time client-side.
      marketTimezone: string | null;
    }
  | { status: "error"; message: string };

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function priceText(value: string): string {
  try {
    return groupThousands(
      formatDecimalTrimmed(parseDecimalResult(value), 6, {
        trimTrailingZeros: true,
      }),
    );
  } catch {
    return value;
  }
}

/** Compact "12 Mar 1998" date label, matching `overviewDate`'s style in
 * `portfolio-shell.tsx` but spelling the year (a price series can span
 * decades, where the year is the fact that matters most).
 *
 * BUG-003: delegates to the Intl/locale-data-free `date-display.ts`
 * formatter -- see that module's header comment for why any
 * `toLocaleDateString`/`Intl` call for a textual month can never be
 * hydration-safe here, even fully pinned. */
function chartDate(date: string): string {
  return formatDayMonthYear(date);
}

/** Review round-1 fix (F2): the delayed-quote line used to hardcode
 * "Delayed (Sharesight)" -- but the provider is already ON THE WIRE as
 * `latestDelayed.providerId`, so a future non-Sharesight delayed source
 * would have been silently mislabelled. Derives a short display name from
 * the provider id instead; an unrecognised future id degrades to a
 * title-cased rendering of the id itself, never a false "Sharesight". */
function providerDisplayLabel(providerId: string): string {
  if (providerId === "sharesight") return "Sharesight";
  if (providerId === "owner-import") return "Owner import";
  return providerId
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

/** MKT-011C: formats a UTC `observedAt` instant as an "HH:MM" market-LOCAL
 * clock time -- labelled "market-local" everywhere it is shown (never bare,
 * which could be misread as the viewer's own local time). `null` (never a
 * guess) when `observedAt`/`marketTimezone` is missing or unparsable -- the
 * caller falls back to date-only wording in that case.
 *
 * BUG-003 sweep: deliberately LEFT as `Intl.DateTimeFormat` (not converted
 * to `date-display.ts`) -- `hour`/`minute` with `hour12: false` are numeric
 * digit fields, never a textual month/weekday/day-period name, so this
 * result is stable across the CLDR/ICU version skew BUG-003 found; only
 * TEXTUAL locale fields are hydration-unsafe. */
function marketLocalTimeLabel(
  observedAt: string | null | undefined,
  marketTimezone: string | null,
): string | null {
  if (!observedAt || !marketTimezone) return null;
  const instant = new Date(observedAt);
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone: marketTimezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(instant);
  } catch {
    return null;
  }
}

/** MKT-011C: a short, human label for a non-`observed` quality tier -- the
 * overlay's per-tick accessible `<title>` text (never color alone, QA-001B).
 * `null` for `observed` (the ordinary case needs no caveat) and for any
 * future/unrecognised value (degrades to no caveat rather than a fabricated
 * label). */
function qualityCaveatLabel(quality: string | undefined): string | null {
  if (quality === "stale_candidate") {
    return "stale candidate -- not a freshly confirmed price";
  }
  if (quality === "indicative") {
    return "indicative -- not a confirmed trade";
  }
  if (quality === "corrected") return "corrected";
  return null;
}

export function HoldingPriceChart({
  portfolioId,
  portfolioSecurityId,
  symbol,
  baseCurrencyCode,
}: {
  portfolioId: string;
  portfolioSecurityId: string;
  symbol: string;
  /** UI-026: the active portfolio's own base currency -- the axis prices
   * render as a bare symbol when the series' own currency matches this,
   * flagged otherwise. */
  baseCurrencyCode: string;
}) {
  const [range, setRange] = useState<PriceHistoryRange>(
    DEFAULT_PRICE_HISTORY_RANGE,
  );
  const [state, setState] = useState<PriceHistoryFetchState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    (async () => {
      setState({ status: "loading" });
      try {
        const response = await fetch(
          `/api/portfolios/${portfolioId}/securities/${portfolioSecurityId}/price-history?range=${range}`,
          { signal: controller.signal },
        );
        const result = (await response.json()) as
          | {
              ok: true;
              currencyCode: string;
              points: PriceHistoryPoint[];
              provenance: PriceHistoryProvenance;
              latestDelayed: PriceHistoryPoint | null;
              invalidRangeRequested: boolean;
              todayMarketDate: string | null;
              todayPoints: PriceHistoryPoint[];
              marketTimezone: string | null;
            }
          | { ok: false; message: string };
        if (cancelled) return;
        if (!response.ok || !result.ok) {
          setState({
            status: "error",
            message:
              !result.ok && result.message
                ? result.message
                : "Price history could not be loaded.",
          });
          return;
        }
        setState({
          status: "loaded",
          currencyCode: result.currencyCode,
          points: result.points,
          provenance: result.provenance,
          latestDelayed: result.latestDelayed,
          invalidRangeRequested: result.invalidRangeRequested,
          todayMarketDate: result.todayMarketDate,
          todayPoints: result.todayPoints,
          marketTimezone: result.marketTimezone,
        });
      } catch (error) {
        if (cancelled) return;
        setState({
          status: "error",
          message: isAbortError(error)
            ? "The request timed out. Try a shorter range or try again."
            : "Price history could not be loaded.",
        });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [portfolioId, portfolioSecurityId, range]);

  return (
    <PriceHistoryChartView
      symbol={symbol}
      range={range}
      state={state}
      onRangeChange={setRange}
      baseCurrencyCode={baseCurrencyCode}
    />
  );
}

/**
 * Pure presentational split (mirrors this file's data-fetching
 * `HoldingPriceChart` vs. its render): exported separately so tests can
 * render every state (loading/error/loaded/empty) directly, without a
 * fetch, via `renderToStaticMarkup`.
 */
export function PriceHistoryChartView({
  symbol,
  range,
  state,
  onRangeChange,
  baseCurrencyCode,
}: {
  symbol: string;
  range: PriceHistoryRange;
  state: PriceHistoryFetchState;
  onRangeChange: (range: PriceHistoryRange) => void;
  /** UI-026: threaded straight through to `ChartBody`'s axis labels. */
  baseCurrencyCode: string;
}) {
  const busy = state.status === "loading";
  return (
    <section
      className="price-history-chart"
      aria-labelledby="price-history-heading"
      aria-busy={busy}
    >
      <p className="eyebrow" id="price-history-heading">
        Price history
      </p>
      {state.status === "error" ? (
        <p className="status-banner warning" role="status">
          <strong>Price history unavailable</strong>
          <span>{state.message}</span>
        </p>
      ) : state.status === "loading" ? (
        <p className="muted-copy" role="status">
          Loading price history…
        </p>
      ) : (
        <ChartBody
          symbol={symbol}
          range={range}
          state={state}
          baseCurrencyCode={baseCurrencyCode}
        />
      )}
      <div className="range-controls" aria-label="Price history range">
        {PRICE_HISTORY_RANGES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={range === option}
            onClick={() => onRangeChange(option)}
          >
            {RANGE_LABELS[option]}
          </button>
        ))}
      </div>
    </section>
  );
}

export function ChartBody({
  symbol,
  range,
  state,
  baseCurrencyCode,
}: {
  symbol: string;
  range: PriceHistoryRange;
  state: Extract<PriceHistoryFetchState, { status: "loaded" }>;
  /** UI-026: the active portfolio's own base currency -- the price axis
   * (the only PLAIN "CODE amount"-shaped money text on this chart) renders
   * a bare symbol when `state.currencyCode` matches this, flagged
   * otherwise. The SVG title/provenance lines below the axis deliberately
   * keep the raw "amount CODE" suffix form -- see the comment at the axis
   * itself for why those are NOT migrated. */
  baseCurrencyCode: string;
}) {
  const plottable = state.points.filter((point) =>
    isPlottableDecimal(point.priceDecimal),
  );
  // MKT-011B: today's intraday overlay -- defensively defaulted (`?? []`)
  // rather than assumed present, so a caller/older cached state shape
  // without these fields degrades to "no overlay" instead of crashing.
  const todayPlottable = (state.todayPoints ?? []).filter((point) =>
    isPlottableDecimal(point.priceDecimal),
  );
  const todayMarketDate = state.todayMarketDate ?? null;

  if (plottable.length === 0 && todayPlottable.length === 0) {
    return (
      <p className="muted-copy" role="status">
        No price history in this range.
      </p>
    );
  }

  const SCALE: ChartScale = {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    paddingX: CHART_PADDING_X,
    paddingY: CHART_PADDING_Y,
  };

  // MKT-011B: scale the historical series AND today's intraday overlay
  // together so both share ONE price/date domain -- the axis reflects the
  // true combined min/max, and today's ticks land in the correct calendar
  // column. Reuses `scalePriceHistoryPoints` UNMODIFIED (it already maps
  // by calendar date, never index) rather than inventing separate overlay
  // geometry; the two halves are split back out below by array position
  // (order is preserved by that function). MKT-011C keeps this call
  // completely unchanged -- it still supplies the shared price/Y domain
  // AND every range's date-based X positions; only the DAY/WEEK ranges'
  // "today" points get their X overridden below by the true time axis.
  const scaled = scalePriceHistoryPoints(
    [...plottable, ...todayPlottable],
    SCALE,
  );
  if (!scaled) {
    return (
      <p className="muted-copy" role="status">
        No price history in this range.
      </p>
    );
  }
  const historicalScaled = scaled.points.slice(0, plottable.length);
  const todayScaled = scaled.points.slice(plottable.length);

  // MKT-011C: true sub-day time axis, DAY (full plot width = the 10:25-16:25
  // window) and WEEK (today's own calendar-day column within the multi-day
  // date-offset axis) ranges only -- every other range keeps today's ticks
  // on the SAME shared calendar-date column `scalePriceHistoryPoints` above
  // already put them on (MKT-011B, unchanged). `marketTimezone` unresolved
  // (no exchange linked) degrades to that same shared-column fallback rather
  // than guessing a timezone.
  const marketTimezone = state.marketTimezone ?? null;
  const timeAxisRange = range === "day" || range === "week";
  const plotMinX = CHART_PADDING_X;
  const plotMaxX = CHART_WIDTH - CHART_PADDING_X;
  let todayTimePositions: readonly (PlottedTimeAxisPoint | null)[] = [];
  if (timeAxisRange && todayScaled.length > 0 && marketTimezone) {
    const yValues = todayScaled.map((point) => point.y);
    const timeInputs = todayPlottable.map((point) => ({
      date: point.date,
      priceDecimal: point.priceDecimal,
      observedAt: point.observedAt ?? "",
    }));
    if (range === "day") {
      // Historical `plottable` on a Day range is EMPTY unless the loader's
      // own sparse-day supplement (`app/owned-price-history.ts`) found an
      // earlier "previous close" for context -- when it did, that single
      // point's UNMODIFIED date-offset x (`scalePriceHistoryPoints` above)
      // sits at the plot's own left edge (`plotMinX`), the SAME pixel the
      // window-OPEN tick would otherwise land on. Review round-1 fix (F2,
      // BLOCKING): the two markers rendered pixel-identical, with the
      // historical circle's own `<title>` (added below, a pre-existing gap
      // even before this task) effectively unreachable under the diamond
      // drawn on top of it -- a different calendar date shown with no
      // distinguishing mark. Reserving a small gap BEFORE the window
      // starts keeps that context point visually separate from the window
      // it precedes, rather than literally inside it. Skipped when there
      // is no context point to make room for, so an ordinary "day" view
      // (no historical data at all) still uses the FULL plot width.
      const hasDayContextPoint = plottable.length > 0;
      const dayStartX = hasDayContextPoint
        ? plotMinX + DAY_CONTEXT_GAP_PX
        : plotMinX;
      todayTimePositions = positionTodayPointsByObservedTime(
        timeInputs,
        yValues,
        marketTimezone,
        { startX: dayStartX, width: plotMaxX - dayStartX },
        { minX: plotMinX, maxX: plotMaxX },
      );
    } else {
      const allDates = [
        ...plottable.map((point) => point.date),
        ...todayPlottable.map((point) => point.date),
      ];
      if (new Set(allDates).size <= 1) {
        // Review round-1 fix (F1, BLOCKING): the combined domain can span
        // a SINGLE calendar date -- a brand-new holding with no historical
        // observation at all, or MKT-011B's own dedupe rule removing the
        // only same-day historical winner once intraday data exists (the
        // ONLY way to reach a single-date domain here, since a historical
        // point on a DIFFERENT date would make this a genuine 2+-date
        // domain). There is then no "neighbouring day" for a per-day
        // column to bleed into at all, and `calendarColumnWidth` cannot
        // size one sensibly for a one-date domain (it degenerately
        // returns the FULL inner width, which the branch below would then
        // subtract from an `anchorX` sitting at the domain's LEFT edge --
        // not its right -- pushing the whole column far off-screen;
        // reviewer-rendered proof: every tick collapsed onto one pixel,
        // with `withinCaptureWindow` still reporting `true` so the
        // window-clamp disclosure never caught it either). Falls back to
        // the SAME full plot width the DAY range uses instead -- today
        // legitimately owns the whole axis when it is the only date on it.
        todayTimePositions = positionTodayPointsByObservedTime(
          timeInputs,
          yValues,
          marketTimezone,
          { startX: plotMinX, width: plotMaxX - plotMinX },
          { minX: plotMinX, maxX: plotMaxX },
        );
      } else {
        // WEEK (genuinely multi-day domain): size today's column to ONE
        // calendar day's width within the multi-day date-offset axis,
        // ENDING at today's own already-computed date position (never
        // centred on it) -- the range window always ends "today"
        // (`priceHistoryWindow`'s `toDate`), so today is normally the
        // RIGHTMOST/latest date on this axis; a column centred there
        // would overflow past the chart's own right edge and clamp every
        // afternoon tick to the same pixel, destroying exactly the spread
        // this range is meant to show. Ending at `anchorX` also gives a
        // pleasing invariant: the window's own LAST tick (16:25) lands
        // exactly where the plain shared-column marker used to sit.
        const columnWidth = calendarColumnWidth(allDates, SCALE);
        const anchorX = todayScaled[0]!.x;
        todayTimePositions = positionTodayPointsByObservedTime(
          timeInputs,
          yValues,
          marketTimezone,
          { startX: anchorX - columnWidth, width: columnWidth },
          { minX: plotMinX, maxX: plotMaxX },
        );
      }
    }
  }
  // Final today-point geometry: a TIME-positioned x when one resolved
  // (day/week ranges with a known market timezone), else the pre-existing
  // shared-column x from `scaled` above -- a point is NEVER dropped just
  // because it could not be time-positioned.
  const todayFinal = todayScaled.map((point, index) => {
    const sourcePoint = todayPlottable[index]!;
    const timePoint = todayTimePositions[index] ?? null;
    return {
      date: point.date,
      priceDecimal: point.priceDecimal,
      x: timePoint ? timePoint.x : point.x,
      y: point.y,
      quality: sourcePoint.quality,
      observedAt: sourcePoint.observedAt,
      // Only meaningful when this render actually attempted time
      // positioning -- outside day/week ranges (or without a resolvable
      // timezone) there is no window to have fallen outside of. Review
      // round-1 fold (F5): a pre-10:25 `observedAt` is the ORDINARY case
      // for a day's FIRST capture (the provider's own observation instant
      // can trail this app's sweep cadence by an unknown delay -- §17/§21),
      // not an exceptional one -- this flag/its disclosure below exists to
      // handle that routine outcome honestly, not as a rare edge case.
      clampedOutsideWindow:
        timePoint !== null && !timePoint.withinCaptureWindow,
    };
  });
  // Review round-2 fix: gap classification must know the sampling cadence
  // (`bucketSize`) -- a downsampled series' NORMAL point spacing is itself
  // roughly `bucketSize` observations apart and must not be mistaken for a
  // hole (see `classifyPriceHistorySegments`'s doc comment).
  const segments = classifyPriceHistorySegments(
    plottable,
    state.provenance.bucketSize,
  );
  const byDate = new Map(historicalScaled.map((point) => [point.date, point]));
  const bucketSize = state.provenance.bucketSize;
  // MKT-011B: the "continuing" polyline -- the last SETTLED historical
  // point (if any) plus every intraday tick in chronological order, so the
  // line visually continues from the last close into today's session. All
  // of today's ticks share ONE x column (today's calendar date -- see
  // `scalePriceHistoryPoints`'s date-offset x-axis); the vertical spread
  // across that column is today's REAL observed price range, never a
  // fabricated sub-day time axis.
  const todayLinePoints =
    historicalScaled.length > 0
      ? [historicalScaled[historicalScaled.length - 1]!, ...todayFinal]
      : todayFinal;
  const todayProviders = [
    ...new Set(todayPlottable.map((point) => point.providerId)),
  ].sort();
  const lastTodayPoint =
    todayPlottable.length > 0
      ? todayPlottable[todayPlottable.length - 1]!
      : null;
  const ariaFromDate = state.provenance.fromDate ?? todayMarketDate;
  const ariaToDate = state.provenance.toDate ?? todayMarketDate;
  const totalPointCount = plottable.length + todayPlottable.length;
  // MKT-011C: axis min/max attribution -- `scaled.min/maxPriceDecimal` come
  // from the COMBINED historical+today domain (unchanged from MKT-011B), so
  // an intraday tick CAN legitimately set the displayed extreme. Compared by
  // exact decimal STRING (never a float re-parse) against every historical
  // point's own price -- if the extreme's value does not appear among the
  // historical points at all, it can only have come from today's overlay.
  const historicalDecimals = new Set(
    plottable.map((point) => point.priceDecimal),
  );
  const maxFromToday =
    todayPlottable.length > 0 &&
    !historicalDecimals.has(scaled.maxPriceDecimal);
  const minFromToday =
    todayPlottable.length > 0 &&
    !historicalDecimals.has(scaled.minPriceDecimal);
  const latestDelayedTimeLabel = state.latestDelayed
    ? marketLocalTimeLabel(state.latestDelayed.observedAt, marketTimezone)
    : null;

  return (
    <>
      <svg
        className="price-history-svg"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="img"
        aria-label={`${symbol} price history in ${state.currencyCode}; ${totalPointCount} point${
          totalPointCount === 1 ? "" : "s"
        }, ${ariaFromDate ?? "unknown"} to ${ariaToDate ?? "unknown"}${
          todayPlottable.length > 0
            ? " (includes today's intraday capture, delayed, not a close)"
            : ""
        }.`}
      >
        <line
          className="price-history-baseline"
          x1={CHART_PADDING_X}
          y1={CHART_HEIGHT - CHART_PADDING_Y}
          x2={CHART_WIDTH - CHART_PADDING_X}
          y2={CHART_HEIGHT - CHART_PADDING_Y}
        />
        {segments.map((segment, index) => {
          const coords = segment.points
            .map((point) => byDate.get(point.date))
            .filter((point): point is NonNullable<typeof point> => !!point);
          if (coords.length < 2) {
            // Review round-1 fix (F2, BLOCKING): a lone historical point
            // (e.g. the DAY range's "previous close" context supplement)
            // previously rendered with NO accessible title at all -- a
            // pre-existing gap that became actively harmful once the DAY
            // range's time axis could place a same-pixel intraday tick
            // right next to (or, before the F2 gap fix above, literally
            // on top of) it: a different calendar date with nothing to
            // distinguish it. Names the point's own date explicitly.
            return coords.length === 1 ? (
              <circle
                key={`point-${index}`}
                className="price-history-dot"
                cx={coords[0]!.x}
                cy={coords[0]!.y}
                r={2.5}
              >
                <title>{`${coords[0]!.date} (historical).`}</title>
              </circle>
            ) : null;
          }
          return (
            <polyline
              key={`segment-${index}`}
              className={
                segment.gap
                  ? "price-history-line price-history-gap"
                  : "price-history-line"
              }
              points={coords.map((point) => `${point.x},${point.y}`).join(" ")}
            >
              <title>
                {segment.gap
                  ? bucketSize > 1
                    ? // Review round-2 fix: downsampling means the RETURNED
                      // points are already sparse, so a wide delta between
                      // two of them is not proof the raw data has zero rows
                      // in between -- only that it exceeds this series'
                      // normal sampling spacing. "No observations" would be
                      // a false claim here; the coverage line one element
                      // below already discloses the real raw/shown counts.
                      // Review round-3 fix: the threshold used to classify
                      // this AS a gap (see `classifyPriceHistorySegments`)
                      // is NOT the same thing as this series' actual
                      // observed cadence -- stating it as "about one point
                      // per N days" overstated sparsity (the FMG "All" view
                      // is really ~27 calendar days apart, not the ~76-day
                      // threshold). State the comparison, not a fabricated
                      // cadence figure.
                      `Downsampled: a hole in the stored data wider than this series' sampling spacing (between ${segment.points[0]!.date} and ${segment.points[segment.points.length - 1]!.date}).`
                    : `No observations between ${segment.points[0]!.date} and ${segment.points[segment.points.length - 1]!.date}.`
                  : `${segment.points[0]!.date} to ${segment.points[segment.points.length - 1]!.date}`}
              </title>
            </polyline>
          );
        })}
        {/* MKT-011B: when today's intraday overlay has data, ITS latest
            tick (below) is the true "most recent known value" marker;
            the plain historical "latest" dot only applies when there is
            no overlay -- this branch is mathematically identical to the
            pre-MKT-011B behaviour in that case (`historicalScaled` alone
            is `scaled.points` when `todayScaled` is empty). */}
        {historicalScaled.length > 0 && todayScaled.length === 0 ? (
          <circle
            className="price-history-dot price-history-latest"
            cx={historicalScaled[historicalScaled.length - 1]!.x}
            cy={historicalScaled[historicalScaled.length - 1]!.y}
            r={3}
          />
        ) : null}
        {todayScaled.length > 0 ? (
          <g className="price-history-intraday-group">
            {todayLinePoints.length >= 2 ? (
              <polyline
                className="price-history-intraday-line"
                points={todayLinePoints
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
              >
                <title>
                  {`Today${todayMarketDate ? ` (${todayMarketDate})` : ""}: intraday capture, delayed -- not a close. ${todayScaled.length} point${todayScaled.length === 1 ? "" : "s"} captured${todayProviders.length > 0 ? ` (${todayProviders.map(providerDisplayLabel).join(", ")})` : ""}.`}
                </title>
              </polyline>
            ) : null}
            {todayFinal.map((point, index) => {
              const caveat = qualityCaveatLabel(point.quality);
              const time = marketLocalTimeLabel(
                point.observedAt,
                marketTimezone,
              );
              // MKT-011C: non-color distinction (QA-001B) -- ONLY the two
              // LOWER-confidence tiers TASKS.md names ('indicative',
              // 'stale_candidate') render HOLLOW with a dashed outline
              // (`price-history-intraday-uncertain`); 'corrected' still gets
              // its own textual caveat below (a correction is worth noting)
              // but keeps the ordinary FILLED marker -- a correction is MORE
              // trustworthy than a plain 'observed' tick, not less, so the
              // "uncertain" visual language would misrepresent it.
              const isUncertainQuality =
                point.quality === "indicative" ||
                point.quality === "stale_candidate";
              const classNames = [
                "price-history-intraday-dot",
                index === todayFinal.length - 1
                  ? "price-history-intraday-latest"
                  : "",
                isUncertainQuality ? "price-history-intraday-uncertain" : "",
              ]
                .filter(Boolean)
                .join(" ");
              // UI-026 ruling: this SVG <title> is accessible/provenance
              // text (a hover/screen-reader tooltip), not the chart's
              // visible price label -- keeps the exact "amount CODE"
              // suffix form deliberately, so the full ISO code always
              // stays reachable here even though the visible axis below
              // uses the bare/flagged symbol. Never migrated to the
              // symbol form.
              const titleParts = [
                time
                  ? `${time} market-local`
                  : `${chartDate(point.date)} (time unavailable)`,
                `${priceText(point.priceDecimal)} ${state.currencyCode}`,
              ];
              if (caveat) titleParts.push(caveat);
              if (point.clampedOutsideWindow) {
                titleParts.push(
                  "outside the 10:25-16:25 capture window -- shown at the nearest window edge, not its true relative time",
                );
              }
              return (
                <rect
                  key={`today-${point.date}-${index}`}
                  className={classNames}
                  x={point.x - 2.5}
                  y={point.y - 2.5}
                  width={5}
                  height={5}
                  transform={`rotate(45 ${point.x} ${point.y})`}
                >
                  <title>{`${titleParts.join("; ")}.`}</title>
                </rect>
              );
            })}
          </g>
        ) : null}
      </svg>
      <div className="price-history-axis">
        <span>
          {currencyDisplayPrefix(state.currencyCode, baseCurrencyCode)}
          {priceText(scaled.maxPriceDecimal)}
          {maxFromToday ? " (today, intraday)" : ""}
        </span>
        <span>
          {currencyDisplayPrefix(state.currencyCode, baseCurrencyCode)}
          {priceText(scaled.minPriceDecimal)}
          {minFromToday ? " (today, intraday)" : ""}
        </span>
      </div>
      {/* MKT-011C: a today-only chart (no settled historical points survive
          this range, e.g. a brand-new listing on the "Day" view) must not
          render "No date range · 0 points · No provider" while the
          intraday diamonds are visibly plotting real data -- that combo
          reads as "nothing here" when there plainly is something here. The
          ORDINARY coverage line (below) still applies whenever there IS a
          historical point to describe. */}
      {state.provenance.pointCountRaw === 0 && todayPlottable.length > 0 ? (
        <p className="chart-coverage">
          No settled historical points in this range -- see today&apos;s
          intraday capture below.
          {state.provenance.excludedCurrencyCount > 0
            ? ` ${state.provenance.excludedCurrencyCount} other-currency row${state.provenance.excludedCurrencyCount === 1 ? "" : "s"} excluded.`
            : ""}
          {state.provenance.excludedMalformedCount > 0
            ? ` ${state.provenance.excludedMalformedCount} malformed row${state.provenance.excludedMalformedCount === 1 ? "" : "s"} skipped.`
            : ""}
        </p>
      ) : (
        <p className="chart-coverage">
          {state.provenance.fromDate && state.provenance.toDate
            ? `${chartDate(state.provenance.fromDate)} – ${chartDate(state.provenance.toDate)}`
            : "No date range"}{" "}
          · {state.provenance.pointCountRaw} point
          {state.provenance.pointCountRaw === 1 ? "" : "s"}
          {state.provenance.pointCountReturned < state.provenance.pointCountRaw
            ? ` (${state.provenance.pointCountReturned} shown)`
            : ""}{" "}
          · {state.provenance.providers.join(", ") || "No provider"}
          {state.provenance.excludedCurrencyCount > 0
            ? ` · ${state.provenance.excludedCurrencyCount} other-currency row${state.provenance.excludedCurrencyCount === 1 ? "" : "s"} excluded`
            : ""}
          {state.provenance.excludedMalformedCount > 0
            ? ` · ${state.provenance.excludedMalformedCount} malformed row${state.provenance.excludedMalformedCount === 1 ? "" : "s"} skipped`
            : ""}
        </p>
      )}
      {/* UI-026 ruling: the "Delayed" and "Today" provenance lines below
          deliberately KEEP their existing "amount CODE" suffix form rather
          than switching to the axis's bare/flagged symbol -- these are
          provenance/accessibility disclosures (mirroring the SVG <title>
          text above), not the chart's primary visible price label, so
          precision (the full ISO code, always spelled out) wins over the
          compact symbol convention here. */}
      {state.latestDelayed ? (
        <p className="muted-copy">
          Delayed ({providerDisplayLabel(state.latestDelayed.providerId)}):{" "}
          {priceText(state.latestDelayed.priceDecimal)}{" "}
          {state.latestDelayed.currencyCode} as of{" "}
          {chartDate(state.latestDelayed.date)}
          {/* MKT-011C: this line and the "Today" line below can both name
              the SAME calendar date -- disambiguated with a market-local
              TIME now that `observedAt` is plumbed through, so the two are
              never read as the same unqualified same-day figure. */}
          {latestDelayedTimeLabel
            ? `, ${latestDelayedTimeLabel} market-local`
            : ""}
          .
        </p>
      ) : null}
      {/* B1 fix (MKT-011B review): this paragraph must render whenever there
          is EITHER a surviving today point OR a today exclusion to
          disclose -- gating the whole paragraph on `lastTodayPoint` alone
          made an all-excluded day (every tick off-currency or malformed)
          render pixel-identical to "nothing captured today", hiding a
          real data problem behind an honest-looking empty state. */}
      {lastTodayPoint ||
      state.provenance.todayExcludedCurrencyCount > 0 ||
      state.provenance.todayExcludedMalformedCount > 0 ? (
        <p className="muted-copy">
          {lastTodayPoint ? (
            <>
              Today{todayMarketDate ? ` (${chartDate(todayMarketDate)})` : ""},
              intraday, delayed
              {todayProviders.length > 0
                ? ` (${todayProviders.map(providerDisplayLabel).join(", ")})`
                : ""}
              : last {priceText(lastTodayPoint.priceDecimal)}{" "}
              {lastTodayPoint.currencyCode}; {todayPlottable.length} point
              {todayPlottable.length === 1 ? "" : "s"} captured -- not a close.
            </>
          ) : (
            <>
              Today
              {todayMarketDate ? ` (${chartDate(todayMarketDate)})` : ""}: no
              plottable intraday points captured.
            </>
          )}
          {state.provenance.todayExcludedCurrencyCount > 0
            ? ` ${state.provenance.todayExcludedCurrencyCount} other-currency row${state.provenance.todayExcludedCurrencyCount === 1 ? "" : "s"} excluded.`
            : ""}
          {state.provenance.todayExcludedMalformedCount > 0
            ? ` ${state.provenance.todayExcludedMalformedCount} malformed row${state.provenance.todayExcludedMalformedCount === 1 ? "" : "s"} skipped.`
            : ""}
        </p>
      ) : null}
      {state.invalidRangeRequested ? (
        <p className="muted-copy" role="status">
          That range was not recognised; showing{" "}
          {RANGE_LABELS[DEFAULT_PRICE_HISTORY_RANGE]} instead.
        </p>
      ) : null}
    </>
  );
}
