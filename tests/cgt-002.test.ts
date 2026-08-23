// CGT-002: capital loss carry-forward chained across financial years.
//
// Part 1 (pure, no DB): `domain/gains/carry-forward.ts`'s
// `computeCapitalGainsCarryChain` -- multi-FY chains, the ordering-
// discriminating fixtures that pin "current-year losses first, then
// carry-in, before the 50% discount", the history-completeness predicate,
// partial-coverage taint propagation, the earliest-FY boundary case, and
// decimal exactness. Fixtures build real `FyCapitalGainsTotal[]` via the
// already-tested `computeFyCapitalGainsTotals` (CGT-001A) rather than
// hand-crafting the derived per-FY fields, so this suite only has to
// independently verify the NEW carry-chain arithmetic layered on top.
//
// Part 2: `app/components/capital-gains-screen.tsx`'s carried columns,
// relabelled lifetime line, dialog standalone-vs-carried sections, and the
// renamed `CGT_CARRY_FORWARD_NOTE` index assertion.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { computeFyCapitalGainsTotals } from "../domain/gains/fy-aggregation.ts";
import {
  CGT_CARRY_FORWARD_NOTE,
  computeCapitalGainsCarryChain,
} from "../domain/gains/carry-forward.ts";
import type { CapitalGainDisposalRow } from "../domain/gains/disposal-rows.ts";

// ===========================================================================
// Part 1: domain/gains/carry-forward.ts
// ===========================================================================

// Mirrors `tests/cgt-001a.test.ts`'s own `row()` fixture helper exactly
// (independent per-file fixture, not shared/imported, matching this
// codebase's existing per-test-file convention).
function row(
  overrides: Partial<CapitalGainDisposalRow>,
): CapitalGainDisposalRow {
  return {
    allocationId: "alloc",
    portfolioSecurityId: "membership-a",
    securitySymbol: "ABC",
    securityName: "ABC Holdings",
    acquiredDate: "2024-01-01",
    disposedDate: "2026-01-15",
    quantityDecimal: "1",
    proceedsDecimal: "0",
    basisDecimal: "0",
    feeDecimal: "0",
    taxDecimal: "0",
    gainDecimal: "0",
    basisStatus: "complete",
    holdingPeriodEligible: true,
    discountThresholdDate: "2025-01-01",
    eligibility: "not_applicable_zero",
    ...overrides,
  };
}

function fyTotals(rows: CapitalGainDisposalRow[], startMonth = 7) {
  const result = computeFyCapitalGainsTotals(rows, startMonth);
  assert.ok(result.ok, "expected computeFyCapitalGainsTotals to succeed");
  if (!result.ok) throw new Error("unreachable");
  return result.totals;
}

test("CGT-002 chain: a loss -> gain -> loss shape carries the FY23 loss into FY24 (partially absorbing the gain) and reports FY25's own new loss standalone", () => {
  // Hand-computed (whole-dollar amounts, no rounding needed):
  //   FY23: loss 1000, no gains -> standalone net 0, unabsorbed 1000 -> carries out 1000.
  //   FY24: discountable gain 1500, no current-year loss.
  //     carry-in 1000 -> non-discountable (none) first, then discountable:
  //     remaining discountable = 1500 - 1000 = 500; discount = 250;
  //     carried net = 0 + 250 = 250. Carry-in fully absorbed -> carries out 0.
  //   FY25: loss 300, no gains, no carry-in (FY24 carried out 0) ->
  //     standalone/carried net 0, unabsorbed 300 -> carries out 300.
  const totals = fyTotals([
    row({
      allocationId: "L1",
      disposedDate: "2023-01-15",
      gainDecimal: "-1000",
      eligibility: "not_applicable_loss",
    }),
    row({
      allocationId: "G1",
      disposedDate: "2024-01-10",
      gainDecimal: "1500",
      holdingPeriodEligible: true,
      eligibility: "discount_eligible",
    }),
    row({
      allocationId: "L2",
      disposedDate: "2025-02-01",
      gainDecimal: "-300",
      eligibility: "not_applicable_loss",
    }),
  ]);
  const chain = computeCapitalGainsCarryChain(totals, "2022-07-01");
  assert.equal(chain.historyComplete, true);
  assert.equal(chain.earliestFyStartDate, "2022-07-01");
  assert.equal(chain.perFy.length, 3);

  const byYear = new Map(chain.perFy.map((fy) => [fy.endingYear, fy]));
  const fy23 = byYear.get(2023)!;
  assert.equal(fy23.carryInLossDecimal, "0"); // earliest FY -- no prior data
  assert.equal(fy23.netCapitalGainEstimateDecimal, "0");
  assert.equal(fy23.carryOutLossDecimal, "1000");
  assert.equal(fy23.carriedFiguresPartial, false);

  const fy24 = byYear.get(2024)!;
  assert.equal(fy24.carryInLossDecimal, "1000");
  assert.equal(fy24.carryInAppliedToNonDiscountableDecimal, "0");
  assert.equal(fy24.carryInAppliedToDiscountableDecimal, "1000");
  assert.equal(fy24.carryInAppliedDecimal, "1000");
  assert.equal(fy24.remainingDiscountableAfterCarryInDecimal, "500");
  assert.equal(fy24.discountAppliedDecimal, "250");
  assert.equal(fy24.netCapitalGainEstimateDecimal, "250"); // NOT the standalone 750
  assert.equal(fy24.carryOutLossDecimal, "0");

  const fy25 = byYear.get(2025)!;
  assert.equal(fy25.carryInLossDecimal, "0");
  assert.equal(fy25.netCapitalGainEstimateDecimal, "0");
  assert.equal(fy25.carryOutLossDecimal, "300");

  assert.equal(chain.lifetimeNetCapitalGainEstimateDecimal, "250");
  assert.equal(chain.lifetimeNetPartial, false);
  assert.equal(chain.finalCarryOutLossDecimal, "300"); // still owed forward, FY25's own new loss
});

// Reviewer follow-up 3: every earlier fixture in this file has a FY that
// carries a loss in OR out, but never both a carry-IN and its OWN
// current-year loss in the SAME financial year. Pinning that combined
// case, independently hand-computed:
//   FY23: loss 500, no gains -> carries out 500.
//   FY24: discountable gain 1200.60, ITS OWN current-year loss 100 (a
//     second, separate loss row disposed the same FY), plus the 500
//     carried in from FY23.
//   Standalone (fy-aggregation.ts, current-year loss only):
//     remaining discountable after FY24's OWN loss = 1200.60 - 100 = 1100.60
//     discount = 550.30; standalone net = 550.30.
//   Carried (this module, current-year loss ALREADY applied above, then
//   the carry-in on top, same non-discountable-then-discountable priority,
//   before the discount):
//     remaining discountable after carry-in = 1100.60 - 500 = 600.60
//     discount = 300.30; carried (true) net = 300.30.
//     Carry-in fully absorbed (500 <= 600.60 gross) -> carries out 0.
test("CGT-002 combined fixture: a FY with BOTH its own current-year loss AND a carry-in applies both, in the ruled order, before the discount", () => {
  const totals = fyTotals([
    row({
      allocationId: "P",
      disposedDate: "2023-01-15",
      gainDecimal: "-500",
      eligibility: "not_applicable_loss",
    }),
    row({
      allocationId: "G",
      disposedDate: "2024-01-10",
      gainDecimal: "1200.60",
      holdingPeriodEligible: true,
      eligibility: "discount_eligible",
    }),
    row({
      allocationId: "L",
      disposedDate: "2024-02-10",
      gainDecimal: "-100",
      eligibility: "not_applicable_loss",
    }),
  ]);
  const fy24Standalone = totals.find((fy) => fy.endingYear === 2024)!;
  assert.equal(fy24Standalone.totalLossesDecimal, "100");
  assert.equal(fy24Standalone.remainingDiscountableAfterLossDecimal, "1100.6");
  assert.equal(fy24Standalone.discountAppliedDecimal, "550.3");
  assert.equal(fy24Standalone.netCapitalGainEstimateDecimal, "550.3"); // standalone, no carry-in

  const chain = computeCapitalGainsCarryChain(totals, "2022-07-01");
  const fy24 = chain.perFy.find((fy) => fy.endingYear === 2024)!;
  assert.equal(fy24.carryInLossDecimal, "500");
  assert.equal(fy24.carryInAppliedDecimal, "500");
  assert.equal(fy24.remainingDiscountableAfterCarryInDecimal, "600.6");
  assert.equal(fy24.discountAppliedDecimal, "300.3");
  assert.equal(fy24.netCapitalGainEstimateDecimal, "300.3"); // carried, true -- own loss AND carry-in both applied
  assert.equal(fy24.carryOutLossDecimal, "0");
});

test("CGT-002 ordering-discriminating fixture: carry-in must reduce the PRE-discount discountable gain, not the already-discounted standalone net", () => {
  // FY23: loss 200 -> carries out 200.
  // FY24: discountable gain 1000, no current-year loss.
  //   RULED (correct): carry-in reduces the gross discountable amount
  //   BEFORE the discount: 1000 - 200 = 800; discount 50% = 400; net = 400.
  //   WRONG (naive: subtract the carry-in from the already-discounted
  //   standalone net, i.e. treat it like a post-discount credit):
  //   standalone net = 1000 * 0.50 = 500; 500 - 200 = 300.
  // These differ (400 vs 300) -- this is the "carry-in vs discount timing"
  // subtlety the ruling pins ("... before the 50% discount").
  const totals = fyTotals([
    row({
      allocationId: "L",
      disposedDate: "2023-01-15",
      gainDecimal: "-200",
      eligibility: "not_applicable_loss",
    }),
    row({
      allocationId: "G",
      disposedDate: "2024-01-10",
      gainDecimal: "1000",
      holdingPeriodEligible: true,
      eligibility: "discount_eligible",
    }),
  ]);
  const chain = computeCapitalGainsCarryChain(totals, "2022-07-01");
  const fy24 = chain.perFy.find((fy) => fy.endingYear === 2024)!;

  const naiveWrong = 500 - 200; // = 300 -- NOT what the ruled order produces
  assert.equal(fy24.netCapitalGainEstimateDecimal, "400");
  assert.notEqual(fy24.netCapitalGainEstimateDecimal, String(naiveWrong));
});

test("CGT-002 ordering-discriminating fixture: carry-in offsets non-discountable gains before discountable, exactly like current-year losses", () => {
  // FY23: loss 200 -> carries out 200.
  // FY24: non-discountable gain 100, discountable gain 1000, no
  //   current-year loss.
  //   RULED (correct, non-discountable first): carry-in 200 -> min(200,100)
  //   applied to non-discountable (remaining 0), 100 leftover applied to
  //   discountable: 1000 - 100 = 900; discount 450; net = 0 + 450 = 450.
  //   WRONG (a naive implementation that only ever offsets the discountable
  //   bucket, skipping non-discountable): 1000 - 200 = 800; discount 400;
  //   net = 100 (non-discountable untouched) + 400 = 500.
  // These differ (450 vs 500).
  const totals = fyTotals([
    row({
      allocationId: "L",
      disposedDate: "2023-01-15",
      gainDecimal: "-200",
      eligibility: "not_applicable_loss",
    }),
    row({
      allocationId: "N",
      disposedDate: "2024-01-10",
      gainDecimal: "100",
      holdingPeriodEligible: false,
      eligibility: "discount_ineligible",
    }),
    row({
      allocationId: "G",
      disposedDate: "2024-02-10",
      gainDecimal: "1000",
      holdingPeriodEligible: true,
      eligibility: "discount_eligible",
    }),
  ]);
  const chain = computeCapitalGainsCarryChain(totals, "2022-07-01");
  const fy24 = chain.perFy.find((fy) => fy.endingYear === 2024)!;

  assert.equal(fy24.carryInAppliedToNonDiscountableDecimal, "100");
  assert.equal(fy24.carryInAppliedToDiscountableDecimal, "100");
  assert.equal(fy24.netCapitalGainEstimateDecimal, "450");
  assert.notEqual(fy24.netCapitalGainEstimateDecimal, "500");
});

test("CGT-002 history-completeness predicate: null history_complete_from is incomplete, with 'unknown' wording", () => {
  const totals = fyTotals([
    row({ disposedDate: "2024-03-01", gainDecimal: "100" }),
  ]);
  const chain = computeCapitalGainsCarryChain(totals, null);
  assert.equal(chain.historyComplete, false);
  assert.match(chain.historyIncompleteMessage!, /unknown/);
  assert.match(
    chain.historyIncompleteMessage!,
    /no declared history-completeness date/,
  );
  assert.equal(chain.perFy[0]!.carriedFiguresPartial, true);
  assert.equal(chain.lifetimeNetPartial, true);
});

test("CGT-002 history-completeness predicate: history_complete_from exactly on the earliest FY's start date is complete", () => {
  const totals = fyTotals([
    row({ disposedDate: "2024-03-01", gainDecimal: "100" }),
  ]);
  assert.equal(totals[0]!.window.startDate, "2023-07-01");
  const chain = computeCapitalGainsCarryChain(totals, "2023-07-01");
  assert.equal(chain.historyComplete, true);
  assert.equal(chain.historyIncompleteMessage, null);
  assert.equal(chain.perFy[0]!.carriedFiguresPartial, false);
});

test("CGT-002 history-completeness predicate: history_complete_from BEFORE the earliest FY's start date is complete", () => {
  const totals = fyTotals([
    row({ disposedDate: "2024-03-01", gainDecimal: "100" }),
  ]);
  const chain = computeCapitalGainsCarryChain(totals, "2023-06-01");
  assert.equal(chain.historyComplete, true);
  assert.equal(chain.historyIncompleteMessage, null);
});

test("CGT-002 history-completeness predicate: history_complete_from AFTER the earliest FY's start date is incomplete, naming the exact date", () => {
  const totals = fyTotals([
    row({ disposedDate: "2024-03-01", gainDecimal: "100" }),
  ]);
  const chain = computeCapitalGainsCarryChain(totals, "2023-08-01");
  assert.equal(chain.historyComplete, false);
  assert.match(chain.historyIncompleteMessage!, /2023-08-01/);
  // Distinct wording from the null case above -- this is a DATED boundary,
  // not "we have no idea at all".
  assert.doesNotMatch(
    chain.historyIncompleteMessage!,
    /no declared history-completeness date/,
  );
});

test("CGT-002 partial-propagation taint: an incomplete-basis FY taints its own carried figures AND every later FY's, even though the later FY has full coverage of its own", () => {
  const totals = fyTotals([
    row({
      allocationId: "P1",
      disposedDate: "2023-01-15",
      gainDecimal: "-500",
      eligibility: "not_applicable_loss",
    }),
    // Excluded from FY23's totals -- unknown gain, never a fabricated zero.
    row({
      allocationId: "P1incomplete",
      disposedDate: "2023-03-01",
      gainDecimal: null,
      basisStatus: "incomplete_basis",
      eligibility: "unknown_incomplete_basis",
    }),
    row({
      allocationId: "P2",
      disposedDate: "2024-01-10",
      gainDecimal: "800",
      holdingPeriodEligible: true,
      eligibility: "discount_eligible",
    }),
  ]);
  assert.equal(
    totals.find((fy) => fy.endingYear === 2023)!.partialCoverage,
    true,
  );
  assert.equal(
    totals.find((fy) => fy.endingYear === 2024)!.partialCoverage,
    false,
  );

  const chain = computeCapitalGainsCarryChain(totals, "2022-07-01");
  const fy23 = chain.perFy.find((fy) => fy.endingYear === 2023)!;
  const fy24 = chain.perFy.find((fy) => fy.endingYear === 2024)!;
  assert.equal(fy23.ownPartialCoverage, true);
  assert.equal(fy23.carriedFiguresPartial, true);
  // FY24's OWN coverage is full, but it is still tainted: FY23's
  // unabsorbed loss (which carries into FY24) was computed excluding an
  // allocation whose real gain/loss is unknown, so FY24's carried figures
  // may be understated/overstated as a result.
  assert.equal(fy24.ownPartialCoverage, false);
  assert.equal(fy24.carriedFiguresPartial, true);
  assert.equal(chain.lifetimeNetPartial, true);
});

test("CGT-002 boundary: the earliest disposal FY (no prior chain data) carries in nothing and its carried figures equal its standalone figures", () => {
  const totals = fyTotals([
    row({ disposedDate: "2024-03-01", gainDecimal: "100" }),
  ]);
  const chain = computeCapitalGainsCarryChain(totals, "2023-07-01");
  const only = chain.perFy[0]!;
  assert.equal(only.carryInLossDecimal, "0");
  assert.equal(only.carryInAppliedDecimal, "0");
  assert.equal(
    only.netCapitalGainEstimateDecimal,
    totals[0]!.netCapitalGainEstimateDecimal,
  );
  assert.equal(only.carryOutLossDecimal, totals[0]!.unabsorbedLossDecimal);
});

test("CGT-002 decimal exactness: fractional-cent carry-in and carry-out survive the chain exactly, no floating-point drift", () => {
  // FY23 loss 333.33 -> carries out 333.33.
  // FY24 gain 111.11, discountable, no current-year loss:
  //   carry-in 333.33 applied to discountable: min(333.33, 111.11) = 111.11
  //   applied; remaining discountable = 0; discount = 0; net = 0.
  //   carry-in left unapplied = 333.33 - 111.11 = 222.22 -> carries out.
  const totals = fyTotals([
    row({
      allocationId: "D1",
      disposedDate: "2023-01-15",
      gainDecimal: "-333.33",
      eligibility: "not_applicable_loss",
    }),
    row({
      allocationId: "D2",
      disposedDate: "2024-01-10",
      gainDecimal: "111.11",
      holdingPeriodEligible: true,
      eligibility: "discount_eligible",
    }),
  ]);
  const chain = computeCapitalGainsCarryChain(totals, "2022-07-01");
  const fy24 = chain.perFy.find((fy) => fy.endingYear === 2024)!;
  assert.equal(fy24.carryInLossDecimal, "333.33");
  assert.equal(fy24.carryInAppliedDecimal, "111.11");
  assert.equal(fy24.remainingDiscountableAfterCarryInDecimal, "0");
  assert.equal(fy24.netCapitalGainEstimateDecimal, "0");
  assert.equal(fy24.carryOutLossDecimal, "222.22");
});

test("CGT-002: an empty FY list rolls up to a vacuously-complete, empty chain rather than throwing", () => {
  const chain = computeCapitalGainsCarryChain([], null);
  assert.equal(chain.historyComplete, true);
  assert.equal(chain.historyIncompleteMessage, null);
  assert.equal(chain.earliestFyStartDate, null);
  assert.deepEqual(chain.perFy, []);
  assert.equal(chain.lifetimeNetCapitalGainEstimateDecimal, "0");
  assert.equal(chain.lifetimeNetPartial, false);
  assert.equal(chain.finalCarryOutLossDecimal, "0");
});

// Reviewer follow-up 5: `computeFyCapitalGainsTotals` never itself produces
// two entries with the same `endingYear`, but this function accepts a bare
// array from any caller and should stay total (never throw) on a malformed
// duplicate-year input -- documented first-wins (see the function's header
// comment): the FIRST entry for a given year is the one actually chained;
// every ORIGINAL entry still gets a `perFy` row (mapped back onto that same
// first-wins result), so `perFy.length` always matches the input length.
test("CGT-002: a duplicate-year input is handled by documented first-wins, never a throw, and perFy stays the same length as the input", () => {
  const totalA = fyTotals([
    row({
      allocationId: "A",
      disposedDate: "2024-01-10",
      gainDecimal: "100",
      holdingPeriodEligible: true,
      eligibility: "discount_eligible",
    }),
  ])[0]!;
  const totalB = fyTotals([
    row({
      allocationId: "B",
      disposedDate: "2024-03-10",
      gainDecimal: "900",
      holdingPeriodEligible: true,
      eligibility: "discount_eligible",
    }),
  ])[0]!;
  assert.equal(totalA.endingYear, 2024);
  assert.equal(totalB.endingYear, 2024);
  assert.notEqual(
    totalA.netCapitalGainEstimateDecimal,
    totalB.netCapitalGainEstimateDecimal,
  );

  const chain = computeCapitalGainsCarryChain([totalA, totalB], "2023-07-01");
  assert.equal(chain.perFy.length, 2); // one row per ORIGINAL entry, not per distinct year
  // Both rows resolve to totalA's (the first entry's) carried result --
  // totalA's standalone net (50, after its own eligibility split) is the
  // ONLY figure chained; totalB is silently dropped from the chain math,
  // per the documented first-wins contract.
  assert.equal(chain.perFy[0]!.netCapitalGainEstimateDecimal, "50");
  assert.equal(chain.perFy[1]!.netCapitalGainEstimateDecimal, "50");
  assert.equal(chain.perFy[0], chain.perFy[1]); // literally the same object
});

test("CGT-002: the standing carry-forward note is a non-empty, documented string", () => {
  assert.ok(CGT_CARRY_FORWARD_NOTE.length > 0);
  assert.match(CGT_CARRY_FORWARD_NOTE, /carry forward/);
});

// ===========================================================================
// Part 2: app/components/capital-gains-screen.tsx
// ===========================================================================

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

// Same shape as the domain-level "ordering-discriminating" fixture above:
// FY23 loss 200 (carries out), FY24 discountable gain 1000 (standalone net
// 500, carried/true net 400). Fully complete history, no incomplete-basis
// rows -- untainted, so these render tests can assert absence of the "*"
// marker independently of the taint-specific test below.
const cleanTotals = fyTotals([
  row({
    allocationId: "L",
    disposedDate: "2023-01-15",
    gainDecimal: "-200",
    eligibility: "not_applicable_loss",
    securityName: "Loss Co",
  }),
  row({
    allocationId: "G",
    disposedDate: "2024-01-10",
    gainDecimal: "1000",
    holdingPeriodEligible: true,
    eligibility: "discount_eligible",
    securityName: "Gain Co",
  }),
]);

function cleanHistory(historyCompleteFrom: string | null) {
  return {
    today: "2026-08-14",
    financialYearStartMonth: 7,
    baseCurrencyCode: "AUD",
    disposalCount: 2,
    fyTotals: cleanTotals,
    historyCompleteFrom,
    earliestTradeDate: null,
  };
}

const screenProps = {
  // UI-022: the Income sub-tab hrefs are derived from `portfolioId` inside
  // the shared `IncomeNav`, so the screen no longer takes per-tab hrefs.
  portfolioId: "portfolio-a",
  holdingsHref: "/portfolio/portfolio-a/holdings",
};

function renderScreen(historyCompleteFrom: string | null) {
  return renderComponent(
    "CapitalGainsScreen",
    "../app/components/capital-gains-screen.tsx",
    {
      ...screenProps,
      result: { status: "ok", history: cleanHistory(historyCompleteFrom) },
    },
  );
}

test("CGT-002 screen: the FY table gains 'Brought forward'/'Applied this FY'/'Carried out' columns, and 'Net estimate' is the carried (true) figure", () => {
  const html = renderScreen("2022-07-01"); // complete: on/before the earliest FY's 2022-07-01 start
  assert.match(html, /Brought forward/);
  assert.match(html, /Applied this FY/);
  assert.match(html, /Carried out/);
  // FY24's carried net (400), not its standalone net (500) -- the
  // discriminating value from the domain-level fixture above.
  assert.match(html, /\$400\.00/);
  assert.doesNotMatch(html, /\$500\.00/);
  // FY24 brought forward 200, applied 200, carried out 0.
  assert.match(html, /\$200\.00/);
});

test("CGT-002 screen: the lifetime line is relabelled to the TRUE, carried whole-period net, not the old standalone-sum wording", () => {
  const html = renderScreen("2022-07-01");
  assert.match(html, /Lifetime net capital gain estimate \(true, carried\)/);
  assert.doesNotMatch(html, /sum of each year, standalone/);
  // Lifetime true net = FY23's carried 0 + FY24's carried 400 = 400.
  assert.match(html, /\$400\.00<\/dd>/);
});

// Reviewer fix (round 1 BLOCKING): the "Lifetime losses" row (inside the
// lifetime SUMMARY `<dl>`) used to append a "· AUD 200.00 unabsorbed"
// suffix driven by the STANDALONE per-FY unabsorbed sum, even when the
// carry chain had already fully absorbed that loss into a later FY's gain
// (this fixture: FY23's own standalone $200 unabsorbed loss is fully
// consumed by FY24's $1000 discountable gain, so `finalCarryOutLossDecimal`
// is "0") -- directly contradicting the carried net capital gain line
// right beneath it. Pins the clean two-FY case: within the lifetime
// summary specifically, loss fully absorbed -> NO unabsorbed/carrying-
// forward suffix, and the carried net is still 400. (FY23's OWN per-FY
// table row is UNAFFECTED by this fix and correctly keeps its explicitly
// "(standalone)"-qualified unabsorbed figure -- that one was never the
// contradiction; only the un-qualified lifetime rollup was.)
test("CGT-002 screen: a loss fully absorbed by a later FY's carry-in renders NO unabsorbed/still-carrying-forward suffix in the lifetime summary, consistent with the carried net", () => {
  const html = renderScreen("2022-07-01");
  assert.equal(
    computeCapitalGainsCarryChain(cleanTotals, "2022-07-01")
      .finalCarryOutLossDecimal,
    "0",
  );
  const summaryStart = html.indexOf('<dl class="income-metric-list"');
  const summaryEnd = html.indexOf("</dl>", summaryStart) + "</dl>".length;
  assert.ok(summaryStart !== -1 && summaryEnd > summaryStart);
  const summary = html.slice(summaryStart, summaryEnd);
  assert.doesNotMatch(summary, /unabsorbed/);
  assert.doesNotMatch(summary, /still carrying forward/i);
  // The lifetime net line is unaffected by this fix -- still the carried 400.
  assert.match(summary, /\$400\.00<\/dd>/);
});

test("CGT-002 screen: complete history renders no incomplete-history disclosure and no '*' taint marker", () => {
  const html = renderScreen("2022-07-01");
  assert.doesNotMatch(html, /may be incomplete/);
  assert.doesNotMatch(html, /marks a carried figure/);
});

test("CGT-002 screen: null history_complete_from renders the honest 'unknown' incompleteness disclosure, and taints every carried figure", () => {
  const html = renderScreen(null);
  assert.match(html, /no declared history-completeness date/);
  assert.match(html, /marks a carried figure/);
});

test("CGT-002 screen: a history_complete_from AFTER the earliest FY's start renders the dated incompleteness disclosure", () => {
  const html = renderScreen("2023-01-01"); // after FY23's 2022-07-01 start
  assert.match(html, /prior losses before 2023-01-01 are unknown/);
});

test("CGT-002 screen: the standing carry-forward note appears before the lifetime net line (index assertion, mirrors CGT-001B's renamed test)", () => {
  const html = renderScreen("2022-07-01");
  const noteIndex = html.indexOf(CGT_CARRY_FORWARD_NOTE);
  const lifetimeNetIndex = html.indexOf("Lifetime net capital gain estimate");
  assert.notEqual(noteIndex, -1);
  assert.notEqual(lifetimeNetIndex, -1);
  assert.ok(noteIndex < lifetimeNetIndex);
});

test("CGT-002 screen: the per-FY detail dialog shows BOTH the standalone figures and the carried breakdown, clearly distinguished", () => {
  const chain = computeCapitalGainsCarryChain(cleanTotals, "2022-07-01");
  const fy2024 = cleanTotals.find((fy) => fy.endingYear === 2024)!;
  const carried2024 = chain.perFy.find((fy) => fy.endingYear === 2024)!;
  const html = renderComponent(
    "FyDetailDialog",
    "../app/components/capital-gains-screen.tsx",
    {
      fy: fy2024,
      carried: carried2024,
      currencyCode: "AUD",
      dialogRef: { current: null },
    },
  );
  assert.match(html, /Standalone \(before prior-year carry-forward\)/);
  assert.match(html, /Carried \(with prior-year losses applied\)/);
  // Standalone net (500) and carried net (400) both appear, distinctly.
  assert.match(html, /Net capital gain estimate \(standalone\)/);
  assert.match(html, /\$500\.00/);
  assert.match(html, /Net capital gain estimate \(carried, true\)/);
  assert.match(html, /\$400\.00/);
  assert.match(html, /Brought forward/);
  assert.match(html, /Carried out to next FY/);
  assert.ok(html.includes(CGT_CARRY_FORWARD_NOTE));
});
