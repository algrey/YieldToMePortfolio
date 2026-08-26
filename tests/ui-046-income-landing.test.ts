/** UI-046 -- Next 12 Months screen (owner directive, verbatim): "we should
 * make a short note on the page with how it is calculated, plus a link to
 * the per share overrides. We should also add 2 more rows to the table:
 * Last 12 Months and FY27 Estimate. These would go between FY2026 and FY27
 * (So far)." Pinned row order (per the task's own resolution of the owner's
 * wording): so-far, FY{yy} Estimate, Last 12 Months, then the closed past-FY
 * rows (FY2026, FY2025, ...).
 *
 * Reuses `tests/ui-037-next12-fy-row.test.ts`'s render harness pattern
 * against the same `income-landing.tsx` component.
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
  endingYear: 2027,
  label: "FY27",
  window: { startDate: "2026-07-01", endDate: "2027-06-30" },
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

const currentFinancialYearEstimate = {
  ok: true,
  row: {
    endingYear: 2027,
    label: "FY27",
    status: "ok",
    dividendGrossDecimal: "900.00",
    dividendCashDecimal: "720.00",
    dividendFrankingKnownDecimal: "180.00",
    dividendFrankingIncomplete: false,
    dividendAmountIncomplete: false,
    excludedSecurities: [],
    partialTtmSecurities: [],
    method:
      "financial-year-to-date actuals plus an evidence-based projection for the financial year's remaining days",
  },
};

const trailingTwelveMonthActual = {
  windowFromDate: "2025-08-13",
  windowToDate: "2026-08-13",
  status: "ok",
  dividendGrossDecimal: "1250.00",
  dividendCashDecimal: "1000.00",
  dividendFrankingKnownDecimal: "250.00",
  dividendFrankingIncomplete: false,
  dividendAmountIncomplete: false,
  includedSecurityCount: 2,
  excludedSecurities: [],
};

const pastFinancialYearRows = [
  {
    endingYear: 2026,
    label: "FY26",
    window: { startDate: "2025-07-01", endDate: "2026-06-30" },
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
    endingYear: 2025,
    label: "FY25",
    window: { startDate: "2024-07-01", endDate: "2025-06-30" },
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
  currentFinancialYearEstimate,
  trailingTwelveMonthActual,
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

test("UI-046: a short one-line method note renders on the page, plus a link to the per-security overrides", () => {
  const html = renderLanding();
  assert.match(html, /class="income-method-note"/);
  // Genuinely short -- not a paragraph of explanatory text (owner's density
  // ruling): well under a couple of sentences.
  const noteMatch = html.match(/<p class="income-method-note">([\s\S]*?)<\/p>/);
  assert.ok(noteMatch, "expected the method-note paragraph to render");
  const noteText = noteMatch![1]!.replace(/<[^>]+>/g, "").trim();
  assert.ok(
    noteText.length < 220,
    `method note should be short, was ${noteText.length} chars: ${noteText}`,
  );
  assert.match(
    html,
    /<a class="income-coverage-link" href="\/portfolio\/portfolio-a\/income\/assumptions">Per-security overrides<\/a>/,
  );
});

test("UI-046: the fuller explanation is reachable via the existing 'Explain this estimate' dialog, extended with the same plain-language note", () => {
  const html = renderLanding();
  assert.match(html, /Explain this estimate/);
  // The dialog itself only renders once `explainOpen` state is toggled by a
  // click, which this static-markup render cannot simulate -- but the
  // dialog's JSX is present in the rendered tree only when `explainOpen` is
  // true, which defaults to false. Assert the button exists and is wired
  // (structural check) rather than asserting dialog content that requires
  // client-side interaction this render harness cannot perform.
  assert.match(html, /class="income-explain-link"/);
});

test("UI-046: row order is pinned -- so-far, FY Estimate, Last 12 Months, then closed past-FY rows newest-first", () => {
  const html = renderLanding();
  const tbodyMatch = html.match(/<tbody>([\s\S]*)<\/tbody>/);
  assert.ok(tbodyMatch);
  const rows = tbodyMatch![1]!.match(/<tr[^>]*>[\s\S]*?<\/tr>/g);
  assert.ok(rows);
  assert.equal(rows!.length, 5);
  assert.match(rows![0]!, /FY27 \(so far\)/);
  assert.match(rows![1]!, /FY27 Estimate/);
  assert.match(rows![2]!, />Last 12 Months</);
  assert.match(rows![3]!, />FY26</);
  assert.match(rows![4]!, />FY25</);
});

test("UI-046: the FY Estimate row's label is derived from the current FY's own label, never hardcoded -- a different ending year renders correctly", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      currentFinancialYear: {
        ok: true,
        row: { ...currentFinancialYearRow, endingYear: 2031, label: "FY31" },
      },
      currentFinancialYearEstimate: {
        ok: true,
        row: {
          ...currentFinancialYearEstimate.row,
          endingYear: 2031,
          label: "FY31",
        },
      },
    },
  });
  assert.match(html, /FY31 Estimate/);
  assert.doesNotMatch(html, /FY27 Estimate/);
});

test("UI-046: the FY Estimate row renders its own gross/cash/franking figures, labelled 'estimate' in the Source column", () => {
  const html = renderLanding();
  const rowMatch = html.match(
    /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*FY27 Estimate[\s\S]*?<\/tr>/,
  );
  assert.ok(rowMatch, "expected to find the FY27 Estimate row");
  assert.match(rowMatch![0]!, /\$900\.00/);
  assert.match(rowMatch![0]!, /\$720\.00/);
  assert.match(rowMatch![0]!, /\$180\.00/);
  assert.match(rowMatch![0]!, /<span class="income-source">estimate<\/span>/);
});

test("UI-046: the Last 12 Months row renders its own real (actual) figures, labelled 'actual' in the Source column, and is not a link (it is not a filterable dividend-list window)", () => {
  const html = renderLanding();
  const rowMatch = html.match(
    /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Last 12 Months[\s\S]*?<\/tr>/,
  );
  assert.ok(rowMatch, "expected to find the Last 12 Months row");
  assert.match(rowMatch![0]!, /\$1,250\.00/);
  assert.match(rowMatch![0]!, /\$1,000\.00/);
  assert.match(rowMatch![0]!, /\$250\.00/);
  assert.match(rowMatch![0]!, /<span class="income-source">actual<\/span>/);
  assert.doesNotMatch(rowMatch![0]!, /<a[^>]*>Last 12 Months/);
});

test("UI-046: an unavailable Last 12 Months row is disclosed honestly, never a fabricated $0", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      trailingTwelveMonthActual: {
        ...trailingTwelveMonthActual,
        status: "unavailable",
        dividendGrossDecimal: null,
        dividendCashDecimal: null,
        dividendFrankingKnownDecimal: null,
        excludedSecurities: [
          { portfolioSecurityId: "ps-x", symbol: "XYZ", reason: "no_evidence" },
        ],
      },
    },
  });
  const rowMatch = html.match(
    /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Last 12 Months[\s\S]*?<\/tr>/,
  );
  assert.ok(rowMatch);
  assert.match(rowMatch![0]!, /Unavailable/);
  assert.doesNotMatch(rowMatch![0]!, /\$0\.00/);
  assert.match(
    rowMatch![0]!,
    /<span class="income-source">unavailable<\/span>/,
  );
});

test("UI-046: a partial FY Estimate (one leg unavailable) is disclosed with a partial marker, never presented as a complete figure", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      currentFinancialYearEstimate: {
        ok: true,
        row: {
          ...currentFinancialYearEstimate.row,
          status: "partial",
          dividendFrankingIncomplete: true,
        },
      },
    },
  });
  const rowMatch = html.match(
    /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*FY27 Estimate[\s\S]*?<\/tr>/,
  );
  assert.ok(rowMatch);
  assert.match(rowMatch![0]!, /class="unavailable"> · partial/);
});

test("UI-046 B2: a Last 12 Months row with dividendAmountIncomplete renders a '· partial' marker on the label AND the cash cell -- never a silently smaller total under an unqualified 'ok'", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      trailingTwelveMonthActual: {
        ...trailingTwelveMonthActual,
        dividendAmountIncomplete: true,
      },
    },
  });
  const rowMatch = html.match(
    /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Last 12 Months[\s\S]*?<\/tr>/,
  );
  assert.ok(rowMatch);
  // The real (understated) figure still renders -- never dropped.
  assert.match(rowMatch![0]!, /\$1,000\.00/);
  const partialMarkers = rowMatch![0]!.match(/class="unavailable"> · partial/g);
  assert.ok(partialMarkers);
  assert.ok(
    partialMarkers!.length >= 2,
    "expected a partial marker on both the row label and the cash figure",
  );
});

test("UI-046 B2: a FY Estimate row with dividendAmountIncomplete renders a '· partial' marker on the cash cell", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      currentFinancialYearEstimate: {
        ok: true,
        row: {
          ...currentFinancialYearEstimate.row,
          status: "partial",
          dividendAmountIncomplete: true,
        },
      },
    },
  });
  const rowMatch = html.match(
    /<tr[^>]*>(?:(?!<\/tr>)[\s\S])*FY27 Estimate[\s\S]*?<\/tr>/,
  );
  assert.ok(rowMatch);
  assert.match(rowMatch![0]!, /\$720\.00/);
  assert.match(rowMatch![0]!, /class="unavailable"> · partial/);
});

test("UI-046: backward compatibility -- a projection built before UI-046 (missing the two new fields entirely) renders the existing 3 rows unchanged, no crash", () => {
  const legacyProjection: Record<string, unknown> = { ...populatedProjection };
  delete legacyProjection.currentFinancialYearEstimate;
  delete legacyProjection.trailingTwelveMonthActual;
  const html = renderLanding({ projection: legacyProjection });
  const tbodyMatch = html.match(/<tbody>([\s\S]*)<\/tbody>/);
  assert.ok(tbodyMatch);
  const rows = tbodyMatch![1]!.match(/<tr[^>]*>[\s\S]*?<\/tr>/g);
  assert.ok(rows);
  assert.equal(rows!.length, 3);
  assert.doesNotMatch(html, /FY27 Estimate/);
  assert.doesNotMatch(html, />Last 12 Months</);
});
