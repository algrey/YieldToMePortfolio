import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  projectMultiYearIncomeWhatIf,
  type MultiYearProjectionAssumptions,
  type MultiYearProjectionInput,
} from "../domain/dividends/projection.ts";
import {
  clampYears,
  DEFAULT_YEARS_BACK,
  DEFAULT_YEARS_FORWARD,
  MAX_YEARS,
} from "../app/income-year-range.ts";

// UI-006A: Income tab -- next-12-months landing and multi-year FY view.
// Rendered assertions use the same `tsx`-loader render trick as
// `tests/qa-001b.test.ts` (react-dom/server in a child process) since these
// components live outside the PortfolioShell dual-mode render path this
// suite's other tests read as source instead.

function extractBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*{([^}]*)}`));
  assert.ok(match, `expected a "${selector}" rule in globals.css`);
  return match![1];
}

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

// --- Landing fixtures -------------------------------------------------

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
  currentFinancialYear: { ok: false, reason: "invalid_start_month" },
  pastFinancialYears: { ok: false, reason: "invalid_years" },
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
  // UI-016: the portfolio-wide individual-dividends list link.
  dividendsHref: "/portfolio/portfolio-a/income/dividends",
};

function renderLanding(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "IncomeLanding",
    "../app/components/income-landing.tsx",
    { ...landingProps, ...overrides },
  );
}

// --- Multi-year fixtures -----------------------------------------------

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

const multiYearAssumptions: MultiYearProjectionAssumptions = {
  currentPortfolioValueDecimal: "10000.00",
  currentPortfolioValueStatus: "available",
  baseYieldPercentDecimal: "6.00",
  baseFrankingMixPercentDecimal: "20.00",
  valueGrowthPercentDecimal: "5",
  valueGrowthSource: "portfolio_assumption",
  dividendGrowthPercentDecimal: "0",
  dividendGrowthSource: "none",
};

// The exact MultiYearProjectionInput the real service would hand the
// component -- used both to render the baseline and, in the what-if
// recompute test, fed through the REAL `projectMultiYearIncomeWhatIf`.
const multiYearBaselineInput: MultiYearProjectionInput = {
  assumptions: multiYearAssumptions,
  yearsForward: 1,
  startEndingYear: 2026,
};

const baselineMultiYear = {
  ok: true,
  rows: [
    {
      yearIndex: 1,
      endingYear: 2027,
      label: "FY27",
      valueDecimal: "10500.00",
      yieldPercentDecimal: "6.00",
      grossDividendDecimal: "630.00",
      cashDividendDecimal: "504.00",
      frankingCreditDecimal: "126.00",
      method:
        "portfolio value compounds at 5%/yr (portfolio_assumption); effective yield compounds at 0%/yr (none); dividend includes franking credits",
    },
  ],
  assumptions: multiYearAssumptions,
};

const populatedMultiYearProps = {
  // UI-022: the Income sub-tab hrefs are derived from `portfolioId` inside
  // the shared `IncomeNav`, so the screen no longer takes per-tab hrefs.
  portfolioId: "portfolio-a",
  assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
  baseCurrencyCode: "AUD",
  pastFinancialYears: { ok: true, rows: pastFinancialYearRows },
  currentFinancialYear: { ok: true, row: currentFinancialYearRow },
  multiYear: baselineMultiYear,
  multiYearBaselineInput,
  portfolioValueGrowthPercentDecimal: "5",
  portfolioDividendGrowthPercentDecimal: "0",
  yearsBack: 2,
  yearsForward: 1,
};

function renderMultiYear(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "IncomeMultiYear",
    "../app/components/income-multi-year.tsx",
    { ...populatedMultiYearProps, ...overrides },
  );
}

// --- Landing --------------------------------------------------------------

test("UI-006A: landing renders the grossed headline with a permanent estimate badge, cash/franking subtitle, dense metric rows, and a coverage link -- never a bare number with no explanation", () => {
  const html = renderLanding();
  assert.match(html, /\$600\.00/); // grossed headline figure
  assert.match(html, /Estimate · includes franking credits/);
  assert.match(html, /Cash \$480\.00 · Franking credits \$120\.00/);
  assert.match(html, /Explain this estimate/);
  assert.match(html, /Average per month/);
  assert.match(html, /\$50\.00/);
  assert.match(html, /Average per week/);
  assert.match(html, /\$11\.54/);
  assert.match(html, /Income % of portfolio value/);
  assert.match(html, />6%</);
  assert.match(html, /Coverage/);
  assert.match(
    html,
    /<a class="income-coverage-link" href="\/portfolio\/portfolio-a\/income\/assumptions">2 of 2<\/a>/,
  );
  // The "Explain this estimate" dialog is closed on initial render (matches
  // the established HoldingSheet/dialog pattern) -- no method text leaks
  // into the static markup before the pop-up is opened.
  assert.doesNotMatch(html, /<dialog/);
});

test("UI-006A: a portfolio with no holdings gets an explicit empty state, never a fabricated $0 projection", () => {
  const html = renderLanding({
    projection: { ...populatedProjection, status: "empty" },
  });
  assert.match(html, /No holdings yet/);
  assert.match(html, /Go to holdings/);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.doesNotMatch(html, /income-headline-figure/);
});

test("UI-006A: no dividend-forecast coverage is disclosed explicitly, never presented as a zero income figure", () => {
  const html = renderLanding({
    projection: {
      ...populatedProjection,
      breakdown: {
        status: "no_coverage",
        currencyCode: "AUD",
        totalGrossDecimal: null,
        totalCashDecimal: null,
        totalFrankingKnownDecimal: null,
        totalFrankingIncomplete: false,
        averagePerMonthDecimal: null,
        averagePerWeekDecimal: null,
        incomePercentOfValueDecimal: null,
        incomePercentOfValueStatus: "unavailable",
        includedSecurityCount: 0,
        excludedSecurities: [
          {
            portfolioSecurityId: "sec-1",
            symbol: "ABC",
            reason: "insufficient_history",
          },
        ],
        partialTtmSecurities: [],
        method: "no held security has a usable 12-month forecast",
      },
    },
  });
  assert.match(html, /Dividend income unavailable/);
  assert.match(html, /no held security has a usable 12-month forecast/);
  assert.match(html, /ABC: insufficient history/);
  assert.match(html, /Set dividend assumptions/);
  assert.doesNotMatch(html, /income-headline-figure/);
  assert.doesNotMatch(html, /\$0\.00/);
});

// --- Multi-year -------------------------------------------------------

test("UI-006A: multi-year table marks the current FY and projected rows distinctly in the row label itself (owner ruling 2026-08-22: the compact Source column is gone; DIV-003's source label -- actual/estimate/fy to date/projected -- stays accessible only via each row's detail dialog, never as a whole table column)", () => {
  const html = renderMultiYear();
  // UI-026 (B2): the caption now folds in the screen-level base-currency
  // statement ("AUD reporting values"), mirroring portfolio-shell.tsx's
  // "{homeCurrencyCode} reporting values" precedent.
  assert.match(
    html,
    /<caption>Financial-year income and portfolio value \(AUD reporting values\)<\/caption>/,
  );
  assert.doesNotMatch(html, /<th scope="col">Source<\/th>/);
  assert.doesNotMatch(html, /class="income-source"/);
  // current FY labelled distinctly in the row label itself, never
  // "actual"/"estimate", and never colour alone.
  assert.match(html, />FY26 \(to date\)</);
  // projected, visually distinguished (green class) AND labelled in text
  // (never colour alone) -- "(projected)" is part of the row label now
  // that the Source column is gone.
  assert.match(html, /class="income-row-projected"/);
  assert.match(html, /FY27 \(projected\)/);
});

test("UI-006A: every row is tappable via a real button (row-detail affordance) and past rows additionally link to an FY override", () => {
  const html = renderMultiYear();
  const triggerCount = (html.match(/class="income-row-trigger"/g) ?? []).length;
  assert.equal(triggerCount, 4); // 2 past + 1 current + 1 projected row
  assert.match(
    html,
    /<button type="button" class="income-row-trigger">FY25<\/button>/,
  );
  // Past/current rows render inside the shared closed dialog on initial
  // render (matches the HoldingSheet pattern) -- source-verified instead,
  // since no row is pre-selected.
  assert.doesNotMatch(html, /<dialog/);
});

test("UI-006A: one assumption summary line states yield includes franking and names both growth assumptions", () => {
  const html = renderMultiYear();
  assert.match(
    html,
    /<p class="income-assumption-summary">Yield is TOTAL yield, including franking credits\. Portfolio value compounds at 5%\/yr; dividend yield compounds at 0%\/yr for projected years\.<\/p>/,
  );
});

test("UI-006A: what-if is two plain number inputs with Apply/Reset, no slider, and no 'applied' marker until Apply runs", () => {
  const html = renderMultiYear();
  assert.match(html, /Portfolio growth % \/ yr/);
  assert.match(html, /Dividend growth % \/ yr/);
  const numberInputCount = (html.match(/type="number"/g) ?? []).length;
  assert.equal(numberInputCount, 2);
  assert.doesNotMatch(html, /type="range"/);
  assert.match(html, />Apply<\/button>/);
  assert.match(html, />Reset<\/button>/);
  assert.doesNotMatch(html, /Applied, not saved/);
});

test("UI-006A: range controls are years-back/years-forward <select>s (no slider) defaulting to 2 back / 4 forward with 0-10 / 1-10 bounds", async () => {
  const [defaultsHtml, source] = [
    renderComponent(
      "IncomeMultiYear",
      "../app/components/income-multi-year.tsx",
      { ...populatedMultiYearProps, yearsBack: 2, yearsForward: 4 },
    ),
    await readFile(
      new URL("../app/components/income-multi-year.tsx", import.meta.url),
      "utf8",
    ),
  ];
  assert.match(defaultsHtml, /name="yearsBack"/);
  assert.match(defaultsHtml, /name="yearsForward"/);
  assert.match(defaultsHtml, /<option value="2" selected="">2<\/option>/);
  assert.match(defaultsHtml, /<option value="4" selected="">4<\/option>/);
  // 0-10 inclusive for years back, 1-10 inclusive for years forward.
  assert.match(defaultsHtml, /<option value="0">0<\/option>/);
  assert.match(defaultsHtml, /<option value="10">10<\/option>/);
  assert.match(defaultsHtml, /<option value="1">1<\/option>/);
  assert.doesNotMatch(defaultsHtml, /type="range"/);
  assert.match(source, /method="get"/);

  const pageSource = await readFile(
    new URL(
      "../app/portfolio/[portfolioId]/income/multi-year/page.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(pageSource, /from "\.\.\/\.\.\/\.\.\/\.\.\/income-year-range"/);
  assert.equal(DEFAULT_YEARS_BACK, 2);
  assert.equal(DEFAULT_YEARS_FORWARD, 4);
  assert.equal(MAX_YEARS, 10);
});

test("UI-006A: clampYears is behaviourally exercised (beyond source greps) -- out-of-range, negative, and unparseable query values all degrade to a safe in-bounds default", () => {
  // ?yearsForward=99 clamps to the MAX_YEARS ceiling, never passed through
  // to the service uncapped.
  assert.equal(clampYears("99", DEFAULT_YEARS_FORWARD, 1), MAX_YEARS);
  // ?yearsBack=-3 clamps up to the minimum (0), never a negative range.
  assert.equal(clampYears("-3", DEFAULT_YEARS_BACK, 0), 0);
  // ?yearsBack=abc (unparseable) falls back to the documented default,
  // never NaN or 0-by-accident.
  assert.equal(clampYears("abc", DEFAULT_YEARS_BACK, 0), DEFAULT_YEARS_BACK);
  // A missing query value also falls back to the default.
  assert.equal(
    clampYears(undefined, DEFAULT_YEARS_FORWARD, 1),
    DEFAULT_YEARS_FORWARD,
  );
  // An in-bounds integer string passes through unchanged.
  assert.equal(clampYears("6", DEFAULT_YEARS_BACK, 0), 6);
  // Number.parseInt truncates a decimal query value to its integer prefix
  // (documented parseInt behaviour), then clamps normally -- not a fallback.
  assert.equal(clampYears("3.9", DEFAULT_YEARS_BACK, 0), 3);
});

test("UI-006A: a degraded forward projection is disclosed as an explicit warning banner, not silently rendered as an empty or zeroed projected row", () => {
  const html = renderMultiYear({
    multiYear: { ok: false, reason: "no_yield_coverage" },
    multiYearBaselineInput: null,
  });
  assert.match(html, /Forward projection unavailable/);
  assert.match(
    html,
    /No held security has a resolved dividend yield, so forward years cannot be projected\./,
  );
  assert.doesNotMatch(html, /class="income-row-projected"/);
});

test("UI-006A: a degraded past-FY or current-FY computation is disclosed as its own explicit banner, never silently collapsed to an empty table with no explanation (follow-up 1)", () => {
  const pastDegradedHtml = renderMultiYear({
    pastFinancialYears: { ok: false, reason: "invalid_years" },
  });
  assert.match(pastDegradedHtml, /Past financial years unavailable/);
  assert.match(pastDegradedHtml, /requested years-back range is invalid/);
  // The current-FY and projected rows still render -- only the past rows
  // are missing.
  assert.match(pastDegradedHtml, /FY26 \(to date\)/);
  assert.doesNotMatch(pastDegradedHtml, /FY25/);

  const currentDegradedHtml = renderMultiYear({
    currentFinancialYear: { ok: false, reason: "invalid_start_month" },
  });
  assert.match(currentDegradedHtml, /Current financial year unavailable/);
  assert.doesNotMatch(currentDegradedHtml, /\(to date\)/);
});

// --- B1: what-if recompute path and the assumption summary -------------

test("B1: applying a what-if recomputes forward rows via the REAL projectMultiYearIncomeWhatIf (not a source grep), and the rendered summary/value cells reflect the ACTIVE (applied) assumptions, never the stale saved growth rates", () => {
  // Exercise the exact recompute path `applyWhatIf()` calls: the same pure
  // function, the same baseline input the service would hand the
  // component, with 8%/3% overrides over the saved 5%/0%.
  const appliedResult = projectMultiYearIncomeWhatIf(multiYearBaselineInput, {
    valueGrowthPercentDecimal: "8",
    dividendGrowthPercentDecimal: "3",
  });
  assert.equal(appliedResult.ok, true);
  if (!appliedResult.ok) throw new Error("unreachable");
  assert.equal(appliedResult.assumptions.valueGrowthPercentDecimal, "8");
  assert.equal(appliedResult.assumptions.valueGrowthSource, "what_if");
  assert.equal(appliedResult.assumptions.dividendGrowthPercentDecimal, "3");
  assert.equal(appliedResult.assumptions.dividendGrowthSource, "what_if");
  // The recomputed row genuinely differs from the 5%/0% baseline row (not
  // an untouched copy).
  assert.notEqual(
    appliedResult.rows[0].valueDecimal,
    baselineMultiYear.rows[0].valueDecimal,
  );

  // Render with this REAL recomputed result as the active projection --
  // exactly what `IncomeMultiYear` shows once `whatIfApplied` is true and
  // `whatIfResult` holds this value. The saved-props growth percentages
  // (5%/0%) are deliberately left unchanged here to prove the summary does
  // NOT fall back to them.
  const html = renderMultiYear({ multiYear: appliedResult });
  assert.match(html, /compounds at 8%\/yr \(what-if\)/);
  assert.match(html, /compounds at 3%\/yr \(what-if\)/);
  assert.doesNotMatch(html, /compounds at 5%\/yr(?! \(what-if\))/);
  assert.doesNotMatch(html, /compounds at 0%\/yr(?! \(what-if\))/);
  // The recomputed projected row's own value/gross figures are shown too.
  assert.match(
    html,
    new RegExp(
      `FY27[\\s\\S]{0,400}${appliedResult.rows[0].grossDividendDecimal.replace(".", "\\.")}`,
    ),
  );
});

// --- B2: partial-value disclosure on the visible surface ----------------

test("B2: a partial current portfolio value is disclosed as a non-colour '· partial' marker on BOTH the current-year and projected value cells, and in the assumption summary -- not only inside the row-detail dialog", () => {
  const html = renderMultiYear({
    currentFinancialYear: {
      ok: true,
      row: { ...currentFinancialYearRow, valueStatus: "partial" },
    },
    multiYear: {
      ...baselineMultiYear,
      assumptions: {
        ...multiYearAssumptions,
        currentPortfolioValueStatus: "partial",
      },
    },
  });
  // Current-year row value cell.
  assert.match(html, /FY26 \(to date\)[\s\S]{0,600}· partial/);
  // Projected row value cell (the forward projection compounds off the
  // SAME partial base for every year).
  assert.match(html, /FY27[\s\S]{0,600}· partial/);
  // The one assumption summary line also discloses it.
  assert.match(
    html,
    /Projected years are based on a partial \(understated\) current portfolio value -- some holdings are unpriced\./,
  );
  // Past rows (never partial in DIV-003's model -- historical snapshots are
  // exact) carry no such marker.
  assert.doesNotMatch(html, /FY25[\s\S]{0,200}· partial/);
});

test("B2: no partial-value marker or disclosure appears when the current portfolio value is fully available", () => {
  const html = renderMultiYear();
  assert.doesNotMatch(html, /· partial/);
  assert.doesNotMatch(html, /partial \(understated\)/);
});

// --- Follow-up 2: editing an input after Apply clears the stale marker --

test("follow-up 2: editing either growth input after Apply clears whatIfApplied/whatIfResult so the table cannot keep showing a what-if projection for inputs that no longer match it", async () => {
  const component = await readFile(
    new URL("../app/components/income-multi-year.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    component,
    /function updateValueGrowthInput[\s\S]{0,400}if \(whatIfApplied\) \{\s*setWhatIfApplied\(false\);\s*setWhatIfResult\(null\);/,
  );
  assert.match(
    component,
    /function updateDividendGrowthInput[\s\S]{0,400}if \(whatIfApplied\) \{\s*setWhatIfApplied\(false\);\s*setWhatIfResult\(null\);/,
  );
  // Both number inputs are wired to the clearing setters, not the raw
  // useState setters directly.
  assert.match(component, /onChange={\(event\) =>\s*updateValueGrowthInput/);
  assert.match(component, /onChange={\(event\) =>\s*updateDividendGrowthInput/);
});

// --- What-if non-persistence -----------------------------------------

test("UI-006A: the what-if overlay recomputes CLIENT-SIDE via the pure domain projector -- no server action, fetch, or mutation route backs it, so it is unpersisted by construction", async () => {
  const [component, ownedIncomeProjectionRoute] = await Promise.all([
    readFile(
      new URL("../app/components/income-multi-year.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/owned-income-projection.ts", import.meta.url),
      "utf8",
    ),
  ]);
  // Imports the WHAT-IF projector from the pure domain module (no
  // SqlClient import anywhere in that file per its own module header),
  // never the owner-scoped service wrapper -- nothing reachable from this
  // client component can write to storage.
  assert.match(component, /from "..\/..\/domain\/dividends\/projection\.ts"/);
  assert.doesNotMatch(component, /from "\.\.\/owned-income-projection/);
  assert.doesNotMatch(component, /fetch\(/);
  assert.doesNotMatch(component, /mutation-request/);
  assert.doesNotMatch(component, /"use server"/);
  assert.match(
    ownedIncomeProjectionRoute,
    /Nothing in this file writes to storage/,
  );
});

test("UI-006A: no API route exists for the what-if overlay (nothing to persist it)", async () => {
  await assert.rejects(
    readFile(
      new URL("../app/api/income/whatif/route.ts", import.meta.url),
      "utf8",
    ),
  );
  await assert.rejects(
    readFile(new URL("../app/income-actions.ts", import.meta.url), "utf8"),
  );
});

// --- Route ownership / no-store ---------------------------------------

test("UI-006A: both Income routes load via the owner-scoped context, deny an unowned portfolio through loadOwnedIncomeProjection's own re-check, and are force-dynamic", async () => {
  const [landingPage, multiYearPage, service] = await Promise.all([
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/income/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/income/multi-year/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../app/owned-income-projection.ts", import.meta.url),
      "utf8",
    ),
  ]);
  for (const page of [landingPage, multiYearPage]) {
    assert.match(page, /export const dynamic = "force-dynamic"/);
    assert.match(page, /loadAuthenticatedWorkspace\(portfolioId\)/);
    assert.match(page, /getAuthenticatedSqlContext\(portfolioId\)/);
    assert.match(page, /loadOwnedIncomeProjection\(/);
    assert.match(page, /workspace\.activePortfolio === null\) notFound\(\)/);
  }
  assert.match(
    service,
    /SELECT id FROM portfolios WHERE id = \? AND user_id = \?/,
  );
  assert.match(service, /if \(!portfolio\) throw new Error\("not_owned"\)/);
});

test("UI-016 (supersedes follow-up 3): the landing page now requests real past-FY history (5 back / 1 forward), since it renders pastFinancialYears; multiYear/currentFinancialYear are still unused and not fetched wider than necessary", async () => {
  const [landingPage, landingComponent] = await Promise.all([
    readFile(
      new URL(
        "../app/portfolio/[portfolioId]/income/page.tsx",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(
      new URL("../app/components/income-landing.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(
    landingPage,
    /loadOwnedIncomeProjection\(\s*context\.client,\s*context\.userId,\s*portfolioId,\s*new Date\(\),\s*\{ yearsBack: 5, yearsForward: 1 \}/,
  );
  // UI-016: IncomeLanding now DOES read pastFinancialYears (the past-FY
  // table this task added) -- multiYear/currentFinancialYear remain
  // unused by this screen (the multi-year sub-page owns those), so the
  // fetched range stays as narrow as the screen's real needs allow.
  assert.match(landingComponent, /projection\.pastFinancialYears/);
  assert.doesNotMatch(landingComponent, /projection\.multiYear/);
  assert.doesNotMatch(landingComponent, /projection\.currentFinancialYear/);
});

test("UI-006A: private-cache coverage already applies to /portfolio/* (no route-specific header needed), and the matrix records the new routes", async () => {
  const [responseSecurity, matrix] = await Promise.all([
    readFile(
      new URL("../worker/response-security.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(responseSecurity, /pathname\.startsWith\("\/portfolio\/"\)/);
  assert.match(matrix, /\/portfolio\/:id\/income/);
  assert.match(matrix, /\/portfolio\/:id\/income\/multi-year/);
  assert.match(matrix, /tests\/ui-006a\.test\.ts/);
});

// --- Accessibility (QA-001B pattern) -----------------------------------

test("UI-006A: Income interactive controls meet the 44x44 CSS-pixel touch-target minimum", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  for (const selector of [
    ".subnav-tabs a,\n.subnav-tabs span",
    ".income-explain-link",
    ".income-coverage-link",
    ".income-row-trigger",
    ".income-whatif-inputs input",
    ".income-whatif-actions button",
    ".income-range-controls select,\n.income-range-controls button",
  ]) {
    const block = extractBlock(styles, selector);
    assert.match(
      block,
      /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/,
      `${selector} must declare min-height >= 44px`,
    );
  }
});

test("UI-006A: the income view tabs use aria-current (keyboard-operable route links), and status text never relies on colour alone", () => {
  const landingHtml = renderLanding();
  assert.match(landingHtml, /aria-current="page"/);
  const multiYearHtml = renderMultiYear();
  assert.match(multiYearHtml, /aria-current="page"/);
  // Franking-incomplete / partial-value disclosures carry explicit text
  // (via the shared ".unavailable" text-colour class, never a bare colour
  // swap with no textual label).
  const partialHtml = renderLanding({
    projection: {
      ...populatedProjection,
      breakdown: {
        ...populatedProjection.breakdown,
        totalFrankingIncomplete: true,
        incomePercentOfValueStatus: "partial",
      },
    },
  });
  assert.match(partialHtml, /franking partially unknown/);
  assert.match(partialHtml, /partial value/);
});

test("UI-006A: the FY table scrolls inside its own container instead of overflowing at 320px", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const wrap = extractBlock(styles, ".income-fy-table-wrap");
  assert.match(wrap, /overflow-x:\s*auto/);
  const table = extractBlock(styles, ".income-fy-table");
  assert.match(table, /min-width:\s*\d/);
  const screen = extractBlock(styles, ".income-screen");
  assert.doesNotMatch(screen, /overflow-x:\s*(?!auto|hidden)/);
});

test("UI-006A: the Income tab only appears in owned mode, pointing at the standalone route (no preview/fixture parity claimed)", async () => {
  const shell = await readFile(
    new URL("../app/components/portfolio-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(shell, /ownedMode && ownedWorkspace\.activePortfolio \? \(/);
  assert.match(
    shell,
    /href={`\/portfolio\/\$\{ownedWorkspace\.activePortfolio\.id\}\/income`}/,
  );
});
