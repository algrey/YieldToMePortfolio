import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CGT_CARRY_FORWARD_NOTE,
  CGT_METHOD_LABELS,
  computeLifetimeCapitalGainsTotal,
  type CapitalGainDisposalRow,
  type FyCapitalGainsTotal,
} from "../domain/gains/index.ts";
import { formatIncomeMoney } from "../app/income-format.ts";

// CGT-001B: the Capital gains screen -- the Income area's third tab.
// Rendered assertions use the same `tsx`-loader child-process render trick
// as `tests/ui-006a.test.ts`/`tests/qa-001b.test.ts`, since this component
// lives outside the PortfolioShell dual-mode render path.

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

// --- Fixtures ------------------------------------------------------------

const rowDiscountEligible: CapitalGainDisposalRow = {
  allocationId: "alloc-a",
  portfolioSecurityId: "ps-alpha",
  securitySymbol: "ALPHA",
  securityName: "Alpha Holdings Ltd",
  acquiredDate: "2022-01-10",
  disposedDate: "2026-02-01",
  quantityDecimal: "100",
  proceedsDecimal: "1600.00",
  basisDecimal: "600.00",
  feeDecimal: "0",
  taxDecimal: "0",
  gainDecimal: "1000.00",
  basisStatus: "complete",
  holdingPeriodEligible: true,
  discountThresholdDate: "2023-01-11",
  eligibility: "discount_eligible",
};

const rowNonDiscount: CapitalGainDisposalRow = {
  allocationId: "alloc-b",
  portfolioSecurityId: "ps-beta",
  securitySymbol: "BETA",
  securityName: "Beta Resources Ltd",
  acquiredDate: "2024-09-01",
  disposedDate: "2025-03-01",
  quantityDecimal: "50",
  proceedsDecimal: "700.00",
  basisDecimal: "500.00",
  feeDecimal: "0",
  taxDecimal: "0",
  gainDecimal: "200.00",
  basisStatus: "complete",
  holdingPeriodEligible: false,
  discountThresholdDate: "2025-09-01",
  eligibility: "discount_ineligible",
};

const rowLoss: CapitalGainDisposalRow = {
  allocationId: "alloc-c",
  portfolioSecurityId: "ps-delta",
  securitySymbol: "DELTA",
  securityName: "Delta Mining Co",
  acquiredDate: "2020-05-01",
  disposedDate: "2025-01-15",
  quantityDecimal: "20",
  proceedsDecimal: "150.00",
  basisDecimal: "500.00",
  feeDecimal: "0",
  taxDecimal: "0",
  gainDecimal: "-350.00",
  basisStatus: "complete",
  holdingPeriodEligible: true,
  discountThresholdDate: "2021-05-01",
  eligibility: "not_applicable_loss",
};

const rowIncomplete: CapitalGainDisposalRow = {
  allocationId: "alloc-d",
  portfolioSecurityId: "ps-gamma",
  securitySymbol: "GAMMA",
  securityName: "Gamma Pty Ltd",
  acquiredDate: "2019-06-01",
  disposedDate: "2025-05-20",
  quantityDecimal: "10",
  proceedsDecimal: null,
  basisDecimal: null,
  feeDecimal: null,
  taxDecimal: null,
  gainDecimal: null,
  basisStatus: "incomplete_basis",
  holdingPeriodEligible: true,
  discountThresholdDate: "2020-06-01",
  eligibility: "unknown_incomplete_basis",
};

const fy2026: FyCapitalGainsTotal = {
  endingYear: 2026,
  label: "FY26",
  window: { startDate: "2025-07-01", endDate: "2026-06-30" },
  rows: [rowDiscountEligible],
  disposalCount: 1,
  excludedIncompleteCount: 0,
  excludedIncompleteSecurityNames: [],
  partialCoverage: false,
  totalDiscountableGainsGrossDecimal: "1000.00",
  totalNonDiscountableGainsGrossDecimal: "0",
  totalLossesDecimal: "0",
  lossAppliedToNonDiscountableDecimal: "0",
  lossAppliedToDiscountableDecimal: "0",
  remainingNonDiscountableAfterLossDecimal: "0",
  remainingDiscountableAfterLossDecimal: "1000.00",
  discountRateDecimal: "0.50",
  discountAppliedDecimal: "500.00",
  netCapitalGainEstimateDecimal: "500.00",
  unabsorbedLossDecimal: "0",
};

const fy2025: FyCapitalGainsTotal = {
  endingYear: 2025,
  label: "FY25",
  window: { startDate: "2024-07-01", endDate: "2025-06-30" },
  rows: [rowNonDiscount, rowLoss, rowIncomplete],
  disposalCount: 3,
  excludedIncompleteCount: 1,
  excludedIncompleteSecurityNames: ["Gamma Pty Ltd"],
  partialCoverage: true,
  totalDiscountableGainsGrossDecimal: "0",
  totalNonDiscountableGainsGrossDecimal: "200.00",
  totalLossesDecimal: "350.00",
  lossAppliedToNonDiscountableDecimal: "200.00",
  lossAppliedToDiscountableDecimal: "0",
  remainingNonDiscountableAfterLossDecimal: "0",
  remainingDiscountableAfterLossDecimal: "0",
  discountRateDecimal: "0.50",
  discountAppliedDecimal: "0",
  netCapitalGainEstimateDecimal: "0",
  unabsorbedLossDecimal: "150.00",
};

const populatedHistory = {
  today: "2026-08-14",
  financialYearStartMonth: 7,
  baseCurrencyCode: "AUD",
  disposalCount: 4,
  fyTotals: [fy2026, fy2025],
  // CGT-002: equal to fy2025's (the earliest FY's) window.startDate, so the
  // carry chain's history-completeness predicate is satisfied on its own --
  // this fixture's carried figures are still tainted, but via fy2025's OWN
  // `partialCoverage: true` (the Gamma allocation), not via a
  // history-completeness gap. That keeps the two taint sources
  // independently testable (history-incompleteness is covered by
  // `tests/cgt-002.test.ts` instead).
  historyCompleteFrom: "2024-07-01",
  // CGT-004: unused whenever historyCompleteFrom is set (it always wins) --
  // present anyway so this fixture matches the real OwnedCapitalGainsHistory
  // shape honestly.
  earliestTradeDate: null,
};

const screenProps = {
  // UI-022: the Income sub-tab hrefs are derived from `portfolioId` inside
  // the shared `IncomeNav`, so the screen no longer takes per-tab hrefs.
  portfolioId: "portfolio-a",
  holdingsHref: "/portfolio/portfolio-a/holdings",
  result: { status: "ok", history: populatedHistory },
};

function renderScreen(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "CapitalGainsScreen",
    "../app/components/capital-gains-screen.tsx",
    { ...screenProps, ...overrides },
  );
}

// `dialogRef` only needs to be ref-SHAPED for a static render (no effect
// ever runs, so `.current` is never dereferenced); `onClose` is omitted --
// JSON.stringify drops the missing function prop entirely, which is
// harmless for a static render exactly like every other dialog test in
// this suite (ui-006a.test.ts's `renderMultiYear`/`renderLanding` never
// pass a real close handler either).
function renderFyDetailDialog(fy: FyCapitalGainsTotal, currencyCode = "AUD") {
  return renderComponent(
    "FyDetailDialog",
    "../app/components/capital-gains-screen.tsx",
    { fy, currencyCode, dialogRef: { current: null } },
  );
}

// --- Domain: lifetime rollup ----------------------------------------------

test("CGT-001B: the lifetime rollup purely sums each FY's own already-standalone figures (no carry-forward, no recomputation)", () => {
  const lifetime = computeLifetimeCapitalGainsTotal([fy2026, fy2025]);
  assert.equal(lifetime.fyCount, 2);
  assert.equal(lifetime.disposalCount, 4);
  assert.equal(lifetime.excludedIncompleteCount, 1);
  assert.deepEqual(lifetime.excludedIncompleteSecurityNames, ["Gamma Pty Ltd"]);
  assert.equal(lifetime.partialCoverage, true);
  assert.equal(lifetime.totalDiscountableGainsGrossDecimal, "1000");
  assert.equal(lifetime.totalNonDiscountableGainsGrossDecimal, "200");
  assert.equal(lifetime.totalLossesDecimal, "350");
  assert.equal(lifetime.totalUnabsorbedLossDecimal, "150");
  assert.equal(lifetime.netCapitalGainEstimateDecimal, "500");
});

test("CGT-001B: an empty FY list rolls up to an all-zero, empty lifetime summary rather than throwing", () => {
  const lifetime = computeLifetimeCapitalGainsTotal([]);
  assert.equal(lifetime.fyCount, 0);
  assert.equal(lifetime.disposalCount, 0);
  assert.equal(lifetime.partialCoverage, false);
  assert.equal(lifetime.netCapitalGainEstimateDecimal, "0");
  assert.deepEqual(lifetime.excludedIncompleteSecurityNames, []);
});

// --- Display-rounding decision --------------------------------------------

test("CGT-001B: a discount landing on an exact half-cent rounds the same way every other money figure in the app already does (2dp, round-half-even), never a fabricated extra cent", () => {
  // 0 is the even digit -- ROUND_HALF_EVEN rounds x.xx5 DOWN when the
  // preceding digit is even, exactly like `formatDecimalFixed` everywhere
  // else in the app (see `domain/calculations/decimal.ts`). This is the
  // documented display-rounding decision (capital-gains-screen.tsx header
  // comment / CALCULATIONS.md section 14): no CGT-specific rounding
  // convention is introduced.
  assert.equal(formatIncomeMoney("AUD", "AUD", "50.505"), "$50.50");
  // 1 is odd -- rounds UP to the even 2.
  assert.equal(formatIncomeMoney("AUD", "AUD", "50.515"), "$50.52");
});

// --- Populated table --------------------------------------------------------

test("CGT-001B: the FY table renders columns in order (year, discountable, non-discountable, losses, net estimate, method, coverage) with honest money figures", () => {
  const html = renderScreen();
  assert.match(
    html,
    /<th scope="col">Year<\/th>[\s\S]*Discountable gains[\s\S]*Non-discountable gains[\s\S]*Losses[\s\S]*Net estimate[\s\S]*Method[\s\S]*Coverage/,
  );
  assert.match(html, /FY26/);
  assert.match(html, /FY25/);
  assert.match(html, /\$1,000\.00/); // FY26 discountable gross
  // CGT-002: the "Net estimate" column is now the carried (true) figure --
  // FY26's own standalone net was 500.00, but FY25's $150 unabsorbed loss
  // carries in first (non-discountable gains, then discountable, before
  // the discount): 1000.00 - 150.00 = 850.00 discountable remaining,
  // 50% discount = 425.00.
  assert.match(html, /\$425\.00/); // FY26 net estimate (carried, true)
  assert.match(html, /\$200\.00/); // FY25 non-discountable gross
  assert.match(html, /\$350\.00/); // FY25 losses
});

test("CGT-001B: an unabsorbed loss is disclosed on its FY row, and the per-FY detail dialog echoes the carry-forward note (source-verified)", async () => {
  const html = renderScreen();
  assert.match(html, /\$150\.00.*unabsorbed/);
  const source = await readFile(
    new URL("../app/components/capital-gains-screen.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /CGT_CARRY_FORWARD_NOTE/);
});

// Reviewer finding (B2): the standing carry-forward note is the ONE thing
// that explains why "Lifetime net capital gain estimate" is a carried,
// chained figure rather than a plain per-FY sum (CGT-002:
// `domain/gains/carry-forward.ts`'s header). A source-only assertion
// cannot catch its `<p>` being deleted; this asserts the note's REAL text
// is present in the populated render AND appears before the lifetime net
// line, so it reads as a caveat over that figure rather than an unrelated
// aside below it.
test("CGT-001B: the standing carry-forward note is rendered on the populated screen, before the lifetime net capital gain estimate line", () => {
  const html = renderScreen();
  const noteIndex = html.indexOf(CGT_CARRY_FORWARD_NOTE);
  const lifetimeNetIndex = html.indexOf("Lifetime net capital gain estimate");
  assert.notEqual(
    noteIndex,
    -1,
    "expected CGT_CARRY_FORWARD_NOTE's exact text in the rendered HTML",
  );
  assert.notEqual(
    lifetimeNetIndex,
    -1,
    "expected the 'Lifetime net capital gain estimate' line in the rendered HTML",
  );
  assert.ok(
    noteIndex < lifetimeNetIndex,
    "the carry-forward note must appear before the lifetime net capital gain estimate line, so it reads as a caveat on that figure",
  );
});

test("CGT-001B: a partial-coverage FY names its excluded security by name, never a bare count with no explanation", () => {
  const html = renderScreen();
  assert.match(html, /Partial · 1 excluded/);
});

test("CGT-001B: the lifetime summary sums the fixture's two FYs and names the excluded security lifetime-wide", () => {
  const html = renderScreen();
  assert.match(html, /Lifetime discountable gains/);
  assert.match(html, /Lifetime non-discountable gains/);
  assert.match(html, /Lifetime losses/);
  assert.match(html, /Lifetime net capital gain estimate/);
  // CGT-002: the lifetime net line is now the TRUE, carried whole-period
  // net (sum of each FY's own carried net -- fy2025's carried net is 0,
  // fy2026's is 425.00, see the FY-table test above), not the old
  // standalone sum of 500.00. fy2025's partial coverage taints the whole
  // chain from that point forward, so this figure MUST carry the "*"
  // marker -- reviewer fix (follow-up 2): the marker was previously
  // optional in this regex, which would have silently passed even if the
  // taint propagation broke (regression-blind).
  assert.match(html, /\$425\.00<span[^>]*> \*<\/span><\/dd>/); // lifetime net estimate row, tainted
  assert.match(html, /4 across 2 financial years/);
  assert.match(html, /Gamma Pty Ltd/);
});

test("CGT-001B: allocation counts are always labelled 'lot matches', never bare 'disposals' (CGT-001A's disposalCount counts allocations, not sales)", () => {
  const html = renderScreen();
  assert.match(html, /Lot matches/);
  assert.doesNotMatch(html, />\s*4 disposals\s*</);
  assert.doesNotMatch(html, /Disposals</);
});

test("CGT-001B: the standing 'informational only -- not tax advice' note is always visible on the populated screen, as plain text (non-colour)", () => {
  const html = renderScreen();
  assert.match(
    html,
    /Informational only — not tax advice\.<\/strong> Consult a\s*registered tax agent/,
  );
});

test("CGT-001B: every FY row is a real, tappable button (row-detail affordance), and the detail dialog is closed on initial render (source-verified instead, matching UI-006A's HoldingSheet pattern)", () => {
  const html = renderScreen();
  const triggerCount = (html.match(/class="income-row-trigger"/g) ?? []).length;
  assert.equal(triggerCount, 2); // one button per FY row
  assert.match(
    html,
    /<button type="button" class="income-row-trigger">FY26<\/button>/,
  );
  assert.doesNotMatch(html, /<dialog/);
});

// --- Empty and degraded states ---------------------------------------------

test("CGT-001B: a portfolio with zero disposals gets an explicit 'No disposals yet' empty state, never a fabricated $0 table", () => {
  const html = renderScreen({
    result: {
      status: "ok",
      history: { ...populatedHistory, disposalCount: 0, fyTotals: [] },
    },
  });
  assert.match(html, /No disposals yet/);
  assert.match(html, /Go to holdings/);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.doesNotMatch(html, /<table/);
  // The standing disclaimer still appears on the empty state.
  assert.match(html, /Informational only/);
});

test("CGT-001B: an unpublished calculation run gets distinct copy from a missing-dates failure and from the generic fallback -- never the same message for different failures", () => {
  const unpublished = renderScreen({
    result: { status: "unavailable", reason: "unpublished" },
  });
  const missingDates = renderScreen({
    result: { status: "unavailable", reason: "missing_dates" },
  });
  const generic = renderScreen({
    result: { status: "unavailable", reason: "error" },
  });
  assert.match(unpublished, /not published yet/);
  assert.match(missingDates, /missing the acquisition or disposal dates/);
  assert.match(generic, /Capital gains are unavailable/);
  assert.notEqual(unpublished, missingDates);
  assert.notEqual(missingDates, generic);
  assert.notEqual(unpublished, generic);
  // No degraded state ever fabricates a $0 figure.
  for (const html of [unpublished, missingDates, generic]) {
    assert.doesNotMatch(html, /\$0\.00/);
    assert.doesNotMatch(html, /<table/);
  }
});

test("CGT-001B: page.tsx maps every documented read-service failure string to the correct distinct reason (source-verified)", async () => {
  const source = await readFile(
    new URL("../app/portfolio/[portfolioId]/gains/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /missing_projection_publication/);
  assert.match(source, /invalid_projection_publication/);
  assert.match(source, /invalid_projection_publication_count/);
  assert.match(source, /missing_allocation_dates/);
  assert.match(source, /invalid_allocation_dates:/);
  assert.match(source, /reason: "unpublished"/);
  assert.match(source, /reason: "missing_dates"/);
  assert.match(source, /reason: "error"/);
});

// --- Dialog pattern (source-verified, matches UI-006A's established
// ref+showModal pattern) ----------------------------------------------------

test("CGT-001B: the FY detail dialog follows the established ref+showModal pattern with opener-capture focus restoration, and never fetches (UI-008's in-flight-fetch timeout does not apply to a purely presentational dialog)", async () => {
  const source = await readFile(
    new URL("../app/components/capital-gains-screen.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /dialog\.showModal\(\)/);
  assert.match(
    source,
    /querySelector<HTMLButtonElement>\(".sheet-close"\)\?\.focus\(\)/,
  );
  assert.match(
    source,
    /onCancel=\{\(event\) => \{\s*event\.preventDefault\(\);\s*dialogRef\.current\?\.close\(\);/,
  );
  assert.match(source, /rowOpenerRef\.current\.focus\(\);/);
  assert.match(source, /aria-labelledby="gains-fy-title"/);
  // Purely presentational -- no fetch, so no UI-008 timeout is needed.
  assert.doesNotMatch(source, /fetch\(/);
});

test("CGT-001B: the FY detail dialog lists every allocation row with an honest, human-readable eligibility label (never the raw enum value) and the same method labels the per-FY totals use", async () => {
  const source = await readFile(
    new URL("../app/components/capital-gains-screen.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /Discount eligible \(held over 12 months\)/);
  assert.match(source, /Discount ineligible \(held 12 months or less\)/);
  assert.match(source, /Loss — no discount applies/);
  assert.match(source, /No gain or loss/);
  assert.match(source, /Unknown — incomplete cost basis/);
  assert.match(source, /CGT_METHOD_LABELS\.discountableGains/);
  assert.match(source, /CGT_METHOD_LABELS\.nonDiscountableGains/);
  assert.match(source, /CGT_METHOD_LABELS\.losses/);
  assert.match(source, /CGT_METHOD_LABELS\.netCapitalGainEstimate/);
  assert.equal(CGT_METHOD_LABELS.netCapitalGainEstimate.includes("50%"), true);
});

// Follow-up (review round 1): the previous test above only source-grepped
// the eligibility/method label STRINGS -- it could not catch a wiring bug
// (e.g. the wrong row's eligibility rendered, or a null figure rendering
// as "Unavailable"/"$0" instead of "Unknown"). `FyDetailDialog` is exported
// specifically so this can render for real against `fy2025`'s fixture,
// which mixes a non-discount gain, a loss, and an incomplete-basis
// allocation in one FY.
test("CGT-001B: the FY detail dialog actually RENDERS honest eligibility labels, 'Unknown' (never a fabricated $0) for an incomplete-basis allocation's figures, formatted quantities, and the in-dialog unabsorbed-loss note", () => {
  const html = renderFyDetailDialog(fy2025);

  // Eligibility labels for the three real rows in fy2025 -- never the raw
  // enum value (`discount_ineligible`, `not_applicable_loss`,
  // `unknown_incomplete_basis`).
  assert.match(html, /Discount ineligible \(held 12 months or less\)/);
  assert.match(html, /Loss — no discount applies/);
  assert.match(html, /Unknown — incomplete cost basis/);

  // rowIncomplete (Gamma Pty Ltd, basisStatus: "incomplete_basis") has a
  // real, known quantity but every MONEY figure is genuinely unknown --
  // each renders "Unknown", never "Unavailable" and never a fabricated
  // "0.00". "Gamma Pty Ltd" also appears earlier as an excluded-security
  // name in the partial-coverage list, so this uses the LAST occurrence --
  // the actual allocation-table row -- not the first.
  const gammaIndex = html.lastIndexOf("Gamma Pty Ltd");
  assert.notEqual(gammaIndex, -1);
  const gammaRow = html.slice(gammaIndex, gammaIndex + 600);
  assert.equal((gammaRow.match(/Unknown/g) ?? []).length >= 4, true);
  assert.doesNotMatch(gammaRow, /\$0\.00/);

  // formatQuantity output for each allocation's real quantity (never a
  // fabricated 0, and no thousands-separator artefact on small numbers).
  assert.match(html, />50</); // Beta's 50-share allocation
  assert.match(html, />20</); // Delta's 20-share allocation
  assert.match(html, />10</); // Gamma's 10-share allocation

  // The in-dialog unabsorbed-loss note (now explicitly "standalone" -- the
  // carried figure lives in the dialog's separate "Carried" section) and
  // the same standing carry-forward note the screen level shows (CGT-002:
  // renamed from `CGT_CARRY_FORWARD_OUT_OF_SCOPE_NOTE`, since carry-forward
  // is no longer out of scope).
  assert.match(html, /Unabsorbed loss this year \(standalone\):/);
  assert.match(html, /\$150\.00/);
  assert.ok(
    html.includes(CGT_CARRY_FORWARD_NOTE),
    "expected the exact carry-forward note text inside the dialog",
  );
});

// --- Income sub-tab row ----------------------------------------------------

// UI-022 supersedes CGT-001B's original per-screen source assertions: the
// four Income sub-tabs are now rendered from ONE list in
// `app/components/income-nav.tsx`, so "Capital gains" cannot be present on
// one screen and absent from another. These assertions now pin that single
// source of truth plus this screen's own rendered output.
test("CGT-001B/UI-022: 'Capital gains' is one of the four shared Income sub-tabs, pointing at /portfolio/:id/gains", async () => {
  const navSource = await readFile(
    new URL("../app/components/income-nav.tsx", import.meta.url),
    "utf8",
  );
  assert.match(navSource, /label: "Capital gains"/);
  assert.match(navSource, /href: \(id\) => `\/portfolio\/\$\{id\}\/gains`/);
  for (const label of [
    "Next 12 months",
    "Multi-year",
    "Capital gains",
    "All dividends",
  ]) {
    assert.match(navSource, new RegExp(`label: "${label}"`));
  }
});

test("CGT-001B/UI-022: the Capital gains screen renders the shared tab row with itself current", () => {
  const gainsHtml = renderScreen();
  assert.match(gainsHtml, /Next 12 months/);
  assert.match(gainsHtml, /Multi-year/);
  assert.match(gainsHtml, /All dividends/);
  assert.match(gainsHtml, /aria-current="page">Capital gains<\/span>/);
  assert.match(gainsHtml, /href="\/portfolio\/portfolio-a\/income\/dividends"/);
});

test("UI-022: every Income screen renders the shared IncomeNav rather than its own tab markup", async () => {
  const sources = await Promise.all(
    [
      "../app/components/income-landing.tsx",
      "../app/components/income-multi-year.tsx",
      "../app/components/capital-gains-screen.tsx",
      "../app/components/owned-dividend-list.tsx",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  for (const source of sources) {
    assert.match(source, /<IncomeNav\b/);
    assert.doesNotMatch(source, /className="income-view-tabs"/);
  }
});

// --- Route ownership / no-store --------------------------------------------

test("CGT-001B: the gains route loads via the owner-scoped context, calls loadOwnedCapitalGains with the authenticated identity, and is force-dynamic", async () => {
  const pageSource = await readFile(
    new URL("../app/portfolio/[portfolioId]/gains/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(pageSource, /export const dynamic = "force-dynamic";/);
  assert.match(pageSource, /loadAuthenticatedWorkspace\(portfolioId\)/);
  assert.match(pageSource, /getAuthenticatedSqlContext\(portfolioId\)/);
  assert.match(
    pageSource,
    /loadOwnedCapitalGains\(\s*context\.client,\s*context\.userId,\s*portfolioId,\s*new Date\(\),\s*\)/,
  );
  assert.match(
    pageSource,
    /if \(workspace\.activePortfolio === null\) notFound\(\);/,
  );
});

test("CGT-001B: private-cache coverage already applies to /portfolio/* (no route-specific header needed), and the matrix records the new route", async () => {
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
  assert.match(matrix, /\/portfolio\/:id\/gains/);
  assert.match(matrix, /tests\/cgt-001b\.test\.ts/);
  assert.match(matrix, /\*\*10\*\* as of CGT-001B/);
});

// Extends the ui-006a/b/c self-checking citation grep to this task's own
// test file -- see `tests/ui-006c.test.ts:771-798`'s identical test for the
// full rationale (every matrix citation naming this file must quote a
// LITERAL substring of it, never a fabricated/paraphrased test title --
// review round 1 caught exactly this: a citation that dropped a clause
// from the real title).
test("CGT-001B: every matrix citation naming tests/cgt-001b.test.ts quotes a literal test title (grep -F self-check)", async () => {
  const [matrix, ownSource] = await Promise.all([
    readFile(
      new URL("../docs/QA-001A_SECURITY_MATRIX.md", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../tests/cgt-001b.test.ts", import.meta.url), "utf8"),
  ]);
  const citationGroupPattern =
    /`(tests\/cgt-001b\.test\.ts)`\s*((?:"(?:[^"\\]|\\.)*"(?:;\s*)?)+)/g;
  const quotedStringPattern = /"(?:[^"\\]|\\.)*"/g;
  let groupCount = 0;
  let titleCount = 0;
  for (const match of matrix.matchAll(citationGroupPattern)) {
    groupCount += 1;
    const titles = match[2]!.match(quotedStringPattern) ?? [];
    for (const quoted of titles) {
      titleCount += 1;
      const title = quoted.slice(1, -1);
      assert.ok(
        ownSource.includes(title),
        `matrix cites "${title}" in tests/cgt-001b.test.ts, but that title is not a literal substring of the file (fabricated/paraphrased citation)`,
      );
    }
  }
  assert.ok(groupCount >= 1, "expected at least 1 citation group to check");
  assert.ok(titleCount >= 1, "expected at least 1 quoted title to check");
});

// --- Accessibility (QA-001B pattern) ---------------------------------------

test("CGT-001B: reused interactive controls (row triggers, dialog close) meet the 44x44 CSS-pixel touch-target minimum", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  for (const selector of [".income-row-trigger", ".sheet-close"]) {
    const block = extractBlock(styles, selector);
    assert.match(
      block,
      /min-height:\s*(4[4-9]|[5-9]\d|\d{3,})px/,
      `${selector} must declare min-height >= 44px`,
    );
  }
});

test("CGT-001B: the FY table and its dialog's allocation table both scroll inside their own container instead of overflowing at 320px", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const wrap = extractBlock(styles, ".income-fy-table-wrap");
  assert.match(wrap, /overflow-x:\s*auto/);
  const table = extractBlock(styles, ".income-fy-table");
  assert.match(table, /min-width:\s*\d/);
  const allocationTable = extractBlock(styles, ".gains-allocation-table");
  assert.match(allocationTable, /min-width:\s*\d/);
  const screen = extractBlock(styles, ".income-screen");
  assert.doesNotMatch(screen, /overflow-x:\s*(?!auto|hidden)/);
});

test("CGT-001B: the tab row uses aria-current for the active view (keyboard-operable route links), consistent across all three states", () => {
  const ok = renderScreen();
  const empty = renderScreen({
    result: {
      status: "ok",
      history: { ...populatedHistory, disposalCount: 0, fyTotals: [] },
    },
  });
  const unavailable = renderScreen({
    result: { status: "unavailable", reason: "error" },
  });
  for (const html of [ok, empty, unavailable]) {
    assert.match(html, /aria-current="page"/);
  }
});

test("CGT-001B: no rounded corners -- the dialog and disclaimer match the app's flat visual language", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );
  const disclaimer = extractBlock(styles, ".gains-disclaimer");
  assert.match(disclaimer, /border-radius:\s*0/);
});
