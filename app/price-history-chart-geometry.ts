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
import {
  resolveDailyCaptureWindowStatus,
  WINDOW_CLOSE_MINUTES,
  WINDOW_OPEN_MINUTES,
} from "../domain/market-data/daily-capture-window.ts";

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

/** UI-041 ("Lets work on the graphs... run my finger, or the mouse across
 * the graph"): a chart's own "is there anything real to plot" gate, shared
 * by both `PortfolioValueChart` (whose "empty" branch previously ALWAYS
 * rendered a redundant EmptyState panel above it, even when this
 * independent HIST-001 read-time series genuinely had data -- see
 * `app/components/portfolio-shell.tsx`) and, in principle, any future
 * caller needing the same check. `status !== "ok"` (an "empty"/"unavailable"
 * read) or a points list with no genuinely plottable value is never
 * "usable" -- mirrors this module's own `isPlottableDecimal` guard rather
 * than a bare `points.length > 0` check, so a series of nothing-but-gap
 * points (`valueDecimal: null`) is correctly treated as unusable too. */
export type UsableHistoryPoint = Readonly<{ valueDecimal: string | null }>;

export function hasUsableHistoryPoints(
  status: "ok" | "empty" | "unavailable",
  points: readonly UsableHistoryPoint[],
): boolean {
  if (status !== "ok") return false;
  return points.some(
    (point) =>
      point.valueDecimal !== null && isPlottableDecimal(point.valueDecimal),
  );
}

/**
 * UI-041: inverse of `dateDayOffset` above -- whole-day epoch offset back to
 * a plain `YYYY-MM-DD` calendar date, using only `getUTCFullYear`/
 * `getUTCMonth`/`getUTCDate` numeric getters (never `toLocaleDateString`/
 * `Intl`/any textual formatting) so this stays exactly as hydration-safe as
 * `dateDayOffset` itself (BUG-003) -- it only ever feeds a synthetic AXIS
 * TICK position back into a real calendar date, never a displayed money
 * value, so plain integer date math is the right tool here, same as the
 * rest of this module's pixel geometry.
 */
export function isoDateFromDayOffset(offset: number): string {
  const date = new Date(offset * 86_400_000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type XAxisTick = Readonly<{ date: string; x: number }>;

/**
 * UI-041: evenly-time-spaced x-axis date ticks across the SAME calendar-date
 * pixel domain `scalePriceHistoryPoints` above uses (never index-spaced, for
 * the identical honesty reason that function's own doc comment gives) --
 * reusing that exact `paddingX + (offset-minOffset)/offsetSpan*innerWidth`
 * formula so a rendered tick lines up with where a real point at that same
 * date would plot. Deliberately does NOT require a tick date to be an
 * actual OBSERVED point -- an axis tick names a POSITION on the scale, not
 * a claimed data value (unlike a plotted point/gridline value, which must
 * always come from real data); a genuine data gap under a tick is not
 * misrepresented by this, since no line/marker is drawn there.
 *
 * `targetCount` is a target, not a guarantee: rounding two adjacent
 * fractional offsets to the SAME whole day (a short-range chart, e.g. a
 * handful of days, with a high target count) collapses to one tick rather
 * than a duplicate label. A single-distinct-date domain returns exactly one
 * tick at that date's own (left-edge) pixel position, mirroring
 * `scalePriceHistoryPoints`'s own single-date `offsetSpan || 1` fallback.
 */
export function computeXAxisTicks(
  dates: readonly string[],
  scale: ChartScale,
  targetCount = 4,
): readonly XAxisTick[] {
  if (dates.length === 0) return [];
  const innerWidth = scale.width - scale.paddingX * 2;
  const offsets = dates.map(dateDayOffset);
  const minOffset = Math.min(...offsets);
  const maxOffset = Math.max(...offsets);
  if (minOffset === maxOffset) {
    return [{ date: isoDateFromDayOffset(minOffset), x: scale.paddingX }];
  }
  const offsetSpan = maxOffset - minOffset;
  const count = Math.max(2, targetCount);
  const seenOffsets = new Set<number>();
  const ticks: XAxisTick[] = [];
  for (let index = 0; index < count; index += 1) {
    const fraction = index / (count - 1);
    const offset = Math.round(minOffset + fraction * offsetSpan);
    if (seenOffsets.has(offset)) continue;
    seenOffsets.add(offset);
    const x = scale.paddingX + ((offset - minOffset) / offsetSpan) * innerWidth;
    ticks.push({ date: isoDateFromDayOffset(offset), x });
  }
  return ticks;
}

export type YAxisTick = Readonly<{ value: number; y: number }>;

export type YAxisTicks = Readonly<{
  ticks: readonly YAxisTick[];
  /** The "nice" round step between consecutive tick VALUES -- callers use
   * this to decide how many decimal places a tick's value needs (e.g.
   * `step = 1000` needs none; `step = 0.05` needs two), rather than each
   * caller re-deriving it from the returned values. */
  step: number;
}>;

/**
 * UI-041: "a small, readable count of y-axis gridline labels at round
 * values" -- a classic 1/2/5-per-decade "nice number" step size (same
 * family as D3's `d3.ticks`), so labels read as round numbers (10, 20, 50,
 * 100, ...) rather than an awkward exact fraction of the data's own span.
 * Deliberately SEPARATE from the chart's own real min/max labels (still
 * rendered by the caller from the exact observed decimal strings,
 * untouched) -- these are supplementary reference gridlines, plain
 * approximate numbers by construction, never presented as an exact
 * observed fact. Degenerates to a single tick at vertical center for a
 * flat/degenerate (min >= max) series, mirroring
 * `scalePriceHistoryPoints`'s own flat-series centering.
 */
export function computeYAxisTicks(
  minValue: number,
  maxValue: number,
  scale: ChartScale,
  targetCount = 5,
): YAxisTicks {
  const innerHeight = scale.height - scale.paddingY * 2;
  if (
    !Number.isFinite(minValue) ||
    !Number.isFinite(maxValue) ||
    maxValue <= minValue
  ) {
    const value = Number.isFinite(minValue) ? minValue : 0;
    return {
      ticks: [{ value, y: scale.paddingY + innerHeight / 2 }],
      step: 0,
    };
  }
  const span = maxValue - minValue;
  const rawStep = span / Math.max(1, targetCount - 1);
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = Math.pow(10, exponent);
  const normalized = rawStep / magnitude;
  const niceNormalized =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = niceNormalized * magnitude;
  // Review B3 (BLOCKING): the caller separately renders the chart's own
  // EXACT min/max as its two extreme labels -- this loop must therefore
  // return ONLY genuinely interior ticks, never one that merely FLOAT-
  // DRIFTED from a boundary (e.g. a naive `Math.ceil(minValue / step) *
  // step` reconstructing 19.200000000000003 for a (19.2, 19.5) domain,
  // which then compared as "greater than" the true 19.2 minimum and leaked
  // through as a false near-duplicate intermediate). A step-relative
  // epsilon on the INDEX bounds themselves (not a post-hoc value compare)
  // keeps any tick within it a whole `step` away from either boundary.
  const epsilon = step / 1000;
  const firstIndex = Math.ceil((minValue + epsilon) / step);
  const lastIndex = Math.floor((maxValue - epsilon) / step);
  const values: number[] = [];
  // Fold-in: a hard cap, independent of the 1/2/5-nice-step math above
  // (which should never itself produce far more than `targetCount` ticks) --
  // a structural safety net against this loop ever running unbounded if
  // that math changes in the future.
  const MAX_TICKS = 32;
  for (
    let index = firstIndex;
    index <= lastIndex && values.length < MAX_TICKS;
    index += 1
  ) {
    values.push(index * step);
  }
  return {
    ticks: values.map((value) => ({
      value,
      y:
        scale.paddingY +
        innerHeight -
        ((value - minValue) / span) * innerHeight,
    })),
    step,
  };
}

/**
 * UI-041 review B3 (BLOCKING): a second, DISPLAY-level safety net on top of
 * `computeYAxisTicks`'s own value-level epsilon above -- that guard only
 * protects the raw numeric VALUES; it cannot know a caller's own chosen
 * display precision (e.g. `PortfolioValueChart` always rounds an
 * intermediate to whole dollars, coarser than the tick step itself). Two
 * failure modes this closes:
 *  - a coarser display rounding pushing an intermediate's RENDERED number
 *    past the series' true min/max (e.g. a raw 1000.6 tick, honestly
 *    inside a (1000.2, 1000.8) domain, rounding to a displayed "1001" --
 *    a label that reads as ABOVE the real observed maximum);
 *  - two distinct raw tick values collapsing to the SAME rendered text at
 *    that precision (e.g. a (0.001, 0.004) domain's ticks both rounding to
 *    a displayed "0" under whole-dollar formatting) -- kept only once.
 * `reservedTexts` should be the chart's own two EXACT extreme labels
 * formatted through this SAME `formatText` function (not their real,
 * differently-precisioned visible rendering) purely so a same-magnitude
 * intermediate is recognised as colliding with an extreme even though the
 * extreme's own visible label uses a different (usually finer) precision.
 *
 * CONTRACT (review follow-up): `formatText` must return a BARE number
 * string (digits, an optional decimal point, optional thousands commas --
 * e.g. "1,001" or "19.4"), never one with a currency symbol/prefix glued
 * on. The out-of-range half of this check re-parses that text back to a
 * number (`Number(text.replace(/,/g, ""))`) purely to compare it against
 * `minValue`/`maxValue`; a prefixed string (e.g. "$1,001") reparses to
 * `NaN`, and `Number.isFinite(numeric)` guards that case explicitly --
 * this DEGRADES to "keep the tick" (skips only the range check, the text-
 * collision check above still applies) rather than throwing or
 * mis-dropping a tick it cannot evaluate. Callers apply their own currency
 * prefix afterwards, once, when rendering `tick.text`.
 */
export function dropCollidingOrOutOfRangeTicks<T extends { value: number }>(
  ticks: readonly T[],
  formatText: (tick: T) => string,
  minValue: number,
  maxValue: number,
  reservedTexts: readonly string[],
): readonly (T & { text: string })[] {
  const seen = new Set(reservedTexts);
  const kept: (T & { text: string })[] = [];
  for (const tick of ticks) {
    const text = formatText(tick);
    if (seen.has(text)) continue;
    const numeric = Number(text.replace(/,/g, ""));
    if (
      Number.isFinite(numeric) &&
      (numeric < minValue || numeric > maxValue)
    ) {
      continue;
    }
    seen.add(text);
    kept.push({ ...tick, text });
  }
  return kept;
}

/**
 * UI-041 review F1 (BLOCKING): a text/value-collision filter alone
 * (`dropCollidingOrOutOfRangeTicks` above) only catches labels that render
 * IDENTICAL or out-of-range text -- two DIFFERENT nearby values (e.g. an
 * exact max at `y=10` and a "nice" intermediate at `y=14.5`, out of a
 * 0-160 viewBox) still visually OVERPRINT each other, since neither's
 * rendered text line fits in that few-viewBox-unit vertical gap at the
 * narrowest supported (320px) rendered chart width.
 *
 * Pure, purely geometric, and independent of any particular tick's VALUE
 * or TEXT: given the chart's two fixed extreme y positions (`extremeYs`,
 * `[topY, bottomY]` -- always kept, rendered exactly, never filtered by
 * this function) and a candidate list of intermediate ticks, keeps only
 * the intermediates whose `y` sits at least `minSeparation` viewBox units
 * away from BOTH extremes and from every previously-kept intermediate.
 * Candidates are processed in ascending-`y` (top-to-bottom) order, so a
 * run of closely-spaced candidates keeps at most one of them, and the
 * kept set is returned in that same top-to-bottom order.
 *
 * `minSeparation` defaults to 32 -- the viewBox-unit height one text
 * label's line-box needs at the narrowest supported 320px chart width.
 * `CHART_HEIGHT` (this module's charts both use 160) stays a FIXED
 * viewBox-unit height regardless of the SVG's actual rendered width (per
 * its own `viewBox`), so one fixed threshold protects every wider
 * rendered width too, not just 320px.
 */
export function filterTicksByVerticalSeparation<T extends { y: number }>(
  ticks: readonly T[],
  extremeYs: readonly [number, number],
  minSeparation = 32,
): readonly T[] {
  const [topY, bottomY] = extremeYs;
  const sorted = [...ticks].sort((left, right) => left.y - right.y);
  const kept: T[] = [];
  let lastKeptY = topY;
  for (const tick of sorted) {
    if (tick.y - lastKeptY < minSeparation) continue;
    if (bottomY - tick.y < minSeparation) continue;
    kept.push(tick);
    lastKeptY = tick.y;
  }
  return kept;
}

/**
 * UI-041 review F2 (BLOCKING): the y-axis label gutter must size to its
 * OWN content -- a fixed pixel width (58px) truncated a real large
 * portfolio value ("$1,337,203.50" ellipsised to "$1,337,20…"). Returns a
 * CSS `ch`-unit width (the LONGEST currently-rendered label's character
 * count, plus one character of breathing room) for the caller to apply as
 * an inline `width` style -- `ch` is used rather than a computed pixel
 * width so this stays purely a function of the label STRINGS themselves:
 * deterministic (no `getBoundingClientRect`/layout read, so no server-
 * vs-client hydration divergence -- BUG-002/BUG-003) and immune to any
 * particular font's metrics. Returns `0` for an empty label list (nothing
 * to size against) rather than a bogus positive width.
 */
export function axisGutterWidthCh(labels: readonly string[]): number {
  if (labels.length === 0) return 0;
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return longest + 1;
}

/**
 * UI-041: plain-JS-number formatting for a synthetic axis tick VALUE (never
 * a real financial fact -- see `computeYAxisTicks`'s own doc comment above).
 * Chooses a decimal-place count from the tick STEP itself (a step of `1000`
 * needs none; a step of `0.05` needs two), rounds via `toFixed` (plain
 * floating-point, exactly like this module's own pixel math) rather than
 * routing the value through `domain/calculations`'s strict decimal parser
 * (sized for real financial facts on the wire -- a float-arithmetic-derived
 * "nice" tick value is not one, and can carry float-dust digits that parser
 * would reject), and trims a trailing ".00"/".0" the same way
 * `formatDecimalTrimmed`'s `trimTrailingZeros` option does. Callers still
 * apply `groupThousands` and their own currency prefix on top of this.
 */
export function formatAxisTickValue(value: number, step: number): string {
  const decimals =
    step > 0 ? Math.max(0, Math.min(6, -Math.floor(Math.log10(step)))) : 0;
  const fixed = value.toFixed(decimals);
  if (decimals === 0) return fixed;
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * UI-041: the pure "which real point is the pointer nearest to" rule behind
 * the scrub/hover readout on both charts -- nearest by PIXEL X distance
 * only, over the array of already-plotted (real, never fabricated) points.
 * Never interpolates a value between two points: a pointer sitting over a
 * genuine date gap simply lands closer to one real neighbour than the
 * other and that neighbour's own real point is returned, exactly the
 * "gaps stay gaps, snap to the nearest real point" rule this task's owner
 * directive asked for. Returns `null` only for an empty series (nothing to
 * snap to); a tie is broken toward the EARLIER (lower) index, deterministic
 * and simple, never a coin flip.
 */
export function findNearestPointIndexByX(
  points: readonly { x: number }[],
  pointerX: number,
): number | null {
  if (points.length === 0) return null;
  let nearestIndex = 0;
  let nearestDistance = Math.abs(points[0]!.x - pointerX);
  for (let index = 1; index < points.length; index += 1) {
    const distance = Math.abs(points[index]!.x - pointerX);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}

/**
 * UI-041 review follow-up: pure "pointer clientX -> chart user-space x"
 * conversion, extracted out of each chart's own inline pointer handler so
 * the DOM-independent math (the only part that can be unit-tested without
 * a real `getBoundingClientRect`) is testable directly. `rectWidth === 0`
 * (an unlaid-out/zero-width element -- never expected in a real browser
 * paint, but a defensive guard against a divide-by-zero) degrades to the
 * chart's own left edge rather than `NaN`/`Infinity`.
 */
export function plotXFromClientX(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  chartWidth: number,
): number {
  const fraction = rectWidth === 0 ? 0 : (clientX - rectLeft) / rectWidth;
  return fraction * chartWidth;
}

/**
 * UI-041 review follow-up: pure keyboard-stepping rule behind both charts'
 * scrub/hover readout, extracted out of each chart's own inline
 * `handleKeyDown` so the stepping logic itself (bounds/no-wrap/Home/End/
 * Escape) is unit-testable without rendering. Returns:
 *  - the NEW active index for a recognised navigation key (`ArrowRight`/
 *    `ArrowLeft`/`Home`/`End`), clamped to `[0, length - 1]` -- stepping
 *    past either end holds at that end rather than wrapping around;
 *  - `null` for `Escape` (clears the readout);
 *  - `undefined` for any other key, a "not handled" sentinel so the caller
 *    knows not to call `preventDefault()`/update state at all.
 * `length === 0` (nothing to step through) always returns `undefined`
 * regardless of key, since there is nothing a navigation key could
 * meaningfully select.
 */
export function stepActiveIndex(
  key: string,
  previousIndex: number | null,
  length: number,
): number | null | undefined {
  if (length === 0) return undefined;
  if (key === "ArrowRight") {
    return Math.min(length - 1, previousIndex === null ? 0 : previousIndex + 1);
  }
  if (key === "ArrowLeft") {
    return Math.max(0, previousIndex === null ? length - 1 : previousIndex - 1);
  }
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "Escape") return null;
  return undefined;
}

/**
 * MKT-011C: true sub-day time axis for today's intraday overlay. Deliberately
 * a SEPARATE pure function rather than a change to `scalePriceHistoryPoints`
 * above (which stays byte-for-byte unmodified, and keeps driving every
 * historical range's calendar-date x-axis, plus the Y/price-domain math
 * shared with today's points -- MKT-011B's precedent) -- this only
 * REPOSITIONS the x-coordinate of already-Y-scaled "today" points onto a
 * time-of-day axis spanning the market-local capture window (10:25-16:25,
 * `domain/market-data/daily-capture-window.ts`'s own boundary constants, so
 * this can never silently drift out of sync with the window the capture
 * sweep itself gates on).
 */
export type TimeAxisInputPoint = Readonly<{
  date: string;
  priceDecimal: string;
  /** The tick's own UTC observation instant (ISO). */
  observedAt: string;
}>;

export type PlottedTimeAxisPoint = Readonly<{
  date: string;
  priceDecimal: string;
  observedAt: string;
  x: number;
  y: number;
  /** False when this tick's local observed time fell OUTSIDE the
   * 10:25-16:25 capture window and was CLAMPED to the nearest window edge
   * rather than excluded from the plot. `observedAt` is the PROVIDER's own
   * reported observation instant, not this app's capture timestamp -- the
   * window only gates WHEN this app's sweep fires a new capture tick
   * (`domain/market-data/daily-capture-window.ts`), and §17/§21's delayed
   * quotes carry an UNKNOWN delay magnitude relative to that tick. A
   * pre-10:25 `observedAt` on a day's FIRST capture is therefore an
   * ORDINARY, EXPECTED outcome (a delayed source's most recent price at
   * 10:25 local can easily have been observed several minutes earlier, or
   * still be reporting the prior session), not an exceptional edge case --
   * clamping is the routine path this exists to handle honestly, not a
   * rare defensive fallback. DOCUMENTED CHOICE: a real captured observation
   * is never dropped from the chart for landing outside the window -- it
   * stays visible at the correct RELATIVE end of the session, and this
   * flag lets the caller mark it distinctly so the clamp is never visually
   * indistinguishable from an ordinary in-window tick. */
  withinCaptureWindow: boolean;
}>;

export type TimeAxisColumn = Readonly<{
  /** Left pixel edge of the time axis (10:25). */
  startX: number;
  /** Pixel width the FULL 10:25-16:25 window spans. */
  width: number;
}>;

export type TimeAxisBounds = Readonly<{ minX: number; maxX: number }>;

/**
 * Positions each point in `points` (parallel-indexed with `yValues`, which
 * the caller already derived from the SHARED `scalePriceHistoryPoints` price
 * domain -- untouched here) onto `column`'s pixel span by its OWN
 * `observedAt`'s local time-of-day in `marketTimezone`, reusing
 * `resolveDailyCaptureWindowStatus` (the exact derivation the capture sweep
 * and the loader's own "today" resolution already use, per TASKS.md
 * MKT-011C) rather than a second bespoke `Intl.DateTimeFormat` call.
 *
 * Returns `null` at a given index (never throws, never guesses) when that
 * point's `observedAt` or `marketTimezone` cannot be resolved to a local
 * time -- the caller falls back to that point's PRE-EXISTING calendar-date x
 * (from the shared `scalePriceHistoryPoints` call) rather than losing the
 * point or fabricating a time.
 *
 * `bounds` clamps the final pixel x into the chart's own plot area -- a
 * defensive floor/ceiling independent of `column`. The two current callers
 * (`app/components/holding-price-chart.tsx`) each size `column` to stay
 * within `bounds` in the ORDINARY case (DAY: the full plot width; WEEK: one
 * calendar-day's width ENDING at today's own date position, never centred
 * on it, so it cannot overflow the right edge a "today is the latest date"
 * range normally sits at) -- but a caller-side sizing bug can still produce
 * a `column` that does not overlap `bounds` AT ALL (review round-1 fix F1,
 * BLOCKING: WEEK's per-day column math assumed a genuinely multi-day
 * combined domain; when the domain actually spans a SINGLE calendar date --
 * a brand-new holding with no historical observation yet, or MKT-011B's own
 * dedupe rule removing the only same-day historical winner once intraday
 * data exists -- `calendarColumnWidth` degenerately returns the FULL inner
 * width, and subtracting that from an `anchorX` sitting at the domain's
 * LEFT edge, not its right, pushed the whole column far off-screen).
 * BLINDLY clamping every point's x into `bounds` in that situation is its
 * own silent failure mode: every tick collapses onto ONE pixel at a bounds
 * edge, and `withinCaptureWindow` stays `true` for an ordinary in-window
 * tick (the collapse is a PIXEL-bounds clamp, not a capture-window clamp,
 * so the window-based disclosure never catches it either) -- reviewer
 * rendered proof. The guard immediately below instead treats a
 * NON-OVERLAPPING column exactly like an unresolvable timezone: every point
 * returns `null`, so the caller falls back to its own PRE-EXISTING
 * (shared calendar-date) x for all of them rather than a misleading stack.
 */
export function positionTodayPointsByObservedTime(
  points: readonly TimeAxisInputPoint[],
  yValues: readonly number[],
  marketTimezone: string,
  column: TimeAxisColumn,
  bounds: TimeAxisBounds,
): readonly (PlottedTimeAxisPoint | null)[] {
  const columnEndX = column.startX + column.width;
  // `<=`/`>=`, not `<`/`>`: a column that only TOUCHES a bounds edge (zero
  // genuine overlap width) is just as degenerate as one that misses
  // entirely -- only the single fraction landing exactly on that edge maps
  // inside `bounds` unclamped, every other fraction clamps to the SAME
  // pixel, which is the exact collapse this guard exists to catch (the
  // reviewer's reproduction: `startX = 8 - 584 = -576`, `width = 584` gives
  // `columnEndX = 8`, touching `bounds.minX` exactly rather than missing
  // it outright).
  if (columnEndX <= bounds.minX || column.startX >= bounds.maxX) {
    return points.map(() => null);
  }
  const span = WINDOW_CLOSE_MINUTES - WINDOW_OPEN_MINUTES || 1;
  return points.map((point, index) => {
    const status = resolveDailyCaptureWindowStatus(
      point.observedAt,
      marketTimezone,
    );
    if (!status) return null;
    const withinCaptureWindow =
      status.localMinutesOfDay >= WINDOW_OPEN_MINUTES &&
      status.localMinutesOfDay <= WINDOW_CLOSE_MINUTES;
    const clampedMinutes = Math.min(
      WINDOW_CLOSE_MINUTES,
      Math.max(WINDOW_OPEN_MINUTES, status.localMinutesOfDay),
    );
    const fraction = (clampedMinutes - WINDOW_OPEN_MINUTES) / span;
    const rawX = column.startX + fraction * column.width;
    const x = Math.min(bounds.maxX, Math.max(bounds.minX, rawX));
    return {
      date: point.date,
      priceDecimal: point.priceDecimal,
      observedAt: point.observedAt,
      x,
      y: yValues[index]!,
      withinCaptureWindow,
    };
  });
}

/**
 * One calendar day's pixel width within a `scalePriceHistoryPoints`
 * date-offset domain spanning `dates` -- re-derives that function's own
 * offset-span math (not exported by it) purely to size "today"'s column on
 * a MULTI-day range (WEEK) so its intraday spread never bleeds into a
 * neighbouring day's column.
 *
 * Falls back to the full inner width when `dates` spans a single calendar
 * day, or is empty (defensive; never divides by a computed `Infinity`/`NaN`
 * span from `Math.min/max` on an empty array). Review round-1 fix (F1,
 * BLOCKING): an earlier version of this comment claimed that fallback
 * "matches `scalePriceHistoryPoints`'s own `offsetSpan || 1` fallback" --
 * true for THAT function (a single-date domain legitimately renders as one
 * flat line at the plot's left edge), but FALSE as a rationale for THIS
 * function's only multi-day consumer (WEEK): the caller does not use this
 * return value as a full-width column, it SUBTRACTS it from an anchor point
 * to compute where a NARROW one-day column starts, so returning the FULL
 * inner width there produced a column that ran hundreds of pixels off the
 * left edge of the chart (the exact bug the reviewer caught). The caller
 * (`app/components/holding-price-chart.tsx`) now special-cases a
 * single-calendar-date combined domain itself -- using the SAME full-width
 * column the DAY range uses instead of calling into this per-day-width
 * math at all -- and `positionTodayPointsByObservedTime`'s own bounds-
 * overlap guard is a second, independent safety net if some OTHER caller
 * ever repeats this mistake.
 */
export function calendarColumnWidth(
  dates: readonly string[],
  scale: ChartScale,
): number {
  const innerWidth = scale.width - scale.paddingX * 2;
  if (dates.length === 0) return innerWidth;
  const offsets = dates.map(dateDayOffset);
  const minOffset = Math.min(...offsets);
  const maxOffset = Math.max(...offsets);
  const offsetSpan = maxOffset - minOffset || 1;
  return innerWidth / offsetSpan;
}
