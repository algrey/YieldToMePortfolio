/** DIV-003 -- retirement-income projection engine. */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteSqlClient } from "../db/repositories/index.ts";
import { loadOwnedIncomeProjection } from "../app/owned-income-projection.ts";
import {
  aggregateSecurityYields,
  computeCurrentFinancialYearRow,
  computeIncomeBreakdown,
  computePastFinancialYearRows,
  decomposeGrossedAmount,
  projectMultiYearIncome,
  projectMultiYearIncomeWhatIf,
  resolvePortfolioDividendGrowth,
  resolvePortfolioValueGrowth,
  resolveSecurityDividendGrowth,
  resolveSecurityFranking,
  resolveSecurityYield,
  type FrankingAssumptionResolution,
  type MultiYearProjectionInput,
  type YieldAssumptionResolution,
} from "../domain/dividends/projection.ts";
import type { SecurityDividendForecast } from "../domain/dividends/forecast.ts";
import type { FyDividendTotal } from "../domain/dividends/aggregations.ts";

// ---------------------------------------------------------------------------
// a. Assumption resolution -- precedence matrices
// ---------------------------------------------------------------------------

test("franking resolution: owner override wins; blank falls back to an explicit unfranked default, never a silent zero pretending to be data", () => {
  const overridden = resolveSecurityFranking("70");
  assert.equal(overridden.source, "owner_override");
  assert.equal(overridden.frankingPercentDecimal, "70");

  const blank = resolveSecurityFranking(null);
  assert.equal(blank.source, "none");
  assert.equal(blank.frankingPercentDecimal, "0");
  assert.match(blank.method, /unfranked/);
});

test("dividend-growth resolution: owner security override > portfolio default > explicit 'no growth assumed' 0%", () => {
  const ownerWins = resolveSecurityDividendGrowth("4", "2");
  assert.equal(ownerWins.source, "owner_override");
  assert.equal(ownerWins.growthPercentDecimal, "4");

  const portfolioFallback = resolveSecurityDividendGrowth(null, "2");
  assert.equal(portfolioFallback.source, "portfolio_default");
  assert.equal(portfolioFallback.growthPercentDecimal, "2");

  const none = resolveSecurityDividendGrowth(null, null);
  assert.equal(none.source, "none");
  assert.equal(none.growthPercentDecimal, "0");
  assert.match(none.method, /no growth assumed/);
});

test("portfolio-level growth assumptions: set value falls through to source 'portfolio_assumption'; blank is 'none' -- DIV-011 (owner directive): defaults to 6%/yr, never the old 0%, and never fabricated as an owner choice", () => {
  assert.deepEqual(resolvePortfolioValueGrowth("8"), {
    source: "portfolio_assumption",
    growthPercentDecimal: "8",
    method: "owner-set portfolio value-growth assumption",
  });
  assert.equal(resolvePortfolioValueGrowth(null).source, "none");
  assert.equal(resolvePortfolioValueGrowth(null).growthPercentDecimal, "6");
  assert.match(
    resolvePortfolioValueGrowth(null).method,
    /defaulting to 6%\/yr/,
  );
  assert.equal(resolvePortfolioDividendGrowth(null).source, "none");
  assert.equal(resolvePortfolioDividendGrowth(null).growthPercentDecimal, "6");
  assert.match(
    resolvePortfolioDividendGrowth(null).method,
    /defaulting to 6%\/yr/,
  );
  // An owner-set value still wins outright -- the DEFAULT is the only thing
  // that changed.
  assert.deepEqual(resolvePortfolioDividendGrowth("3"), {
    source: "portfolio_assumption",
    growthPercentDecimal: "3",
    method: "owner-set portfolio dividend-growth assumption",
  });
});

test("yield resolution: owner override wins outright, no gross-up applied (owner value already means total yield)", () => {
  const franking = resolveSecurityFranking("70");
  const resolution = resolveSecurityYield(
    "12",
    { ok: false, reason: "insufficient_history" },
    franking,
  );
  assert.equal(resolution.source, "owner_override");
  assert.equal(resolution.status, "ok");
  assert.equal(resolution.grossedYieldPercentDecimal, "12");
  assert.equal(resolution.cashYieldPercentDecimal, null);
});

test("yield resolution: grossed-yield derivation from cash TTM + franking -- grossed = cash * (1 + frankingPct/100 * 30/70)", () => {
  const franking = resolveSecurityFranking("70"); // 70% chosen so the ratio (70/100 * 30/70 = 0.3) terminates exactly, no rounding noise
  const resolution = resolveSecurityYield(
    null,
    {
      ok: true,
      trailingYieldPercentDecimal: "10",
      ttmSource: "provider_ttm",
      ttmIncomplete: false,
    },
    franking,
  );
  assert.equal(resolution.source, "provider_ttm");
  assert.equal(resolution.status, "ok");
  assert.equal(resolution.cashYieldPercentDecimal, "10");
  assert.equal(resolution.frankingPercentUsedDecimal, "70");
  // 10 * (1 + 0.3) = 13 exactly.
  assert.equal(resolution.grossedYieldPercentDecimal, "13");
});

test("yield resolution: no owner override and no franking assumption set -- provider cash yield passes through unfranked (0% assumed), not silently blocked", () => {
  const franking = resolveSecurityFranking(null);
  const resolution = resolveSecurityYield(
    null,
    {
      ok: true,
      trailingYieldPercentDecimal: "5",
      ttmSource: "provider_ttm",
      ttmIncomplete: false,
    },
    franking,
  );
  assert.equal(resolution.source, "provider_ttm");
  assert.equal(resolution.grossedYieldPercentDecimal, "5");
});

test("yield resolution: no owner override and no usable provider data -- explicit 'none' carrying the provider's own typed reason, never a fabricated yield", () => {
  const franking = resolveSecurityFranking(null);
  for (const reason of [
    "insufficient_history",
    "price_unavailable",
    "currency_mismatch",
    "mixed_currency",
    "invalid_input",
  ] as const) {
    const resolution = resolveSecurityYield(
      null,
      { ok: false, reason },
      franking,
    );
    assert.equal(resolution.source, "none");
    assert.equal(resolution.status, reason);
    assert.equal(resolution.grossedYieldPercentDecimal, null);
  }
});

// ---------------------------------------------------------------------------
// Franking gross-up/decomposition -- exact decimal round trip
// ---------------------------------------------------------------------------

test("decomposeGrossedAmount splits an exact 100% return trip: cash + franking always sums back to gross exactly", () => {
  // 70% franking gives an exact (non-repeating) ratio of 0.3, so this fixture
  // is hand-verifiable: gross 130 = cash 100 + franking credit 30.
  const split = decomposeGrossedAmount("130", "70");
  assert.equal(split.cashDecimal, "100");
  assert.equal(split.frankingDecimal, "30");
});

test("decomposeGrossedAmount at 0% franking returns the gross figure unchanged as pure cash", () => {
  const split = decomposeGrossedAmount("500", "0");
  assert.equal(split.cashDecimal, "500");
  assert.equal(split.frankingDecimal, "0");
});

// ---------------------------------------------------------------------------
// Value-weighted aggregation
// ---------------------------------------------------------------------------

function yieldOk(percent: string): YieldAssumptionResolution {
  return {
    source: "owner_override",
    status: "ok",
    grossedYieldPercentDecimal: percent,
    cashYieldPercentDecimal: null,
    frankingPercentUsedDecimal: null,
    frankingSource: null,
    ttmIncomplete: false,
    method: "test",
  };
}
function yieldNone(
  reason: Exclude<YieldAssumptionResolution["status"], "ok">,
): YieldAssumptionResolution {
  return {
    source: "none",
    status: reason,
    grossedYieldPercentDecimal: null,
    cashYieldPercentDecimal: null,
    frankingPercentUsedDecimal: null,
    frankingSource: null,
    ttmIncomplete: false,
    method: "test",
  };
}
function frankingPercent(percent: string): FrankingAssumptionResolution {
  return {
    source: "owner_override",
    frankingPercentDecimal: percent,
    method: "test",
  };
}

test("aggregateSecurityYields: value-weighted average across covered securities; an uncovered security is excluded and named, not treated as 0% yield", () => {
  const result = aggregateSecurityYields([
    {
      portfolioSecurityId: "a",
      symbol: "A",
      valueDecimal: "1000",
      yield: yieldOk("10"),
      franking: frankingPercent("100"),
    },
    {
      portfolioSecurityId: "b",
      symbol: "B",
      valueDecimal: "3000",
      yield: yieldOk("6"),
      franking: frankingPercent("0"),
    },
    {
      portfolioSecurityId: "c",
      symbol: "C",
      valueDecimal: "500",
      yield: yieldNone("insufficient_history"),
      franking: frankingPercent("0"),
    },
  ]);
  assert.equal(result.status, "ok");
  // (1000*10 + 3000*6) / 4000 = 7 exactly.
  assert.equal(result.effectiveYieldPercentDecimal, "7");
  // (1000*100 + 3000*0) / 4000 = 25 exactly.
  assert.equal(result.effectiveFrankingMixPercentDecimal, "25");
  assert.equal(result.includedValueDecimal, "4000");
  assert.equal(result.includedCount, 2);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0]!.portfolioSecurityId, "c");
  assert.equal(result.excluded[0]!.reason, "insufficient_history");
});

test("aggregateSecurityYields: no security has a resolved yield -- explicit no_coverage, not a fabricated 0% portfolio yield", () => {
  const result = aggregateSecurityYields([
    {
      portfolioSecurityId: "a",
      symbol: "A",
      valueDecimal: "1000",
      yield: yieldNone("insufficient_history"),
      franking: frankingPercent("0"),
    },
  ]);
  assert.equal(result.status, "no_coverage");
  assert.equal(result.effectiveYieldPercentDecimal, null);
  assert.equal(result.excluded.length, 1);
});

test("aggregateSecurityYields: a zero-value holding contributes no weight and is not disclosed as an exclusion (a real fact, not missing data)", () => {
  const result = aggregateSecurityYields([
    {
      portfolioSecurityId: "a",
      symbol: "A",
      valueDecimal: "0",
      yield: yieldOk("10"),
      franking: frankingPercent("0"),
    },
    {
      portfolioSecurityId: "b",
      symbol: "B",
      valueDecimal: "1000",
      yield: yieldOk("5"),
      franking: frankingPercent("0"),
    },
  ]);
  assert.equal(result.status, "ok");
  assert.equal(result.effectiveYieldPercentDecimal, "5");
  assert.equal(result.excluded.length, 0);
});

test("B1 repro: an unpriced holding is never folded in as a real zero -- it is excluded and named, and the covered remainder's yield is disclosed as partial, not full, coverage", () => {
  // $900k holding, owner override yield 6%, but NO current price (unpriced).
  // $100k holding, priced, 3% yield. Before the fix, the unpriced holding's
  // `valueDecimal` collapsed to the literal "0", so it silently vanished
  // from both the numerator and denominator: (0*6 + 100k*3) / (0 + 100k) =
  // 3%, reported with ZERO exclusions and a method string claiming full
  // coverage -- a confident-looking number built on 10% of the portfolio.
  const result = aggregateSecurityYields([
    {
      portfolioSecurityId: "unpriced",
      symbol: "UNPRICED",
      valueDecimal: null, // unknown, distinct from a real "0"
      yield: yieldOk("6"),
      franking: frankingPercent("0"),
    },
    {
      portfolioSecurityId: "priced",
      symbol: "PRICED",
      valueDecimal: "100000",
      yield: yieldOk("3"),
      franking: frankingPercent("0"),
    },
  ]);
  assert.equal(result.status, "ok");
  // The numeric result is still 3% (only the priced $100k is weighable),
  // but it must now be disclosed as partial coverage, not full coverage.
  assert.equal(result.effectiveYieldPercentDecimal, "3");
  assert.equal(result.includedCount, 1);
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0]!.portfolioSecurityId, "unpriced");
  assert.equal(result.excluded[0]!.reason, "value_unavailable");
  assert.doesNotMatch(result.method, /every held security/);
  assert.match(result.method, /1 excluded/);
});

test("aggregateSecurityYields: value_unavailable is checked before the yield check -- an unpriced holding with NO resolved yield either is still named for its value gap, not silently absorbed", () => {
  const result = aggregateSecurityYields([
    {
      portfolioSecurityId: "a",
      symbol: "A",
      valueDecimal: null,
      yield: yieldNone("insufficient_history"),
      franking: frankingPercent("0"),
    },
  ]);
  assert.equal(result.status, "no_coverage");
  assert.equal(result.excluded.length, 1);
  assert.equal(result.excluded[0]!.reason, "value_unavailable");
});

// ---------------------------------------------------------------------------
// b. Multi-year projection -- exact-decimal compounding, spot-checked
// ---------------------------------------------------------------------------

// DIV-011 (owner directive, 2026-08-23): the fixture/tests below were
// rewritten -- year 1 is now the UNGROWN base (`currentPortfolioValueDecimal`
// and the reused `baseForecastGrossDecimal`/`baseForecastCashDecimal`
// forecast sum, verbatim), and value/dividend compound INDEPENDENTLY on
// their own growth assumptions starting from year 2 (yield is a derived
// display figure, never a compounding input). Pre-DIV-011 this fixture
// derived year 1 from `baseYieldPercentDecimal * currentPortfolioValueDecimal`
// (both already grown once) -- the exact mechanism the root-cause
// investigation found diverging from `computeIncomeBreakdown`'s
// Next-12-months headline.
const COMPOUNDING_FIXTURE: MultiYearProjectionInput = {
  assumptions: {
    currentPortfolioValueDecimal: "100000",
    currentPortfolioValueStatus: "available",
    baseForecastGrossDecimal: "10000",
    baseForecastCashDecimal: "10000", // 0% franking mix -- isolates value/dividend compounding from the cash/franking split
    baseYieldIncludesPartialTtm: false,
    baseForecastFrankingIncomplete: false,
    baseExcludedSecurityCount: 0,
    valueGrowthPercentDecimal: "10",
    valueGrowthSource: "portfolio_assumption",
    dividendGrowthPercentDecimal: "0", // dividend held constant so value compounding is hand-verifiable in isolation
    dividendGrowthSource: "none",
  },
  yearsForward: 10,
  startEndingYear: 2026,
};

test("multi-year projection (DIV-011): year 1 is the UNGROWN base (current value, the reused forecast sum verbatim); value compounds from year 2 onward, spot-checked at year 1, 2, and 10", () => {
  const result = projectMultiYearIncome(COMPOUNDING_FIXTURE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const year1 = result.rows[0]!;
  assert.equal(year1.yearIndex, 1);
  assert.equal(year1.endingYear, 2027);
  assert.equal(year1.label, "FY27");
  assert.equal(year1.valueDecimal, "100000"); // UNGROWN -- year 1 is the current value, not yet compounded
  assert.equal(year1.yieldPercentDecimal, "10"); // derived display: 10000 / 100000 * 100
  assert.equal(year1.grossDividendDecimal, "10000"); // the reused base forecast sum, unmodified
  assert.equal(year1.cashDividendDecimal, "10000");
  assert.equal(year1.frankingCreditDecimal, "0");

  const year2 = result.rows[1]!;
  assert.equal(year2.valueDecimal, "110000"); // 100000 * 1.1 -- growth starts applying from year 2
  assert.equal(year2.grossDividendDecimal, "10000"); // dividend growth is 0% in this fixture -- unchanged

  // 1.1^9 = 2.357947691 exactly (11^9 / 10^9, a terminating decimal) --
  // value compounds 9 times reaching year 10 (years 2 through 10).
  const year10 = result.rows[9]!;
  assert.equal(year10.yearIndex, 10);
  assert.equal(year10.endingYear, 2036);
  assert.equal(year10.valueDecimal, "235794.7691");
  assert.equal(year10.grossDividendDecimal, "10000");
  assert.equal(year10.cashDividendDecimal, "10000");
  assert.equal(year10.frankingCreditDecimal, "0");
});

test("multi-year projection (DIV-011): dividend compounds by the dividend-growth assumption, independently of value growth (yield is a derived display figure, not a compounding input)", () => {
  const result = projectMultiYearIncome({
    assumptions: {
      currentPortfolioValueDecimal: "1000",
      currentPortfolioValueStatus: "available",
      baseForecastGrossDecimal: "40",
      baseForecastCashDecimal: "40",
      baseYieldIncludesPartialTtm: false,
      baseForecastFrankingIncomplete: false,
      baseExcludedSecurityCount: 0,
      valueGrowthPercentDecimal: "0", // isolates dividend compounding
      valueGrowthSource: "none",
      dividendGrowthPercentDecimal: "5",
      dividendGrowthSource: "portfolio_assumption",
    },
    yearsForward: 3,
    startEndingYear: null,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0]!.valueDecimal, "1000"); // year 1 -- the ungrown base
  assert.equal(result.rows[0]!.grossDividendDecimal, "40");
  assert.equal(result.rows[0]!.yieldPercentDecimal, "4"); // derived: 40 / 1000 * 100
  assert.equal(result.rows[0]!.label, "Year 1"); // no startEndingYear -> plain label

  assert.equal(result.rows[1]!.valueDecimal, "1000"); // value growth is 0% -- unchanged
  assert.equal(result.rows[1]!.grossDividendDecimal, "42"); // 40 * 1.05
  assert.equal(result.rows[1]!.yieldPercentDecimal, "4.2"); // derived: 42 / 1000 * 100

  assert.equal(result.rows[2]!.grossDividendDecimal, "44.1"); // 42 * 1.05
});

test("multi-year projection (DIV-011): franking credit is derived by subtraction (gross - cash) every year -- an exact cash/credit round trip, never an independent multiplication", () => {
  const result = projectMultiYearIncome({
    assumptions: {
      currentPortfolioValueDecimal: "1000",
      currentPortfolioValueStatus: "available",
      baseForecastGrossDecimal: "130",
      baseForecastCashDecimal: "100", // 30 franking credit -- the exact 0.3 ratio, see decomposeGrossedAmount fixture above
      baseYieldIncludesPartialTtm: false,
      baseForecastFrankingIncomplete: false,
      baseExcludedSecurityCount: 0,
      valueGrowthPercentDecimal: "0",
      valueGrowthSource: "none",
      dividendGrowthPercentDecimal: "10",
      dividendGrowthSource: "portfolio_assumption",
    },
    yearsForward: 2,
    startEndingYear: null,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const year1 = result.rows[0]!;
  assert.equal(year1.grossDividendDecimal, "130");
  assert.equal(year1.cashDividendDecimal, "100");
  assert.equal(year1.frankingCreditDecimal, "30");
  assert.match(year1.method, /includes franking credits/);

  // Year 2: gross and cash each compound by 10% independently; franking is
  // DERIVED by subtraction from that year's own gross/cash (never an
  // independent multiplication) -- still an exact round trip.
  const year2 = result.rows[1]!;
  assert.equal(year2.grossDividendDecimal, "143"); // 130 * 1.1
  assert.equal(year2.cashDividendDecimal, "110"); // 100 * 1.1
  assert.equal(year2.frankingCreditDecimal, "33"); // 143 - 110, exact
});

test("multi-year projection (DIV-011 review fix B3): a several-excluded base (most held securities contributed NOTHING to the reused forecast sum) is named on EVERY row's method, not just the merely-partial-TTM case -- a base built from a minority of held securities must never read as confidently complete", () => {
  const result = projectMultiYearIncome({
    assumptions: {
      currentPortfolioValueDecimal: "10000",
      currentPortfolioValueStatus: "available",
      baseForecastGrossDecimal: "100", // only 1 of 4 held securities actually contributed
      baseForecastCashDecimal: "100",
      baseYieldIncludesPartialTtm: false,
      baseForecastFrankingIncomplete: false,
      baseExcludedSecurityCount: 3,
      valueGrowthPercentDecimal: "0",
      valueGrowthSource: "none",
      dividendGrowthPercentDecimal: "0",
      dividendGrowthSource: "none",
    },
    yearsForward: 2,
    startEndingYear: null,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const row of result.rows) {
    assert.match(
      row.method,
      /3 held securities excluded entirely from this base/,
    );
    assert.match(row.method, /may understate true income/);
  }
});

test("multi-year projection: a base excluding exactly one security uses the singular 'security', never 'securityies' or a bare count", () => {
  const result = projectMultiYearIncome({
    assumptions: {
      currentPortfolioValueDecimal: "10000",
      currentPortfolioValueStatus: "available",
      baseForecastGrossDecimal: "100",
      baseForecastCashDecimal: "100",
      baseYieldIncludesPartialTtm: false,
      baseForecastFrankingIncomplete: false,
      baseExcludedSecurityCount: 1,
      valueGrowthPercentDecimal: "0",
      valueGrowthSource: "none",
      dividendGrowthPercentDecimal: "0",
      dividendGrowthSource: "none",
    },
    yearsForward: 1,
    startEndingYear: null,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(
    result.rows[0]!.method,
    /1 held security excluded entirely from this base/,
  );
});

test("multi-year projection: baseExcludedSecurityCount: 0 (every held security included) adds NO exclusion clause to the method", () => {
  const result = projectMultiYearIncome(COMPOUNDING_FIXTURE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.doesNotMatch(result.rows[0]!.method, /excluded entirely/);
});

test("multi-year projection (DIV-011 review fix B2): a 'none'-sourced growth rate is named as a DEFAULT, never rendered as if the owner chose it -- both axes", () => {
  const result = projectMultiYearIncome({
    ...COMPOUNDING_FIXTURE,
    assumptions: {
      ...COMPOUNDING_FIXTURE.assumptions,
      valueGrowthPercentDecimal: "6",
      valueGrowthSource: "none",
      dividendGrowthPercentDecimal: "6",
      dividendGrowthSource: "none",
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.rows[0]!.method, /6%\/yr \(default, 6%\/yr unless set\)/);
  // Both axes -- appears twice.
  const matches = result.rows[0]!.method.match(
    /\(default, 6%\/yr unless set\)/g,
  );
  assert.equal(matches?.length, 2);
  // An owner-set rate on BOTH axes reads distinctly, never "default".
  const ownerSet = projectMultiYearIncome({
    ...COMPOUNDING_FIXTURE,
    assumptions: {
      ...COMPOUNDING_FIXTURE.assumptions,
      dividendGrowthPercentDecimal: "3",
      dividendGrowthSource: "portfolio_assumption",
    },
  });
  assert.equal(ownerSet.ok, true);
  if (ownerSet.ok) {
    assert.doesNotMatch(ownerSet.rows[0]!.method, /default/);
    const ownerSetMatches = ownerSet.rows[0]!.method.match(/\(owner-set\)/g);
    assert.equal(ownerSetMatches?.length, 2);
  }
});

test("multi-year projection: rejects years forward outside the 1-10 bound with a typed reason", () => {
  const tooMany = projectMultiYearIncome({
    ...COMPOUNDING_FIXTURE,
    yearsForward: 11,
  });
  assert.deepEqual(tooMany, { ok: false, reason: "invalid_years" });
  const zero = projectMultiYearIncome({
    ...COMPOUNDING_FIXTURE,
    yearsForward: 0,
  });
  assert.deepEqual(zero, { ok: false, reason: "invalid_years" });
});

// ---------------------------------------------------------------------------
// e. What-if overlay -- purity and correctness
// ---------------------------------------------------------------------------

test("what-if overlay module has no repository/persistence imports (structural non-persistence guarantee)", async () => {
  const source = await readFile(
    new URL("../domain/dividends/projection.ts", import.meta.url),
    "utf8",
  );
  const importLines = source
    .split("\n")
    .filter((line) => /^import\b/.test(line.trim()));
  assert.ok(importLines.length > 0, "sanity check: file has imports");
  for (const line of importLines) {
    assert.doesNotMatch(line, /db\/repositories/);
    assert.doesNotMatch(line, /sql-client/);
  }
  assert.doesNotMatch(source, /\bclient\.(run|batch|all|get)\(/);
});

test("what-if overlay: substitutes only value/dividend growth, leaves the baseline input object unmutated, and recomputes correctly", () => {
  const whatIf = projectMultiYearIncomeWhatIf(COMPOUNDING_FIXTURE, {
    valueGrowthPercentDecimal: "0",
  });
  assert.equal(whatIf.ok, true);
  if (!whatIf.ok) return;
  // Year 1 is the ungrown base regardless (DIV-011) -- a value-growth
  // override only shows a difference from year 2 onward.
  assert.equal(whatIf.rows[0]!.valueDecimal, "100000");
  assert.equal(whatIf.rows[1]!.valueDecimal, "100000"); // value no longer grows
  assert.equal(whatIf.rows[9]!.valueDecimal, "100000");
  assert.equal(whatIf.assumptions.valueGrowthSource, "what_if");
  assert.equal(whatIf.assumptions.dividendGrowthSource, "none"); // untouched override

  // Baseline object itself is untouched -- re-running it gives the original result.
  assert.equal(COMPOUNDING_FIXTURE.assumptions.valueGrowthPercentDecimal, "10");
  const baseline = projectMultiYearIncome(COMPOUNDING_FIXTURE);
  assert.equal(baseline.ok, true);
  if (baseline.ok) assert.equal(baseline.rows[1]!.valueDecimal, "110000");
});

test("B4: a 'partial' base portfolio value's disclosure survives into BOTH the baseline projection's row methods and a standalone what-if result's row methods", () => {
  const partialBaseFixture: MultiYearProjectionInput = {
    ...COMPOUNDING_FIXTURE,
    assumptions: {
      ...COMPOUNDING_FIXTURE.assumptions,
      currentPortfolioValueStatus: "partial",
    },
  };

  const baseline = projectMultiYearIncome(partialBaseFixture);
  assert.equal(baseline.ok, true);
  if (baseline.ok) {
    for (const row of baseline.rows) {
      assert.match(
        row.method,
        /partial \(understated\) current portfolio value/,
      );
    }
  }

  // The what-if result is what UI-006A can render STANDALONE -- the caller
  // may never see the original `OwnedIncomeProjection.portfolioValueStatus`
  // alongside it, so the disclosure must travel inside the what-if row's
  // OWN `method` string, not just the baseline's.
  const whatIf = projectMultiYearIncomeWhatIf(partialBaseFixture, {
    dividendGrowthPercentDecimal: "2",
  });
  assert.equal(whatIf.ok, true);
  if (whatIf.ok) {
    for (const row of whatIf.rows) {
      assert.match(
        row.method,
        /partial \(understated\) current portfolio value/,
      );
    }
  }

  // An "available" base never carries the note (control case).
  const available = projectMultiYearIncome(COMPOUNDING_FIXTURE);
  assert.equal(available.ok, true);
  if (available.ok) {
    assert.doesNotMatch(available.rows[0]!.method, /partial/);
  }
});

// ---------------------------------------------------------------------------
// c. Past financial-year rows
// ---------------------------------------------------------------------------

function fyTotal(
  overrides: Partial<FyDividendTotal> & { endingYear: number },
): FyDividendTotal {
  return {
    label: `FY${String(overrides.endingYear).slice(-2)}`,
    window: { startDate: "x", endDate: "y" },
    source: "actual",
    cashDecimal: "0",
    frankingKnownDecimal: null,
    frankingUnknownCount: 0,
    unknownAmountCount: 0,
    rowCount: 1,
    ...overrides,
  };
}

test("past-FY rows: owner FY override outranks derived totals and is normalized to cash = grossed - franking", () => {
  const result = computePastFinancialYearRows({
    baseCurrencyCode: "AUD",
    startMonth: 7,
    currentEndingYear: 2026,
    yearsBack: 1,
    securities: [],
    portfolioFyOverrides: [
      {
        endingYear: 2025,
        grossedAmountDecimal: "2000",
        frankingAmountDecimal: "600",
      },
    ],
    historicalPortfolioValueByYear: new Map(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const row = result.rows[0]!;
  assert.equal(row.dividendSource, "fy_override");
  assert.equal(row.dividendGrossDecimal, "2000");
  assert.equal(row.dividendCashDecimal, "1400");
  assert.equal(row.dividendFrankingKnownDecimal, "600");
});

test("past-FY rows: derived totals, value-unavailable disclosure, and effective yield only computed when both parts exist", () => {
  const securities = [
    {
      portfolioSecurityId: "psa",
      symbol: "A",
      currencyCode: "AUD",
      fyTotalsStatus: "ok",
      fyTotals: [
        fyTotal({
          endingYear: 2025,
          source: "actual",
          cashDecimal: "1000",
          frankingKnownDecimal: "300",
        }),
        fyTotal({
          endingYear: 2024,
          source: "provider_estimate",
          cashDecimal: "800",
          frankingKnownDecimal: null,
          frankingUnknownCount: 1,
        }),
      ],
    },
    {
      portfolioSecurityId: "psb",
      symbol: "B",
      currencyCode: "USD",
      fyTotalsStatus: "ok",
      fyTotals: [
        fyTotal({ endingYear: 2025, source: "actual", cashDecimal: "500" }),
      ],
    },
  ];
  const result = computePastFinancialYearRows({
    baseCurrencyCode: "AUD",
    startMonth: 7,
    currentEndingYear: 2026,
    yearsBack: 2,
    securities,
    portfolioFyOverrides: [],
    historicalPortfolioValueByYear: new Map<number, string | null>([
      [2025, "100000"],
      [2024, null],
    ]),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows.length, 2);
  const fy25 = result.rows.find((row) => row.endingYear === 2025)!;
  assert.equal(fy25.dividendSource, "actual");
  assert.equal(fy25.dividendGrossDecimal, "1300"); // 1000 cash + 300 franking
  assert.equal(fy25.includedSecurityCount, 1);
  assert.deepEqual(
    fy25.excludedSecurities.map((entry) => entry.reason),
    ["foreign_currency"],
  );
  assert.equal(fy25.valueStatus, "available");
  assert.equal(fy25.portfolioValueDecimal, "100000");
  assert.equal(fy25.effectiveYieldPercentDecimal, "1.3"); // 1300/100000*100

  const fy24 = result.rows.find((row) => row.endingYear === 2024)!;
  assert.equal(fy24.dividendSource, "provider_estimate");
  assert.equal(fy24.dividendGrossDecimal, "800");
  assert.equal(fy24.dividendFrankingIncomplete, true);
  // Historical value genuinely unavailable for this year -- never a
  // fabricated zero, and no yield derived from a missing denominator.
  assert.equal(fy24.valueStatus, "unavailable");
  assert.equal(fy24.portfolioValueDecimal, null);
  assert.equal(fy24.effectiveYieldPercentDecimal, null);
});

test("follow-up 1: a base-currency security with zero fyTotals entries for a year is 'no_evidence' with a null figure, never an asserted 'actual $0'", () => {
  const result = computePastFinancialYearRows({
    baseCurrencyCode: "AUD",
    startMonth: 7,
    currentEndingYear: 2026,
    yearsBack: 1,
    securities: [
      {
        portfolioSecurityId: "psa",
        symbol: "A",
        currencyCode: "AUD",
        fyTotalsStatus: "ok",
        fyTotals: [], // no evidence either way -- DIV-001 cannot distinguish "paid nothing" from "no data"
      },
    ],
    portfolioFyOverrides: [],
    historicalPortfolioValueByYear: new Map(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.rows[0]!.dividendSource, "no_evidence");
  assert.equal(result.rows[0]!.dividendGrossDecimal, null);
  assert.equal(result.rows[0]!.dividendCashDecimal, null);
  assert.equal(result.rows[0]!.dividendFrankingKnownDecimal, null);
  assert.equal(result.rows[0]!.excludedSecurities.length, 0);
});

test("follow-up 1: a FY predating a security's own dividend history is 'no_evidence' for that year, while a later year with real data still reports normally", () => {
  const result = computePastFinancialYearRows({
    baseCurrencyCode: "AUD",
    startMonth: 7,
    currentEndingYear: 2026,
    yearsBack: 3, // 2025, 2024, 2023
    securities: [
      {
        portfolioSecurityId: "psa",
        symbol: "A",
        currencyCode: "AUD",
        fyTotalsStatus: "ok",
        // The security's history only goes back to FY2025 -- FY2024 and
        // FY2023 (before the holding existed) have no entries at all.
        fyTotals: [
          fyTotal({
            endingYear: 2025,
            source: "actual",
            cashDecimal: "1000",
            frankingKnownDecimal: "0",
          }),
        ],
      },
    ],
    portfolioFyOverrides: [],
    historicalPortfolioValueByYear: new Map(),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const fy25 = result.rows.find((row) => row.endingYear === 2025)!;
  assert.equal(fy25.dividendSource, "actual");
  assert.equal(fy25.dividendGrossDecimal, "1000");
  const fy24 = result.rows.find((row) => row.endingYear === 2024)!;
  assert.equal(fy24.dividendSource, "no_evidence");
  assert.equal(fy24.dividendGrossDecimal, null);
  const fy23 = result.rows.find((row) => row.endingYear === 2023)!;
  assert.equal(fy23.dividendSource, "no_evidence");
  assert.equal(fy23.dividendGrossDecimal, null);
});

test("past-FY rows: rejects yearsBack outside the 0-10 bound", () => {
  const result = computePastFinancialYearRows({
    baseCurrencyCode: "AUD",
    startMonth: 7,
    currentEndingYear: 2026,
    yearsBack: 11,
    securities: [],
    portfolioFyOverrides: [],
    historicalPortfolioValueByYear: new Map(),
  });
  assert.deepEqual(result, { ok: false, reason: "invalid_years" });
});

// ---------------------------------------------------------------------------
// c2. Current (in-progress) financial-year row -- follow-up 2
// ---------------------------------------------------------------------------

test("follow-up 2: the current FY row reports FY-to-date actuals, labelled distinctly from a closed year's 'actual', with the CURRENT (not historical) portfolio value and its own partial/available status", () => {
  const result = computeCurrentFinancialYearRow({
    baseCurrencyCode: "AUD",
    startMonth: 7,
    currentEndingYear: 2026,
    securities: [
      {
        portfolioSecurityId: "psa",
        symbol: "A",
        currencyCode: "AUD",
        fyTotalsStatus: "ok",
        fyTotals: [
          fyTotal({
            endingYear: 2026,
            source: "actual",
            cashDecimal: "400",
            frankingKnownDecimal: "120",
          }),
        ],
      },
    ],
    portfolioFyOverrides: [],
    currentPortfolioValueDecimal: "50000",
    currentPortfolioValueStatus: "partial",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.endingYear, 2026);
  assert.equal(result.row.dividendSource, "fy_to_date");
  assert.equal(result.row.dividendGrossDecimal, "520"); // 400 + 120
  assert.equal(result.row.portfolioValueDecimal, "50000");
  assert.equal(result.row.valueStatus, "partial");
  assert.match(result.row.method, /financial-year-to-date/);
  assert.match(result.row.method, /not a full-year figure/);
  assert.match(result.row.method, /partial known total/);
});

test("follow-up 2: no dividend evidence yet this FY reports 'no_evidence' with a null figure, and a portfolio-value-unavailable row shows portfolioValueDecimal null", () => {
  const result = computeCurrentFinancialYearRow({
    baseCurrencyCode: "AUD",
    startMonth: 7,
    currentEndingYear: 2026,
    securities: [
      {
        portfolioSecurityId: "psa",
        symbol: "A",
        currencyCode: "AUD",
        fyTotalsStatus: "ok",
        fyTotals: [],
      },
    ],
    portfolioFyOverrides: [],
    currentPortfolioValueDecimal: null,
    currentPortfolioValueStatus: "unavailable",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.dividendSource, "no_evidence");
  assert.equal(result.row.dividendGrossDecimal, null);
  assert.equal(result.row.portfolioValueDecimal, null);
  assert.equal(result.row.valueStatus, "unavailable");
  assert.equal(result.row.effectiveYieldPercentDecimal, null);
});

test("follow-up 2: an owner FY override applies to the current year too, outranking the FY-to-date derived sum", () => {
  const result = computeCurrentFinancialYearRow({
    baseCurrencyCode: "AUD",
    startMonth: 7,
    currentEndingYear: 2026,
    securities: [],
    portfolioFyOverrides: [
      {
        endingYear: 2026,
        grossedAmountDecimal: "700",
        frankingAmountDecimal: "200",
      },
    ],
    currentPortfolioValueDecimal: "100000",
    currentPortfolioValueStatus: "available",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.dividendSource, "fy_override");
  assert.equal(result.row.dividendGrossDecimal, "700");
  assert.equal(result.row.dividendCashDecimal, "500");
});

// ---------------------------------------------------------------------------
// d. Single-12-month breakdown
// ---------------------------------------------------------------------------

function forecast(
  overrides: Partial<SecurityDividendForecast>,
): SecurityDividendForecast {
  return {
    portfolioSecurityId: "p",
    currencyCode: "AUD",
    windowFromDate: "2026-01-01",
    windowToDate: "2026-12-31",
    currentSharesDecimal: "10",
    status: "fully_covered_by_declared",
    declaredCashDecimal: "0",
    declaredFrankingKnownDecimal: "0",
    declaredFrankingUnknownCount: 0,
    declaredEventCount: 0,
    declaredUnknownAmountCount: 0,
    uncoveredDays: 0,
    uncoveredCashDecimal: "0",
    uncoveredFrankingKnownDecimal: "0",
    uncoveredReason: null,
    totalCashDecimal: "0",
    totalFrankingKnownDecimal: "0",
    totalFrankingIncomplete: false,
    totalGrossDecimal: "0",
    ttmSource: null,
    ttmIncomplete: false,
    ttmPerShareDecimal: null,
    ...overrides,
  };
}

test("income breakdown: aggregates gross/cash/franking, divisor conventions (gross/12, gross/52), and income % of current value", () => {
  const result = computeIncomeBreakdown({
    baseCurrencyCode: "AUD",
    currentPortfolioValueDecimal: "100000",
    currentPortfolioValueStatus: "available",
    securities: [
      {
        portfolioSecurityId: "psa",
        symbol: "A",
        currencyCode: "AUD",
        forecast: forecast({
          totalCashDecimal: "1200",
          totalFrankingKnownDecimal: "360",
          totalGrossDecimal: "1560",
        }),
      },
    ],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.totalGrossDecimal, "1560");
  assert.equal(result.totalCashDecimal, "1200");
  assert.equal(result.totalFrankingKnownDecimal, "360");
  assert.equal(result.averagePerMonthDecimal, "130"); // 1560/12
  assert.equal(result.averagePerWeekDecimal, "30"); // 1560/52
  assert.equal(result.incomePercentOfValueDecimal, "1.56"); // 1560/100000*100
  assert.equal(result.includedSecurityCount, 1);
  assert.equal(result.excludedSecurities.length, 0);
});

test("income breakdown: insufficient-history and foreign-currency securities are excluded and named, disclosed as partial coverage -- never folded in as zero", () => {
  const result = computeIncomeBreakdown({
    baseCurrencyCode: "AUD",
    currentPortfolioValueDecimal: "100000",
    currentPortfolioValueStatus: "available",
    securities: [
      {
        portfolioSecurityId: "psa",
        symbol: "A",
        currencyCode: "AUD",
        forecast: forecast({
          totalCashDecimal: "1200",
          totalFrankingKnownDecimal: "360",
          totalGrossDecimal: "1560",
        }),
      },
      {
        portfolioSecurityId: "psc",
        symbol: "C",
        currencyCode: "AUD",
        forecast: forecast({
          status: "insufficient_history",
          totalCashDecimal: null,
          totalFrankingKnownDecimal: null,
          totalGrossDecimal: null,
          totalFrankingIncomplete: true,
        }),
      },
      {
        portfolioSecurityId: "psd",
        symbol: "D",
        currencyCode: "USD",
        forecast: forecast({ totalGrossDecimal: "999" }),
      },
    ],
  });
  assert.equal(result.status, "partial");
  assert.equal(result.totalGrossDecimal, "1560"); // only A counted
  assert.equal(result.includedSecurityCount, 1);
  assert.equal(result.excludedSecurities.length, 2);
  assert.deepEqual(
    result.excludedSecurities.map((entry) => entry.portfolioSecurityId).sort(),
    ["psc", "psd"],
  );
  const insufficient = result.excludedSecurities.find(
    (entry) => entry.portfolioSecurityId === "psc",
  )!;
  assert.equal(insufficient.reason, "insufficient_history");
  const foreign = result.excludedSecurities.find(
    (entry) => entry.portfolioSecurityId === "psd",
  )!;
  assert.equal(foreign.reason, "foreign_currency");
});

test("DIV-006 review follow-up: a security whose history TTM is only partially determinable is INCLUDED (not excluded) but the breakdown discloses the incompleteness", () => {
  const result = computeIncomeBreakdown({
    baseCurrencyCode: "AUD",
    currentPortfolioValueDecimal: "100000",
    currentPortfolioValueStatus: "available",
    securities: [
      {
        portfolioSecurityId: "psa",
        symbol: "A",
        currencyCode: "AUD",
        forecast: forecast({
          totalCashDecimal: "1200",
          totalFrankingKnownDecimal: "360",
          totalGrossDecimal: "1560",
        }),
      },
      {
        portfolioSecurityId: "psb",
        symbol: "B",
        currencyCode: "AUD",
        forecast: forecast({
          status: "declared_plus_ttm",
          totalCashDecimal: "500",
          totalFrankingKnownDecimal: "0",
          totalGrossDecimal: "500",
          ttmSource: "history_ttm",
          ttmIncomplete: true,
        }),
      },
    ],
  });
  // Included -- contributes its real (possibly understated) figure, never
  // excluded/dropped a second time.
  assert.equal(result.includedSecurityCount, 2);
  assert.equal(result.excludedSecurities.length, 0);
  assert.equal(result.totalGrossDecimal, "2060"); // 1560 + 500, both counted
  // But the aggregate is honestly flagged partial, and the affected security
  // is named -- never silently presented as a complete total.
  assert.equal(result.status, "partial");
  assert.equal(result.partialTtmSecurities.length, 1);
  assert.equal(result.partialTtmSecurities[0]!.portfolioSecurityId, "psb");
  assert.match(result.method, /partially determinable/);
});

test("DIV-006 review follow-up: every included security's TTM fully determinable keeps status 'ok', with an empty partialTtmSecurities list", () => {
  const result = computeIncomeBreakdown({
    baseCurrencyCode: "AUD",
    currentPortfolioValueDecimal: "100000",
    currentPortfolioValueStatus: "available",
    securities: [
      {
        portfolioSecurityId: "psa",
        symbol: "A",
        currencyCode: "AUD",
        forecast: forecast({
          status: "declared_plus_ttm",
          totalCashDecimal: "1200",
          totalFrankingKnownDecimal: "360",
          totalGrossDecimal: "1560",
          ttmSource: "history_ttm",
          ttmIncomplete: false, // fully determinable -- not partial
        }),
      },
    ],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.partialTtmSecurities.length, 0);
  assert.equal(result.totalGrossDecimal, "1560");
});

test("income breakdown: a zero-current-holding forecast (a real fact) is included as an honest 0, not excluded", () => {
  const result = computeIncomeBreakdown({
    baseCurrencyCode: "AUD",
    currentPortfolioValueDecimal: "100000",
    currentPortfolioValueStatus: "available",
    securities: [
      {
        portfolioSecurityId: "psa",
        symbol: "A",
        currencyCode: "AUD",
        forecast: forecast({
          status: "no_current_holding",
          totalCashDecimal: "0",
          totalFrankingKnownDecimal: "0",
          totalGrossDecimal: "0",
        }),
      },
    ],
  });
  assert.equal(result.status, "ok");
  assert.equal(result.totalGrossDecimal, "0");
  assert.equal(result.includedSecurityCount, 1);
  assert.equal(result.excludedSecurities.length, 0);
});

test("income breakdown: no coverage at all is explicit, not a fabricated zero total", () => {
  const result = computeIncomeBreakdown({
    baseCurrencyCode: "AUD",
    currentPortfolioValueDecimal: null,
    currentPortfolioValueStatus: "unavailable",
    securities: [],
  });
  assert.equal(result.status, "no_coverage");
  assert.equal(result.totalGrossDecimal, null);
  assert.equal(result.incomePercentOfValueDecimal, null);
  assert.equal(result.incomePercentOfValueStatus, "unavailable");
});

test("B2: income % of value carries a 'partial' denominator flag when the current portfolio value is itself only a partial known total", () => {
  const result = computeIncomeBreakdown({
    baseCurrencyCode: "AUD",
    currentPortfolioValueDecimal: "100000", // a real but understated known total
    currentPortfolioValueStatus: "partial",
    securities: [
      {
        portfolioSecurityId: "psa",
        symbol: "A",
        currencyCode: "AUD",
        forecast: forecast({
          totalCashDecimal: "1200",
          totalFrankingKnownDecimal: "360",
          totalGrossDecimal: "1560",
        }),
      },
    ],
  });
  // The percent is still computed (the honest best-known number) but flagged.
  assert.equal(result.incomePercentOfValueDecimal, "1.56");
  assert.equal(result.incomePercentOfValueStatus, "partial");
});

// ---------------------------------------------------------------------------
// Service layer: owner-scoped, cross-user isolation
// ---------------------------------------------------------------------------

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const files = (await readdir(new URL("../drizzle", import.meta.url)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(
      await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
  return db;
}

async function serviceFixture(): Promise<DatabaseSync> {
  const db = await migratedDatabase();
  db.exec(`
    INSERT INTO currencies(code,numeric_code,name,minor_unit_digits) VALUES('AUD',36,'Australian dollar',2);
    INSERT INTO users(id,status,primary_email,timezone,created_at,updated_at) VALUES
      ('a','active','a@example.test','Australia/Sydney','2026-08-01','2026-08-01'),
      ('b','active','b@example.test','Australia/Sydney','2026-08-01','2026-08-01');
    INSERT INTO user_settings(user_id,home_currency_code,timezone,financial_year_start_month,created_at,updated_at,version) VALUES
      ('a','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1),
      ('b','AUD','Australia/Sydney',7,'2026-08-01','2026-08-01',1);
    INSERT INTO portfolios(id,user_id,code,name,base_currency_code,timezone,accounting_method,status,created_at,updated_at) VALUES
      ('pa','a','A','A portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pb','b','B','B portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01'),
      ('pe','a','E','A empty portfolio','AUD','Australia/Sydney','fifo','active','2026-08-01','2026-08-01');
    INSERT INTO securities(id,asset_type,primary_currency_code,canonical_name,created_at,updated_at) VALUES
      ('s','equity','AUD','Shared Co','2026-08-01','2026-08-01');
    INSERT INTO portfolio_securities(id,user_id,portfolio_id,security_id,source_symbol,source_currency_code,status,created_at,updated_at) VALUES
      ('psa','a','pa','s','S','AUD','held','2026-08-01','2026-08-01'),
      ('psb','b','pb','s','S','AUD','held','2026-08-01','2026-08-01');
    INSERT INTO market_data_providers(id,code,name,capabilities_json,rate_limit_json) VALUES('p','p','Provider','{}','{}');
    INSERT INTO dividend_events(id,security_id,provider_id,kind,status,ex_date,currency_code,gross_per_share_decimal,observed_at,ingested_at,created_at) VALUES
      ('de','s','p','cash','paid','2026-03-01','AUD','1','2026-03-01T00:00:00Z','2026-03-01T00:00:00Z','2026-03-01');
    INSERT INTO transactions(id,user_id,portfolio_id,portfolio_security_id,type,status,trade_at,local_trade_date,quantity_decimal,unit_price_decimal,currency_code,gross_amount_decimal,fee_amount_decimal,tax_amount_decimal,source_type,created_by_user_id,calculation_version,created_at) VALUES
      ('txa','a','pa','psa','buy','posted','2026-01-01T00:00:00Z','2026-01-01','10','5','AUD','50','0','0','manual','a',1,'2026-01-01'),
      ('txb','b','pb','psb','buy','posted','2026-01-01T00:00:00Z','2026-01-01','5','5','AUD','25','0','0','manual','b',1,'2026-01-01');
  `);
  return db;
}

test("service layer: cross-user access to another owner's portfolio is rejected", async () => {
  const db = await serviceFixture();
  const client = createSqliteSqlClient(db);
  await assert.rejects(
    () =>
      loadOwnedIncomeProjection(
        client,
        "a",
        "pb",
        new Date("2026-08-13T00:00:00Z"),
      ),
    /not_owned/,
  );
});

test("service layer: an empty portfolio (no held securities) is an explicit empty state, not a fabricated projection", async () => {
  const db = await serviceFixture();
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pe",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(projection.status, "empty");
  assert.equal(projection.assumptionGrid.length, 0);
  assert.equal(projection.breakdown.status, "no_coverage");
});

test("service layer: without a published holdings calculation, portfolio value and the multi-year projection honestly degrade to unavailable -- yield resolution still runs and reports a typed reason (price_unavailable) rather than throwing", async () => {
  const db = await serviceFixture();
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(projection.status, "ok");
  assert.equal(projection.portfolioValueStatus, "unavailable");
  assert.equal(projection.currentPortfolioValueDecimal, null);
  assert.equal(projection.portfolioValueCoverage, null);
  assert.equal(projection.assumptionGrid.length, 1);
  const security = projection.assumptionGrid[0]!;
  assert.equal(security.portfolioSecurityId, "psa");
  // No owner override, no holdings price -> the provider TTM yield cannot be
  // computed (no current price to divide by), an honest typed reason.
  assert.equal(security.yield.source, "none");
  assert.equal(security.yield.status, "price_unavailable");

  // B3: a degraded portfolio value must surface a typed reason, never the
  // old blanket `invalid_decimal`, and must never hand back a baseline
  // input a caller could feed straight into what-if to get a confident
  // all-zero `ok: true` projection.
  assert.deepEqual(projection.multiYear, {
    ok: false,
    reason: "portfolio_value_unavailable",
  });
  assert.equal(projection.multiYearBaselineInput, null);

  // The current-FY row is independent of the forward multi-year projection
  // -- it still resolves (dividend evidence + value status), even though
  // the multi-year projection itself is unavailable.
  assert.equal(projection.currentFinancialYear.ok, true);
});

test("B3: a portfolio with a known (cash-only) value but no security at all reports 'no_yield_coverage', not the old blanket 'invalid_decimal' and not a fabricated zero-yield projection", async () => {
  const db = await serviceFixture();
  // The zero-held-securities "pe" portfolio takes `loadOwnedHoldings`'s
  // early cash-only return path (no `projection_publications`/
  // `calculation_runs` needed at all), so a real, known, non-zero portfolio
  // value is achievable here without standing up the full holdings pipeline
  // -- isolating "value known, yield coverage impossible" (there are no
  // securities to resolve a yield for) from "value unknown" (B3's other
  // typed reason, covered by the previous test).
  db.exec(`
    INSERT INTO cash_accounts(id,user_id,portfolio_id,currency_code,completeness,status) VALUES
      ('ca-e','a','pe','AUD','complete','active');
    INSERT INTO cash_ledger_entries(id,user_id,portfolio_id,cash_account_id,transaction_id,effective_at,local_effective_date,type,signed_amount_decimal,status,created_at) VALUES
      ('cle-e','a','pe','ca-e',NULL,'2026-01-01T00:00:00Z','2026-01-01','cash_deposit','5000','posted','2026-01-01');
  `);
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pe",
    new Date("2026-08-13T00:00:00Z"),
  );
  assert.equal(projection.currentPortfolioValueDecimal, "5000");
  assert.equal(projection.portfolioValueStatus, "available");
  assert.equal(projection.aggregateYield.status, "no_coverage");
  assert.deepEqual(projection.multiYear, {
    ok: false,
    reason: "no_yield_coverage",
  });
  assert.equal(projection.multiYearBaselineInput, null);
});

test("follow-up 3: yearsForward: 0 is explicitly rejected at the service boundary, never silently forced up to 1", async () => {
  const db = await serviceFixture();
  const client = createSqliteSqlClient(db);
  const projection = await loadOwnedIncomeProjection(
    client,
    "a",
    "pa",
    new Date("2026-08-13T00:00:00Z"),
    { yearsForward: 0 },
  );
  assert.deepEqual(projection.multiYear, {
    ok: false,
    reason: "invalid_years",
  });
  assert.equal(projection.multiYearBaselineInput, null);
});
