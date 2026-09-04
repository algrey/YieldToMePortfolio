"use client";

import { useMemo, useState } from "react";
import {
  currentFyWindow,
  lastFyWindow,
} from "../../domain/calculations/index.ts";
import { subtractCalendarMonths } from "../overview-range";
import { sampleOverviewChartPoints } from "../overview-chart";
import {
  filterToClosedFyWindow,
  filterToFyToDateWindow,
} from "../overview-fy-range";
import type { HoldingsSummaryFooter } from "../owned-holdings-summary.ts";
import type { ProjectionPendingState } from "../owned-holdings-contract";
import {
  type OverviewRange,
  type OwnedOverviewData,
  type OwnedPortfolioValueHistory,
} from "./portfolio-shell-model";
import { OwnedOverviewScreenBody } from "./portfolio-shell-overview";

// PRF-014 step 2c: `HoldingsSummaryFooterRow` (see
// portfolio-shell-leaves.tsx) has zero hooks/state/effects/browser APIs of
// its own -- its ONLY genuinely interactive fragment is the "Hide
// Sold"/"Show Sold" toggle button, which used to receive a bare
// `onToggleHideSold: () => void` closure as a prop. A plain function
// cannot cross a real server/client component boundary (only a Server
// Action can), so a component holding one in its own prop type can never
// actually be rendered from a Server Component -- it would only ever work
// by accident, the way it does TODAY, because `portfolio-shell.tsx` (the
// caller, `OwnedHoldingsScreen`) is itself still "use client" and nothing
// here crosses a real RSC boundary yet.
//
// Inversion: `OwnedHoldingsScreen` (still "use client", still owns the
// `hideSold`/`setHideSold` state) now builds this element itself and hands
// the FINISHED node down to `HoldingsSummaryFooterRow` as a plain
// `hideSoldToggle: ReactNode` prop -- an already-rendered React element is
// serializable across a real server/client boundary the way a closure is
// not, which is what makes `HoldingsSummaryFooterRow` itself safe to
// render from a genuine Server Component once PRF-014 step 2e gives it
// one. Markup is byte-identical to the pre-2c inline `<button>`.
//
// Honesty note (see portfolio-shell-leaves.tsx's own header comment): this
// file is "use client" and this component genuinely needs to be, but
// `portfolio-shell.tsx` (the only importer today) is ALSO still "use
// client" end-to-end, so this split changes nothing about what ships in
// today's production client bundle -- it is preparation for step 2e, not
// a bundle-size win by itself.
export function HideSoldToggle({
  hideSold,
  onToggleHideSold,
}: {
  hideSold: boolean;
  onToggleHideSold: () => void;
}) {
  return (
    <button
      type="button"
      className="hide-sold-toggle"
      aria-pressed={hideSold}
      onClick={onToggleHideSold}
    >
      {hideSold ? "Show Sold" : "Hide Sold"}
    </button>
  );
}

// PRF-014 step 2d: `OwnedOverviewScreen`'s only client state was the
// history chart's `range` selector (`useState`) plus four `useMemo`s
// derived from it (`currentFyResult`/`lastFyResult`/`history`/
// `chartHistory`) -- everything else in that ~560-line component was a
// pure function of its props. This leaf owns exactly that state/memo slice
// and the range-tab `<button>` row that mutates it, then renders the
// server-renderable body (`OwnedOverviewScreenBody`,
// portfolio-shell-overview.tsx) as its child, handing down the four
// computed values plus `range` itself and the finished `rangeControls`
// element -- the same "build the interactive piece here, hand down a
// finished ReactNode" inversion `HideSoldToggle` above uses, applied to a
// whole memoised slice instead of one button. `portfolio-shell.tsx`'s
// `PortfolioShell` renders this directly where it used to render
// `OwnedOverviewScreen` inline, with an unchanged prop list.
//
// Honesty note (see this file's `HideSoldToggle` comment above, and
// portfolio-shell-leaves.tsx's/portfolio-shell-overview.tsx's own header
// comments): `portfolio-shell.tsx` is still "use client" end-to-end (step
// 2e's job), so this split changes nothing about what ships in today's
// production client bundle -- it is preparation for step 2e. Rendered HTML
// is byte-identical to the pre-2d inline `OwnedOverviewScreen`.
export function OverviewRangeSelector({
  data,
  portfolioId,
  portfolioName,
  financialYearStartMonth,
  timezone,
  nowInstant,
  portfolioValueHistory,
  holdingsSummary,
  holdingsProjectionPending,
}: {
  data: OwnedOverviewData;
  portfolioId: string;
  portfolioName: string;
  financialYearStartMonth: number;
  timezone: string;
  portfolioValueHistory: OwnedPortfolioValueHistory;
  // A full ISO-8601 instant resolved server-side when the workspace was
  // assembled (see OwnedWorkspace.nowInstant). FY is an ABSOLUTE named
  // period -- unlike the relative 1M/3M/12M cutoffs, which are safe to
  // anchor on the latest published point, "FY"/"Last FY" must anchor on
  // the real current instant. Anchoring on a history point instead would
  // mislabel the window (stale data reads as a false "current FY") and,
  // because that point's date is a bare local calendar date rather than an
  // instant, would also misclassify boundary dates in negative-offset
  // timezones (FY-001C review B1/B2). This must never be computed with
  // `new Date()`/`Date.now()` inside this client component -- it is always
  // threaded in as a prop from the server render.
  nowInstant: string;
  holdingsSummary?: HoldingsSummaryFooter;
  /** BUG-017: see `OwnedWorkspace.holdingsProjectionPending`'s doc comment -- the SAME best-effort holdings read `holdingsSummary` above already came from. */
  holdingsProjectionPending?: ProjectionPendingState;
}) {
  const [range, setRange] = useState<OverviewRange>("12M");
  const currentFyResult = useMemo(
    () => currentFyWindow(nowInstant, financialYearStartMonth, timezone),
    [nowInstant, financialYearStartMonth, timezone],
  );
  const lastFyResult = useMemo(
    () => lastFyWindow(nowInstant, financialYearStartMonth, timezone),
    [nowInstant, financialYearStartMonth, timezone],
  );
  const history = useMemo(() => {
    if (range === "All") return data.history;
    if (range === "FY")
      return filterToFyToDateWindow(data.history, currentFyResult);
    if (range === "Last FY")
      return filterToClosedFyWindow(data.history, lastFyResult);
    const latest = data.history[data.history.length - 1];
    if (!latest) return [];
    const cutoffDate = subtractCalendarMonths(
      latest.date,
      range === "1M" ? 1 : range === "3M" ? 3 : 12,
    );
    return data.history.filter((point) => point.date >= cutoffDate);
  }, [data.history, range, currentFyResult, lastFyResult]);
  const chartHistory = useMemo(
    () => sampleOverviewChartPoints(history),
    [history],
  );
  const rangeControls = (
    <div className="range-controls" aria-label="History range">
      {(["1M", "3M", "12M", "FY", "Last FY", "All"] as const).map((option) => (
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
  );
  return (
    <OwnedOverviewScreenBody
      data={data}
      portfolioId={portfolioId}
      portfolioName={portfolioName}
      financialYearStartMonth={financialYearStartMonth}
      timezone={timezone}
      nowInstant={nowInstant}
      portfolioValueHistory={portfolioValueHistory}
      holdingsSummary={holdingsSummary}
      holdingsProjectionPending={holdingsProjectionPending}
      range={range}
      currentFyResult={currentFyResult}
      lastFyResult={lastFyResult}
      history={history}
      chartHistory={chartHistory}
      rangeControls={rangeControls}
    />
  );
}
