"use client";

// UI-006A: the Income tab's multi-year FY view. Wireframe decisions
// (TASKS.md UI-006A, owner review 2026-08-13): compact lower-case source
// labels (actual / estimate / projected, current FY labelled distinctly);
// every row opens its own detail (receipts/override/projection inputs);
// past rows additionally offer "Override this FY"; one assumption summary
// line under the table (yield means TOTAL yield including franking); the
// what-if overlay is two plain number inputs + Apply/Reset with only a
// compact "applied, not saved" marker, recomputed CLIENT-SIDE via DIV-003's
// pure `projectMultiYearIncomeWhatIf` -- imported from the pure domain
// module (`domain/dividends/projection.ts`, no SqlClient import anywhere in
// that file) rather than the owner-scoped service wrapper, so nothing here
// can accidentally pull server-only/D1 code into the client bundle and the
// what-if stays unpersisted BY CONSTRUCTION (nothing in this file writes to
// storage); range controls (years back / years forward) sit at the bottom,
// as a plain GET form so the range works without client JS.
//
// Review fix (2026-08-13, B1/B2): the assumption summary and the value
// column both derive from the ACTIVE projection's own typed assumptions
// object (never from the saved-props growth percentages, which go stale the
// moment a what-if is applied), and the current/projected rows' partial-base
// value status is carried onto the visible surface, not just into the
// row-detail dialog.
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
   * FY (`?fy=<endingYear>`) -- `null` for every PROJECTED row (B2, round-1
   * review ruling: a projection is a forecast, not a dividend row, so it
   * never links out). Past/current rows always carry a real value here. */
  dividendsHref: string | null;
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
  };
}

function mapCurrentRow(
  row: CurrentFinancialYearRow,
  dividendsHref: string,
): DisplayRow {
  const sourceLabel: SourceLabel =
    row.dividendSource === "fy_override"
      ? "actual"
      : row.dividendSource === "fy_to_date"
        ? "fy to date"
        : "no data";
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
  };
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
    // and current (FY-to-date) rows -- which have REAL underlying dividend
    // rows -- ever link out.
    dividendsHref: null,
  };
}

function isValidGrowthInput(value: string): boolean {
  return /^-?\d+(?:\.\d+)?$/.test(value.trim());
}

/** " (what-if)" only when this growth figure's OWN recorded source (from the active projection's assumptions, never component state alone) says so -- review fix B1. */
function growthSourceSuffix(source: string): string {
  return source === "what_if" ? " (what-if)" : "";
}

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

  const [valueGrowthInput, setValueGrowthInput] = useState(
    portfolioValueGrowthPercentDecimal,
  );
  const [dividendGrowthInput, setDividendGrowthInput] = useState(
    portfolioDividendGrowthPercentDecimal,
  );
  const [whatIfResult, setWhatIfResult] =
    useState<MultiYearProjectionResult | null>(null);
  const [whatIfApplied, setWhatIfApplied] = useState(false);
  const [whatIfError, setWhatIfError] = useState<string | null>(null);

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

  const activeProjection = whatIfApplied ? whatIfResult : multiYear;
  // Review fix B1: the summary line and the projected rows' partial-base
  // marker both read from THIS -- the active projection's own labelled
  // assumptions -- never from the saved `portfolioValueGrowthPercentDecimal`
  // props, which are the SAVED assumption and go stale the instant a
  // what-if is applied.
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
    activeAssumptions?.valueGrowthSource ??
    (whatIfApplied ? "what_if" : "portfolio_assumption");
  const summaryDividendGrowthSource =
    activeAssumptions?.dividendGrowthSource ??
    (whatIfApplied ? "what_if" : "portfolio_assumption");

  const pastRows = pastFinancialYears.ok
    ? pastFinancialYears.rows
        .slice()
        .reverse()
        .map((row) => mapPastRow(row, assumptionsHref, dividendsHref))
    : [];
  const currentRow =
    currentFinancialYear.ok && currentFinancialYear.row
      ? [mapCurrentRow(currentFinancialYear.row, dividendsHref)]
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
  const rows = [...pastRows, ...currentRow, ...projectedRows];

  function updateValueGrowthInput(value: string) {
    setValueGrowthInput(value);
    // Follow-up 2: an edit after Apply invalidates the stale "applied"
    // marker/result immediately -- the table must never keep showing a
    // what-if projection for inputs that no longer match it.
    if (whatIfApplied) {
      setWhatIfApplied(false);
      setWhatIfResult(null);
    }
  }

  function updateDividendGrowthInput(value: string) {
    setDividendGrowthInput(value);
    if (whatIfApplied) {
      setWhatIfApplied(false);
      setWhatIfResult(null);
    }
  }

  function applyWhatIf() {
    setWhatIfError(null);
    if (!multiYearBaselineInput) {
      setWhatIfError(
        "A what-if projection is not available for this portfolio.",
      );
      return;
    }
    if (
      !isValidGrowthInput(valueGrowthInput) ||
      !isValidGrowthInput(dividendGrowthInput)
    ) {
      setWhatIfError("Enter a plain growth percentage, e.g. 3 or -1.5.");
      return;
    }
    const result = projectMultiYearIncomeWhatIf(multiYearBaselineInput, {
      valueGrowthPercentDecimal: valueGrowthInput.trim(),
      dividendGrowthPercentDecimal: dividendGrowthInput.trim(),
    });
    if (!result.ok) {
      setWhatIfError("That combination could not be projected.");
      return;
    }
    setWhatIfResult(result);
    setWhatIfApplied(true);
  }

  function resetWhatIf() {
    setValueGrowthInput(portfolioValueGrowthPercentDecimal);
    setDividendGrowthInput(portfolioDividendGrowthPercentDecimal);
    setWhatIfResult(null);
    setWhatIfApplied(false);
    setWhatIfError(null);
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
                ? "No held security has a resolved dividend yield, so forward years cannot be projected."
                : "Forward years could not be projected with the current year range."}
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
                        projected/forecast row (B2 ruling: a projection is
                        not a dividend row). */}
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

      <p className="income-assumption-summary">
        Yield is TOTAL yield, including franking credits. Portfolio value
        compounds at {formatIncomePercent(summaryValueGrowthPercentDecimal)}
        /yr{growthSourceSuffix(summaryValueGrowthSource)}; dividend yield
        compounds at {formatIncomePercent(summaryDividendGrowthPercentDecimal)}
        /yr
        {growthSourceSuffix(summaryDividendGrowthSource)} for projected years.
        {activeAssumptions?.currentPortfolioValueStatus === "partial"
          ? " Projected years are based on a partial (understated) current portfolio value -- some holdings are unpriced."
          : ""}
      </p>

      <section className="income-whatif" aria-labelledby="income-whatif-title">
        <p className="eyebrow" id="income-whatif-title">
          What if
        </p>
        <div className="income-whatif-inputs">
          <label>
            <span>Portfolio growth % / yr</span>
            <input
              type="number"
              step="0.01"
              value={valueGrowthInput}
              onChange={(event) => updateValueGrowthInput(event.target.value)}
            />
          </label>
          <label>
            <span>Dividend growth % / yr</span>
            <input
              type="number"
              step="0.01"
              value={dividendGrowthInput}
              onChange={(event) =>
                updateDividendGrowthInput(event.target.value)
              }
            />
          </label>
        </div>
        <div className="income-whatif-actions">
          <button type="button" onClick={applyWhatIf}>
            Apply
          </button>
          <button type="button" onClick={resetWhatIf}>
            Reset
          </button>
          {whatIfApplied ? (
            <span className="income-whatif-marker">Applied, not saved</span>
          ) : null}
        </div>
        {whatIfError ? (
          <p className="unavailable" role="alert">
            {whatIfError}
          </p>
        ) : null}
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
