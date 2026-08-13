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
import {
  formatCoverage,
  formatIncomeMoney,
  formatIncomePercent,
} from "../income-format.ts";

export function IncomeLanding({
  projection,
  portfolioId,
  multiYearHref,
  assumptionsHref,
}: {
  projection: OwnedIncomeProjection;
  portfolioId: string;
  multiYearHref: string;
  assumptionsHref: string;
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
        <p className="eyebrow">Income</p>
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
      <p className="eyebrow">Income</p>
      <nav className="income-view-tabs" aria-label="Income views">
        <span aria-current="page">Next 12 months</span>
        <Link href={multiYearHref}>Multi-year</Link>
      </nav>

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
