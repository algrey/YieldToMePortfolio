/** UI-037 -- Next-12-months (income landing) sub-tab: "dividends so far for
 * this FY" row + newest-first table order (owner directive, 2026-08-24).
 *
 * NOTE ON THE DUPLICATE TASK ID: `tests/ui-037.test.ts` already exists for a
 * DIFFERENT, earlier, unrelated UI-037 ("back arrow on the manual ledger
 * entry page", DONE 2026-08-23) -- TASKS.md accumulated two separate
 * sections both titled "UI-037" (a genuine ID collision in the backlog,
 * flagged to the Orchestrator rather than silently worked around). This
 * file is named separately so it never collides with or overwrites that
 * file's existing, unrelated pins.
 *
 * Scope: `app/components/income-landing.tsx`'s "Recent financial years"
 * table (the Next 12 Months sub-tab's compact past-FY history, distinct
 * from the Multi-year sub-tab's own table in income-multi-year.tsx, which
 * DIV-011 already gave a merged current-FY row and is NOT in scope here).
 * The new row REUSES `projection.currentFinancialYear`
 * (`computeCurrentFinancialYearRow`'s existing fy-to-date derivation,
 * already computed by `loadOwnedIncomeProjection` -- no new derivation).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

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

const currentFinancialYearRow = {
  endingYear: 2026,
  label: "FY26",
  window: { startDate: "2025-07-01", endDate: "2026-06-30" },
  dividendSource: "fy_to_date",
  dividendGrossDecimal: "300.00",
  dividendCashDecimal: "240.00",
  dividendFrankingKnownDecimal: "60.00",
  dividendFrankingIncomplete: false,
  includedSecurityCount: 2,
  excludedSecurities: [],
  portfolioValueDecimal: "10000.00",
  valueStatus: "available",
  effectiveYieldPercentDecimal: "3.00",
  method: "financial-year-to-date total (not a full-year figure)",
};

const pastFinancialYearRows = [
  {
    endingYear: 2025,
    label: "FY25",
    window: { startDate: "2024-07-01", endDate: "2025-06-30" },
    dividendSource: "actual",
    dividendGrossDecimal: "550.00",
    dividendCashDecimal: "440.00",
    dividendFrankingKnownDecimal: "110.00",
    dividendFrankingIncomplete: false,
    includedSecurityCount: 2,
    excludedSecurities: [],
    portfolioValueDecimal: "9500.00",
    valueStatus: "available",
    effectiveYieldPercentDecimal: "5.79",
    method: "sum of each security's own precedence-resolved FY total (actual)",
  },
  {
    endingYear: 2024,
    label: "FY24",
    window: { startDate: "2023-07-01", endDate: "2024-06-30" },
    dividendSource: "provider_estimate",
    dividendGrossDecimal: "500.00",
    dividendCashDecimal: "400.00",
    dividendFrankingKnownDecimal: "100.00",
    dividendFrankingIncomplete: false,
    includedSecurityCount: 2,
    excludedSecurities: [],
    portfolioValueDecimal: "9000.00",
    valueStatus: "available",
    effectiveYieldPercentDecimal: "5.56",
    method:
      "sum of each security's own precedence-resolved FY total (provider_estimate)",
  },
];

const populatedProjection = {
  status: "ok",
  baseCurrencyCode: "AUD",
  today: "2026-08-13",
  currentPortfolioValueDecimal: "10000.00",
  portfolioValueStatus: "available",
  portfolioValueCoverage: null,
  assumptionGrid: [],
  aggregateYield: {
    status: "ok",
    effectiveYieldPercentDecimal: "4.5",
    effectiveFrankingMixPercentDecimal: "1.5",
    includedValueDecimal: "10000.00",
    includedCount: 2,
    excluded: [],
    method: "value-weighted average of every held security's resolved yield",
  },
  portfolioValueGrowth: {
    source: "none",
    growthPercentDecimal: "0",
    method: "no growth assumed",
  },
  portfolioDividendGrowth: {
    source: "none",
    growthPercentDecimal: "0",
    method: "no growth assumed",
  },
  multiYear: { ok: false, reason: "portfolio_value_unavailable" },
  multiYearBaselineInput: null,
  currentFinancialYear: { ok: true, row: currentFinancialYearRow },
  pastFinancialYears: { ok: true, rows: pastFinancialYearRows },
  breakdown: {
    status: "ok",
    currencyCode: "AUD",
    totalGrossDecimal: "600.00",
    totalCashDecimal: "480.00",
    totalFrankingKnownDecimal: "120.00",
    totalFrankingIncomplete: false,
    averagePerMonthDecimal: "50.00",
    averagePerWeekDecimal: "11.54",
    incomePercentOfValueDecimal: "6.00",
    incomePercentOfValueStatus: "available",
    includedSecurityCount: 2,
    excludedSecurities: [],
    partialTtmSecurities: [],
    method:
      "sum of every held security's 12-month baseline forecast (gross, includes franking credits)",
  },
};

const landingProps = {
  projection: populatedProjection,
  portfolioId: "portfolio-a",
  multiYearHref: "/portfolio/portfolio-a/income/multi-year",
  assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
  dividendsHref: "/portfolio/portfolio-a/income/dividends",
};

function renderLanding(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "IncomeLanding",
    "../app/components/income-landing.tsx",
    { ...landingProps, ...overrides },
  );
}

test("UI-037: the current FY's actuals-so-far row renders with its real figures, labelled distinctly from a closed year's 'actual'", () => {
  const html = renderLanding();
  assert.match(html, /FY26 \(so far\)/);
  assert.match(html, /\$300\.00/); // gross
  assert.match(html, /\$240\.00/); // cash
  assert.match(html, /\$60\.00/); // franking
  // Non-colour distinction (AGENTS.md): the source column text itself says
  // "actual to date", never the closed-year "actual" alone.
  assert.match(
    html,
    /FY26 \(so far\)[\s\S]{0,600}<span class="income-source">actual to date<\/span>/,
  );
  // Scoped strictly to the current-FY row's own <tr>...</tr> (not the
  // whole document) -- FY25's closed-year row legitimately says bare
  // "actual" a little further down, and a wide unscoped window would
  // false-positive match into it.
  const currentRowMatch = html.match(
    /<tr class="income-row-current-fy">[\s\S]*?<\/tr>/,
  );
  assert.ok(currentRowMatch, "expected the current-FY row's own <tr>");
  assert.doesNotMatch(
    currentRowMatch![0],
    /<span class="income-source">actual<\/span>/,
  );
  // Visual (non-exclusive) distinction: the dedicated row class.
  assert.match(html, /<tr class="income-row-current-fy">/);
});

test("UI-037: the current-FY row links to the real dividend list filtered to its own FY (it carries real underlying dividend rows, not a bare forecast)", () => {
  const html = renderLanding();
  assert.match(
    html,
    /<a class="income-fy-row-link" href="\/portfolio\/portfolio-a\/income\/dividends\?fy=2026">FY26 \(so far\)<\/a>/,
  );
});

test("UI-037: table order is reversed -- most recent (the current FY) is first, then FY25, then FY24 (oldest last)", () => {
  const html = renderLanding();
  const currentIndex = html.indexOf("FY26 (so far)");
  const fy25Index = html.indexOf(">FY25<");
  const fy24Index = html.indexOf(">FY24<");
  assert.ok(currentIndex > -1 && fy25Index > -1 && fy24Index > -1);
  assert.ok(
    currentIndex < fy25Index,
    "current FY (so far) row must render before FY25",
  );
  assert.ok(fy25Index < fy24Index, "FY25 must render before the older FY24");
});

test("UI-037: pin the top/bottom row identity -- the FIRST <tr> in tbody is the current FY, the LAST is the oldest past FY", () => {
  const html = renderLanding();
  const tbodyMatch = html.match(/<tbody>([\s\S]*)<\/tbody>/);
  assert.ok(tbodyMatch);
  const rows = tbodyMatch![1]!.match(/<tr[^>]*>[\s\S]*?<\/tr>/g);
  assert.ok(rows);
  assert.equal(rows!.length, 3);
  assert.match(rows![0]!, /FY26 \(so far\)/);
  assert.match(rows![rows!.length - 1]!, />FY24</);
});

test("UI-037: a degraded currentFinancialYear (ok: false) is disclosed with an explicit banner, and the past-FY rows still render (never a silently empty screen)", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      currentFinancialYear: { ok: false, reason: "invalid_start_month" },
    },
  });
  assert.match(html, /Current financial year unavailable/);
  assert.match(html, /The financial-year start month is invalid\./);
  assert.doesNotMatch(html, /\(so far\)/);
  // Past rows unaffected, still present in newest-first order.
  assert.match(html, />FY25</);
  assert.match(html, />FY24</);
});

test("UI-037: when ONLY the current FY has a row (pastFinancialYears degraded), the current-FY row alone still renders -- never collapsed to 'No financial years in range'", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      pastFinancialYears: { ok: false, reason: "invalid_years" },
    },
  });
  assert.match(html, /Past financial years unavailable/);
  assert.match(html, /FY26 \(so far\)/);
  assert.doesNotMatch(html, /No financial years in range\./);
});

test("UI-037: when both pastFinancialYears is empty (ok, 0 rows) and currentFinancialYear is degraded, the honest 'No financial years in range' text renders, no table", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      currentFinancialYear: { ok: false, reason: "invalid_start_month" },
      pastFinancialYears: { ok: true, rows: [] },
    },
  });
  assert.match(html, /No financial years in range\./);
  assert.doesNotMatch(html, /<caption>Recent financial-year dividends/);
});

test("UI-037: a current-FY row with no dividend evidence yet renders an honest 'no evidence' source, never a fabricated actual/zero", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      currentFinancialYear: {
        ok: true,
        row: {
          ...currentFinancialYearRow,
          dividendSource: "no_evidence",
          dividendGrossDecimal: null,
          dividendCashDecimal: null,
          dividendFrankingKnownDecimal: null,
        },
      },
    },
  });
  assert.match(
    html,
    /FY26 \(so far\)[\s\S]{0,600}<span class="income-source">no evidence<\/span>/,
  );
  assert.doesNotMatch(html, /FY26 \(so far\)[\s\S]{0,200}\$0\.00/);
  assert.match(html, /Unavailable/);
});

test("UI-037: an owner FY-override on the current year is labelled 'actual' (a real entered number), distinct from 'actual to date'", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      currentFinancialYear: {
        ok: true,
        row: {
          ...currentFinancialYearRow,
          dividendSource: "fy_override",
        },
      },
    },
  });
  assert.match(
    html,
    /FY26 \(so far\)[\s\S]{0,600}<span class="income-source">actual<\/span>/,
  );
});

test("UI-037: .income-row-current-fy is styled as a supplementary (non-colour-only) cue -- the text label/source already carry the distinction", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.income-row-current-fy\s*{/);
});
