/** UI-041 -- graph axis labels, scrub/hover readout, and Overview layout.
 * Owner directive (verbatim): "Lets work on the graphs. They all need x and
 * y labels. I would like to be able to run my finger, or the mouse across
 * the graph and see the value at that point on the graph. The graph in
 * overview should be moved up and replace the 'Empty State No Valuation
 * History' which should only be displayed when we don't have the full
 * valuation history."
 *
 * Reviewer round-1 findings (B1/B2/B3, all BLOCKING) folded in here:
 *   B1 -- y-axis labels must sit AGAINST their own computed `tick.y`
 *         position (a positioned label layer over a fixed-aspect chart
 *         wrapper), not a `justify-content: space-between` row that paired
 *         the wrong value with the wrong date.
 *   B2 -- x-axis labels must be positioned from their own `tick.x`, not
 *         discarded in favour of an evenly-spaced flex row (day-rounded
 *         ticks are NOT evenly spaced).
 *   B3 -- `computeYAxisTicks` needs a step-relative epsilon so a
 *         float-drifted reconstruction never leaks past its min/max
 *         boundary as a false "interior" tick, AND a second, DISPLAY-level
 *         pass (`dropCollidingOrOutOfRangeTicks`) drops any intermediate
 *         whose RENDERED text collides with a neighbour/extreme label or
 *         falls outside the true [min, max] once rounded to its own
 *         display precision.
 * Plus two cheap review follow-ups: `plotXFromClientX`/`stepActiveIndex`
 * extracted as pure, unit-tested helpers (previously inline closures), and
 * a hard iteration cap inside `computeYAxisTicks`.
 *
 * Three parts, both SVG charts (`app/components/portfolio-value-chart.tsx`,
 * `app/components/holding-price-chart.tsx`):
 *   1. axis labels -- pure geometry in `app/price-history-chart-geometry.ts`,
 *      plus rendered-markup positioning/format assertions below.
 *   2. scrub/hover nearest-point snapping and keyboard stepping -- pure
 *      helpers, plus a keyboard-accessible/no-hydration-divergence
 *      rendered-markup sanity check.
 *   3. Overview layout -- `hasUsableHistoryPoints` (the pure gate) plus a
 *      full PortfolioShell render proving the redundant "No valuation
 *      history yet" EmptyState only appears when the HIST-001 chart itself
 *      has nothing usable to show.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  axisGutterWidthCh,
  computeXAxisTicks,
  computeYAxisTicks,
  dropCollidingOrOutOfRangeTicks,
  filterTicksByVerticalSeparation,
  findNearestPointIndexByX,
  formatAxisTickValue,
  hasUsableHistoryPoints,
  plotXFromClientX,
  stepActiveIndex,
  type ChartScale,
} from "../app/price-history-chart-geometry.ts";

const SCALE: ChartScale = {
  width: 600,
  height: 160,
  paddingX: 8,
  paddingY: 10,
};

// ---------------------------------------------------------------------------
// Part 1: axis tick geometry -- pure, no rendering.
// ---------------------------------------------------------------------------

test("UI-041: computeXAxisTicks returns evenly time-spaced dates, always including the first and last date", () => {
  const ticks = computeXAxisTicks(
    ["2020-01-01", "2020-01-11", "2020-01-21", "2020-01-31"],
    SCALE,
    4,
  );
  assert.equal(ticks.length, 4);
  assert.equal(ticks[0]!.date, "2020-01-01");
  assert.equal(ticks[ticks.length - 1]!.date, "2020-01-31");
  // Pixel x is monotonically increasing left-to-right, matching
  // `scalePriceHistoryPoints`'s own calendar-offset x formula.
  for (let index = 1; index < ticks.length; index += 1) {
    assert.ok(ticks[index]!.x > ticks[index - 1]!.x);
  }
  assert.equal(ticks[0]!.x, SCALE.paddingX);
  assert.equal(ticks[ticks.length - 1]!.x, SCALE.width - SCALE.paddingX);
});

test("UI-041: computeXAxisTicks degenerates to ONE tick for a single-distinct-date domain, at the left (padding) edge -- mirrors scalePriceHistoryPoints's own single-date fallback", () => {
  const ticks = computeXAxisTicks(
    ["2026-08-21", "2026-08-21", "2026-08-21"],
    SCALE,
    4,
  );
  assert.deepEqual(ticks, [{ date: "2026-08-21", x: SCALE.paddingX }]);
});

test("UI-041: computeXAxisTicks returns an empty array for an empty date list", () => {
  assert.deepEqual(computeXAxisTicks([], SCALE, 4), []);
});

test("UI-041: computeXAxisTicks never duplicates a tick date when the range is too short for the requested count", () => {
  const ticks = computeXAxisTicks(["2020-01-01", "2020-01-02"], SCALE, 5);
  const dates = ticks.map((tick) => tick.date);
  assert.equal(new Set(dates).size, dates.length);
  assert.ok(dates.includes("2020-01-01"));
  assert.ok(dates.includes("2020-01-02"));
});

test("UI-041: computeYAxisTicks chooses round (1/2/5-per-decade) step values, all STRICTLY INTERIOR to [min, max], evenly pixel-spaced top-to-bottom", () => {
  const result = computeYAxisTicks(0, 100, SCALE, 5);
  assert.ok(result.step > 0);
  for (const tick of result.ticks) {
    // Review B1/B3: the caller renders the true min/max as its own
    // separate exact extreme labels -- this loop must never return a
    // value equal to (or float-drifted onto) either boundary.
    assert.ok(tick.value > 0 && tick.value < 100);
    // Every tick value is a clean multiple of the chosen step (a "round"
    // number relative to that step), not an arbitrary fraction of the span.
    assert.equal(
      Math.round(tick.value / result.step),
      tick.value / result.step,
    );
  }
  // Y is a linear price scale -- ticks in ascending value order have
  // DESCENDING pixel y (higher value = nearer the chart's top).
  for (let index = 1; index < result.ticks.length; index += 1) {
    assert.ok(result.ticks[index]!.y < result.ticks[index - 1]!.y);
  }
});

test("UI-041: computeYAxisTicks degenerates to a single centered tick for a flat/degenerate (min >= max) series -- mirrors scalePriceHistoryPoints's own flat-series centering", () => {
  const result = computeYAxisTicks(5, 5, SCALE, 5);
  assert.equal(result.ticks.length, 1);
  assert.equal(result.ticks[0]!.value, 5);
  assert.equal(
    result.ticks[0]!.y,
    SCALE.paddingY + (SCALE.height - SCALE.paddingY * 2) / 2,
  );
});

test("UI-041: computeYAxisTicks returns a small, readable count (never dozens of labels) for a realistic portfolio-value range", () => {
  const result = computeYAxisTicks(1980, 5123, SCALE, 5);
  assert.ok(result.ticks.length >= 1 && result.ticks.length <= 6);
});

// --- reviewer B3 repro #1: float-drift boundary leak ------------------------

test("UI-041 review B3 (BLOCKING) repro: computeYAxisTicks(19.2, 19.5) never leaks a float-drifted near-duplicate of either boundary (e.g. 19.200000000000003)", () => {
  const result = computeYAxisTicks(19.2, 19.5, SCALE, 5);
  for (const tick of result.ticks) {
    assert.ok(
      tick.value > 19.2 + 1e-9 && tick.value < 19.5 - 1e-9,
      `tick ${tick.value} is not strictly interior to (19.2, 19.5)`,
    );
  }
});

// --- reviewer B3 repro #2/#3: display-level collision/out-of-range ---------

test("UI-041 review B3 (BLOCKING) repro: dropCollidingOrOutOfRangeTicks drops a whole-dollar-rounded intermediate that would print ABOVE the series' true max (1000.2, 1000.8 -> a raw 1000.6-ish tick rounds to '1001')", () => {
  const { ticks } = computeYAxisTicks(1000.2, 1000.8, SCALE, 5);
  const formatWhole = (tick: { value: number }) =>
    String(Math.round(tick.value));
  const kept = dropCollidingOrOutOfRangeTicks(
    ticks,
    formatWhole,
    1000.2,
    1000.8,
    [formatWhole({ value: 1000.2 }), formatWhole({ value: 1000.8 })],
  );
  for (const tick of kept) {
    const numeric = Number(tick.text);
    assert.ok(
      numeric >= 1000.2 && numeric <= 1000.8,
      `kept label "${tick.text}" (${numeric}) reads outside the true [1000.2, 1000.8] range`,
    );
  }
});

test("UI-041 review B3 (BLOCKING) repro: dropCollidingOrOutOfRangeTicks never prints two identical labels for a tiny range (0.001, 0.004) that would otherwise both round to '0'", () => {
  const { ticks } = computeYAxisTicks(0.001, 0.004, SCALE, 5);
  const formatWhole = (tick: { value: number }) =>
    String(Math.round(tick.value));
  const kept = dropCollidingOrOutOfRangeTicks(
    ticks,
    formatWhole,
    0.001,
    0.004,
    [formatWhole({ value: 0.001 }), formatWhole({ value: 0.004 })],
  );
  const texts = kept.map((tick) => tick.text);
  assert.equal(
    new Set(texts).size,
    texts.length,
    "no duplicate rendered labels",
  );
  // A "0" here would also read as BELOW the true 0.001 minimum -- dropped
  // by the same out-of-range guard, not merely deduped.
  assert.ok(!texts.includes("0"));
});

test("UI-041: dropCollidingOrOutOfRangeTicks keeps a genuinely interior, non-colliding, in-range tick", () => {
  const kept = dropCollidingOrOutOfRangeTicks(
    [{ value: 50 }],
    (tick) => String(tick.value),
    0,
    100,
    ["0", "100"],
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.text, "50");
});

test("UI-041: dropCollidingOrOutOfRangeTicks drops a tick whose text exactly matches a reserved (extreme) label", () => {
  const kept = dropCollidingOrOutOfRangeTicks(
    [{ value: 50 }, { value: 60 }],
    (tick) => String(tick.value),
    0,
    100,
    ["50"],
  );
  assert.deepEqual(
    kept.map((tick) => tick.text),
    ["60"],
  );
});

// --- reviewer round-2 F1 (BLOCKING): vertical label overprint --------------

test("UI-041 review F1 (BLOCKING): filterTicksByVerticalSeparation drops an intermediate too close to an EXTREME (the exact reviewer repro shape: a max at y=10 and a candidate at y=14.52 -- 4.52 apart, well under the 32-unit threshold)", () => {
  const kept = filterTicksByVerticalSeparation(
    [{ y: 14.52 }, { y: 59.68 }, { y: 104.84 }],
    [10, 150],
  );
  // The 14.52 candidate (too close to the top extreme at y=10) is dropped;
  // the other two are each >= 32 units from the nearest extreme AND from
  // each other, so both survive.
  assert.deepEqual(
    kept.map((tick) => tick.y),
    [59.68, 104.84],
  );
});

test("UI-041 review F1 (BLOCKING): filterTicksByVerticalSeparation drops a candidate too close to the PREVIOUS kept candidate, keeping only one from a tight cluster", () => {
  // Bottom extreme pushed far away (200) so this test isolates the
  // previous-kept-candidate rule from the extreme-boundary rule (already
  // covered by the sibling test above).
  const kept = filterTicksByVerticalSeparation(
    [{ y: 50 }, { y: 60 }, { y: 70 }, { y: 130 }],
    [0, 200],
  );
  // 50/60/70 are each < 32 apart from their neighbour -- only the first
  // (closest to the top extreme, in top-to-bottom scan order) survives
  // from that cluster; 130 is far enough from both the kept 50 and the
  // bottom extreme (200) to also survive.
  assert.deepEqual(
    kept.map((tick) => tick.y),
    [50, 130],
  );
});

test("UI-041 review F1: filterTicksByVerticalSeparation keeps a candidate exactly AT the threshold (>= 32, not strictly >)", () => {
  const kept = filterTicksByVerticalSeparation([{ y: 42 }], [10, 150]);
  // 42 - 10 = 32 (the threshold itself) and 150 - 42 = 108 -- both satisfy
  // the ">= minSeparation" (not "> minSeparation") boundary.
  assert.deepEqual(kept, [{ y: 42 }]);
});

test("UI-041 review F1: filterTicksByVerticalSeparation returns an empty list for an empty candidate list, and respects a custom minSeparation", () => {
  assert.deepEqual(filterTicksByVerticalSeparation([], [10, 150]), []);
  const kept = filterTicksByVerticalSeparation(
    [{ y: 20 }],
    [10, 150],
    5, // a much smaller threshold -- 20 is now far enough from y=10
  );
  assert.deepEqual(kept, [{ y: 20 }]);
});

test("UI-041 review F2 (BLOCKING): axisGutterWidthCh sizes to the LONGEST label plus one character of breathing room, and returns 0 for no labels", () => {
  assert.equal(axisGutterWidthCh(["$5,100.00", "$2,000.00"]), 10);
  // The owner's own real large portfolio value -- "$1,337,203.50" is 13
  // characters; the gutter must size for THIS, not a fixed guess.
  assert.equal(axisGutterWidthCh(["$1,337,203.50", "$508,153.46"]), 14);
  assert.equal(axisGutterWidthCh([]), 0);
});

test("UI-041: computeYAxisTicks has a hard iteration cap (structural safety, review follow-up) -- never returns an unbounded tick list", () => {
  // A pathologically large target count against a tiny span still returns
  // a small, bounded list.
  const result = computeYAxisTicks(0, 1, SCALE, 10_000);
  assert.ok(result.ticks.length <= 32);
});

test("UI-041: formatAxisTickValue picks decimal places from the STEP, not the value, and trims trailing zeros", () => {
  assert.equal(formatAxisTickValue(1000, 1000), "1000");
  assert.equal(formatAxisTickValue(2000, 1000), "2000");
  // step=0.05 implies 2dp precision, but a trailing zero still trims (same
  // `trimTrailingZeros` convention as `formatDecimalTrimmed` elsewhere).
  assert.equal(formatAxisTickValue(0.1, 0.05), "0.1");
  assert.equal(formatAxisTickValue(0.15, 0.05), "0.15");
  assert.equal(formatAxisTickValue(19.4, 0.2), "19.4");
});

test("UI-041: formatAxisTickValue never throws on a float-arithmetic-derived value (unlike routing through the strict decimal parser)", () => {
  // A value with float-noise digits (e.g. 19.299999999999997) must still
  // format cleanly given its step -- this is the exact hazard
  // `formatAxisTickValue`'s own doc comment documents avoiding.
  assert.doesNotThrow(() => formatAxisTickValue(19.299999999999997, 0.1));
});

// ---------------------------------------------------------------------------
// Part 2: scrub/hover nearest-point snapping and keyboard/pointer helpers --
// pure, no rendering.
// ---------------------------------------------------------------------------

test("UI-041: findNearestPointIndexByX returns null for an empty series", () => {
  assert.equal(findNearestPointIndexByX([], 50), null);
});

test("UI-041: findNearestPointIndexByX returns the single point for a single-point series regardless of pointer position", () => {
  const points = [{ x: 300 }];
  assert.equal(findNearestPointIndexByX(points, 0), 0);
  assert.equal(findNearestPointIndexByX(points, 300), 0);
  assert.equal(findNearestPointIndexByX(points, 599), 0);
});

test("UI-041: findNearestPointIndexByX returns an EXACT hit's own index", () => {
  const points = [{ x: 10 }, { x: 50 }, { x: 90 }];
  assert.equal(findNearestPointIndexByX(points, 50), 1);
});

test("UI-041: findNearestPointIndexByX snaps to the nearer of two points when the pointer sits BETWEEN them, never interpolating a new value", () => {
  const points = [{ x: 10 }, { x: 90 }];
  assert.equal(findNearestPointIndexByX(points, 30), 0); // closer to 10
  assert.equal(findNearestPointIndexByX(points, 70), 1); // closer to 90
});

test("UI-041: findNearestPointIndexByX -- hovering over a genuine GAP (a wide pixel span between two real points, e.g. a dashed gap segment) still snaps to whichever real neighbour is pixel-closer, never fabricating a point in between (honesty rule)", () => {
  const points = [{ x: 10 }, { x: 20 }, { x: 500 }];
  assert.equal(findNearestPointIndexByX(points, 100), 1);
  assert.equal(findNearestPointIndexByX(points, 400), 2);
});

test("UI-041 review follow-up: plotXFromClientX maps a pointer's clientX into chart user-space x, scaling for a rendered box narrower/wider than the chart's own viewBox width", () => {
  // Chart is 600 user-space units wide but rendered at only 300px (a
  // scaled-down SVG, e.g. a narrow screen) starting at rect.left = 20.
  assert.equal(plotXFromClientX(20, 20, 300, 600), 0);
  assert.equal(plotXFromClientX(170, 20, 300, 600), 300); // 50% across
  assert.equal(plotXFromClientX(320, 20, 300, 600), 600);
});

test("UI-041 review follow-up: plotXFromClientX degrades to the left edge for a zero-width rect rather than NaN/Infinity", () => {
  assert.equal(plotXFromClientX(50, 20, 0, 600), 0);
});

test("UI-041 review follow-up: stepActiveIndex steps ArrowRight/ArrowLeft from null to the first/last index, clamps at bounds (no wrap), and Home/End jump directly", () => {
  assert.equal(stepActiveIndex("ArrowRight", null, 5), 0);
  assert.equal(stepActiveIndex("ArrowRight", 3, 5), 4);
  assert.equal(stepActiveIndex("ArrowRight", 4, 5), 4); // clamped, no wrap
  assert.equal(stepActiveIndex("ArrowLeft", null, 5), 4);
  assert.equal(stepActiveIndex("ArrowLeft", 1, 5), 0);
  assert.equal(stepActiveIndex("ArrowLeft", 0, 5), 0); // clamped, no wrap
  assert.equal(stepActiveIndex("Home", 3, 5), 0);
  assert.equal(stepActiveIndex("End", 1, 5), 4);
});

test("UI-041 review follow-up: stepActiveIndex returns null for Escape (clears the readout) and undefined for an unrecognised key (caller must not preventDefault/update state)", () => {
  assert.equal(stepActiveIndex("Escape", 2, 5), null);
  assert.equal(stepActiveIndex("Tab", 2, 5), undefined);
  assert.equal(stepActiveIndex("a", null, 5), undefined);
});

test("UI-041 review follow-up: stepActiveIndex returns undefined (nothing to step through) for a zero-length series regardless of key", () => {
  assert.equal(stepActiveIndex("ArrowRight", null, 0), undefined);
  assert.equal(stepActiveIndex("Home", null, 0), undefined);
});

// ---------------------------------------------------------------------------
// Part 3: Overview layout -- hasUsableHistoryPoints (pure) plus a full
// PortfolioShell render proving the EmptyState/chart branch behaviour.
// ---------------------------------------------------------------------------

test("UI-041: hasUsableHistoryPoints is false for a non-'ok' status regardless of points", () => {
  assert.equal(
    hasUsableHistoryPoints("empty", [{ valueDecimal: "100" }]),
    false,
  );
  assert.equal(
    hasUsableHistoryPoints("unavailable", [{ valueDecimal: "100" }]),
    false,
  );
});

test("UI-041: hasUsableHistoryPoints is false for an 'ok' status with zero points, or points that are all gaps (null valueDecimal)", () => {
  assert.equal(hasUsableHistoryPoints("ok", []), false);
  assert.equal(
    hasUsableHistoryPoints("ok", [
      { valueDecimal: null },
      { valueDecimal: null },
    ]),
    false,
  );
});

test("UI-041: hasUsableHistoryPoints is false for an 'ok' status whose only point is a malformed/non-plottable decimal (e.g. negative)", () => {
  assert.equal(hasUsableHistoryPoints("ok", [{ valueDecimal: "-5" }]), false);
});

test("UI-041: hasUsableHistoryPoints is true for an 'ok' status with at least one real, plottable point", () => {
  assert.equal(
    hasUsableHistoryPoints("ok", [
      { valueDecimal: null },
      { valueDecimal: "1234.56" },
    ]),
    true,
  );
});

// --- full-render: OwnedOverviewScreen's empty-vs-chart branch --------------

const ROUTER_STUB_IMPORT = `
  import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
  const routerStub = {
    push() {},
    replace() {},
    back() {},
    forward() {},
    refresh() {},
    prefetch() {},
  };
`;

/** Renders PortfolioShell's owned Overview screen with `overview.status`
 * pinned to "empty" (the CALC-003/CALC-004 published-snapshot pipeline's
 * permanently-empty state for an owner it never runs for -- CALC-005), and
 * an injectable `portfolioValueHistory` (the SEPARATE HIST-001 read-time
 * series) so both the "chart has real data" and "chart also has nothing"
 * cases can be exercised. */
function renderEmptyOverview(portfolioValueHistory: unknown): string {
  const componentUrl = new URL(
    "../app/components/portfolio-shell.tsx",
    import.meta.url,
  ).href;
  const script = `
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { PortfolioShell } from ${JSON.stringify(componentUrl)};
    ${ROUTER_STUB_IMPORT}

    const ownedWorkspace = {
      status: "ready",
      homeCurrencyCode: "AUD",
      activePortfolio: {
        id: "portfolio-a",
        name: "Fixture Portfolio",
        homeCurrencyCode: "AUD",
        baseCurrencyCode: "AUD",
        timezone: "Australia/Sydney",
        accountingMethod: "fifo",
        status: "active",
        version: 1,
      },
      portfolios: [
        {
          id: "portfolio-a",
          name: "Fixture Portfolio",
          homeCurrencyCode: "AUD",
          status: "active",
          version: 1,
        },
      ],
      overview: {
        status: "empty",
        currencyCode: "AUD",
        current: null,
        history: [],
        coverage: {
          pricedHoldingCount: null,
          nonZeroHoldingCount: null,
          convertedCashAccountCount: null,
          nonZeroCashAccountCount: null,
          totalHoldingCount: null,
          excluded: [],
          issues: [],
          marketDataStates: [],
        },
        allocation: { status: "unavailable", rows: [] },
      },
      portfolioValueHistory: ${JSON.stringify(portfolioValueHistory)},
    };

    process.stdout.write(
      renderToStaticMarkup(
        createElement(
          AppRouterContext.Provider,
          { value: routerStub },
          createElement(PortfolioShell, {
            activeSection: "overview",
            ownedWorkspace,
          }),
        ),
      ),
    );
  `;
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    { encoding: "utf8" },
  );
}

test("UI-041: the Overview chart renders as the primary element even when the published-snapshot pipeline (overview.status) is 'empty', ahead of any EmptyState markup", () => {
  const html = renderEmptyOverview({
    status: "ok",
    baseCurrencyCode: "AUD",
    points: [
      { date: "2025-01-01", valueDecimal: "1000", completeness: "complete" },
      { date: "2025-02-01", valueDecimal: "1100", completeness: "complete" },
    ],
    datesTruncated: false,
    backfillPending: false,
  });
  const chartIndex = html.indexOf("Portfolio value over time");
  const emptyStateIndex = html.indexOf("No valuation history yet");
  assert.ok(chartIndex >= 0, "expected the chart heading to render");
  assert.ok(
    emptyStateIndex === -1,
    "the redundant 'No valuation history yet' panel must NOT render once the chart has real, usable history",
  );
  assert.match(html, /<svg/);
});

test("UI-041: the 'No valuation history yet' EmptyState still renders when the chart ALSO has nothing usable (both reads genuinely empty)", () => {
  const html = renderEmptyOverview({
    status: "unavailable",
    baseCurrencyCode: "AUD",
    points: [],
    datesTruncated: false,
    backfillPending: false,
  });
  assert.match(html, /No valuation history yet/);
  // Chart's own honest "unavailable" message still renders alongside it
  // (the chart component is unconditionally mounted -- only the redundant
  // outer panel is gated).
  assert.match(html, /Portfolio value history is temporarily unavailable/);
});

test("UI-041 source: OwnedOverviewScreen's empty branch gates the EmptyState on hasUsableHistoryPoints, with the chart mounted first", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    'if (data.status === "empty" || current === null) {',
  );
  assert.ok(start >= 0, "expected the empty-overview branch");
  const end = source.indexOf("\n  }", start);
  const branchSource = source.slice(start, end);
  const chartPos = branchSource.indexOf("<PortfolioValueChart");
  const emptyStatePos = branchSource.indexOf("<EmptyState");
  assert.ok(chartPos >= 0 && emptyStatePos >= 0);
  assert.ok(
    chartPos < emptyStatePos,
    "the chart must be mounted ahead of the conditional EmptyState in source order",
  );
  assert.match(branchSource, /hasUsableHistoryPoints\(/);
  assert.match(branchSource, /chartHasHistory \? null : \(/);
});

// ---------------------------------------------------------------------------
// Part 4: rendered-markup sanity -- axis label POSITIONING (B1/B2), no
// initial-render hover/readout divergence, keyboard accessibility, and CSS
// guards.
// ---------------------------------------------------------------------------

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

const PORTFOLIO_VALUE_CHART_PROPS = {
  history: {
    status: "ok",
    baseCurrencyCode: "AUD",
    points: [
      {
        date: "2024-01-01",
        valueDecimal: "2000",
        completeness: "complete",
        heldSecurityCount: 1,
        pricedSecurityCount: 1,
      },
      {
        date: "2024-06-01",
        valueDecimal: "3000",
        completeness: "complete",
        heldSecurityCount: 1,
        pricedSecurityCount: 1,
      },
      {
        date: "2025-01-01",
        valueDecimal: "5100",
        completeness: "complete",
        heldSecurityCount: 1,
        pricedSecurityCount: 1,
      },
    ],
    datesTruncated: false,
    backfillPending: false,
  },
  financialYearStartMonth: 7,
  timezone: "Australia/Sydney",
  nowInstant: "2026-08-25T00:00:00.000Z",
};

test("UI-041 review B1/B2 (BLOCKING): PortfolioValueChart positions each y-axis label at its OWN computed top% (never a flex-row guess) and each x-axis label at its OWN computed left% (using the exact tick.x geometry, not discarded)", () => {
  const html = renderComponent(
    "PortfolioValueChart",
    "../app/components/portfolio-value-chart.tsx",
    PORTFOLIO_VALUE_CHART_PROPS,
  );
  assert.match(html, /price-history-x-axis/);
  assert.match(html, /price-history-gridline/);
  // The exact max label sits at top: 6.25% (paddingY / height = 10/160),
  // the exact min at top: 93.75% ((height-paddingY)/height) -- the SAME
  // percentages the SVG's own baseline/top-row math uses.
  assert.match(html, /style="top:6\.25%"/);
  assert.match(html, /style="top:93\.75%"/);
  // Every x-axis label carries its OWN `left` percentage (not a bare,
  // unpositioned span) -- at least the first tick sits at the plot's own
  // left padding fraction (8/600 ~= 1.33%).
  assert.match(html, /class="price-history-x-axis"[\s\S]*?left:1\.3\d*%/);
  // The two exact extreme labels (BUG-003-safe, UI-026 bare $) still render
  // untouched.
  assert.match(html, /\$5,100/);
  assert.match(html, /\$2,000/);
});

/** Extracts every `top:N%` value from a `.price-history-axis-label` span's
 * inline style (both the two exact extremes and any surviving
 * intermediates) -- these are the ONLY `top:` percentages this markup
 * emits, so a plain global scan is unambiguous. */
function yAxisLabelTopPercents(html: string): number[] {
  const matches = [...html.matchAll(/top:([\d.]+)%/g)];
  return matches.map((match) => Number(match[1]));
}

test("UI-041 review F1 (BLOCKING) rendered pin: PortfolioValueChart's reviewer-fixture (2000→5100) never renders two y-axis labels whose top% sit within the 32-viewBox-unit (20%) overprint threshold of each other", () => {
  const html = renderComponent(
    "PortfolioValueChart",
    "../app/components/portfolio-value-chart.tsx",
    PORTFOLIO_VALUE_CHART_PROPS,
  );
  const tops = yAxisLabelTopPercents(html).sort((a, b) => a - b);
  assert.ok(tops.length >= 2, "expected at least the two exact extremes");
  const minSeparationPercent = (32 / 160) * 100; // 20%
  for (let index = 1; index < tops.length; index += 1) {
    const gap = tops[index]! - tops[index - 1]!;
    assert.ok(
      gap >= minSeparationPercent - 1e-9,
      `labels at top:${tops[index - 1]}% and top:${tops[index]}% are only ${gap}% apart (need >= ${minSeparationPercent}%)`,
    );
  }
});

test("UI-041 review F2 (BLOCKING) rendered pin: PortfolioValueChart never truncates a real large portfolio value ('$1,337,203.50'/'$508,153.46', the owner's own example figures) -- the gutter's computed width covers the longest label's full character count", () => {
  const html = renderComponent(
    "PortfolioValueChart",
    "../app/components/portfolio-value-chart.tsx",
    {
      history: {
        status: "ok",
        baseCurrencyCode: "AUD",
        points: [
          {
            date: "2024-01-01",
            valueDecimal: "508153.46",
            completeness: "complete",
            heldSecurityCount: 1,
            pricedSecurityCount: 1,
          },
          {
            date: "2025-01-01",
            valueDecimal: "1337203.50",
            completeness: "complete",
            heldSecurityCount: 1,
            pricedSecurityCount: 1,
          },
        ],
        datesTruncated: false,
        backfillPending: false,
      },
      financialYearStartMonth: 7,
      timezone: "Australia/Sydney",
      nowInstant: "2026-08-25T00:00:00.000Z",
    },
  );
  // Both full, untruncated labels are present in the rendered HTML.
  assert.match(html, /\$1,337,203\.50/);
  assert.match(html, /\$508,153\.46/);
  const widthMatch =
    /class="price-history-axis-shell" style="width:(\d+)ch"/.exec(html);
  assert.ok(widthMatch, "expected an inline content-sized gutter width");
  const gutterChars = Number(widthMatch![1]);
  assert.ok(
    gutterChars >= "$1,337,203.50".length,
    `gutter width ${gutterChars}ch is narrower than the longest label ("$1,337,203.50", ${"$1,337,203.50".length} chars)`,
  );
});

test("UI-041 review F1 follow-up (secondary item 1): PortfolioValueChart requests only 3 x-axis ticks (down from 4) to leave real breathing room at the narrowest supported 320px width", () => {
  const html = renderComponent(
    "PortfolioValueChart",
    "../app/components/portfolio-value-chart.tsx",
    {
      history: {
        status: "ok",
        baseCurrencyCode: "AUD",
        // All within the component's own default "12M" trailing-range
        // filter (relative to the LATEST point, 2026-01-01) -- otherwise
        // the range filter itself would drop everything but the latest
        // point before the axis-tick math ever runs.
        points: [
          "2025-02-01",
          "2025-05-01",
          "2025-08-01",
          "2025-11-01",
          "2026-01-01",
        ].map((date, index) => ({
          date,
          valueDecimal: String(1000 + index * 500),
          completeness: "complete",
          heldSecurityCount: 1,
          pricedSecurityCount: 1,
        })),
        datesTruncated: false,
        backfillPending: false,
      },
      financialYearStartMonth: 7,
      timezone: "Australia/Sydney",
      nowInstant: "2026-08-25T00:00:00.000Z",
    },
  );
  const xAxisBlock = /class="price-history-x-axis"[^]*?<\/div>/.exec(html)![0];
  const tickCount = [...xAxisBlock.matchAll(/left:/g)].length;
  assert.equal(tickCount, 3);
});

test("UI-041: PortfolioValueChart's initial (server) render has NO scrub/hover readout content or guide-line markup -- interaction state starts null, so hydration never has to remove anything (BUG-002/BUG-003)", () => {
  const html = renderComponent(
    "PortfolioValueChart",
    "../app/components/portfolio-value-chart.tsx",
    PORTFOLIO_VALUE_CHART_PROPS,
  );
  assert.doesNotMatch(html, /price-history-hover-group/);
  // The readout paragraph itself renders (a reserved layout slot -- see
  // the `.chart-readout { min-height }` CSS pin below), but with only a
  // placeholder space, never real point text, on the un-hydrated render.
  assert.match(
    html,
    /<p id="portfolio-value-readout" class="chart-readout" role="status"> <\/p>/,
  );
});

test("UI-041: PortfolioValueChart's plot is keyboard-focusable and describes itself via the readout region (aria-describedby)", () => {
  const html = renderComponent(
    "PortfolioValueChart",
    "../app/components/portfolio-value-chart.tsx",
    PORTFOLIO_VALUE_CHART_PROPS,
  );
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-describedby="portfolio-value-readout"/);
});

const HOLDING_CHART_LOADED_PROPS = {
  symbol: "FMG",
  baseCurrencyCode: "AUD",
  range: "all",
  state: {
    status: "loaded",
    currencyCode: "AUD",
    points: [
      {
        date: "2020-01-01",
        priceDecimal: "10.00",
        currencyCode: "AUD",
        providerId: "owner-import",
        interval: "eod",
      },
      {
        date: "2021-01-01",
        priceDecimal: "15.00",
        currencyCode: "AUD",
        providerId: "owner-import",
        interval: "eod",
      },
      {
        date: "2022-01-01",
        priceDecimal: "20.00",
        currencyCode: "AUD",
        providerId: "owner-import",
        interval: "eod",
      },
    ],
    provenance: {
      providers: ["owner-import"],
      fromDate: "2020-01-01",
      toDate: "2022-01-01",
      pointCountRaw: 3,
      pointCountReturned: 3,
      bucketSize: 1,
      excludedCurrencyCount: 0,
      excludedMalformedCount: 0,
    },
    latestDelayed: null,
    invalidRangeRequested: false,
    todayMarketDate: null,
    todayPoints: [],
    marketTimezone: null,
  },
  onRangeChange: () => {},
};

test("UI-041 review B1/B2 (BLOCKING): HoldingPriceChart (PriceHistoryChartView) positions its axis labels the same way for a non-time-axis range", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    "../app/components/holding-price-chart.tsx",
    HOLDING_CHART_LOADED_PROPS,
  );
  assert.match(html, /price-history-x-axis/);
  assert.match(html, /price-history-gridline/);
  assert.match(html, /style="top:6\.25%"/);
  assert.match(html, /style="top:93\.75%"/);
});

test("UI-041 review F1 (BLOCKING) rendered pin: HoldingPriceChart never renders two y-axis labels whose top% sit within the 32-viewBox-unit (20%) overprint threshold of each other", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    "../app/components/holding-price-chart.tsx",
    HOLDING_CHART_LOADED_PROPS,
  );
  const tops = yAxisLabelTopPercents(html).sort((a, b) => a - b);
  assert.ok(tops.length >= 2);
  const minSeparationPercent = (32 / 160) * 100;
  for (let index = 1; index < tops.length; index += 1) {
    const gap = tops[index]! - tops[index - 1]!;
    assert.ok(
      gap >= minSeparationPercent - 1e-9,
      `labels at top:${tops[index - 1]}% and top:${tops[index]}% are only ${gap}% apart`,
    );
  }
});

test("UI-041 review F2 (BLOCKING) rendered pin: HoldingPriceChart's gutter width covers a real large price label's full character count", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    "../app/components/holding-price-chart.tsx",
    {
      ...HOLDING_CHART_LOADED_PROPS,
      state: {
        ...HOLDING_CHART_LOADED_PROPS.state,
        points: [
          {
            date: "2020-01-01",
            priceDecimal: "5.00",
            currencyCode: "AUD",
            providerId: "owner-import",
            interval: "eod",
          },
          {
            date: "2022-01-01",
            priceDecimal: "1337203.50",
            currencyCode: "AUD",
            providerId: "owner-import",
            interval: "eod",
          },
        ],
      },
    },
  );
  assert.match(html, /\$1,337,203\.5/);
  const widthMatch =
    /class="price-history-axis-shell" style="width:(\d+)ch"/.exec(html);
  assert.ok(widthMatch);
  const gutterChars = Number(widthMatch![1]);
  assert.ok(gutterChars >= "$1,337,203.5".length);
});

test("UI-041 review F2 (BLOCKING): HoldingPriceChart's '(today, intraday)' attribution is sr-only (never inflates the visible gutter label text), while the pinned literal substring stays present in the rendered HTML for MKT-011C's own disclosure requirement", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    "../app/components/holding-price-chart.tsx",
    {
      symbol: "FMG",
      baseCurrencyCode: "AUD",
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
        },
        latestDelayed: null,
        invalidRangeRequested: false,
        todayMarketDate: "2026-08-20",
        todayPoints: [
          {
            date: "2026-08-20",
            priceDecimal: "20.30",
            currencyCode: "AUD",
            providerId: "sharesight",
            interval: "delayed",
            quality: "observed",
            observedAt: "2026-08-20T05:00:00.000Z",
          },
        ],
        marketTimezone: "UTC",
      },
      onRangeChange: () => {},
    },
  );
  // Still present SOMEWHERE in the rendered HTML (MKT-011C's own pinned
  // regression, tests/ui-018.test.ts, scans for exactly this).
  assert.match(html, /\(today, intraday\)/);
  // But it now lives inside an `sr-only` span, not as plain visible text
  // directly inside the axis label span.
  assert.match(html, /<span class="sr-only"> \(today, intraday\)<\/span>/);
});

test("UI-041 review F1 follow-up (secondary item 1): HoldingPriceChart requests only 3 x-axis ticks (down from 4) on a non-time-axis range", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    "../app/components/holding-price-chart.tsx",
    {
      ...HOLDING_CHART_LOADED_PROPS,
      range: "5y",
      state: {
        ...HOLDING_CHART_LOADED_PROPS.state,
        points: [
          "2018-01-01",
          "2019-06-01",
          "2021-01-01",
          "2023-06-01",
          "2026-01-01",
        ].map((date) => ({
          date,
          priceDecimal: "10.00",
          currencyCode: "AUD",
          providerId: "owner-import",
          interval: "eod",
        })),
      },
    },
  );
  const xAxisBlock = /class="price-history-x-axis"[^]*?<\/div>/.exec(html)![0];
  const tickCount = [...xAxisBlock.matchAll(/left:/g)].length;
  assert.equal(tickCount, 3);
});

test("UI-041: HoldingPriceChart's initial render has no scrub/hover guide-line, and its plot is keyboard-focusable with a role=status readout", () => {
  const html = renderComponent(
    "PriceHistoryChartView",
    "../app/components/holding-price-chart.tsx",
    HOLDING_CHART_LOADED_PROPS,
  );
  assert.doesNotMatch(html, /price-history-hover-group/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-describedby="price-history-readout"/);
  assert.match(html, /role="status"/);
  // MKT-011B's own pinned regression: the rendered markup must never
  // contain the literal substring "live" (a delayed quote is never a "live"
  // price) -- `role="status"` (not an explicit `aria-live="..."` attribute)
  // keeps this component's own new readout region compliant with that.
  assert.ok(!html.toLowerCase().includes("live"));
});

test("UI-041: HoldingPriceChart skips the calendar x-axis tick row on the Day/Week TIME-axis ranges (a calendar-date axis would mislabel the time-repositioned intraday overlay)", () => {
  const dayProps = {
    ...HOLDING_CHART_LOADED_PROPS,
    range: "day",
    state: { ...HOLDING_CHART_LOADED_PROPS.state, points: [] },
  };
  const html = renderComponent(
    "PriceHistoryChartView",
    "../app/components/holding-price-chart.tsx",
    dayProps,
  );
  assert.doesNotMatch(html, /price-history-x-axis/);
});

test("UI-041: the SVG touch-action CSS lets vertical page scroll survive a touch scrub (never hijacking the swipe)", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.price-history-svg\s*{[^}]*touch-action:\s*pan-y/s);
});

test("UI-041: the scrub/hover readout reserves a (two-line) min-height in CSS, so showing/hiding it -- or its text wrapping under a long readout -- never shifts the chart's layout", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.chart-readout\s*{[^}]*min-height:\s*2\.\d+em/s);
});

test("UI-041: x-axis tick label text truncates instead of squeezing the plot illegible on a narrow (320px) screen -- overflow-hidden/ellipsis, never forced full-width text", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.price-history-x-axis span\s*{[^}]*overflow:\s*hidden/s);
});

test("UI-041 review B1: the plot is a fixed-aspect box matching the SVG's own 600x160 viewBox, so tick.y/tick.x percentages land on the true pixel regardless of rendered width", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.price-history-plot\s*{[^}]*aspect-ratio:\s*600\s*\/\s*160/s,
  );
});

test("UI-041 review F2 (BLOCKING) 320px budget re-check: the y-axis gutter's own max-width cap plus the row gap still leaves a meaningfully positive plot width at the narrowest supported 320px screen (reviewer's own '~70px gutter leaves ~218px plot' arithmetic)", async () => {
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const gutterMaxWidthMatch =
    /\.price-history-axis-shell\s*{[^}]*max-width:\s*(\d+)px/s.exec(css);
  assert.ok(gutterMaxWidthMatch, "expected a max-width cap on the gutter");
  const gutterMaxWidth = Number(gutterMaxWidthMatch![1]);
  const gapMatch = /\.price-history-chart-row\s*{[^}]*gap:\s*(\d+)px/s.exec(
    css,
  );
  assert.ok(gapMatch, "expected a gap declared on the chart row");
  const gap = Number(gapMatch![1]);
  const NARROW_SCREEN_PX = 320;
  const plotWidth = NARROW_SCREEN_PX - gutterMaxWidth - gap;
  assert.ok(
    plotWidth >= 150,
    `only ${plotWidth}px left for the plot at a ${NARROW_SCREEN_PX}px screen (gutter cap ${gutterMaxWidth}px + gap ${gap}px) -- too tight to read a chart in`,
  );
});
