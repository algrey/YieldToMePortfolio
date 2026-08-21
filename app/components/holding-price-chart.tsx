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
  classifyPriceHistorySegments,
  isPlottableDecimal,
  scalePriceHistoryPoints,
} from "../price-history-chart-geometry.ts";
import type {
  PriceHistoryPoint,
  PriceHistoryProvenance,
} from "../owned-price-history.ts";

const FETCH_TIMEOUT_MS = 15_000;
const CHART_WIDTH = 600;
const CHART_HEIGHT = 160;
const CHART_PADDING_X = 8;
const CHART_PADDING_Y = 10;

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
 * decades, where the year is the fact that matters most). */
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

export function HoldingPriceChart({
  portfolioId,
  portfolioSecurityId,
  symbol,
}: {
  portfolioId: string;
  portfolioSecurityId: string;
  symbol: string;
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
}: {
  symbol: string;
  range: PriceHistoryRange;
  state: PriceHistoryFetchState;
  onRangeChange: (range: PriceHistoryRange) => void;
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
        <ChartBody symbol={symbol} state={state} />
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
  state,
}: {
  symbol: string;
  state: Extract<PriceHistoryFetchState, { status: "loaded" }>;
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

  // MKT-011B: scale the historical series AND today's intraday overlay
  // together so both share ONE price/date domain -- the axis reflects the
  // true combined min/max, and today's ticks land in the correct calendar
  // column. Reuses `scalePriceHistoryPoints` UNMODIFIED (it already maps
  // by calendar date, never index) rather than inventing separate overlay
  // geometry; the two halves are split back out below by array position
  // (order is preserved by that function).
  const scaled = scalePriceHistoryPoints([...plottable, ...todayPlottable], {
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
    paddingX: CHART_PADDING_X,
    paddingY: CHART_PADDING_Y,
  });
  if (!scaled) {
    return (
      <p className="muted-copy" role="status">
        No price history in this range.
      </p>
    );
  }
  const historicalScaled = scaled.points.slice(0, plottable.length);
  const todayScaled = scaled.points.slice(plottable.length);
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
      ? [historicalScaled[historicalScaled.length - 1]!, ...todayScaled]
      : todayScaled;
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
            return coords.length === 1 ? (
              <circle
                key={`point-${index}`}
                className="price-history-dot"
                cx={coords[0]!.x}
                cy={coords[0]!.y}
                r={2.5}
              />
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
            {todayScaled.map((point, index) => (
              <rect
                key={`today-${point.date}-${index}`}
                className={
                  index === todayScaled.length - 1
                    ? "price-history-intraday-dot price-history-intraday-latest"
                    : "price-history-intraday-dot"
                }
                x={point.x - 2.5}
                y={point.y - 2.5}
                width={5}
                height={5}
                transform={`rotate(45 ${point.x} ${point.y})`}
              />
            ))}
          </g>
        ) : null}
      </svg>
      <div className="price-history-axis">
        <span>
          {state.currencyCode} {priceText(scaled.maxPriceDecimal)}
        </span>
        <span>
          {state.currencyCode} {priceText(scaled.minPriceDecimal)}
        </span>
      </div>
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
      {state.latestDelayed ? (
        <p className="muted-copy">
          Delayed ({providerDisplayLabel(state.latestDelayed.providerId)}):{" "}
          {priceText(state.latestDelayed.priceDecimal)}{" "}
          {state.latestDelayed.currencyCode} as of{" "}
          {chartDate(state.latestDelayed.date)}.
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
