// PRF-014 step 2d: `OwnedOverviewScreen`'s ~500-line render body -- moved
// verbatim out of `portfolio-shell.tsx` (`"use client"`) into this plain
// (non "use client") sibling module, the same PRF-014 step 2a/2c precedent
// (`portfolio-shell-model.ts`, `portfolio-shell-leaves.tsx`) extends to a
// component whose only client-only need was the FY-range tab state.
//
// Inversion (mirrors `portfolio-shell-client-leaves.tsx`'s `HideSoldToggle`
// pattern exactly): the ONE piece of client state this screen ever held --
// `range` (a `useState`) plus the four `useMemo`s derived from it
// (`currentFyResult`, `lastFyResult`, `history`, `chartHistory`) -- now live
// in a small `"use client"` leaf, `OverviewRangeSelector`
// (`portfolio-shell-client-leaves.tsx`), which computes them once per
// render and hands the FINISHED values down as plain props, along with an
// already-built `rangeControls: ReactNode` for the tab buttons themselves
// (an already-rendered element crosses a real server/client boundary the
// way a live `onClick` closure cannot -- the same reasoning
// `portfolio-shell-leaves.tsx`'s header comment gives for
// `hideSoldToggle`/`createPortfolioAction`). This component is therefore a
// pure function of its props: it renders the hero, chart, published-value
// history panel (slotting `rangeControls` into its original position) and
// the coverage/allocation section, all unconditionally on `range`'s
// CURRENT value passed in -- it holds no hooks of its own.
//
// Honesty note (see `portfolio-shell-leaves.tsx`'s own header comment,
// unchanged by this step): `portfolio-shell.tsx` is still "use client"
// end-to-end (step 2e's job) and `OverviewRangeSelector` -- this module's
// only importer today -- is ALSO "use client", so this split changes
// nothing about what ships in today's production client bundle; it is
// preparation so this piece is independently safe to render from a genuine
// Server Component once step 2e gives the shell's chrome a real
// server/client split. Rendered HTML is byte-identical to the pre-2d
// inline version.
import type { ReactNode } from "react";
import Link from "next/link";
import { type Tone } from "../prototype-data";
import type { FyWindowResult } from "../../domain/calculations/index.ts";
import type { HoldingsSummaryFooter } from "../owned-holdings-summary.ts";
import type { ProjectionPendingState } from "../owned-holdings-contract";
import {
  ownedHoldingAmount,
  ownedHoldingAmountWhole,
  ownedHoldingPercent,
  ownedHoldingToneFromDecimal,
} from "../owned-holding-format";
import { overviewFormulaTotal, overviewStateCopy } from "../overview-copy";
import { fyRangeEyebrow, windowChangeAmount } from "../overview-fy-range";
import { hasUsableHistoryPoints } from "../price-history-chart-geometry";
import { PortfolioValueChart } from "./portfolio-value-chart";
import {
  FY_MONTH_ABBREVIATIONS,
  type OverviewRange,
  type OwnedOverviewData,
  type OwnedOverviewPoint,
  type OwnedPortfolioValueHistory,
} from "./portfolio-shell-model";
import {
  EmptyState,
  OverviewFact,
  overviewDate,
  PartialMarker,
} from "./portfolio-shell-leaves";

export function OwnedOverviewScreenBody({
  data,
  portfolioId,
  portfolioName,
  financialYearStartMonth,
  timezone,
  nowInstant,
  portfolioValueHistory,
  holdingsSummary,
  holdingsProjectionPending,
  range,
  currentFyResult,
  lastFyResult,
  history,
  chartHistory,
  rangeControls,
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
  // `new Date()`/`Date.now()` -- it is always threaded in as a prop from
  // the server render (via `OverviewRangeSelector`, unchanged by this step).
  nowInstant: string;
  // UI-048 (owner-reported): the hero headline's SOURCE OF TRUTH -- the
  // same securities-only totals `app/owned-holdings-summary.ts`'s
  // `buildHoldingsSummaryFooter` already composes for the Holdings tab
  // (`app/authenticated-workspace.ts` now loads holdings for the Overview
  // read too, best-effort). Never `data.current.value` below, which stays
  // sourced from the cash-inclusive CALC-003/CALC-004 persisted snapshot
  // (CALC-005 follow-up). `undefined` means the best-effort holdings load
  // failed or there are no held securities -- the headline then reads
  // "unavailable" rather than falling back to the wrong number.
  holdingsSummary?: HoldingsSummaryFooter;
  /** BUG-017: see `OwnedWorkspace.holdingsProjectionPending`'s doc comment -- the SAME best-effort holdings read `holdingsSummary` above already came from. */
  holdingsProjectionPending?: ProjectionPendingState;
  /** PRF-014 step 2d: owned by `OverviewRangeSelector` (`"use client"`),
   * threaded down as a plain value -- see this module's header comment. */
  range: OverviewRange;
  currentFyResult: FyWindowResult;
  lastFyResult: FyWindowResult;
  history: readonly OwnedOverviewPoint[];
  chartHistory: readonly OwnedOverviewPoint[];
  /** The already-built range-tab `<button>` row, rendered by
   * `OverviewRangeSelector` (it alone owns `range`'s `setRange`) and
   * slotted into its original position inside `.section-heading.compact`. */
  rangeControls: ReactNode;
}) {
  // The FY ranges are the only ones with a computed period change today
  // (1M/3M/12M/All show no delta of their own -- see the hero's `daily`
  // movement, which is independent of the selected range). "Last FY" is a
  // closed window, so its delta must read as change ACROSS that window,
  // never change-to-today; computing first-point-to-last-point of the
  // filtered window satisfies that for both FY ranges.
  const fyWindowChange =
    range === "FY" || range === "Last FY"
      ? windowChangeAmount(history, data.currencyCode)
      : null;
  // A genuine 0.00 change (a flat window) is a known fact, not missing
  // data -- it must render, but neutrally, not as a false "gain" (green).
  // Mirrors OverviewFact's own zero handling below.
  const fyWindowChangeIsZero =
    fyWindowChange !== null && /(?:^| )0\.00$/.test(fyWindowChange);
  const historyEyebrow =
    (range === "FY"
      ? fyRangeEyebrow("FY", currentFyResult, FY_MONTH_ABBREVIATIONS)
      : range === "Last FY"
        ? fyRangeEyebrow("Last FY", lastFyResult, FY_MONTH_ABBREVIATIONS)
        : null) ?? "Portfolio history";
  const current = data.current;
  const partial =
    data.status === "partial" ||
    data.status === "stale" ||
    data.status === "incomplete";
  const chartSampled = chartHistory.length < history.length;
  const stateCopy = current ? overviewStateCopy(data, current) : null;
  // UI-048: the hero headline's actual value -- see this component's
  // `holdingsSummary` prop doc comment for why this is never `current.value`.
  const headlineValue = holdingsSummary?.marketValue ?? {
    status: "unavailable" as const,
    currencyCode: data.currencyCode,
    value: null,
    reason: null,
  };
  // UI-048 review (B2, BLOCKING): the movement line directly beneath the
  // headline must come from the SAME holdings read as the headline itself
  // -- `current.daily` is the published snapshot's own day-over-day change,
  // a different figure that can (and, on the account that triggered this
  // report, does) disagree with a live securities-only total. `holdings
  // Summary.dailyMovement` is `owned-holdings.ts`'s `composePortfolioDaily
  // MovementTotal`, computed from the exact same `rows` the headline's
  // `marketValue` is composed from -- no third derivation.
  const headlineDailyMovement = holdingsSummary?.dailyMovement ?? {
    status: "unavailable" as const,
    currencyCode: data.currencyCode,
    value: null,
    reason: null,
  };
  // UI-048 review round 3 (C2, BLOCKING): the SAME holdings read carries a
  // real daily percent (`owned-holdings-summary.ts`'s `buildHoldingsSummary
  // Footer` composes it from the identical `unrealisedSummary.daily` this
  // movement figure comes from) -- the hero must render it, not the
  // hardcoded "Percentage unavailable" literal that used to sit there
  // regardless of what was actually known.
  const headlineDailyPercent = holdingsSummary?.dailyPercent ?? {
    status: "unavailable" as const,
    currencyCode: "%",
    value: null,
    reason: null,
  };
  const headlineDailyTone: Tone | null =
    headlineDailyMovement.status === "available" &&
    headlineDailyMovement.value !== null
      ? ownedHoldingToneFromDecimal(headlineDailyMovement.value)
      : null;

  if (data.status === "unavailable") {
    return (
      <>
        <section
          className="empty-state"
          aria-labelledby="overview-unavailable-title"
        >
          <p className="eyebrow">Private workspace</p>
          <h1 id="overview-unavailable-title">Overview unavailable</h1>
          <p>
            Published valuation data could not be loaded. Try again shortly.
          </p>
        </section>
        {/* HIST-001: the graph is a SEPARATE, independent read from the
            "Published value" panel above (see this file's HIST-001 import
            comment) -- it renders even when the older persisted-snapshot
            pipeline is unavailable, since investigation found that
            pipeline can stay unavailable indefinitely on a real account
            while price history is fully present. */}
        <PortfolioValueChart
          history={portfolioValueHistory}
          financialYearStartMonth={financialYearStartMonth}
          timezone={timezone}
          nowInstant={nowInstant}
        />
      </>
    );
  }

  if (data.status === "empty" || current === null) {
    // UI-041 (owner directive, verbatim: "The graph in overview should be
    // moved up and replace the 'Empty State No Valuation History' which
    // should only be displayed when we don't have the full valuation
    // history"): `data` here is the CALC-003/CALC-004 persisted-snapshot
    // read (`OwnedOverviewData`) -- its "empty" status simply means that
    // pipeline has never published (CALC-005: it never runs for this
    // owner), which is unconditionally true today regardless of whether
    // real portfolio value history exists. `portfolioValueHistory` is a
    // SEPARATE, independent HIST-001 read-time derivation (see this file's
    // HIST-001 import comment) that can be genuinely populated even while
    // `data.status` is always "empty" -- the old unconditional EmptyState
    // above the chart therefore claimed "no valuation history" on screens
    // where the chart right below it was visibly showing real history, a
    // standing contradiction. The chart is now the PRIMARY element in this
    // slot; the EmptyState renders only when the chart ALSO has nothing
    // usable to show (its own `status !== "ok"` or zero plottable points),
    // so the two surfaces never disagree with each other. The underlying
    // CALC-003/CALC-004 published-snapshot machinery itself is untouched --
    // only this redundant duplicate empty shell is conditioned.
    const chartHasHistory = hasUsableHistoryPoints(
      portfolioValueHistory.status,
      portfolioValueHistory.points,
    );
    return (
      <>
        <PortfolioValueChart
          history={portfolioValueHistory}
          financialYearStartMonth={financialYearStartMonth}
          timezone={timezone}
          nowInstant={nowInstant}
        />
        {chartHasHistory ? null : (
          <EmptyState
            title="No valuation history yet"
            message="Add posted transactions and validated market observations to publish portfolio value."
          />
        )}
      </>
    );
  }

  return (
    <div className="overview-screen owned-overview">
      {/* UI-048 (owner ruling): the visible "Known value" / "Stale coverage"
          box is removed -- it explained coverage of the CALC-003/CALC-004
          persisted-snapshot read below (`data`/`current`), which no longer
          drives the headline OR the movement line beside it (see
          `headlineValue`/`headlineDailyMovement` above -- review B2: both
          now come from the same live holdings read, so a stale/partial
          SNAPSHOT no longer silently narrates a LIVE number). It still
          genuinely describes the KPI facts below (Securities/Cash/
          Unrealised/Cost/Realised, still snapshot-sourced), so the text
          stays reachable to a screen-reader user rather than being deleted
          outright -- sr-only, never a visible box, per the owner's
          report. */}
      {stateCopy ? (
        <p className="sr-only" role="status">
          <strong>
            {data.status === "stale"
              ? "Stale coverage"
              : data.status === "incomplete" && current?.value === null
                ? "Value unavailable"
                : "Known value"}
          </strong>
          <span> -- {stateCopy}</span>
        </p>
      ) : null}
      {/* BUG-017: honest, VISIBLE (non-color) disclosure -- unlike the
          sr-only box above, this headline figure genuinely can be stale
          relative to the ledger (see `holdingsProjectionPending`'s doc
          comment), so it must be visible, not screen-reader-only. */}
      {holdingsProjectionPending?.pending ? (
        <p className="unavailable" role="status">
          {holdingsProjectionPending.reason === "failed"
            ? "The last recalculation failed — figures reflect the previous successful calculation."
            : "Recalculating after your latest ledger change — figures may not yet reflect it."}
        </p>
      ) : null}
      <section className="overview-hero" aria-labelledby="owned-overview-title">
        <div>
          <p className="eyebrow">
            {portfolioName} · {data.currencyCode}
          </p>
          <h1 id="owned-overview-title">
            {/* UI-048 review (minor 1): a headline-appropriate phrase, not
                `ownedHoldingAmountWhole`'s bare lowercase "unavailable" --
                this IS the page's accessible name (`aria-labelledby`
                everything else in the hero points at). */}
            {headlineValue.status === "available" &&
            headlineValue.value !== null
              ? ownedHoldingAmountWhole(data.currencyCode, headlineValue)
              : "Value unavailable"}
            <PartialMarker text={holdingsSummary?.valueQualifier ?? null} />
          </h1>
          {/* UI-048 review round 3: no "as of ..." span here -- option 1
              (reviewer's preferred call). `marketValue`/`dailyMovement` sum
              each row's `homeValue`/`dailyMovement`, and a row's own
              `priceState` can be stale/fallback (a days-old close); the
              hero has no aggregate freshness read to disclose honestly, so
              it makes no timestamp claim instead of a false "now" (deleted
              outright, not relabelled -- a freshness aggregation is a
              recorded follow-up, out of scope here). The movement text's
              own "today" already states what it can back: today's change,
              not a batch date. */}
          <p className="overview-movement">
            <span
              className={
                headlineDailyTone === null
                  ? "muted-copy"
                  : `tone-${headlineDailyTone}`
              }
            >
              {headlineDailyTone === null
                ? "Daily movement unavailable"
                : ownedHoldingAmount(
                    data.currencyCode,
                    headlineDailyMovement,
                    2,
                    true,
                  )}
              {/* UI-048 review round 3 (C1, BLOCKING): the Holdings tab
                  reaches this same field's qualifier right after the
                  amount (`summary.dailyQualifier`, above) -- reused here
                  verbatim rather than silently dropped. Self-guards on
                  `null` (nothing excluded), so this is safe to render
                  unconditionally. */}
              <PartialMarker text={holdingsSummary?.dailyQualifier ?? null} />
              {headlineDailyTone === null ? null : (
                <>
                  {" today · "}
                  {/* UI-048 review round 3 (C2, BLOCKING): the SAME read
                      carries a real percent -- rendering it honestly
                      replaces the hardcoded "Percentage unavailable" that
                      used to sit here regardless of what was actually
                      known. `ownedHoldingPercent` itself falls back to
                      that exact honest text for the genuinely-null case
                      (e.g. a zero previous value). */}
                  {ownedHoldingPercent(headlineDailyPercent, true)}
                </>
              )}
            </span>
          </p>
        </div>
        <dl className="overview-kpis">
          <OverviewFact label="Securities" value={current.securities} />
          <OverviewFact label="Cash" value={current.cash} />
          <OverviewFact
            label={partial ? "Known unrealised" : "Unrealised"}
            value={current.unrealised}
            signed
          />
          <OverviewFact label="Cost" value={current.cost} />
          <OverviewFact label="Realised" value={current.realised} signed />
        </dl>
      </section>

      {/* UI-048: this wrapper is the grid item `.overview-screen` places --
          NOT the chart's own `.history-panel` section inside it, which the
          desktop 2-column grid pins to the narrower left column (shared
          with the "Published value" section below). Full-width per owner
          report ("the graph need to go back to being full width"). */}
      <div className="overview-chart-full">
        <PortfolioValueChart
          history={portfolioValueHistory}
          financialYearStartMonth={financialYearStartMonth}
          timezone={timezone}
          nowInstant={nowInstant}
        />
      </div>

      <section className="history-panel" aria-labelledby="owned-history-title">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">{historyEyebrow}</p>
            <h2 id="owned-history-title">Published value</h2>
            {range === "FY" || range === "Last FY" ? (
              <p className="overview-movement">
                <span
                  className={
                    fyWindowChange === null
                      ? "muted-copy"
                      : fyWindowChangeIsZero
                        ? ""
                        : fyWindowChange.startsWith("−")
                          ? "tone-negative"
                          : "tone-positive"
                  }
                >
                  {fyWindowChange === null
                    ? "Change unavailable"
                    : `${fyWindowChange} ${
                        range === "Last FY" ? "across the window" : "this FY"
                      } · Percentage unavailable`}
                </span>
              </p>
            ) : null}
          </div>
          {rangeControls}
        </div>
        <div
          className="history-bars"
          role="img"
          aria-label={`Published portfolio value history; ${history.length} daily points. ${chartSampled ? "Visual bars are bounded and gap markers are representative when needed; the table below contains every point." : "All points are shown."}`}
        >
          {chartHistory.map((point) => (
            <span
              key={point.date}
              className={
                point.valueDecimal === null
                  ? "history-gap"
                  : point.completeness !== "complete"
                    ? "history-partial"
                    : undefined
              }
              style={{ "--bar-height": point.barHeight } as React.CSSProperties}
              title={`${overviewDate(point.date)}: ${point.value ?? "Unavailable"}`}
            />
          ))}
        </div>
        <p className="chart-coverage">
          {history.length === 0
            ? "No published points in this range."
            : `${history.length} published daily point${history.length === 1 ? "" : "s"}; incomplete dates remain marked in the table.${chartSampled ? " Visual gap markers are representative; use the table for the complete gap record." : ""}`}
        </p>
        <details className="chart-table-details">
          <summary>View history as a table</summary>
          <table>
            <caption>Published portfolio value history</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Value</th>
                <th scope="col">Daily</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {history.map((point) => (
                <tr key={`${point.date}-row`}>
                  <th scope="row">{overviewDate(point.date)}</th>
                  <td>{point.value ?? "Unavailable"}</td>
                  <td>
                    {point.daily ?? "Unavailable"} (Percentage unavailable)
                  </td>
                  <td>{point.completeness}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>

      <section
        className="portfolio-list overview-coverage"
        aria-labelledby="overview-coverage-title"
      >
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Coverage</p>
            <h2 id="overview-coverage-title">What is included</h2>
          </div>
        </div>
        <dl className="overview-kpis">
          <OverviewFact
            label="Priced holdings"
            value={
              data.coverage.pricedHoldingCount === null
                ? null
                : `${data.coverage.pricedHoldingCount} / ${data.coverage.nonZeroHoldingCount ?? "—"} non-zero`
            }
          />
          <OverviewFact
            label="Converted cash"
            value={
              data.coverage.convertedCashAccountCount === null
                ? null
                : `${data.coverage.convertedCashAccountCount} / ${data.coverage.nonZeroCashAccountCount ?? "—"} non-zero`
            }
          />
        </dl>
        <section
          className="allocation-summary"
          aria-labelledby="allocation-title"
        >
          <h3 id="allocation-title">Allocation of valued securities</h3>
          {data.allocation.status === "unavailable" ? (
            <p className="muted-copy">
              Allocation unavailable until current holding valuation facts are
              published.
            </p>
          ) : (
            <ul>
              {data.allocation.rows.map((row) => (
                <li key={row.id}>
                  <span>{row.label}</span>
                  <span>{row.percent ?? "Unavailable"}</span>
                </li>
              ))}
            </ul>
          )}
          {data.allocation.status === "partial" ? (
            <p className="muted-copy">
              Partial allocation: unavailable holdings are excluded.
            </p>
          ) : null}
        </section>
        <p className="muted-copy">Income is not included in this release.</p>
        <details className="overview-drilldown">
          <summary>Coverage and formula details</summary>
          <p>
            Known formula: {current.securities ?? "Unavailable"} securities +{" "}
            {current.cash ?? "Unavailable"} cash ={" "}
            {overviewFormulaTotal(current)}
          </p>
          <dl>
            <div>
              <dt>Priced holdings</dt>
              <dd>
                {data.coverage.pricedHoldingCount ?? "Unavailable"} /{" "}
                {data.coverage.nonZeroHoldingCount ?? "Unavailable"} non-zero
              </dd>
            </div>
            <div>
              <dt>Holding snapshots</dt>
              <dd>{data.coverage.totalHoldingCount ?? "Unavailable"} total</dd>
            </div>
            <div>
              <dt>Converted cash</dt>
              <dd>
                {data.coverage.convertedCashAccountCount ?? "Unavailable"} /{" "}
                {data.coverage.nonZeroCashAccountCount ?? "Unavailable"}{" "}
                non-zero
              </dd>
            </div>
          </dl>
          <h3>
            {data.coverage.issues.length > 0
              ? "Coverage limitations"
              : "Excluded components"}
          </h3>
          {data.coverage.issues.length === 0 ? (
            <p>No exclusions or limitations recorded.</p>
          ) : (
            <ul>
              {data.coverage.issues.map((item) => (
                <li key={`${item.id}-${item.reason}`}>
                  {item.id}: {item.reason}
                </li>
              ))}
            </ul>
          )}
          <h3>Market state explanations</h3>
          {data.coverage.marketDataStates.length === 0 ? (
            <p>No market-data exceptions recorded.</p>
          ) : (
            <ul>
              {data.coverage.marketDataStates.map((state) => (
                <li key={state.id}>
                  {state.id}: price {state.price}, FX {state.fx}, calendar{" "}
                  {state.calendar}
                </li>
              ))}
            </ul>
          )}
          {data.coverage.issues.length > 0 ? (
            <p>
              Review price, FX, and session limitations in{" "}
              <Link href={`/portfolio/${portfolioId}/quotes`}>Quotes</Link>,
              inspect calculation coverage in{" "}
              <Link href={`/portfolio/${portfolioId}/details`}>Details</Link>,
              and review history or quantity issues in the{" "}
              <Link href={`/portfolio/${portfolioId}/ledger/new`}>ledger</Link>.
            </p>
          ) : null}
        </details>
      </section>
    </div>
  );
}
