/**
 * UI-018: pure SVG-geometry derivation for the holding-detail price-history
 * chart -- mirrors `app/overview-chart.ts`'s split (bounded/derived series
 * logic kept separate from the rendering component so it is unit-testable
 * without `renderToStaticMarkup`). No chart dependency: this only computes
 * plain numbers/strings; `app/components/holding-price-chart.tsx` turns
 * them into `<svg>` markup.
 *
 * Pixel positions here are deliberately plain JS numbers (never the exact
 * decimal arithmetic AGENTS.md requires for money) -- they are SCREEN
 * GEOMETRY, not a financial computation or a displayed value. Every price
 * actually shown to the owner (axis labels, point tooltips) uses the
 * original decimal STRING untouched; only the pixel Y position is a float
 * approximation of it.
 */
import { parseDecimalResult } from "../domain/calculations/index.ts";

export type ChartInputPoint = Readonly<{
  date: string;
  priceDecimal: string;
}>;

/** Whole-day offset since the Unix epoch, UTC, for a `YYYY-MM-DD` date --
 * used only to compare/scale calendar distance, never displayed. */
export function dateDayOffset(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return 0;
  const [, year, month, day] = match;
  return Math.floor(
    Date.UTC(Number(year), Number(month) - 1, Number(day)) / 86_400_000,
  );
}

export type PriceHistorySegment = Readonly<{
  points: readonly ChartInputPoint[];
  /** True for a segment spanning an unusually large date gap -- rendered
   * dashed/muted by the caller rather than a plain solid line, so a hole
   * in the data is never visually indistinguishable from continuous
   * observation. */
  gap: boolean;
}>;

/** Review round-1 follow-up (F1): a segment delta beyond this MANY calendar
 * days is always a gap, independent of the median-relative rule below.
 * Exists because the median rule is a RELATIVE measure and degrades exactly
 * when it is needed most: a 2-3 point series has only 1-2 deltas, so the
 * "median" IS one of the actual deltas and a single 4x-median comparison
 * can never flag it (an 8-year hole between two points drew a plain solid
 * line -- the reported repro). This is the FLOOR for an UNDOWNSAMPLED
 * series (`bucketSize` 1); see `EXPECTED_CADENCE_DAYS` immediately below
 * for how it scales once the series has been downsampled. */
const ABSOLUTE_GAP_FLOOR_DAYS = 10;

/**
 * Review round-2 fix (the F1 fix's own regression, BLOCKING): a plain,
 * UNSCALED `ABSOLUTE_GAP_FLOOR_DAYS` broke every heavily downsampled long
 * range. Downsampling (`downsamplePriceHistoryPoints`) returns one point
 * per `bucketSize` raw observations, so the RETURNED point spacing IS
 * roughly `bucketSize` trading days apart even when the underlying data has
 * NO hole at all -- a 28-year, ~7,313-point history capped to 400 points
 * (`bucketSize` ~19) legitimately shows points ~19 trading days apart, and
 * a flat 10-calendar-day floor flagged EVERY one of those as a "gap",
 * dashing the entire line and titling each segment "No observations
 * between X and Y" -- false, since the observations exist; downsampling
 * simply did not return them individually.
 *
 * Fix: scale the absolute floor to the sampling cadence. `~4` is an
 * approximate calendar-day-per-trading-day cadence for ordinary daily
 * data once weekends are accounted for (5 trading days span ~7 calendar
 * days, rounded up for the occasional holiday) -- not a precise trading
 * calendar, just enough headroom that one bucket's worth of NORMAL
 * downsampled spacing is never mistaken for a hole.
 *
 * Review round-3 fix: this is a CLASSIFICATION threshold, not a claim
 * about this series' actual observed cadence -- the two can differ a lot
 * (the 28-year FMG "All" view classifies at ~76 days but its real spacing
 * is ~27 calendar days). Earlier renderer code surfaced this number
 * directly in a downsampled gap's title ("about one point per N days"),
 * which overstated sparsity by ~2.8x. Kept module-private now that the
 * renderer no longer reads it -- the gap title states the comparison
 * ("wider than this series' sampling spacing"), never a fabricated
 * cadence figure. */
const EXPECTED_CADENCE_DAYS = 4;

/**
 * Splits a chronologically-sorted point series into solid/gap segments so
 * the chart never draws a plain solid line across a hole in the data as if
 * the price moved smoothly through it (TASKS.md UI-018: "gaps in data
 * render as gaps"). RULE (documented, NOT a claim of perfect gap
 * detection): a segment is a gap when EITHER (a) its delta exceeds 4x the
 * series' median inter-point spacing (floor 5 days, so an ordinary
 * daily-dominated series with one missed weekend/holiday never misfires),
 * OR (b) its delta exceeds `max(ABSOLUTE_GAP_FLOOR_DAYS, bucketSize *
 * EXPECTED_CADENCE_DAYS)` -- an absolute floor SCALED to how heavily this
 * series was downsampled, so normal bucket-to-bucket spacing in a long
 * range is never itself mistaken for a hole, while a genuine hole (many
 * times wider than the sampling cadence) still stands out. `bucketSize`
 * defaults to 1 (no downsampling), matching `downsamplePriceHistoryPoints`'s
 * own no-op default. A gap segment shares both endpoints with its solid
 * neighbours so the line stays visually continuous -- the dash pattern
 * marks it as uncertain, not a visible break in the line itself. Callers
 * MUST vary the segment's title by `bucketSize` (see
 * `app/components/holding-price-chart.tsx`) -- "No observations between
 * X and Y" is only true when `bucketSize === 1`; a downsampled gap is a
 * hole LARGER than the sampling spacing, not proof of zero raw rows.
 */
export function classifyPriceHistorySegments(
  points: readonly ChartInputPoint[],
  bucketSize = 1,
): readonly PriceHistorySegment[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ points, gap: false }];
  const deltas = points
    .slice(1)
    .map(
      (point, index) =>
        dateDayOffset(point.date) - dateDayOffset(points[index]!.date),
    );
  const sortedDeltas = [...deltas].sort((left, right) => left - right);
  const median = sortedDeltas[Math.floor(sortedDeltas.length / 2)] ?? 1;
  const relativeThreshold = Math.max(median * 4, 5);
  const cadenceFloor = Math.max(
    ABSOLUTE_GAP_FLOOR_DAYS,
    Math.max(bucketSize, 1) * EXPECTED_CADENCE_DAYS,
  );
  const segments: PriceHistorySegment[] = [];
  let current: ChartInputPoint[] = [points[0]!];
  for (let index = 1; index < points.length; index += 1) {
    const delta = deltas[index - 1]!;
    if (delta > relativeThreshold || delta > cadenceFloor) {
      segments.push({ points: current, gap: false });
      segments.push({
        points: [points[index - 1]!, points[index]!],
        gap: true,
      });
      current = [points[index]!];
    } else {
      current.push(points[index]!);
    }
  }
  segments.push({ points: current, gap: false });
  return segments.filter((segment) => segment.points.length > 0);
}

export type PlottedPoint = Readonly<{
  date: string;
  priceDecimal: string;
  x: number;
  y: number;
}>;

export type ChartScale = Readonly<{
  width: number;
  height: number;
  paddingX: number;
  paddingY: number;
}>;

export type ScaledPriceHistory = Readonly<{
  points: readonly PlottedPoint[];
  minPriceDecimal: string;
  maxPriceDecimal: string;
}>;

/**
 * Maps points to SVG pixel coordinates. X is proportional to calendar-date
 * offset, never index-spaced -- an index-spaced x-axis would visually
 * compress a genuine multi-year gap into the same width as one trading
 * day, which is its own kind of fabrication. Y is proportional to price
 * between the series' own min/max; a perfectly flat series (min == max)
 * renders as a flat line at vertical mid-height rather than dividing by
 * zero or collapsing to one edge.
 */
export function scalePriceHistoryPoints(
  points: readonly ChartInputPoint[],
  scale: ChartScale,
): ScaledPriceHistory | null {
  if (points.length === 0) return null;
  const offsets = points.map((point) => dateDayOffset(point.date));
  const minOffset = Math.min(...offsets);
  const maxOffset = Math.max(...offsets);
  const offsetSpan = maxOffset - minOffset || 1;

  const numericPrices = points.map((point) => Number(point.priceDecimal));
  let minIndex = 0;
  let maxIndex = 0;
  numericPrices.forEach((value, index) => {
    if (value < numericPrices[minIndex]!) minIndex = index;
    if (value > numericPrices[maxIndex]!) maxIndex = index;
  });
  const minPrice = numericPrices[minIndex]!;
  const maxPrice = numericPrices[maxIndex]!;
  const rawSpan = maxPrice - minPrice;
  const priceSpan = rawSpan || 1;

  const innerWidth = scale.width - scale.paddingX * 2;
  const innerHeight = scale.height - scale.paddingY * 2;

  const plotted = points.map((point, index) => {
    const x =
      scale.paddingX +
      ((offsets[index]! - minOffset) / offsetSpan) * innerWidth;
    const y =
      rawSpan === 0
        ? scale.paddingY + innerHeight / 2
        : scale.paddingY +
          innerHeight -
          ((numericPrices[index]! - minPrice) / priceSpan) * innerHeight;
    return { date: point.date, priceDecimal: point.priceDecimal, x, y };
  });

  return {
    points: plotted,
    minPriceDecimal: points[minIndex]!.priceDecimal,
    maxPriceDecimal: points[maxIndex]!.priceDecimal,
  };
}

/** Guards a price string is a real, positive decimal before it reaches
 * `Number()` above -- defends chart geometry against a malformed value
 * reaching pixel math with a NaN/Infinity, without pulling display
 * formatting into this module. */
export function isPlottableDecimal(value: string): boolean {
  try {
    parseDecimalResult(value);
    return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
  } catch {
    return false;
  }
}
