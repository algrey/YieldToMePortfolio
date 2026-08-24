/**
 * DIV-013 -- "Add/Remove Capital" what-if subsection + "Reinvest Dividends"
 * (owner directive, 2026-08-24), built on DIV-012's live what-if inputs in
 * `app/components/income-multi-year.tsx`.
 *
 * Covers: the pure domain overlay `applyCapitalEventsToProjection`
 * (`domain/dividends/projection.ts`) -- parcel add/remove/mid-year pro-rata/
 * blank-follows-portfolio/reinvest-formula math -- and the pure UI helpers
 * (`app/income-whatif.ts`) -- draft validation, row conversion, sort order,
 * and the session-storage read/write pair. Component-level coverage is
 * source-pinned/rendered-static exactly like `tests/div-012.test.ts`'s own
 * documented constraint: this harness has no jsdom/interactive-DOM layer
 * (`renderToStaticMarkup` only), so "typing"/"clicking Apply" cannot be
 * simulated -- the pure functions those handlers call are unit-tested
 * directly instead, and the component's WIRING to them is pinned on source.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyCapitalEventsToProjection,
  projectMultiYearIncome,
  type CapitalEventInput,
  type MultiYearProjectionAssumptions,
  type MultiYearProjectionInput,
  type ProjectionYearRow,
} from "../domain/dividends/projection.ts";
import {
  CAPITAL_EVENT_DEFAULT_NAME,
  CAPITAL_EVENT_DEFAULT_YIELD_PERCENT_DECIMAL,
  capitalEventDraftToRow,
  capitalEventRowToDomainInput,
  capitalEventsStorageKey,
  defaultCapitalEventMonthYear,
  isValidCapitalEventDraft,
  loadCapitalEventsSession,
  saveCapitalEventsSession,
  sortCapitalEventRows,
  type CapitalEventDraft,
  type CapitalEventRowState,
  type StorageLike,
} from "../app/income-whatif.ts";

// ---------------------------------------------------------------------------
// In-memory fake for `StorageLike` -- lets the session-storage tests run
// under the plain Node test runner (no `sessionStorage` global available).
// ---------------------------------------------------------------------------

class FakeStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

class ThrowingStorage implements StorageLike {
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem(): void {
    throw new Error("blocked");
  }
}

// ---------------------------------------------------------------------------
// a. Domain overlay -- `applyCapitalEventsToProjection`.
// ---------------------------------------------------------------------------

// Clean, hand-checkable base (0% franking throughout, so gross === cash and
// franking is always exactly 0 -- keeps every assertion below verifiable by
// hand rather than trusting the module's own arithmetic to check itself).
const baseAssumptions: MultiYearProjectionAssumptions = {
  currentPortfolioValueDecimal: "10000",
  currentPortfolioValueStatus: "available",
  baseForecastGrossDecimal: "500",
  baseForecastCashDecimal: "500",
  baseYieldIncludesPartialTtm: false,
  baseForecastFrankingIncomplete: false,
  baseExcludedSecurityCount: 0,
  valueGrowthPercentDecimal: "10",
  valueGrowthSource: "portfolio_assumption",
  dividendGrowthPercentDecimal: "5",
  dividendGrowthSource: "portfolio_assumption",
};
// startEndingYear=2025, FY start month July (7) -- year 1 endingYear=2026
// (2025-07-01..2026-06-30), year 2=2027, year 3=2028.
const baseline: MultiYearProjectionInput = {
  assumptions: baseAssumptions,
  yearsForward: 3,
  startEndingYear: 2025,
};
const baseResult = projectMultiYearIncome(baseline);
assert.ok(baseResult.ok, "fixture setup: base projection must succeed");
const baseRows: ProjectionYearRow[] = baseResult.ok ? baseResult.rows : [];

// A parcel joining January 2026 -- inside FY2026 (July 2025-June 2026), 6
// months from January through June inclusive, so its own join-FY dividend
// pro-rates by exactly 6/12 = 0.5 (a clean fraction, by design).
const addParcel: CapitalEventInput = {
  id: "add-1",
  name: "House sale",
  amountDecimal: "1200",
  month: 1,
  year: 2026,
  yieldPercentDecimal: "10",
  capitalGrowthPercentDecimal: null, // blank -- follows portfolio (10%)
  dividendGrowthPercentDecimal: null, // blank -- follows portfolio (5%)
};

test("DIV-013: fast path -- no parcels, reinvest off -- returns the base rows byte-for-byte (plus an empty contributions field), regardless of startMonth validity", () => {
  const result = applyCapitalEventsToProjection(
    { rows: baseRows, assumptions: baseAssumptions },
    [],
    { startMonth: 0, reinvestDividends: false }, // deliberately invalid startMonth
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.rows.length, baseRows.length);
  for (let index = 0; index < baseRows.length; index += 1) {
    assert.equal(
      result.rows[index]!.valueDecimal,
      baseRows[index]!.valueDecimal,
    );
    assert.equal(
      result.rows[index]!.grossDividendDecimal,
      baseRows[index]!.grossDividendDecimal,
    );
    assert.deepEqual(result.rows[index]!.capitalEventContributions, []);
  }
});

test("DIV-013 (parcel mechanics): a joining parcel's OWN join-FY value is unprorated (exactly its amount) while its dividend pro-rates by months-held/12; later FYs compound both once per step at the (blank-follows) portfolio growth rates", () => {
  const result = applyCapitalEventsToProjection(
    { rows: baseRows, assumptions: baseAssumptions },
    [addParcel],
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const [row1, row2, row3] = result.rows;

  // Join FY (k=0): value = amount unprorated; dividend = (amount * 10%) *
  // 6/12 = 120 * 0.5 = 60.
  assert.deepEqual(row1!.capitalEventContributions, [
    {
      id: "add-1",
      name: "House sale",
      valueDecimal: "1200",
      grossDividendDecimal: "60",
    },
  ]);
  // Combined row totals: base (10000 / 500) + parcel (1200 / 60).
  assert.equal(row1!.valueDecimal, "11200");
  assert.equal(row1!.grossDividendDecimal, "560");
  assert.equal(row1!.cashDividendDecimal, "560"); // 0% franking assumed for parcels
  assert.equal(row1!.frankingCreditDecimal, "0");
  assert.equal(row1!.yieldPercentDecimal, "5"); // 560 / 11200 * 100

  // k=1: value = 1200 * 1.10 = 1320; dividend = (1200*10%=120) * 1.05 = 126.
  assert.deepEqual(row2!.capitalEventContributions, [
    {
      id: "add-1",
      name: "House sale",
      valueDecimal: "1320",
      grossDividendDecimal: "126",
    },
  ]);

  // k=2: value = 1320 * 1.10 = 1452; dividend = 126 * 1.05 = 132.3.
  assert.deepEqual(row3!.capitalEventContributions, [
    {
      id: "add-1",
      name: "House sale",
      valueDecimal: "1452",
      grossDividendDecimal: "132.3",
    },
  ]);
});

test("DIV-013 (removal mirrors addition): a negative amount uses the IDENTICAL formula -- every contribution is the exact negation of the positive fixture above", () => {
  const removeParcel: CapitalEventInput = {
    ...addParcel,
    id: "remove-1",
    amountDecimal: "-1200",
  };
  const result = applyCapitalEventsToProjection(
    { rows: baseRows, assumptions: baseAssumptions },
    [removeParcel],
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const [row1, row2, row3] = result.rows;
  assert.deepEqual(row1!.capitalEventContributions, [
    {
      id: "remove-1",
      name: "House sale",
      valueDecimal: "-1200",
      grossDividendDecimal: "-60",
    },
  ]);
  assert.deepEqual(row2!.capitalEventContributions, [
    {
      id: "remove-1",
      name: "House sale",
      valueDecimal: "-1320",
      grossDividendDecimal: "-126",
    },
  ]);
  assert.deepEqual(row3!.capitalEventContributions, [
    {
      id: "remove-1",
      name: "House sale",
      valueDecimal: "-1452",
      grossDividendDecimal: "-132.3",
    },
  ]);
  // Combined row 1 total: base (10000/500) + removal (-1200/-60).
  assert.equal(row1!.valueDecimal, "8800");
  assert.equal(row1!.grossDividendDecimal, "440");
});

// --- Review round 1, B1 (BLOCKING): removal-direction franking split ---

// A base row with a REAL franking mix (unlike `baseAssumptions` above,
// which is 0%-franked throughout by design) -- 70% cash / 30% franking.
const frankedAssumptions: MultiYearProjectionAssumptions = {
  currentPortfolioValueDecimal: "100000",
  currentPortfolioValueStatus: "available",
  baseForecastGrossDecimal: "10000",
  baseForecastCashDecimal: "7000",
  baseYieldIncludesPartialTtm: false,
  baseForecastFrankingIncomplete: false,
  baseExcludedSecurityCount: 0,
  valueGrowthPercentDecimal: "0",
  valueGrowthSource: "portfolio_assumption",
  dividendGrowthPercentDecimal: "0",
  dividendGrowthSource: "portfolio_assumption",
};
const frankedBaseline: MultiYearProjectionInput = {
  assumptions: frankedAssumptions,
  yearsForward: 1,
  startEndingYear: 2025, // row 1 endingYear = 2026
};
const frankedBaseResult = projectMultiYearIncome(frankedBaseline);
assert.ok(
  frankedBaseResult.ok,
  "fixture setup: franked base projection must succeed",
);
const frankedBaseRows: ProjectionYearRow[] = frankedBaseResult.ok
  ? frankedBaseResult.rows
  : [];

test("DIV-013 review (B1, BLOCKING, reviewer drill reproduced): a large capital REMOVAL splits its dividend reduction PRO-RATA against the row's OWN cash/franking composition -- franking moves proportionally with gross, never left unchanged next to a deeply negative cash figure", () => {
  const bigRemoval: CapitalEventInput = {
    id: "sell-down",
    name: "Sell-down",
    amountDecimal: "-500000",
    month: 7,
    year: 2025, // joins exactly at FY start -- a full, un-prorated 12/12 FY
    yieldPercentDecimal: "10",
    capitalGrowthPercentDecimal: "0",
    dividendGrowthPercentDecimal: "0",
  };
  const result = applyCapitalEventsToProjection(
    { rows: frankedBaseRows, assumptions: frankedAssumptions },
    [bigRemoval],
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const row1 = result.rows[0]!;
  // Base row: gross 10,000 / cash 7,000 / franking 3,000 (a real 70/30
  // mix). Parcel contributes dividend -50,000 (amount -500,000 * 10%).
  assert.deepEqual(row1.capitalEventContributions, [
    {
      id: "sell-down",
      name: "Sell-down",
      valueDecimal: "-500000",
      grossDividendDecimal: "-50000",
    },
  ]);
  assert.equal(row1.grossDividendDecimal, "-40000"); // 10000 - 50000
  // Pre-fix (B1): the whole -50,000 hit cash alone -- cash -40,000 /
  // franking UNCHANGED at 3,000 (reviewer's exact drill shape). Post-fix:
  // the reduction splits pro-rata against the base 70/30 ratio -- cash
  // reduces by -50,000*0.7=-35,000 (7,000-35,000), franking's reduction
  // (by the module's standing gross-minus-cash subtraction identity) works
  // out to the matching -50,000*0.3=-15,000 (3,000-15,000).
  assert.equal(row1.cashDividendDecimal, "-28000");
  assert.equal(row1.frankingCreditDecimal, "-12000");
});

test("DIV-013 review (B1, BLOCKING, half-portfolio case): removing EXACTLY half a row's dividend halves cash AND franking together -- the base 70/30 composition survives exactly", () => {
  const halfRemoval: CapitalEventInput = {
    id: "half-sell",
    name: "Half sell-down",
    amountDecimal: "-50000",
    month: 7,
    year: 2025,
    yieldPercentDecimal: "10",
    capitalGrowthPercentDecimal: "0",
    dividendGrowthPercentDecimal: "0",
  };
  const result = applyCapitalEventsToProjection(
    { rows: frankedBaseRows, assumptions: frankedAssumptions },
    [halfRemoval],
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const row1 = result.rows[0]!;
  assert.equal(row1.grossDividendDecimal, "5000"); // half of 10,000
  assert.equal(row1.cashDividendDecimal, "3500"); // half of 7,000
  assert.equal(row1.frankingCreditDecimal, "1500"); // half of 3,000 -- franking halves WITH gross
});

test("DIV-013 review (B1 fold): a POSITIVE parcel combined in the SAME row as a negative one keeps the documented 0%-franked/pure-cash simplification -- only the NEGATIVE portion pro-rates against the base franking mix", () => {
  const addition: CapitalEventInput = {
    id: "top-up",
    name: "Top-up",
    amountDecimal: "20000",
    month: 7,
    year: 2025,
    yieldPercentDecimal: "10",
    capitalGrowthPercentDecimal: "0",
    dividendGrowthPercentDecimal: "0",
  };
  const removal: CapitalEventInput = {
    id: "sell-down-2",
    name: "Sell-down",
    amountDecimal: "-50000",
    month: 7,
    year: 2025,
    yieldPercentDecimal: "10",
    capitalGrowthPercentDecimal: "0",
    dividendGrowthPercentDecimal: "0",
  };
  const result = applyCapitalEventsToProjection(
    { rows: frankedBaseRows, assumptions: frankedAssumptions },
    [addition, removal],
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const row1 = result.rows[0]!;
  // addition: dividend +2,000 (20000*10%), pure cash (0% franked).
  // removal: dividend -5,000 (half the base 10,000), pro-rated 70/30
  // against the BASE row's own composition -- cash -3,500, franking share
  // -1,500 (via the subtraction identity).
  // gross = 10000 + 2000 - 5000 = 7000.
  // cash  = 7000(base) + 2000(addition) + -3500(removal's cash share) = 5500.
  // franking = gross - cash = 7000 - 5500 = 1500.
  assert.equal(row1.grossDividendDecimal, "7000");
  assert.equal(row1.cashDividendDecimal, "5500");
  assert.equal(row1.frankingCreditDecimal, "1500");
});

// --- Review round 1 fold: value <= 0 -> yield unavailable, not "0.00%" -

test("DIV-013 review (fold): an over-removal parcel driving a row's combined value to zero or negative renders yieldPercentDecimal as null (honest 'unavailable'), never a fabricated '0'", () => {
  const overRemoval: CapitalEventInput = {
    id: "wipe-out",
    name: "Wipe-out",
    amountDecimal: "-20000", // base row 1 value is 10000 -- drives it negative
    month: 7,
    year: 2025,
    yieldPercentDecimal: "10",
    capitalGrowthPercentDecimal: "0",
    dividendGrowthPercentDecimal: "0",
  };
  const result = applyCapitalEventsToProjection(
    { rows: baseRows, assumptions: baseAssumptions },
    [overRemoval],
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const row1 = result.rows[0]!;
  assert.equal(row1.valueDecimal, "-10000"); // 10000 - 20000
  assert.equal(row1.yieldPercentDecimal, null);
});

test("DIV-013 review (fold, reinvest edge case): when over-removal drives a row's value non-positive (yieldPercentDecimal null), the auto-generated reinvestment parcel for that FY falls back to an explicit 0% yield rather than failing the whole overlay closed", () => {
  const overRemoval: CapitalEventInput = {
    id: "wipe-out-2",
    name: "Wipe-out",
    amountDecimal: "-20000",
    month: 7,
    year: 2025,
    yieldPercentDecimal: "10",
    capitalGrowthPercentDecimal: "0",
    dividendGrowthPercentDecimal: "0",
  };
  const result = applyCapitalEventsToProjection(
    { rows: baseRows, assumptions: baseAssumptions },
    [overRemoval],
    { startMonth: 7, reinvestDividends: true },
  );
  assert.equal(result.ok, true);
});

test("DIV-013 (blank-follows-portfolio, LIVE -- never copied): the SAME blank-growth parcel resolves DIFFERENT k>=1 figures against DIFFERENT current portfolio growth assumptions -- proves the resolution reads `base.assumptions` fresh on every call, not a value captured/cached when the parcel was entered", () => {
  const grownAssumptions: MultiYearProjectionAssumptions = {
    ...baseAssumptions,
    valueGrowthPercentDecimal: "20", // was 10%
    dividendGrowthPercentDecimal: "5",
  };
  const grownBaseline: MultiYearProjectionInput = {
    assumptions: grownAssumptions,
    yearsForward: 3,
    startEndingYear: 2025,
  };
  const grownBaseResult = projectMultiYearIncome(grownBaseline);
  assert.ok(grownBaseResult.ok);
  const grownRows = grownBaseResult.ok ? grownBaseResult.rows : [];

  const result = applyCapitalEventsToProjection(
    { rows: grownRows, assumptions: grownAssumptions },
    [addParcel], // identical parcel object, still blank growth fields
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  // k=1 value now compounds at the CHANGED 20% rate: 1200 * 1.20 = 1440
  // (was 1320 against the original 10% fixture above).
  assert.equal(
    result.rows[1]!.capitalEventContributions[0]!.valueDecimal,
    "1440",
  );
});

test("DIV-013 (named/sorted rows -- multiple parcels combine additively): two parcels joining the same FY both contribute, summed into that row's totals", () => {
  const second: CapitalEventInput = {
    id: "add-2",
    name: "Bonus",
    amountDecimal: "300",
    month: 4,
    year: 2026, // also FY2026, 3 months held (Apr-Jun inclusive) -- 3/12=0.25
    // is a CLEAN terminating fraction (unlike e.g. 4/12=1/3, which the
    // engine's single-rounding-per-division convention would round to a
    // near-10-but-not-exact figure -- deliberately avoided here so this
    // fixture stays hand-checkable to the exact cent).
    yieldPercentDecimal: "10",
    capitalGrowthPercentDecimal: "0", // owner-set, does NOT follow portfolio
    dividendGrowthPercentDecimal: "0",
  };
  const result = applyCapitalEventsToProjection(
    { rows: baseRows, assumptions: baseAssumptions },
    [addParcel, second],
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const row1 = result.rows[0]!;
  assert.equal(row1.capitalEventContributions.length, 2);
  // second: fullYearDividendBase = 300*10/100=30, prorated 3/12=0.25 => 7.5.
  const secondContribution = row1.capitalEventContributions.find(
    (c) => c.id === "add-2",
  );
  assert.deepEqual(secondContribution, {
    id: "add-2",
    name: "Bonus",
    valueDecimal: "300",
    grossDividendDecimal: "7.5",
  });
  // Combined: base(10000/500) + add-1(1200/60) + add-2(300/7.5).
  assert.equal(row1.valueDecimal, "11500");
  assert.equal(row1.grossDividendDecimal, "567.5");
});

// --- Reinvest Dividends (owner's simple formula) ----------------------

// Isolated fixture: dividendGrowth 0% keeps the BASE dividend flat across
// years, isolating the reinvestment mechanism's own effect for a clean,
// hand-checkable number.
const reinvestAssumptions: MultiYearProjectionAssumptions = {
  currentPortfolioValueDecimal: "10000",
  currentPortfolioValueStatus: "available",
  baseForecastGrossDecimal: "1000",
  baseForecastCashDecimal: "1000",
  baseYieldIncludesPartialTtm: false,
  baseForecastFrankingIncomplete: false,
  baseExcludedSecurityCount: 0,
  valueGrowthPercentDecimal: "10",
  valueGrowthSource: "portfolio_assumption",
  dividendGrowthPercentDecimal: "0",
  dividendGrowthSource: "portfolio_assumption",
};
const reinvestBaseline: MultiYearProjectionInput = {
  assumptions: reinvestAssumptions,
  yearsForward: 2,
  startEndingYear: 2025,
};
const reinvestBaseResult = projectMultiYearIncome(reinvestBaseline);
assert.ok(reinvestBaseResult.ok);
const reinvestBaseRows = reinvestBaseResult.ok ? reinvestBaseResult.rows : [];

test("DIV-013 (Reinvest Dividends -- owner's simple formula, hand-checkable): FY N's own finalised total dividend becomes a new parcel dated at FY N's midpoint, yielding FY N's own derived yield, growth left blank (follows portfolio) -- its first VISIBLE effect is FY N+1 (a full k=1 compounding step), never retroactively changing the total it was generated from", () => {
  const result = applyCapitalEventsToProjection(
    { rows: reinvestBaseRows, assumptions: reinvestAssumptions },
    [],
    { startMonth: 7, reinvestDividends: true },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  const [row1, row2] = result.rows;

  // Row 1: no parcel has joined yet (the reinvest parcel for FY2026 is only
  // generated AFTER row 1 is finalised) -- untouched base figures.
  assert.equal(row1!.capitalEventContributions.length, 0);
  assert.equal(row1!.valueDecimal, "10000");
  assert.equal(row1!.grossDividendDecimal, "1000");
  assert.equal(row1!.yieldPercentDecimal, "10"); // 1000/10000*100

  // Row 2: base alone would be value=10000*1.10=11000, gross=1000*1.00=1000
  // (0% dividend growth). The FY2026-generated reinvest parcel (amount
  // 1000, yield 10%, blank growth) contributes its k=1 step:
  // value = 1000 * 1.10 = 1100; dividend = (1000*10%=100) * 1.00 = 100.
  assert.equal(row2!.capitalEventContributions.length, 1);
  const reinvestContribution = row2!.capitalEventContributions[0]!;
  assert.equal(reinvestContribution.id, "reinvest-fy-2026");
  assert.equal(reinvestContribution.name, "Reinvested dividends (FY26)");
  assert.equal(reinvestContribution.valueDecimal, "1100");
  assert.equal(reinvestContribution.grossDividendDecimal, "100");
  // Combined row 2 totals: base (11000/1000) + reinvest (1100/100).
  assert.equal(row2!.valueDecimal, "12100");
  assert.equal(row2!.grossDividendDecimal, "1100");
  assert.equal(row2!.cashDividendDecimal, "1100");
  assert.equal(row2!.frankingCreditDecimal, "0");
});

// --- Invalid input / honest failure handling ---------------------------

test("DIV-013: an unusable decimal anywhere in a parcel (amount, yield, or an owner-set growth override) fails the WHOLE overlay closed with reason 'invalid_decimal' -- never silently drops just the one bad parcel or fabricates a number", () => {
  const badAmount: CapitalEventInput = {
    ...addParcel,
    amountDecimal: "not-a-number",
  };
  const result = applyCapitalEventsToProjection(
    { rows: baseRows, assumptions: baseAssumptions },
    [badAmount],
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "invalid_decimal");
});

test("DIV-013: an out-of-range parcel month/year also fails closed with 'invalid_decimal' (the calendar placement is unusable, not silently clamped or guessed)", () => {
  const badMonth: CapitalEventInput = { ...addParcel, month: 13 };
  const result = applyCapitalEventsToProjection(
    { rows: baseRows, assumptions: baseAssumptions },
    [badMonth],
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "invalid_decimal");
});

test("DIV-013: an invalid portfolio FY start month is rejected honestly -- but ONLY once something is actually configured (a parcel, or reinvestment) that needs the calendar; the trivial fast path (already pinned above) never even inspects it", () => {
  const withParcel = applyCapitalEventsToProjection(
    { rows: baseRows, assumptions: baseAssumptions },
    [addParcel],
    { startMonth: 13, reinvestDividends: false },
  );
  assert.equal(withParcel.ok, false);
  if (withParcel.ok) throw new Error("unreachable");
  assert.equal(withParcel.reason, "invalid_start_month");

  const reinvestOnly = applyCapitalEventsToProjection(
    { rows: baseRows, assumptions: baseAssumptions },
    [],
    { startMonth: 0, reinvestDividends: true },
  );
  assert.equal(reinvestOnly.ok, false);
  if (reinvestOnly.ok) throw new Error("unreachable");
  assert.equal(reinvestOnly.reason, "invalid_start_month");
});

test("DIV-013: when the base projection's own rows carry no FY calendar (startEndingYear was null), a configured parcel fails honestly with 'no_fy_calendar' rather than guessing a placement", () => {
  const noCalendarRows: ProjectionYearRow[] = baseRows.map((row) => ({
    ...row,
    endingYear: null,
    label: "Year 1",
  }));
  const result = applyCapitalEventsToProjection(
    { rows: noCalendarRows, assumptions: baseAssumptions },
    [addParcel],
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.reason, "no_fy_calendar");
});

// --- DIV-011 chain survival: endingYear/label pass through unchanged ---

test("DIV-013 (DIV-011 chain survival): the capital-adjusted rows keep every OTHER base field (endingYear, label, method) byte-identical -- only value/dividend/franking/yield change -- so DIV-011's mergeCurrentFinancialYear guard (`forecastEndingYear !== row.endingYear`) keeps working unmodified against a capital-adjusted row 1", () => {
  const result = applyCapitalEventsToProjection(
    { rows: baseRows, assumptions: baseAssumptions },
    [addParcel],
    { startMonth: 7, reinvestDividends: false },
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  for (let index = 0; index < baseRows.length; index += 1) {
    assert.equal(result.rows[index]!.endingYear, baseRows[index]!.endingYear);
    assert.equal(result.rows[index]!.label, baseRows[index]!.label);
    assert.equal(result.rows[index]!.yearIndex, baseRows[index]!.yearIndex);
  }
});

// ---------------------------------------------------------------------------
// b. Pure UI helpers -- `app/income-whatif.ts`.
// ---------------------------------------------------------------------------

test("DIV-013: defaultCapitalEventMonthYear defaults to January of the year AFTER the reference date's year (owner directive: 'month + year (default January next year)')", () => {
  assert.deepEqual(defaultCapitalEventMonthYear(new Date(2026, 7, 21)), {
    month: 1,
    year: 2027,
  });
  assert.deepEqual(defaultCapitalEventMonthYear(new Date(2025, 0, 1)), {
    month: 1,
    year: 2026,
  });
});

const validDraft: CapitalEventDraft = {
  name: "Change",
  amountDecimal: "1000",
  month: 6,
  year: 2027,
  yieldPercentDecimal: "2",
  capitalGrowthInput: "",
  dividendGrowthInput: "",
};

test("DIV-013: isValidCapitalEventDraft accepts a fully blank-growth draft (owner directive: growth fields are the only optional ones) and a fully owner-set one", () => {
  assert.equal(isValidCapitalEventDraft(validDraft), true);
  assert.equal(
    isValidCapitalEventDraft({
      ...validDraft,
      capitalGrowthInput: "3",
      dividendGrowthInput: "-1.5",
    }),
    true,
  );
});

test("DIV-013: isValidCapitalEventDraft honestly rejects every other required field when invalid/missing -- amount, yield, month, year, and a SETTLED (non-blank) invalid growth entry", () => {
  assert.equal(
    isValidCapitalEventDraft({ ...validDraft, amountDecimal: "" }),
    false,
  );
  assert.equal(
    isValidCapitalEventDraft({ ...validDraft, amountDecimal: "abc" }),
    false,
  );
  assert.equal(
    isValidCapitalEventDraft({ ...validDraft, yieldPercentDecimal: "2%" }),
    false,
  );
  assert.equal(isValidCapitalEventDraft({ ...validDraft, month: 0 }), false);
  assert.equal(isValidCapitalEventDraft({ ...validDraft, month: 13 }), false);
  assert.equal(isValidCapitalEventDraft({ ...validDraft, month: 1.5 }), false);
  assert.equal(
    isValidCapitalEventDraft({ ...validDraft, year: Number("abc") }),
    false,
  );
  assert.equal(
    isValidCapitalEventDraft({ ...validDraft, capitalGrowthInput: "abc" }),
    false,
  );
  assert.equal(
    isValidCapitalEventDraft({ ...validDraft, dividendGrowthInput: "abc" }),
    false,
  );
});

test("DIV-013: capitalEventDraftToRow defaults a blank name to the owner's 'Change' default, trims real values, and turns a blank growth field into the null blank-follows-portfolio flag", () => {
  const row = capitalEventDraftToRow({ ...validDraft, name: "  " }, "row-1");
  assert.equal(row.name, CAPITAL_EVENT_DEFAULT_NAME);
  assert.equal(row.id, "row-1");
  assert.equal(row.capitalGrowthPercentDecimal, null);
  assert.equal(row.dividendGrowthPercentDecimal, null);

  const namedRow = capitalEventDraftToRow(
    { ...validDraft, name: "  Renovation  ", capitalGrowthInput: " 4 " },
    "row-2",
  );
  assert.equal(namedRow.name, "Renovation");
  assert.equal(namedRow.capitalGrowthPercentDecimal, "4");
  assert.equal(namedRow.dividendGrowthPercentDecimal, null);
});

test("DIV-013: CAPITAL_EVENT_DEFAULT_YIELD_PERCENT_DECIMAL is the owner's 2% default", () => {
  assert.equal(CAPITAL_EVENT_DEFAULT_YIELD_PERCENT_DECIMAL, "2");
});

test("DIV-013 (owner directive: 'sorted by date, oldest at top'): sortCapitalEventRows sorts by (year, month) ascending, and is a STABLE sort for ties", () => {
  const rows: CapitalEventRowState[] = [
    {
      id: "c",
      name: "C",
      amountDecimal: "1",
      month: 6,
      year: 2028,
      yieldPercentDecimal: "2",
      capitalGrowthPercentDecimal: null,
      dividendGrowthPercentDecimal: null,
    },
    {
      id: "a",
      name: "A",
      amountDecimal: "1",
      month: 1,
      year: 2027,
      yieldPercentDecimal: "2",
      capitalGrowthPercentDecimal: null,
      dividendGrowthPercentDecimal: null,
    },
    {
      id: "b-first",
      name: "B1",
      amountDecimal: "1",
      month: 3,
      year: 2027,
      yieldPercentDecimal: "2",
      capitalGrowthPercentDecimal: null,
      dividendGrowthPercentDecimal: null,
    },
    {
      id: "b-second",
      name: "B2",
      amountDecimal: "1",
      month: 3,
      year: 2027,
      yieldPercentDecimal: "2",
      capitalGrowthPercentDecimal: null,
      dividendGrowthPercentDecimal: null,
    },
  ];
  const sorted = sortCapitalEventRows(rows);
  assert.deepEqual(
    sorted.map((row) => row.id),
    ["a", "b-first", "b-second", "c"],
  );
  // Does not mutate the input array (a fresh copy, per the doc comment).
  assert.equal(rows[0]!.id, "c");
});

test("DIV-013: capitalEventRowToDomainInput maps a committed row onto the domain projector's own input shape 1:1, blank-follow flags preserved as null", () => {
  const row: CapitalEventRowState = {
    id: "x",
    name: "X",
    amountDecimal: "500",
    month: 4,
    year: 2029,
    yieldPercentDecimal: "3",
    capitalGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: "7",
  };
  assert.deepEqual(capitalEventRowToDomainInput(row), {
    id: "x",
    name: "X",
    amountDecimal: "500",
    month: 4,
    year: 2029,
    yieldPercentDecimal: "3",
    capitalGrowthPercentDecimal: null,
    dividendGrowthPercentDecimal: "7",
  });
});

// --- Session persistence (storage mock) + honest reset behaviour -------

test("DIV-013: capitalEventsStorageKey namespaces by portfolio -- two portfolios in the same session never share or clobber each other's rows", () => {
  assert.notEqual(
    capitalEventsStorageKey("portfolio-a"),
    capitalEventsStorageKey("portfolio-b"),
  );
});

test("DIV-013: loadCapitalEventsSession on empty storage returns the honest empty/reinvest-off default", () => {
  const storage = new FakeStorage();
  assert.deepEqual(
    loadCapitalEventsSession(storage, capitalEventsStorageKey("p1")),
    { rows: [], reinvestDividends: false },
  );
});

test("DIV-013: save then load round-trips a real capital-events session state exactly, including a blank-follow (null) growth flag and the reinvest flag", () => {
  const storage = new FakeStorage();
  const key = capitalEventsStorageKey("p1");
  const state = {
    rows: [
      {
        id: "row-1",
        name: "House sale",
        amountDecimal: "1200",
        month: 1,
        year: 2026,
        yieldPercentDecimal: "10",
        capitalGrowthPercentDecimal: null,
        dividendGrowthPercentDecimal: "5",
      },
    ],
    reinvestDividends: true,
  };
  saveCapitalEventsSession(storage, key, state);
  assert.deepEqual(loadCapitalEventsSession(storage, key), state);
});

test("DIV-013: loadCapitalEventsSession degrades corrupted/malformed JSON to the honest empty default rather than throwing", () => {
  const storage = new FakeStorage();
  const key = capitalEventsStorageKey("p1");
  storage.setItem(key, "{not valid json");
  assert.deepEqual(loadCapitalEventsSession(storage, key), {
    rows: [],
    reinvestDividends: false,
  });
});

test("DIV-013: loadCapitalEventsSession defensively filters out a malformed row (untrusted stored content -- another tab, a stale schema, hand-edited devtools) rather than trusting it into render", () => {
  const storage = new FakeStorage();
  const key = capitalEventsStorageKey("p1");
  storage.setItem(
    key,
    JSON.stringify({
      rows: [
        {
          id: "ok",
          name: "Fine",
          amountDecimal: "1",
          month: 1,
          year: 2026,
          yieldPercentDecimal: "2",
          capitalGrowthPercentDecimal: null,
          dividendGrowthPercentDecimal: null,
        },
        { id: "bad", month: "not-a-number" }, // malformed
        "not even an object",
      ],
      reinvestDividends: "yes", // wrong type -- not literally `true`
    }),
  );
  const loaded = loadCapitalEventsSession(storage, key);
  assert.equal(loaded.rows.length, 1);
  assert.equal(loaded.rows[0]!.id, "ok");
  assert.equal(loaded.reinvestDividends, false);
});

test("DIV-013: a throwing storage (private/incognito tab, quota, blocked) never breaks load or save -- both degrade honestly, never throw into the caller", () => {
  const storage = new ThrowingStorage();
  const key = capitalEventsStorageKey("p1");
  assert.deepEqual(loadCapitalEventsSession(storage, key), {
    rows: [],
    reinvestDividends: false,
  });
  assert.doesNotThrow(() =>
    saveCapitalEventsSession(storage, key, {
      rows: [],
      reinvestDividends: false,
    }),
  );
});

// ---------------------------------------------------------------------------
// c. Component: fresh-mount structural/rendered pins + wiring.
// ---------------------------------------------------------------------------

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

function renderMultiYear(props: Record<string, unknown>) {
  return renderComponent(
    "IncomeMultiYear",
    "../app/components/income-multi-year.tsx",
    props,
  );
}

async function readComponentSource(): Promise<string> {
  return readFile(
    new URL("../app/components/income-multi-year.tsx", import.meta.url),
    "utf8",
  );
}

const componentAssumptions: MultiYearProjectionAssumptions = {
  ...baseAssumptions,
};
const componentBaselineInput: MultiYearProjectionInput = {
  assumptions: componentAssumptions,
  yearsForward: 2,
  startEndingYear: 2025,
};
const componentMultiYear = projectMultiYearIncome(componentBaselineInput);

const freshMountProps = {
  portfolioId: "portfolio-a",
  assumptionsHref: "/portfolio/portfolio-a/income/assumptions",
  dividendsHref: "/portfolio/portfolio-a/income/dividends",
  baseCurrencyCode: "AUD",
  pastFinancialYears: { ok: true, rows: [] },
  currentFinancialYear: { ok: false, reason: "invalid_start_month" },
  multiYear: componentMultiYear,
  multiYearBaselineInput: componentBaselineInput,
  portfolioValueGrowthPercentDecimal: "10",
  portfolioDividendGrowthPercentDecimal: "5",
  financialYearStartMonth: 7,
  yearsBack: 0,
  yearsForward: 2,
};

test("DIV-013: the 'Add/Remove Capital' subsection is a SEPARATE, sibling <section> from '.income-whatif' -- never nested inside it (DIV-012's own pins assert zero <button> inside that section; my Apply/remove/reinvest buttons must not collide with that)", () => {
  const html = renderMultiYear(freshMountProps);
  assert.match(
    html,
    /<section class="income-whatif"[\s\S]*?<\/section>\s*<section class="income-capital-events"/,
  );
  const whatIfSection = html.match(
    /<section class="income-whatif"[\s\S]*?<\/section>/,
  )![0];
  assert.doesNotMatch(whatIfSection, /<button/);
});

test("DIV-013: on a fresh mount (empty session, nothing typed yet), the disclosure line renders, the rows table is absent (nothing committed yet), the Apply button is disabled (an empty amount is honestly invalid), and the reinvest toggle reads '(off)'", () => {
  const html = renderMultiYear(freshMountProps);
  assert.match(
    html,
    /What-if only -- these hypothetical amounts are never saved and never change your real portfolio\./,
  );
  assert.doesNotMatch(
    html,
    /class="income-fy-table income-capital-events-rows"/,
  );
  assert.match(
    html,
    /<button type="button" class="income-capital-events-apply" disabled="">Apply<\/button>/,
  );
  assert.match(html, /Reinvest dividends \(off\)/);
  assert.match(html, /aria-pressed="false"/);
});

test("DIV-013: the Apply/remove handlers are wired through the pure helpers -- structural pin, since this harness cannot simulate a click", async () => {
  const source = await readComponentSource();
  assert.match(source, /capitalEventDraftToRow\(capitalEventDraft, id\)/);
  assert.match(source, /existing\.filter\(\(row\) => row\.id !== id\)/);
  assert.match(source, /sortedCapitalRows\.map\(\(row\) => \(/);
  assert.match(source, /isValidCapitalEventDraft\(capitalEventDraft\)/);
});

test("DIV-013: session persistence is wired through `window.sessionStorage` specifically -- never `localStorage` (owner directive: resets on a new browser session, which is sessionStorage's own contract, not something this code re-implements)", async () => {
  const source = await readComponentSource();
  assert.match(source, /window\.sessionStorage/);
  assert.doesNotMatch(source, /localStorage/);
});

test("DIV-013: the capital-adjusted rows (when the overlay succeeds) are wired into the SAME table the growth what-if already renders -- via capitalEventsResult, never a second/separate table -- and activeProjection/activeProjectionUnavailable (DIV-012's own pinned lines) are untouched", async () => {
  const source = await readComponentSource();
  assert.match(
    source,
    /capitalEventsResult && capitalEventsResult\.ok\s*\n?\s*\?\s*capitalEventsResult\.rows\s*\n?\s*:\s*activeProjection\.rows/,
  );
  // DIV-012's own exact pins (re-asserted here too, locally, since this file
  // is the one that could most plausibly have disturbed them).
  assert.match(
    source,
    /const activeProjectionUnavailable =\s*\n?\s*multiYearBaselineInput !== null && !activeProjection\.ok;/,
  );
  assert.match(
    source,
    /activeProjection = multiYearBaselineInput\s*\n?\s*\?\s*projectMultiYearIncomeWhatIf/,
  );
});

// --- Review round 1, B2 (BLOCKING): never describe unrendered rows -----

test("DIV-013 review (B2, BLOCKING, structural pin): BOTH the lower marker and the folded-up assumption-summary sentence are gated on `capitalEventsResult?.ok === true` -- never merely on `sortedCapitalRows.length`/`reinvestDividends` alone, which say nothing about whether `activeProjection` (and therefore a rendered table) exists at all", async () => {
  const source = await readComponentSource();
  const gateOccurrences = (
    source.match(
      /capitalEventsResult\?\.ok === true &&\s*\n?\s*\(?sortedCapitalRows\.length > 0 \|\| reinvestDividends\)?/g,
    ) ?? []
  ).length;
  assert.equal(
    gateOccurrences,
    2,
    "expected the identical capitalEventsResult?.ok === true gate on both the assumption-summary fold and the lower marker",
  );
});

// --- Review round 1, B3 (BLOCKING): portfolio-switch session race ------

test("DIV-013 review (B3, BLOCKING, structural pin): the SAVE effect is declared BEFORE the LOAD effect in source, and gates on `hydratedKeyRef.current !== capitalEventsStorageKey(portfolioId)` -- ordering the reviewer's fix depends on (see the effects' own comments for why)", async () => {
  const source = await readComponentSource();
  assert.match(
    source,
    /if \(hydratedKeyRef\.current !== capitalEventsStorageKey\(portfolioId\)\) \{\s*\n\s*return;\s*\n\s*\}/,
  );
  const saveIndex = source.indexOf(
    "saveCapitalEventsSession(\n      window.sessionStorage,",
  );
  const loadIndex = source.indexOf(
    "loadCapitalEventsSession(window.sessionStorage, key)",
  );
  assert.ok(saveIndex > 0, "expected to find the save effect's call site");
  assert.ok(loadIndex > 0, "expected to find the load effect's call site");
  assert.ok(
    saveIndex < loadIndex,
    "expected the save effect to be declared (and therefore run) BEFORE the load effect",
  );
  assert.doesNotMatch(source, /const \[sessionHydrated, setSessionHydrated\]/);
});

test("DIV-013 review (B3, BLOCKING, two-portfolio key-switch drill): replicates the exact effect sequence a portfolio switch produces -- the save effect (running FIRST each pass, per the ordering pin above) must observe the STALE ref and skip, never clobbering the newly-entered portfolio's own real stored session with the just-left portfolio's leftover in-memory rows", () => {
  const storage = new FakeStorage();
  const keyA = capitalEventsStorageKey("portfolio-a");
  const keyB = capitalEventsStorageKey("portfolio-b");
  const originalA = {
    rows: [
      {
        id: "a-row",
        name: "A's parcel",
        amountDecimal: "111",
        month: 1,
        year: 2027,
        yieldPercentDecimal: "2",
        capitalGrowthPercentDecimal: null,
        dividendGrowthPercentDecimal: null,
      },
    ],
    reinvestDividends: false,
  };
  const originalB = {
    rows: [
      {
        id: "b-row",
        name: "B's parcel",
        amountDecimal: "222",
        month: 2,
        year: 2028,
        yieldPercentDecimal: "3",
        capitalGrowthPercentDecimal: null,
        dividendGrowthPercentDecimal: null,
      },
    ],
    reinvestDividends: true,
  };
  saveCapitalEventsSession(storage, keyA, originalA);
  saveCapitalEventsSession(storage, keyB, originalB);

  // A tiny faithful reproduction of the component's own two effect bodies.
  const hydratedKeyRef: { current: string | null } = { current: null };
  let state: { rows: CapitalEventRowState[]; reinvestDividends: boolean } = {
    rows: [],
    reinvestDividends: false,
  };
  function runSaveEffect(portfolioId: string) {
    const key = capitalEventsStorageKey(portfolioId);
    if (hydratedKeyRef.current !== key) return; // the B3 guard
    saveCapitalEventsSession(storage, key, state);
  }
  function runLoadEffect(portfolioId: string) {
    const key = capitalEventsStorageKey(portfolioId);
    const loaded = loadCapitalEventsSession(storage, key);
    state = {
      rows: loaded.rows,
      reinvestDividends: loaded.reinvestDividends,
    };
    hydratedKeyRef.current = key;
  }

  // Pass 1 (mount for portfolio A): save runs first (ref null, skip), then
  // load (reads A's real data, hydrates ref to A).
  runSaveEffect("portfolio-a");
  runLoadEffect("portfolio-a");
  assert.deepEqual(loadCapitalEventsSession(storage, keyA), originalA);
  // Pass 2 (state committed): save re-runs, ref now matches -- persists
  // A's own (unchanged) data back, a no-op re-write.
  runSaveEffect("portfolio-a");
  assert.deepEqual(loadCapitalEventsSession(storage, keyA), originalA);

  // Now switch portfolios WITHOUT a remount -- `portfolioId` becomes "B"
  // while `state` STILL holds A's rows (setState from the load effect below
  // has not committed yet). Pass 3: save runs FIRST -- ref still says "A",
  // mismatches "B" -- must skip, never writing A's stale rows into B's key.
  runSaveEffect("portfolio-b");
  assert.deepEqual(
    loadCapitalEventsSession(storage, keyB),
    originalB,
    "B's real stored session must be UNTOUCHED by the stale pre-load save attempt",
  );
  // Then load runs: reads B's real data, hydrates state + ref to B.
  runLoadEffect("portfolio-b");
  assert.deepEqual(state, {
    rows: originalB.rows,
    reinvestDividends: originalB.reinvestDividends,
  });
  // Pass 4: save re-runs, ref now matches B -- persists B's own (freshly
  // loaded, unchanged) data back.
  runSaveEffect("portfolio-b");
  assert.deepEqual(loadCapitalEventsSession(storage, keyB), originalB);
  // A's own stored session was never touched throughout the whole drill.
  assert.deepEqual(loadCapitalEventsSession(storage, keyA), originalA);
});

test("DIV-013 (invalid input, honest UI handling): the draft is invalid whenever a required field is missing -- pinned via the SAME pure `isValidCapitalEventDraft` the component gates Apply on, not a re-implemented check", () => {
  assert.equal(
    isValidCapitalEventDraft({
      name: "",
      amountDecimal: "",
      month: 1,
      year: 2027,
      yieldPercentDecimal: CAPITAL_EVENT_DEFAULT_YIELD_PERCENT_DECIMAL,
      capitalGrowthInput: "",
      dividendGrowthInput: "",
    }),
    false,
  );
});
