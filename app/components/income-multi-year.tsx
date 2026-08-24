"use client";

// UI-006A: the Income tab's multi-year FY view. Wireframe decisions
// (TASKS.md UI-006A, owner review 2026-08-13): compact lower-case source
// labels (actual / estimate / projected, current FY labelled distinctly);
// every row opens its own detail (receipts/override/projection inputs);
// past rows additionally offer "Override this FY"; one assumption summary
// line under the table (yield means TOTAL yield including franking);
// recomputed CLIENT-SIDE via DIV-003's pure `projectMultiYearIncomeWhatIf`
// -- imported from the pure domain module (`domain/dividends/projection.ts`,
// no SqlClient import anywhere in that file) rather than the owner-scoped
// service wrapper, so nothing here can accidentally pull server-only/D1 code
// into the client bundle and the what-if stays unpersisted BY CONSTRUCTION
// (nothing in this file writes to storage); range controls (years back /
// years forward) sit at the bottom, as a plain GET form so the range works
// without client JS.
//
// Review fix (2026-08-13, B1/B2): the assumption summary and the value
// column both derive from the ACTIVE projection's own typed assumptions
// object (never from the saved-props growth percentages, which would go
// stale the moment the what-if inputs diverge from them), and the
// current/projected rows' partial-base value status is carried onto the
// visible surface, not just into the row-detail dialog.
//
// DIV-012 (owner directive, 2026-08-24): the what-if overlay is now two
// plain number inputs with NO Apply/Reset controls -- it live-applies on
// every keystroke, both fields defaulting to 6%/yr, independently editable.
// ROOT CAUSE of the pre-fix "editing one field briefly resets the other
// field to the default" quirk: the old design gated BOTH growth axes'
// displayed figures behind one SHARED boolean flag recording whether a
// what-if had been "applied" (plus a paired "applied result" state cell
// alongside it) -- editing EITHER input's change handler unconditionally
// cleared BOTH of those shared cells, which flipped the rendered
// projection/summary for BOTH growth axes back to the saved baseline
// assumptions at once, even though only one field's text had actually
// changed and the other field's own typed value was untouched in its own
// state. From the owner's seat that reads exactly as "the field I didn't
// touch reset to its default". This was never a draft-state/server-resync
// bug -- this component has never made a server round trip for the what-if
// (see the non-persistence tests below) -- it was a single shared pair of
// state cells coupling two otherwise-independent inputs' VISIBLE effect.
// Removing that shared "applied"/"not applied" concept entirely (the table
// always reflects the CURRENT resolved value of both inputs, nothing to
// apply or leave stale) makes the coupling structurally impossible: each
// field's own `useState` is independent, and the live projection is a pure
// function of both current values recomputed on every render -- see
// `resolveWhatIfGrowthPercentDecimal` (`../income-whatif.ts`, split into a
// plain non-JSX module so `tests/div-012.test.ts` can import it directly
// under the repo's native-Node test runner), and tests/div-012.test.ts for
// the source-level pin proving the old shared state cells no longer exist
// anywhere in this file.
//
// DIV-012 review round 1 (BLOCKING fixes):
// B1 -- the RAW input (`valueGrowthInput`/`dividendGrowthInput`) stays
// instant (the controlled `<input>`'s own `value`, so typing never lags),
// but the RECOMPUTE reads a separately-debounced echo of it
// (`debouncedValueGrowthInput`/`debouncedDividendGrowthInput`, ~300ms,
// `WHATIF_DEBOUNCE_MS` below) -- a transient mid-typing state ("3.", "",
// a lone "-") never reaches `resolveWhatIfGrowthPercentDecimal`/the
// projector until typing actually settles, so it can no longer flash the
// whole table/summary to the 6% fallback the way the ORIGINAL cross-reset
// bug flashed it to the saved baseline. Only once settled does an honestly
// invalid/empty value resolve to the real 6% default (+ hint).
// B2 -- a live recompute CAN itself fail (e.g. an overflow-class growth
// input the domain projector's decimal library rejects) even though the
// ORIGINAL server-computed `multiYear` was fine -- `activeProjectionUnavailable`
// below is keyed off `activeProjection` (not `multiYear`) so this failure
// gets its own disclosure banner, and the assumption-summary paragraph is
// suppressed entirely rather than describing rows that no longer render.
// B3 (RULING) -- each box SEEDS from the portfolio's own saved growth
// assumption when one is recorded, defaulting to 6% only when none exists
// (`portfolioValueGrowthPercentDecimal`/`portfolioDividendGrowthPercentDecimal`
// already encode exactly that resolution -- see `resolvePortfolioValueGrowth`/
// `resolvePortfolioDividendGrowth`, `domain/dividends/projection.ts` --
// CALCULATIONS.md:696's "an owner-set value... is used exactly as typed,
// never overridden" stays true). The "(what-if)" suffix only applies once
// the owner actually EDITS a field away from its seed
// (`valueGrowthTouched`/`dividendGrowthTouched` below) -- until then that
// axis's override is left `undefined`, so `projectMultiYearIncomeWhatIf`
// passes the baseline's own `portfolio_assumption`/`none` source straight
// through unmodified, and the summary reads with owner-set/default
// semantics exactly as the pre-what-if baseline did.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { IncomeNav } from "./income-nav.tsx";
import {
  projectMultiYearIncomeWhatIf,
  type ComputeCurrentFinancialYearRowResult,
  type ComputePastFinancialYearRowsResult,
  type CurrentFinancialYearRow,
  type MultiYearProjectionInput,
  type MultiYearProjectionResult,
  type PastFinancialYearRow,
  type PastFyExclusion,
  type ProjectionYearRow,
} from "../../domain/dividends/projection.ts";
import {
  isValidGrowthInput,
  resolveWhatIfGrowthPercentDecimal,
} from "../income-whatif.ts";
import { formatIncomeMoney, formatIncomePercent } from "../income-format.ts";

type SourceLabel =
  "actual" | "estimate" | "fy to date" | "projected" | "no data";

type ValueStatus = "available" | "partial" | "unavailable";

type DisplayRow = {
  key: string;
  label: string;
  valueDecimal: string | null;
  valueStatus: ValueStatus;
  grossDecimal: string | null;
  cashDecimal: string | null;
  frankingDecimal: string | null;
  yieldPercentDecimal: string | null;
  sourceLabel: SourceLabel;
  method: string;
  isProjected: boolean;
  includedSecurityCount: number | null;
  excludedSecurities: readonly PastFyExclusion[];
  overrideHref: string | null;
  /** UI-017 (owner directive): the dividend list filtered to this row's own
   * FY (`?fy=<endingYear>`) -- `null` for every PURELY future PROJECTED row
   * (B2, round-1 review ruling: a projection is a forecast, not a dividend
   * row, so it never links out). Past/current rows always carry a real
   * value here -- DIV-011: the current FY's forecast row is an exception to
   * the "projection never links out" default (see `mergeCurrentFinancialYear`
   * below) because it has REAL underlying dividend rows (actuals received
   * so far this FY), even though its headline figure is a forecast. */
  dividendsHref: string | null;
  /** DIV-011 (owner directive, 2026-08-23): actual dividends received so far
   * THIS financial year (`computeCurrentFinancialYearRow`'s existing
   * fy-to-date derivation, reused verbatim -- never re-derived here).
   * Populated only on the current FY's own row: either merged onto its
   * forward-forecast row (`mergeCurrentFinancialYear`) or, when no forward
   * forecast is available, shown on its own standalone row (`mapCurrentRow`,
   * unchanged from pre-DIV-011). `null` on every past row and every
   * genuinely FUTURE projected row. Rendered ALONGSIDE, never summed into,
   * the row's own (forecast) dividend figures -- they cover different,
   * non-additive time windows (FY-to-date actuals vs a rolling
   * 12-month-forward forecast); summing them would double-count/misstate. */
  actualToDateGrossDecimal: string | null;
  /** `null` exactly when `actualToDateGrossDecimal` is -- i.e. this is not
   * the current FY's own row at all. A non-null label with a `null` gross
   * figure ("no data") is a real, honest state: the current FY genuinely has
   * no recorded dividends yet. */
  actualToDateSourceLabel: SourceLabel | null;
};

function mapPastRow(
  row: PastFinancialYearRow,
  assumptionsHref: string,
  dividendsHref: string,
): DisplayRow {
  const sourceLabel: SourceLabel =
    row.dividendSource === "fy_override" || row.dividendSource === "actual"
      ? "actual"
      : row.dividendSource === "partially_estimated" ||
          row.dividendSource === "provider_estimate"
        ? "estimate"
        : "no data";
  return {
    key: `fy-${row.endingYear}`,
    label: row.label,
    valueDecimal: row.portfolioValueDecimal,
    valueStatus: row.valueStatus,
    grossDecimal: row.dividendGrossDecimal,
    cashDecimal: row.dividendCashDecimal,
    frankingDecimal: row.dividendFrankingKnownDecimal,
    yieldPercentDecimal: row.effectiveYieldPercentDecimal,
    sourceLabel,
    method: row.method,
    isProjected: false,
    includedSecurityCount: row.includedSecurityCount,
    excludedSecurities: row.excludedSecurities,
    overrideHref: `${assumptionsHref}?overrideYear=${row.endingYear}`,
    dividendsHref: `${dividendsHref}?fy=${row.endingYear}`,
    actualToDateGrossDecimal: null,
    actualToDateSourceLabel: null,
  };
}

/** DIV-011 fallback path: renders when NO forward forecast is available at
 * all (`multiYear` degraded) -- the current FY's real actuals-to-date must
 * still render on their own rather than silently vanishing just because a
 * different subsystem (the forecast) is degraded. Unchanged from
 * pre-DIV-011 (still the "(to date)" label, still labels the derived tier
 * "fy to date"). */
function mapCurrentRow(
  row: CurrentFinancialYearRow,
  dividendsHref: string,
): DisplayRow {
  const sourceLabel: SourceLabel = currentFinancialYearSourceLabel(row);
  return {
    key: `fy-${row.endingYear}-current`,
    label: `${row.label} (to date)`,
    valueDecimal: row.portfolioValueDecimal,
    valueStatus: row.valueStatus,
    grossDecimal: row.dividendGrossDecimal,
    cashDecimal: row.dividendCashDecimal,
    frankingDecimal: row.dividendFrankingKnownDecimal,
    yieldPercentDecimal: row.effectiveYieldPercentDecimal,
    sourceLabel,
    method: row.method,
    isProjected: false,
    includedSecurityCount: row.includedSecurityCount,
    excludedSecurities: row.excludedSecurities,
    overrideHref: null,
    dividendsHref: `${dividendsHref}?fy=${row.endingYear}`,
    actualToDateGrossDecimal: null,
    actualToDateSourceLabel: null,
  };
}

function currentFinancialYearSourceLabel(
  row: CurrentFinancialYearRow,
): SourceLabel {
  return row.dividendSource === "fy_override"
    ? "actual"
    : row.dividendSource === "fy_to_date"
      ? "fy to date"
      : "no data";
}

function mapProjectedRow(
  row: ProjectionYearRow,
  valueStatus: "available" | "partial",
): DisplayRow {
  return {
    key: `projected-${row.yearIndex}`,
    // UI-006A/AGENTS.md: with the compact Source column removed, the
    // green `.income-row-projected` styling can no longer be the ONLY
    // signal that a row is a forecast, not a real result -- the label
    // itself must say so (never colour alone).
    label: `${row.label} (projected)`,
    valueDecimal: row.valueDecimal,
    valueStatus,
    grossDecimal: row.grossDividendDecimal,
    cashDecimal: row.cashDividendDecimal,
    frankingDecimal: row.frankingCreditDecimal,
    yieldPercentDecimal: row.yieldPercentDecimal,
    sourceLabel: "projected",
    method: row.method,
    isProjected: true,
    includedSecurityCount: null,
    excludedSecurities: [],
    overrideHref: null,
    // B2 (round-1 review, RULING): a projected row is a FORECAST, not a
    // dividend row -- `?fy=<endingYear>` would either 404-honest-fallback
    // (years beyond the clamp) or, worse, silently show a mostly-empty real
    // list under a heading the owner just saw as a projection. Only past
    // rows -- and, per DIV-011, the current FY's own forecast row (see
    // `mergeCurrentFinancialYear`) -- which have REAL underlying dividend
    // rows, ever link out. Every genuinely FUTURE row (yearIndex >= 2) keeps
    // this `null`.
    dividendsHref: null,
    actualToDateGrossDecimal: null,
    actualToDateSourceLabel: null,
  };
}

/** DIV-011 (owner directive, 2026-08-23): merges the current FY's real
 * actuals-to-date onto its OWN forward-forecast row (year 1 of the active
 * projection -- `MultiYearProjectionInput.startEndingYear`'s doc comment:
 * year 1's `endingYear` IS the current FY) rather than rendering a second,
 * separate "(to date)" row for the identical financial year the way
 * pre-DIV-011 did. Two independently-derived facts land on ONE row: the
 * row's own `grossDecimal`/`cashDecimal`/`frankingDecimal`/`yieldPercentDecimal`
 * stay exactly what `mapProjectedRow` already computed (the forward
 * forecast composition -- the SAME per-security sum feeding the
 * Next-12-months headline); `actualToDateGrossDecimal`/`actualToDateSourceLabel`
 * carry `computeCurrentFinancialYearRow`'s existing fy-to-date derivation,
 * reused verbatim, never re-derived or summed into the forecast figures
 * (they cover different, non-additive time windows). No-op (the plain
 * forecast row, `actualToDate*` left `null`) when `currentFinancialYear`
 * itself is degraded -- the forecast still renders honestly on its own. */
function mergeCurrentFinancialYear(
  forecastRow: DisplayRow,
  /** Year 1's OWN `endingYear` (the raw `ProjectionYearRow` this
   * `forecastRow` was mapped from) -- guarded against
   * `currentFinancialYear.row.endingYear` before merging so a future wiring
   * mistake (the service no longer aligning `startEndingYear` with the
   * current FY) fails toward NOT merging actuals onto the wrong year, never
   * a silent, wrong attribution. */
  forecastEndingYear: number | null,
  currentFinancialYear: ComputeCurrentFinancialYearRowResult,
  dividendsHref: string,
): DisplayRow {
  if (!currentFinancialYear.ok) return forecastRow;
  const row = currentFinancialYear.row;
  if (forecastEndingYear !== row.endingYear) return forecastRow;
  return {
    ...forecastRow,
    actualToDateGrossDecimal: row.dividendGrossDecimal,
    actualToDateSourceLabel: currentFinancialYearSourceLabel(row),
    dividendsHref: `${dividendsHref}?fy=${row.endingYear}`,
  };
}

/** " (what-if)"/" (default)" only when this growth figure's OWN recorded
 * source (from the active projection's assumptions, never component state
 * alone) says so -- review fix B1. DIV-011 review fix (B2): `source ===
 * "none"` now substitutes a real, non-zero 6%/yr default (never the
 * pre-DIV-011 "no growth assumed" 0%) -- rendering it bare would read
 * exactly like an owner's real 0% choice, so it must say "(default)"
 * explicitly, never presented as an assumption the owner made. */
function growthSourceSuffix(source: string): string {
  if (source === "what_if") return " (what-if)";
  if (source === "none") return " (default)";
  return "";
}

/** DIV-012 review (B1, BLOCKING): the recompute debounce -- the controlled
 * inputs themselves stay instant; only the value FED INTO the live
 * projection/summary waits this long after the owner stops typing. ~300ms
 * per the review ruling. */
const WHATIF_DEBOUNCE_MS = 300;

function ValueCell({
  currencyCode,
  valueDecimal,
  valueStatus,
}: {
  currencyCode: string;
  valueDecimal: string | null;
  valueStatus: ValueStatus;
}) {
  return (
    <>
      {formatIncomeMoney(currencyCode, currencyCode, valueDecimal)}
      {valueStatus === "partial" ? (
        <span className="unavailable"> · partial</span>
      ) : null}
    </>
  );
}

export function IncomeMultiYear({
  portfolioId,
  assumptionsHref,
  dividendsHref,
  baseCurrencyCode,
  pastFinancialYears,
  currentFinancialYear,
  multiYear,
  multiYearBaselineInput,
  portfolioValueGrowthPercentDecimal,
  portfolioDividendGrowthPercentDecimal,
  yearsBack,
  yearsForward,
}: {
  portfolioId: string;
  assumptionsHref: string;
  dividendsHref: string;
  baseCurrencyCode: string;
  pastFinancialYears: ComputePastFinancialYearRowsResult;
  currentFinancialYear: ComputeCurrentFinancialYearRowResult;
  multiYear: MultiYearProjectionResult;
  multiYearBaselineInput: MultiYearProjectionInput | null;
  portfolioValueGrowthPercentDecimal: string;
  portfolioDividendGrowthPercentDecimal: string;
  yearsBack: number;
  yearsForward: number;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const rowOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [selectedRow, setSelectedRow] = useState<DisplayRow | null>(null);

  // DIV-012 review (B3, RULING): both what-if fields SEED from the
  // portfolio's own saved growth assumption when one is recorded, defaulting
  // to 6%/yr only when none exists -- `portfolioValueGrowthPercentDecimal`/
  // `portfolioDividendGrowthPercentDecimal` already encode exactly that
  // resolution (`resolvePortfolioValueGrowth`/`resolvePortfolioDividendGrowth`
  // in the domain module), so seeding from them directly keeps
  // CALCULATIONS.md:696's "an owner-set value is used exactly as typed,
  // never overridden" true on load. Two separate `useState` calls per axis
  // -- nothing here can share a mutable cell between the two.
  const [valueGrowthInput, setValueGrowthInput] = useState(
    portfolioValueGrowthPercentDecimal,
  );
  const [dividendGrowthInput, setDividendGrowthInput] = useState(
    portfolioDividendGrowthPercentDecimal,
  );
  // Has the owner actually EDITED this axis away from its seed yet? Gates
  // whether this axis's override is passed to the pure projector at all
  // (see `activeProjection` below) -- untouched means "let the baseline's
  // own owner-set/default source pass straight through", so the summary
  // reads with owner-set semantics, never a premature "(what-if)", until an
  // actual edit happens.
  const [valueGrowthTouched, setValueGrowthTouched] = useState(false);
  const [dividendGrowthTouched, setDividendGrowthTouched] = useState(false);
  // DIV-012 review (B1, BLOCKING): the RECOMPUTE reads these DEBOUNCED
  // echoes of the raw inputs above, not the raw inputs directly -- see
  // `WHATIF_DEBOUNCE_MS` and the effects below. The controlled inputs'
  // OWN `value` stays wired to the instant `valueGrowthInput`/
  // `dividendGrowthInput` state, so typing itself never lags.
  const [debouncedValueGrowthInput, setDebouncedValueGrowthInput] = useState(
    portfolioValueGrowthPercentDecimal,
  );
  const [debouncedDividendGrowthInput, setDebouncedDividendGrowthInput] =
    useState(portfolioDividendGrowthPercentDecimal);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (selectedRow && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!selectedRow && rowOpenerRef.current) {
      rowOpenerRef.current.focus();
      rowOpenerRef.current = null;
    }
  }, [selectedRow]);

  // DIV-012 review (B1, BLOCKING): each axis debounces INDEPENDENTLY (two
  // separate effects, two separate timers) -- editing one field's timer
  // never touches the other's. A fresh keystroke resets its OWN timer (the
  // cleanup function), so the recompute only fires once typing on that
  // field actually settles for `WHATIF_DEBOUNCE_MS`.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValueGrowthInput(valueGrowthInput);
    }, WHATIF_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [valueGrowthInput]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedDividendGrowthInput(dividendGrowthInput);
    }, WHATIF_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dividendGrowthInput]);

  // DIV-012: each axis resolves its OWN debounced (settled) input
  // independently -- neither resolution reads the other field's state, so
  // there is nothing left that could couple them (see the module header's
  // root-cause note).
  const resolvedValueGrowthPercentDecimal = resolveWhatIfGrowthPercentDecimal(
    debouncedValueGrowthInput,
  );
  const resolvedDividendGrowthPercentDecimal =
    resolveWhatIfGrowthPercentDecimal(debouncedDividendGrowthInput);
  // DIV-012 review (B1, BLOCKING): gated on the DEBOUNCED (settled) input,
  // never the raw one -- the hint itself must not flash on/off while typing
  // any more than the table/summary should.
  const valueGrowthHintVisible = !isValidGrowthInput(debouncedValueGrowthInput);
  const dividendGrowthHintVisible = !isValidGrowthInput(
    debouncedDividendGrowthInput,
  );

  // DIV-012: the what-if inputs ARE the live control surface for the
  // forward projection now -- recomputed via the pure domain projector on
  // every render directly from both current SETTLED input values, no Apply
  // step, no "applied" gate. An axis the owner hasn't touched yet passes
  // `undefined` (B3 RULING: let the baseline's own owner-set/default value
  // and source through unmodified, rather than forcing a premature
  // "(what-if)" 6% override onto an untouched field). `multiYearBaselineInput`
  // is `null` in exactly the same degraded cases `multiYear` itself is
  // `ok: false` (CALCULATIONS.md's "Degraded multi-year inputs" section), so
  // falling back to the server-computed `multiYear` there reuses its own
  // typed failure/degradation handling unchanged -- there is nothing a live
  // what-if could compute from when the baseline itself is unavailable.
  const activeProjection = multiYearBaselineInput
    ? projectMultiYearIncomeWhatIf(multiYearBaselineInput, {
        valueGrowthPercentDecimal: valueGrowthTouched
          ? resolvedValueGrowthPercentDecimal
          : undefined,
        dividendGrowthPercentDecimal: dividendGrowthTouched
          ? resolvedDividendGrowthPercentDecimal
          : undefined,
      })
    : multiYear;
  // DIV-012 review (B2, BLOCKING): a live recompute can itself fail (e.g. an
  // overflow-class growth input the domain projector's decimal library
  // rejects) even when the ORIGINAL server-computed `multiYear` was fine --
  // this is intentionally keyed off `activeProjection`, never `multiYear`,
  // so it fires for a live-recompute failure the `!multiYear.ok` banner
  // below can never see.
  const activeProjectionUnavailable =
    multiYearBaselineInput !== null && !activeProjection.ok;
  // Review fix B1: the summary line and the projected rows' partial-base
  // marker both read from THIS -- the active projection's own labelled
  // assumptions -- never from the saved `portfolioValueGrowthPercentDecimal`
  // props, which reflect the portfolio's SAVED assumption, not the live
  // what-if inputs above.
  const activeAssumptions =
    activeProjection && activeProjection.ok
      ? activeProjection.assumptions
      : null;
  const summaryValueGrowthPercentDecimal =
    activeAssumptions?.valueGrowthPercentDecimal ??
    portfolioValueGrowthPercentDecimal;
  const summaryDividendGrowthPercentDecimal =
    activeAssumptions?.dividendGrowthPercentDecimal ??
    portfolioDividendGrowthPercentDecimal;
  const summaryValueGrowthSource =
    activeAssumptions?.valueGrowthSource ?? "portfolio_assumption";
  const summaryDividendGrowthSource =
    activeAssumptions?.dividendGrowthSource ?? "portfolio_assumption";

  const pastRows = pastFinancialYears.ok
    ? pastFinancialYears.rows
        .slice()
        .reverse()
        .map((row) => mapPastRow(row, assumptionsHref, dividendsHref))
    : [];
  const projectedRows =
    activeProjection && activeProjection.ok
      ? activeProjection.rows.map((row) =>
          mapProjectedRow(
            row,
            activeProjection.assumptions.currentPortfolioValueStatus,
          ),
        )
      : [];
  // DIV-011: year 1 of the forward projection IS the current FY's own
  // forward-looking forecast, so its actuals-to-date merge onto that SAME
  // row (`mergeCurrentFinancialYear`) rather than a second, separate row.
  // When no forward forecast is available at all, the actuals-to-date still
  // render on their OWN row (`mapCurrentRow`, unchanged) -- real data must
  // never be dropped just because a different subsystem is degraded.
  const forwardRows: DisplayRow[] =
    projectedRows.length > 0
      ? [
          mergeCurrentFinancialYear(
            projectedRows[0]!,
            activeProjection && activeProjection.ok
              ? activeProjection.rows[0]!.endingYear
              : null,
            currentFinancialYear,
            dividendsHref,
          ),
          ...projectedRows.slice(1),
        ]
      : currentFinancialYear.ok && currentFinancialYear.row
        ? [mapCurrentRow(currentFinancialYear.row, dividendsHref)]
        : [];
  const rows = [...pastRows, ...forwardRows];

  return (
    <main className="income-screen">
      <IncomeNav portfolioId={portfolioId} active="multi-year" />

      {!multiYear.ok ? (
        <p className="status-banner warning" role="status">
          <strong>Forward projection unavailable</strong>
          <span>
            {multiYear.reason === "portfolio_value_unavailable"
              ? "The current portfolio value is unavailable, so forward years cannot be projected."
              : multiYear.reason === "no_yield_coverage"
                ? "No held security has a usable 12-month dividend forecast, so forward years cannot be projected."
                : "Forward years could not be projected with the current year range."}
          </span>
        </p>
      ) : activeProjectionUnavailable ? (
        // DIV-012 review (B2, BLOCKING): the ORIGINAL server-computed
        // `multiYear` was fine (the banner above stays silent) but the LIVE
        // what-if recompute itself failed -- an overflow-class growth input
        // the domain projector's decimal library rejects, for instance. This
        // must not be a silently emptied table with a summary describing
        // rows that no longer exist.
        <p className="status-banner warning" role="status">
          <strong>What-if projection unavailable</strong>
          <span>
            That combination could not be projected. Try different growth
            percentages.
          </span>
        </p>
      ) : null}

      {/* Follow-up 1: a degraded past-FY or current-FY computation is
          disclosed with the same banner pattern as the forward projection --
          never silently collapsed to an empty table with no explanation. */}
      {!pastFinancialYears.ok ? (
        <p className="status-banner warning" role="status">
          <strong>Past financial years unavailable</strong>
          <span>
            {pastFinancialYears.reason === "invalid_years"
              ? "The requested years-back range is invalid."
              : "The financial-year start month is invalid."}
          </span>
        </p>
      ) : null}
      {!currentFinancialYear.ok ? (
        <p className="status-banner warning" role="status">
          <strong>Current financial year unavailable</strong>
          <span>The financial-year start month is invalid.</span>
        </p>
      ) : null}

      <div className="income-fy-table-wrap">
        <table className="income-fy-table">
          {/* UI-026 (B2, Orchestrator ruling): every money figure on this
              screen is `baseCurrencyCode` (ValueCell/the row-detail dialog
              always pass it through, never a security's own currency), so
              ONE screen-level statement -- folded into this table's own
              caption, mirroring portfolio-shell.tsx's "{homeCurrencyCode}
              reporting values" precedent -- covers every bare "$"-style
              figure below, including the row-detail dialog. */}
          <caption>
            Financial-year income and portfolio value ({baseCurrencyCode}{" "}
            reporting values)
          </caption>
          <thead>
            <tr>
              <th scope="col">Year</th>
              <th scope="col" className="numeric">
                Portfolio value
              </th>
              <th scope="col" className="numeric">
                Dividends (gross)
              </th>
              <th scope="col" className="numeric">
                Yield
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>No financial years in range.</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.key}
                  className={
                    row.isProjected ? "income-row-projected" : undefined
                  }
                >
                  <th scope="row">
                    <button
                      type="button"
                      className="income-row-trigger"
                      onClick={(event) => {
                        rowOpenerRef.current = event.currentTarget;
                        setSelectedRow(row);
                      }}
                    >
                      {row.label}
                    </button>
                    {/* UI-017 (owner directive): a real, keyboard-accessible
                        link to the dividend list filtered to this row's own
                        FY -- separate from the row-detail button above,
                        which keeps its existing dialog affordance
                        (assumptions/method/override). `null` for every
                        genuinely FUTURE projected row (B2 ruling: a
                        projection is not a dividend row) -- DIV-011: the
                        current FY's own forecast row is the one exception
                        (it has real underlying dividend rows: actuals
                        received so far this FY), see `mergeCurrentFinancialYear`. */}
                    {row.dividendsHref ? (
                      <Link
                        href={row.dividendsHref}
                        className="income-fy-year-link"
                      >
                        View dividends
                      </Link>
                    ) : null}
                  </th>
                  <td className="numeric">
                    <ValueCell
                      currencyCode={baseCurrencyCode}
                      valueDecimal={row.valueDecimal}
                      valueStatus={row.valueStatus}
                    />
                  </td>
                  <td className="numeric">
                    {formatIncomeMoney(
                      baseCurrencyCode,
                      baseCurrencyCode,
                      row.grossDecimal,
                    )}
                    {/* DIV-011 (owner directive): the current FY's own row
                        additionally discloses actuals received so far THIS
                        financial year, reused verbatim from
                        computeCurrentFinancialYearRow -- shown ALONGSIDE,
                        never summed into, the figure above (a rolling
                        12-month-forward forecast, a different time window). */}
                    {row.actualToDateSourceLabel !== null ? (
                      <span className="unavailable">
                        {" "}
                        ·{" "}
                        {row.actualToDateGrossDecimal !== null
                          ? `${formatIncomeMoney(baseCurrencyCode, baseCurrencyCode, row.actualToDateGrossDecimal)} received so far this FY`
                          : "no dividends received yet this FY"}
                      </span>
                    ) : null}
                  </td>
                  <td className="numeric">
                    {formatIncomePercent(row.yieldPercentDecimal)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* DIV-012 review (B2, BLOCKING): this must never describe rows that
          aren't rendered -- when the live recompute itself has failed
          (`activeProjectionUnavailable`, its own banner above), there is no
          active projection's assumptions left to honestly summarise, so the
          whole paragraph is suppressed rather than falling back to stale
          saved-prop growth figures next to an empty/degraded table. */}
      {!activeProjectionUnavailable ? (
        <p className="income-assumption-summary">
          Yield is TOTAL yield, including franking credits. Portfolio value
          compounds at {formatIncomePercent(summaryValueGrowthPercentDecimal)}
          /yr{growthSourceSuffix(summaryValueGrowthSource)}; dividends compound
          at {formatIncomePercent(summaryDividendGrowthPercentDecimal)}/yr
          {growthSourceSuffix(summaryDividendGrowthSource)} for projected years;
          the yield shown is derived (dividend ÷ value), not a projection input,
          so it can rise OR fall even while dividends compound upward.
          {activeAssumptions?.currentPortfolioValueStatus === "partial"
            ? " Projected years are based on a partial (understated) current portfolio value -- some holdings are unpriced."
            : ""}
        </p>
      ) : null}

      {/* DIV-012 (owner directive + B3 RULING): live-apply, no Apply/Reset
          controls -- typing here recomputes `activeProjection` above,
          debounced ~300ms (B1) so a mid-typing invalid state never flashes
          the table/summary to the fallback. Each field SEEDS from the
          portfolio's own saved growth assumption when one is recorded,
          defaulting to 6%/yr only when none exists; once settled, an
          empty/invalid entry falls back to that same 6% default honestly
          (never erroring or fabricating a zero -- see
          `resolveWhatIfGrowthPercentDecimal`), disclosed via the hint below
          each field rather than blocking input. Selecting the field's
          contents on focus/click (mobile tap included) means a quick
          re-entry never has to fight the previous value. These are live
          preview inputs, not a mutation -- they keep working offline, no
          `isOnline` gating. */}
      <section className="income-whatif" aria-labelledby="income-whatif-title">
        <p className="eyebrow" id="income-whatif-title">
          What if
        </p>
        <div className="income-whatif-inputs">
          <div className="income-whatif-field">
            <label>
              <span>Portfolio growth % / yr</span>
              <input
                type="number"
                step="0.01"
                value={valueGrowthInput}
                onChange={(event) => {
                  setValueGrowthInput(event.target.value);
                  setValueGrowthTouched(true);
                }}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                aria-describedby={
                  valueGrowthHintVisible
                    ? "whatif-value-growth-hint"
                    : undefined
                }
              />
            </label>
            {/* DIV-012 review fold: a hint nested INSIDE the <label> would
                become part of the input's ACCESSIBLE NAME (every text node a
                <label> wraps), changing that name every time validity
                toggles -- moved OUT of the label as its own element,
                associated instead via `aria-describedby`
                (`dividend-assumptions-editor.tsx`'s established precedent),
                so the accessible NAME (the caption span) stays stable and
                this is announced as a description instead. */}
            {valueGrowthHintVisible ? (
              <span id="whatif-value-growth-hint" className="unavailable">
                Using the default 6%/yr until you enter a plain number.
              </span>
            ) : null}
          </div>
          <div className="income-whatif-field">
            <label>
              <span>Dividend growth % / yr</span>
              <input
                type="number"
                step="0.01"
                value={dividendGrowthInput}
                onChange={(event) => {
                  setDividendGrowthInput(event.target.value);
                  setDividendGrowthTouched(true);
                }}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                aria-describedby={
                  dividendGrowthHintVisible
                    ? "whatif-dividend-growth-hint"
                    : undefined
                }
              />
            </label>
            {dividendGrowthHintVisible ? (
              <span id="whatif-dividend-growth-hint" className="unavailable">
                Using the default 6%/yr until you enter a plain number.
              </span>
            ) : null}
          </div>
        </div>
        {multiYearBaselineInput ? (
          <p className="income-whatif-marker">Live preview here -- not saved</p>
        ) : (
          <p className="unavailable" role="status">
            A what-if projection is not available for this portfolio.
          </p>
        )}
      </section>

      <form
        className="income-range-controls"
        method="get"
        aria-label="Adjust year range"
      >
        <label>
          <span>Years back</span>
          <select name="yearsBack" defaultValue={String(yearsBack)}>
            {Array.from({ length: 11 }, (_, index) => index).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Years forward</span>
          <select name="yearsForward" defaultValue={String(yearsForward)}>
            {Array.from({ length: 10 }, (_, index) => index + 1).map(
              (option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ),
            )}
          </select>
        </label>
        <button type="submit">Update range</button>
      </form>

      {selectedRow ? (
        <dialog
          ref={dialogRef}
          className="income-dialog"
          aria-labelledby="income-row-title"
          onCancel={(event) => {
            event.preventDefault();
            dialogRef.current?.close();
            setSelectedRow(null);
          }}
          onClose={() => setSelectedRow(null)}
        >
          <button
            type="button"
            className="sheet-close"
            onClick={() => dialogRef.current?.close()}
          >
            Close
          </button>
          <p className="eyebrow" id="income-row-title">
            {selectedRow.label}
          </p>
          <dl className="detail-facts">
            <div>
              <dt>Portfolio value</dt>
              <dd>
                <ValueCell
                  currencyCode={baseCurrencyCode}
                  valueDecimal={selectedRow.valueDecimal}
                  valueStatus={selectedRow.valueStatus}
                />
              </dd>
            </div>
            <div>
              <dt>Dividends (gross)</dt>
              <dd>
                {formatIncomeMoney(
                  baseCurrencyCode,
                  baseCurrencyCode,
                  selectedRow.grossDecimal,
                )}
              </dd>
            </div>
            <div>
              <dt>Cash</dt>
              <dd>
                {formatIncomeMoney(
                  baseCurrencyCode,
                  baseCurrencyCode,
                  selectedRow.cashDecimal,
                )}
              </dd>
            </div>
            <div>
              <dt>Franking credits</dt>
              <dd>
                {formatIncomeMoney(
                  baseCurrencyCode,
                  baseCurrencyCode,
                  selectedRow.frankingDecimal,
                )}
              </dd>
            </div>
            <div>
              <dt>Yield</dt>
              <dd>{formatIncomePercent(selectedRow.yieldPercentDecimal)}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{selectedRow.sourceLabel}</dd>
            </div>
            {/* DIV-011 (owner directive): the current FY's own row also
                discloses actuals received so far this FY -- reused verbatim
                from computeCurrentFinancialYearRow, never summed into the
                figures above (a different, non-additive time window). */}
            {selectedRow.actualToDateSourceLabel !== null ? (
              <div>
                <dt>Received so far this FY</dt>
                <dd>
                  {formatIncomeMoney(
                    baseCurrencyCode,
                    baseCurrencyCode,
                    selectedRow.actualToDateGrossDecimal,
                  )}{" "}
                  ({selectedRow.actualToDateSourceLabel})
                </dd>
              </div>
            ) : null}
          </dl>
          <p>{selectedRow.method}</p>
          {selectedRow.excludedSecurities.length > 0 ? (
            <ul className="income-exclusions">
              {selectedRow.excludedSecurities.map((item) => (
                <li key={item.portfolioSecurityId}>
                  {item.symbol}: {item.reason.replace(/_/g, " ")}
                </li>
              ))}
            </ul>
          ) : null}
          {selectedRow.overrideHref ? (
            <Link href={selectedRow.overrideHref}>Override this FY</Link>
          ) : null}
        </dialog>
      ) : null}
    </main>
  );
}
