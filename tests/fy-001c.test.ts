import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  currentFyWindow,
  lastFyWindow,
} from "../domain/calculations/financial-year.ts";
import {
  filterToClosedFyWindow,
  filterToFyToDateWindow,
  formatFyBoundaryDate,
  fyRangeEyebrow,
  windowChangeAmount,
} from "../app/overview-fy-range.ts";

// FY-001C: FY and Last FY chart periods. The pure window/label math itself
// is FY-001A's responsibility (tests/fy-001a.test.ts); these tests cover
// how the overview chart consumes an already-resolved FyWindowResult:
// boundary-inclusive/exclusive filtering, the closed-window delta, empty
// windows, and non-July start months.

const FY_MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function point(date: string, valueDecimal: string | null) {
  return { date, valueDecimal };
}

// --- window filtering at the Jun 30 / Jul 1 boundary -----------------------

test("FY-001C: FY-to-date filtering includes the boundary start date but excludes the day before it", () => {
  const latest = "2026-08-13"; // matches the fy-001a fixture's "today"
  const current = currentFyWindow(latest, 7, "Australia/Sydney");
  assert.ok(current.ok);

  const points = [
    point("2025-06-29", "100.00"),
    point("2025-06-30", "101.00"),
    point("2026-06-30", "150.00"), // day before the FY start -- excluded
    point("2026-07-01", "151.00"), // FY start -- included
    point("2026-08-13", "160.00"),
  ];

  const filtered = filterToFyToDateWindow(points, current);
  assert.deepEqual(
    filtered.map((p) => p.date),
    ["2026-07-01", "2026-08-13"],
  );
});

test("FY-001C: Last FY filtering is a closed window -- includes both Jun 30 and Jul 1 boundaries correctly", () => {
  const latest = "2026-08-13";
  const last = lastFyWindow(latest, 7, "Australia/Sydney");
  assert.ok(last.ok);
  if (!last.ok) return;
  assert.deepEqual(last.window, {
    startDate: "2025-07-01",
    endDate: "2026-06-30",
  });

  const points = [
    point("2025-06-29", "90.00"), // before the window -- excluded
    point("2025-06-30", "95.00"), // day before the window starts -- excluded
    point("2025-07-01", "100.00"), // window start -- included
    point("2026-06-30", "150.00"), // window end -- included
    point("2026-07-01", "160.00"), // day after the window closes -- excluded
    point("2026-08-13", "170.00"), // well after the window -- excluded
  ];

  const filtered = filterToClosedFyWindow(points, last);
  assert.deepEqual(
    filtered.map((p) => p.date),
    ["2025-07-01", "2026-06-30"],
  );
});

// --- Last FY delta reads as change ACROSS the closed window ----------------

test("FY-001C: Last FY's delta is first-point-to-last-point of the closed window, not a change-to-today figure", () => {
  const latest = "2026-08-13";
  const last = lastFyWindow(latest, 7, "Australia/Sydney");
  assert.ok(last.ok);

  const points = [
    point("2025-06-30", "999.00"), // outside the window -- must be ignored
    point("2025-07-01", "1000.00"), // window start
    point("2026-01-15", "1150.00"), // interior point -- must be ignored
    point("2026-06-30", "1300.00"), // window end
    point("2026-08-13", "5000.00"), // today -- well outside the window, must not leak in
  ];

  const filtered = filterToClosedFyWindow(points, last);
  const change = windowChangeAmount(filtered, "AUD");
  // 1300.00 - 1000.00 = 300.00, not (5000.00 - 1000.00) and not 0.
  assert.equal(change, "+$300.00");
});

test("FY-001C: a closed-window loss is signed with an explicit minus, not colour alone", () => {
  const points = [
    point("2025-07-01", "1000.00"),
    point("2026-06-30", "850.00"),
  ];
  assert.equal(windowChangeAmount(points, "AUD"), "−$150.00");
});

test("FY-001C: a flat window of two-or-more points shows no sign, and is a known 0.00 (never a fabricated +0.00)", () => {
  const points = [
    point("2025-07-01", "1000.00"),
    point("2026-06-30", "1000.00"),
  ];
  assert.equal(windowChangeAmount(points, "AUD"), "$0.00");
});

test("FY-001C (B3): a single-point window has no knowable change and returns null, not a spuriously-flat 0.00", () => {
  // Before the fix, first === last for a one-point array, so the delta was
  // always exactly zero -- rendering "AUD 0.00 across the window" for a
  // window that has never actually been observed changing. That is missing
  // data dressed up as a fact, which AGENTS.md forbids.
  const points = [point("2026-06-30", "1000.00")];
  assert.equal(windowChangeAmount(points, "AUD"), null);
});

test("FY-001C (B3): an empty window also returns null, not a spuriously-flat 0.00", () => {
  assert.equal(windowChangeAmount([], "AUD"), null);
});

// --- empty/missing-data windows: never zero, never fabricated --------------

test("FY-001C: an empty window (no points fall inside it) filters to zero points and yields no delta", () => {
  const last = lastFyWindow("2026-08-13", 7, "Australia/Sydney");
  assert.ok(last.ok);

  // All history predates the closed Last-FY window entirely.
  const points = [point("2020-01-01", "10.00"), point("2020-06-01", "12.00")];
  const filtered = filterToClosedFyWindow(points, last);
  assert.deepEqual(filtered, []);
  assert.equal(windowChangeAmount(filtered, "AUD"), null);
});

test("FY-001C: a window whose boundary points have no priced value never fabricates a $0.00 change", () => {
  const points = [point("2025-07-01", null), point("2026-06-30", "850.00")];
  assert.equal(windowChangeAmount(points, "AUD"), null);
});

test("FY-001C: an unresolved FY window (invalid settings) filters to zero points rather than throwing", () => {
  const invalid = currentFyWindow("2026-08-13", 13, "Australia/Sydney");
  assert.equal(invalid.ok, false);
  const points = [point("2026-07-01", "100.00")];
  assert.deepEqual(filterToFyToDateWindow(points, invalid), []);
  assert.deepEqual(filterToClosedFyWindow(points, invalid), []);
  assert.deepEqual(filterToFyToDateWindow(points, null), []);
});

// --- non-July start months --------------------------------------------------

test("FY-001C: a non-July (April) start month resolves and filters a different FY window correctly", () => {
  const latest = "2026-08-13";
  const current = currentFyWindow(latest, 4, "Australia/Sydney");
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.deepEqual(current.window, {
    startDate: "2026-04-01",
    endDate: "2026-08-13",
  });

  const points = [
    point("2026-03-31", "500.00"), // day before the April FY start
    point("2026-04-01", "510.00"), // FY start
    point("2026-08-13", "600.00"),
  ];
  const filtered = filterToFyToDateWindow(points, current);
  assert.deepEqual(
    filtered.map((p) => p.date),
    ["2026-04-01", "2026-08-13"],
  );
});

test("FY-001C: a January start month produces plain calendar-year windows and labels", () => {
  const current = currentFyWindow("2026-08-13", 1, "Australia/Sydney");
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.deepEqual(current.window, {
    startDate: "2026-01-01",
    endDate: "2026-08-13",
  });
  assert.equal(
    fyRangeEyebrow("FY", current, FY_MONTH_ABBREVIATIONS),
    "FY26 · 1 Jan 2026 – today",
  );
});

// --- B2 regression: a real ISO instant, not a bare local date -------------

test("FY-001C (B2 regression): a real ISO instant with an explicit offset resolves the correct FY for a negative-offset timezone, unlike a bare local date", () => {
  // "Now" really is 2026-07-01T06:00:00Z, which is 2026-07-01 02:00 local
  // in America/New_York (UTC-4 in July) -- the very first local moment of
  // the new FY.
  const realInstant = "2026-07-01T06:00:00Z";
  const correct = currentFyWindow(realInstant, 7, "America/New_York");
  assert.ok(correct.ok);
  if (correct.ok) {
    assert.equal(correct.window.startDate, "2026-07-01");
    assert.equal(correct.window.endDate, "2026-07-01");
  }

  // The bug this guards against: the OLD (buggy) anchor fed a bare
  // "YYYY-MM-DD" local date -- as if the same wall-clock moment were
  // "2026-07-01" with no time component. `localDateAt` treats a bare date
  // as UTC midnight, which in a negative-offset timezone rolls back to the
  // PRIOR local day, misclassifying a genuinely new-FY point as still
  // belonging to the prior, already-closed FY.
  const misinterpretedAsBareDate = currentFyWindow(
    "2026-07-01",
    7,
    "America/New_York",
  );
  assert.ok(misinterpretedAsBareDate.ok);
  if (misinterpretedAsBareDate.ok) {
    assert.equal(misinterpretedAsBareDate.window.startDate, "2025-07-01");
    assert.notEqual(
      misinterpretedAsBareDate.window.startDate,
      correct.ok ? correct.window.startDate : null,
      "a bare local date and the real instant it represents must not silently disagree on which FY it belongs to",
    );
  }
});

// --- B1 regression: stale history must not rename the current FY ----------

test("FY-001C (B1 regression, end-to-end): FY selected with history ending in a prior FY shows the empty state and 'Change unavailable', while the eyebrow still honestly names the CURRENT FY", () => {
  // "Now" is deep into FY27 (15 Jan 2027), but the portfolio's last
  // published point is from FY26 -- exactly the staleness scenario the old
  // latestHistoryDate anchor got wrong (it would have named the window
  // after the stale point's FY, FY26, instead of the real current FY).
  const nowInstant = "2027-01-15T04:00:00Z";
  const timezone = "Australia/Sydney";
  const startMonth = 7;

  const staleHistory = [
    point("2025-08-01", "900.00"),
    point("2026-05-20", "950.00"), // last published point: still FY26
  ];

  const currentFyResult = currentFyWindow(nowInstant, startMonth, timezone);
  assert.ok(currentFyResult.ok);
  if (!currentFyResult.ok) return;

  // The eyebrow is named after the REAL current FY (FY27) -- it is derived
  // purely from nowInstant/settings, never from `staleHistory`.
  const eyebrow = fyRangeEyebrow("FY", currentFyResult, FY_MONTH_ABBREVIATIONS);
  assert.equal(eyebrow, "FY27 · 1 Jul 2026 – today");

  // But filtering the stale history against that honestly-named window
  // correctly yields nothing: no FY27 point has been published yet, so the
  // chart's existing empty-range state applies.
  const filtered = filterToFyToDateWindow(staleHistory, currentFyResult);
  assert.deepEqual(filtered, []);
  // ...and the delta reads "Change unavailable" in the UI (null), never a
  // fabricated 0.00 and never the stale point's own (irrelevant) change.
  assert.equal(windowChangeAmount(filtered, "AUD"), null);
});

// --- eyebrow/tooltip copy matches the owner's exact examples ---------------

test('FY-001C: the FY eyebrow reads exactly "FY27 · 1 Jul 2026 – today"', () => {
  const current = currentFyWindow("2026-08-13", 7, "Australia/Sydney");
  assert.ok(current.ok);
  assert.equal(
    fyRangeEyebrow("FY", current, FY_MONTH_ABBREVIATIONS),
    "FY27 · 1 Jul 2026 – today",
  );
});

test('FY-001C: the Last FY eyebrow reads exactly "FY26 · 1 Jul 2025 – 30 Jun 2026"', () => {
  const last = lastFyWindow("2026-08-13", 7, "Australia/Sydney");
  assert.ok(last.ok);
  assert.equal(
    fyRangeEyebrow("Last FY", last, FY_MONTH_ABBREVIATIONS),
    "FY26 · 1 Jul 2025 – 30 Jun 2026",
  );
});

test("FY-001C: fyRangeEyebrow falls back to null (never a broken label) when the window is unresolved", () => {
  assert.equal(fyRangeEyebrow("FY", null, FY_MONTH_ABBREVIATIONS), null);
  const invalid = currentFyWindow("2026-08-13", 0, "Australia/Sydney");
  assert.equal(invalid.ok, false);
  assert.equal(fyRangeEyebrow("FY", invalid, FY_MONTH_ABBREVIATIONS), null);
});

test("FY-001C: formatFyBoundaryDate drops leading zeros from the day and always includes the year", () => {
  assert.equal(
    formatFyBoundaryDate("2026-07-01", FY_MONTH_ABBREVIATIONS),
    "1 Jul 2026",
  );
  assert.equal(
    formatFyBoundaryDate("2026-06-30", FY_MONTH_ABBREVIATIONS),
    "30 Jun 2026",
  );
});

// --- component wiring: props threaded, no re-derivation caching bug --------
//
// These assertions are deliberately layout-insensitive (small, independent
// substring/regex checks rather than one long fixed-shape multi-line
// pattern) so they survive a prettier reflow instead of breaking on
// incidental whitespace changes.

/** The text following the first occurrence of `marker` in `source`, bounded
 * so a `match` against it can't accidentally reach into unrelated code. */
function excerptAfter(source: string, marker: string, length = 200): string {
  const index = source.indexOf(marker);
  assert.ok(index !== -1, `expected to find "${marker}" in source`);
  return source.slice(index, index + marker.length + length);
}

test("FY-001C (B1): OwnedOverviewScreen anchors FY windows on nowInstant, not a history point's date", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  // The chart calls the FY-001A domain functions with the resolved "now"
  // instant -- never a history point's date.
  assert.match(
    source,
    /currentFyWindow\(nowInstant, financialYearStartMonth, timezone\)/,
  );
  assert.match(
    source,
    /lastFyWindow\(nowInstant, financialYearStartMonth, timezone\)/,
  );
  assert.doesNotMatch(source, /currentFyWindow\([^)]*latestHistoryDate/);
  assert.doesNotMatch(source, /lastFyWindow\([^)]*latestHistoryDate/);
});

test("FY-001C: both FY windows are memoised on nowInstant, financialYearStartMonth, and timezone, so any of the three re-derives the window on the next render (no stale-cache bug)", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  const currentDeps = excerptAfter(source, "const currentFyResult = useMemo(");
  assert.match(
    currentDeps,
    /\[nowInstant, financialYearStartMonth, timezone\]/,
  );
  const lastDeps = excerptAfter(source, "const lastFyResult = useMemo(");
  assert.match(lastDeps, /\[nowInstant, financialYearStartMonth, timezone\]/);
});

test("FY-001C: OwnedOverviewScreen threads financialYearStartMonth, the settings-level timezone, and the server-resolved nowInstant at the call site", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /financialYearStartMonth=\{/);
  assert.match(source, /ownedWorkspace\.financialYearStartMonth \?\? 7/);
  // Timezone falls back from the user's settings, to the portfolio's own,
  // to a fixed default -- never a hand-rolled instant.
  assert.match(source, /timezone=\{/);
  assert.match(source, /ownedWorkspace\.timezone \?\?/);
  assert.match(source, /ownedWorkspace\.activePortfolio\.timezone \?\?/);
  assert.match(source, /"Australia\/Sydney"/);
  // nowInstant comes from the workspace (server-resolved), with a
  // deliberately-invalid empty-string fallback rather than any client-side
  // Date() call, so a missing instant fails FY resolution closed instead of
  // guessing.
  assert.match(source, /nowInstant=\{ownedWorkspace\.nowInstant \?\? ""\}/);
  // The workspace type threads both settings.timezone and the resolved
  // instant through, not just the portfolio's own timezone.
  assert.match(source, /timezone\?:\s*string;/);
  assert.match(source, /nowInstant\?:\s*string;/);
});

test("FY-001C: loadAuthenticatedWorkspace resolves nowInstant once server-side and copies user_settings.timezone into the workspace", async () => {
  const source = await readFile(
    new URL("../app/authenticated-workspace.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /timezone:\s*settings\.timezone,/);
  assert.match(source, /const nowInstant = new Date\(\)\.toISOString\(\);/);
  assert.match(source, /nowInstant,/);
});

// --- prototype details tabs: label-only, no fabricated data -----------------

test("FY-001C: the details prototype inserts FY and Last FY after YTD without changing how periods render", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const periods = \["1W", "1M", "3M", "6M", "YTD", "FY", "Last FY", "1Y", "Max"\];/,
  );
  // Still just an interpolated label -- no special-cased branch that would
  // imply real filtering or fabricate different figures for the new tabs.
  assert.match(
    source,
    /<p className="eyebrow">Portfolio value · \{period\}<\/p>/,
  );
});

// --- accessibility: the fy-start-month-helper span sits outside its label --

test("FY-001C: the FY start-month helper text is associated via aria-describedby/htmlFor, not nested inside the label (no double announcement)", async () => {
  const source = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  const labelMatch =
    /<label htmlFor="fy-start-month-select">[\s\S]*?<\/label>/.exec(source);
  assert.ok(labelMatch, "expected an explicit htmlFor label for the FY select");
  assert.doesNotMatch(
    labelMatch![0],
    /fy-start-month-helper/,
    "the helper note must not be nested inside the label's accessible name",
  );
  assert.match(source, /<select\s+id="fy-start-month-select"/);
  assert.match(source, /aria-describedby="fy-start-month-helper"/);
  assert.match(
    source,
    /<span className="menu-note" id="fy-start-month-helper">/,
  );
});

// --- tab accessibility: aria-pressed and range-controls wiring survive -----

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

function renderOwnedOverviewWithFy(financialYearStartMonth: number): string {
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
      financialYearStartMonth: ${financialYearStartMonth},
      timezone: "Australia/Sydney",
      nowInstant: "2026-08-13T04:00:00Z",
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
        status: "complete",
        currencyCode: "AUD",
        current: {
          date: "2026-08-13",
          value: "AUD 1,000.00",
          securities: "AUD 900.00",
          cash: "AUD 100.00",
          cost: "AUD 800.00",
          unrealised: "+AUD 100.00",
          realised: "+AUD 0.00",
          daily: "+AUD 5.00",
          valueDecimal: "1000.00",
          completeness: "complete",
          barHeight: "80%",
        },
        history: [
          {
            date: "2025-07-01",
            value: "AUD 995.00",
            securities: "AUD 895.00",
            cash: "AUD 100.00",
            cost: "AUD 800.00",
            unrealised: "+AUD 95.00",
            realised: "+AUD 0.00",
            daily: "+AUD 2.00",
            valueDecimal: "995.00",
            completeness: "complete",
            barHeight: "78%",
          },
          {
            date: "2026-08-13",
            value: "AUD 1,000.00",
            securities: "AUD 900.00",
            cash: "AUD 100.00",
            cost: "AUD 800.00",
            unrealised: "+AUD 100.00",
            realised: "+AUD 0.00",
            daily: "+AUD 5.00",
            valueDecimal: "1000.00",
            completeness: "complete",
            barHeight: "80%",
          },
        ],
        coverage: {
          pricedHoldingCount: 1,
          nonZeroHoldingCount: 1,
          convertedCashAccountCount: 1,
          nonZeroCashAccountCount: 1,
          totalHoldingCount: 1,
          excluded: [],
          issues: [],
          marketDataStates: [],
        },
        allocation: { status: "complete", rows: [] },
      },
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

test("FY-001C: the overview range controls render FY and Last FY buttons with aria-pressed semantics alongside the existing ranges", () => {
  const html = renderOwnedOverviewWithFy(7);
  assert.match(html, /aria-label="History range"/);
  const rangeControlsMatch =
    /<div class="range-controls"[^>]*>[\s\S]*?<\/div>/.exec(html);
  assert.ok(rangeControlsMatch);
  const rangeControls = rangeControlsMatch![0];
  for (const option of ["1M", "3M", "12M", "FY", "Last FY", "All"]) {
    assert.match(
      rangeControls,
      new RegExp(
        `aria-pressed="${option === "12M" ? "true" : "false"}"[^>]*>${option.replace(/ /g, "\\s*")}<`,
      ),
    );
  }
});

test("FY-001C: the default 12M range still shows the unchanged 'Portfolio history' eyebrow (FY copy is opt-in, not fabricated by default)", () => {
  const html = renderOwnedOverviewWithFy(7);
  assert.match(html, /Portfolio history/);
});
