"use client";

// UI-006A: the Income tab's landing view -- the next-12-months projection
// (DIV-003's `breakdown`). Wireframe decisions (TASKS.md UI-006A, owner
// review 2026-08-13): grossed headline carries a PERMANENT "Estimate ..."
// label (never conditional -- every projected figure on this screen is an
// estimate, so the label is not a caveat that only appears sometimes);
// cash/franking sit on the subtitle line with no separate method sentence;
// "Explain this estimate" opens a pop-up with the service's own labelled
// method/provenance text rather than duplicating it inline; stats render as
// dense metric-list rows; the coverage row is a plain link into the
// assumptions editor (UI-006B) with no threshold/warning state.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { OwnedIncomeProjection } from "../owned-income-projection.ts";
import type { PastFyDividendSource } from "../../domain/dividends/projection.ts";
import {
  formatCoverage,
  formatIncomeMoney,
  formatIncomePercent,
} from "../income-format.ts";
import { IncomeNav } from "./income-nav.tsx";

// UI-016: compact source-status text for the past-FY table -- literal,
// honest labels only (never collapses `no_evidence`/`unavailable` into a
// fabricated "actual"). Mirrors `income-multi-year.tsx`'s `mapPastRow`
// grouping but keeps `no_evidence` and `unavailable` visibly distinct here
// since this compact table has no row-detail dialog to explain the
// difference the way the multi-year sub-page does.
function pastFySourceStatus(source: PastFyDividendSource): string {
  switch (source) {
    case "fy_override":
    case "actual":
      return "actual";
    case "provider_estimate":
    case "partially_estimated":
      return "estimate";
    case "no_evidence":
      return "no evidence";
    case "unavailable":
      return "unavailable";
  }
}

export function IncomeLanding({
  projection,
  portfolioId,
  multiYearHref,
  assumptionsHref,
  dividendsHref,
}: {
  projection: OwnedIncomeProjection;
  portfolioId: string;
  multiYearHref: string;
  assumptionsHref: string;
  dividendsHref: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const explainOpenerRef = useRef<HTMLButtonElement | null>(null);
  const [explainOpen, setExplainOpen] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (explainOpen && dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    }
    if (!explainOpen && explainOpenerRef.current) {
      explainOpenerRef.current.focus();
      explainOpenerRef.current = null;
    }
  }, [explainOpen]);

  // DIV-003's `status: "empty"` means this portfolio holds no securities at
  // all -- never render a $0 projection for that case (AGENTS.md: missing
  // dividend data is never zero), explain what to add instead.
  if (projection.status === "empty") {
    return (
      <main className="income-screen">
        <IncomeNav portfolioId={portfolioId} active="next12" />
        <section className="empty-state" aria-labelledby="income-empty-title">
          <h1 id="income-empty-title">No holdings yet</h1>
          <p>
            This portfolio has no securities to project dividend income from.
            Add a holding or import transactions to start.
          </p>
          <Link href={`/portfolio/${portfolioId}/holdings`}>
            Go to holdings
          </Link>
        </section>
      </main>
    );
  }

  const { breakdown } = projection;
  const totalSecurityCount =
    breakdown.includedSecurityCount + breakdown.excludedSecurities.length;

  return (
    <main className="income-screen">
      <IncomeNav portfolioId={portfolioId} active="next12" />

      {breakdown.status === "no_coverage" ? (
        <section
          className="empty-state"
          aria-labelledby="income-no-coverage-title"
        >
          <h1 id="income-no-coverage-title">Dividend income unavailable</h1>
          <p>{breakdown.method}</p>
          {breakdown.excludedSecurities.length > 0 ? (
            <ul className="income-exclusions">
              {breakdown.excludedSecurities.map((item) => (
                <li key={item.portfolioSecurityId}>
                  {item.symbol}: {item.reason.replace(/_/g, " ")}
                </li>
              ))}
            </ul>
          ) : null}
          <Link href={assumptionsHref}>Set dividend assumptions</Link>
        </section>
      ) : (
        <>
          <section
            className="income-headline"
            aria-labelledby="income-headline-title"
          >
            <p className="eyebrow" id="income-headline-title">
              Projected next 12 months
            </p>
            <p className="income-headline-figure">
              {formatIncomeMoney(
                breakdown.currencyCode,
                breakdown.totalGrossDecimal,
              )}
            </p>
            <p className="income-headline-badge">
              Estimate · includes franking credits
            </p>
            <p className="income-subtitle">
              Cash{" "}
              {formatIncomeMoney(
                breakdown.currencyCode,
                breakdown.totalCashDecimal,
              )}{" "}
              · Franking credits{" "}
              {formatIncomeMoney(
                breakdown.currencyCode,
                breakdown.totalFrankingKnownDecimal,
              )}
              {breakdown.totalFrankingIncomplete ? (
                <span className="unavailable">
                  {" "}
                  · franking partially unknown
                </span>
              ) : null}
            </p>
            <button
              type="button"
              className="income-explain-link"
              onClick={(event) => {
                explainOpenerRef.current = event.currentTarget;
                setExplainOpen(true);
              }}
            >
              Explain this estimate
            </button>
            {/* UI-017 (owner directive): the Next 12 Months section links to
                the dividend list filtered to what is KNOWN of the window
                (declared/pending + already-paid rows) -- never the
                projection itself, which is not a list of real rows. */}
            <p>
              <Link
                href={`${dividendsHref}?window=next12`}
                className="income-next12-link"
              >
                View known dividends in this window
              </Link>
            </p>
          </section>

          <dl className="income-metric-list" aria-label="Income statistics">
            <div className="income-metric-row">
              <dt>Average per month</dt>
              <dd>
                {formatIncomeMoney(
                  breakdown.currencyCode,
                  breakdown.averagePerMonthDecimal,
                )}
              </dd>
            </div>
            <div className="income-metric-row">
              <dt>Average per week</dt>
              <dd>
                {formatIncomeMoney(
                  breakdown.currencyCode,
                  breakdown.averagePerWeekDecimal,
                )}
              </dd>
            </div>
            <div className="income-metric-row">
              <dt>Income % of portfolio value</dt>
              <dd>
                {formatIncomePercent(breakdown.incomePercentOfValueDecimal)}
                {breakdown.incomePercentOfValueStatus === "partial" ? (
                  <span className="unavailable"> · partial value</span>
                ) : null}
              </dd>
            </div>
            <div className="income-metric-row">
              <dt>Coverage</dt>
              <dd>
                <Link href={assumptionsHref} className="income-coverage-link">
                  {formatCoverage(
                    breakdown.includedSecurityCount,
                    totalSecurityCount,
                  )}
                </Link>
              </dd>
            </div>
          </dl>
        </>
      )}

      {/* UI-016: recent financial-year history on the main Income tab --
          previously `pastFinancialYears` was threaded to this component but
          never rendered here (only the multi-year sub-page showed it), and
          the page requested `yearsBack: 0` so the rows were empty anyway.
          Independent of `breakdown.status` (a forward-projection coverage
          gap doesn't mean past history is unavailable). Honest states only:
          `formatIncomeMoney(null)` renders "Unavailable" rather than a
          fabricated zero, and the source column names `no_evidence` /
          `unavailable` explicitly rather than folding them into "actual". */}
      <section
        className="income-past-fy"
        aria-labelledby="income-past-fy-title"
      >
        <p className="eyebrow" id="income-past-fy-title">
          Recent financial years
        </p>
        {!projection.pastFinancialYears.ok ? (
          <p className="status-banner warning" role="status">
            <strong>Past financial years unavailable</strong>
            <span>
              {projection.pastFinancialYears.reason === "invalid_years"
                ? "The requested years-back range is invalid."
                : "The financial-year start month is invalid."}
            </span>
          </p>
        ) : projection.pastFinancialYears.rows.length === 0 ? (
          <p>No financial years in range.</p>
        ) : (
          <div className="income-fy-table-wrap">
            <table className="income-fy-table">
              <caption>Recent financial-year dividends</caption>
              <thead>
                <tr>
                  <th scope="col">Year</th>
                  <th scope="col" className="numeric">
                    Gross
                  </th>
                  <th scope="col" className="numeric">
                    Cash
                  </th>
                  <th scope="col" className="numeric">
                    Franking
                  </th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {projection.pastFinancialYears.rows
                  .slice()
                  .reverse()
                  .map((row) => (
                    <tr key={`past-fy-${row.endingYear}`}>
                      <th scope="row">
                        {/* UI-017 (owner directive): clicking a year row
                            opens the dividend list filtered to that year --
                            the whole label (including the partial marker)
                            is wrapped in one real link so the row is
                            keyboard-accessible and works without JS. */}
                        <Link
                          href={`${dividendsHref}?fy=${row.endingYear}`}
                          className="income-fy-row-link"
                        >
                          {row.label}
                          {row.excludedSecurities.length > 0 ? (
                            <span className="unavailable"> · partial</span>
                          ) : null}
                        </Link>
                      </th>
                      <td className="numeric">
                        {formatIncomeMoney(
                          projection.baseCurrencyCode,
                          row.dividendGrossDecimal,
                        )}
                      </td>
                      <td className="numeric">
                        {formatIncomeMoney(
                          projection.baseCurrencyCode,
                          row.dividendCashDecimal,
                        )}
                      </td>
                      <td className="numeric">
                        {formatIncomeMoney(
                          projection.baseCurrencyCode,
                          row.dividendFrankingKnownDecimal,
                        )}
                        {row.dividendFrankingIncomplete ? (
                          <span className="unavailable"> · partial</span>
                        ) : null}
                      </td>
                      <td>
                        <span className="income-source">
                          {pastFySourceStatus(row.dividendSource)}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
        <p>
          {/* Follow-up (b): the sub-page's own default is 2 years back
              (`DEFAULT_YEARS_BACK`, income-year-range.ts) -- without an
              explicit query value, following this link would show FEWER
              years than the compact table above it. `?yearsBack=10`
              (`MAX_YEARS`) so the owner actually reaches the full range in
              one click, matching the promise of "full". */}
          <Link
            href={`${multiYearHref}?yearsBack=10`}
            className="income-coverage-link"
          >
            See the full multi-year range
          </Link>
        </p>
      </section>

      {explainOpen ? (
        <dialog
          ref={dialogRef}
          className="income-dialog"
          aria-labelledby="income-explain-title"
          onCancel={(event) => {
            event.preventDefault();
            dialogRef.current?.close();
            setExplainOpen(false);
          }}
          onClose={() => setExplainOpen(false)}
        >
          <button
            type="button"
            className="sheet-close"
            onClick={() => dialogRef.current?.close()}
          >
            Close
          </button>
          <p className="eyebrow" id="income-explain-title">
            How this estimate is calculated
          </p>
          <p>{breakdown.method}</p>
          {breakdown.excludedSecurities.length > 0 ? (
            <ul className="income-exclusions">
              {breakdown.excludedSecurities.map((item) => (
                <li key={item.portfolioSecurityId}>
                  {item.symbol}: {item.reason.replace(/_/g, " ")}
                </li>
              ))}
            </ul>
          ) : null}
          {/* DIV-006 review follow-up: these securities ARE included in the
              total above (unlike excludedSecurities) but their history-TTM
              figure is only partially known -- named so the owner can see
              the total may understate their true income, never silently
              presented as a complete sum. */}
          {breakdown.partialTtmSecurities.length > 0 ? (
            <>
              <p className="unavailable">
                The trailing-twelve-month figure is only partially known for
                these included securities -- the total above may understate true
                income:
              </p>
              <ul className="income-exclusions">
                {breakdown.partialTtmSecurities.map((item) => (
                  <li key={item.portfolioSecurityId}>{item.symbol}</li>
                ))}
              </ul>
            </>
          ) : null}
          {breakdown.totalFrankingIncomplete ? (
            <p className="unavailable">
              Franking credits are not fully known for every included dividend.
            </p>
          ) : null}
          <p>{projection.aggregateYield.method}</p>
        </dialog>
      ) : null}
    </main>
  );
}
