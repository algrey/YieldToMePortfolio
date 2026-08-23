import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  buildCapitalGainsDisplayRows,
  CAPITAL_GAINS_DISPLAY_YEARS,
} from "../app/owned-capital-gains.ts";
import {
  computeCapitalGainsCarryChain,
  type FyCapitalGainsTotal,
} from "../domain/gains/index.ts";

// CGT-004 (owner directive, verbatim): "For the Capital gains sub-tab
// increase the number of years to 10 years." Covers the new, APP-LAYER-ONLY
// `buildCapitalGainsDisplayRows` padding step (`app/owned-capital-gains.ts`)
// and its rendering in `capital-gains-screen.tsx`. `domain/gains` changes
// only by exporting the already-existing `evaluateHistoryCompleteness`
// predicate for direct reuse (CGT-004 review fold ruling) -- no
// calculation anywhere changed; see the B1 pass-through test below for a
// direct regression pin proving that.

function makeFy(
  endingYear: number,
  overrides: Partial<FyCapitalGainsTotal> = {},
): FyCapitalGainsTotal {
  return {
    endingYear,
    label: `FY${String(endingYear).slice(-2)}`,
    window: {
      startDate: `${endingYear - 1}-07-01`,
      endDate: `${endingYear}-06-30`,
    },
    rows: [],
    disposalCount: 1,
    excludedIncompleteCount: 0,
    excludedIncompleteSecurityNames: [],
    partialCoverage: false,
    totalDiscountableGainsGrossDecimal: "0",
    totalNonDiscountableGainsGrossDecimal: "0",
    totalLossesDecimal: "0",
    lossAppliedToNonDiscountableDecimal: "0",
    lossAppliedToDiscountableDecimal: "0",
    remainingNonDiscountableAfterLossDecimal: "0",
    remainingDiscountableAfterLossDecimal: "0",
    discountRateDecimal: "0.50",
    discountAppliedDecimal: "0",
    netCapitalGainEstimateDecimal: "0",
    unabsorbedLossDecimal: "0",
    ...overrides,
  };
}

// --- B1: a real carried loss passes THROUGH a no-disposal year unchanged --

test("CGT-004 (B1 regression): a loss carried from an earlier real FY passes through an all-zero gap year unchanged, and lands on the later real FY identically whether or not the zero year is present -- proves omitting a padding row from the carry chain is mathematically safe, never a false 'nothing to carry'", () => {
  // Reviewer's own drill: FY24 has an unabsorbed $5,000 loss; FY26 has a
  // $10,000 discountable gain and no loss of its own; FY25 (in between) has
  // no real disposal at all.
  const fy24Loss = makeFy(2024, { unabsorbedLossDecimal: "5000.00" });
  const fy26Gain = makeFy(2026, {
    totalDiscountableGainsGrossDecimal: "10000.00",
    remainingDiscountableAfterLossDecimal: "10000.00",
  });
  const fy25AllZero = makeFy(2025); // every field already "0" via makeFy's defaults

  const withGap = computeCapitalGainsCarryChain(
    [fy26Gain, fy25AllZero, fy24Loss],
    "2023-07-01",
  );
  const withoutGap = computeCapitalGainsCarryChain(
    [fy26Gain, fy24Loss],
    "2023-07-01",
  );

  const gapEntry = withGap.perFy.find((entry) => entry.endingYear === 2025)!;
  // The $5,000 loss passes THROUGH the zero year completely unabsorbed --
  // this is exactly what a caller would see if it computed the chain WITH
  // the zero year, confirming the padding row's carry columns showing
  // "nothing to carry" would have been false.
  assert.equal(gapEntry.carryInLossDecimal, "5000");
  assert.equal(gapEntry.carryInAppliedDecimal, "0");
  assert.equal(gapEntry.carryOutLossDecimal, "5000");

  const withGapEntry26 = withGap.perFy.find(
    (entry) => entry.endingYear === 2026,
  )!;
  const withoutGapEntry26 = withoutGap.perFy.find(
    (entry) => entry.endingYear === 2026,
  )!;
  // The real FY's own carried figures are IDENTICAL whether or not the
  // all-zero gap year is included in the chain -- padding never perturbs a
  // real FY's math.
  assert.deepEqual(withGapEntry26, withoutGapEntry26);
  assert.equal(withGapEntry26.netCapitalGainEstimateDecimal, "2500");
  assert.equal(withGapEntry26.carryOutLossDecimal, "0");
});

// --- Pure padding function -------------------------------------------------

test("CGT-004: pads an empty fyTotals list out to exactly CAPITAL_GAINS_DISPLAY_YEARS (10) rows, newest first", () => {
  assert.equal(CAPITAL_GAINS_DISPLAY_YEARS, 10);
  const rows = buildCapitalGainsDisplayRows({
    fyTotals: [],
    today: "2026-08-14",
    financialYearStartMonth: 7,
    historyCompleteFrom: null,
    earliestTradeDate: null,
  });
  assert.equal(rows.length, CAPITAL_GAINS_DISPLAY_YEARS);
  assert.deepEqual(
    rows.map((row) => row.endingYear),
    [2027, 2026, 2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018],
  );
  // No declared boundary AND no ledger evidence at all -- every candidate
  // year is genuinely unknown, never a fabricated zero.
  assert.ok(rows.every((row) => row.kind === "unknown"));
  // Only the current (in-progress) FY is flagged `isCurrentFy`.
  const current = rows.find((row) => row.endingYear === 2027);
  assert.equal((current as { isCurrentFy: boolean }).isCurrentFy, true);
  assert.ok(
    rows
      .filter((row) => row.endingYear !== 2027)
      .every((row) => (row as { isCurrentFy: boolean }).isCurrentFy === false),
  );
});

test("CGT-004: real disposal FYs are always kept, even ones older than the 10-year display window -- padding only ever adds rows, never truncates real ones", () => {
  const ancient = makeFy(2010);
  const rows = buildCapitalGainsDisplayRows({
    fyTotals: [ancient],
    today: "2026-08-14",
    financialYearStartMonth: 7,
    historyCompleteFrom: "2024-07-01",
    earliestTradeDate: null,
  });
  assert.equal(rows.length, CAPITAL_GAINS_DISPLAY_YEARS + 1);
  const oldest = rows[rows.length - 1]!;
  assert.equal(oldest.kind, "data");
  assert.equal(oldest.endingYear, 2010);
});

test("CGT-004: a real FY inside the window is never replaced by a placeholder, and a declared history_complete_from tiers the gap years correctly", () => {
  const fy2026 = makeFy(2026, {
    totalDiscountableGainsGrossDecimal: "1000.00",
  });
  const fy2025 = makeFy(2025, {
    totalNonDiscountableGainsGrossDecimal: "200.00",
  });
  const rows = buildCapitalGainsDisplayRows({
    fyTotals: [fy2026, fy2025],
    today: "2026-08-14",
    financialYearStartMonth: 7,
    historyCompleteFrom: "2024-07-01",
    earliestTradeDate: null,
  });
  const byYear = new Map(rows.map((row) => [row.endingYear, row]));
  assert.equal(rows.length, 10);
  assert.deepEqual(byYear.get(2026), {
    kind: "data",
    endingYear: 2026,
    fy: fy2026,
  });
  assert.deepEqual(byYear.get(2025), {
    kind: "data",
    endingYear: 2025,
    fy: fy2025,
  });
  // FY27 (this FY, in progress): its start date (2026-07-01) is ON/AFTER
  // historyCompleteFrom (2024-07-01) -- a real, known zero SO FAR.
  const fy27 = byYear.get(2027) as {
    kind: string;
    isCurrentFy: boolean;
  };
  assert.equal(fy27.kind, "no_disposals");
  assert.equal(fy27.isCurrentFy, true);
  // FY24's start date (2023-07-01) is BEFORE historyCompleteFrom
  // (2024-07-01) -- genuinely unknown, never a fabricated zero.
  assert.equal(byYear.get(2024)!.kind, "unknown");
  assert.equal(byYear.get(2018)!.kind, "unknown");
});

test("CGT-004 (B2 ruling): when history_complete_from is null, the portfolio's earliest recorded ledger transaction date is used as evidence instead -- a fully-synced ledger no longer renders as mostly-unknown years", () => {
  const rows = buildCapitalGainsDisplayRows({
    fyTotals: [],
    today: "2026-08-14",
    financialYearStartMonth: 7,
    historyCompleteFrom: null,
    earliestTradeDate: "2016-07-01", // well before every candidate FY's start
  });
  assert.equal(rows.length, 10);
  // Every one of the 10 candidate years starts on/after 2016-07-01, so
  // every one is a real, evidence-backed known zero -- never "unknown".
  assert.ok(rows.every((row) => row.kind === "no_disposals"));
});

test("CGT-004 (B2 ruling): the evidence fallback only kicks in when history_complete_from is null -- a declared (even much earlier) boundary is never silently overridden by evidence, and a declared boundary that makes a year unknown still wins over evidence that would have called it known", () => {
  const rows = buildCapitalGainsDisplayRows({
    fyTotals: [],
    today: "2026-08-14",
    financialYearStartMonth: 7,
    historyCompleteFrom: "2025-07-01", // declared, covers only the current FY
    earliestTradeDate: "2000-07-01", // evidence alone would call every year known
  });
  const byYear = new Map(rows.map((row) => [row.endingYear, row]));
  // FY27 (start 2026-07-01) is on/after the DECLARED boundary -- known.
  assert.equal(byYear.get(2027)!.kind, "no_disposals");
  // FY25 (start 2024-07-01) predates the declared boundary -- the declared
  // boundary wins, so this is unknown EVEN THOUGH the (ignored) evidence
  // date would have called it known.
  assert.equal(byYear.get(2025)!.kind, "unknown");
});

test("CGT-004: a candidate year whose start predates the earliest recorded transaction is unknown, even though it sits chronologically before a year the evidence DOES cover", () => {
  const rows = buildCapitalGainsDisplayRows({
    fyTotals: [],
    today: "2026-08-14",
    financialYearStartMonth: 7,
    historyCompleteFrom: null,
    earliestTradeDate: "2022-09-15", // mid-FY23
  });
  const byYear = new Map(rows.map((row) => [row.endingYear, row]));
  // FY24 (start 2023-07-01) is on/after the earliest trade date -- known.
  assert.equal(byYear.get(2024)!.kind, "no_disposals");
  // FY23 (start 2022-07-01) is BEFORE the earliest trade date, even though
  // the earliest trade itself falls inside FY23 -- still unknown (the
  // portion of that FY before the earliest trade is unevidenced), matching
  // `evaluateHistoryCompleteness`'s existing "boundary sits inside the
  // window" precedent.
  assert.equal(byYear.get(2023)!.kind, "unknown");
});

test("CGT-004: an unresolvable today/start-month combination fails closed -- real FYs still render, padding is simply skipped rather than throwing", () => {
  const fy2026 = makeFy(2026);
  const rows = buildCapitalGainsDisplayRows({
    fyTotals: [fy2026],
    today: "not-a-date",
    financialYearStartMonth: 7,
    historyCompleteFrom: null,
    earliestTradeDate: null,
  });
  assert.deepEqual(rows, [{ kind: "data", endingYear: 2026, fy: fy2026 }]);
});

// --- Rendered screen ---------------------------------------------------------

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

const fy2026Screen = makeFy(2026, {
  disposalCount: 1,
  totalDiscountableGainsGrossDecimal: "1000.00",
  remainingDiscountableAfterLossDecimal: "1000.00",
  discountAppliedDecimal: "500.00",
  netCapitalGainEstimateDecimal: "500.00",
});

const screenHistory = {
  today: "2026-08-14",
  financialYearStartMonth: 7,
  baseCurrencyCode: "AUD",
  disposalCount: 1,
  fyTotals: [fy2026Screen],
  historyCompleteFrom: "2024-07-01",
  earliestTradeDate: null,
};

function renderScreen(overrides: Record<string, unknown> = {}) {
  return renderComponent(
    "CapitalGainsScreen",
    "../app/components/capital-gains-screen.tsx",
    {
      portfolioId: "portfolio-a",
      holdingsHref: "/portfolio/portfolio-a/holdings",
      result: { status: "ok", history: screenHistory },
      ...overrides,
    },
  );
}

test("CGT-004: the populated FY table renders exactly 10 rows (CAPITAL_GAINS_DISPLAY_YEARS), padding a single real FY out to a full decade", () => {
  const html = renderScreen();
  const tbodyMatch = html.match(/<tbody>([\s\S]*)<\/tbody>/);
  assert.ok(tbodyMatch, "expected a <tbody> in the rendered FY table");
  const rowCount = (tbodyMatch![1]!.match(/<tr[ >]/g) ?? []).length;
  assert.equal(rowCount, 10);
});

// The Status cell's aria-label deliberately repeats its own visible span
// text (the aria-label overrides the "Method" column-header association
// for assistive tech; see the render source) -- these assertions count
// only the VISIBLE span occurrences, not the (duplicate) aria-label text,
// so they aren't accidentally doubled by that repetition.
function countVisibleStatusText(html: string, text: string): number {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    html.match(
      new RegExp(`<span class="income-source">${escaped}</span>`, "g"),
    ) ?? []
  ).length;
}

test("CGT-004: a declared-complete NON-current year with no real disposal renders an honest real zero ('No disposals recorded this financial year', $0.00, Full coverage)", () => {
  const html = renderScreen();
  // FY25's start date (2024-07-01) is on/after historyCompleteFrom
  // (2024-07-01), and it is NOT the current FY.
  assert.equal(
    countVisibleStatusText(html, "No disposals recorded this financial year"),
    1,
  );
  assert.match(html, /FY25/);
});

test("CGT-004 (fold ruling): the still-open current FY says 'so far', never claims 'Full' coverage for an unfinished year", () => {
  const html = renderScreen();
  assert.match(html, /No disposals recorded so far this financial year/);
  assert.match(html, />In progress</);
  // "Full" legitimately appears twice in this fixture: FY26's own real
  // coverage cell, and FY25's `no_disposals` (non-current) placeholder --
  // it must never appear a THIRD time, which would mean FY27 (the
  // still-open current FY) wrongly claimed "Full" too.
  assert.equal((html.match(/>Full</g) ?? []).length, 2);
});

test("CGT-004 (B2 ruling): a year predating the completeness boundary renders honestly 'Unknown', and NEVER claims 'before recorded history' (false for a gap year between two real disposal years or the current FY)", () => {
  const html = renderScreen();
  assert.equal(
    countVisibleStatusText(
      html,
      "Unknown — no confirmed disposal record for this financial year",
    ),
    7, // FY24 down through FY18
  );
  assert.match(html, /FY18/);
  assert.doesNotMatch(html, /before recorded history/i);
});

test("CGT-004 (B1 ruling): every placeholder row's carry columns render an honest not-computed state (em dash, accessible reason), never a false 'nothing to carry' claim", () => {
  const html = renderScreen();
  assert.doesNotMatch(html, /nothing to carry/i);
  const ariaOccurrences = (
    html.match(/aria-label="Not computed for years with no disposals"/g) ?? []
  ).length;
  // 9 placeholder rows in this fixture (10 total minus the one real FY26 row).
  assert.equal(ariaOccurrences, 9);
});

test("CGT-004 (B2 ruling, evidence fallback rendered): when history_complete_from is null, a portfolio with an early earliest recorded transaction renders mostly real zeros, not mostly Unknown", () => {
  const html = renderScreen({
    result: {
      status: "ok",
      history: {
        ...screenHistory,
        historyCompleteFrom: null,
        earliestTradeDate: "2015-07-01",
      },
    },
  });
  // Every padded year now starts on/after the earliest recorded
  // transaction, so none of the 9 placeholder rows are "Unknown".
  assert.equal((html.match(/Unknown — no confirmed/g) ?? []).length, 0);
  assert.equal(
    (
      html.match(
        /<span class="income-source">No disposals recorded (so far )?this financial year<\/span>/g,
      ) ?? []
    ).length,
    9,
  );
});

test("CGT-004: only the real FY row is a clickable detail-dialog trigger -- placeholder rows have no detail to open", () => {
  const html = renderScreen();
  const triggerCount = (html.match(/class="income-row-trigger"/g) ?? []).length;
  assert.equal(triggerCount, 1);
  assert.match(
    html,
    /<button type="button" class="income-row-trigger">FY26<\/button>/,
  );
});

test("CGT-004: the real FY's own figures are unaffected by padding -- the FY26 row still shows its true carried net estimate", () => {
  const html = renderScreen();
  assert.match(html, /\$1,000\.00/); // FY26 discountable gross
  assert.match(html, /\$500\.00/); // FY26 net estimate (no carry-in, no other FYs)
});

test("CGT-004: a portfolio with zero disposals still gets the plain 'No disposals yet' empty state, not a padded table (padding only applies once there is at least one real disposal)", () => {
  const html = renderScreen({
    result: {
      status: "ok",
      history: { ...screenHistory, disposalCount: 0, fyTotals: [] },
    },
  });
  assert.match(html, /No disposals yet/);
  assert.doesNotMatch(html, /<table/);
  assert.doesNotMatch(html, /No disposals recorded/);
});
