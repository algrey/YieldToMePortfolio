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
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { IncomeNav } from "./income-nav.tsx";
import {
  applyCapitalEventsToProjection,
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
import type { IncomeScenarioRecord } from "../../db/repositories/index.ts";
import {
  CAPITAL_EVENT_DEFAULT_NAME,
  CAPITAL_EVENT_DEFAULT_YIELD_PERCENT_DECIMAL,
  capitalEventDraftToRow,
  capitalEventInputToRow,
  capitalEventRowToDomainInput,
  capitalEventsStorageKey,
  defaultCapitalEventMonthYear,
  deriveIncomeScenarioYieldSummary,
  INCOME_SCENARIO_NAME_MAX_LENGTH,
  isValidCapitalEventDraft,
  isValidGrowthInput,
  loadCapitalEventsSession,
  resolveLoadedScenarioGrowthField,
  resolveWhatIfGrowthPercentDecimal,
  saveCapitalEventsSession,
  sortCapitalEventRows,
  sumCapitalEventAmounts,
  type CapitalEventDraft,
  type CapitalEventRowState,
} from "../income-whatif.ts";
import { formatIncomeMoney, formatIncomePercent } from "../income-format.ts";
import {
  formatDecimalExact,
  parseDecimal,
  subtractDecimal,
} from "../../domain/calculations/decimal.ts";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

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
  /** BRK-022 slice 3 review fix (B1): the announced-but-unpaid subset of
   * `grossDecimal` above -- populated only on the DIV-011 fallback standalone
   * "(to date)" row (`mapCurrentRow`, when the forward forecast itself is
   * degraded and there is no merged forecast row to attach `actualToDate*`
   * to). `null`/`0` on every other row -- a past row's own gross figure
   * never includes an unpaid subset by the time it closes, and every
   * projected/merged-forecast row's `grossDecimal` is a rolling forecast
   * composition, not an actuals total, so there is nothing to subtract. */
  unpaidGrossDecimal: string | null;
  unpaidCount: number;
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
    unpaidGrossDecimal: null,
    unpaidCount: 0,
  };
}

/** DIV-011 fallback path: renders when NO forward forecast is available at
 * all (`multiYear` degraded) -- the current FY's real actuals-to-date must
 * still render on their own rather than silently vanishing just because a
 * different subsystem (the forecast) is degraded. Unchanged from
 * pre-DIV-011 (still the "(to date)" label, still labels the derived tier
 * "fy to date").
 *
 * BRK-022 slice 3 review fix (B1): `row.dividendGrossDecimal` includes both
 * what has actually been paid and what Sharesight has merely announced --
 * `grossDecimal` here must stay PAID-only (`paidOnlyGrossDecimal`, the SAME
 * helper `mergeCurrentFinancialYear` below already uses for its own
 * `actualToDateGrossDecimal`), and the unpaid subset is separately disclosed
 * via `unpaidGrossDecimal`/`unpaidCount` so the render can append the same
 * "*$x unpaid" note `income-landing.tsx` shows. */
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
    grossDecimal: paidOnlyGrossDecimal(row),
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
    unpaidGrossDecimal: row.dividendUnpaidGrossDecimal,
    unpaidCount: row.dividendUnpaidCount,
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

/** Accepts either the plain base `ProjectionYearRow` (`yieldPercentDecimal`
 * always a string) or DIV-013's capital-adjusted
 * `CapitalEventProjectionYearRow` (`yieldPercentDecimal` may be `null` --
 * an over-removal parcel can newly drive a row's value to zero/negative,
 * where there is no meaningful yield to report). `DisplayRow.yieldPercentDecimal`
 * is already `string | null` (see `formatIncomePercent`'s existing
 * null-safe "Unavailable" handling below), so this widening is purely
 * about what this function itself is willing to ACCEPT. */
function mapProjectedRow(
  row: Omit<ProjectionYearRow, "yieldPercentDecimal"> & {
    yieldPercentDecimal: string | null;
  },
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
    unpaidGrossDecimal: null,
    unpaidCount: 0,
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
/** BRK-022 slice 3: `CurrentFinancialYearRow.dividendGrossDecimal` includes
 * BOTH what has actually been paid and what Sharesight has merely announced
 * (`dividendUnpaidGrossDecimal`, always a subset of it -- see that field's
 * doc comment). The "received so far this FY" figure this module surfaces
 * must stay PAID-only, never silently grow the moment an announcement is
 * observed -- subtracts the (always non-negative, always a subset) unpaid
 * portion via decimal arithmetic, never floats. `null` when the underlying
 * gross figure itself is `null` (nothing to report either way). */
function paidOnlyGrossDecimal(row: CurrentFinancialYearRow): string | null {
  if (row.dividendGrossDecimal === null) return null;
  // `?? null` rather than a strict `=== null` check: a caller/fixture built
  // before this field existed supplies `undefined`, not `null` -- both mean
  // "nothing to subtract", never a value to feed `parseDecimal`.
  const unpaidGrossDecimal = row.dividendUnpaidGrossDecimal ?? null;
  if (unpaidGrossDecimal === null) return row.dividendGrossDecimal;
  return formatDecimalExact(
    subtractDecimal(
      parseDecimal(row.dividendGrossDecimal),
      parseDecimal(unpaidGrossDecimal),
    ),
  );
}

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
    actualToDateGrossDecimal: paidOnlyGrossDecimal(row),
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
  financialYearStartMonth,
  yearsBack,
  yearsForward,
  // DIV-014: defaulted (never left `undefined`) so a caller that predates
  // this task's props -- e.g. an older test fixture rendering this
  // component directly, as `tests/div-012.test.ts`/`tests/div-013.test.ts`/
  // `tests/ui-006a.test.ts`/`tests/ui-017.test.ts` all do -- degrades to
  // "no saved scenarios" rather than throwing on `.length`/`.map` against
  // `undefined`. The real server caller (`page.tsx`) always supplies both
  // explicitly; these defaults are a runtime safety net, not a documented
  // optional-prop contract (the type below stays required).
  initialScenarios = [],
  scenariosUnavailable = false,
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
  /** DIV-013: the portfolio's FY start month (1-12) -- needed to place the
   * "Add/Remove Capital" what-if parcels' owner-chosen calendar month/year
   * onto the same FY calendar the rows above already use. */
  financialYearStartMonth: number;
  yearsBack: number;
  yearsForward: number;
  /** DIV-014: server-loaded saved scenarios for this portfolio -- owned by
   * the server component (`page.tsx`'s `loadOwnedIncomeScenarios`), NEVER
   * mirrored into local state here (see `handleSaveScenario`/
   * `handleDeleteScenario`'s own comments: `router.refresh()` re-fetches
   * this prop after every mutation, mirroring `portfolio-shell.tsx`'s
   * identical watchlist pattern). */
  initialScenarios: IncomeScenarioRecord[];
  scenariosUnavailable: boolean;
}) {
  const router = useRouter();
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

  // DIV-013 (owner directive): the "Add/Remove Capital" what-if rows --
  // committed (post-Apply) parcels, the reinvest-dividends toggle, and the
  // uncommitted draft input fields feeding Apply. Starts empty/off on every
  // fresh mount (server-render included); `hydratedKeyRef` below gates when
  // it is safe to start WRITING to sessionStorage, so the initial empty
  // state can never clobber a real prior-session value before the load
  // effect has had a chance to read it back in (see the two effects below).
  const [capitalRows, setCapitalRows] = useState<CapitalEventRowState[]>([]);
  const [reinvestDividends, setReinvestDividends] = useState(false);
  // DIV-013 review (B3, BLOCKING): which PORTFOLIO's own storage key the
  // CURRENT `capitalRows`/`reinvestDividends` state actually reflects --
  // `null` until the very first load completes. A `useRef` (not state) is
  // deliberate, and its correctness depends on the SAVE effect below being
  // declared BEFORE the LOAD effect (see the save effect's own comment):
  // on the SAME render pass a `portfolioId` prop change re-runs both
  // effects, the save effect must run FIRST and observe the STALE ref
  // (still the PREVIOUS portfolio's key) so it early-returns, rather than
  // writing the just-left portfolio's still-in-state rows into the NEWLY
  // entered portfolio's own key -- reviewer finding B3: switching
  // portfolios without a full remount was clobbering the destination
  // portfolio's real stored session with the source portfolio's leftovers.
  const hydratedKeyRef = useRef<string | null>(null);
  const capitalEventDefaults = defaultCapitalEventMonthYear(new Date());
  const [draftName, setDraftName] = useState("");
  const [draftAmount, setDraftAmount] = useState("");
  const [draftMonth, setDraftMonth] = useState(
    String(capitalEventDefaults.month),
  );
  const [draftYear, setDraftYear] = useState(String(capitalEventDefaults.year));
  const [draftYield, setDraftYield] = useState(
    CAPITAL_EVENT_DEFAULT_YIELD_PERCENT_DECIMAL,
  );
  const [draftCapitalGrowth, setDraftCapitalGrowth] = useState("");
  const [draftDividendGrowth, setDraftDividendGrowth] = useState("");

  // DIV-014 ("Save Scenario" -- owner directive): the name field the owner
  // types before saving, and the pending/error UI state for the save and
  // delete network calls below. Deliberately NOT a mirror of `initialScenarios`
  // itself -- see that prop's own doc comment.
  const [scenarioName, setScenarioName] = useState("");
  const [scenarioSavePending, setScenarioSavePending] = useState(false);
  const [scenarioSaveError, setScenarioSaveError] = useState<string | null>(
    null,
  );
  const [scenarioDeletePendingId, setScenarioDeletePendingId] = useState<
    string | null
  >(null);
  const [scenarioActionError, setScenarioActionError] = useState<string | null>(
    null,
  );

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

  // DIV-013 review (B3, BLOCKING): declared BEFORE the load effect below --
  // effects run in DECLARATION order within a single render pass, so on the
  // exact pass a `portfolioId` prop change re-runs both (both depend on
  // it), THIS one runs FIRST and reads `hydratedKeyRef.current` as it stood
  // BEFORE the load effect (below) has had any chance to update it this
  // pass -- still the PREVIOUS portfolio's key, which mismatches the
  // now-current `portfolioId`, so it early-returns without writing. Only
  // on the FOLLOWING render (once the load effect's `setCapitalRows`/
  // `setReinvestDividends` calls have actually committed, and its own ref
  // update has caught up) does this effect re-run and see the ref/state
  // agree -- at which point `capitalRows`/`reinvestDividends` genuinely
  // belong to the CURRENT `portfolioId`, and persisting them is safe.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (hydratedKeyRef.current !== capitalEventsStorageKey(portfolioId)) {
      return;
    }
    saveCapitalEventsSession(
      window.sessionStorage,
      capitalEventsStorageKey(portfolioId),
      { rows: capitalRows, reinvestDividends },
    );
  }, [capitalRows, reinvestDividends, portfolioId]);

  // DIV-013 (owner directive: "persists for the session and resets unless
  // saved"): reads any capital-change rows/reinvest flag left over from
  // earlier in THIS session -- or, on a PORTFOLIO SWITCH, that OTHER
  // portfolio's own separate key -- back in. Runs on mount and on every
  // `portfolioId` change, client-side only (an effect never runs during
  // server render, so this never throws there even though
  // `window`/`sessionStorage` do not exist on the server). Declared AFTER
  // the save effect above -- see that effect's own comment for why the
  // ORDER is load-behind-save, not just save-behind-load.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Indirected through a nested callback rather than calling setState
    // directly in the effect body -- the same sanctioned
    // `react-hooks/set-state-in-effect` workaround
    // `QuoteCorrectionHistory` (`portfolio-shell.tsx`) already uses for its
    // own mount-time load.
    (() => {
      const key = capitalEventsStorageKey(portfolioId);
      const loaded = loadCapitalEventsSession(window.sessionStorage, key);
      setCapitalRows(loaded.rows);
      setReinvestDividends(loaded.reinvestDividends);
      hydratedKeyRef.current = key;
    })();
  }, [portfolioId]);

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

  // DIV-013: owner-entered capital-change parcels layered onto the ACTIVE
  // (already DIV-012 what-if-adjusted) projection -- never a second,
  // independent recompute of the growth what-if itself (`applyCapitalEventsToProjection`
  // takes `activeProjection`'s own already-resolved rows/assumptions as its
  // base). Sorted oldest-first before mapping (owner directive) -- sort
  // order has no effect on the MATH (each parcel resolves against its own
  // date independently), only on this display's row order.
  const sortedCapitalRows = sortCapitalEventRows(capitalRows);
  const capitalEventsResult =
    activeProjection && activeProjection.ok
      ? applyCapitalEventsToProjection(
          {
            rows: activeProjection.rows,
            assumptions: activeProjection.assumptions,
          },
          sortedCapitalRows.map(capitalEventRowToDomainInput),
          { startMonth: financialYearStartMonth, reinvestDividends },
        )
      : null;
  // Never true when no parcel/reinvestment is configured -- the domain
  // function's own empty-input fast path always succeeds, so this can only
  // fire once the owner has actually entered something (an invalid parcel,
  // or a `financialYearStartMonth` the service itself could not resolve).
  const capitalEventsUnavailable =
    capitalEventsResult !== null && !capitalEventsResult.ok;

  const pastRows = pastFinancialYears.ok
    ? pastFinancialYears.rows
        .slice()
        .reverse()
        .map((row) => mapPastRow(row, assumptionsHref, dividendsHref))
    : [];
  const projectedRows =
    activeProjection && activeProjection.ok
      ? (capitalEventsResult && capitalEventsResult.ok
          ? capitalEventsResult.rows
          : activeProjection.rows
        ).map((row) =>
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

  // DIV-013: the current draft (uncommitted "Add/Remove Capital" input
  // fields) as the pure validator's own input shape -- `month`/`year` are
  // parsed here (the `<select>` guarantees `draftMonth` is always a valid
  // "1".."12" string; `draftYear` is free text and may not parse to a real
  // integer, which `isValidCapitalEventDraft` catches identically to any
  // other invalid field).
  const capitalEventDraft: CapitalEventDraft = {
    name: draftName,
    amountDecimal: draftAmount,
    month: Number(draftMonth),
    year: Number(draftYear),
    yieldPercentDecimal: draftYield,
    capitalGrowthInput: draftCapitalGrowth,
    dividendGrowthInput: draftDividendGrowth,
  };
  const capitalEventDraftValid = isValidCapitalEventDraft(capitalEventDraft);

  function handleApplyCapitalEvent() {
    if (!capitalEventDraftValid) return;
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `capital-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setCapitalRows((existing) => [
      ...existing,
      capitalEventDraftToRow(capitalEventDraft, id),
    ]);
    // Owner directive: "more rows addable via the same inputs" -- reset the
    // draft back to fresh defaults for the next entry rather than leaving
    // the just-applied values sitting in the fields.
    const nextDefaults = defaultCapitalEventMonthYear(new Date());
    setDraftName("");
    setDraftAmount("");
    setDraftMonth(String(nextDefaults.month));
    setDraftYear(String(nextDefaults.year));
    setDraftYield(CAPITAL_EVENT_DEFAULT_YIELD_PERCENT_DECIMAL);
    setDraftCapitalGrowth("");
    setDraftDividendGrowth("");
  }

  function handleRemoveCapitalRow(id: string) {
    setCapitalRows((existing) => existing.filter((row) => row.id !== id));
  }

  // DIV-014 ("Save Scenario" -- owner directive): posts the CURRENT growth
  // inputs + capital-change parcels + reinvest flag as a new named
  // scenario. Owner ruling: store INPUTS only, never a computed output --
  // `sortedCapitalRows.map(capitalEventRowToDomainInput)` is the SAME
  // mapping DIV-013's own live render path already uses (never a second,
  // divergent one), and each growth axis is `null` (untouched -- keeps
  // live-following the portfolio) unless the owner actually edited it
  // (`valueGrowthTouched`/`dividendGrowthTouched`), in which case the
  // DEBOUNCED/settled resolved value is stored -- see
  // `resolveLoadedScenarioGrowthField`'s doc comment for the reverse
  // (load-time) half of this contract. `router.refresh()` re-fetches
  // `initialScenarios` from the server afterwards (this component never
  // mirrors that list into local state -- see the prop's own doc comment).
  async function handleSaveScenario() {
    const name = scenarioName.trim();
    if (name.length === 0) return;
    setScenarioSavePending(true);
    setScenarioSaveError(null);
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/income-scenarios`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            rows: sortedCapitalRows.map(capitalEventRowToDomainInput),
            reinvestDividends,
            valueGrowthPercentDecimal: valueGrowthTouched
              ? resolvedValueGrowthPercentDecimal
              : null,
            dividendGrowthPercentDecimal: dividendGrowthTouched
              ? resolvedDividendGrowthPercentDecimal
              : null,
          }),
        },
      );
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok) {
        throw new Error(result.message ?? "This scenario could not be saved.");
      }
      setScenarioName("");
      router.refresh();
    } catch (error) {
      setScenarioSaveError(
        error instanceof Error
          ? error.message
          : "This scenario could not be saved.",
      );
    } finally {
      setScenarioSavePending(false);
    }
  }

  // DIV-014 (owner ruling, verbatim): "clicking a row loads it and scraps
  // the current scenario, no confirmation" -- every relevant piece of state
  // is overwritten WHOLESALE and IMMEDIATELY (both the raw AND the
  // debounced growth-input echoes are set together, bypassing the normal
  // ~300ms debounce entirely, so the replacement takes visible effect on
  // the very next render, never delayed). `setCapitalRows`/
  // `setReinvestDividends` changing also re-triggers the EXISTING DIV-013
  // save effect (gated on `hydratedKeyRef` already matching this mounted
  // portfolio, true by this point), which persists the loaded scenario into
  // `sessionStorage` under this portfolio's own key -- "updates
  // sessionStorage per DIV-013's mechanics" (owner ruling), reusing that
  // mechanism rather than a second, parallel one.
  function handleLoadScenario(scenario: IncomeScenarioRecord) {
    setCapitalRows(scenario.rows.map(capitalEventInputToRow));
    setReinvestDividends(scenario.reinvestDividends);
    const value = resolveLoadedScenarioGrowthField(
      scenario.valueGrowthPercentDecimal,
      portfolioValueGrowthPercentDecimal,
    );
    setValueGrowthInput(value.input);
    setValueGrowthTouched(value.touched);
    setDebouncedValueGrowthInput(value.input);
    const dividend = resolveLoadedScenarioGrowthField(
      scenario.dividendGrowthPercentDecimal,
      portfolioDividendGrowthPercentDecimal,
    );
    setDividendGrowthInput(dividend.input);
    setDividendGrowthTouched(dividend.touched);
    setDebouncedDividendGrowthInput(dividend.input);
  }

  // DIV-014 (owner ruling): "delete is permanent (x, no confirm per owner)
  // but audited" -- no `confirm()`/dialog gate, the DELETE route's own
  // repository call (`db/repositories/income-scenarios.ts`'s `remove`)
  // writes the audit row unconditionally on this path.
  async function handleDeleteScenario(scenario: IncomeScenarioRecord) {
    setScenarioDeletePendingId(scenario.id);
    setScenarioActionError(null);
    try {
      const response = await fetch(
        `/api/portfolios/${portfolioId}/income-scenarios`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: scenario.id,
            expectedVersion: scenario.version,
          }),
        },
      );
      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
      };
      if (!response.ok || !result.ok) {
        throw new Error(
          result.message ?? "This scenario could not be removed.",
        );
      }
      router.refresh();
    } catch (error) {
      setScenarioActionError(
        error instanceof Error
          ? error.message
          : "This scenario could not be removed.",
      );
    } finally {
      setScenarioDeletePendingId(null);
    }
  }

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
                    {/* BRK-022 slice 3 review fix (B1): the DIV-011 fallback
                        standalone "(to date)" row's own gross figure above is
                        now PAID-only (`mapCurrentRow`) -- discloses the
                        announced-but-unpaid subset separately, mirroring
                        `income-landing.tsx`'s identical note wording/format,
                        non-colour (AGENTS.md): the "unpaid" WORD is the
                        signal, never styling alone. */}
                    {row.unpaidCount > 0 ? (
                      <span className="unavailable">
                        {" "}
                        *
                        {formatIncomeMoney(
                          baseCurrencyCode,
                          baseCurrencyCode,
                          row.unpaidGrossDecimal,
                        )}{" "}
                        unpaid
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
            ? // HIST-001: the OLD copy unconditionally claimed "some
              // holdings are unpriced" -- investigation found real accounts
              // where the status is "partial" for an unrelated reason (cash
              // history completeness, cost-basis provenance) while every
              // holding is fully priced and the value total is NOT
              // understated. `currentPortfolioValuePartialReason` (threaded
              // from `app/owned-income-projection.ts`) names the REAL cause
              // when supplied; the fallback keeps the ORIGINAL wording
              // byte-identical for a caller that never sets it.
              activeAssumptions.currentPortfolioValuePartialReason
              ? ` Projected years are based on a partial current portfolio value -- ${activeAssumptions.currentPortfolioValuePartialReason}.`
              : " Projected years are based on a partial (understated) current portfolio value -- some holdings are unpriced."
            : ""}
          {/* DIV-013 review (fold): the parcel-applied disclosure used to
              live ONLY in the "Add/Remove Capital" section's own marker,
              two sections lower than the figures it actually describes --
              folded up here too, gated identically (`capitalEventsResult?.ok
              === true`, the same B2 "never describe unrendered rows"
              guard). */}
          {capitalEventsResult?.ok === true &&
          (sortedCapitalRows.length > 0 || reinvestDividends)
            ? ` ${sortedCapitalRows.length} what-if capital-change parcel${sortedCapitalRows.length === 1 ? "" : "s"}${reinvestDividends ? " + dividend reinvestment" : ""} applied -- not saved.`
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

      {/* DIV-013 (owner directive, 2026-08-24): "Add/Remove Capital" -- a
          SEPARATE, sibling section from `.income-whatif` above (never nested
          inside it -- DIV-012's own pins assert NO `<button>` exists inside
          that section at all, so Apply/remove/reinvest controls live here
          instead). Owner-entered hypothetical capital-change parcels layer
          onto the table above via `capitalEventsResult`; nothing here is
          ever saved (DIV-014 scope) -- sessionStorage only, reset on a new
          browser session. */}
      <section
        className="income-capital-events"
        aria-labelledby="income-capital-events-title"
      >
        <p className="eyebrow" id="income-capital-events-title">
          Add / remove capital
        </p>
        <p className="unavailable">
          What-if only -- these hypothetical amounts are never saved and never
          change your real portfolio.
        </p>
        <div className="income-capital-events-inputs">
          <label>
            <span>Name</span>
            <input
              type="text"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder={CAPITAL_EVENT_DEFAULT_NAME}
            />
          </label>
          <label>
            <span>Amount (signed; negative removes)</span>
            <input
              type="number"
              step="0.01"
              value={draftAmount}
              onChange={(event) => setDraftAmount(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
          </label>
          <label>
            <span>Month</span>
            <select
              value={draftMonth}
              onChange={(event) => setDraftMonth(event.target.value)}
            >
              {MONTH_NAMES.map((name, index) => (
                <option key={name} value={String(index + 1)}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Year</span>
            <input
              type="number"
              step="1"
              value={draftYear}
              onChange={(event) => setDraftYear(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
          </label>
          <label>
            <span>Dividend yield %/yr</span>
            <input
              type="number"
              step="0.01"
              value={draftYield}
              onChange={(event) => setDraftYield(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
          </label>
          <label>
            <span>Capital growth %/yr (blank follows portfolio)</span>
            <input
              type="number"
              step="0.01"
              value={draftCapitalGrowth}
              onChange={(event) => setDraftCapitalGrowth(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
              placeholder="Follows portfolio"
            />
          </label>
          <label>
            <span>Dividend growth %/yr (blank follows portfolio)</span>
            <input
              type="number"
              step="0.01"
              value={draftDividendGrowth}
              onChange={(event) => setDraftDividendGrowth(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
              placeholder="Follows portfolio"
            />
          </label>
        </div>
        {!capitalEventDraftValid ? (
          <span className="unavailable">
            Enter a valid signed amount, month, year, and dividend yield to
            apply.
          </span>
        ) : null}
        <button
          type="button"
          className="income-capital-events-apply"
          disabled={!capitalEventDraftValid}
          onClick={handleApplyCapitalEvent}
        >
          Apply
        </button>

        {sortedCapitalRows.length > 0 ? (
          <div className="income-fy-table-wrap">
            <table className="income-fy-table income-capital-events-rows">
              <caption>Capital-change parcels (what-if only)</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="numeric">
                    Amount
                  </th>
                  <th scope="col">Date</th>
                  <th scope="col" className="numeric">
                    Yield
                  </th>
                  <th scope="col" className="numeric">
                    Capital growth
                  </th>
                  <th scope="col" className="numeric">
                    Dividend growth
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedCapitalRows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.name}</th>
                    <td className="numeric">
                      {formatIncomeMoney(
                        baseCurrencyCode,
                        baseCurrencyCode,
                        row.amountDecimal,
                        { signed: true },
                      )}
                    </td>
                    <td>
                      {MONTH_NAMES[row.month - 1]} {row.year}
                    </td>
                    <td className="numeric">
                      {formatIncomePercent(row.yieldPercentDecimal)}
                    </td>
                    <td className="numeric">
                      {row.capitalGrowthPercentDecimal !== null
                        ? formatIncomePercent(row.capitalGrowthPercentDecimal)
                        : "Follows portfolio"}
                    </td>
                    <td className="numeric">
                      {row.dividendGrowthPercentDecimal !== null
                        ? formatIncomePercent(row.dividendGrowthPercentDecimal)
                        : "Follows portfolio"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="income-capital-events-remove"
                        onClick={() => handleRemoveCapitalRow(row.id)}
                        aria-label={`Remove ${row.name} capital-change parcel`}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <button
          type="button"
          className={
            reinvestDividends
              ? "income-reinvest-toggle active"
              : "income-reinvest-toggle"
          }
          aria-pressed={reinvestDividends}
          onClick={() => setReinvestDividends((value) => !value)}
        >
          Reinvest dividends{reinvestDividends ? " (on)" : " (off)"}
        </button>

        {capitalEventsUnavailable ? (
          <p className="status-banner warning" role="status">
            <strong>Capital-change what-if unavailable</strong>
            <span>
              That combination could not be projected. Check the entered amounts
              and dates.
            </span>
          </p>
        ) : /* DIV-013 review (B2, BLOCKING): this must never describe rows
              that are not rendered (the identical DIV-012 B2 ruling) --
              `capitalEventsResult?.ok === true` is the ONLY signal that a
              projected table with these parcels actually applied to it
              exists at all; `sortedCapitalRows`/`reinvestDividends` alone
              say nothing about whether `activeProjection` itself is even
              `ok` (when it is not, `capitalEventsResult` is `null`, and
              `capitalEventsUnavailable` above stays `false` too -- there is
              simply nothing to describe). */
        capitalEventsResult?.ok === true &&
          (sortedCapitalRows.length > 0 || reinvestDividends) ? (
          <p className="income-whatif-marker">
            {sortedCapitalRows.length} capital-change parcel
            {sortedCapitalRows.length === 1 ? "" : "s"}
            {reinvestDividends ? " + dividend reinvestment" : ""} applied to the
            table above -- not saved.
          </p>
        ) : null}
      </section>

      {/* DIV-014 (owner directive, 2026-08-24): "below the What-If section,
          a Save Scenario area" -- placed after `.income-capital-events`
          (rather than immediately after `.income-whatif`) because a
          "scenario" is the FULL current what-if state: both top-level
          growth inputs AND the capital-change parcels/reinvest flag above,
          so saving before the parcel section would be premature. Owner
          spec verbatim: "scenarios NAMED before saving; each saved scenario
          = a row showing name, amount invested, yield, capital and
          dividend growth %, with an x to delete; clicking a row loads it
          and SCRAPS the current scenario, no confirmation." */}
      <section
        className="income-saved-scenarios"
        aria-labelledby="income-saved-scenarios-title"
      >
        <p className="eyebrow" id="income-saved-scenarios-title">
          Save scenario
        </p>
        <p className="unavailable">
          Saves the growth inputs and capital-change parcels above as a named
          scenario you can reload later -- durable, but still never changes your
          real portfolio. Clicking a saved scenario below loads it immediately
          and replaces everything above -- there is no confirmation.
        </p>
        <div className="income-save-scenario-inputs">
          <label>
            <span>Scenario name</span>
            <input
              type="text"
              value={scenarioName}
              onChange={(event) => setScenarioName(event.target.value)}
              maxLength={INCOME_SCENARIO_NAME_MAX_LENGTH}
            />
          </label>
          <button
            type="button"
            disabled={scenarioName.trim().length === 0 || scenarioSavePending}
            onClick={handleSaveScenario}
          >
            {scenarioSavePending ? "Saving…" : "Save scenario"}
          </button>
        </div>
        {scenarioSaveError ? (
          <p className="status-banner warning" role="status">
            <strong>Scenario not saved</strong>
            <span>{scenarioSaveError}</span>
          </p>
        ) : null}
        {scenarioActionError ? (
          <p className="status-banner warning" role="status">
            <strong>Scenario action failed</strong>
            <span>{scenarioActionError}</span>
          </p>
        ) : null}

        {scenariosUnavailable ? (
          <p className="unavailable">
            Saved scenarios are temporarily unavailable.
          </p>
        ) : initialScenarios.length === 0 ? (
          <p className="unavailable">No saved scenarios yet.</p>
        ) : (
          <div className="income-fy-table-wrap">
            <table className="income-fy-table income-saved-scenarios-rows">
              {/* DIV-014 owner ruling: "amount invested" is the NET signed
                  sum of every parcel's own signed amount (removals net
                  AGAINST additions, per DIV-013's own signed-amount
                  convention) -- see `sumCapitalEventAmounts`'s doc comment
                  for why this is honestly a net figure, never a gross
                  "total contributed". */}
              <caption>Saved scenarios (net amount invested)</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col" className="numeric">
                    Net amount invested
                  </th>
                  <th scope="col" className="numeric">
                    Yield
                  </th>
                  <th scope="col" className="numeric">
                    Capital growth
                  </th>
                  <th scope="col" className="numeric">
                    Dividend growth
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">Delete</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {initialScenarios.map((scenario) => {
                  const netAmountInvested = sumCapitalEventAmounts(
                    scenario.rows,
                  );
                  const yieldSummary = deriveIncomeScenarioYieldSummary(
                    scenario.rows,
                  );
                  return (
                    <tr key={scenario.id}>
                      <th scope="row">
                        <button
                          type="button"
                          className="income-row-trigger"
                          onClick={() => handleLoadScenario(scenario)}
                        >
                          {scenario.name}
                        </button>
                      </th>
                      <td className="numeric">
                        {formatIncomeMoney(
                          baseCurrencyCode,
                          baseCurrencyCode,
                          netAmountInvested,
                          { signed: true },
                        )}
                      </td>
                      <td className="numeric">
                        {/* UI: owner ruling 2026-08-24 — differing parcel
                            yields show the net-amount-weighted AVERAGE
                            (never "Mixed"); a zero-net scenario has no
                            meaningful blend and stays an em-dash. */}
                        {yieldSummary.kind === "single" ||
                        yieldSummary.kind === "average"
                          ? formatIncomePercent(
                              yieldSummary.yieldPercentDecimal,
                            )
                          : "—"}
                      </td>
                      <td className="numeric">
                        {scenario.valueGrowthPercentDecimal !== null
                          ? formatIncomePercent(
                              scenario.valueGrowthPercentDecimal,
                            )
                          : "Follows portfolio"}
                      </td>
                      <td className="numeric">
                        {scenario.dividendGrowthPercentDecimal !== null
                          ? formatIncomePercent(
                              scenario.dividendGrowthPercentDecimal,
                            )
                          : "Follows portfolio"}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="income-capital-events-remove"
                          disabled={scenarioDeletePendingId === scenario.id}
                          onClick={() => handleDeleteScenario(scenario)}
                          aria-label={`Delete saved scenario ${scenario.name}`}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
